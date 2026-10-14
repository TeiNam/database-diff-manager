// ALTER 스크립트 → 새 모델. 문장마다 MySQL 과 같은 결과를 만들고, 받을 수 없는 문장에서 멈춘다 (부분 적용하지 않는다)
import { Cursor, ParseError } from '../cursor';
import type { RenameMapping } from '../diff';
import { LexError, tokenize, type Token } from '../lexer';
import type { SchemaModel } from '../model';
import { routineLexMode } from '../normalize';
import { splitDump } from '../parse-dump';
import { UnsafeValueError } from '../sql-safety';
import { alterTable, createIndex, dropIndexOn } from './alter-table';
import { assertBmpText, canonicalCharset, canonicalCollation, charsetOfCollation, primaryCollation } from './normalize-mysql';
import { createRoutine, dropRoutine, dropView, isCreateRoutine } from './object-stmt';
import { applySet } from './session';
import { initialState, type State } from './state';
import { createTable, dropTable, renameTables } from './table-stmt';
import { ApplyFailure, DEFAULT_SQL_MODE, fail, MYSQL_DEFAULTS, RE_EXPORT, type ApplyDefaults, type ApplyOptions, type ApplyResult } from './types';

export { MYSQL_DEFAULTS, type ApplyDefaults, type ApplyError, type ApplyOptions, type ApplyResult } from './types';
export { printSqlDump } from './print-dump';
export { ApplyFailure } from './types'; // printSqlDump 가 출력할 수 없는 모델에 던진다 — 서버가 400 으로 바꾼다

const MAX_STATEMENT_TEXT = 500;
const VIEW_RE = /^(?:CREATE\s+(?:OR\s+REPLACE\s+)?|ALTER\s+)(?:ALGORITHM\s*=\s*\w+\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:SQL\s+SECURITY\s+\w+\s+)?VIEW\b/i;

export function applyScript(base: SchemaModel, script: string, opts: ApplyOptions): ApplyResult {
  let statements;
  let defaults: ApplyDefaults;
  try {
    statements = splitDump(script.replace(/^\uFEFF/, ''));
    defaults = resolveDefaults(opts.defaults);
  } catch (e) {
    if (e instanceof LexError) return failure(0, 1, '', `스크립트를 문장으로 나누지 못했습니다: ${e.message}`);
    if (e instanceof ApplyFailure) return failure(0, 1, '', e.message);
    throw e;
  }
  const st = initialState(base, opts.schemaName, defaults, DEFAULT_SQL_MODE);
  let applied = 0;
  for (const [i, s] of statements.entries()) {
    try {
      if (applyStatement(st, s.ddl, s.noBackslashEscapes)) applied++;
    } catch (e) {
      if (e instanceof ApplyFailure || e instanceof ParseError || e instanceof LexError || e instanceof UnsafeValueError) return failure(i + 1, s.line, s.ddl, e.message);
      throw e;
    }
  }
  if (applied === 0) return failure(0, 1, '', '적용할 DDL 문장이 없습니다');
  return { ok: true, model: st.model, applied, renames: collectRenames(st), defaults };
}

const failure = (index: number, line: number, statement: string, reason: string): ApplyResult =>
  ({ ok: false, error: { index, line, statement: statement.slice(0, MAX_STATEMENT_TEXT), reason } });

// 스키마 기본 문자셋·콜레이션: 이름을 MySQL 표기로 맞춘다. 안 준 값(undefined 포함)은 MySQL 기본값으로 채우되,
// 문자셋만 주면 그 문자셋의 기본 콜레이션을, 콜레이션만 주면 그 콜레이션의 문자셋을 쓴다. 둘 다 주면 서로 맞는지 본다
export function resolveDefaults(given: Partial<ApplyDefaults> = {}): ApplyDefaults {
  const collation = given.collation === undefined ? undefined : canonicalCollation(given.collation);
  if (given.charset === undefined) return collation === undefined ? { ...MYSQL_DEFAULTS } : { charset: charsetOfCollation(collation), collation };
  const charset = canonicalCharset(given.charset);
  if (collation === undefined) return { charset, collation: primaryCollation(charset) };
  if (charsetOfCollation(collation) !== charset) fail(`스키마 기본 콜레이션 ${collation} 은 문자셋 ${charset} 의 콜레이션이 아닙니다 (MySQL 1253)`);
  return { charset, collation };
}

// DDL 을 적용했으면 true, 세션 문장(SET·USE)과 무시하는 문장(isNoOp)이면 false
function applyStatement(st: State, statement: string, noBackslashEscapes: boolean): boolean {
  assertSameBackslashMode(st, statement, noBackslashEscapes);
  const { toks, ddl } = withoutCommentEnd(statement, tokenize(statement, { noBackslashEscapes }));
  const c = new Cursor(toks, ddl);
  if (c.isWord('SET') || c.isWord('USE') || isNoOp(c)) assertOneStatement(c.toks);
  if (c.isWord('SET')) {
    applySet(st, c);
    return false;
  }
  if (c.acceptWord('USE')) {
    const db = c.ident();
    if (db !== st.schemaName || !c.done) fail(`다른 스키마로 USE 할 수 없습니다: ${db}`);
    return false;
  }
  if (isNoOp(c)) return false;
  if (!isCreateRoutine(ddl)) assertBmpStrings(c.toks);
  if (noBackslashEscapes && !isCreateRoutine(ddl)) assertNoBackslashTypeValues(c.toks, ddl);
  if (c.acceptWord('ALTER', 'TABLE')) alterTable(st, c);
  else if (c.acceptWord('DROP', 'INDEX')) dropIndexOn(st, c);
  else if (c.isWord('CREATE', 'INDEX') || ['UNIQUE', 'FULLTEXT', 'SPATIAL'].some((w) => c.isWord('CREATE', w, 'INDEX'))) {
    c.next();
    createIndex(st, c);
  }
  else if (c.acceptWord('CREATE', 'TABLE')) createTable(st, c);
  else if (c.acceptWord('DROP', 'TABLE')) dropTable(st, c);
  else if (c.acceptWord('RENAME', 'TABLE')) renameTables(st, c);
  else if (c.acceptWord('DROP', 'VIEW')) dropView(st, c);
  else if (c.isWord('DROP', 'FUNCTION') || c.isWord('DROP', 'PROCEDURE')) {
    c.next();
    dropRoutine(st, c);
  } else if (isCreateRoutine(ddl)) createRoutine(st, ddl, noBackslashEscapes);
  else return fail(unsupported(ddl));
  return true;
}

// 스키마(SHOW CREATE 결과)를 바꾸지 않는 문장 — 이미 MySQL 에서 돈 스크립트에 흔해 무시한다 (적용한 문장 수에 세지 않는다): 트랜잭션 제어, LOCK·UNLOCK TABLES,
// 데이터 문장, 권한. DDL 은 MySQL 이 암묵적으로 커밋하므로 ROLLBACK 이 되돌리지 않고, TRUNCATE 가 바꾸는 AUTO_INCREMENT 값은 비교하지 않는다
const NO_OP_WORDS: ReadonlySet<string> = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'TRUNCATE', 'GRANT', 'REVOKE']);

function isNoOp(c: Cursor): boolean {
  const first = c.peek();
  if (first?.t !== 'word') return false;
  return NO_OP_WORDS.has(first.v.toUpperCase()) || c.isWord('START', 'TRANSACTION') || ['LOCK', 'UNLOCK'].some((w) => c.isWord(w, 'TABLES') || c.isWord(w, 'TABLE'));
}

// 무시하는 문장(SET·USE·isNoOp)은 첫 단어만 보고 덩어리를 통째로 넘긴다. 그런데 구분자를 바꾼 뒤(DELIMITER ;; 를 되돌리지 않음)에는 ';' 가 문장을 끝내지 않고,
// mysql 클라이언트 명령 '\g'·'\G' 도 문장을 끝내므로 한 덩어리에 문장이 여럿 들 수 있다 — 그대로 넘기면 뒤 DDL 이 조용히 사라지므로 받지 않는다 (끝의 ';' 만은 괜찮다)
function assertOneStatement(toks: readonly Token[]): void {
  const isSemicolon = (t: Token) => t.t === 'op' && t.v === ';';
  const end = toks.findIndex(isSemicolon);
  const continues = end >= 0 && toks.slice(end).some((t) => !isSemicolon(t));
  if (!continues && !toks.some((t) => t.t === 'op' && t.v === '\\')) return;
  fail(`한 문장 뒤에 다른 문장이 이어져 있습니다 (DELIMITER 를 ';' 로 되돌리지 않았거나 '\\g' 를 썼습니다) — 무시하는 문장과 함께 뒤 문장이 버려지지 않도록 받지 않습니다 — ${RE_EXPORT}`);
}

// 문장 나누기(splitDump)는 SET SQL_MODE = '…' 꼴만 따라가 NO_BACKSLASH_ESCAPES 를 켜고 끈다. SET 문(applySet)이 바꾼 세션 SQL_MODE 와 어긋나면
// (@@sql_mode·:=·@변수·큰따옴표, SET GLOBAL) 이 문장의 문자열을 MySQL 과 다른 이스케이프 규칙으로 읽었으므로, 백슬래시가 든 문장은 받지 않는다 (백슬래시가 없으면 두 규칙이 같다)
function assertSameBackslashMode(st: State, ddl: string, noBackslashEscapes: boolean): void {
  if (routineLexMode(st.sqlMode).noBackslashEscapes === noBackslashEscapes || !ddl.includes('\\')) return;
  fail(`앞의 SET 문이 바꾼 SQL_MODE 의 NO_BACKSLASH_ESCAPES 를 문장 나누기와 다르게 읽어 백슬래시가 든 이 문장을 MySQL 과 같게 읽을 수 없습니다 (SET SQL_MODE = '…' 꼴로 쓰면 됩니다) — ${RE_EXPORT}`);
}

// NO_BACKSLASH_ESCAPES 세션에서 ENUM·SET 값에 백슬래시가 있으면 거부한다: 타입 정규화가 타입 원문을 보통 이스케이프 규칙으로 다시 읽어 값이 바뀐다.
// 같은 세션의 COMMENT·DEFAULT 는 토큰 값을 그대로 써서 백슬래시가 MySQL 과 같게 남는다 (8.4.11 실측). 토큰을 한 번만 돌며 열린 괄호마다 ENUM·SET 인자 괄호인지 기억해,
// 그런 괄호 안(더 깊이 중첩된 괄호 안 포함)의 문자열만 본다 — ENUM( 마다 짝 괄호까지 다시 훑으면 중첩 괄호에서 제곱 시간이다 (리뷰 1회차 M-2)
function assertNoBackslashTypeValues(toks: readonly Token[], ddl: string): void {
  const opened: boolean[] = []; // 열린 괄호마다: ENUM·SET 바로 뒤의 괄호인가
  let typeArgs = 0; // 열린 ENUM·SET 인자 괄호 수
  toks.forEach((t, k) => {
    if (t.t === 'op' && t.v === '(') {
      const prev = toks[k - 1];
      const isTypeArgs = prev?.t === 'word' && /^(ENUM|SET)$/i.test(prev.v);
      opened.push(isTypeArgs);
      if (isTypeArgs) typeArgs++;
    } else if (t.t === 'op' && t.v === ')') {
      if (opened.pop()) typeArgs--;
    } else if (typeArgs > 0 && t.t === 'string' && ddl.slice(t.s, t.e).includes('\\')) {
      fail(`NO_BACKSLASH_ESCAPES 세션에서 백슬래시가 든 ENUM·SET 값은 받을 수 없습니다 — ${RE_EXPORT}`);
    }
  });
}

// 문장의 문자열 리터럴에 4바이트 문자가 있으면 거부한다 (DEFAULT·COMMENT·ENUM 값). 루틴은 본문이 쓴 그대로 찍히므로 COMMENT 만 object-stmt 가 본다
function assertBmpStrings(toks: readonly Token[]): void {
  for (const t of toks) if (t.t === 'string') assertBmpText(t.v, '문자열');
}

// 실행 주석(/*!NNNNN … */)으로 감싼 문장 ('/*!40101 SET … */;' — mysqldump 머리·꼬리): 문장 나누기가 여는 표지만 떼고 닫는 '*/' 를 문장 끝에 남긴다.
// 문장 끝에 붙은 '*' '/' 는 올바른 문장에 있을 수 없으므로 실행 주석의 끝으로 보고 토큰과 원문에서 함께 뗀다 (원문은 루틴 본문이 된다 — 리뷰 1회차 F2).
// 안의 문장은 MySQL 이 그대로 실행한다
function withoutCommentEnd(statement: string, toks: Token[]): { toks: Token[]; ddl: string } {
  const [star, slash] = toks.slice(-2);
  const closes = star?.t === 'op' && star.v === '*' && slash?.t === 'op' && slash.v === '/' && star.e === slash.s;
  return closes ? { toks: toks.slice(0, -2), ddl: statement.slice(0, star.s).trimEnd() } : { toks, ddl: statement };
}

function unsupported(ddl: string): string {
  if (VIEW_RE.test(ddl)) return `CREATE·ALTER VIEW 는 1차 지원 범위가 아닙니다 (MySQL 이 뷰 본문을 다시 써서 저장합니다) — ${RE_EXPORT}`;
  const head = ddl.split(/\s+/).slice(0, 3).join(' ');
  return `지원하지 않는 문장입니다: ${head} — 1차 지원 범위는 ALTER·CREATE·DROP·RENAME TABLE, CREATE·DROP INDEX, CREATE·DROP FUNCTION·PROCEDURE, DROP VIEW 이고, `
    + `스키마를 바꾸지 않는 문장(트랜잭션 제어·LOCK·데이터 문장·권한)은 무시합니다 — ${RE_EXPORT}`;
}

// 기준 → 결과 이름 대응 (diff 의 rename 매핑 형식). 새로 만든 객체·지운 객체는 들어가지 않는다
function collectRenames(st: State): RenameMapping[] {
  const out: RenameMapping[] = [];
  for (const [to, from] of st.origins.tables) if (from !== undefined && from !== to) out.push({ kind: 'table', from, to });
  for (const [table, cols] of st.origins.columns) for (const [to, from] of cols) if (from !== undefined && from !== to) out.push({ kind: 'column', table, from, to });
  for (const [table, idx] of st.origins.indexes) for (const [to, from] of idx) if (from !== undefined && from !== to && to !== 'PRIMARY') out.push({ kind: 'index', table, from, to });
  return out;
}
