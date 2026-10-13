import { describe, it } from 'vitest';
import { checkCase, fill, MAX_SCRIPT, RE_EXPORT_ERRNO, tableNames, TEST_TIMEOUT_MS, type Case } from './perf-cases';

// 테이블이 많은 스키마 — 한 문장의 키·FK·이름 목록 (perf-cases.ts)
const CASES: Case[] = [
  ['CREATE TABLE 안의 키 많이', () => fill(() => 'KEY (a)', ', ', 'CREATE TABLE big (a INT, ', ');'), { index: 1, errno: '1069' }],
  ['CREATE TABLE 안의 FK 많이', () => fill(() => 'FOREIGN KEY (a) REFERENCES member (id)', ', ', 'CREATE TABLE big (a INT UNSIGNED, ', ');'), { index: 1, errno: RE_EXPORT_ERRNO }],
  ['CREATE TABLE 많이 + RENAME TABLE 한 문장', () => {
    const names = tableNames(Math.floor(MAX_SCRIPT / 52));
    return `${names.map((n) => `CREATE TABLE ${n} (id INT);`).join('\n')}\nRENAME TABLE ${names.map((n) => `${n} TO b${n}`).join(', ')};`;
  }, { ok: true }],
  ['CREATE TABLE 많이 + DROP TABLE 한 문장', () => {
    const names = tableNames(Math.floor(MAX_SCRIPT / 40));
    return `${names.map((n) => `CREATE TABLE ${n} (id INT);`).join('\n')}\nDROP TABLE ${names.join(', ')};`;
  }, { ok: true }],
];

describe('applyScript — 1,000,000자 스크립트의 계산량: 객체가 많은 스키마 — 한 문장', () => {
  it.each(CASES)('%s', (_name, make, expected) => checkCase(make, expected), TEST_TIMEOUT_MS);
});
