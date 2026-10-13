// 사람이 쓴 타입·기본값·문자셋을 MySQL SHOW CREATE 모양으로 맞춘다 (8.0/8.4).
// 규칙마다 test:mysql 의 ALTER 시나리오(test/apply.int.test.ts)가 실제 MySQL 결과와 비교한다
import { Cursor, splitTopLevel } from '../cursor';
import { quoteString, tokenize, type Token } from '../lexer';
import type { Column, TableOption } from '../model';
import { normalizeType } from '../normalize';
import { fail, type ColumnSpec, type DefaultSpec, type NowSpec } from './types';

export const INT_TYPES: ReadonlySet<string> = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'bigint']);
const NUMERIC: ReadonlySet<string> = new Set([...INT_TYPES, 'decimal', 'float', 'double']);
// 문자셋·콜레이션이 붙는 타입
export const CHARSET_TYPES: ReadonlySet<string> = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set']);
export const BLOB_TYPES: ReadonlySet<string> = new Set(['tinytext', 'text', 'mediumtext', 'longtext', 'tinyblob', 'blob', 'mediumblob', 'longblob']);
// 리터럴 기본값을 쓸 수 없는 타입 (MySQL 1101). NULL 허용이어도 SHOW CREATE 에 DEFAULT NULL 이 없다
export const NO_LITERAL_DEFAULT: ReadonlySet<string> = new Set([...BLOB_TYPES, 'json',
  'geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection', 'geomcollection']);
const KNOWN: ReadonlySet<string> = new Set([...NUMERIC, ...CHARSET_TYPES, ...NO_LITERAL_DEFAULT, 'bit', 'date', 'datetime', 'timestamp', 'time', 'year', 'binary', 'varbinary']);
const TWO_ARGS: ReadonlySet<string> = new Set(['decimal', 'float', 'double']);
const AUTO_INCREMENT_TYPES: ReadonlySet<string> = new Set([...INT_TYPES, 'float', 'double']);
const ALIASES: Readonly<Record<string, string>> = {
  integer: 'int', int1: 'tinyint', int2: 'smallint', int3: 'mediumint', int4: 'int', int8: 'bigint', middleint: 'mediumint',
  dec: 'decimal', numeric: 'decimal', fixed: 'decimal', real: 'double', character: 'char',
};
const NATIONAL = 'NATIONAL·NCHAR 타입은 문자셋이 따로 붙어 1차 지원 범위가 아닙니다';
const REJECTED: Readonly<Record<string, string>> = {
  serial: 'SERIAL 은 UNIQUE 인덱스가 따로 생겨 1차 지원 범위가 아닙니다',
  national: NATIONAL, nchar: NATIONAL, nvarchar: NATIONAL,
  long: 'LONG·LONG VARCHAR 는 1차 지원 범위가 아닙니다 — MEDIUMTEXT 로 쓰세요',
};

export const baseType = (type: string): string => /^\w+/.exec(type)?.[0] ?? '';

// 'INT(11) UNSIGNED' → 'int unsigned', 'DECIMAL' → 'decimal(10,0)', "ENUM('a' , \"b\")" → "enum('a','b')"
export function normalizeUserType(src: string): string {
  const c = new Cursor(tokenize(src), src);
  const first = c.next();
  if (first.t !== 'word') return fail(`타입이 필요합니다: ${src}`);
  const word = first.v.toLowerCase();
  if (REJECTED[word]) return fail(REJECTED[word]);
  if (word === 'bool' || word === 'boolean') return c.done ? 'tinyint(1)' : fail(`BOOLEAN 뒤에는 수식어를 쓸 수 없습니다: ${src}`);
  if (word === 'double') c.acceptWord('PRECISION');
  const name = ALIASES[word] ?? word;
  if (!KNOWN.has(name)) return fail(`지원하지 않는 타입입니다: ${first.v}`);
  const inner = c.isOp('(') ? c.parenTokens() : undefined;
  let unsigned = false;
  while (!c.done) {
    if (c.acceptWord('UNSIGNED')) unsigned = true;
    else if (c.acceptWord('SIGNED')) unsigned = false;
    else if (c.isWord('ZEROFILL')) fail('ZEROFILL 은 1차 지원 범위가 아닙니다 (MySQL 8.0.17 부터 폐기 예정)');
    else fail(`알 수 없는 타입 수식어: ${c.peek()!.v}`);
  }
  if (unsigned && !NUMERIC.has(name)) fail(`UNSIGNED 는 숫자 타입에만 쓸 수 있습니다: ${src}`);
  return withArgs(name, inner, src) + (unsigned ? ' unsigned' : '');
}

function withArgs(name: string, inner: Token[] | undefined, src: string): string {
  if (name === 'enum' || name === 'set') return `${name}(${enumValues(inner, src).map(quoteString).join(',')})`;
  const args = inner && splitTopLevel(inner).map((part) => (part.length === 1 && part[0].t === 'number' && /^\d+$/.test(part[0].v) ? String(Number(part[0].v)) : fail(`타입 인자가 올바르지 않습니다: ${src}`)));
  if (args && args.length > (TWO_ARGS.has(name) ? 2 : 1)) fail(`타입 인자가 너무 많습니다: ${src}`);
  switch (name) {
    case 'decimal': return `decimal(${args?.[0] ?? 10},${args?.[1] ?? 0})`;
    case 'char': case 'binary': case 'bit': return `${name}(${args?.[0] ?? 1})`;
    case 'varchar': case 'varbinary': return args ? `${name}(${args[0]})` : fail(`${name.toUpperCase()} 는 길이가 필요합니다 (MySQL 1064)`);
    case 'float': return !args ? 'float' : args.length === 1 ? (Number(args[0]) <= 24 ? 'float' : 'double') : `float(${args.join(',')})`;
    case 'double': return args ? `double(${args.join(',')})` : 'double';
    case 'year': return !args || args[0] === '4' ? 'year' : fail('YEAR(2) 는 MySQL 8.0 에서 지원하지 않습니다');
    case 'datetime': case 'timestamp': case 'time':
      if (args && Number(args[0]) > 6) fail(`소수 초 자릿수는 0~6 이어야 합니다: ${src} (MySQL 1426)`);
      return args && args[0] !== '0' ? `${name}(${args[0]})` : name;
    default:
      if (INT_TYPES.has(name)) return normalizeType(args ? `${name}(${args[0]})` : name); // int(11) → int, tinyint(1) 유지
      return args ? fail(`${name.toUpperCase()}(n) 은 1차 지원 범위가 아닙니다 (MySQL 이 길이로 타입을 고릅니다)`) : name;
  }
}

// MySQL 은 ENUM·SET 값 끝 공백을 지운다. 대소문자만 다른 같은 값이면 1291
function enumValues(inner: Token[] | undefined, src: string): string[] {
  const values = (inner ? splitTopLevel(inner) : []).map((part) => (part.length === 1 && part[0].t === 'string' ? part[0].v.replace(/ +$/, '') : fail(`ENUM·SET 값은 문자열이어야 합니다: ${src}`)));
  if (!values.length) fail(`ENUM·SET 값이 없습니다: ${src}`);
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v.toLowerCase())) fail(`ENUM·SET 값 '${v}' 이 두 번 있습니다 (MySQL 1291)`);
    seen.add(v.toLowerCase());
  }
  return values;
}

export const enumMembers = (type: string): string[] => tokenize(type).filter((t) => t.t === 'string').map((t) => t.v);

// 문자셋의 기본(primary) 콜레이션 — MySQL 8.0/8.4 SHOW CHARACTER SET 의 Default collation
const PRIMARY_COLLATION: Readonly<Record<string, string>> = {
  utf8mb4: 'utf8mb4_0900_ai_ci', utf8mb3: 'utf8mb3_general_ci', latin1: 'latin1_swedish_ci', latin2: 'latin2_general_ci', ascii: 'ascii_general_ci',
  binary: 'binary', ucs2: 'ucs2_general_ci', utf16: 'utf16_general_ci', utf16le: 'utf16le_general_ci', utf32: 'utf32_general_ci',
  euckr: 'euckr_korean_ci', gbk: 'gbk_chinese_ci', gb2312: 'gb2312_chinese_ci', gb18030: 'gb18030_chinese_ci', big5: 'big5_chinese_ci',
  sjis: 'sjis_japanese_ci', ujis: 'ujis_japanese_ci', cp932: 'cp932_japanese_ci', eucjpms: 'eucjpms_japanese_ci', cp1250: 'cp1250_general_ci',
  cp1251: 'cp1251_general_ci', cp1256: 'cp1256_general_ci', cp1257: 'cp1257_general_ci', greek: 'greek_general_ci', hebrew: 'hebrew_general_ci',
  tis620: 'tis620_thai_ci', koi8r: 'koi8r_general_ci', koi8u: 'koi8u_general_ci',
};

export function canonicalCharset(name: string): string {
  const cs = name.toLowerCase() === 'utf8' ? 'utf8mb3' : name.toLowerCase();
  return PRIMARY_COLLATION[cs] ? cs : fail(`알 수 없는 문자셋입니다: ${name} (MySQL 1115)`);
}

export function canonicalCollation(name: string): string {
  const coll = name.toLowerCase().replace(/^utf8_/, 'utf8mb3_');
  charsetOfCollation(coll);
  return coll;
}

export function charsetOfCollation(coll: string): string {
  const cs = coll === 'binary' ? 'binary' : coll.split('_')[0];
  return PRIMARY_COLLATION[cs] ? cs : fail(`알 수 없는 콜레이션입니다: ${coll} (MySQL 1273)`);
}

export const primaryCollation = (cs: string): string => PRIMARY_COLLATION[cs];

export interface TableCharset {
  charset: string;
  collation: string;
}

// 테이블 기본 문자셋 (SHOW CREATE 의 DEFAULT CHARSET=·COLLATE= 옵션). 없으면 스키마 기본값
export function tableCharset(options: readonly TableOption[], defaults: TableCharset): TableCharset {
  const value = (...keys: string[]) => options.find((o) => keys.includes(o.key))?.value;
  const charsetRaw = value('DEFAULT CHARSET', 'CHARSET', 'DEFAULT CHARACTER SET', 'CHARACTER SET');
  const collationRaw = value('COLLATE', 'DEFAULT COLLATE');
  const collation = collationRaw ? canonicalCollation(collationRaw) : charsetRaw ? primaryCollation(canonicalCharset(charsetRaw)) : defaults.collation;
  return { charset: charsetOfCollation(collation), collation };
}

// 컬럼 문자셋 표기 (SHOW CREATE 규칙): 콜레이션이 테이블 기본과 다르면 CHARACTER SET, 문자셋 기본 콜레이션이 아니면 COLLATE.
// COLLATE 를 직접 쓰면 둘 다 붙인다 (MySQL 은 명시한 콜레이션을 기억한다 — 비교 엔진은 COLLATE 만 있는 표기와 같게 본다)
export function columnCharset(type: string, written: Pick<ColumnSpec, 'charset' | 'collation'>, table: TableCharset): Pick<Column, 'charset' | 'collation'> {
  if (!CHARSET_TYPES.has(baseType(type))) return written.charset || written.collation ? fail(`문자열이 아닌 타입에는 CHARACTER SET·COLLATE 를 쓸 수 없습니다: ${type}`) : {};
  const charset = written.charset ? canonicalCharset(written.charset) : written.collation ? charsetOfCollation(canonicalCollation(written.collation)) : table.charset;
  const collation = written.collation ? canonicalCollation(written.collation) : written.charset ? primaryCollation(charset) : table.collation;
  if (charsetOfCollation(collation) !== charset) fail(`COLLATE ${collation} 은 문자셋 ${charset} 의 콜레이션이 아닙니다 (MySQL 1253)`);
  if (written.collation) return { charset, collation };
  return { ...(collation !== table.collation ? { charset } : {}), ...(collation !== primaryCollation(charset) ? { collation } : {}) };
}

// 컬럼의 실제 콜레이션 (문자열 타입이 아니면 '')
export function effectiveCollation(col: Pick<Column, 'type' | 'charset' | 'collation'>, table: TableCharset): string {
  if (!CHARSET_TYPES.has(baseType(col.type))) return '';
  return col.collation ?? (col.charset ? primaryCollation(canonicalCharset(col.charset)) : table.collation);
}

const fspOf = (type: string): number => Number(/^(?:datetime|timestamp|time)\((\d)\)/.exec(type)?.[1] ?? 0);

// CURRENT_TIMESTAMP 기본값·ON UPDATE: DATETIME·TIMESTAMP 에만, 소수 초 자릿수는 컬럼과 같아야 한다
export function nowText(type: string, now: NowSpec, what: string): string {
  const base = baseType(type);
  if (base !== 'datetime' && base !== 'timestamp') fail(`${what} CURRENT_TIMESTAMP 은 DATETIME·TIMESTAMP 에만 쓸 수 있습니다 (MySQL 1067)`);
  if ((now.fsp ?? 0) !== fspOf(type)) fail(`${what} CURRENT_TIMESTAMP 의 소수 초 자릿수가 컬럼(${type})과 다릅니다 (MySQL 1067)`);
  return now.fsp ? `CURRENT_TIMESTAMP(${now.fsp})` : 'CURRENT_TIMESTAMP';
}

// 기본값 원문 (SHOW CREATE 표기): 숫자도 따옴표로 감싸고 타입 자릿수에 맞춘다
export function normalizeDefault(spec: DefaultSpec, col: Pick<Column, 'name' | 'type' | 'nullable'>): string {
  const base = baseType(col.type);
  const bad = (why: string): never => fail(`컬럼 \`${col.name}\` 의 기본값이 올바르지 않습니다: ${why} (MySQL 1067)`);
  if (spec.kind === 'null') return col.nullable ? 'NULL' : bad('NOT NULL 컬럼에 NULL');
  if (NO_LITERAL_DEFAULT.has(base)) return fail(`${base.toUpperCase()} 컬럼에는 리터럴 기본값을 쓸 수 없습니다 (MySQL 1101)`);
  if (spec.kind === 'now') return nowText(col.type, spec, `컬럼 \`${col.name}\` 의 기본값`);
  if (base === 'bit') return spec.kind === 'bit' ? spec.value : /^\d+$/.test(spec.value) ? `b'${BigInt(spec.value).toString(2)}'` : bad(spec.value);
  if (spec.kind === 'bit') return bad(spec.value);
  if (NUMERIC.has(base) || base === 'year') return quoteString(numericDefault(spec.value, col.type, bad));
  if (base === 'enum') return quoteString(enumMembers(col.type).find((m) => m.toLowerCase() === spec.value.replace(/ +$/, '').toLowerCase()) ?? bad(`'${spec.value}' 은 ENUM 값이 아닙니다`));
  if (base === 'set') return quoteString(setDefault(spec.value, col.type, bad));
  return quoteString(spec.value);
}

// ponytail: 정수 범위·DECIMAL 자릿수 초과(MySQL 1067)는 검사하지 않는다 — 필요해지면 타입별 범위표를 둔다
function numericDefault(text: string, type: string, bad: (why: string) => never): string {
  const t = text.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return bad(`'${text}' 은 숫자가 아닙니다`);
  const base = baseType(type);
  if (/ unsigned$/.test(type) && t.startsWith('-') && Number(t) !== 0) return bad('UNSIGNED 컬럼에 음수');
  if (INT_TYPES.has(base) || base === 'year') return /^[+-]?\d+$/.test(t) ? BigInt(t).toString() : bad(`정수 컬럼에 '${text}'`);
  if (base === 'decimal') return Number(t).toFixed(Number(/^decimal\(\d+,(\d+)\)/.exec(type)![1]));
  return String(Number(t)); // float·double
}

// SET 기본값: 값마다 멤버여야 하고, 정의 순서로 다시 쓴다
function setDefault(text: string, type: string, bad: (why: string) => never): string {
  const members = enumMembers(type);
  const picked = text === '' ? [] : text.split(',').map((v) => members.find((m) => m.toLowerCase() === v.toLowerCase()) ?? bad(`'${v}' 은 SET 값이 아닙니다`));
  return members.filter((m) => picked.includes(m)).join(',');
}

// 사람이 쓴 컬럼 정의 → SHOW CREATE 모양 Column (table: 이 컬럼이 들어갈 테이블의 기본 문자셋)
export function finalizeColumn(spec: ColumnSpec, table: TableCharset): Column {
  const base = baseType(spec.type);
  if (spec.primaryKey && spec.nullable === true) fail(`PRIMARY KEY 컬럼 \`${spec.name}\` 은 NULL 일 수 없습니다 (MySQL 1171)`);
  if (spec.autoIncrement && !AUTO_INCREMENT_TYPES.has(base)) fail(`AUTO_INCREMENT 는 정수·실수 컬럼에만 쓸 수 있습니다: \`${spec.name}\` (MySQL 1063)`);
  if (spec.autoIncrement && spec.default) fail(`AUTO_INCREMENT 컬럼 \`${spec.name}\` 에는 기본값을 쓸 수 없습니다 (MySQL 1067)`);
  const nullable = spec.primaryKey ? false : spec.nullable ?? true;
  const col: Column = { name: spec.name, type: spec.type, ...columnCharset(spec.type, spec, table), nullable, invisible: spec.invisible, autoIncrement: spec.autoIncrement };
  if (spec.srid !== undefined) col.srid = spec.srid;
  if (spec.storage) col.storage = spec.storage;
  if (spec.columnFormat) col.columnFormat = spec.columnFormat;
  if (spec.default) col.default = normalizeDefault(spec.default, col);
  else if (nullable && !spec.autoIncrement && !NO_LITERAL_DEFAULT.has(base)) col.default = 'NULL';
  if (spec.onUpdate) col.onUpdate = nowText(spec.type, spec.onUpdate, `컬럼 \`${spec.name}\` 의 ON UPDATE`);
  if (spec.comment) col.comment = spec.comment;
  return col;
}

// 함수 RETURNS 타입: 타입 규칙으로 맞추고 문자열 타입이면 MySQL 처럼 ' CHARSET <스키마 기본 문자셋>' 을 붙인다
export function routineReturns(raw: string, charset: string): string {
  if (/\b(CHARSET|CHARACTER\s+SET|COLLATE)\b/i.test(raw)) fail(`RETURNS 안의 CHARSET·COLLATE 는 1차 지원 범위가 아닙니다: ${raw}`);
  const type = normalizeUserType(raw);
  return CHARSET_TYPES.has(baseType(type)) ? `${type} CHARSET ${canonicalCharset(charset)}` : type;
}
