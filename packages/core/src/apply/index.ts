// ALTER 스크립트 → 새 모델. 문장마다 MySQL 과 같은 결과를 만들고, 받을 수 없는 문장에서 멈춘다 (부분 적용하지 않는다)
import { Cursor, ParseError } from '../cursor';
import type { RenameMapping } from '../diff';
import { LexError, tokenize, type Token } from '../lexer';
import type { SchemaModel } from '../model';
import { splitDump } from '../parse-dump';
import { UnsafeValueError } from '../sql-safety';
import { alterTable, createIndex, dropIndexOn } from './alter-table';
import { canonicalCharset, canonicalCollation, charsetOfCollation, primaryCollation } from './normalize-mysql';
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

// DDL 을 적용했으면 true, 세션 문장(SET·USE)이면 false
function applyStatement(st: State, ddl: string, noBackslashEscapes: boolean): boolean {
  const c = new Cursor(withoutCommentEnd(tokenize(ddl, { noBackslashEscapes })), ddl);
  if (c.isWord('SET')) {
    applySet(st, c);
    return false;
  }
  if (c.acceptWord('USE')) {
    const db = c.ident();
    if (db !== st.schemaName || !c.done) fail(`다른 스키마로 USE 할 수 없습니다: ${db}`);
    return false;
  }
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

// 실행 주석(/*!NNNNN … */)으로 감싼 문장 ('/*!40101 SET … */;' — mysqldump 머리·꼬리): 문장 나누기가 여는 표지만 떼고 닫는 '*/' 를 문장 끝에 남긴다.
// 문장 끝에 붙은 '*' '/' 는 올바른 문장에 있을 수 없으므로 실행 주석의 끝으로 보고 뗀다. 안의 문장은 MySQL 이 그대로 실행한다
function withoutCommentEnd(toks: Token[]): Token[] {
  const [star, slash] = toks.slice(-2);
  const closes = star?.t === 'op' && star.v === '*' && slash?.t === 'op' && slash.v === '/' && star.e === slash.s;
  return closes ? toks.slice(0, -2) : toks;
}

function unsupported(ddl: string): string {
  if (VIEW_RE.test(ddl)) return `CREATE·ALTER VIEW 는 1차 지원 범위가 아닙니다 (MySQL 이 뷰 본문을 다시 써서 저장합니다) — ${RE_EXPORT}`;
  const head = ddl.split(/\s+/).slice(0, 3).join(' ');
  return `지원하지 않는 문장입니다: ${head} — 1차 지원 범위는 ALTER·CREATE·DROP·RENAME TABLE, CREATE·DROP INDEX, CREATE·DROP FUNCTION·PROCEDURE, DROP VIEW 입니다`;
}

// 기준 → 결과 이름 대응 (diff 의 rename 매핑 형식). 새로 만든 객체·지운 객체는 들어가지 않는다
function collectRenames(st: State): RenameMapping[] {
  const out: RenameMapping[] = [];
  for (const [to, from] of st.origins.tables) if (from !== undefined && from !== to) out.push({ kind: 'table', from, to });
  for (const [table, cols] of st.origins.columns) for (const [to, from] of cols) if (from !== undefined && from !== to) out.push({ kind: 'column', table, from, to });
  for (const [table, idx] of st.origins.indexes) for (const [to, from] of idx) if (from !== undefined && from !== to && to !== 'PRIMARY') out.push({ kind: 'index', table, from, to });
  return out;
}
