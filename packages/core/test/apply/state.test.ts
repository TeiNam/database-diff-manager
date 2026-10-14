import { describe, expect, it } from 'vitest';
import { cappedReason, forgetOrigins, initialState, moveOrigins, nameTaken, needTable, objectName, objectNameList, trackNew } from '../../src/apply/state';
import { ApplyFailure, DEFAULT_SQL_MODE, MYSQL_DEFAULTS, RE_EXPORT } from '../../src/apply/types';
import { Cursor } from '../../src/cursor';
import { tokenize } from '../../src/lexer';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

const table = (name: string, ...lines: string[]) =>
  `CREATE TABLE \`${name}\` (\n${lines.map((l) => `  ${l}`).join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;\n`;
const base = parseSqlDump(tdExport(
  table('a', '`id` int NOT NULL', '`name` varchar(10) DEFAULT NULL', 'PRIMARY KEY (`id`)', 'KEY `idx_name` (`name`)') + table('b', '`id` int NOT NULL'),
)).model;
const fresh = () => initialState(base, 'shop', MYSQL_DEFAULTS, DEFAULT_SQL_MODE);
const cursor = (src: string) => new Cursor(tokenize(src), src);
const entries = (m: ReadonlyMap<string, unknown> | undefined) => [...(m ?? [])];

describe('initialState·기준 이름 추적', () => {
  it('입력 모델은 복사해 쓰고, 기준 이름은 지금 이름 그대로 시작한다', () => {
    const st = fresh();
    expect(st.model).toEqual(base);
    st.model.tables[0].name = 'changed';
    expect(base.tables[0].name).toBe('a');
    expect(entries(st.origins.tables)).toEqual([['a', 'a'], ['b', 'b']]);
    expect(entries(st.origins.columns.get('a'))).toEqual([['id', 'id'], ['name', 'name']]);
    expect(entries(st.origins.indexes.get('a'))).toEqual([['PRIMARY', 'PRIMARY'], ['idx_name', 'idx_name']]);
  });

  it('테이블 이름을 바꾸면 컬럼·인덱스 기준 이름이 따라가고, 맞바꿔도 서로의 기준을 유지한다', () => {
    const st = fresh();
    moveOrigins(st.origins, 'a', 'a2');
    expect(entries(st.origins.tables)).toEqual([['b', 'b'], ['a2', 'a']]);
    expect(entries(st.origins.columns.get('a2'))).toEqual([['id', 'id'], ['name', 'name']]);
    expect(st.origins.columns.has('a')).toBe(false);
    moveOrigins(st.origins, 'b', 'a');
    moveOrigins(st.origins, 'a2', 'b');
    expect(entries(st.origins.tables)).toEqual([['a', 'b'], ['b', 'a']]);
    expect(entries(st.origins.indexes.get('b'))).toEqual([['PRIMARY', 'PRIMARY'], ['idx_name', 'idx_name']]);
  });

  it('새로 만든 테이블은 기준이 없고, 지운 테이블은 추적에서 빠진다', () => {
    const st = fresh();
    trackNew(st.origins, st.model.tables[0], false);
    expect(entries(st.origins.tables)).toEqual([['a', undefined], ['b', 'b']]);
    expect(entries(st.origins.columns.get('a'))).toEqual([['id', undefined], ['name', undefined]]);
    forgetOrigins(st.origins, 'a');
    expect(entries(st.origins.tables)).toEqual([['b', 'b']]);
    expect(st.origins.columns.has('a')).toBe(false);
    expect(st.origins.indexes.has('a')).toBe(false);
  });
});

describe('이름 찾기', () => {
  it('needTable 은 없는 테이블(1146)과 파싱하지 못한 정의를 거부하고, nameTaken 은 테이블·뷰 이름을 함께 본다', () => {
    const st = fresh();
    expect(needTable(st, 'a').name).toBe('a');
    expect(() => needTable(st, 'A')).toThrow(/1146/);
    st.model.views.push({ kind: 'view', name: 'v', body: 'select 1', fidelity: 'full' });
    expect(nameTaken(st, 'v')).toBe(true);
    expect(nameTaken(st, 'a')).toBe(true);
    expect(nameTaken(st, 'zzz')).toBe(false);
    st.model.tables[1].parseError = '읽지 못함';
    expect(() => needTable(st, 'b')).toThrow(`파싱하지 못한 정의라 바꿀 수 없습니다 — ${RE_EXPORT}`);
  });

  it('objectName·objectNameList 는 현재 스키마로 한정한 이름만 받고, 목록의 빈 항목은 1064', () => {
    const st = fresh();
    expect(objectName(cursor('t'), st)).toBe('t');
    expect(objectName(cursor('`shop`.`t`'), st)).toBe('t');
    expect(() => objectName(cursor('other.t'), st)).toThrow(ApplyFailure);
    expect(objectNameList(cursor('a, shop.b CASCADE'), st)).toEqual(['a', 'b']);
    expect(objectNameList(cursor('a RESTRICT'), st)).toEqual(['a']);
    expect(() => objectNameList(cursor('a,'), st)).toThrow(/1064/);
    expect(() => objectNameList(cursor('a RESTRICT CASCADE'), st)).toThrow(ApplyFailure);
    expect(() => objectNameList(cursor('other.t'), st)).toThrow(ApplyFailure);
  });
});

// 인덱스 출처(provenance): 이 실행이 아는 인덱스 출처 (auto·user). 기준 버전에는 없고, 테이블을 따라 옮겨지며 지우면 사라진다
describe('인덱스 출처 추적', () => {
  it('기준 버전은 아는 출처가 없고, 테이블 이름을 바꾸면 따라가며(맞바꿔도), 지우면 사라진다 — trackNew 는 건드리지 않는다', () => {
    const st = fresh();
    expect(st.origins.provenance.size).toBe(0);
    st.origins.provenance.set('a', new Map([['idx_name', 'auto']]));
    st.origins.provenance.set('b', new Map([['k', 'user']]));
    moveOrigins(st.origins, 'a', 'a2');
    expect(entries(st.origins.provenance.get('a2'))).toEqual([['idx_name', 'auto']]);
    expect(st.origins.provenance.has('a')).toBe(false);
    moveOrigins(st.origins, 'b', 'a');
    moveOrigins(st.origins, 'a2', 'b');
    expect(entries(st.origins.provenance.get('a'))).toEqual([['k', 'user']]);
    expect(entries(st.origins.provenance.get('b'))).toEqual([['idx_name', 'auto']]);
    trackNew(st.origins, st.model.tables[0], false); // CREATE TABLE 은 addKeys 가 적어 둔 출처를 지우지 않는다
    expect(entries(st.origins.provenance.get('a'))).toEqual([['k', 'user']]);
    forgetOrigins(st.origins, 'a');
    expect(st.origins.provenance.has('a')).toBe(false);
  });

  it('moveOrigins: 같은 이름으로 옮기면 출처도 그대로다', () => {
    const st = fresh();
    st.origins.provenance.set('a', new Map([['idx_name', 'user']]));
    moveOrigins(st.origins, 'a', 'a');
    expect(entries(st.origins.provenance.get('a'))).toEqual([['idx_name', 'user']]);
  });
});

describe('보완', () => {
  it('moveOrigins: 같은 이름으로 옮기면 아무것도 바뀌지 않는다', () => {
    const st = fresh();
    moveOrigins(st.origins, 'a', 'a');
    expect(entries(st.origins.tables)).toEqual([['a', 'a'], ['b', 'b']]);
    expect(entries(st.origins.columns.get('a'))).toEqual([['id', 'id'], ['name', 'name']]);
    expect(entries(st.origins.indexes.get('a'))).toEqual([['PRIMARY', 'PRIMARY'], ['idx_name', 'idx_name']]);
  });

  // MySQL 8.0.46 실측: DROP TABLE a RESTRICT, b · DROP TABLE a CASCADE, b CASCADE · DROP VIEW a RESTRICT, b 는 1064
  it('objectNameList: RESTRICT·CASCADE 는 마지막 이름 뒤에만 쓸 수 있다', () => {
    const st = fresh();
    expect(objectNameList(cursor('a, b RESTRICT'), st)).toEqual(['a', 'b']);
    expect(objectNameList(cursor('a, b CASCADE'), st)).toEqual(['a', 'b']);
    for (const src of ['a RESTRICT, b', 'a CASCADE, b CASCADE', 'a RESTRICT, b RESTRICT']) {
      expect(() => objectNameList(cursor(src), st), src).toThrow(/\(MySQL 1064\)/);
    }
  });
});

// 리뷰 11회차 Claude F7: 모르는 값의 까닭 글은 500자를 넘으면 가운데를 줄인다 (앞 200자와 끝을 남긴다). 4바이트 글자(대리 쌍)는 가르지 않는다
describe('cappedReason', () => {
  const EMOJI = '\u{1F600}';
  const lonePair = (text: string) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);

  it('500자까지는 그대로 두고, 넘으면 앞 200자와 끝을 남겨 500자 안으로 줄인다', () => {
    expect(cappedReason('a'.repeat(500))).toBe('a'.repeat(500));
    const capped = cappedReason(`${'a'.repeat(300)}${'b'.repeat(400)}`);
    expect(capped).toBe(`${'a'.repeat(200)} … ${'b'.repeat(297)}`);
  });

  it('잘리는 자리의 대리 쌍은 통째로 빼고 길이는 500자를 넘지 않는다', () => {
    for (const text of [`${'a'.repeat(199)}${EMOJI}${'b'.repeat(600)}`, `${'x'.repeat(600)}${EMOJI}${'y'.repeat(296)}`]) {
      const capped = cappedReason(text);
      expect(capped.length).toBeLessThanOrEqual(500);
      expect(lonePair(capped), capped.slice(195, 210)).toBe(false);
    }
  });
});
