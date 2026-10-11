// 생성 DDL 을 그대로 실행하면 실패하거나 의미가 바뀌는 테이블을 찾는다 (generateDdl 이 그 테이블 문장을 수동 확인으로 바꾼다)
import { fkAutoNameCollides } from './auto-name';
import type { TableDiff } from './diff';
import { quoteIdent as q, quotedIdentifiers } from './lexer';
import type { Index, SchemaModel, Table } from './model';

export interface ManualTable {
  table: string; // 문장을 막을 테이블 (TARGET 이름, 삭제 테이블은 BASE 이름)
  reason: string;
  note: string;
}

export function findManualTables(base: SchemaModel, target: SchemaModel, tables: TableDiff[]): ManualTable[] {
  const altered = tables.filter((d) => (d.op === 'modify' || d.op === 'rename') && d.from && d.to);
  return [...altered.flatMap((d) => [...fkNameCollision(d), ...reusedNameDependents(base, tables, d)]), ...nonStandardFkKeys(target, tables)];
}

function fkNameCollision(d: TableDiff): ManualTable[] {
  if (!d.oldName || !fkAutoNameCollides(d.from!.foreignKeys, d.oldName, d.name)) return [];
  return [{
    table: d.name,
    reason: `${d.name}: rename 뒤 FK 자동 이름(${d.oldName}_ibfk_N → ${d.name}_ibfk_N)이 다른 FK 이름과 겹쳐 FK 를 식별할 수 없습니다 — 직접 작성하세요`,
    note: `FK 자동 이름 보정이 기존 FK 이름과 겹쳐 보정하지 않았습니다 (${d.from!.foreignKeys.map((f) => f.name).join(', ')})`,
  }];
}

// 삭제되는 컬럼 이름을 rename 이 재사용할 때(겹침 허용), 그 컬럼을 쓰던 식 인덱스·생성 컬럼 식·다른 테이블 FK 는
// 생성 DDL 이 다시 만들지 않으므로 DROP COLUMN 이 실패하거나 새 컬럼을 가리키게 된다. 테이블과 바뀌는 자식 테이블을 막는다
function reusedNameDependents(base: SchemaModel, tables: TableDiff[], d: TableDiff): ManualTable[] {
  const renamedTo = new Set(d.columns.filter((c) => c.op === 'rename').map((c) => c.name));
  const reused = d.columns.filter((c) => c.op === 'drop' && renamedTo.has(c.name)).map((c) => c.name);
  if (!reused.length) return [];
  const baseName = d.oldName ?? d.name;
  // 식의 따옴표 식별자로 판정한다 (문자열 안의 `이름` 은 빼고, 컬럼 이름은 대소문자 무시). 토큰으로 못 나누면 포함 여부로
  const uses = (expr: string | undefined) => {
    if (expr === undefined) return false;
    const idents = quotedIdentifiers(expr)?.map((v) => v.toLowerCase());
    return reused.some((n) => (idents ? idents.includes(n.toLowerCase()) : expr.includes(q(n))));
  };
  const exprUsers = [
    ...d.from!.indexes.filter((i) => i.parts.some((p) => uses(p.expr))).map((i) => `인덱스 ${i.name}`),
    ...d.from!.columns.filter((c) => uses(c.generated?.expr)).map((c) => `생성 컬럼 ${c.name}`),
  ];
  const children = base.tables.filter((t) => referencesColumns(t, baseName, reused));
  if (!exprUsers.length && !children.length) return [];
  const users = [...exprUsers, ...children.map((t) => `${t.name} 의 FK`)].join(', ');
  const reason = `${d.name}: 삭제되는 컬럼(${reused.join(', ')}) 이름을 rename 이 다시 쓰는데 ${users} 가 그 컬럼을 참조합니다 — 직접 작성하세요`;
  const note = `삭제 컬럼 ${reused.join(', ')} 을 참조하는 ${users} 는 새 컬럼으로 옮겨지지 않습니다`;
  const changedChildren = children
    .map((t) => tables.find((x) => x.oldName === t.name)?.name ?? t.name)
    .filter((n) => n !== d.name && tables.some((x) => x.name === n && x.op !== 'add'));
  return [d.name, ...changedChildren].map((table) => ({ table, reason: table === d.name ? reason : `${table}: 참조하는 ${d.name} 의 컬럼 rename 이 수동 확인이라 실행하지 않습니다 — 직접 작성하세요`, note }));
}

// t 의 FK 가 같은 스키마의 table 컬럼 중 하나를 참조하는지
const referencesColumns = (t: Table, table: string, columns: string[]): boolean =>
  t.foreignKeys.some((f) => f.refSchema === undefined && f.refTable === table && f.refColumns.some((c) => columns.includes(c)));

// FK 가 참조할 수 있는 표준 키: 참조 컬럼과 같은 컬럼(같은 순서)으로만 된 전체 길이 PRIMARY/UNIQUE.
// MD(partial) 인덱스는 종류(Normal = INDEX|UNIQUE)·키 파트 상세를 모를 수 있어, 컬럼이 같으면 표준 키일 수 있다고 본다 (판정 불가 → 막지 않음)
const isStandardKey = (i: Index, columns: string[]): boolean => {
  const vague = Boolean(i.unknown?.includes('kind') || i.unknown?.includes('partDetails'));
  return (i.kind === 'PRIMARY' || i.kind === 'UNIQUE' || (vague && i.kind === 'INDEX'))
    && i.parts.length === columns.length && i.parts.every((p, n) => p.expr === undefined && (vague || !p.length) && p.column === columns[n]);
};

const indexColumns = (i: Index | undefined): string[] => i?.parts.flatMap((p) => (p.column === undefined ? [] : [p.column])) ?? [];

// MySQL 8.4 기본값 restrict_fk_on_non_standard_key=ON 에서는 부모에 참조 컬럼과 정확히 같은 PRIMARY/UNIQUE 가 없으면 FK 추가가
// error 6125 로, 그런 FK 가 쓰는 부모 인덱스 삭제가 error 1553 으로 실패한다 (8.0 은 둘 다 실행된다 — 8.4 실측).
// TARGET 에 존재할 모든 FK(유지·재생성·신규) 중 TARGET 부모에 표준 키가 없는 것을, 생성 DDL 이 그 FK 를 추가(새 테이블·새·바뀐·
// 재생성 FK)하거나 부모의 참조 컬럼 인덱스를 바꾸면 자식(바뀌는 경우)과 부모(바뀌는 경우)의 문장 전체를 수동 확인으로 묶는다
function nonStandardFkKeys(target: SchemaModel, tables: TableDiff[]): ManualTable[] {
  const changed = (name: string) => tables.find((d) => d.name === name && d.op !== 'drop' && !d.unparsed);
  return target.tables.flatMap((child) => child.foreignKeys.flatMap((fk): ManualTable[] => {
    const parent = fk.refSchema === undefined && !child.parseError ? target.tables.find((t) => t.name === fk.refTable) : undefined;
    if (!parent || parent.parseError || parent.indexes.some((i) => isStandardKey(i, fk.refColumns))) return [];
    const c = changed(child.name);
    const p = changed(parent.name);
    const addsFk = c?.op === 'add' || Boolean(c?.foreignKeys.some((f) => f.name === fk.name && (f.op === 'add' || f.op === 'modify')));
    const touchesKey = (p?.op === 'modify' || p?.op === 'rename') && p.indexes.some((i) => (i.op !== 'rename' || i.fields.length > 0)
      && [...indexColumns(i.from), ...indexColumns(i.to)].some((col) => fk.refColumns.includes(col)));
    if (!addsFk && !touchesKey) return [];
    const label = `${child.name}.${fk.name}`;
    const reason = (table: string) => `${table}: FK(${label})가 참조하는 ${parent.name}(${fk.refColumns.join(', ')}) 에 TARGET 에서 같은 컬럼의 UNIQUE/PRIMARY 키가 없습니다. MySQL 8.4 restrict_fk_on_non_standard_key=ON(기본)에서 실패하고(FK 추가 error 6125, 부모 인덱스 삭제 error 1553), 8.0 은 실행 가능합니다 — FK 와 부모 키를 함께 확인해 직접 작성하세요`;
    const note = `8.4 restrict_fk_on_non_standard_key: FK ${label} 는 참조 컬럼과 같은 UNIQUE/PRIMARY 키가 필요합니다 (8.0 은 실행 가능)`;
    const blocked = [...new Set([...(c ? [child.name] : []), ...(touchesKey ? [parent.name] : [])])];
    return blocked.map((table) => ({ table, reason: reason(table), note }));
  }));
}
