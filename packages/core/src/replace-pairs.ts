// 같은 이름 객체의 삭제·재생성 쌍 (스펙 4.6, 12회차): 한쪽만 수동 확인이면 다른 쪽도 실행하지 않는다.
// 바뀌는 루틴(DROP … IF EXISTS → CREATE), 테이블→뷰(DROP TABLE x → CREATE VIEW x), 뷰→테이블, 뷰 자리로 들어오는 테이블 rename
// (DROP VIEW v → RENAME TABLE t TO v). CREATE 만 막히고 DROP 이 실행되면 객체가 사라지고, DROP 만 막히면 CREATE 가 실패한다
import type { Statement } from './ddl';
import { isManual } from './ddl-alter';
import { routineNameKey } from './diff';

export interface PairKeys {
  relations: Set<string>; // 테이블·뷰 이름 (TARGET)
  routines: Set<string>; // routinePairKey
}

export const isRoutineStatement = (st: Statement): boolean => st.kind === 'function' || st.kind === 'procedure';
export const routinePairKey = (st: Pick<Statement, 'kind' | 'object'>): string => `${st.kind} ${routineNameKey(st.object)}`;

const relationNames = (st: Statement): string[] => (st.kind === 'table' ? st.related ?? [st.object] : [st.object]);
const isDrop = (st: Statement): boolean => st.op === 'drop';
const isCreate = (st: Statement): boolean => st.op === 'add' || (st.kind === 'table' && st.op === 'rename');

// 묶음 안에 수동 확인 문장과 실행 문장이 함께 있다
const isHalfBlocked = (group: Statement[]): boolean => group.some(isManual) && group.some((st) => !st.comment);

function groupBy(stmts: Statement[], keys: (st: Statement) => string[]): Map<string, Statement[]> {
  const out = new Map<string, Statement[]>();
  for (const st of stmts) for (const k of keys(st)) out.set(k, [...(out.get(k) ?? []), st]);
  return out;
}

// 한쪽만 수동 확인인 쌍의 키
export function halfBlockedPairs(stmts: Statement[]): PairKeys {
  const relations = new Set<string>();
  for (const [name, group] of groupBy(stmts.filter((st) => !isRoutineStatement(st)), relationNames)) {
    const pair = [...group.filter(isDrop), ...group.filter(isCreate)];
    if (group.some(isDrop) && group.some(isCreate) && isHalfBlocked(pair)) relations.add(name);
  }
  const routines = new Set<string>();
  for (const [key, group] of groupBy(stmts.filter(isRoutineStatement), (st) => [routinePairKey(st)])) {
    if (group.length > 1 && isHalfBlocked(group)) routines.add(key);
  }
  return { relations, routines };
}

export const PAIR_NOTE = '같은 이름 객체의 삭제·재생성은 함께 실행해야 합니다 (삭제만 실행하면 객체가 사라집니다)';
export const pairReason = (name: string): string => `${name}: 같은 이름 객체의 삭제·재생성 중 한쪽이 수동 확인이라 함께 실행하지 않습니다 — 직접 작성하세요`;
