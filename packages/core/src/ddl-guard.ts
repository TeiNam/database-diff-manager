// 그대로 실행하면 데이터가 어긋나거나 DDL 이 실패하는 테이블·뷰의 문장을 수동 확인 문장으로 바꾼다 (스펙 4.6)
// 원칙: MySQL 로 검증한 패턴만 실행 SQL 로 내고, 얽힌 조합은 관련 객체 전체를 막는다
import type { Statement } from './ddl';
import { isAlterBlocked, manualBody, manualNote } from './ddl-alter';
import { retypeGroups } from './fk-retype';
import { routineNameKey, type SchemaDiff, type TableDiff, type ViewDiff } from './diff';
import { objectReferences } from './lexer';
import { renameGroups } from './table-rename';

interface Conflict {
  reason: string;
  notes: string[];
}

type Conflicts = Map<string, Conflict>;

export function guardStatements(stmts: Statement[], diff: SchemaDiff): Statement[] {
  const alterBlocked = alterBlockedNames(diff);
  const tables = spreadConflicts(diff, seedConflicts(diff, stmts), alterBlocked);
  const unparsed = unparsedObjects(diff);
  const views = viewConflicts(diff.views, new Set([...blockedNames(diff, tables), ...alterBlocked, ...unparsed.views]), unparsed.functions);
  if (!tables.size && !views.size) return stmts;
  return guard(stmts, tables, views);
}

// 본 ALTER 만 수동 확인인 테이블의 옛·새 이름. 그 테이블의 다른 문장은 그대로 두고, 그 테이블을 참조하는 바뀌는 FK·
// 그 테이블을 읽는 바뀌는 뷰만 막는다 (막힌 ALTER 가 만들 컬럼·인덱스를 쓰면 실패한다. 일상 변경 과잉 차단을 피해 rename 묶음으로는 넓히지 않는다)
function alterBlockedNames(diff: SchemaDiff): Set<string> {
  const out = new Set<string>();
  for (const d of diff.tables) {
    if ((d.op !== 'modify' && d.op !== 'rename') || !isAlterBlocked(d)) continue;
    out.add(d.name);
    if (d.oldName) out.add(d.oldName);
  }
  return out;
}

const addConflict = (out: Conflicts, table: string, reason: string, note: string) => {
  const prev = out.get(table);
  out.set(table, { reason: prev?.reason ?? reason, notes: [...(prev?.notes ?? []), note] });
};

// 출발점: 순서로 풀 수 없는 rename ('이름 충돌'로 적용되지 않은 매핑. 컬럼은 TARGET 테이블, 테이블 매핑은 옛·새 이름 두
// 테이블 — 옛 이름 테이블이 그대로 남거나 새 이름 테이블이 따로 만들어진다), diff 가 찾은 수동 확인 테이블, 생성이 막힌 새 테이블
function seedConflicts(diff: SchemaDiff, stmts: Statement[]): Conflicts {
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
  // 생성 문장이 수동 확인(주석)인 새 테이블: 이유(파싱 실패, MD 생성식 미상·파싱 실패 등)와 무관하게 CREATE 를 실행하지 않으므로
  // 그 테이블을 참조하는 FK(바뀌는 FK 는 DROP/ADD 를 함께)·읽는 뷰도 막는다. 실제로 만든 문장으로 판정해 이유가 늘어도 빠지지 않는다
  for (const st of stmts) {
    if (st.kind !== 'table' || st.op !== 'add' || !st.comment || st.fkAdds) continue;
    addConflict(out, st.object, `${st.object}: 생성 문장이 수동 확인이라 실행하지 않습니다 — 원문을 확인해 직접 실행하세요`, '생성 문장을 실행하지 않는 테이블입니다');
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
// 다른 테이블의 ALTER 가 엉뚱한 테이블의 데이터를 바꾼다), 막힌 테이블(본 ALTER 만 막힌 테이블 포함)을 참조하는 FK 를
// 바꾸거나 새로 추가하는 테이블, 막힌 테이블(본 ALTER 만 막힌 테이블 포함)이 든 fk-retype 묶음의 모든 테이블 (묶음은 FK 해제 →
// 부모·자식 MODIFY → FK 재추가가 함께 실행돼야 한다. 한 테이블 MODIFY 만 빠지면 재추가가 error 3780 으로 실패해 FK 가 사라진다)
function spreadConflicts(diff: SchemaDiff, seeds: Conflicts, alterBlocked: ReadonlySet<string>): Conflicts {
  if (!seeds.size && !alterBlocked.size) return seeds;
  const out = new Map(seeds);
  const groups = renameGroups(diff.tables, new Set());
  // 새 테이블도 8단계에서 FK 를 추가하므로 함께 본다
  const changed = diff.tables.filter((d) => d.op !== 'drop');
  const retyped = [...new Map([...retypeGroups(diff.tables).values()].map((g) => [g.join('\n'), g])).values()];
  for (;;) {
    const before = out.size;
    const blocked = blockedNames(diff, out);
    for (const g of groups) {
      if (!g.tables.some((d) => blocked.has(d.name) || blocked.has(d.oldName!))) continue;
      const pairs = g.tables.map((d) => `${d.oldName}→${d.name}`).join(', ');
      for (const d of g.tables) {
        if (out.has(d.name)) continue;
        out.set(d.name, { reason: `${d.name}: 함께 묶인 테이블 rename 이 수동 확인이라 실행하지 않습니다 — 값 대응을 확인해 직접 작성하세요`, notes: [`테이블 rename 묶음(${pairs})의 다른 테이블이 수동 확인입니다`] });
      }
    }
    const referenced = new Set([...blocked, ...alterBlocked]);
    for (const g of retyped) {
      const hit = g.find((n) => referenced.has(n));
      if (hit === undefined) continue;
      for (const n of g) {
        if (out.has(n)) continue;
        out.set(n, { reason: `${n}: FK 로 묶여 컬럼 타입이 함께 바뀌는 테이블(${g.join(', ')}) 중 ${hit} 의 문장이 수동 확인이라 실행하지 않습니다 — 직접 작성하세요`, notes: [`FK 해제·컬럼 변경·FK 재추가는 묶음(${g.join(', ')})을 함께 실행해야 합니다 (error 3780)`] });
      }
    }
    for (const d of changed) {
      const refs = out.has(d.name) ? [] : referencingFks(d, referenced);
      if (!refs.length) continue;
      out.set(d.name, { reason: `${d.name}: 참조하는 테이블의 문장이 수동 확인이라 FK 변경을 실행하지 않습니다 — 직접 작성하세요`, notes: [`FK ${refs.map((f) => f.name).join(', ')} 가 수동 확인 테이블을 참조합니다`] });
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
const blockedUses = (body: string, relations: ReadonlySet<string>, functions: readonly string[]): string[] => {
  const refs = objectReferences(body, [...relations, ...functions]);
  const calls = new Set(refs.routines.map(routineNameKey));
  return [...refs.relations.filter((n) => relations.has(n)), ...functions.filter((n) => calls.has(routineNameKey(n)))];
};

// 막힌 테이블·뷰를 읽거나 막힌 함수를 부르는 뷰의 생성·삭제도 막는다
function viewConflicts(views: ViewDiff[], blocked: ReadonlySet<string>, functions: readonly string[]): Conflicts {
  const out: Conflicts = new Map();
  const names = new Set(blocked);
  const reads = (v: ViewDiff) => [...new Set([v.from?.body, v.to?.body].flatMap((b) => (b === undefined ? [] : blockedUses(b, names, functions))))];
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
