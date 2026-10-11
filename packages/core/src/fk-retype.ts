// FK 로 묶인 컬럼의 타입·문자셋·콜레이션이 바뀌면 FK 정의가 같아도 다시 만들어야 한다. MODIFY 만 하면
// FOREIGN_KEY_CHECKS=0 이어도 error 3780 (MySQL 8.0/8.4 실측). 그런 FK 를 'modify' 로 표시해 1단계 DROP·8단계 ADD 로 보낸다
import { renamedFkNames } from './auto-name';
import { effectiveCharsetChanges } from './charset-ddl';
import type { Change, TableDiff } from './diff';
import type { ForeignKey } from './model';

// FK 변경 사유 표식 (fields). 정의는 같고 묶인 컬럼 타입이 바뀌어 다시 만든다
export const RETYPED_FIELD = 'columnType';
const RETYPE_FIELDS = new Set(['type', 'charset', 'collation']);

// 테이블(TARGET 이름)별 타입·문자셋·콜레이션이 바뀌는 컬럼(TARGET 이름).
// 테이블 기본 문자셋을 상속하는 컬럼은 컬럼 diff 가 없어도 실효 문자셋이 바뀌므로 함께 본다 (CONVERT TO 도 error 3780)
function retypedColumns(diffs: Iterable<TableDiff>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const d of diffs) {
    const cols = d.columns.filter((c) => (c.op === 'modify' || c.op === 'rename') && c.fields.some((f) => RETYPE_FIELDS.has(f)));
    const names = new Set([...cols.map((c) => c.name), ...effectiveCharsetChanges(d)]);
    if (names.size) out.set(d.name, names);
  }
  return out;
}

// diffs: TARGET 이름 → 짝지어진 테이블의 diff. 묶인 컬럼 타입이 바뀌는 변경 없는 FK 를 modify 로 더한 새 diff 들
export function withRetypedForeignKeys(diffs: ReadonlyMap<string, TableDiff>): Map<string, TableDiff> {
  const retyped = retypedColumns(diffs.values());
  if (!retyped.size) return new Map(diffs);
  return new Map([...diffs].map(([name, d]) => [name, addRetyped(d, retyped)]));
}

type Retyped = ReadonlyMap<string, ReadonlySet<string>>;

// FK 의 로컬 컬럼이나 (같은 스키마) 참조 컬럼 중 타입·문자셋·콜레이션이 바뀌는 것이 있는지
const touches = (table: string, f: ForeignKey, retyped: Retyped): boolean => f.columns.some((c) => retyped.get(table)?.has(c))
  || (f.refSchema === undefined && f.refColumns.some((c) => retyped.get(f.refTable)?.has(c)));

function addRetyped(d: TableDiff, retyped: Retyped): TableDiff {
  if (d.unparsed || !d.from || !d.to || d.from.parseError || d.to.parseError) return d;
  const changed = new Set(d.foreignKeys.map((f) => f.name));
  const names = renamedFkNames(d.from.foreignKeys, d.from.name, d.to.name);
  const extra: Change<ForeignKey>[] = d.to.foreignKeys.flatMap((to) => {
    const i = names.indexOf(to.name);
    if (changed.has(to.name) || i < 0 || !touches(d.name, to, retyped)) return [];
    return [{ op: 'modify', name: to.name, from: { ...d.from!.foreignKeys[i], name: to.name }, to, fields: [RETYPED_FIELD] }];
  });
  return extra.length ? { ...d, foreignKeys: [...d.foreignKeys, ...extra] } : d;
}

// FK 로 묶여 타입·문자셋·콜레이션이 함께 바뀌는 테이블 묶음 (TARGET 이름 → 묶음의 테이블, 이름순). 묶음 중 한 테이블의 문장만
// 실행하면 다른 테이블의 FK 해제·재추가가 없어 error 3780 으로 실패하므로 객체 카드 복사는 묶음 전체의 문장을 함께 낸다
export function retypeGroups(tables: readonly TableDiff[]): Map<string, string[]> {
  const retyped = retypedColumns(tables);
  const parent = new Map<string, string>();
  const find = (n: string): string => {
    const p = parent.get(n) ?? n;
    return p === n ? n : find(p);
  };
  const names = new Set(tables.map((d) => d.name));
  for (const d of tables) {
    for (const f of d.foreignKeys) {
      if (f.op !== 'modify' || !f.to || f.to.refSchema !== undefined || !names.has(f.to.refTable) || !touches(d.name, f.to, retyped)) continue;
      const [a, b] = [find(d.name), find(f.to.refTable)];
      if (a !== b) parent.set(a, b);
    }
  }
  const groups = new Map<string, string[]>();
  for (const n of names) groups.set(find(n), [...(groups.get(find(n)) ?? []), n]);
  return new Map([...names].flatMap((n) => {
    const g = groups.get(find(n))!;
    return g.length > 1 ? [[n, [...g].sort()] as const] : [];
  }));
}
