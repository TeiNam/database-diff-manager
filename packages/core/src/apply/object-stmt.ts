// CREATE·DROP FUNCTION·PROCEDURE, DROP VIEW. 루틴 본문은 쓴 그대로 저장한다 (MySQL SHOW CREATE 도 그렇다)
import { ParseError, type Cursor } from '../cursor';
import { routineNameKey } from '../diff';
import type { Routine, RoutineKind } from '../model';
import { parseRoutine } from '../parse-routine';
import { routineReturns } from './normalize-mysql';
import { objectName, objectNameList, type State } from './state';
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
  const r = readRoutine(ifNotExists ? ddl.replace(IF_NOT_EXISTS_RE, '$1') : ddl, noBackslashEscapes);
  if (st.model.routines.some((x) => x.kind === r.kind && routineNameKey(x.name) === routineNameKey(r.name))) {
    if (ifNotExists) return;
    fail(`${label(r.kind)} \`${r.name}\` 이 이미 있습니다 (MySQL 1304)`);
  }
  const returns = r.returns === undefined ? {} : { returns: routineReturns(r.returns, st.defaults.charset) };
  st.model.routines = [...st.model.routines, { ...r, ...returns, sqlMode: st.sqlMode }];
}

function readRoutine(ddl: string, noBackslashEscapes: boolean): Routine {
  if (QUALIFIED_NAME_RE.test(ddl)) fail(`스키마를 붙인 루틴 이름은 받을 수 없습니다 — ${RE_EXPORT}`);
  const r = parseOrFail(ddl, noBackslashEscapes);
  // parseRoutine 은 SHOW CREATE 출력을 읽도록 만들어져 COMMENT 를 SQL_MODE 와 상관없이 일반 이스케이프 규칙으로 다시 읽는다.
  // NO_BACKSLASH_ESCAPES 세션에서 직접 쓴 COMMENT 의 백슬래시는 값이 달라지므로 받지 않는다
  if (noBackslashEscapes && r.characteristics.comment !== undefined && ddl.includes('\\')) {
    fail(`NO_BACKSLASH_ESCAPES 세션에서 백슬래시가 든 루틴 COMMENT 는 받을 수 없습니다 — ${RE_EXPORT}`);
  }
  return r;
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
  const left = st.model.routines.filter((r) => !(r.kind === kind && routineNameKey(r.name) === routineNameKey(name)));
  if (left.length === st.model.routines.length && !ifExists) fail(`${label(kind)} \`${name}\` 이 없습니다 (MySQL 1305)`);
  st.model.routines = left;
}

// DROP VIEW [IF EXISTS] v [, w …] [RESTRICT|CASCADE]. 하나라도 없으면(IF EXISTS 제외) 아무것도 지우지 않는다
export function dropView(st: State, c: Cursor): void {
  const ifExists = c.acceptWord('IF', 'EXISTS');
  const names = objectNameList(c, st);
  const missing = names.filter((n) => !st.model.views.some((v) => v.name === n));
  if (missing.length && !ifExists) fail(`뷰 \`${missing.join('`, `')}\` 이 없습니다 (MySQL 1051)`);
  st.model.views = st.model.views.filter((v) => !names.includes(v.name));
}
