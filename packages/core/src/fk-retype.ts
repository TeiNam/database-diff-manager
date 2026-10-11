// FK 로 묶인 컬럼의 타입·문자셋·콜레이션이 바뀌면 FK 정의가 같아도 다시 만들어야 한다. MODIFY 만 하면
// FOREIGN_KEY_CHECKS=0 이어도 error 3780 (MySQL 8.0/8.4 실측). 그런 FK 를 'modify' 로 표시해 1단계 DROP·8단계 ADD 로 보낸다
import { renamedFkNames } from './auto-name';
import type { Change, TableDiff } from './diff';
import type { ForeignKey } from './model';

// FK 변경 사유 표식 (fields). 정의는 같고 묶인 컬럼 타입이 바뀌어 다시 만든다
export const RETYPED_FIELD = 'columnType';
const RETYPE_FIELDS = new Set(['type', 'charset', 'collation']);

// 테이블(TARGET 이름)별 타입·문자셋·콜레이션이 바뀌는 컬럼(TARGET 이름)
function retypedColumns(diffs: Iterable<TableDiff>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const d of diffs) {
    const cols = d.columns.filter((c) => (c.op === 'modify' || c.op === 'rename') && c.fields.some((f) => RETYPE_FIELDS.has(f)));
    if (cols.length) out.set(d.name, new Set(cols.map((c) => c.name)));
  }
  return out;
}

// diffs: TARGET 이름 → 짝지어진 테이블의 diff. 묶인 컬럼 타입이 바뀌는 변경 없는 FK 를 modify 로 더한 새 diff 들
export function withRetypedForeignKeys(diffs: ReadonlyMap<string, TableDiff>): Map<string, TableDiff> {
  const retyped = retypedColumns(diffs.values());
  if (!retyped.size) return new Map(diffs);
  return new Map([...diffs].map(([name, d]) => [name, addRetyped(d, retyped)]));
}

function addRetyped(d: TableDiff, retyped: ReadonlyMap<string, ReadonlySet<string>>): TableDiff {
  if (d.unparsed || !d.from || !d.to || d.from.parseError || d.to.parseError) return d;
  const changed = new Set(d.foreignKeys.map((f) => f.name));
  const names = renamedFkNames(d.from.foreignKeys, d.from.name, d.to.name);
  const touches = (f: ForeignKey) => f.columns.some((c) => retyped.get(d.name)?.has(c))
    || (f.refSchema === undefined && f.refColumns.some((c) => retyped.get(f.refTable)?.has(c)));
  const extra: Change<ForeignKey>[] = d.to.foreignKeys.flatMap((to) => {
    const i = names.indexOf(to.name);
    if (changed.has(to.name) || i < 0 || !touches(to)) return [];
    return [{ op: 'modify', name: to.name, from: { ...d.from!.foreignKeys[i], name: to.name }, to, fields: [RETYPED_FIELD] }];
  });
  return extra.length ? { ...d, foreignKeys: [...d.foreignKeys, ...extra] } : d;
}
