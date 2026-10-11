// 그대로 실행하면 데이터가 어긋나거나 DDL 이 실패하는 테이블·뷰의 문장을 수동 확인 문장으로 바꾼다 (스펙 4.6)
// 원칙: MySQL 로 검증한 패턴만 실행 SQL 로 내고, 얽힌 조합은 관련 객체 전체를 막는다
import type { Statement } from './ddl';
import { isAlterBlocked, manualBody, manualNote } from './ddl-alter';
import { hasSafeIdentifiers, isSingleStatement, UNSAFE_IDENTIFIER_REASON, UNSAFE_STATEMENT_REASON } from './statement-check';
import { retypeGroups } from './fk-retype';
import { localSchemas, routineNameKey, type SchemaDiff, type TableDiff, type ViewDiff } from './diff';
import { objectReferences } from './lexer';
import { renameGroups } from './table-rename';
import { halfBlockedPairs, isRoutineStatement, PAIR_NOTE, pairReason, routinePairKey, type PairKeys } from './replace-pairs';

interface Conflict {
  reason: string;
  notes: string[];
}

type Conflicts = Map<string, Conflict>;

export function guardStatements(stmts: Statement[], diff: SchemaDiff): Statement[] {
  // 실행 문장이 한 문장이 아니면(입력 값 주입) 그 문장을 수동 확인으로 돌리고, 생성이 막힌 객체처럼 의존 문장도 함께 막는다
  const checked = stmts.map(singleOrManual);
  const unsafe = checked.filter((st, i) => st !== stmts[i]);
  // 삭제·재생성 쌍의 한쪽만 막히면 그 객체도 막힌 것으로 보고 다시 넓힌다 (고정점, replace-pairs)
  let pairs: PairKeys = { relations: new Set(), routines: new Set() };
  for (;;) {
    const out = guardWith(checked, unsafe, diff, pairs);
    const half = halfBlockedPairs(out);
    const next: PairKeys = { relations: new Set([...pairs.relations, ...half.relations]), routines: new Set([...pairs.routines, ...half.routines]) };
    if (next.relations.size === pairs.relations.size && next.routines.size === pairs.routines.size) return out;
    pairs = next;
  }
}

function guardWith(checked: Statement[], unsafe: Statement[], diff: SchemaDiff, pairs: PairKeys): Statement[] {
  const seeds = seedConflicts(diff, checked, unsafe);
  for (const n of pairs.relations) addConflict(seeds, n, pairReason(n), PAIR_NOTE);
  const tables = spreadConflicts(diff, seeds, alterBlockedTables(diff));
  const unparsed = unparsedObjects(diff);
  const unsafeOf = (kind: Statement['kind']) => unsafe.filter((st) => st.kind === kind).map((st) => st.object);
  const views = viewConflicts(diff.views, localSchemas(diff), new Set([...blockedNames(diff, tables), ...unparsed.views, ...unsafeOf('view')]), [...unparsed.functions, ...unsafeOf('function')]);
  for (const n of pairs.relations) if (!views.has(n)) views.set(n, { reason: pairReason(n), notes: [PAIR_NOTE] });
  if (diff.targetIncomplete) {
    for (const v of diff.views) if ((v.op === 'drop' || isSuspect(diff, v.name)) && !views.has(v.name)) views.set(v.name, incompleteConflict(diff, v.name));
  }
  const out = tables.size || views.size ? guard(checked, tables, views) : checked;
  // 마지막 방어선: 막은 뒤의 문장도 다시 확인한다
  return out.map((st) => {
    if (!isRoutineStatement(st)) return st;
    if (pairs.routines.has(routinePairKey(st))) return toManual(st, pairReason(st.object), [PAIR_NOTE]);
    if (diff.targetIncomplete && (st.op === 'drop' || isSuspect(diff, st.object))) return toManual(st, incompleteConflict(diff, st.object).reason, [INCOMPLETE_NOTE]);
    return st;
  }).map(singleOrManual);
}

// 불완전한 TARGET (식별 불가 파싱 실패 문장·객체 0개·원문 판정): 객체 DROP·DROP COLUMN 은 TARGET 이 정말 그것을 뺀 것인지 알 수 없어
// 실행하지 않는다. 정의가 끊겼을 수 있는 객체(incompleteObjects)는 생성·변경 문장도 실행하지 않는다 (14회차 1)
const INCOMPLETE_NOTE = 'TARGET 이 불완전하면 객체 삭제(DROP TABLE·VIEW·ROUTINE)·컬럼 삭제와 끊긴 객체의 문장을 실행하지 않습니다';
const isSuspect = (diff: SchemaDiff, name: string): boolean => Boolean(diff.incompleteObjects?.includes(name));
const incompleteConflict = (diff: SchemaDiff, name: string): Conflict => (
  { reason: `${name}: TARGET 이 불완전해 실행하지 않습니다 (${diff.targetIncomplete}) — TARGET 파일을 확인하세요`, notes: [INCOMPLETE_NOTE] }
);
// 불완전한 TARGET 에서 막을 테이블: 삭제·끊긴 객체·컬럼을 지우는 변경
const incompleteBlocked = (diff: SchemaDiff, d: TableDiff): boolean =>
  d.op === 'drop' || isSuspect(diff, d.name) || d.columns.some((c) => c.op === 'drop');

function toManual(st: Statement, reason: string, notes: string[] = []): Statement {
  if (st.comment) return st;
  const { delimited: _, ...rest } = st;
  return { ...rest, ...manualBody(reason, st.sql, [...(st.notes ?? []), ...notes]) };
}

// 한 문장이 아니면 그 사유를, 한 문장이어도 이름이 보수적 이름 규칙을 어기면 그 사유를 단다 (statement-check)
function singleOrManual(st: Statement): Statement {
  if (!isSingleStatement(st)) return toManual(st, `${st.object}: ${UNSAFE_STATEMENT_REASON}`);
  return hasSafeIdentifiers(st) ? st : toManual(st, `${st.object}: ${UNSAFE_IDENTIFIER_REASON}`);
}

// 본 ALTER 가 수동 확인인 테이블은 그 테이블의 모든 문장(FK 해제·재추가, rename, 파티션 등)을 막는다 (본 ALTER 없이 FK 해제·재추가만
// 실행하면 재추가가 실패해 FK 가 사라진다). 그 테이블을 참조하는 FK·읽는 뷰·묶인 rename/fk-retype 묶음은 spreadConflicts 가 넓힌다
const ALTER_BLOCKED_NOTE = '본 ALTER 가 수동 확인이라 이 테이블의 다른 문장(FK 해제·추가 등)도 함께 실행하지 않습니다';
const alterBlockedTables = (diff: SchemaDiff): TableDiff[] => diff.tables.filter((d) => (d.op === 'modify' || d.op === 'rename') && isAlterBlocked(d));

const addConflict = (out: Conflicts, table: string, reason: string, note: string) => {
  const prev = out.get(table);
  out.set(table, { reason: prev?.reason ?? reason, notes: [...(prev?.notes ?? []), note] });
};

// 출발점: 순서로 풀 수 없는 rename ('이름 충돌'로 적용되지 않은 매핑. 컬럼은 TARGET 테이블, 테이블 매핑은 옛·새 이름 두
// 테이블 — 옛 이름 테이블이 그대로 남거나 새 이름 테이블이 따로 만들어진다), diff 가 찾은 수동 확인 테이블, 생성이 막힌 새 테이블
function seedConflicts(diff: SchemaDiff, stmts: Statement[], unsafe: Statement[]): Conflicts {
  const out: Conflicts = new Map();
  for (const { mapping: m, reason } of diff.ignoredRenames) {
    if (reason !== '이름 충돌') continue;
    if (m.kind === 'table') {
      const note = `테이블 rename ${m.from}→${m.to} 이 다른 테이블 이름과 겹쳐 적용하지 못했습니다`;
      for (const name of new Set([m.from, m.to])) addConflict(out, name, `${name}: 테이블 rename 이름 충돌 — 값 대응을 확인해 직접 작성하세요`, note);
    } else if (m.kind === 'column' && m.table !== undefined) {
      addConflict(out, m.table, `${m.table}: 컬럼 rename 이름 충돌 — 값 대응을 확인해 직접 작성하세요`, `컬럼 rename ${m.from}→${m.to} 이 다른 컬럼 이름과 겹쳐 적용하지 못했습니다`);
    }
  }
  for (const t of diff.manualTables) addConflict(out, t.table, t.reason, t.note);
  if (diff.targetIncomplete) {
    for (const d of diff.tables) if (incompleteBlocked(diff, d)) addConflict(out, d.name, incompleteConflict(diff, d.name).reason, INCOMPLETE_NOTE);
  }
  // 생성 문장이 수동 확인(주석)인 새 테이블: 이유(파싱 실패, MD 생성식 미상·파싱 실패 등)와 무관하게 CREATE 를 실행하지 않으므로
  // 그 테이블을 참조하는 FK(바뀌는 FK 는 DROP/ADD 를 함께)·읽는 뷰도 막는다. 실제로 만든 문장으로 판정해 이유가 늘어도 빠지지 않는다
  for (const st of stmts) {
    if (st.kind !== 'table' || st.op !== 'add' || !st.comment || st.fkAdds) continue;
    addConflict(out, st.object, `${st.object}: 생성 문장이 수동 확인이라 실행하지 않습니다 — 원문을 확인해 직접 실행하세요`, '생성 문장을 실행하지 않는 테이블입니다');
  }
  for (const st of unsafe) {
    if (st.kind !== 'table') continue;
    for (const n of st.related ?? [st.object]) addConflict(out, n, `${n}: ${UNSAFE_STATEMENT_REASON} — 이 테이블의 문장을 실행하지 않습니다`, '실행 문장이 한 문장이 아닌 테이블입니다');
  }
  return out;
}

// 생성 문장을 실행하지 않는 파싱 실패 객체 이름: 새 함수, TARGET 뷰 (그 함수를 부르거나 그 뷰를 읽는 뷰를 막는다. 뷰는 프로시저를
// 부를 수 없다). 바뀌는 루틴은 옛 정의를 지우지 않으므로(2단계 수동 확인) 남는다
function unparsedObjects(diff: SchemaDiff): { functions: string[]; views: string[] } {
  return {
    functions: diff.routines.filter((r) => r.kind === 'function' && r.op === 'add' && r.to?.parseError).map((r) => r.name),
    views: diff.views.filter((v) => v.op !== 'drop' && v.to?.parseError).map((v) => v.name),
  };
}

// 막힌 테이블의 옛·새 이름
function blockedNames(diff: SchemaDiff, conflicts: Conflicts): Set<string> {
  const out = new Set(conflicts.keys());
  for (const d of diff.tables) if (d.oldName && conflicts.has(d.name)) out.add(d.oldName);
  return out;
}

// 더 이상 늘지 않을 때까지 넓힌다: 막힌 테이블이 든 얽힌 rename 묶음의 모든 테이블 (묶음 RENAME 이 실행되지 않으면
// 다른 테이블의 ALTER 가 엉뚱한 테이블의 데이터를 바꾼다), 막힌 테이블을 참조하는 FK 를
// 바꾸거나 새로 추가하는 테이블, 막힌 테이블이 든 fk-retype 묶음의 모든 테이블 (묶음은 FK 해제 →
// 부모·자식 MODIFY → FK 재추가가 함께 실행돼야 한다. 한 테이블 MODIFY 만 빠지면 재추가가 error 3780 으로 실패해 FK 가 사라진다)
function spreadConflicts(diff: SchemaDiff, seeds: Conflicts, alterBlocked: TableDiff[]): Conflicts {
  if (!seeds.size && !alterBlocked.length) return seeds;
  // 본 ALTER 가 막힌 테이블(옛·새 이름)은 처음부터 막힌 것으로 보고 넓힌다. 사유는 묶음 사유(fk-retype 등)가 먼저 붙으면 그것을 쓴다
  const alterNames = alterBlocked.flatMap((d) => [d.name, ...(d.oldName ? [d.oldName] : [])]);
  const out = new Map(seeds);
  const groups = renameGroups(diff.tables, new Set());
  // 새 테이블도 8단계에서 FK 를 추가하므로 함께 본다
  const changed = diff.tables.filter((d) => d.op !== 'drop');
  const retyped = [...new Map([...retypeGroups(diff.tables).values()].map((g) => [g.join('\n'), g])).values()];
  for (;;) {
    const before = out.size;
    const blocked = new Set([...blockedNames(diff, out), ...alterNames]);
    for (const g of groups) {
      if (!g.tables.some((d) => blocked.has(d.name) || blocked.has(d.oldName!))) continue;
      const pairs = g.tables.map((d) => `${d.oldName}→${d.name}`).join(', ');
      for (const d of g.tables) {
        if (out.has(d.name)) continue;
        out.set(d.name, { reason: `${d.name}: 함께 묶인 테이블 rename 이 수동 확인이라 실행하지 않습니다 — 값 대응을 확인해 직접 작성하세요`, notes: [`테이블 rename 묶음(${pairs})의 다른 테이블이 수동 확인입니다`] });
      }
    }
    for (const g of retyped) {
      const hit = g.find((n) => blocked.has(n));
      if (hit === undefined) continue;
      for (const n of g) {
        if (out.has(n)) continue;
        out.set(n, { reason: `${n}: FK 로 묶여 컬럼 타입이 함께 바뀌는 테이블(${g.join(', ')}) 중 ${hit} 의 문장이 수동 확인이라 실행하지 않습니다 — 직접 작성하세요`, notes: [`FK 해제·컬럼 변경·FK 재추가는 묶음(${g.join(', ')})을 함께 실행해야 합니다 (error 3780)`] });
      }
    }
    for (const d of changed) {
      const refs = out.has(d.name) ? [] : referencingFks(d, blocked);
      if (!refs.length) continue;
      out.set(d.name, { reason: `${d.name}: 참조하는 테이블의 문장이 수동 확인이라 FK 변경을 실행하지 않습니다 — 직접 작성하세요`, notes: [`FK ${refs.map((f) => f.name).join(', ')} 가 수동 확인 테이블을 참조합니다`] });
    }
    for (const d of alterBlocked) {
      if (!out.has(d.name)) out.set(d.name, { reason: `${d.name}: 본 ALTER 가 수동 확인이라 이 테이블의 문장을 실행하지 않습니다 — 직접 작성하세요`, notes: [ALTER_BLOCKED_NOTE] });
    }
    if (out.size === before) return out;
  }
}

// 막힌 테이블을 참조하는 FK: 바뀌는 테이블은 바뀌는 FK, 새 테이블은 추가할 FK 전부
const referencingFks = (d: TableDiff, blocked: ReadonlySet<string>): { name: string }[] => {
  if (d.op === 'add') return (d.to?.foreignKeys ?? []).filter((f) => f.refSchema === undefined && blocked.has(f.refTable));
  return d.foreignKeys.filter((f) => [f.from?.refTable, f.to?.refTable].some((n) => n !== undefined && blocked.has(n)));
};

// 본문이 쓰는 막힌 객체: FROM/JOIN 참조는 막힌 테이블·뷰와, 함수 호출은 막힌 함수와(대소문자 무시) 비교한다 (objectReferences —
// 토큰으로 나눌 수 없으면 `이름` 이 나오기만 해도 쓰는 것으로 본다). 막힌 테이블 f 와 같은 이름의 함수 f() 만 부르는 뷰는 막지 않는다
const blockedUses = (body: string, relations: ReadonlySet<string>, functions: readonly string[], local: ReadonlySet<string> | undefined): string[] => {
  const refs = objectReferences(body, [...relations, ...functions], local);
  const calls = new Set(refs.routines.map(routineNameKey));
  return [...refs.relations.filter((n) => relations.has(n)), ...functions.filter((n) => calls.has(routineNameKey(n)))];
};

// 막힌 테이블·뷰를 읽거나 막힌 함수를 부르는 뷰의 생성·삭제도 막는다
function viewConflicts(views: ViewDiff[], local: ReadonlySet<string> | undefined, blocked: ReadonlySet<string>, functions: readonly string[]): Conflicts {
  const out: Conflicts = new Map();
  const names = new Set(blocked);
  const reads = (v: ViewDiff) => [...new Set([v.from?.body, v.to?.body].flatMap((b) => (b === undefined ? [] : blockedUses(b, names, functions, local))))];
  for (;;) {
    const before = out.size;
    for (const v of views) {
      const hits = out.has(v.name) ? [] : reads(v);
      if (!hits.length) continue;
      out.set(v.name, { reason: `${v.name}: 읽는 객체(${hits.join(', ')})의 문장이 수동 확인이라 뷰를 바꾸지 않습니다 — 직접 작성하세요`, notes: [] });
      names.add(v.name);
    }
    if (out.size === before) return out;
  }
}

// 막힌 테이블·뷰의 모든 문장(FK 삭제·추가, 테이블 rename·생성·삭제, ALTER, 파티션, 뷰 삭제·생성)을 실행하지 않는 수동 확인
// 문장으로 바꾼다. 막힌 테이블의 문장이 하나도 없으면 안내 문장 하나를 만든다
function guard(stmts: Statement[], tables: Conflicts, views: Conflicts): Statement[] {
  const conflictsOf = (st: Statement) => (st.kind === 'table' ? (st.related ?? [st.object]).map((n) => tables.get(n))
    : st.kind === 'view' ? [views.get(st.object)] : []).filter((c): c is Conflict => c !== undefined);
  const guarded = stmts.map((st) => {
    const hits = conflictsOf(st);
    if (!hits.length || st.comment) return st;
    const notes = [...new Set(hits.flatMap((c) => c.notes))];
    return { ...st, ...manualBody(hits[0].reason, st.sql, [...(st.notes ?? []), ...notes]) };
  });
  const covered = new Set(stmts.flatMap((st) => (st.kind === 'table' ? st.related ?? [st.object] : [])));
  const extra = [...tables].filter(([name]) => !covered.has(name)).map(([name, c]): Statement => (
    { object: name, kind: 'table', op: 'modify', ...manualNote(c.reason), notes: c.notes }
  ));
  return [...guarded, ...extra];
}
