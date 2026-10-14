// CREATE·DROP FUNCTION·PROCEDURE, DROP VIEW. 루틴 본문은 쓴 그대로 저장한다 (MySQL SHOW CREATE 도 그렇다)
import { ParseError, type Cursor } from '../cursor';
import { tokenize, type Token } from '../lexer';
import type { Routine, RoutineCharacteristics, RoutineKind } from '../model';
import { parseRoutine } from '../parse-routine';
import { isSingleRoutineBody } from '../routine-body';
import { isDefaultCharacteristic } from '../routine-defaults';
import { assertBmpText, routineReturns } from './normalize-mysql';
import { objectName, objectNameList, routineKey, type State } from './state';
import { fail, RE_EXPORT } from './types';

const CREATE_ROUTINE_RE = /^CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?(?:FUNCTION|PROCEDURE)\b/i;
const IF_NOT_EXISTS_RE = /^(CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?(?:FUNCTION|PROCEDURE)\s+)IF\s+NOT\s+EXISTS\s+/i;
// 이름 앞에 스키마를 붙인 꼴 (`db`.name). parseRoutine 은 식별자 하나만 이름으로 읽으므로 현재 스키마면 떼고 읽는다 (IF NOT EXISTS 는 이미 뗀 문장을 본다)
const QUALIFIED_NAME_RE = /^(CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?(?:FUNCTION|PROCEDURE)\s+)(`(?:[^`]|``)*`|\w+)\s*\.\s*/i;
const label = (kind: RoutineKind) => (kind === 'function' ? 'FUNCTION' : 'PROCEDURE');

export const isCreateRoutine = (ddl: string): boolean => CREATE_ROUTINE_RE.test(ddl);

// 루틴은 만들 때의 세션 SQL_MODE 를 기억한다. 이름은 대소문자를 구분하지 않는다
export function createRoutine(st: State, ddl: string, noBackslashEscapes: boolean): void {
  assertNoExecutableComment(ddl, tokenize(ddl, { noBackslashEscapes }));
  const ifNotExists = IF_NOT_EXISTS_RE.test(ddl);
  const r = readRoutine(withoutSchema(st, withoutTerminator(ifNotExists ? ddl.replace(IF_NOT_EXISTS_RE, '$1') : ddl, noBackslashEscapes)), noBackslashEscapes);
  if (st.routineKeys.has(routineKey(r))) {
    if (ifNotExists) return;
    fail(`${label(r.kind)} \`${r.name}\` 이 이미 있습니다 (MySQL 1304)`);
  }
  const returns = r.returns === undefined ? {} : { returns: routineReturns(r.returns, st.defaults.charset, st.defaults.collation) };
  st.model.routines = [...st.model.routines, { ...r, ...returns, sqlMode: st.sqlMode }];
  st.routineKeys.add(routineKey(r));
}

// 루틴 정의 안의 실행 주석(/*!NNNNN … */, 번호 없는 /*!): MySQL 은 본문을 표지를 지운 글로 저장한다 (8.0.46·8.4.11 실측: 'BEGIN /*!80000 SELECT 1; */ END' →
// 'BEGIN  SELECT 1;  END', 버전이 서버보다 높으면 안의 글까지 지운다). 본문은 쓴 그대로 저장하므로 받지 않는다. 루틴을 통째로 감싼 꼴은 applyStatement 가 이미 풀었고,
// 그 닫는 '*/' 가 문장 가운데 남았으면 (감싼 주석 뒤에 글이 더 있다) 붙은 '*' '/' 토큰으로 보인다. 일반 주석 속 '/*!' 글자도 함께 거부한다 (보수적)
function assertNoExecutableComment(ddl: string, toks: readonly Token[]): void {
  let pos = 0;
  let marked = toks.some((t, k) => t.t === 'op' && t.v === '*' && toks[k + 1]?.t === 'op' && toks[k + 1].v === '/' && toks[k + 1].s === t.e);
  for (const t of [...toks, { s: ddl.length, e: ddl.length }]) {
    marked ||= ddl.slice(pos, t.s).includes('/*!');
    pos = t.e;
  }
  if (marked) fail(`루틴 정의 안의 실행 주석(/*!…*/)은 MySQL 이 표지를 지운 본문으로 저장해 1차 지원 범위가 아닙니다 (루틴을 통째로 감싼 꼴만 받습니다) — ${RE_EXPORT}`);
}

// 문장 끝의 ';' 는 본문이 아니다: DELIMITER 를 바꾼 스크립트의 'RETURN x + 1; //' 에서 MySQL 은 본문을 'RETURN x + 1' 로 저장한다 (8.0.46·8.4.11 실측; 공백이 끼어도, ';' 가 여럿이어도 같다).
// 본문 안의 ';' 는 마지막 토큰이 아니고, 뒤에 주석이 따르는 ';' 는 MySQL 도 본문에 남긴다. 둘 다 건드리지 않는다
function withoutTerminator(ddl: string, noBackslashEscapes: boolean): string {
  const toks = tokenize(ddl, { noBackslashEscapes });
  let cut = ddl.length;
  for (let i = toks.length - 1; i >= 0 && toks[i].t === 'op' && toks[i].v === ';' && /^\s*$/.test(ddl.slice(toks[i].e, cut)); i--) cut = toks[i].s;
  return cut === ddl.length ? ddl : ddl.slice(0, cut).trimEnd();
}

// 현재 스키마로 한정한 이름(`shop`.f)은 테이블처럼 받고 스키마를 뗀다 — MySQL 의 SHOW CREATE 도 스키마를 찍지 않는다. 다른 스키마는 거부한다 (objectName 과 같다)
function withoutSchema(st: State, ddl: string): string {
  const m = QUALIFIED_NAME_RE.exec(ddl);
  if (!m) return ddl;
  const schema = m[2].startsWith('`') ? m[2].slice(1, -1).replace(/``/g, '`') : m[2];
  if (schema !== st.schemaName) fail(`다른 스키마 \`${schema}\` 의 객체는 바꿀 수 없습니다 — 이 버전은 스키마 \`${st.schemaName}\` 하나를 나타냅니다`);
  return m[1] + ddl.slice(m[0].length);
}

function readRoutine(ddl: string, noBackslashEscapes: boolean): Routine {
  const parsed = parseOrFail(ddl, noBackslashEscapes);
  assertOneRoutine(tokenize(parsed.body, { noBackslashEscapes }));
  const r: Routine = { ...parsed, characteristics: withoutDefaultCharacteristics(parsed.characteristics) };
  if (r.characteristics.comment !== undefined) assertBmpText(r.characteristics.comment, '루틴 COMMENT');
  // parseRoutine 은 SHOW CREATE 출력을 읽도록 만들어져 COMMENT 를 SQL_MODE 와 상관없이 일반 이스케이프 규칙으로 다시 읽는다.
  // NO_BACKSLASH_ESCAPES 세션에서 직접 쓴 COMMENT 의 백슬래시는 값이 달라지므로 받지 않는다
  if (noBackslashEscapes && r.characteristics.comment !== undefined && ddl.includes('\\')) {
    fail(`NO_BACKSLASH_ESCAPES 세션에서 백슬래시가 든 루틴 COMMENT 는 받을 수 없습니다 — ${RE_EXPORT}`);
  }
  return r;
}

const isSemicolon = (t: Token): boolean => t.t === 'op' && t.v === ';';

// 구분자 덩어리 하나에는 루틴 하나만 받는다 (리뷰 1회차 I-1): mysql 클라이언트는 덩어리를 다중 문장으로 보내고 서버는 루틴이 끝난 뒤의 문장을 따로 실행하는데
// ('DELIMITER ;;' 를 되돌리지 않은 'RETURN 1; ALTER TABLE …', 'END; DROP TABLE …', 루틴 둘), 덩어리 전체를 본문으로 읽으면 뒤 DDL 이 본문에 들어가 조용히 사라진다.
// 본문 판정은 DDL 생성 쪽 최종 검사와 같은 isSingleRoutineBody 다 (BEGIN … END 하나 또는 ';' 없는 문장 하나). 끝의 ';' 는 본문이 아니다 (withoutTerminator 가 못 뗀,
// 뒤에 주석이 따르는 ';'). 문장을 끊는 mysql 클라이언트 명령('\g'·'\G')도 받지 않는다 — 문자열 밖 백슬래시는 SQL 이 아니다
function assertOneRoutine(body: readonly Token[]): void {
  let end = body.length;
  while (end > 0 && isSemicolon(body[end - 1])) end--;
  const toks = body.slice(0, end);
  if (isSingleRoutineBody(toks) && !toks.some((t) => t.t === 'op' && t.v === '\\')) return;
  fail(`구분자 덩어리 하나에는 루틴 하나만 받습니다 — 루틴 뒤에 다른 문장이 이어져 있거나(DELIMITER 를 되돌리지 않았거나 '\\g' 를 썼습니다) 본문이 BEGIN … END 하나나 ';' 없는 문장 하나가 아니어서 MySQL 과 같게 루틴의 끝을 가를 수 없습니다 — ${RE_EXPORT}`);
}

// 덤프에서 읽은 모델과 같은 모양으로 맞춘다: 직접 쓴 기본값 특성(LANGUAGE SQL·NOT DETERMINISTIC·CONTAINS SQL·SQL SECURITY DEFINER·빈 COMMENT)은 저장하지 않는다.
// 남기면 diff 에 변경이 잘못 잡히고 print·parse 왕복이 달라진다. 기본값이 아닌 특성은 그대로 두고, 새 객체를 돌려준다
function withoutDefaultCharacteristics(ch: RoutineCharacteristics): RoutineCharacteristics {
  return Object.fromEntries(Object.entries(ch).filter(([name, value]) => !isDefaultCharacteristic(name, value)));
}

function parseOrFail(ddl: string, noBackslashEscapes: boolean): Routine {
  try {
    return parseRoutine(ddl, { noBackslashEscapes });
  } catch (e) {
    if (e instanceof ParseError) return fail(`루틴 정의를 읽을 수 없습니다: ${e.message} (MySQL 1064)`);
    throw e;
  }
}

// DROP {FUNCTION|PROCEDURE} [IF EXISTS] name
export function dropRoutine(st: State, c: Cursor): void {
  let kind: RoutineKind = 'function';
  if (!c.acceptWord('FUNCTION')) {
    c.expectWord('PROCEDURE');
    kind = 'procedure';
  }
  const ifExists = c.acceptWord('IF', 'EXISTS');
  const name = objectName(c, st);
  if (!c.done) fail(`알 수 없는 내용입니다: ${c.peek()!.v} (MySQL 1064)`);
  const key = routineKey({ kind, name });
  if (!st.routineKeys.has(key)) {
    if (!ifExists) fail(`${label(kind)} \`${name}\` 이 없습니다 (MySQL 1305)`);
    return;
  }
  st.model.routines = st.model.routines.filter((r) => routineKey(r) !== key);
  st.routineKeys.delete(key);
}

// DROP VIEW [IF EXISTS] v [, w …] [RESTRICT|CASCADE]. 하나라도 없으면(IF EXISTS 제외) 아무것도 지우지 않는다
export function dropView(st: State, c: Cursor): void {
  const ifExists = c.acceptWord('IF', 'EXISTS');
  const names = objectNameList(c, st);
  const present = new Set(st.model.views.map((v) => v.name));
  const missing = names.filter((n) => !present.has(n));
  if (missing.length && !ifExists) fail(`뷰 \`${missing.join('`, `')}\` 이 없습니다 (MySQL 1051)`);
  const dropped = new Set(names);
  st.model.views = st.model.views.filter((v) => !dropped.has(v.name));
}
