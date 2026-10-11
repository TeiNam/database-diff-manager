// 생성 DDL 을 그대로 실행하면 실패하거나 의미가 바뀌는 테이블을 찾는다 (generateDdl 이 그 테이블 문장을 수동 확인으로 바꾼다)
import { fkAutoNameCollides } from './auto-name';
import type { TableDiff } from './diff';
import { quoteIdent as q, quotedIdentifiers } from './lexer';
import type { SchemaModel, Table } from './model';

export interface ManualTable {
  table: string; // 문장을 막을 테이블 (TARGET 이름, 삭제 테이블은 BASE 이름)
  reason: string;
  note: string;
}

export function findManualTables(base: SchemaModel, tables: TableDiff[]): ManualTable[] {
  const altered = tables.filter((d) => (d.op === 'modify' || d.op === 'rename') && d.from && d.to);
  return altered.flatMap((d) => [...fkNameCollision(d), ...reusedNameDependents(base, tables, d)]);
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
