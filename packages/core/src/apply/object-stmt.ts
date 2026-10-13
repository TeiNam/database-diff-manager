// CREATE·DROP FUNCTION·PROCEDURE, DROP VIEW. 루틴 본문은 쓴 그대로 저장한다 (MySQL SHOW CREATE 도 그렇다)
import { ParseError, type Cursor } from '../cursor';
import { tokenize } from '../lexer';
import type { Routine, RoutineCharacteristics, RoutineKind } from '../model';
import { parseRoutine } from '../parse-routine';
import { isDefaultCharacteristic } from '../routine-defaults';
import { assertBmpText, routineReturns } from './normalize-mysql';
import { objectName, objectNameList, routineKey, type State } from './state';
import { fail, RE_EXPORT } from './types';

const CREATE_ROUTINE_RE = /^CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?(?:FUNCTION|PROCEDURE)\b/i;
const IF_NOT_EXISTS_RE = /^(CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?(?:FUNCTION|PROCEDURE)\s+)IF\s+NOT\s+EXISTS\s+/i;
// 이름 앞에 스키마를 붙인 꼴 (`db`.name). parseRoutine 은 식별자 하나만 이름으로 읽는다 (IF NOT EXISTS 는 이미 뗀 문장을 본다)
const QUALIFIED_NAME_RE = /^CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?(?:FUNCTION|PROCEDURE)\s+(?:`(?:[^`]|``)*`|\w+)\s*\./i;
const label = (kind: RoutineKind) => (kind === 'function' ? 'FUNCTION' : 'PROCEDURE');

export const isCreateRoutine = (ddl: string): boolean => CREATE_ROUTINE_RE.test(ddl);

// 루틴은 만들 때의 세션 SQL_MODE 를 기억한다. 이름은 대소문자를 구분하지 않는다
export function createRoutine(st: State, ddl: string, noBackslashEscapes: boolean): void {
  const ifNotExists = IF_NOT_EXISTS_RE.test(ddl);
  const r = readRoutine(withoutTerminator(ifNotExists ? ddl.replace(IF_NOT_EXISTS_RE, '$1') : ddl, noBackslashEscapes), noBackslashEscapes);
  if (st.routineKeys.has(routineKey(r))) {
    if (ifNotExists) return;
    fail(`${label(r.kind)} \`${r.name}\` 이 이미 있습니다 (MySQL 1304)`);
  }
  const returns = r.returns === undefined ? {} : { returns: routineReturns(r.returns, st.defaults.charset, st.defaults.collation) };
  st.model.routines = [...st.model.routines, { ...r, ...returns, sqlMode: st.sqlMode }];
  st.routineKeys.add(routineKey(r));
}

// 문장 끝의 ';' 는 본문이 아니다: DELIMITER 를 바꾼 스크립트의 'RETURN x + 1; //' 에서 MySQL 은 본문을 'RETURN x + 1' 로 저장한다 (8.0.46·8.4.11 실측; 공백이 끼어도, ';' 가 여럿이어도 같다).
// 본문 안의 ';' 는 마지막 토큰이 아니고, 뒤에 주석이 따르는 ';' 는 MySQL 도 본문에 남긴다. 둘 다 건드리지 않는다
function withoutTerminator(ddl: string, noBackslashEscapes: boolean): string {
  const toks = tokenize(ddl, { noBackslashEscapes });
  let cut = ddl.length;
  for (let i = toks.length - 1; i >= 0 && toks[i].t === 'op' && toks[i].v === ';' && /^\s*$/.test(ddl.slice(toks[i].e, cut)); i--) cut = toks[i].s;
  return cut === ddl.length ? ddl : ddl.slice(0, cut).trimEnd();
}

function readRoutine(ddl: string, noBackslashEscapes: boolean): Routine {
  if (QUALIFIED_NAME_RE.test(ddl)) fail(`스키마를 붙인 루틴 이름은 받을 수 없습니다 — ${RE_EXPORT}`);
  const parsed = parseOrFail(ddl, noBackslashEscapes);
  const r: Routine = { ...parsed, characteristics: withoutDefaultCharacteristics(parsed.characteristics) };
  if (r.characteristics.comment !== undefined) assertBmpText(r.characteristics.comment, '루틴 COMMENT');
  // parseRoutine 은 SHOW CREATE 출력을 읽도록 만들어져 COMMENT 를 SQL_MODE 와 상관없이 일반 이스케이프 규칙으로 다시 읽는다.
  // NO_BACKSLASH_ESCAPES 세션에서 직접 쓴 COMMENT 의 백슬래시는 값이 달라지므로 받지 않는다
  if (noBackslashEscapes && r.characteristics.comment !== undefined && ddl.includes('\\')) {
    fail(`NO_BACKSLASH_ESCAPES 세션에서 백슬래시가 든 루틴 COMMENT 는 받을 수 없습니다 — ${RE_EXPORT}`);
  }
  return r;
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
