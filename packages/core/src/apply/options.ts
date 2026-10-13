// 테이블 옵션: 값 정규화와 SHOW CREATE 옵션 순서
import type { Cursor } from '../cursor';
import { quoteString } from '../lexer';
import type { TableOption } from '../model';
import { fail } from './types';

// Map: 객체 조회는 'constructor'·'__proto__' 같은 Object.prototype 이름을 '있는 키'로 읽는다
const ENGINES: ReadonlyMap<string, string> = new Map(Object.entries({
  innodb: 'InnoDB', myisam: 'MyISAM', memory: 'MEMORY', heap: 'MEMORY', csv: 'CSV', archive: 'ARCHIVE', blackhole: 'BLACKHOLE',
}));
const ROW_FORMATS: ReadonlySet<string> = new Set(['DEFAULT', 'DYNAMIC', 'FIXED', 'COMPRESSED', 'REDUNDANT', 'COMPACT']);
// SHOW CREATE TABLE 의 옵션 순서 (모르는 키는 COLLATE 와 ROW_FORMAT 사이)
const ORDER = ['ENGINE', 'DEFAULT CHARSET', 'COLLATE', 'ROW_FORMAT', 'KEY_BLOCK_SIZE', 'COMMENT'];

export const engineName = (v: string): string => ENGINES.get(v.toLowerCase()) ?? fail(`지원하지 않는 엔진입니다: ${v}`);

export function rowFormatName(v: string): string {
  const f = v.toUpperCase();
  return ROW_FORMATS.has(f) ? f : fail(`알 수 없는 ROW_FORMAT 입니다: ${v}`);
}

// 옵션을 바꾸거나(value) 지운다(undefined). 있던 옵션은 그 자리에서 바꾸고, 새 옵션은 SHOW CREATE 순서에 맞는 자리에 넣는다
export function setOption(options: readonly TableOption[], key: string, value: string | undefined): TableOption[] {
  if (value === undefined) return options.filter((o) => o.key !== key);
  if (options.some((o) => o.key === key)) return options.map((o) => (o.key === key ? { key, value } : o));
  const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : 2.5);
  const at = options.findIndex((o) => rank(o.key) > rank(key));
  return at < 0 ? [...options, { key, value }] : [...options.slice(0, at), { key, value }, ...options.slice(at)];
}

// 옵션 값: [=] 값 (따옴표 값도 받는다)
export function optionValue(c: Cursor): string {
  c.acceptOp('=');
  return c.next().v;
}

// COMMENT·ROW_FORMAT·KEY_BLOCK_SIZE 옵션 하나 (ALTER TABLE·CREATE TABLE 공용). 이 셋이 아니면 소비하지 않고 undefined.
// value undefined 는 옵션을 지운다 (COMMENT=''·ROW_FORMAT=DEFAULT·KEY_BLOCK_SIZE=0)
export function parseCommonOption(c: Cursor): { key: string; value: string | undefined } | undefined {
  if (c.acceptWord('COMMENT')) {
    c.acceptOp('=');
    const v = c.string();
    return { key: 'COMMENT', value: v === '' ? undefined : quoteString(v) };
  }
  if (c.acceptWord('ROW_FORMAT')) {
    const v = rowFormatName(optionValue(c));
    return { key: 'ROW_FORMAT', value: v === 'DEFAULT' ? undefined : v };
  }
  if (c.acceptWord('KEY_BLOCK_SIZE')) {
    const v = optionValue(c);
    if (!/^\d+$/.test(v)) fail(`KEY_BLOCK_SIZE 는 숫자여야 합니다: ${v}`);
    return { key: 'KEY_BLOCK_SIZE', value: Number(v) === 0 ? undefined : String(Number(v)) };
  }
  return undefined;
}
