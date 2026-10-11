// 두 스키마 모델의 차이 계산. unknown 목록의 속성은 비교하지 않고 skipped에 기록한다
import { renamedAutoName, renamedFkNames } from './auto-name';
import { canonicalJson } from './canonical';
import { withRetypedForeignKeys } from './fk-retype';
import { quoteIdent } from './lexer';
import type { Check, Column, ForeignKey, Index, IndexField, Partitioning, Routine, RoutineKind, SchemaModel, Table, View } from './model';
import { normalizeBody, routineLexMode } from './normalize';
import { isOtherKindFamily } from './partial-fill';
import { subpartitionKey } from './partition-ddl';
import { printColumn, printRoutine, printTable, printView } from './print';
import { findManualTables, type ManualTable } from './manual-review';
import { findIgnoredRenames, type IgnoredRename } from './rename-check';

export { renamedAutoName } from './auto-name';

export type Op = 'add' | 'drop' | 'modify' | 'rename';

export interface Change<T> {
  op: Op;
  name: string;
  oldName?: string;
  from?: T;
  to?: T;
  fields: string[];
}

export interface OptionChange {
  key: string;
  from?: string;
  to?: string;
}

export interface TableDiff {
  op: Op;
  name: string;
  oldName?: string;
  from?: Table;
  to?: Table;
  columns: Change<Column>[];
  moved: string[]; // 위치가 바뀐 컬럼 (TARGET 이름)
  indexes: Change<Index>[];
  foreignKeys: Change<ForeignKey>[];
  checks: Change<Check>[];
  options: OptionChange[];
  partition?: { from?: Partitioning; to?: Partitioning };
  skipped: string[]; // partial 출처라 비교하지 못한 속성 ('column.charset' 등)
  unparsed: boolean; // 파싱 실패 객체의 원문이 달라졌음
}

export interface ViewDiff {
  op: 'add' | 'drop' | 'modify';
  name: string;
  from?: View;
  to?: View;
  fields: string[];
}

export interface RoutineDiff {
  op: 'add' | 'drop' | 'modify';
  kind: RoutineKind;
  name: string; // TARGET 표기 (drop 은 BASE 표기)
  from?: Routine;
  to?: Routine;
  fields: string[]; // 'params', 'returns', 'characteristics.deterministic' …, 'body', 'sqlMode'
}

export interface RenameMapping {
  kind: 'table' | 'column' | 'index';
  table?: string; // column/index: TARGET 테이블명
  from: string;
  to: string;
  // column 전용: 겹치는 같은 이름 컬럼이 따로 삭제·추가됨이 확인된 rename (전환 매핑의 remove-column·To-Be 신규 컬럼).
  // 이름이 겹쳐도 먼저 짝지어, 겹친 컬럼은 DROP·ADD 로 처리한다
  allowOverlap?: boolean;
}

export interface SchemaDiff {
  tables: TableDiff[];
  views: ViewDiff[];
  renameCandidates: RenameMapping[];
  ignoredRenames: IgnoredRename[]; // 적용하지 못한 rename 매핑과 이유
  partial: boolean;
  routines: RoutineDiff[];
  routinesUnknown: boolean; // 한쪽이라도 MD 출처라 루틴을 비교하지 않음 (routines 는 빈 배열)
  objectNames: string[]; // BASE·TARGET 의 모든 테이블·뷰 이름 (맞바꾸기 임시 이름이 겹치지 않게 예약)
  manualTables: ManualTable[]; // 생성 DDL 을 그대로 실행할 수 없어 문장을 수동 확인으로 돌릴 테이블과 이유
  // BASE·TARGET 스키마 이름 (빈 이름 제외). 뷰 본문의 `스키마`.`객체` 참조가 이 목록 밖이면 다른 스키마 객체라 로컬 의존이 아니다.
  // 비었거나 없으면(옛 JSON) 한정자로 판정하지 않는다 (같은 이름이면 로컬로 보는 안전 쪽)
  schemaNames?: string[];
}

// 뷰 본문의 한정자 중 로컬로 보는 스키마 이름 (schemaNames). 스키마 이름을 모르면 undefined — 한정자를 보지 않는다(로컬로 본다)
export const localSchemas = (diff: Pick<SchemaDiff, 'schemaNames'>): ReadonlySet<string> | undefined => (diff.schemaNames?.length ? new Set(diff.schemaNames) : undefined);

// 비교용 표식: 삭제되는 BASE 컬럼 이름 앞에 붙여 TARGET 의 같은 이름 컬럼과 다르게 만든다 (식별자에 나올 수 없는 문자)
const DROPPED_MARK = '\u0000dropped:';
const COLUMN_FIELDS = ['type', 'charset', 'collation', 'generated', 'nullable', 'srid', 'storage', 'columnFormat', 'invisible', 'default', 'onUpdate', 'autoIncrement', 'comment'] as const;
const INDEX_FIELDS = ['kind', 'using', 'keyBlockSize', 'parser', 'comment', 'invisible'] as const;
// SHOW CREATE 에만 나오는 속성: partial(MD) 출처는 알 수 없으므로 한쪽이 partial 이면 값이 달라도 변경이 아니라 skipped 로 남긴다
const SQL_ONLY_FIELDS: ReadonlySet<string> = new Set(['storage', 'columnFormat', 'keyBlockSize']);
const FK_FIELDS = ['columns', 'refSchema', 'refTable', 'refColumns', 'onDelete', 'onUpdate'] as const;
const CHECK_FIELDS = ['expr', 'enforced'] as const;
const VIEW_FIELDS = ['algorithm', 'security', 'checkOption', 'columnList', 'body'] as const;

type Equal = (field: string, a: unknown, b: unknown) => boolean;
const sameJson: Equal = (_, a, b) => canonicalJson(a) === canonicalJson(b);
// InnoDB에서 RESTRICT, NO ACTION, 미지정은 같은 동작이다
const fkAction = (v: unknown) => (v === undefined || v === 'RESTRICT' || v === 'NO ACTION' ? 'RESTRICT' : v);
const fkEqual: Equal = (f, a, b) => (f === 'onDelete' || f === 'onUpdate' ? fkAction(a) === fkAction(b) : sameJson(f, a, b));

export function diffSchemas(base: SchemaModel, target: SchemaModel, renames: RenameMapping[] = []): SchemaDiff {
  const tables = diffTables(base.tables, target.tables, renames);
  const all = [...base.tables, ...target.tables, ...base.views, ...target.views];
  const routinesUnknown = Boolean(base.routinesUnknown || target.routinesUnknown);
  return {
    tables,
    views: diffViews(base.views, target.views),
    renameCandidates: findRenameCandidates(tables),
    ignoredRenames: findIgnoredRenames(base, target, tables, renames),
    partial: all.some((o) => o.fidelity === 'partial'),
    // routines 가 없는 옛 모델(루틴 지원 전 JSON)은 빈 목록으로 본다
    routines: routinesUnknown ? [] : diffRoutines(base.routines ?? [], target.routines ?? []),
    routinesUnknown,
    objectNames: [...new Set(all.map((o) => o.name))],
    manualTables: findManualTables(base, target, tables),
    schemaNames: [...new Set([base.name, target.name].filter((n) => n !== ''))],
  };
}

// 적용된 rename (BASE 이름 → TARGET 이름). InnoDB 는 RENAME TABLE·RENAME/CHANGE COLUMN 때 다른 테이블 FK 의
// 참조 테이블·참조 컬럼도 따라 옮기므로, FK 는 BASE 참조에 이 rename 을 적용한 값으로 TARGET 과 비교한다
export interface AppliedRenames {
  tables: ReadonlyMap<string, string>;
  columns: ReadonlyMap<string, ReadonlyMap<string, string>>; // BASE 테이블명 → (BASE 컬럼명 → TARGET 컬럼명)
}

function diffTables(base: Table[], target: Table[], renames: RenameMapping[]): TableDiff[] {
  const tableMap = mappingOf(renames, 'table');
  const { pairs } = matchByName(base, target, tableMap, () => []);
  const applied: AppliedRenames = {
    tables: new Map(pairs.filter(([b, t]) => b.name !== t.name).map(([b, t]) => [b.name, t.name])),
    columns: new Map(pairs.map(([b, t]) => [b.name, appliedColumnRenames(b, t, renames)])),
  };
  // 묶인 컬럼 타입이 바뀌는 FK 는 다른 테이블의 컬럼 변경을 봐야 알 수 있어, 짝지은 테이블 diff 를 모두 만든 뒤 더한다
  const details = withRetypedForeignKeys(new Map(pairs.map(([b, t]) => [t.name, diffTable(b, t, renames, applied)])));
  const { changes } = matchByName(base, target, tableMap, (_, t) => (hasChanges(details.get(t.name)!) ? ['definition'] : []));
  return changes.map((c) => {
    if (c.op === 'drop') return emptyDiff('drop', c.name, c.from, undefined);
    if (c.op === 'add') return emptyDiff('add', c.name, undefined, c.to);
    return { ...details.get(c.name)!, op: c.op, oldName: c.oldName };
  });
}

// 컬럼 짝짓기 (rename 매핑 우선). diffTable 과 적용된 컬럼 rename 계산이 함께 쓴다
function matchColumns(b: Table, t: Table, renames: RenameMapping[], fields: (x: Column, y: Column) => string[]) {
  return matchByName(b.columns, t.columns, mappingOf(renames, 'column', t.name), fields, overlapOf(renames, t.name));
}

function appliedColumnRenames(b: Table, t: Table, renames: RenameMapping[]): Map<string, string> {
  const { changes } = matchColumns(b, t, renames, () => []);
  return new Map(changes.filter((c) => c.op === 'rename').map((c) => [c.oldName!, c.name]));
}

// BASE FK 의 참조를 rename 적용 후 값으로 바꾼다. 다른 스키마를 가리키는 FK 는 그대로 둔다
function renamedReference(fk: ForeignKey, applied: AppliedRenames): ForeignKey {
  if (fk.refSchema !== undefined) return fk;
  const cols = applied.columns.get(fk.refTable);
  return { ...fk, refTable: applied.tables.get(fk.refTable) ?? fk.refTable, refColumns: fk.refColumns.map((c) => cols?.get(c) ?? c) };
}

export function diffTable(b: Table, t: Table, renames: RenameMapping[] = [], context?: AppliedRenames): TableDiff {
  const base = emptyDiff('modify', t.name, b, t);
  if (b.parseError || t.parseError) return { ...base, unparsed: printTable(b) !== printTable(t) };
  const skipped = new Set<string>();
  const columns = matchColumns(b, t, renames, (x, y) => columnFields(withImpliedCharset(x), withImpliedCharset(y), skipped));
  const baseOrder = columns.pairs.map(([, y]) => y.name);
  const targetOrder = t.columns.map((c) => c.name).filter((n) => baseOrder.includes(n));
  const keep = lcs(baseOrder, targetOrder);
  // RENAME/CHANGE COLUMN은 인덱스·FK의 컬럼 참조를 자동 갱신하므로, 적용된 rename을 BASE 사본에 반영해 비교한다
  const applied = new Map(columns.changes.filter((c) => c.op === 'rename').map((c) => [c.oldName!, c.name]));
  // 삭제되는 BASE 컬럼은 같은 이름으로 들어오는 다른 컬럼(x→y, 기존 y 삭제)과 구별한다. MySQL 은 그 컬럼을 쓰던 인덱스를
  // 지우거나 줄이므로, 그 컬럼을 참조하던 인덱스·FK·CHECK 는 TARGET 과 같아 보여도 다시 만든다
  const dropped = new Set(columns.changes.filter((c) => c.op === 'drop').map((c) => c.name));
  const renameCol = (n: string) => (dropped.has(n) ? `${DROPPED_MARK}${n}` : applied.get(n) ?? n);
  // 단독 호출이면 이 테이블 자신의 rename 만 안다 (자기 참조 FK)
  const refs = context ?? { tables: new Map(b.name === t.name ? [] : [[b.name, t.name]]), columns: new Map([[b.name, applied]]) };
  const indexes = matchByName(b.indexes, t.indexes, mappingOf(renames, 'index', t.name), (x, y) =>
    indexFields({ ...x, parts: x.parts.map((p) => (p.column === undefined ? p : { ...p, column: renameCol(p.column) })) }, y, skipped),
  );
  const fkNames = renamedFkNames(b.foreignKeys, b.name, t.name);
  const baseFks = b.foreignKeys.map((f, i) => ({ ...f, name: fkNames[i] }));
  const foreignKeys = matchByName(baseFks, t.foreignKeys, new Map(), (x, y) =>
    fieldDiff({ ...renamedReference(x, refs), columns: x.columns.map(renameCol) }, y, FK_FIELDS, skipped, 'fk.', fkEqual),
  );
  return {
    ...base,
    columns: columns.changes,
    moved: targetOrder.filter((n) => !keep.has(n)),
    indexes: indexes.changes,
    foreignKeys: foreignKeys.changes,
    checks: checkChanges(b, t, skipped, dropped),
    options: optionChanges(b, t, skipped),
    partition: partitionChange(b, t, skipped),
    skipped: [...skipped].sort(),
  };
}

function emptyDiff(op: Op, name: string, from: Table | undefined, to: Table | undefined): TableDiff {
  return { op, name, from, to, columns: [], moved: [], indexes: [], foreignKeys: [], checks: [], options: [], skipped: [], unparsed: false };
}

function hasChanges(d: TableDiff): boolean {
  return d.unparsed || d.columns.length > 0 || d.moved.length > 0 || d.indexes.length > 0 || d.foreignKeys.length > 0
    || d.checks.length > 0 || d.options.length > 0 || d.partition !== undefined;
}

// 같은 원본의 매핑이 여러 개면 처음 것만 쓴다 (나머지는 ignoredRenames에 '중복 매핑')
function mappingOf(renames: RenameMapping[], kind: RenameMapping['kind'], table?: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of renames) if (r.kind === kind && (table === undefined || r.table === table) && !out.has(r.from)) out.set(r.from, r.to);
  return out;
}

// 이름 겹침을 허용한 컬럼 rename 의 원본 이름 (TARGET 테이블 기준)
function overlapOf(renames: RenameMapping[], table: string): Set<string> {
  return new Set(renames.filter((r) => r.kind === 'column' && r.table === table && r.allowOverlap).map((r) => r.from));
}

// 이름으로 짝을 맞춘다. rename 매핑을 먼저 짝짓고 나머지를 같은 이름끼리 맞춘다.
// rename 은 같은 대상이 아직 짝지어지지 않았을 때만 적용한다
function matchByName<T extends { name: string }>(
  base: T[], target: T[], renames: Map<string, string>, fields: (a: T, b: T) => string[], overlap: ReadonlySet<string> = new Set(),
): { changes: Change<T>[]; pairs: [T, T][] } {
  const targetByName = new Map(target.map((x) => [x.name, x]));
  const accepted = acceptRenames(base.map((x) => x.name), new Set(targetByName.keys()), renames, overlap);
  const renamedTo = new Map<T, string>();
  for (const b of base) {
    const renamed = accepted.get(b.name);
    if (renamed !== undefined) renamedTo.set(b, renamed);
  }
  const consumed = new Set(accepted.values());
  const renameTargets = new Set(consumed);
  const changes: Change<T>[] = [];
  const pairs: [T, T][] = [];
  for (const b of base) {
    const renamed = renamedTo.get(b);
    const useRename = renamed !== undefined;
    const t = useRename ? targetByName.get(renamed) : renameTargets.has(b.name) ? undefined : targetByName.get(b.name);
    if (!t) {
      changes.push({ op: 'drop', name: b.name, from: b, fields: [] });
      continue;
    }
    consumed.add(t.name);
    pairs.push([b, t]);
    const f = fields(b, t);
    if (useRename) changes.push({ op: 'rename', name: t.name, oldName: b.name, from: b, to: t, fields: f });
    else if (f.length) changes.push({ op: 'modify', name: t.name, from: b, to: t, fields: f });
  }
  for (const t of target) if (!consumed.has(t.name)) changes.push({ op: 'add', name: t.name, to: t, fields: [] });
  return { changes, pairs };
}

// 적용할 rename(BASE 이름 → TARGET 이름)을 고른다. 새 이름이 BASE 에 있으면 그 BASE 객체도 다른 이름으로 옮겨지고,
// 옛 이름이 TARGET 에 있으면 그 TARGET 객체도 다른 rename 으로 채워질 때만 적용한다 (맞바꾸기·연쇄·교체).
// 겹침 허용 매핑은 이 검사를 건너뛴다. 조건을 못 맞춘 매핑을 빼면 다른 매핑이 무너질 수 있어 안정될 때까지 반복한다
function acceptRenames(baseNames: string[], targetNames: ReadonlySet<string>, renames: Map<string, string>, overlap: ReadonlySet<string>): Map<string, string> {
  const inBase = new Set(baseNames);
  const banned = new Set<string>();
  for (;;) {
    const picked = new Map<string, string>();
    const used = new Set<string>();
    for (const b of baseNames) {
      const t = renames.get(b);
      if (t === undefined || t === b || banned.has(b) || !targetNames.has(t) || used.has(t)) continue;
      used.add(t);
      picked.set(b, t);
    }
    const bad = [...picked].filter(([b, t]) => !overlap.has(b) && ((inBase.has(t) && !picked.has(t)) || (targetNames.has(b) && !used.has(b))));
    if (!bad.length) return picked;
    for (const [b] of bad) banned.add(b);
  }
}

// SHOW CREATE 는 같은 컬럼을 `COLLATE x` 또는 `CHARACTER SET y COLLATE x` 로 찍는다(생성 방식에 따라 다름).
// 콜레이션은 문자셋을 정하므로, 비교할 때만 빠진 문자셋을 콜레이션에서 채운다 (모델·출력은 그대로)
function withImpliedCharset(col: Column): Column {
  if (col.charset || !col.collation) return col;
  const charset = col.collation === 'binary' ? 'binary' : col.collation.split('_')[0];
  return { ...col, charset };
}

function fieldDiff<T extends object>(
  a: T, b: T, fields: readonly (keyof T & string)[], skipped: Set<string>, prefix: string, eq: Equal = sameJson,
): string[] {
  const unknownOf = (x: T) => (x as { unknown?: readonly string[] }).unknown ?? [];
  const isPartial = (x: T) => (x as { unknown?: readonly string[] }).unknown !== undefined;
  return fields.filter((f) => {
    if (SQL_ONLY_FIELDS.has(f) && (isPartial(a) || isPartial(b))) {
      if (!eq(f, a[f], b[f])) skipped.add(prefix + f);
      return false;
    }
    if (unknownOf(a).includes(f) || unknownOf(b).includes(f)) {
      skipped.add(prefix + f);
      return false;
    }
    return !eq(f, a[f], b[f]);
  });
}

// 생성식을 모르는 쪽(MD)이 있어도 생성 여부·저장 방식(VIRTUAL/STORED)은 비교한다. 표현식만 skipped 로 남긴다
function columnFields(a: Column, b: Column, skipped: Set<string>): string[] {
  const fields = fieldDiff(a, b, COLUMN_FIELDS, skipped, 'column.');
  const isPartial = a.unknown?.includes('generated') || b.unknown?.includes('generated');
  const storage = (c: Column) => (c.generated ? (c.generated.stored ? 'STORED' : 'VIRTUAL') : '');
  if (!isPartial || storage(a) === storage(b)) return fields;
  return COLUMN_FIELDS.filter((f) => f === 'generated' || fields.includes(f));
}

function indexFields(a: Index, b: Index, skipped: Set<string>): string[] {
  const has = (f: IndexField) => Boolean(a.unknown?.includes(f) || b.unknown?.includes(f));
  const known = fieldDiff(a, b, INDEX_FIELDS, skipped, 'index.');
  // 종류 미상(Normal)이어도 계열이 다르면(INDEX/UNIQUE ↔ FULLTEXT/SPATIAL) 종류 차이로 본다
  const fields = has('kind') && isOtherKindFamily(a, b) ? ['kind', ...known] : known;
  if (has('partDetails')) skipped.add('index.partDetails');
  if (has('partOrder')) skipped.add('index.partOrder');
  const key = (i: Index): string => {
    if (!has('partDetails') && !has('partOrder')) return canonicalJson(i.parts);
    const names = i.parts.map((p) => p.column ?? p.expr ?? '');
    return canonicalJson(has('partOrder') ? [...names].sort() : names);
  };
  return key(a) === key(b) ? fields : [...fields, 'parts'];
}

function checkChanges(a: Table, b: Table, skipped: Set<string>, dropped: ReadonlySet<string>): Change<Check>[] {
  if (a.unknown?.includes('checks') || b.unknown?.includes('checks')) {
    skipped.add('checks');
    return [];
  }
  const checks = a.checks.map((c) => ({ ...c, name: renamedAutoName(c.name, a.name, b.name, 'chk') }));
  // 삭제되는 컬럼을 쓰는 CHECK 는 MySQL 이 함께 지우거나(그 컬럼만 쓸 때) 컬럼 삭제를 거부한다(error 3959)
  const usesDropped = (c: Check) => [...dropped].some((n) => c.expr.includes(quoteIdent(n)));
  return matchByName(checks, b.checks, new Map(), (x, y) => {
    const fields = fieldDiff(x, y, CHECK_FIELDS, skipped, 'check.');
    return usesDropped(x) && !fields.includes('expr') ? ['expr', ...fields] : fields;
  }).changes;
}

function optionChanges(a: Table, b: Table, skipped: Set<string>): OptionChange[] {
  const limit = a.comparableOptions && b.comparableOptions
    ? a.comparableOptions.filter((k) => b.comparableOptions!.includes(k))
    : (a.comparableOptions ?? b.comparableOptions);
  if (limit) skipped.add('options');
  const value = (t: Table, key: string) => t.options.find((o) => o.key === key)?.value;
  const keys = [...new Set([...a.options, ...b.options].map((o) => o.key))].filter((k) => !limit || limit.includes(k));
  return keys.flatMap((key) => {
    const from = value(a, key);
    const to = value(b, key);
    return from === to ? [] : [{ key, from, to }];
  });
}

function partitionChange(a: Table, b: Table, skipped: Set<string>): TableDiff['partition'] {
  if (a.unknown?.includes('partition') || b.unknown?.includes('partition')) {
    skipped.add('partition');
    return undefined;
  }
  const key = (p?: Partitioning) =>
    (p ? canonicalJson({ method: p.method, expr: p.expr, count: p.count, sub: subpartitionKey(p), partitions: p.partitions }) : '');
  return key(a.partition) === key(b.partition) ? undefined : { from: a.partition, to: b.partition };
}

function diffViews(base: View[], target: View[]): ViewDiff[] {
  const { changes } = matchByName(base, target, new Map(), (a, b) => {
    if (a.parseError || b.parseError) return printView(a) === printView(b) ? [] : ['body'];
    return fieldDiff(a, b, VIEW_FIELDS, new Set(), 'view.');
  });
  return changes.map((c) => ({ op: c.op as ViewDiff['op'], name: c.name, from: c.from, to: c.to, fields: c.fields }));
}

// 기본값과 같은 명시 특성은 생략한 것과 같다
const ROUTINE_DEFAULTS: Record<string, unknown> = { deterministic: false, dataAccess: 'CONTAINS SQL', security: 'DEFINER', language: 'SQL' };
const CHARACTERISTICS = ['deterministic', 'dataAccess', 'security', 'comment', 'language'] as const;
// MySQL 루틴 이름은 대소문자를 구분하지 않는다. 저장소·화면도 이 키로 같은 루틴을 찾는다
export const routineNameKey = (name: string): string => name.toLowerCase();
const routineKey = (r: Routine) => `${r.kind}:${routineNameKey(r.name)}`;

// (종류, 이름) 으로 짝짓는다. MySQL 루틴 이름은 대소문자를 구분하지 않는다. rename 후보는 만들지 않는다
function diffRoutines(base: Routine[], target: Routine[]): RoutineDiff[] {
  const targetByKey = new Map(target.map((r) => [routineKey(r), r]));
  const baseKeys = new Set(base.map(routineKey));
  const out: RoutineDiff[] = [];
  for (const b of base) {
    const t = targetByKey.get(routineKey(b));
    if (!t) {
      out.push({ op: 'drop', kind: b.kind, name: b.name, from: b, fields: [] });
      continue;
    }
    const fields = routineFields(b, t);
    if (fields.length) out.push({ op: 'modify', kind: t.kind, name: t.name, from: b, to: t, fields });
  }
  for (const t of target) if (!baseKeys.has(routineKey(t))) out.push({ op: 'add', kind: t.kind, name: t.name, to: t, fields: [] });
  return out;
}

function routineFields(a: Routine, b: Routine): string[] {
  if (a.parseError || b.parseError) return printRoutine(a) === printRoutine(b) ? [] : ['body'];
  const ch = (r: Routine, k: (typeof CHARACTERISTICS)[number]) => r.characteristics[k] ?? ROUTINE_DEFAULTS[k];
  return [
    ...(a.params === b.params ? [] : ['params']),
    ...(a.returns === b.returns ? [] : ['returns']),
    ...CHARACTERISTICS.filter((k) => ch(a, k) !== ch(b, k)).map((k) => `characteristics.${k}`),
    ...(normalizeBody(a.body, routineLexMode(a.sqlMode)) === normalizeBody(b.body, routineLexMode(b.sqlMode)) ? [] : ['body']),
    // 한쪽만 SQL_MODE 를 알면(직접 쓴 덤프 등) 비교하지 않는다
    ...(a.sqlMode !== undefined && b.sqlMode !== undefined && a.sqlMode !== b.sqlMode ? ['sqlMode'] : []),
  ];
}

// 이름만 다른 drop/add 쌍을 rename 후보로 제시한다 (자동 적용하지 않음)
function findRenameCandidates(tables: TableDiff[]): RenameMapping[] {
  const out: RenameMapping[] = [];
  const tableSig = (t: Table) => t.columns.map((c) => printColumn(c, false)).join('\n');
  // 파싱 실패 테이블은 컬럼 구성을 알 수 없으므로 후보에서 뺀다
  const dropped = tables.filter((t) => t.op === 'drop' && !t.from?.parseError).map((t) => ({ op: 'drop' as const, name: t.name, from: t.from, fields: [] }));
  const added = tables.filter((t) => t.op === 'add' && !t.to?.parseError).map((t) => ({ op: 'add' as const, name: t.name, to: t.to, fields: [] }));
  pairCandidates<Table>([...dropped, ...added], tableSig, (from, to) => out.push({ kind: 'table', from, to }));
  for (const t of tables) {
    if (t.op !== 'modify' && t.op !== 'rename') continue;
    pairCandidates<Column>(t.columns, (c) => printColumn({ ...c, name: '' }, false), (from, to) => out.push({ kind: 'column', table: t.name, from, to }));
    const indexes = t.indexes.filter((i) => (i.from ?? i.to)!.kind !== 'PRIMARY');
    pairCandidates<Index>(indexes, (i) => canonicalJson({ ...i, name: '' }), (from, to) => out.push({ kind: 'index', table: t.name, from, to }));
  }
  return out;
}

function pairCandidates<T>(changes: Change<T>[], sig: (x: T) => string, emit: (from: string, to: string) => void): void {
  const adds = changes.filter((c) => c.op === 'add');
  const used = new Set<string>();
  for (const d of changes.filter((c) => c.op === 'drop')) {
    const match = adds.find((a) => !used.has(a.name) && sig(a.to!) === sig(d.from!));
    if (!match) continue;
    used.add(match.name);
    emit(d.name, match.name);
  }
}

export function lcs(a: string[], b: string[]): Set<string> {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.add(a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return out;
}
