// 테이블 옵션: 값 정규화와 SHOW CREATE 옵션 순서
import type { Cursor } from '../cursor';
import { quoteString } from '../lexer';
import type { Table, TableOption } from '../model';
import { assertCommentLength } from './comment-length';
import { fail, RE_EXPORT } from './types';

// Map: 객체 조회는 'constructor'·'__proto__' 같은 Object.prototype 이름을 '있는 키'로 읽는다
const ENGINES: ReadonlyMap<string, string> = new Map(Object.entries({
  innodb: 'InnoDB', myisam: 'MyISAM', memory: 'MEMORY', heap: 'MEMORY', csv: 'CSV', archive: 'ARCHIVE', blackhole: 'BLACKHOLE',
}));
const ROW_FORMATS: ReadonlySet<string> = new Set(['DEFAULT', 'DYNAMIC', 'FIXED', 'COMPRESSED', 'REDUNDANT', 'COMPACT']);
// SHOW CREATE TABLE 의 옵션 순서 (모르는 키는 COLLATE 와 ROW_FORMAT 사이)
const ORDER = ['ENGINE', 'DEFAULT CHARSET', 'COLLATE', 'ROW_FORMAT', 'KEY_BLOCK_SIZE', 'COMMENT'];

export const engineName = (v: string): string => ENGINES.get(v.toLowerCase()) ?? fail(`지원하지 않는 엔진입니다: ${v}`);

// InnoDB 테이블만 지원한다: 엔진마다 FK·인덱스 규칙이 달라 모델에서 MySQL 과 같게 재현할 수 없다 (예: MyISAM 은 FOREIGN KEY 를 조용히 버린다)
const innodbOnly = (detail: string): never => fail(`InnoDB 테이블만 지원합니다 (${detail}) — ${RE_EXPORT}`);

// CREATE·ALTER TABLE 의 ENGINE 값: InnoDB(대소문자 무시)만 받는다. 다른 값은 알려진 엔진이든 모르는 이름이든 1차 지원 범위 밖이다
export const innodbEngineName = (v: string): string => (v.toLowerCase() === 'innodb' ? engineName(v) : innodbOnly(`ENGINE=${v}`));

// InnoDB 가 아닌 엔진의 기존 테이블에는 ALTER TABLE·CREATE INDEX·DROP INDEX 를 할 수 없다 (DROP·RENAME TABLE 은 된다). ENGINE 옵션이 없는 테이블은 InnoDB(MySQL 8 기본)로 본다
export function assertInnoDbTable(t: Pick<Table, 'name' | 'options'>): void {
  const engine = t.options.find((o) => o.key === 'ENGINE')?.value;
  if (engine !== undefined && engine !== 'InnoDB') innodbOnly(`테이블 \`${t.name}\` 의 엔진은 ${engine} 입니다`);
}

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
    assertCommentLength('table', '', v); // 2048자 (리뷰 11회차 Claude F1)
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
