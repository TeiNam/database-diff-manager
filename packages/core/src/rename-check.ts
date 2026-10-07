// 적용되지 않은 rename 매핑과 그 이유를 찾는다 (UI가 사용자에게 알려 주기 위함)
import type { RenameMapping, TableDiff } from './diff';
import type { SchemaModel, Table } from './model';

export interface IgnoredRename {
  mapping: RenameMapping;
  reason: string;
}

interface Scope {
  base: string[];
  target: string[];
}

export function findIgnoredRenames(base: SchemaModel, target: SchemaModel, tables: TableDiff[], renames: RenameMapping[]): IgnoredRename[] {
  const seen: RenameMapping[] = [];
  const out: IgnoredRename[] = [];
  for (const m of renames) {
    const duplicate = seen.some((s) => sameScope(s, m) && (s.from === m.from || s.to === m.to));
    seen.push(m);
    if (isApplied(m, tables)) continue;
    const scope = scopeOf(m, base, target, tables);
    out.push({ mapping: m, reason: scope ? reasonOf(m, scope, duplicate) : '테이블 없음' });
  }
  return out;
}

const sameScope = (a: RenameMapping, b: RenameMapping) => a.kind === b.kind && a.table === b.table;

function isApplied(m: RenameMapping, tables: TableDiff[]): boolean {
  if (m.kind === 'table') return tables.some((t) => t.op === 'rename' && t.oldName === m.from && t.name === m.to);
  const t = tables.find((x) => x.name === m.table && (x.op === 'modify' || x.op === 'rename'));
  const changes = m.kind === 'column' ? t?.columns : t?.indexes;
  return Boolean(changes?.some((c) => c.op === 'rename' && c.oldName === m.from && c.name === m.to));
}

// 매핑을 비교할 이름 목록. column/index는 TARGET 테이블과 짝지어진 BASE 테이블 안에서 찾는다
function scopeOf(m: RenameMapping, base: SchemaModel, target: SchemaModel, tables: TableDiff[]): Scope | undefined {
  if (m.kind === 'table') return { base: base.tables.map((t) => t.name), target: target.tables.map((t) => t.name) };
  const to = target.tables.find((t) => t.name === m.table);
  const baseName = tables.find((t) => t.op === 'rename' && t.name === m.table)?.oldName ?? m.table;
  const from = base.tables.find((t) => t.name === baseName);
  if (!to || !from) return undefined;
  const names = (t: Table) => (m.kind === 'column' ? t.columns : t.indexes).map((x) => x.name);
  return { base: names(from), target: names(to) };
}

function reasonOf(m: RenameMapping, scope: Scope, duplicate: boolean): string {
  if (!scope.base.includes(m.from)) return '원본 없음';
  if (!scope.target.includes(m.to)) return '대상 없음';
  if (scope.base.includes(m.to) || scope.target.includes(m.from)) return '이름 충돌';
  return duplicate ? '중복 매핑' : '적용 불가';
}
