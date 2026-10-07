// td-export Markdown 정의서 → SchemaModel (partial: 일부 속성은 알 수 없음)
import { quoteString, tokenize } from './lexer';
import type { Column, ForeignKey, Index, IndexField, IndexPart, Table, View } from './model';
import { normalizeType } from './normalize';
import type { ParsedDump, ParseWarning } from './parse-dump';
import { parseCreateView } from './parse-view';

// 기본값이 없는 타입: nullable이어도 SHOW CREATE에 DEFAULT NULL이 붙지 않는다 (json은 붙는다)
const NO_DEFAULT_TYPES = /^((tiny|medium|long)?(blob|text)|geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geomcollection|geometrycollection)\b/i;
const VIEW_HEADER = '|Table type|Charset|';
const MD_OPTION_KEYS = ['ENGINE', 'COLLATE', 'COMMENT'];
const TABLE_LIST_RE = /^\s*- \[(\S+) \(.*\)\]\(#(.*)\)\s*$/;
const INDEX_RE = /^- \[(Normal|Unique|Fulltext|Spatial)\](.+?)\((.*)\)(?: WHERE .*)?$/;
const INDEX_KINDS: Record<string, Index['kind']> = { Normal: 'INDEX', Unique: 'UNIQUE', Fulltext: 'FULLTEXT', Spatial: 'SPATIAL' };
const FK_RE = /^- (\S+) FOREIGN KEY \((.*)\) Reference (.+?) ON DELETE (.+) ON UPDATE (.+)$/;
// binary 기본값: information_schema는 16진수(0x6162), SHOW CREATE는 문자열('ab')로 준다 → MD로는 알 수 없다
const BINARY_TYPE = /^(var)?binary\b/;
const HEX_DEFAULT = /^'?0x[0-9a-f]*'?$/i;
const QUOTED_LITERAL = /^'[\s\S]*'$/;
const PREFIX_PART = /^(.+)\((\d+)\)$/;
const DESC_SUFFIX = ' DESC';

// td-export 버전에 따라 Default 칸 형식이 다르다
// - legacy (~0.1.14): NULL·''·기본값 없음을 모두 빈 칸으로 출력한다
// - v2 (0.1.15~0.1.20): 기본값 없는 nullable → NULL, NOT NULL → 빈 칸, 빈 문자열 → ''. 문자열은 따옴표 없이
// - quoted (0.1.21+): 문자열·날짜 리터럴을 SQL처럼 따옴표로 감싼다 ('Y', 'it''s', 'NULL'). 숫자·bit·표현식은 그대로
type DefaultFormat = 'legacy' | 'v2' | 'quoted';
interface MdFormat {
  defaults: DefaultFormat;
  // 0.1.19+: 인덱스 종류(Fulltext/Spatial)와 키 파트의 DESC·prefix 길이·함수식을 출력한다
  indexDetails: boolean;
  // 0.1.22+: 셀 안의 '|'를 '\\|'로 이스케이프한다. 판별 근거가 없어 indexDetails(0.1.19+)일 때만 이스케이프로 읽는다
  cellEscapes: boolean;
}
// 판별 전에는 이스케이프를 모르는 상태로 셀을 나눈다
const PLAIN_FORMAT: MdFormat = { defaults: 'legacy', indexDetails: false, cellEscapes: false };
const ESCAPED_FORMAT: MdFormat = { ...PLAIN_FORMAT, cellEscapes: true };
// 0.1.21+가 반드시 따옴표로 감싸는 타입 (문자열·날짜/시간). 이 타입의 맨몸 Default는 0.1.20 이하의 증거다
const QUOTED_TYPE = /^((var)?char|(tiny|medium|long)?text|enum|set|date|datetime|time|timestamp)\b/i;
// 0.1.21+도 따옴표 없이 내는 Default: NULL, CURRENT_TIMESTAMP[(n)], 숫자
const BARE_DEFAULT = /^(NULL|current_timestamp(\(\d*\))?|-?\d+(\.\d+)?)$/i;
const COLUMN_HEADER = '|Name|Type|';
const COLUMN_CELLS = 9;

interface Section {
  heading: string;
  line: number;
  body: string[];
}

export function parseMdDump(text: string): ParsedDump {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  const realNames = new Map<string, string>(); // 앵커(소문자) → 원래 이름
  for (const l of lines) {
    const m = TABLE_LIST_RE.exec(l);
    if (m) realNames.set(m[2], m[1]);
  }
  const tables: Table[] = [];
  const views: View[] = [];
  const warnings: ParseWarning[] = [];
  const secs = sections(lines);
  const format = detectFormat(secs);
  for (const sec of secs) {
    if (sec.heading === 'Table List') continue;
    const name = realNames.get(sec.heading) ?? sec.heading;
    try {
      const obj = parseSection(name, sec.body, format);
      if (obj.kind === 'view') views.push(obj);
      else tables.push(obj);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const failed = { name, fidelity: 'partial' as const, parseError: message, rawDdl: sec.body.join('\n') };
      const isView = sec.body.some((l) => l.startsWith(VIEW_HEADER));
      warnings.push({ code: 'parse-error', kind: isView ? 'view' : 'table', object: name, line: sec.line, message });
      if (isView) views.push({ kind: 'view', body: '', ...failed });
      else tables.push({ kind: 'table', columns: [], indexes: [], foreignKeys: [], checks: [], options: [], ...failed });
    }
  }
  return { model: { name: (lines[0] ?? '').trim(), tables, views }, warnings };
}

function sections(lines: string[]): Section[] {
  const out: Section[] = [];
  lines.forEach((l, i) => {
    const m = /^## (.+?)\s*$/.exec(l);
    if (m) out.push({ heading: m[1], line: i + 1, body: [] });
    else out.at(-1)?.body.push(l);
  });
  return out;
}

// 파일 단위로 판별한다. 이전 버전이 낼 수 없는 표기가 하나라도 있으면 그 버전 이상으로 본다
// - quoted: 문자열·날짜 컬럼에 따옴표 없는 리터럴 Default(ready)가 하나도 없고, 따옴표로 감싼 비어 있지 않은 Default('Y')가 있다.
//   맨몸 리터럴이 하나라도 있으면 0.1.20 이하이므로 'x' 같은 Default는 값 자체로 읽는다 (판별 근거가 둘 다 없으면 따옴표 규칙은 쓸 일이 없다)
// - v2: Default 칸이 정확히 NULL 또는 ''
// - indexDetails: [Fulltext]/[Spatial], 키 파트의 ' DESC'나 괄호(prefix·함수식). quoted(0.1.21+)면 당연히 포함
function detectFormat(secs: Section[]): MdFormat {
  const columnRows = (format: MdFormat) => secs.flatMap((sec) => {
    const header = sec.body.find((l) => l.startsWith(COLUMN_HEADER));
    return header === undefined ? [] : rowsAfter(sec.body, header, COLUMN_CELLS, format);
  });
  const rows = columnRows(PLAIN_FORMAT);
  // 이스케이프 여부를 아직 모르므로 두 방식으로 나눈 결과가 모두 맨몸 리터럴일 때만 증거로 쓴다 (enum('a\|b') 등에서 칸이 밀리는 것 방지)
  const escapedRows = columnRows(ESCAPED_FORMAT);
  const defaults = rows.map((c) => c[3] ?? '');
  const hasBareLiteral = rows.some((c, i) => isBareLiteralDefault(c) && isBareLiteralDefault(escapedRows[i] ?? []));
  const hasQuotedDefault = defaults.some((d) => d.length > 2 && QUOTED_LITERAL.test(d));
  const hasDetailedIndex = secs.some((sec) => listAfter(sec.body, '**Index**').some(isDetailedIndexLine));
  const isQuoted = !hasBareLiteral && hasQuotedDefault;
  const isV2 = isQuoted || defaults.some((d) => d === 'NULL' || d === "''");
  const indexDetails = isQuoted || hasDetailedIndex;
  return { defaults: isQuoted ? 'quoted' : isV2 ? 'v2' : 'legacy', indexDetails, cellEscapes: indexDetails };
}

// 0.1.21+라면 따옴표로 감쌌을 Default (표현식 Default·생성 컬럼은 따옴표 없이 나오므로 제외)
function isBareLiteralDefault(c: string[]): boolean {
  const [, type = '', , def = '', , , , extra = ''] = c;
  if (def === '' || def.startsWith("'") || !QUOTED_TYPE.test(type.trim())) return false;
  return !BARE_DEFAULT.test(def) && !/default_generated|generated/i.test(extra);
}

function isDetailedIndexLine(line: string): boolean {
  const m = INDEX_RE.exec(line);
  return m !== null && (m[1] === 'Fulltext' || m[1] === 'Spatial' || m[3].includes(DESC_SUFFIX) || m[3].includes('('));
}

function parseSection(name: string, body: string[], format: MdFormat): Table | View {
  const header = body.find((l) => l.startsWith('|Table type|'));
  if (!header) throw new Error('Information 표 없음');
  if (header.startsWith(VIEW_HEADER)) return parseViewSection(name, body);
  const info = rowsAfter(body, header, 5, format)[0];
  if (!info) throw new Error('Information 행 없음');
  const [, engine, , collate, comment] = info;
  const columns: Column[] = [];
  const pk: string[] = [];
  const colHeader = body.find((l) => l.startsWith(COLUMN_HEADER));
  if (!colHeader) throw new Error('Columns 표 없음');
  for (const cells of rowsAfter(body, colHeader, COLUMN_CELLS, format)) {
    const { col, isPk } = mdColumn(cells, format);
    columns.push(col);
    if (isPk) pk.push(col.name);
  }
  const indexes: Index[] = pk.length
    ? [{ name: 'PRIMARY', kind: 'PRIMARY', parts: pk.map((column) => ({ column, desc: false })), invisible: false, unknown: ['partOrder', 'partDetails', 'using', 'comment', 'invisible'] }]
    : [];
  const columnNames = new Set(columns.map((c) => c.name));
  indexes.push(...listAfter(body, '**Index**').map((l) => mdIndex(l, format, columnNames)));
  return {
    kind: 'table',
    name,
    columns,
    indexes,
    foreignKeys: mergeForeignKeys(listAfter(body, '**Constraint**').map(mdForeignKey)),
    checks: [],
    options: [
      ...(engine ? [{ key: 'ENGINE', value: engine }] : []),
      ...(collate ? [{ key: 'COLLATE', value: collate }] : []),
      ...(comment ? [{ key: 'COMMENT', value: quoteString(comment) }] : []),
    ],
    fidelity: 'partial',
    unknown: ['checks', 'partition'],
    comparableOptions: MD_OPTION_KEYS,
  };
}

// 표 머리줄 다음 구분줄을 건너뛰고 행을 읽는다.
// '|'로 시작하지 않는 비어 있지 않은 줄은 이전 행의 이어진 줄(여러 줄 코멘트)이다.
// 빈 줄, '**' 또는 '- '로 시작하는 줄에서 표가 끝난다.
function rowsAfter(body: string[], header: string, n: number, format: MdFormat): string[][] {
  const raw: string[] = [];
  for (let i = body.indexOf(header) + 2; i < body.length; i++) {
    const line = body[i];
    if (line.startsWith('|')) raw.push(line);
    else if (raw.length > 0 && line.trim() !== '' && !line.startsWith('**') && !line.startsWith('- ')) raw[raw.length - 1] += `\n${line}`;
    else break;
  }
  return raw.map((l) => cells(l, n, format.cellEscapes));
}

// td-export 0.1.22+는 셀 안의 '|'를 '\\|'로, 줄바꿈을 '<br>'로 이스케이프한다 (백슬래시는 이스케이프하지 않는다).
// 그 이전은 '|'를 이스케이프하지 않으므로 넘친 셀은 마지막 열로 합친다 ('\\'로 끝나는 셀도 그대로 둔다)
// 줄 끝 '|'는 이스케이프 여부와 상관없이 표 구분자다 (마지막 셀 'C:\\'는 'C:\\|'로 끝난다)
function cells(line: string, n: number, isEscaped: boolean): string[] {
  const sep = isEscaped ? /(?<!\\)\|/ : /\|/;
  const parts = line.replace(/^\|/, '').replace(/\|\s*$/, '').split(sep);
  const merged = parts.length > n ? [...parts.slice(0, n - 1), parts.slice(n - 1).join('|')] : parts;
  return merged.map((c) => (isEscaped ? c.replace(/\\\|/g, '|') : c).replace(/<br>/g, '\n'));
}

function listAfter(body: string[], marker: string): string[] {
  const out: string[] = [];
  const start = body.indexOf(marker);
  if (start < 0) return out;
  for (let i = start + 1; i < body.length && body[i].startsWith('- '); i++) out.push(body[i]);
  return out;
}

function mdColumn(c: string[], format: MdFormat): { col: Column; isPk: boolean } {
  const [name, type, nullable, def = '', , , key, extra = '', comment = ''] = c;
  const ex = extra.toLowerCase();
  const unknown: Column['unknown'] = ['charset', 'collation', 'srid'];
  const col: Column = {
    name, type: normalizeType(type), nullable: nullable === 'YES', invisible: /\binvisible\b/.test(ex), autoIncrement: ex.includes('auto_increment'), unknown,
  };
  const onUpdate = /on update (\S+)/i.exec(extra);
  if (onUpdate) col.onUpdate = onUpdate[1];
  if (/(virtual|stored) generated/.test(ex)) {
    col.generated = { expr: '', stored: ex.includes('stored generated') };
    unknown.push('generated');
  } else if (BINARY_TYPE.test(col.type) && HEX_DEFAULT.test(def)) {
    unknown.push('default');
  } else if (format.defaults === 'quoted') {
    col.default = quotedDefault(col, def, ex.includes('default_generated'));
  } else if (format.defaults === 'v2') {
    col.default = v2Default(col, def, ex.includes('default_generated'));
  } else if (def === '' && !hasNoDefault(col)) {
    unknown.push('default'); // legacy td-export는 NULL과 ''를 모두 빈 칸으로 출력해 구분할 수 없다
  } else {
    col.default = mdDefault(def, ex.includes('default_generated'));
  }
  if (comment) col.comment = comment;
  return { col, isPk: key === 'PRI' };
}

// 기본값이 없음이 확실한 컬럼 (text/blob/geometry, auto_increment)
const hasNoDefault = (col: Column): boolean => NO_DEFAULT_TYPES.test(col.type) || col.autoIncrement;

// v2: NULL은 기본값 없는 nullable(DEFAULT NULL), 빈 칸은 기본값 없는 NOT NULL이다.
// 문자열 기본값 'NULL'도 NULL로 출력되어 DEFAULT NULL과 구분할 수 없다 (드묾)
function v2Default(col: Column, value: string, isExpression: boolean): string | undefined {
  if (value === 'NULL') return hasNoDefault(col) ? undefined : 'NULL';
  return mdDefault(value, isExpression);
}

// quoted: 따옴표 리터럴은 SHOW CREATE 인용 규칙으로 다시 쓴다 (td-export는 '와 \\만 이스케이프하고 줄바꿈은 그대로 둔다)
function quotedDefault(col: Column, value: string, isExpression: boolean): string | undefined {
  if (!isExpression && QUOTED_LITERAL.test(value)) return requote(value);
  return v2Default(col, value, isExpression);
}

function requote(literal: string): string {
  try {
    const toks = tokenize(literal);
    return toks.length === 1 && toks[0].t === 'string' && toks[0].e === literal.length ? quoteString(toks[0].v) : literal;
  } catch {
    return literal; // 닫히지 않은 따옴표 등: 원문 그대로 비교한다
  }
}

function mdDefault(value: string, isExpression: boolean): string | undefined {
  if (value === '') return undefined; // 기본값 없음 (legacy는 hasNoDefault 컬럼만 여기로 온다)
  if (value === "''") return "''"; // 빈 문자열 기본값 (v2)
  if (/^current_timestamp(\(\d*\))?$/i.test(value)) return value;
  if (isExpression) return `(${value})`;
  if (/^b'[01]*'$/.test(value)) return value;
  return quoteString(value);
}

function mdIndex(line: string, format: MdFormat, columnNames: Set<string>): Index {
  const m = INDEX_RE.exec(line);
  if (!m) throw new Error(`인덱스 형식 오류: ${line}`);
  const unknown: IndexField[] = [...(format.indexDetails ? [] : ['partDetails' as const]), 'using', 'parser', 'comment', 'invisible'];
  // td-export는 non_unique 조회 실패 시 UNIQUE도 Normal로 출력한다 → Normal은 종류를 확신할 수 없다
  // (0.1.19+는 INDEX/UNIQUE 중에서만 모호하다. diff는 partDetails가 알려진 경우 FULLTEXT·SPATIAL과의 차이를 비교한다)
  if (m[1] === 'Normal') unknown.push('kind');
  return {
    name: m[2],
    kind: INDEX_KINDS[m[1]],
    parts: format.indexDetails
      ? splitIndexParts(m[3]).map((p) => indexPart(p, columnNames))
      : m[3].split(',').filter(Boolean).map((column) => ({ column, desc: false })),
    invisible: false,
    unknown,
  };
}

// 0.1.19+ 키 파트: 'col', 'col(10)', 'col DESC', 함수식 'lower(`c`)'(바깥 괄호 없음). 테이블 컬럼명이 아니면 함수식으로 본다
// 컬럼 식별자(COLUMN_NAME)는 이스케이프되지 않으므로 원문으로, 함수식(EXPRESSION)은 디코드한 값으로 읽는다
function indexPart(part: KeyPart, columnNames: Set<string>): IndexPart {
  const desc = part.raw.endsWith(DESC_SUFFIX);
  const strip = (s: string) => (desc ? s.slice(0, -DESC_SUFFIX.length) : s);
  const text = strip(part.raw);
  if (columnNames.has(text)) return { column: text, desc };
  const prefix = PREFIX_PART.exec(text);
  if (prefix && columnNames.has(prefix[1])) return { column: prefix[1], length: Number(prefix[2]), desc };
  return { expr: strip(part.decoded), desc };
}

interface KeyPart {
  raw: string;
  decoded: string;
}

// 괄호·따옴표 밖의 쉼표로 나눈다 (함수식 인자의 쉼표를 보존). 판단은 디코드한 글자로 하고 파트마다 원문도 함께 돌려준다
function splitIndexParts(raw: string): KeyPart[] {
  const { text, rawAt } = unescapeOneLevel(raw);
  const out: KeyPart[] = [];
  const push = (s: number, e: number) => out.push({ raw: raw.slice(rawAt[s], rawAt[e]).trim(), decoded: text.slice(s, e).trim() });
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote !== '`') i++;
      else if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      push(start, i);
      start = i + 1;
    }
  }
  push(start, text.length);
  return out.filter((p) => p.decoded);
}

// information_schema.STATISTICS.EXPRESSION은 백슬래시 이스케이프가 한 겹 더 씌워져 있다 (\\' → ', \\\\ → \\).
// 디코드한 글자마다 원문 위치를 기록한다 (rawAt[k] = k번째 글자의 원문 위치, 끝에 원문 길이)
function unescapeOneLevel(s: string): { text: string; rawAt: number[] } {
  let text = '';
  const rawAt: number[] = [];
  for (let i = 0; i < s.length; i++) {
    rawAt.push(i);
    if (s[i] === '\\' && i + 1 < s.length) i++;
    text += s[i];
  }
  rawAt.push(s.length);
  return { text, rawAt };
}

function mdForeignKey(line: string): ForeignKey {
  const m = FK_RE.exec(line);
  if (!m) throw new Error(`FK 형식 오류: ${line}`);
  return {
    name: m[1], columns: splitNames(m[2]), ...mdReference(m[3]),
    onDelete: m[4].trim(), onUpdate: m[5].trim(),
  };
}

// 참조 대상: 'table.col' 또는 (0.1.29+ 다중 컬럼) 'table(c1, c2)'. 다른 스키마면 앞에 'schema.'가 붙는다 (0.1.29+)
function mdReference(ref: string): Pick<ForeignKey, 'refSchema' | 'refTable' | 'refColumns'> {
  const multi = /^(.+)\((.*)\)$/.exec(ref);
  const dot = ref.lastIndexOf('.');
  const table = multi ? multi[1] : ref.slice(0, dot);
  const refColumns = multi ? splitNames(multi[2]) : [ref.slice(dot + 1)];
  const schemaDot = table.indexOf('.');
  return schemaDot > 0
    ? { refSchema: table.slice(0, schemaDot), refTable: table.slice(schemaDot + 1), refColumns }
    : { refTable: table, refColumns };
}

const splitNames = (list: string): string[] => list.split(',').map((x) => x.trim());

// td-export는 복합 FK를 참조 컬럼별로 여러 줄 출력한다 → 이름으로 합친다
function mergeForeignKeys(fks: ForeignKey[]): ForeignKey[] {
  const byName = new Map<string, ForeignKey>();
  for (const fk of fks) {
    const prev = byName.get(fk.name);
    if (!prev) {
      byName.set(fk.name, fk);
      continue;
    }
    // 참조 컬럼마다 줄이 반복되므로 컬럼은 합집합, 참조 컬럼은 중복 없이 이어 붙인다
    // (완전히 같은 줄이 반복돼도 refColumns가 늘어나지 않는다)
    byName.set(fk.name, {
      ...prev,
      columns: [...new Set([...prev.columns, ...fk.columns])],
      refColumns: [...prev.refColumns, ...fk.refColumns.filter((r) => !prev.refColumns.includes(r))],
    });
  }
  return [...byName.values()];
}

function parseViewSection(name: string, body: string[]): View {
  const open = body.findIndex((l) => /^`{3,}sql$/.test(l));
  if (open < 0) throw new Error('View Create SQL 블록 없음');
  const fence = body[open].slice(0, -3);
  const close = body.indexOf(fence, open + 1);
  const view = parseCreateView(body.slice(open + 1, close < 0 ? undefined : close).join('\n'));
  return { ...view, name };
}
