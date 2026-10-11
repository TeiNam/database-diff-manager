// 테이블 rename 을 RENAME TABLE 문장으로 만든다. MySQL 의 RENAME TABLE 은 절을 앞에서부터 차례로 적용하므로
// 연쇄(log→log_2025, log_new→log)는 비는 이름부터 옮기고, 맞바꾸기(a↔b)는 임시 이름을 거쳐 한 문장(원자적)으로 묶는다
import type { TableDiff } from './diff';
import { quoteIdent as q } from './lexer';

const TMP_PREFIX = '__tdm_tmp_';

export interface RenameGroup {
  clauses: [string, string][]; // 실행 순서대로 [옛 이름, 새 이름]
  tables: TableDiff[]; // 이 묶음에 든 rename 테이블 (TABLE diff 순서)
}

// rename 끼리 이름이 얽힌 것(한 rename 의 새 이름이 다른 rename 의 옛 이름)을 한 묶음으로 모은다
export function renameGroups(tables: TableDiff[], taken: ReadonlySet<string>): RenameGroup[] {
  const renames = tables.filter((d) => d.op === 'rename');
  const byOld = new Map(renames.map((d) => [d.oldName!, d]));
  const groupOf = new Map<TableDiff, TableDiff[]>();
  for (const d of renames) {
    if (groupOf.has(d)) continue;
    const members = collect(d, renames, byOld);
    for (const m of members) groupOf.set(m, members);
  }
  const used = new Set(taken);
  const seen = new Set<TableDiff[]>();
  const out: RenameGroup[] = [];
  for (const d of renames) {
    const members = groupOf.get(d)!;
    if (seen.has(members)) continue;
    seen.add(members);
    out.push({ clauses: order(members.map((m) => [m.oldName!, m.name]), used), tables: members });
  }
  return out;
}

export function renameTableSql(clauses: [string, string][]): string {
  return `RENAME TABLE ${clauses.map(([from, to]) => `${q(from)} TO ${q(to)}`).join(', ')}`;
}

// d 와 이름으로 이어진 rename 전부 (새 이름 = 다른 rename 의 옛 이름, 또는 그 반대)
function collect(start: TableDiff, renames: TableDiff[], byOld: Map<string, TableDiff>): TableDiff[] {
  const out = new Set<TableDiff>();
  const stack = [start];
  while (stack.length) {
    const d = stack.pop()!;
    if (out.has(d)) continue;
    out.add(d);
    const next = byOld.get(d.name);
    if (next) stack.push(next);
    for (const p of renames) if (p.name === d.oldName) stack.push(p);
  }
  return renames.filter((d) => out.has(d));
}

// 새 이름이 아직 다른 테이블의 이름이 아닌 절부터 내보낸다. 남은 것이 모두 순환이면 하나를 임시 이름으로 비켜 둔다
function order(pending: [string, string][], used: Set<string>): [string, string][] {
  const out: [string, string][] = [];
  let rest = pending;
  while (rest.length) {
    const i = rest.findIndex(([, to]) => !rest.some(([from]) => from === to));
    if (i >= 0) {
      out.push(rest[i]);
      rest = rest.filter((_, k) => k !== i);
      continue;
    }
    const [from, to] = rest[0];
    const tmp = freshName(used);
    out.push([from, tmp]);
    rest = [[tmp, to], ...rest.slice(1)];
  }
  return out;
}

function freshName(used: Set<string>): string {
  let n = 1;
  while (used.has(`${TMP_PREFIX}${n}`)) n++;
  const name = `${TMP_PREFIX}${n}`;
  used.add(name);
  return name;
}
