// AWS DMS table-mapping JSON → 전환 매핑. 모든 object-locator 는 As-Is 이름 기준이고, 이름 비교는 대소문자를 무시한다
export const MAX_DMS_RULES = 20_000;

export type DmsWarningCode = 'unsupported' | 'duplicate' | 'invalid';

export interface DmsWarning {
  ruleId: string;
  code: DmsWarningCode;
  message: string;
}

export interface DmsTableRename {
  ruleId: string;
  from: string; // As-Is 테이블 (locator 원문)
  to: string; // To-Be 테이블
}

export interface DmsColumnRename {
  ruleId: string;
  table: string; // As-Is 테이블
  from: string; // As-Is 컬럼
  to: string; // To-Be 컬럼
}

export interface DmsRemovedColumn {
  ruleId: string;
  table: string; // As-Is 테이블
  column: string; // As-Is 컬럼
}

export interface DmsMapping {
  fromSchema: string;
  toSchema?: string;
  selection: { include: string[]; exclude: string[] }; // table-name 패턴 (% 와일드카드)
  tables: DmsTableRename[];
  columns: DmsColumnRename[];
  removedColumns: DmsRemovedColumn[];
  ruleCount: number;
}

// 업로드 자체를 거부해야 하는 오류 (JSON 아님, rules 없음, 룰 수 초과)
export class DmsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DmsParseError';
  }
}

interface Rule {
  id: string;
  type: string;
  target?: string;
  action: string;
  schema: string;
  table?: string;
  column?: string;
  value?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const lower = (v: string) => v.toLowerCase();
const hasWildcard = (v: string | undefined) => v !== undefined && v.includes('%');

// '%' 만 와일드카드로 본다 (DMS 와 같다). '_' 는 테이블명에 흔해서 글자 그대로 비교한다
export function likePattern(pattern: string): RegExp {
  const body = pattern.split('%').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`, 'i');
}

export const likeMatch = (pattern: string, name: string): boolean => likePattern(pattern).test(name);

// selection 룰이 없으면 전부 대상, exclude 가 include 보다 우선
export function isSelected(mapping: DmsMapping, table: string): boolean {
  const { include, exclude } = mapping.selection;
  const included = include.length === 0 || include.some((p) => likeMatch(p, table));
  return included && !exclude.some((p) => likeMatch(p, table));
}

export function parseDmsMapping(text: string): { mapping: DmsMapping; warnings: DmsWarning[] } {
  const rules = readRules(text);
  const warnings: DmsWarning[] = [];
  const parsed = rules.map((raw, i) => toRule(raw, i, warnings)).filter((r): r is Rule => r !== undefined);
  const fromSchema = parsed.find((r) => !hasWildcard(r.schema))?.schema ?? '%';
  const builder = new MappingBuilder(fromSchema, warnings);
  for (const rule of parsed) {
    if (!likeMatch(rule.schema, fromSchema)) {
      warnings.push({ ruleId: rule.id, code: 'invalid', message: `다른 스키마(${rule.schema})의 룰은 반영하지 않습니다` });
      continue;
    }
    builder.add(rule);
  }
  return { mapping: builder.build(rules.length), warnings };
}

function readRules(text: string): unknown[] {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new DmsParseError('JSON 형식이 아닙니다');
  }
  const rules = isObject(json) ? json.rules : undefined;
  if (!Array.isArray(rules)) throw new DmsParseError('rules 배열이 없습니다');
  if (rules.length > MAX_DMS_RULES) throw new DmsParseError(`룰은 최대 ${MAX_DMS_RULES.toLocaleString('en-US')}개까지 올릴 수 있습니다 (현재 ${rules.length.toLocaleString('en-US')}개)`);
  return rules;
}

function toRule(raw: unknown, index: number, warnings: DmsWarning[]): Rule | undefined {
  const r = isObject(raw) ? raw : {};
  const rawId = r['rule-id'];
  const id = typeof rawId === 'number' ? String(rawId) : str(rawId) ?? `#${index + 1}`;
  const locator = isObject(r['object-locator']) ? r['object-locator'] : undefined;
  const type = str(r['rule-type']);
  const action = str(r['rule-action']);
  const schema = str(locator?.['schema-name']);
  if (!type || !action || !schema) {
    warnings.push({ ruleId: id, code: 'invalid', message: 'rule-type·rule-action·object-locator.schema-name 이 필요합니다' });
    return undefined;
  }
  return {
    id, type, action, schema,
    target: str(r['rule-target']),
    table: str(locator?.['table-name']),
    column: str(locator?.['column-name']),
    value: str(r.value),
  };
}

// rule-id 가 큰 쪽이 이긴다 (숫자로 비교할 수 없으면 문자열 비교)
function isNewer(a: string, b: string): boolean {
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) ? x > y : a > b;
}

class MappingBuilder {
  private readonly include: string[] = [];
  private readonly exclude: string[] = [];
  private readonly schema = new Map<string, { ruleId: string; value: string }>();
  private readonly tables = new Map<string, DmsTableRename>();
  private readonly columns = new Map<string, DmsColumnRename>();
  private readonly removed = new Map<string, DmsRemovedColumn>();

  constructor(private readonly fromSchema: string, private readonly warnings: DmsWarning[]) {}

  add(rule: Rule): void {
    if (rule.type === 'selection') return this.addSelection(rule);
    if (rule.type !== 'transformation') return this.unsupported(rule, `rule-type '${rule.type}'`);
    const kind = `${rule.target ?? ''}/${rule.action}`;
    if (kind === 'schema/rename') return this.addSchemaRename(rule);
    if (kind === 'table/rename') return this.addTableRename(rule);
    if (kind === 'column/rename') return this.addColumnRename(rule);
    if (kind === 'column/remove-column') return this.addRemovedColumn(rule);
    this.unsupported(rule, `${rule.target ?? '(target 없음)'} / ${rule.action}`);
  }

  build(ruleCount: number): DmsMapping {
    return {
      fromSchema: this.fromSchema,
      ...(this.schema.has('') ? { toSchema: this.schema.get('')!.value } : {}),
      selection: { include: [...this.include], exclude: [...this.exclude] },
      tables: [...this.tables.values()],
      columns: [...this.columns.values()],
      removedColumns: [...this.removed.values()],
      ruleCount,
    };
  }

  private addSelection(rule: Rule): void {
    const pattern = rule.table ?? '%';
    if (rule.action === 'include') this.include.push(pattern);
    else if (rule.action === 'exclude') this.exclude.push(pattern);
    else this.unsupported(rule, `selection / ${rule.action}`);
  }

  private addSchemaRename(rule: Rule): void {
    if (!rule.value) return this.invalid(rule, 'value(새 이름)가 없습니다');
    this.keep(this.schema, '', { ruleId: rule.id, value: rule.value });
  }

  private addTableRename(rule: Rule): void {
    if (!rule.table || hasWildcard(rule.table)) return this.wildcard(rule);
    if (!rule.value) return this.invalid(rule, 'value(새 이름)가 없습니다');
    this.keep(this.tables, lower(rule.table), { ruleId: rule.id, from: rule.table, to: rule.value });
  }

  private addColumnRename(rule: Rule): void {
    if (!rule.table || !rule.column || hasWildcard(rule.table) || hasWildcard(rule.column)) return this.wildcard(rule);
    if (!rule.value) return this.invalid(rule, 'value(새 이름)가 없습니다');
    const key = `${lower(rule.table)}.${lower(rule.column)}`;
    this.keep(this.columns, key, { ruleId: rule.id, table: rule.table, from: rule.column, to: rule.value });
  }

  private addRemovedColumn(rule: Rule): void {
    if (!rule.table || !rule.column || hasWildcard(rule.table) || hasWildcard(rule.column)) return this.wildcard(rule);
    const key = `${lower(rule.table)}.${lower(rule.column)}`;
    this.keep(this.removed, key, { ruleId: rule.id, table: rule.table, column: rule.column });
  }

  // 같은 대상의 룰이 또 나오면 rule-id 가 큰 쪽을 남기고, 진 쪽을 경고로 남긴다
  private keep<T extends { ruleId: string }>(map: Map<string, T>, key: string, next: T): void {
    const prev = map.get(key);
    if (!prev) {
      map.set(key, next);
      return;
    }
    const [winner, loser] = isNewer(next.ruleId, prev.ruleId) ? [next, prev] : [prev, next];
    map.set(key, winner);
    this.warnings.push({ ruleId: loser.ruleId, code: 'duplicate', message: `같은 대상의 룰이 겹쳐 rule ${winner.ruleId} 를 사용합니다` });
  }

  private unsupported(rule: Rule, what: string): void {
    this.warnings.push({ ruleId: rule.id, code: 'unsupported', message: `${what} 룰은 반영하지 않습니다` });
  }

  private wildcard(rule: Rule): void {
    this.warnings.push({ ruleId: rule.id, code: 'unsupported', message: 'transformation 의 와일드카드(%)나 빈 이름은 반영하지 않습니다' });
  }

  private invalid(rule: Rule, message: string): void {
    this.warnings.push({ ruleId: rule.id, code: 'invalid', message });
  }
}
