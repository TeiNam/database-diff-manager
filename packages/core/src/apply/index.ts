// ALTER 스크립트 → 새 모델. 문장마다 MySQL 과 같은 결과를 만들고, 받을 수 없는 문장에서 멈춘다 (부분 적용하지 않는다)
import { Cursor, ParseError } from '../cursor';
import type { RenameMapping } from '../diff';
import { LexError, tokenize, type Token } from '../lexer';
import type { SchemaModel } from '../model';
import { routineLexMode } from '../normalize';
import { splitForApply, type ApplyStatement } from '../parse-dump';
import { UnsafeValueError } from '../sql-safety';
import { alterTable, createIndex, dropIndexOn } from './alter-table';
import { assertUtf8Session } from './client-charset';
import { LongComment, longCommentReason } from './comment-length';
import { assertBmpText, canonicalCharset, canonicalCollation, charsetOfCollation, primaryCollation } from './normalize-mysql';
import { noOpHandler } from './no-op';
import { createRoutine, dropRoutine, dropView, isCreateRoutine } from './object-stmt';
import { applySet, resolveSqlMode } from './session';
import { initialState, type State } from './state';
import { createTable, dropTable, renameTables } from './table-stmt';
import { ApplyFailure, DEFAULT_SQL_MODE, fail, MYSQL_DEFAULTS, RE_EXPORT, type ApplyDefaults, type ApplyOptions, type ApplyResult } from './types';
import { assertAsciiSpaces } from './unicode-space';
import { assertKnownRealType, assertModeIndependentText } from './unknown-session';
import { executedText, skippedComments } from './version-comment';

export { MYSQL_DEFAULTS, type ApplyDefaults, type ApplyError, type ApplyOptions, type ApplyResult } from './types';
export { printSqlDump } from './print-dump';
export { ApplyFailure } from './types'; // printSqlDump 가 출력할 수 없는 모델에 던진다 — 서버가 400 으로 바꾼다
export { resolveSqlMode } from './session'; // 서버가 기준 버전 루틴의 SQL_MODE 중 처음 세션 SQL_MODE 로 쓸 수 있는 것을 가린다

const MAX_STATEMENT_TEXT = 500;
const VIEW_RE = /^(?:CREATE\s+(?:OR\s+REPLACE\s+)?|ALTER\s+)(?:ALGORITHM\s*=\s*\w+\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:SQL\s+SECURITY\s+\w+\s+)?VIEW\b/i;
const SCHEMA_RE = /^CREATE\s+(?:SCHEMA|DATABASE)\b/i;
// 계정 문장 (리뷰 4회차 M-3): 스키마를 바꾸지 않지만 비밀번호를 담을 수 있다. 적용한 스크립트는 버전 이력에 원문 그대로 남으므로 무시하지 않고 지우라고 안내한다
// (비밀번호가 없는 DROP·RENAME USER 는 무시한다 — no-op.ts). 안내에 문장 글자는 넣지 않는다
const ACCOUNT_RE = /^(?:CREATE|ALTER)\s+USER\b/i;
const ACCOUNT_STATEMENT = '계정 문장(CREATE USER·ALTER USER·SET PASSWORD)은 비밀번호를 담을 수 있어 받지 않습니다 — 적용한 스크립트는 버전 이력에 원문 그대로 남으므로, '
  + '비밀번호가 든 계정 문장은 지우고 다시 넣어 주세요 (계정 문장은 스키마를 바꾸지 않습니다)';

export function applyScript(base: SchemaModel, script: string, opts: ApplyOptions): ApplyResult {
  const text = script.replace(/^\uFEFF/, '');
  let statements: ApplyStatement[];
  let defaults: ApplyDefaults;
  let sqlMode: string;
  try {
    statements = splitForApply(text);
    defaults = resolveDefaults(opts.defaults);
    sqlMode = initialSqlMode(opts.sqlMode);
  } catch (e) {
    if (e instanceof LexError) return failure(0, 1, '', `스크립트를 문장으로 나누지 못했습니다: ${e.message}`);
    if (e instanceof ApplyFailure) return failure(0, 1, '', e.message);
    throw e;
  }
  const st = initialState(base, opts.schemaName, defaults, sqlMode);
  let applied = 0;
  for (const [i, s] of statements.entries()) {
    try {
      if (applyStatement(st, s, text)) applied++;
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

// 처음 세션 SQL_MODE (ApplyOptions.sqlMode). 안 주면 MySQL 8.0/8.4 기본 모드이고, 주면 SET SQL_MODE = '…' 의 값처럼 검사하고 MySQL 순서로 맞춘다
function initialSqlMode(given: string | undefined): string {
  if (given === undefined) return DEFAULT_SQL_MODE;
  try {
    return resolveSqlMode(given);
  } catch (e) {
    if (e instanceof ApplyFailure) return fail(`처음 세션 SQL_MODE(스크립트를 실행한 서버의 sql_mode)를 쓸 수 없습니다: ${e.message}`);
    throw e;
  }
}

type Handler = (st: State, c: Cursor) => void;

// DDL 을 적용했으면 true, 세션 문장(SET·USE)과 무시하는 문장(no-op.ts), 건너뛰는 실행 주석뿐인 문장이면 false. script: 문장을 나눈 원문 (실행 주석의 표지는 문장 앞에 있을 수 있다).
// 모드 검사는 쓴 글 그대로 본다 — 건너뛰는 실행 주석 안의 글도 문장 나누기는 읽었다 (보수적)
function applyStatement(st: State, s: ApplyStatement, script: string): boolean {
  const { noBackslashEscapes } = s;
  const skipped = skippedComments(script, s); // 실행 주석의 버전 번호 (리뷰 11회차 R11-2)
  const statement = executedText(s, skipped);
  assertSameBackslashMode(st, s.ddl, noBackslashEscapes);
  const written = tokenize(s.ddl, { noBackslashEscapes });
  assertModeIndependentText(st, s.ddl, written); // 세션 SQL_MODE 를 모르면 모드에 따라 달리 읽히는 백슬래시·큰따옴표 (리뷰 10회차)
  const tokens = statement === s.ddl ? written : tokenize(statement, { noBackslashEscapes });
  assertAsciiSpaces(script, s, skipped, tokens); // 따옴표·주석 밖의 NBSP 등 (리뷰 11회차 Claude F5)
  return tokens.length > 0 && applyTokens(st, statement, tokens, noBackslashEscapes); // 주석뿐인 문장은 MySQL 도 오류 없이 지나간다
}

// 루틴은 본문 안의 ';' 와 덩어리의 경계를 assertOneRoutine 이 가르고, 그 밖의 문장은 끝의 ';' 를 뗀 덩어리에 문장이 하나만 있어야 한다
// (assertOneStatement — 지원하지 않는 문장은 그보다 먼저 지원 범위 안내로 거부한다)
function applyTokens(st: State, statement: string, tokens: Token[], noBackslashEscapes: boolean): boolean {
  const routine = withoutCommentEnd(statement, tokens).ddl;
  if (isCreateRoutine(routine)) {
    assertUtf8Session(st, statement, tokens); // UTF-8 이 아닌 세션 문자셋 (리뷰 11회차 Claude F4)
    createRoutine(st, routine, noBackslashEscapes);
    return true;
  }
  // 끝의 ';' 를 먼저 떼고 실행 주석의 닫는 '*/' 를 찾는다: 구분자를 바꾼 동안의 '/*!40101 ALTER … */;' 도 안의 문장이다 (리뷰 3회차 M-2)
  const { toks, ddl } = withoutCommentEnd(statement, withoutTrailingSemicolons(tokens));
  const c = new Cursor(toks, ddl);
  const session = sessionHandler(c);
  const handler = session ?? ddlHandler(c) ?? fail(unsupported(ddl));
  assertOneStatement(c.toks);
  if (!session) {
    assertBmpStrings(c.toks);
    assertUtf8Session(st, ddl, c.toks);
    assertKnownRealType(st, c.toks);
    if (noBackslashEscapes) assertNoBackslashTypeValues(c.toks, ddl);
  }
  runHandler(st, handler, c);
  return !session;
}

// 처리기를 부른다. 정의 파서가 던진 긴 COMMENT(LongComment)는 세션 SQL_MODE 에 맞는 안내로 바꾼다 — 파서는 세션을 모른다 (comment-length.ts, 리뷰 11회차 Claude F1)
function runHandler(st: State, handler: Handler, c: Cursor): void {
  try {
    handler(st, c);
  } catch (e) {
    if (e instanceof LongComment) fail(longCommentReason(st, e));
    throw e;
  }
}

// 문장 종류에 맞는 DDL 처리기 (지원하지 않는 문장이면 undefined). c 는 처리기가 읽기 시작할 자리로 옮긴다
function ddlHandler(c: Cursor): Handler | undefined {
  if (c.acceptWord('ALTER', 'TABLE')) return alterTable;
  if (c.acceptWord('DROP', 'INDEX')) return dropIndexOn;
  if (c.isWord('CREATE', 'INDEX') || ['UNIQUE', 'FULLTEXT', 'SPATIAL'].some((w) => c.isWord('CREATE', w, 'INDEX'))) {
    c.next();
    return createIndex;
  }
  if (c.acceptWord('CREATE', 'TABLE')) return createTable;
  if (c.acceptWord('DROP', 'TABLE')) return dropTable;
  if (c.acceptWord('RENAME', 'TABLE')) return renameTables;
  if (c.acceptWord('DROP', 'VIEW')) return dropView;
  if (c.isWord('DROP', 'FUNCTION') || c.isWord('DROP', 'PROCEDURE')) {
    c.next();
    return dropRoutine;
  }
  return undefined;
}

// SET·USE 와 무시하는 문장(no-op.ts)의 처리기 — 적용한 DDL 이 아니다. 아니면 undefined
function sessionHandler(c: Cursor): Handler | undefined {
  if (c.isWord('SET', 'PASSWORD')) return fail(ACCOUNT_STATEMENT);
  if (c.isWord('SET')) return applySet;
  return c.isWord('USE') ? useSchema : noOpHandler(c);
}

function useSchema(st: State, c: Cursor): void {
  c.expectWord('USE');
  const db = c.ident();
  if (db !== st.schemaName || !c.done) fail(`다른 스키마로 USE 할 수 없습니다: ${db}`);
}

const isOp = (t: Token, v: string): boolean => t.t === 'op' && t.v === v;

// 덩어리 끝의 ';' 들은 문장을 끝낼 뿐이라 뗀다: 구분자를 바꾼 동안 'ALTER TABLE …;' 로 끝낸 마지막 문장도 mysql 클라이언트가 그대로 보내고 MySQL 이 받는다 (8.0.46·8.4.11 실측, ';;' 도 같다)
function withoutTrailingSemicolons(toks: readonly Token[]): Token[] {
  let end = toks.length;
  while (end > 0 && isOp(toks[end - 1], ';')) end--;
  return toks.slice(0, end);
}

// 구분자 덩어리 하나에는 문장 하나만 받는다 (리뷰 1회차 I-1·2회차 I-1). 구분자를 바꾼 동안(DELIMITER $$)에는 ';' 가 문장을 끝내지 않고 mysql 클라이언트 명령 '\g'·'\G' 는
// 덩어리 가운데서 문장을 끝내므로 한 덩어리에 문장이 여럿 들 수 있다. mysql 클라이언트는 그 문장을 모두 실행하는데 (8.0.46·8.4.11 실측: 이미 있는 테이블의
// CREATE TABLE IF NOT EXISTS 뒤의 ALTER·DROP 도 실행된다), 첫 문장만 읽거나 무시하면 뒤 DDL 이 조용히 사라진다. 루틴이 아닌 문장에는 문자열 밖의 ';'·백슬래시가 올 수 없다
function assertOneStatement(toks: readonly Token[]): void {
  if (!toks.some((t) => isOp(t, ';') || isOp(t, '\\'))) return;
  fail(`한 문장 뒤에 다른 문장이 이어져 있습니다 (DELIMITER 로 바꾼 구분자 대신 ';' 로 끝냈거나, DELIMITER 를 ';' 로 되돌리지 않았거나, '\\g' 를 썼습니다) — 뒤 문장이 버려지지 않도록 받지 않습니다 — ${RE_EXPORT}`);
}

// 문장 나누기(splitDump)는 SET SQL_MODE = '…' 꼴만 따라가 NO_BACKSLASH_ESCAPES 를 켜고 끈다 (처음에는 꺼져 있다). 세션 SQL_MODE 와 어긋나면
// (SET 문이 @@sql_mode·:=·@변수·큰따옴표·SET GLOBAL 꼴로 바꿨거나, 처음 세션 SQL_MODE 에 있다) 이 문장의 문자열을 MySQL 과 다른 이스케이프 규칙으로 읽었으므로,
// 백슬래시가 든 문장은 받지 않는다 (백슬래시가 없으면 두 규칙이 같다). 세션 SQL_MODE 를 모르면 assertModeIndependentText 가 같은 규칙으로 까닭을 밝혀 거부한다
function assertSameBackslashMode(st: State, ddl: string, noBackslashEscapes: boolean): void {
  if (st.sqlModeUnknown !== undefined || routineLexMode(st.sqlMode).noBackslashEscapes === noBackslashEscapes || !ddl.includes('\\')) return;
  fail(`앞의 SET 문이 바꾼 SQL_MODE 나 서버 SQL_MODE(SET 전의 세션 값)의 NO_BACKSLASH_ESCAPES 를 문장 나누기와 다르게 읽어 백슬래시가 든 이 문장을 MySQL 과 같게 읽을 수 없습니다 `
    + `(그 앞에서 SET SQL_MODE = '…' 꼴로 정하면 됩니다) — ${RE_EXPORT}`);
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
  if (SCHEMA_RE.test(ddl)) return `CREATE SCHEMA·DATABASE 는 현재 스키마의 IF NOT EXISTS 꼴(문자셋·콜레이션 옵션 포함)만 무시하고 그 밖에는 받지 않습니다 — ${RE_EXPORT}`;
  if (ACCOUNT_RE.test(ddl)) return ACCOUNT_STATEMENT;
  const head = ddl.split(/\s+/).slice(0, 3).join(' ');
  return `지원하지 않는 문장입니다: ${head} — 1차 지원 범위는 ALTER·CREATE·DROP·RENAME TABLE, CREATE·DROP INDEX, CREATE·DROP FUNCTION·PROCEDURE, DROP VIEW 이고, `
    + `스키마를 바꾸지 않는 문장(트랜잭션 제어·LOCK·데이터 문장·권한·FLUSH PRIVILEGES·TABLES·테이블 점검·조회)은 무시합니다 — ${RE_EXPORT}`;
}

// 기준 → 결과 이름 대응 (diff 의 rename 매핑 형식). 새로 만든 객체·지운 객체는 들어가지 않는다
function collectRenames(st: State): RenameMapping[] {
  const out: RenameMapping[] = [];
  for (const [to, from] of st.origins.tables) if (from !== undefined && from !== to) out.push({ kind: 'table', from, to });
  for (const [table, cols] of st.origins.columns) for (const [to, from] of cols) if (from !== undefined && from !== to) out.push({ kind: 'column', table, from, to });
  for (const [table, idx] of st.origins.indexes) for (const [to, from] of idx) if (from !== undefined && from !== to && to !== 'PRIMARY') out.push({ kind: 'index', table, from, to });
  return out;
}
