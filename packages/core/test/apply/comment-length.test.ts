import { describe, expect, it } from 'vitest';
import { applyScript, type ApplyResult } from '../../src/apply';
import { RE_EXPORT } from '../../src/apply/types';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

// 리뷰 11회차 Claude F1 (8.0.46·8.4.11 실측): MySQL 은 컬럼·인덱스(PRIMARY KEY 포함) COMMENT 를 1024자, 테이블 COMMENT 를 2048자까지 받는다 — 글자 수다 (한글 1024자도 받는다).
// 엄격 SQL_MODE(STRICT_TRANS_TABLES·STRICT_ALL_TABLES)는 넘으면 1629·1688·1628 로 거부하고, 엄격하지 않은 세션은 경고만 남기고 한도까지 잘라 저장한다 (CREATE·ALTER TABLE,
// CREATE INDEX 모두). 잘린 값은 재현하지 않는다: 엄격한 세션이면 MySQL 오류 번호로, 엄격하지 않거나 세션 SQL_MODE 를 모르면 RE_EXPORT 로 거부한다
const base = parseSqlDump(tdExport('CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `v` int DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;')).model;
const run = (script: string): ApplyResult => applyScript(base, script, { schemaName: 'shop' });
const x = (n: number, ch = 'x'): string => ch.repeat(n);
const NON_STRICT = "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';";

// [문장(COMMENT 길이 n), 한도, MySQL 오류 번호, 안내의 주어]
const CASES: [string, (n: number) => string, number, number, string][] = [
  ['ADD COLUMN', (n) => `ALTER TABLE t ADD c INT COMMENT '${x(n)}';`, 1024, 1629, '컬럼 `c` 의 COMMENT'],
  ['MODIFY', (n) => `ALTER TABLE t MODIFY v INT COMMENT '${x(n)}';`, 1024, 1629, '컬럼 `v` 의 COMMENT'],
  ['CHANGE', (n) => `ALTER TABLE t CHANGE v w INT COMMENT '${x(n)}';`, 1024, 1629, '컬럼 `w` 의 COMMENT'],
  ['CREATE TABLE 컬럼', (n) => `CREATE TABLE u (id INT PRIMARY KEY COMMENT '${x(n)}');`, 1024, 1629, '컬럼 `id` 의 COMMENT'],
  ['ADD INDEX', (n) => `ALTER TABLE t ADD INDEX k (v) COMMENT '${x(n)}';`, 1024, 1688, '인덱스 `k` 의 COMMENT'],
  ['CREATE INDEX', (n) => `CREATE INDEX k ON t (v) COMMENT '${x(n)}';`, 1024, 1688, '인덱스 `k` 의 COMMENT'],
  ['CREATE TABLE 의 PRIMARY KEY', (n) => `CREATE TABLE u (id INT, PRIMARY KEY (id) COMMENT '${x(n)}');`, 1024, 1688, '인덱스 `PRIMARY` 의 COMMENT'],
  ['이름 없는 키', (n) => `ALTER TABLE t ADD UNIQUE (v) COMMENT '${x(n)}';`, 1024, 1688, '인덱스의 COMMENT'],
  ['ALTER TABLE COMMENT', (n) => `ALTER TABLE t COMMENT '${x(n)}';`, 2048, 1628, '테이블 COMMENT'],
  ['ALTER TABLE COMMENT =', (n) => `ALTER TABLE t COMMENT = '${x(n)}';`, 2048, 1628, '테이블 COMMENT'],
  ['CREATE TABLE 옵션', (n) => `CREATE TABLE u (id INT PRIMARY KEY) COMMENT='${x(n)}';`, 2048, 1628, '테이블 COMMENT'],
];

describe('한도를 넘는 COMMENT', () => {
  it.each(CASES)('%s: 한도까지는 받고, 넘으면 엄격한 세션에서 MySQL 오류 번호로 거부한다', (_name, sql, limit, errno, subject) => {
    expect(run(sql(limit))).toMatchObject({ ok: true, applied: 1 });
    for (const mode of ['', "SET SQL_MODE = 'STRICT_ALL_TABLES';\n"]) {
      const r = run(`${mode}${sql(limit + 1)}`);
      expect(r).toMatchObject({ ok: false, error: { index: mode ? 2 : 1, reason: `${subject} 가 ${limit}자를 넘습니다 (MySQL ${errno})` } });
    }
  });

  it.each(CASES)('%s: 엄격하지 않은 세션은 MySQL 이 잘라 저장하므로 RE_EXPORT 로 거부한다', (_name, sql, limit, errno, subject) => {
    const r = run(`${NON_STRICT}\n${sql(limit + 1)}`);
    expect(r).toMatchObject({ ok: false, error: { index: 2 } });
    if (r.ok) return;
    expect(r.error.reason).toContain(`${subject} 가 ${limit}자를 넘습니다`);
    expect(r.error.reason).toContain(`${limit}자로 잘라 저장`);
    expect(r.error.reason).not.toContain(`(MySQL ${errno})`);
    expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
  });

  it('세션 SQL_MODE 를 모르면 RE_EXPORT 로 거부하고 그 까닭을 밝힌다', () => {
    const r = run(`SET SQL_MODE = @never_saved;\nALTER TABLE t ADD c INT COMMENT '${x(1025)}';`);
    expect(r).toMatchObject({ ok: false, error: { index: 2, reason: expect.stringContaining('세션 SQL_MODE 를 알 수 없습니다') } });
    expect(!r.ok && r.error.reason).toContain('값을 저장하지 않은 변수입니다: @never_saved');
    expect(!r.ok && r.error.reason.endsWith(RE_EXPORT)).toBe(true);
  });

  it('한도는 글자 수다: 한글 1024자(3072바이트) 컬럼·인덱스 COMMENT 와 2048자 테이블 COMMENT 는 받는다', () => {
    const r = run(`ALTER TABLE t ADD c INT COMMENT '${x(1024, '가')}', ADD INDEX k (v) COMMENT '${x(1024, '가')}', COMMENT '${x(2048, '가')}';`);
    expect(r).toMatchObject({ ok: true, applied: 1 });
    expect(run(`ALTER TABLE t ADD c INT COMMENT '${x(1025, '가')}';`)).toMatchObject({ ok: false, error: { reason: expect.stringContaining('(MySQL 1629)') } });
  });

  it('이미 있는 테이블의 CREATE TABLE IF NOT EXISTS 는 정의를 읽지 않는다 (MySQL 은 note 1050 만 남긴다)', () => {
    expect(run(`CREATE TABLE IF NOT EXISTS t (id INT PRIMARY KEY COMMENT '${x(1025)}');\nALTER TABLE t ADD c INT;`)).toMatchObject({ ok: true, applied: 2 });
  });
});
