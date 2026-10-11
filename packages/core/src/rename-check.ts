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

// 매핑 충돌 (17회차 2): 같은 범위(종류·TARGET 테이블)에서 서로 다른 원본이 같은 목적지로 가거나(다대일) 한 원본이 여러 목적지로
// 가는(일대다) 매핑. 하나만 고르면 다른 원본이 소리 없이 DROP 되거나 뒤집은 역방향 매핑과 어긋난다 — AWS DMS 에서도 서로 다른
// 원본 두 개가 한 대상으로 가면 데이터가 합쳐지는 충돌이다 (같은 원본에 룰이 여럿이면 rule-id 로 하나를 고르는 것과 다르다).
// 이름은 대소문자를 무시해 비교한다 (MySQL 컬럼·인덱스 이름은 대소문자를 구분하지 않는다). 똑같은 매핑의 반복은 충돌이 아니다
export const MAPPING_CONFLICT = '매핑 충돌';

export function conflictingRenames(renames: readonly RenameMapping[]): Set<RenameMapping> {
  const scopeOf = (m: RenameMapping) => `${m.kind}\u0000${m.table ?? ''}`;
  const fold = (v: string) => v.toLowerCase();
  const targets = new Map<string, Set<string>>(); // 범위·원본 → 목적지들
  const sources = new Map<string, Set<string>>(); // 범위·목적지 → 원본들
  const add = (map: Map<string, Set<string>>, key: string, value: string) => map.set(key, new Set([...(map.get(key) ?? []), value]));
  for (const m of renames) {
    add(targets, `${scopeOf(m)}\u0000${fold(m.from)}`, fold(m.to));
    add(sources, `${scopeOf(m)}\u0000${fold(m.to)}`, fold(m.from));
  }
  return new Set(renames.filter((m) => targets.get(`${scopeOf(m)}\u0000${fold(m.from)}`)!.size > 1 || sources.get(`${scopeOf(m)}\u0000${fold(m.to)}`)!.size > 1));
}

export function findIgnoredRenames(base: SchemaModel, target: SchemaModel, tables: TableDiff[], renames: RenameMapping[]): IgnoredRename[] {
  const conflicts = conflictingRenames(renames);
  const out: IgnoredRename[] = [];
  for (const m of renames) {
    if (conflicts.has(m)) {
      out.push({ mapping: m, reason: MAPPING_CONFLICT });
      continue;
    }
    if (isApplied(m, tables)) continue;
    const scope = scopeOf(m, base, target, tables);
    out.push({ mapping: m, reason: scope ? reasonOf(m, scope) : '테이블 없음' });
  }
  return out;
}

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

function reasonOf(m: RenameMapping, scope: Scope): string {
  if (!scope.base.includes(m.from)) return '원본 없음';
  if (!scope.target.includes(m.to)) return '대상 없음';
  if (scope.base.includes(m.to) || scope.target.includes(m.from)) return '이름 충돌';
  return '적용 불가';
}
