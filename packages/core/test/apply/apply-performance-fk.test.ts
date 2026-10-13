import { describe, it } from 'vitest';
import { checkCase, clauses, FK_64, FK_HEAD, lines, RE_EXPORT_ERRNO, TEST_TIMEOUT_MS, type Case } from './perf-cases';

// 같은 테이블의 FK (perf-cases.ts). 테이블당 FK 64개 한도: 65번째 FK 를 더하는 문장에서 멈춘다 (FK_HEAD 의 두 문장 뒤 65번째)
const FK_TABLE = (n: number) => `CREATE TABLE p (id INT PRIMARY KEY);\nCREATE TABLE c (x INT, ${FK_64.slice(64 - n).join(', ')});\n`;
const CASES: Case[] = [
  ['같은 테이블 FK 문장 따로 — FK 64개 한도', () => lines(() => 'ALTER TABLE c ADD FOREIGN KEY (x) REFERENCES p (id);', `${FK_HEAD}\n`), { index: 67, errno: RE_EXPORT_ERRNO }],
  ['같은 테이블 FK 문장 따로 (자동 인덱스)', () => lines((i) => `ALTER TABLE c ADD CONSTRAINT f${i} FOREIGN KEY (y) REFERENCES p (id);`, `${FK_HEAD}\n`), { index: 67, errno: RE_EXPORT_ERRNO }],
  ['같은 테이블 FK 한 문장', () => clauses(() => 'ADD FOREIGN KEY (y) REFERENCES p (id)', `${FK_HEAD}\nALTER TABLE c `), { index: 3, errno: RE_EXPORT_ERRNO }],
  ['FK 64개 테이블에 작은 문장 많이', () => lines(() => "ALTER TABLE c COMMENT 'x';", FK_TABLE(64)), { ok: true }],
  ['FK 63개 테이블에 FK 더하고 지우기', () => lines((i) => (i % 2 ? 'ALTER TABLE c ADD CONSTRAINT fx FOREIGN KEY (x) REFERENCES p (id);' : 'ALTER TABLE c DROP FOREIGN KEY fx;'), FK_TABLE(63)), { ok: true }],
];

describe('applyScript — 1,000,000자 스크립트의 계산량: FK', () => {
  it.each(CASES)('%s', (_name, make, expected) => checkCase(make, expected), TEST_TIMEOUT_MS);
});
