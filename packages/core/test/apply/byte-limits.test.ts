import { describe, expect, it } from 'vitest';
import { applyScript } from '../../src/apply';
import { RE_EXPORT } from '../../src/apply/types';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

// 바이트 한도 (리뷰 3회차 I-1, MySQL 8.0.46·8.4.11 실측): 키 파트 하나는 3072 바이트 (ROW_FORMAT=COMPACT·REDUNDANT 는 767, 쓰지 않으면 innodb_default_row_format=DYNAMIC),
// VARCHAR·VARBINARY 는 65535 바이트. 엄격 SQL_MODE 는 넘으면 1071·1074 로 거부하지만, 엄격하지 않은 세션은 일반 인덱스의 키 파트를 한도까지의 prefix 로 줄이고
// (VARCHAR(769) utf8mb4 의 KEY (c) → KEY (c(768)), COMPACT 의 VARCHAR(192) → c(191)) 긴 VARCHAR 를 TEXT·BLOB 계열로 바꾼다 (VARCHAR(16384) utf8mb4 → mediumtext).
// 쓴 그대로 저장하면 틀린 모델이 되므로 SQL_MODE 와 상관없이 RE_EXPORT 로 거부한다
const base = parseSqlDump(tdExport([
  "CREATE TABLE `member` (\n  `id` int NOT NULL,\n  `title` varchar(255) DEFAULT NULL,\n  `memo` text,\n  PRIMARY KEY (`id`),\n  KEY `ix_title` (`title`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;",
  "CREATE TABLE `legacy` (\n  `id` int NOT NULL,\n  `title` varchar(255) DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=COMPACT;",
  "CREATE TABLE `old` (\n  `id` int NOT NULL,\n  `title` varchar(255) DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=REDUNDANT;",
  "CREATE TABLE `l1` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=latin1;",
].join('\n\n'))).model;
const run = (script: string) => applyScript(base, script, { schemaName: 'shop' });
const reasonOf = (script: string): string => {
  const r = run(script);
  return r.ok ? 'ok' : `${r.error.index}: ${r.error.reason}`;
};
const KEY_PART = /^\d+: .*3072 바이트.*1071.*td-export 로 다시 뽑아 올려 주세요$/;
const ANTELOPE_KEY_PART = /^\d+: .*767 바이트.*1071.*td-export 로 다시 뽑아 올려 주세요$/;
const VARCHAR = /^\d+: .*65535 바이트.*1074.*td-export 로 다시 뽑아 올려 주세요$/;

describe('키 파트 바이트 한도 (3072, COMPACT·REDUNDANT 는 767)', () => {
  it('엄격하지 않은 SQL_MODE 뒤에서도 3072 바이트를 넘는 키 파트는 RE_EXPORT 로 거부한다 (MySQL 은 prefix 로 줄여 받는다)', () => {
    const r = run("SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';\nALTER TABLE member ADD url VARCHAR(1000), ADD INDEX ix_url (url);");
    expect(r).toMatchObject({ ok: false, error: { index: 2 } });
    if (!r.ok) expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
    expect(reasonOf('ALTER TABLE member ADD url VARCHAR(1000), ADD INDEX ix_url (url);')).toMatch(KEY_PART);
  });

  it.each([
    ['utf8mb4 VARCHAR(768) 전체', 'ALTER TABLE member ADD c VARCHAR(768), ADD KEY ix_c (c);', 'ok'],
    ['utf8mb4 VARCHAR(769) 전체', 'ALTER TABLE member ADD c VARCHAR(769), ADD KEY ix_c (c);', KEY_PART],
    ['TEXT prefix 768자', 'ALTER TABLE member ADD KEY ix_memo (memo(768));', 'ok'],
    ['TEXT prefix 769자', 'ALTER TABLE member ADD KEY ix_memo (memo(769));', KEY_PART],
    ['긴 VARCHAR 의 prefix 768자', 'ALTER TABLE member ADD c VARCHAR(1000), ADD KEY ix_c (c(768));', 'ok'],
    ['BLOB prefix 3072', 'ALTER TABLE member ADD b BLOB, ADD KEY ix_b (b(3072));', 'ok'],
    ['BLOB prefix 3073', 'ALTER TABLE member ADD b BLOB, ADD KEY ix_b (b(3073));', KEY_PART],
    ['VARBINARY(3073) 전체', 'ALTER TABLE member ADD b VARBINARY(3073), ADD KEY ix_b (b);', KEY_PART],
    ['latin1 VARCHAR(3072)', 'ALTER TABLE l1 ADD c VARCHAR(3072), ADD KEY ix_c (c);', 'ok'],
    ['latin1 VARCHAR(3073)', 'ALTER TABLE l1 ADD c VARCHAR(3073), ADD KEY ix_c (c);', KEY_PART],
    ['latin1 테이블의 utf8mb4 컬럼', 'ALTER TABLE l1 ADD c VARCHAR(1000) CHARACTER SET utf8mb4, ADD KEY ix_c (c);', KEY_PART],
    ['utf8mb3 VARCHAR(1024)', 'CREATE TABLE u3 (id INT PRIMARY KEY, c VARCHAR(1024), KEY ix (c)) DEFAULT CHARSET=utf8mb3;', 'ok'],
    ['utf8mb3 VARCHAR(1025)', 'CREATE TABLE u3 (id INT PRIMARY KEY, c VARCHAR(1025), KEY ix (c)) DEFAULT CHARSET=utf8mb3;', KEY_PART],
    ['UNIQUE', 'ALTER TABLE member ADD c VARCHAR(769), ADD UNIQUE KEY uq_c (c);', KEY_PART],
    ['PRIMARY KEY', 'CREATE TABLE p (c VARCHAR(769) PRIMARY KEY);', KEY_PART],
    ['CREATE INDEX', 'ALTER TABLE member ADD c VARCHAR(769);\nCREATE INDEX ix_c ON member (c);', KEY_PART],
    ['FULLTEXT 는 보지 않는다', 'ALTER TABLE member ADD c VARCHAR(5000), ADD FULLTEXT KEY ft_c (c);', 'ok'],
    ['키 파트 합계(3072 초과)는 보지 않는다 — MySQL 은 엄격하지 않아도 1071 로 거부한다', 'ALTER TABLE member ADD a VARCHAR(500), ADD b VARCHAR(500), ADD KEY ix_ab (a, b);', 'ok'],
  ])('%s', (_name, script, expected) => {
    if (expected === 'ok') expect(reasonOf(script)).toBe('ok');
    else expect(reasonOf(script)).toMatch(expected);
  });

  it.each([
    ['COMPACT 테이블의 VARCHAR(191)', 'ALTER TABLE legacy MODIFY title VARCHAR(191), ADD KEY ix_t (title);', 'ok'],
    ['COMPACT 테이블의 VARCHAR(255)', 'ALTER TABLE legacy ADD INDEX ix_title (title);', ANTELOPE_KEY_PART],
    ['REDUNDANT 테이블의 VARCHAR(192)', 'ALTER TABLE old MODIFY title VARCHAR(192), ADD KEY ix_t (title);', ANTELOPE_KEY_PART],
    ['같은 문장에서 ROW_FORMAT=COMPACT 로 바꾸며 더한 키', 'ALTER TABLE member ADD c VARCHAR(255), ROW_FORMAT=COMPACT, ADD KEY ix_c (c);', ANTELOPE_KEY_PART],
    ['같은 문장에서 ROW_FORMAT=DYNAMIC 으로 바꾸며 더한 키', 'ALTER TABLE legacy ROW_FORMAT=DYNAMIC, ADD INDEX ix_title (title);', 'ok'],
    ['ROW_FORMAT=COMPACT 로만 바꿔도 있던 키가 767 을 넘으면', 'ALTER TABLE member ROW_FORMAT=COMPACT;', ANTELOPE_KEY_PART],
    ['ROW_FORMAT=DEFAULT 는 DYNAMIC', 'ALTER TABLE legacy ROW_FORMAT=DEFAULT, ADD INDEX ix_title (title);', 'ok'],
    ['CREATE TABLE … ROW_FORMAT=COMPACT', 'CREATE TABLE c1 (id INT PRIMARY KEY, c VARCHAR(192), KEY ix (c)) ROW_FORMAT=COMPACT;', ANTELOPE_KEY_PART],
    ['CREATE TABLE … ROW_FORMAT=COMPRESSED 는 3072', 'CREATE TABLE c1 (id INT PRIMARY KEY, c VARCHAR(768), KEY ix (c)) ROW_FORMAT=COMPRESSED;', 'ok'],
  ])('%s', (_name, script, expected) => {
    if (expected === 'ok') expect(reasonOf(script)).toBe('ok');
    else expect(reasonOf(script)).toMatch(expected);
  });

  it('MODIFY·CHANGE 로 키에 든 컬럼을 늘려 3072 바이트를 넘으면 거부한다 (MySQL 은 엄격하지 않으면 prefix 로 줄인다)', () => {
    expect(reasonOf('ALTER TABLE member MODIFY title VARCHAR(1000);')).toMatch(KEY_PART);
    expect(reasonOf('ALTER TABLE member CHANGE title subject VARCHAR(1000);')).toMatch(KEY_PART);
    expect(reasonOf('ALTER TABLE member MODIFY title VARCHAR(768);')).toBe('ok');
  });
});

describe('VARCHAR·VARBINARY 바이트 한도 (65535)', () => {
  it('엄격하지 않은 SQL_MODE 뒤에서도 65535 바이트를 넘는 VARCHAR 는 RE_EXPORT 로 거부한다 (MySQL 은 TEXT 계열로 바꿔 받는다)', () => {
    const r = run("SET SQL_MODE = '';\nCREATE TABLE big (id INT PRIMARY KEY, body VARCHAR(30000)) DEFAULT CHARSET=utf8mb4;");
    expect(r).toMatchObject({ ok: false, error: { index: 2 } });
    if (!r.ok) expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
  });

  it.each([
    ['utf8mb4 VARCHAR(16383)', 'CREATE TABLE big (c VARCHAR(16383));', 'ok'],
    ['utf8mb4 VARCHAR(16384)', 'CREATE TABLE big (c VARCHAR(16384));', VARCHAR],
    ['latin1 VARCHAR(65535) — 행 크기(1118)는 보지 않는다', 'CREATE TABLE big (c VARCHAR(65535)) DEFAULT CHARSET=latin1;', 'ok'],
    ['latin1 VARCHAR(65536)', 'CREATE TABLE big (c VARCHAR(65536)) DEFAULT CHARSET=latin1;', VARCHAR],
    ['VARBINARY(65536)', 'ALTER TABLE member ADD b VARBINARY(65536);', VARCHAR],
    ['ADD', 'ALTER TABLE member ADD c VARCHAR(20000);', VARCHAR],
    ['MODIFY', 'ALTER TABLE member MODIFY memo VARCHAR(20000);', VARCHAR],
    ['CHANGE', 'ALTER TABLE member CHANGE memo body VARCHAR(20000);', VARCHAR],
    ['latin1 테이블은 20000 바이트', 'ALTER TABLE l1 ADD c VARCHAR(20000);', 'ok'],
    ['latin1 테이블의 utf8mb4 컬럼', 'ALTER TABLE l1 ADD c VARCHAR(20000) CHARACTER SET utf8mb4;', VARCHAR],
  ])('%s', (_name, script, expected) => {
    if (expected === 'ok') expect(reasonOf(script)).toBe('ok');
    else expect(reasonOf(script)).toMatch(expected);
  });
});
