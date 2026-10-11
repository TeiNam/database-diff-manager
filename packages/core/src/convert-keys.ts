// CONVERT TO CHARACTER SET 직후 인덱스 키 길이 판정 (InnoDB 키 한도, error 1071).
// 8.4 실측: 키 파트 하나는 DYNAMIC/COMPRESSED 3072바이트·COMPACT/REDUNDANT 767바이트, 인덱스 전체는 3072바이트까지.
// ROW_FORMAT 변경은 CONVERT 와 같은 ALTER 에 들어가므로 한도는 TARGET 행 저장 형식으로 정한다 (DYNAMIC→COMPACT + CONVERT 도 767)
import type { Column, Index, Table } from './model';

const TOTAL_LIMIT = 3072;
const PART_LIMIT = 3072;
const SMALL_PART_LIMIT = 767; // COMPACT·REDUNDANT
const SMALL_ROW_FORMATS = new Set(['COMPACT', 'REDUNDANT']);

// 문자 하나의 최대 바이트 (MySQL 8.4 SHOW CHARACTER SET 의 Maxlen). 모르는 문자셋은 가장 큰 값 4 로 본다 (안전 쪽)
const MULTI_BYTE: Record<string, number> = {
  utf8mb4: 4, utf8mb3: 3, utf8: 3, ucs2: 2, utf16: 4, utf16le: 4, utf32: 4, big5: 2, cp932: 2, euckr: 2, gb2312: 2, gbk: 2,
  sjis: 2, ujis: 3, eucjpms: 3, gb18030: 4,
};
const SINGLE_BYTE = new Set([
  'ascii', 'binary', 'latin1', 'latin2', 'latin5', 'latin7', 'cp1250', 'cp1251', 'cp1256', 'cp1257', 'cp850', 'cp852', 'cp866',
  'koi8r', 'koi8u', 'greek', 'hebrew', 'armscii8', 'dec8', 'swe7', 'hp8', 'keybcs2', 'macce', 'macroman', 'geostd8', 'tis620',
]);
const UNKNOWN_MAXLEN = 4;

export const charsetMaxlen = (charset: string): number => {
  const c = charset.toLowerCase();
  return SINGLE_BYTE.has(c) ? 1 : MULTI_BYTE[c] ?? UNKNOWN_MAXLEN;
};

const CHAR_TYPE = /^(?:var)?char\((\d+)\)/i;
const BINARY_TYPE = /^(?:var)?binary\((\d+)\)/i;
const TEXT_TYPE = /^(?:tiny|medium|long)?text\b/i;
const BLOB_TYPE = /^(?:tiny|medium|long)?blob\b/i;

// 키 파트 하나의 바이트. 문자 컬럼은 (prefix 또는 문자 길이) × maxlen, 이진 컬럼은 바이트 그대로.
// 식 키 파트·그 밖의 타입(숫자·enum 등)은 문자셋과 무관하거나 알 수 없어 0 으로 센다
function partBytes(column: Column | undefined, length: number | undefined, maxlen: number): number {
  if (!column) return 0;
  const chars = CHAR_TYPE.exec(column.type);
  if (chars) return (length ?? Number(chars[1])) * maxlen;
  if (TEXT_TYPE.test(column.type)) return (length ?? 0) * maxlen;
  const bytes = BINARY_TYPE.exec(column.type);
  if (bytes) return length ?? Number(bytes[1]);
  return BLOB_TYPE.test(column.type) ? length ?? 0 : 0;
}

export interface KeyLimit {
  part: number;
  total: number;
}

export const keyLimit = (rowFormat: string | undefined): KeyLimit =>
  ({ part: rowFormat && SMALL_ROW_FORMATS.has(rowFormat.toUpperCase()) ? SMALL_PART_LIMIT : PART_LIMIT, total: TOTAL_LIMIT });

export const rowFormatOf = (t: Table): string | undefined => t.options.find((o) => o.key === 'ROW_FORMAT')?.value;

// 모든 문자 컬럼이 maxlen 바이트 문자셋일 때 한도를 넘는 B-tree 인덱스 이름 (FULLTEXT·SPATIAL 은 키 길이 한도가 다르다)
export function oversizedIndexes(indexes: Index[], columns: Column[], maxlen: number, limit: KeyLimit): string[] {
  const byName = new Map(columns.map((c) => [c.name, c]));
  return indexes.filter((i) => i.kind !== 'FULLTEXT' && i.kind !== 'SPATIAL').filter((i) => {
    const parts = i.parts.map((p) => (p.column === undefined ? 0 : partBytes(byName.get(p.column), p.length, maxlen)));
    return parts.some((b) => b > limit.part) || parts.reduce((a, b) => a + b, 0) > limit.total;
  }).map((i) => i.name);
}
