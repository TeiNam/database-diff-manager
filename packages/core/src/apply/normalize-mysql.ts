// 사람이 쓴 타입·기본값·문자셋을 MySQL SHOW CREATE 모양으로 맞춘다 (8.0/8.4).
// 규칙마다 test:mysql 의 ALTER 시나리오(test/apply.int.test.ts)가 실제 MySQL 결과와 비교한다
import { charsetMaxlen, partBytes } from '../convert-keys';
import { Cursor } from '../cursor';
import { quoteString, tokenize, type Token } from '../lexer';
import type { Column, TableOption } from '../model';
import { normalizeType } from '../normalize';
import { memberFinder } from './enum-member';
import { assertFloatSize, floatDefault } from './float-default';
import { MAX_VARCHAR_BYTES } from './limits';
import { splitList } from './lists';
import { TEMPORAL_TYPES, temporalDefault, type TemporalType } from './temporal-default';
import { fail, RE_EXPORT, type ColumnSpec, type DefaultSpec, type NowSpec } from './types';

export const INT_TYPES: ReadonlySet<string> = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'bigint']);
const NUMERIC: ReadonlySet<string> = new Set([...INT_TYPES, 'decimal', 'float', 'double']);
// 문자셋·콜레이션이 붙는 타입
export const CHARSET_TYPES: ReadonlySet<string> = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set']);
export const BLOB_TYPES: ReadonlySet<string> = new Set(['tinytext', 'text', 'mediumtext', 'longtext', 'tinyblob', 'blob', 'mediumblob', 'longblob']);
// 리터럴 기본값을 쓸 수 없는 타입 (MySQL 1101). 그중 TEXT·BLOB 계열(BLOB_TYPES)만 NULL 허용이어도 SHOW CREATE 에 DEFAULT NULL 이 없고, JSON·GEOMETRY 계열은 찍힌다
export const NO_LITERAL_DEFAULT: ReadonlySet<string> = new Set([...BLOB_TYPES, 'json',
  'geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection', 'geomcollection']);
const KNOWN: ReadonlySet<string> = new Set([...NUMERIC, ...CHARSET_TYPES, ...NO_LITERAL_DEFAULT, 'bit', 'date', 'datetime', 'timestamp', 'time', 'year', 'binary', 'varbinary']);
const TWO_ARGS: ReadonlySet<string> = new Set(['decimal', 'float', 'double']);
// AUTO_INCREMENT 를 쓸 수 있는 타입은 정수뿐이다. FLOAT·DOUBLE 은 8.0.46 이 받고 8.4.11 은 1063 이라 8.4 규칙을 따른다 (스펙 4장)
const FLOAT_TYPES: ReadonlySet<string> = new Set(['float', 'double']);
// 사전은 Map: 객체 조회는 'constructor'·'__proto__' 같은 Object.prototype 이름을 '있는 키'로 읽는다
const ALIASES: ReadonlyMap<string, string> = new Map(Object.entries({
  integer: 'int', int1: 'tinyint', int2: 'smallint', int3: 'mediumint', int4: 'int', int8: 'bigint', middleint: 'mediumint',
  dec: 'decimal', numeric: 'decimal', fixed: 'decimal', real: 'double', character: 'char',
}));
const NATIONAL = `NATIONAL·NCHAR 타입은 문자셋이 따로 붙어 1차 지원 범위가 아닙니다 — ${RE_EXPORT}`;
const REJECTED: ReadonlyMap<string, string> = new Map(Object.entries({
  serial: `SERIAL 은 UNIQUE 인덱스가 따로 생겨 1차 지원 범위가 아닙니다 — ${RE_EXPORT}`,
  national: NATIONAL, nchar: NATIONAL, nvarchar: NATIONAL,
  long: `LONG·LONG VARCHAR 는 1차 지원 범위가 아닙니다 (MEDIUMTEXT 로 쓰면 됩니다) — ${RE_EXPORT}`,
}));

export const baseType = (type: string): string => /^\w+/.exec(type)?.[0] ?? '';

// 'INT(11) UNSIGNED' → 'int unsigned', 'DECIMAL' → 'decimal(10,0)', "ENUM('a' , \"b\")" → "enum('a','b')"
export function normalizeUserType(src: string): string {
  const c = new Cursor(tokenize(src), src);
  const first = c.next();
  if (first.t !== 'word') return fail(`타입이 필요합니다: ${src}`);
  const word = first.v.toLowerCase();
  const rejected = REJECTED.get(word);
  if (rejected) return fail(rejected);
  if (word === 'bool' || word === 'boolean') return c.done ? 'tinyint(1)' : fail(`BOOLEAN 뒤에는 수식어를 쓸 수 없습니다: ${src}`);
  if (word === 'double') c.acceptWord('PRECISION');
  const varying = (word === 'char' || word === 'character') && c.acceptWord('VARYING'); // CHARACTER VARYING(n)·CHAR VARYING(n) = VARCHAR(n)
  const name = varying ? 'varchar' : (ALIASES.get(word) ?? word);
  if (!KNOWN.has(name)) return fail(`지원하지 않는 타입입니다: ${first.v}`);
  const inner = c.isOp('(') ? c.parenTokens() : undefined;
  let unsigned = false;
  while (!c.done) {
    if (c.acceptWord('UNSIGNED')) unsigned = true;
    else if (c.acceptWord('SIGNED')) unsigned = false;
    else if (c.isWord('ZEROFILL')) fail(`ZEROFILL 은 1차 지원 범위가 아닙니다 (MySQL 8.0.17 부터 폐기 예정) — ${RE_EXPORT}`);
    else fail(`알 수 없는 타입 수식어: ${c.peek()!.v}`);
  }
  if (unsigned && !NUMERIC.has(name)) fail(`UNSIGNED 는 숫자 타입에만 쓸 수 있습니다: ${src}`);
  return withArgs(name, inner, src) + (unsigned ? ' unsigned' : '');
}

function withArgs(name: string, inner: Token[] | undefined, src: string): string {
  if (name === 'enum' || name === 'set') return `${name}(${enumValues(inner, src).map(quoteString).join(',')})`;
  if (inner && !inner.length) fail(`타입 인자가 비었습니다: ${src} (MySQL 1064)`); // 빈 괄호는 splitList 보다 먼저 봐서 어느 타입인지 메시지에 남긴다
  const args = inner && splitList(inner, '타입 인자').map((part) => (part.length === 1 && part[0].t === 'number' && /^\d+$/.test(part[0].v) ? String(Number(part[0].v)) : fail(`타입 인자가 올바르지 않습니다: ${src}`)));
  if (args && args.length > (TWO_ARGS.has(name) ? 2 : 1)) fail(`타입 인자가 너무 많습니다: ${src}`);
  if (FLOAT_TYPES.has(name) && args?.length === 2) assertFloatSize(name.toUpperCase(), Number(args[0]), Number(args[1]));
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
      return args ? fail(`${name.toUpperCase()}(n) 은 1차 지원 범위가 아닙니다 (MySQL 이 길이로 타입을 고릅니다) — ${RE_EXPORT}`) : name;
  }
}

// 끝의 공백(U+0020)만 지운다 — MySQL 이 ENUM·SET 값에 하는 일이라 탭·줄바꿈·NBSP 는 남는다.
// `/ +$/` 로 지우면 값 가운데 공백이 길 때 시작 위치마다 끝까지 훑어 O(n^2) (10만 칸 ≈ 5 초)라 뒤에서부터 센다
export function trimTrailingSpaces(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x20) end--;
  return text.slice(0, end);
}

// MySQL 은 ENUM·SET 값 끝 공백을 지운다. 대소문자만 다른 같은 값이면 1291
function enumValues(inner: Token[] | undefined, src: string): string[] {
  const values = (inner ? splitList(inner, 'ENUM·SET 값') : []).map((part) => (part.length === 1 && part[0].t === 'string' ? trimTrailingSpaces(part[0].v) : fail(`ENUM·SET 값은 문자열이어야 합니다: ${src}`)));
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
const PRIMARY_COLLATION: ReadonlyMap<string, string> = new Map(Object.entries({
  utf8mb4: 'utf8mb4_0900_ai_ci', utf8mb3: 'utf8mb3_general_ci', latin1: 'latin1_swedish_ci', latin2: 'latin2_general_ci', ascii: 'ascii_general_ci',
  binary: 'binary', ucs2: 'ucs2_general_ci', utf16: 'utf16_general_ci', utf16le: 'utf16le_general_ci', utf32: 'utf32_general_ci',
  euckr: 'euckr_korean_ci', gbk: 'gbk_chinese_ci', gb2312: 'gb2312_chinese_ci', gb18030: 'gb18030_chinese_ci', big5: 'big5_chinese_ci',
  sjis: 'sjis_japanese_ci', ujis: 'ujis_japanese_ci', cp932: 'cp932_japanese_ci', eucjpms: 'eucjpms_japanese_ci', cp1250: 'cp1250_general_ci',
  cp1251: 'cp1251_general_ci', cp1256: 'cp1256_general_ci', cp1257: 'cp1257_general_ci', greek: 'greek_general_ci', hebrew: 'hebrew_general_ci',
  tis620: 'tis620_thai_ci', koi8r: 'koi8r_general_ci', koi8u: 'koi8u_general_ci',
}));

export function canonicalCharset(name: string): string {
  const cs = name.toLowerCase() === 'utf8' ? 'utf8mb3' : name.toLowerCase();
  return PRIMARY_COLLATION.has(cs) ? cs : fail(`알 수 없는 문자셋입니다: ${name} (MySQL 1115)`);
}

// 콜레이션 이름은 SHOW CREATE 에 따옴표 없이 찍히므로 이름 전체가 \w+ 여야 한다 (charsetOfCollation 은 접두어만 본다)
export function canonicalCollation(name: string): string {
  const coll = name.toLowerCase().replace(/^utf8_/, 'utf8mb3_');
  if (!/^\w+$/.test(coll)) fail(`알 수 없는 콜레이션입니다: ${name} (MySQL 1273)`);
  charsetOfCollation(coll);
  return coll;
}

export function charsetOfCollation(coll: string): string {
  const cs = coll === 'binary' ? 'binary' : coll.split('_')[0];
  return PRIMARY_COLLATION.has(cs) ? cs : fail(`알 수 없는 콜레이션입니다: ${coll} (MySQL 1273)`);
}

export const primaryCollation = (cs: string): string => PRIMARY_COLLATION.get(cs) ?? fail(`알 수 없는 문자셋입니다: ${cs} (MySQL 1115)`);

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

// 컬럼 문자셋 표기 (SHOW CREATE 규칙, MySQL 8.0.46·8.4.11 실측): CHARACTER SET·COLLATE 를 하나라도 쓴 컬럼은 테이블 기본과 같아도 둘 다 남긴다
// (`CHARACTER SET a COLLATE b` — 문자셋만 쓰면 테이블 콜레이션이 아니라 그 문자셋의 기본 콜레이션, COLLATE 만 쓰면 그 콜레이션의 문자셋이 붙는다).
// 쓰지 않은 컬럼은 테이블 기본을 물려받고, 그 콜레이션이 문자셋의 기본(primary)이 아닐 때만 COLLATE 하나가 남는다. MODIFY·CHANGE 도 옛 컬럼의 문자셋을 물려받지 않는다
export function columnCharset(type: string, written: Pick<ColumnSpec, 'charset' | 'collation'>, table: TableCharset): Pick<Column, 'charset' | 'collation'> {
  if (!CHARSET_TYPES.has(baseType(type))) return written.charset || written.collation ? fail(`문자열이 아닌 타입에는 CHARACTER SET·COLLATE 를 쓸 수 없습니다: ${type}`) : {};
  if (!written.charset && !written.collation) return table.collation === primaryCollation(table.charset) ? {} : { collation: table.collation };
  const charset = written.charset ? canonicalCharset(written.charset) : charsetOfCollation(canonicalCollation(written.collation!));
  const collation = written.collation ? canonicalCollation(written.collation) : primaryCollation(charset);
  if (charsetOfCollation(collation) !== charset) fail(`COLLATE ${collation} 은 문자셋 ${charset} 의 콜레이션이 아닙니다 (MySQL 1253)`);
  if (charset === 'binary') fail(`CHARACTER SET binary 는 MySQL 이 컬럼 타입을 VARBINARY·BLOB 으로 바꿔 1차 지원 범위가 아닙니다 (VARBINARY·BLOB 타입을 직접 쓰세요) — ${RE_EXPORT}`);
  return { charset, collation };
}

// 컬럼의 실제 콜레이션 (문자열 타입이 아니면 '')
export function effectiveCollation(col: Pick<Column, 'type' | 'charset' | 'collation'>, table: TableCharset): string {
  if (!CHARSET_TYPES.has(baseType(col.type))) return '';
  return col.collation ?? (col.charset ? primaryCollation(canonicalCharset(col.charset)) : table.collation);
}

// 컬럼의 글자당 최대 바이트 (charsetMaxlen — SHOW CHARACTER SET 의 Maxlen): 문자열 타입은 실제 문자셋의 값이고, 이진 타입(BINARY·VARBINARY·BLOB)은 바이트가 글자라 1 이다.
// 콜레이션 이름의 앞부분으로 문자셋을 읽어 기준 덤프의 옛 이름(utf8_general_ci)에도 던지지 않는다
export function columnMaxlen(col: Pick<Column, 'type' | 'charset' | 'collation'>, table: TableCharset): number {
  if (!CHARSET_TYPES.has(baseType(col.type))) return 1;
  return charsetMaxlen(col.collation?.split('_')[0] ?? col.charset ?? table.charset);
}

// VARCHAR·VARBINARY 바이트 한도 (limits.ts): 엄격하지 않은 세션은 넘는 컬럼을 TEXT·BLOB 계열로 바꿔 받는다 (utf8mb4 VARCHAR(16384) → mediumtext). 행 크기 한도(1118)는 보지 않는다
function assertVarcharBytes(col: Column, table: TableCharset): void {
  const base = baseType(col.type);
  if (base !== 'varchar' && base !== 'varbinary') return;
  const bytes = partBytes(col, undefined, columnMaxlen(col, table));
  if (bytes <= MAX_VARCHAR_BYTES) return;
  fail(`컬럼 \`${col.name}\` 의 ${col.type} 은 ${bytes} 바이트로 ${MAX_VARCHAR_BYTES} 바이트를 넘습니다 — 엄격 SQL_MODE 의 MySQL 은 1074 로 거부하고, 엄격하지 않은 세션은 TEXT·BLOB 계열로 바꿔 받습니다 — ${RE_EXPORT}`);
}

const fspOf = (type: string): number => Number(/^(?:datetime|timestamp|time)\((\d)\)/.exec(type)?.[1] ?? 0);

export const ER_INVALID_DEFAULT = 1067;
export const ER_INVALID_ON_UPDATE = 1294;

// CURRENT_TIMESTAMP 기본값·ON UPDATE: DATETIME·TIMESTAMP 에만, 소수 초 자릿수는 컬럼과 같아야 한다.
// errno: 기본값이 잘못되면 1067, ON UPDATE 가 잘못되면 1294
export function nowText(type: string, now: NowSpec, what: string, errno = ER_INVALID_DEFAULT): string {
  const base = baseType(type);
  if (base !== 'datetime' && base !== 'timestamp') fail(`${what} CURRENT_TIMESTAMP 은 DATETIME·TIMESTAMP 에만 쓸 수 있습니다 (MySQL ${errno})`);
  if ((now.fsp ?? 0) !== fspOf(type)) fail(`${what} CURRENT_TIMESTAMP 의 소수 초 자릿수가 컬럼(${type})과 다릅니다 (MySQL ${errno})`);
  return now.fsp ? `CURRENT_TIMESTAMP(${now.fsp})` : 'CURRENT_TIMESTAMP';
}

// 기본값 원문 (SHOW CREATE 표기): 숫자도 따옴표로 감싸고 타입 자릿수에 맞춘다. ENUM·SET 멤버는 컬럼의 실제 콜레이션으로 찾는다 (memberFinder — table: 컬럼이 든 테이블의
// 기본 문자셋, 콜레이션을 적지 않은 컬럼이 물려받는다). undefined: 저장되는 기본값이 없다 — TEXT·BLOB 계열에 명시한 DEFAULT NULL 은 SHOW CREATE 에 보이지 않는다 (JSON·GEOMETRY 는 'NULL')
export function normalizeDefault(spec: DefaultSpec, col: Pick<Column, 'name' | 'type' | 'nullable' | 'charset' | 'collation'>, table: TableCharset): string | undefined {
  const base = baseType(col.type);
  const bad = (why: string): never => fail(`컬럼 \`${col.name}\` 의 기본값이 올바르지 않습니다: ${why} (MySQL 1067)`);
  const reExport = (why: string): never => fail(`컬럼 \`${col.name}\` 의 기본값 ${why} — ${RE_EXPORT}`);
  if (spec.kind === 'null') {
    if (!col.nullable) return bad('NOT NULL 컬럼에 NULL');
    return BLOB_TYPES.has(base) ? undefined : 'NULL';
  }
  if (NO_LITERAL_DEFAULT.has(base)) return fail(`${base.toUpperCase()} 컬럼에는 리터럴 기본값을 쓸 수 없습니다 (MySQL 1101)`);
  if (spec.kind === 'now') return nowText(col.type, spec, `컬럼 \`${col.name}\` 의 기본값`);
  if (base === 'bit') return bitDefault(spec, bad, reExport);
  if (spec.kind === 'bit') return bad(spec.value);
  if (TEMPORAL_TYPES.has(base)) return temporalText(spec, col, base as TemporalType, bad);
  if (base === 'year') return quoteString(yearDefault(spec.value, bad, reExport));
  if (NUMERIC.has(base)) return quoteString(numericDefault(spec.value, col.type, bad, reExport));
  // ENUM·SET 에 쓴 숫자는 값이 아니라 순번·비트다 (8.0.46·8.4.11 실측: ENUM('2','1') DEFAULT 1 → '2', SET('2','a') DEFAULT 2 → 'a')
  if ((base === 'enum' || base === 'set') && spec.kind === 'number') return reExport(`${spec.value} 은(는) 숫자라 MySQL 이 값이 아니라 순번·비트로 읽습니다 (값을 따옴표로 감싸 쓰세요)`);
  if (base === 'enum') {
    const find = memberFinder(enumMembers(col.type), effectiveCollation(col, table), reExport);
    return quoteString(find(trimTrailingSpaces(spec.value)) ?? bad(`'${spec.value}' 은 ENUM 값이 아닙니다`));
  }
  if (base === 'set') return quoteString(setDefault(spec.value, col, table, bad, reExport));
  const text = spec.kind === 'number' ? numberText(spec.value) ?? reExport(`${spec.value} 은(는) 문자열 컬럼에 쓸 수 있는 숫자 꼴이 아닙니다`) : spec.value;
  if (base === 'char') return quoteString(trimTrailingSpaces(text)); // CHAR 는 끝 공백을 떼고 찍는다 (8.0.46·8.4.11 실측: 'ab  ' → 'ab', ' ' → '')
  return quoteString(text);
}

// 문자열 컬럼(CHAR·VARCHAR·BINARY·VARBINARY)에 쓴 숫자 리터럴: MySQL 은 수로 읽은 뒤 글자로 바꿔 저장한다 (8.0.46·8.4.11 실측, 시나리오 string-number-defaults:
// 001 → '1', 001.50 → '1.50', 1. → '1', -0 → '0', -0.0 → '0.0', -001 → '-1'). 정수부 앞 0 을 떼고, 소수부는 쓴 그대로 두며 (빈 소수부는 점까지 뗀다), 값이 0 이면
// 부호를 뗀다. parseDefault 가 만드는 꼴([-]정수[.소수])이 아니면 undefined
function numberText(value: string): string | undefined {
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(value);
  if (!m) return undefined;
  const [, sign, whole, frac = ''] = m;
  const text = `${whole.replace(/^0+(?=\d)/, '')}${frac ? `.${frac}` : ''}`;
  return sign && /[1-9]/.test(whole + frac) ? `-${text}` : text;
}

// BIT 기본값: MySQL 은 앞쪽 0 을 떼고 찍는다 (8.0.46·8.4.11 실측: b'00000101' → b'101', b'00000000' → b'0')
const bitText = (digits: string): string => `b'${digits.replace(/^0+/, '') || '0'}'`;

// BIT 기본값은 b'…' 와 0 이상의 정수만 받는다. 문자열은 MySQL 이 수가 아니라 글자의 바이트로 저장하므로 (8.0.46·8.4.11 실측: BIT(8) DEFAULT '1' → b'110001',
// BIT(1) DEFAULT '0' → 1067) 재현하지 않고 받지 않는다 — 수로 읽으면 다른 기본값을 저장한다 (리뷰 2회차 M-5)
function bitDefault(spec: Extract<DefaultSpec, { value: string }>, bad: (why: string) => never, reExport: (why: string) => never): string {
  if (spec.kind === 'bit') return bitText(spec.value.slice(2, -1));
  if (spec.kind === 'string') return reExport(`'${spec.value}' 은(는) 문자열이라 MySQL 이 BIT 에 글자의 바이트로 저장합니다 (숫자나 b'…' 로 쓰세요)`);
  return /^\d+$/.test(spec.value) ? bitText(BigInt(spec.value).toString(2)) : bad(spec.value);
}

// 날짜·시간 컬럼의 문자열 기본값: MySQL 이 다시 쓰는 꼴로 맞춘다 (temporal-default.ts). 숫자 리터럴(20200101)과 표준이 아닌 꼴은 1차에서 받지 않는다
const TEMPORAL_SHAPE: Readonly<Record<TemporalType, string>> = { date: 'YYYY-MM-DD', datetime: 'YYYY-MM-DD HH:MM:SS', timestamp: 'YYYY-MM-DD HH:MM:SS', time: 'HH:MM:SS' };

function temporalText(spec: DefaultSpec, col: Pick<Column, 'name' | 'type'>, type: TemporalType, bad: (why: string) => never): string {
  const result = spec.kind === 'string' ? temporalDefault(type, fspOf(col.type), spec.value) : undefined;
  if (result && 'value' in result) return quoteString(result.value);
  if (result && 'invalid' in result) return bad(result.invalid);
  return fail(`컬럼 \`${col.name}\` 의 ${type.toUpperCase()} 기본값은 '${TEMPORAL_SHAPE[type]}' 꼴의 문자열로만 쓸 수 있습니다 (MySQL 이 값을 다시 써서 저장합니다) — ${RE_EXPORT}`);
}

// 숫자 모양 (부호, 정수부[.소수부] 또는 .소수부, 지수). 정수부와 소수부를 '.' 이 갈라 놓아 숫자가 아닌 긴 문자열에서도 선형이다 —
// \d+\.?\d* 처럼 '.' 를 선택으로 두면 \d+ 와 \d* 가 같은 자리를 나눠 가져 실패할 때 O(n^2) (20만 자 ≈ 30 초)
const NUMERIC_LITERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

// ponytail: 정수 범위(MySQL 1067)는 검사하지 않는다 — 필요해지면 타입별 범위표를 둔다. FLOAT·DOUBLE 은 MySQL 이 다시 쓰는 꼴을 float-default.ts 가 맞춘다
function numericDefault(text: string, type: string, bad: (why: string) => never, reExport: (why: string) => never): string {
  const t = text.trim();
  if (!NUMERIC_LITERAL.test(t)) return bad(`'${text}' 은 숫자가 아닙니다`);
  const base = baseType(type);
  if (/ unsigned$/.test(type) && t.startsWith('-') && Number(t) !== 0) return bad('UNSIGNED 컬럼에 음수');
  if (INT_TYPES.has(base)) return /^[+-]?\d+$/.test(t) ? BigInt(t).toString() : bad(`정수 컬럼에 '${text}'`);
  if (base === 'decimal') return decimalDefault(t, type, bad, reExport);
  return floatDefault(t, type, bad, reExport);
}

// YEAR 기본값 (MySQL 8.0.46·8.4.11 실측): 네 자리 연도(1901~2155)와 0000 만 그대로 저장한다. 한두 자리는 MySQL 이 세기를 붙여 바꾸고
// (20 → '2020', 69 → '2069', 70 → '1970', 숫자 0 → '0000' 인데 문자열 '0' → '2000'), '+2020'·'2020.5'·' 2020' 같은 숫자 꼴도 값을 다시 써서 저장하므로 재현하지 않는다
function yearDefault(text: string, bad: (why: string) => never, reExport: (why: string) => never): string {
  const rewritten = (why: string) => reExport(`${JSON.stringify(text)} 은(는) ${why} (YEAR 는 네 자리 연도로 쓰세요)`);
  if (/^\d+$/.test(text)) {
    const year = text.replace(/^0+/, ''); // 0 으로 채운 꼴(0001)도 숫자 1 과 같다
    if (text === '0000') return text;
    if (year.length <= 2) return rewritten('MySQL 이 세기를 붙여 바꿔 저장합니다');
    return year.length === 4 && year >= '1901' && year <= '2155' ? year : bad('YEAR 는 1901~2155 와 0000 만 받습니다');
  }
  if (/^\s*[+-]?\d+(?:\.\d+)?\s*$/.test(text)) return rewritten('MySQL 이 값을 다시 써서 저장합니다');
  return bad(`'${text}' 은 YEAR 값이 아닙니다`);
}

// DECIMAL 기본값 (MySQL 8.0.46·8.4.11 실측): 정확한 십진수로 scale 자리에 맞춘다. Number 를 거치면 15자리가 넘는 값과 소수 17자리 이상이 틀리고
// (0.1.toFixed(20) = '0.10000000000000000555') 반올림도 어긋난다 (1.005.toFixed(2) = '1.00', MySQL 은 '1.01'). 반올림은 0 에서 먼 쪽이고 (2.5 → 3, -2.5 → -3, -0.001 → '0.00'),
// 정밀도를 넘으면 반올림한 뒤에 1067 이다. 지수 표기(1e2)는 MySQL 이 DOUBLE 을 거쳐 바꾸므로 가수 15자리 이하·지수 70 이하만 받는다
const DECIMAL_LITERAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i;
const MAX_EXPONENT = 70;
const MAX_EXPONENT_DIGITS = 15;

function decimalDefault(t: string, type: string, bad: (why: string) => never, reExport: (why: string) => never): string {
  const [precision, scale] = decimalSize(type);
  const [, sign, intDigits, fracDigits = '', expText] = DECIMAL_LITERAL.exec(t)!; // numericDefault 가 NUMERIC_LITERAL 로 모양을 이미 확인했다
  const exponent = expText === undefined ? 0 : Number(expText);
  const digits = intDigits + fracDigits;
  if (expText !== undefined && (Math.abs(exponent) > MAX_EXPONENT || digits.replace(/^0+/, '').length > MAX_EXPONENT_DIGITS)) {
    return reExport(`${t} 의 지수 표기는 MySQL 이 DOUBLE 을 거쳐 바꿔 가수 ${MAX_EXPONENT_DIGITS}자리·지수 ${MAX_EXPONENT} 이하만 받습니다`);
  }
  const point = intDigits.length + exponent; // digits 안에서 소수점이 놓이는 자리
  const whole = (point <= 0 ? '' : digits.slice(0, point).padEnd(point, '0')).replace(/^0+/, '');
  const frac = point >= digits.length ? '' : point <= 0 ? '0'.repeat(-point) + digits : digits.slice(point);
  const overflow = () => bad(`DECIMAL(${precision},${scale}) 의 범위를 넘습니다`);
  if (whole.length > precision - scale) return overflow(); // 긴 숫자를 BigInt 로 읽기 전에 거른다
  const scaled = BigInt(`${whole || '0'}${frac.slice(0, scale).padEnd(scale, '0')}`) + ((frac[scale] ?? '0') >= '5' ? 1n : 0n);
  if (scaled >= 10n ** BigInt(precision)) return overflow();
  const body = scaled.toString().padStart(scale + 1, '0');
  const text = scale === 0 ? body : `${body.slice(0, -scale)}.${body.slice(-scale)}`;
  return sign === '-' && scaled !== 0n ? `-${text}` : text;
}

// decimal(M,D) 의 M·D. MySQL 이 받지 않는 크기는 거부한다
function decimalSize(type: string): [number, number] {
  const m = /^decimal\((\d+),(\d+)\)/.exec(type)!;
  const [precision, scale] = [Number(m[1]), Number(m[2])];
  if (precision > 65) fail(`DECIMAL 의 전체 자릿수는 65 이하여야 합니다: ${precision} (MySQL 1426)`);
  if (scale > 30) fail(`DECIMAL 의 소수 자릿수는 30 이하여야 합니다: ${scale} (MySQL 1425)`);
  if (scale > precision) fail(`DECIMAL(${precision},${scale}) 은 전체 자릿수가 소수 자릿수 이상이어야 합니다 (MySQL 1427)`);
  return [precision, scale];
}

// 4바이트 문자(이모지 등, U+10000 이상): SHOW CREATE 는 COMMENT·ENUM·SET 값의 그 문자를 '?' 로, 문자열 DEFAULT 는 통째로 16진수(0xF09F9880)로 바꿔 찍는다 (MySQL 8.0.46·8.4.11 실측).
// 그대로 저장하면 재추출한 덤프와 달라 1차에서는 거부한다. 루틴 본문은 쓴 그대로 찍히므로 상관없다 (루틴 COMMENT 는 '?')
const NON_BMP = /[\u{10000}-\u{10FFFF}]/u;

export function assertBmpText(text: string, where: string): void {
  if (NON_BMP.test(text)) fail(`${where}에 4바이트 문자(이모지 등)가 있습니다 — MySQL 이 SHOW CREATE 에서 '?' 나 16진수로 바꿔 찍어 1차 지원 범위가 아닙니다 — ${RE_EXPORT}`);
}

// SET 기본값: 값마다 멤버여야 하고 (memberFinder), 정의 순서로 다시 쓴다
function setDefault(text: string, col: Pick<Column, 'type' | 'charset' | 'collation'>, table: TableCharset, bad: (why: string) => never, reExport: (why: string) => never): string {
  const members = enumMembers(col.type);
  const find = memberFinder(members, effectiveCollation(col, table), reExport);
  const picked = text === '' ? [] : text.split(',').map((v) => find(v) ?? bad(`'${v}' 은 SET 값이 아닙니다`));
  return members.filter((m) => picked.includes(m)).join(',');
}

// 사람이 쓴 컬럼 정의 → SHOW CREATE 모양 Column (table: 이 컬럼이 들어갈 테이블의 기본 문자셋)
export function finalizeColumn(spec: ColumnSpec, table: TableCharset): Column {
  const base = baseType(spec.type);
  if (spec.primaryKey && spec.nullable === true) fail(`PRIMARY KEY 컬럼 \`${spec.name}\` 은 NULL 일 수 없습니다 (MySQL 1171)`);
  if (spec.autoIncrement && FLOAT_TYPES.has(base)) fail(`AUTO_INCREMENT 는 FLOAT·DOUBLE 컬럼에 쓸 수 없습니다: \`${spec.name}\` (MySQL 8.4 1063 — 8.0 은 받지만 1차에서는 8.4 규칙을 따릅니다)`);
  if (spec.autoIncrement && !INT_TYPES.has(base)) fail(`AUTO_INCREMENT 는 정수 컬럼에만 쓸 수 있습니다: \`${spec.name}\` (MySQL 1063)`);
  // AUTO_INCREMENT 컬럼은 NULL 을 써도 NOT NULL 이 되고, DEFAULT NULL 은 조용히 없어진다 (MySQL 8.0.46·8.4.11 실측). 다른 기본값은 1067.
  // PRIMARY KEY 에 든 컬럼의 NULL·DEFAULT NULL(1171)은 키가 다 정해진 문장 끝에서 enforcePrimaryKeyNotNull 이 본다
  if (spec.autoIncrement && spec.default && spec.default.kind !== 'null') fail(`AUTO_INCREMENT 컬럼 \`${spec.name}\` 에는 기본값을 쓸 수 없습니다 (MySQL 1067)`);
  const nullable = spec.primaryKey || spec.autoIncrement ? false : spec.nullable ?? true;
  const col: Column = { name: spec.name, type: spec.type, ...columnCharset(spec.type, spec, table), nullable, invisible: spec.invisible, autoIncrement: spec.autoIncrement };
  assertVarcharBytes(col, table);
  if (spec.srid !== undefined) col.srid = spec.srid;
  if (spec.storage) col.storage = spec.storage;
  if (spec.columnFormat) col.columnFormat = spec.columnFormat;
  if (spec.default && !spec.autoIncrement) {
    const value = normalizeDefault(spec.default, col, table);
    if (value !== undefined) col.default = value;
  } else if (nullable && !BLOB_TYPES.has(base)) col.default = 'NULL';
  if (spec.onUpdate) col.onUpdate = nowText(spec.type, spec.onUpdate, `컬럼 \`${spec.name}\` 의 ON UPDATE`, ER_INVALID_ON_UPDATE);
  if (spec.comment) col.comment = spec.comment;
  return col;
}

// 함수 RETURNS 타입: 타입 규칙으로 맞추고 문자열 타입이면 MySQL 처럼 ' CHARSET <스키마 기본 문자셋>' 을 붙인다. 스키마 기본 콜레이션이 그 문자셋의 기본(primary)이 아니면
// ' COLLATE <콜레이션>' 도 붙는다 (8.0.46·8.4.11 실측: utf8mb4_0900_ai_ci·latin1_swedish_ci·utf8mb3_general_ci 는 안 찍고 utf8mb4_unicode_ci·latin1_bin 은 찍는다).
// collation 을 안 주면 문자셋의 기본 콜레이션이다
export function routineReturns(raw: string, charset: string, collation?: string): string {
  if (/\b(CHARSET|CHARACTER\s+SET|COLLATE)\b/i.test(raw)) fail(`RETURNS 안의 CHARSET·COLLATE 는 1차 지원 범위가 아닙니다: ${raw} — ${RE_EXPORT}`);
  const type = normalizeUserType(raw);
  if (!CHARSET_TYPES.has(baseType(type))) return type;
  const cs = canonicalCharset(charset);
  const coll = collation === undefined ? primaryCollation(cs) : canonicalCollation(collation);
  return `${type} CHARSET ${cs}${coll === primaryCollation(cs) ? '' : ` COLLATE ${coll}`}`;
}
