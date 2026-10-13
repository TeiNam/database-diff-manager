import { describe, it } from 'vitest';
import { checkCase, lines, TEST_TIMEOUT_MS, type Case } from './perf-cases';

// 테이블·루틴이 많은 스키마 — 만들기 (perf-cases.ts)
const CASES: Case[] = [
  ['CREATE FUNCTION 많이', () => lines((i) => `CREATE FUNCTION f${i}() RETURNS INT DETERMINISTIC RETURN 1;`), { ok: true }],
  ['CREATE TABLE 많이', () => lines((i) => `CREATE TABLE t${i} (id INT PRIMARY KEY);`), { ok: true }],
  ['CREATE TABLE 과 ALTER TABLE 번갈아', () => lines((i) => (i % 2 ? `CREATE TABLE t${i} (id INT PRIMARY KEY);` : `ALTER TABLE t${i - 1} ADD c INT, ADD INDEX (c);`)), { ok: true }],
  ['FK 로 부모를 참조하는 CREATE TABLE 많이', () => lines((i) => `CREATE TABLE k${i} (id INT, m INT UNSIGNED, FOREIGN KEY (m) REFERENCES member (id));`), { ok: true }],
];

describe('applyScript — 1,000,000자 스크립트의 계산량: 객체가 많은 스키마 — 만들기', () => {
  it.each(CASES)('%s', (_name, make, expected) => checkCase(make, expected), TEST_TIMEOUT_MS);
});
