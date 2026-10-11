// 그대로 실행하면 데이터가 어긋나거나 DDL 이 실패하는 테이블·뷰의 문장을 수동 확인 문장으로 바꾼다 (스펙 4.6)
// 원칙: MySQL 로 검증한 패턴만 실행 SQL 로 내고, 얽힌 조합은 관련 객체 전체를 막는다
import type { Statement } from './ddl';
import { commentBody, manualBody } from './ddl-alter';
import type { SchemaDiff, TableDiff, ViewDiff } from './diff';
import { quoteIdent as q } from './lexer';
import { renameGroups } from './table-rename';

interface Conflict {
  reason: string;
  notes: string[];
}

type Conflicts = Map<string, Conflict>;

export function guardStatements(stmts: Statement[], diff: SchemaDiff): Statement[] {
  const tables = spreadConflicts(diff, seedConflicts(diff));
  if (!tables.size) return stmts;
  return guard(stmts, tables, viewConflicts(diff.views, blockedNames(diff, tables)));
}

const addConflict = (out: Conflicts, table: string, reason: string, note: string) => {
  const prev = out.get(table);
  out.set(table, { reason: prev?.reason ?? reason, notes: [...(prev?.notes ?? []), note] });
};

// 출발점: 순서로 풀 수 없는 rename ('이름 충돌'로 적용되지 않은 매핑. 컬럼은 TARGET 테이블, 테이블 매핑은 옛·새 이름 두
// 테이블 — 옛 이름 테이블이 그대로 남거나 새 이름 테이블이 따로 만들어진다)과 diff 가 찾은 수동 확인 테이블
function seedConflicts(diff: SchemaDiff): Conflicts {
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
  return out;
}

// 막힌 테이블의 옛·새 이름
function blockedNames(diff: SchemaDiff, conflicts: Conflicts): Set<string> {
  const out = new Set(conflicts.keys());
  for (const d of diff.tables) if (d.oldName && conflicts.has(d.name)) out.add(d.oldName);
  return out;
}

// 더 이상 늘지 않을 때까지 넓힌다: 막힌 테이블이 든 얽힌 rename 묶음의 모든 테이블 (묶음 RENAME 이 실행되지 않으면
// 다른 테이블의 ALTER 가 엉뚱한 테이블의 데이터를 바꾼다), 막힌 테이블을 참조하는 FK 를 바꾸는 테이블
function spreadConflicts(diff: SchemaDiff, seeds: Conflicts): Conflicts {
  if (!seeds.size) return seeds;
  const out = new Map(seeds);
  const groups = renameGroups(diff.tables, new Set());
  const altered = diff.tables.filter((d) => d.op === 'modify' || d.op === 'rename');
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
    for (const d of altered) {
      const refs = out.has(d.name) ? [] : referencingFks(d, blocked);
      if (!refs.length) continue;
      out.set(d.name, { reason: `${d.name}: 참조하는 테이블의 문장이 수동 확인이라 FK 변경을 실행하지 않습니다 — 직접 작성하세요`, notes: [`FK ${refs.map((f) => f.name).join(', ')} 가 수동 확인 테이블을 참조합니다`] });
    }
    if (out.size === before) return out;
  }
}

const referencingFks = (d: TableDiff, blocked: ReadonlySet<string>) =>
  d.foreignKeys.filter((f) => [f.from?.refTable, f.to?.refTable].some((n) => n !== undefined && blocked.has(n)));

// 막힌 테이블(또는 막힌 뷰)을 읽는 뷰의 생성·삭제도 막는다 (본문에 `이름` 이 나오면 읽는 것으로 본다)
function viewConflicts(views: ViewDiff[], blocked: ReadonlySet<string>): Conflicts {
  const out: Conflicts = new Map();
  const names = new Set(blocked);
  const reads = (v: ViewDiff) => [...names].filter((n) => [v.from?.body, v.to?.body].some((b) => b?.includes(q(n))));
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
    { object: name, kind: 'table', op: 'modify', ...commentBody(`-- [수동 확인 필요] ${c.reason}`), notes: c.notes }
  ));
  return [...guarded, ...extra];
}
