import { describe, it } from 'vitest';
import { checkCase, clauses, lines, TEST_TIMEOUT_MS, type Case } from './perf-cases';

// 문장 수·같은 테이블의 키와 컬럼 (perf-cases.ts)
const CASES: Case[] = [
  ['SET 문장만 많이 (문장 위치 → 줄 번호)', () => lines(() => 'SET @a = 1;'), { index: 0, errno: '' }],
  ['작은 ALTER 문장 많이', () => lines(() => "ALTER TABLE member COMMENT 'x';"), { ok: true }],
  ['같은 컬럼 ADD INDEX 문장 따로 — 키 64개 한도', () => lines(() => 'ALTER TABLE member ADD INDEX (email);'), { index: 62, errno: '1069' }],
  ['같은 컬럼 ADD INDEX 한 문장', () => clauses(() => 'ADD INDEX (email)', 'ALTER TABLE member '), { index: 1, errno: '1069' }],
  ['ADD INDEX·DROP INDEX 번갈아', () => lines((i) => (i % 2 ? 'ALTER TABLE member ADD INDEX ix (email);' : 'ALTER TABLE member DROP INDEX ix;')), { ok: true }],
  ['ADD COLUMN 문장 따로 — 컬럼 1017개 한도', () => lines((i) => `ALTER TABLE member ADD c${i} INT;`), { index: 1012, errno: '1117' }],
  ['ADD COLUMN 한 문장 (AFTER)', () => clauses((i) => `ADD c${i} INT AFTER id`, 'ALTER TABLE member '), { index: 1, errno: '1117' }],
  ['ADD·DROP COLUMN 번갈아', () => lines((i) => (i % 2 ? 'ALTER TABLE member ADD cx INT;' : 'ALTER TABLE member DROP cx;')), { ok: true }],
];

describe('applyScript — 1,000,000자 스크립트의 계산량: 문장·키·컬럼', () => {
  it.each(CASES)('%s', (_name, make, expected) => checkCase(make, expected), TEST_TIMEOUT_MS);
});
