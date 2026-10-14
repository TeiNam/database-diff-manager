import { describe, expect, it } from 'vitest';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';
import { checkCase, clauses, fill, lines, MAX_SCRIPT, RE_EXPORT_ERRNO, TEST_TIMEOUT_MS, type Case } from './perf-cases';

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

// 키·컬럼이 한도까지 많은 테이블 (리뷰 4회차 M-2): 컬럼 1017개(1117 한도)와 키 64개(1069 한도) — PRIMARY 와 16 파트(1070 한도) 일반 키 63개. MySQL 8.4 가 만드는 모양이다.
// 작은 ALTER 도 문장 끝에 키를 MySQL 순서로 다시 정렬하는데, 키 파트마다 컬럼 목록을 훑던 때는 문장 하나에 이름 비교가 100만 번 들어 1,000,000자 스크립트가 4분 걸렸다.
// 키 파트 바이트 검사는 키·키에 든 컬럼의 정의·ROW_FORMAT 을 건드린 문장만 하고, 컬럼 절이 없는 문장은 컬럼 목록을 다시 훑지 않는다 (실측 1~2 초).
// 컬럼 정의를 바꾸는 문장(MODIFY·ADD·DROP COLUMN)은 컬럼 목록을 새로 만들어 문장마다 컬럼 수에 비례한다 — 여기서 재지 않는다
const WIDE_COLUMNS = 1016; // id 와 함께 1017개
const WIDE_KEYS = 63; // PRIMARY 와 함께 64개
const KEY_PARTS = 16;
const wideKey = (k: number) => Array.from({ length: KEY_PARTS }, (_, j) => `\`c${k * KEY_PARTS + j}\``).join(',');
const WIDE_BODY = [
  '  `id` int NOT NULL',
  ...Array.from({ length: WIDE_COLUMNS }, (_, i) => `  \`c${i}\` varchar(5) DEFAULT NULL`),
  '  PRIMARY KEY (`id`)',
  ...Array.from({ length: WIDE_KEYS }, (_, k) => `  KEY \`k${k}\` (${wideKey(k)})`),
].join(',\n');
const WIDE = parseSqlDump(tdExport(`CREATE TABLE \`w\` (\n${WIDE_BODY}\n) ENGINE=InnoDB DEFAULT CHARSET=latin1;`)).model;
const WIDE_CASES: Case[] = [
  ['작은 ALTER 문장 많이', () => lines(() => "ALTER TABLE w COMMENT 'x';"), { ok: true }],
  ['키에 든 컬럼의 기본값 바꾸기 번갈아', () => lines((i) => `ALTER TABLE w ALTER COLUMN c1 SET DEFAULT '${i % 2}';`), { ok: true }],
  ['RENAME INDEX 번갈아', () => lines((i) => (i % 2 ? 'ALTER TABLE w RENAME INDEX k0 TO kx;' : 'ALTER TABLE w RENAME INDEX kx TO k0;')), { ok: true }],
];

describe('applyScript — 1,000,000자 스크립트의 계산량: 키·컬럼이 한도까지 많은 테이블', () => {
  it('기준 테이블은 컬럼 1017개, 키 64개 × 16 파트다', () => {
    expect(WIDE.tables[0].columns).toHaveLength(WIDE_COLUMNS + 1);
    expect(WIDE.tables[0].indexes.map((i) => i.parts.length)).toEqual([1, ...Array.from({ length: WIDE_KEYS }, () => KEY_PARTS)]);
  });
  it.each(WIDE_CASES)('%s', (_name, make, expected) => checkCase(make, expected, WIDE), TEST_TIMEOUT_MS);
});

// 건너뛰는 실행 주석·NBSP 가 많은 문장 하나 (리뷰 12회차 Claude F2): 건너뛰는 주석마다 문장 전체를 다시 잇던 blank 와 NBSP 마다 건너뛰는 주석을 모두 훑던 공백 검사가 제곱
// 시간이라, 1,000,000자 문장 하나가 4~28 초였다. 두 배열은 원문 자리 순서라 한 번에 훑고 조각은 한 번에 잇는다. 여기서는 3 초 안을 본다
const SKIPPED_BOUND_MS = 3000;
const SKIPPED_COMMENTS = 50_000;
const NBSP = '\u00a0';
const SKIPPED_CASES: Case[] = [
  ['건너뛰는 실행 주석이 가득한 문장', () => fill(() => '/*!99999*/', '', 'ALTER TABLE member ADD a INT ', ';'), { ok: true }],
  ['건너뛰는 실행 주석 50,000개 뒤에 NBSP 가 가득한 건너뛰는 주석', () => {
    const head = `ALTER TABLE member ADD a INT ${'/*!99999*/'.repeat(SKIPPED_COMMENTS)}/*!99999 `;
    return `${head}${NBSP.repeat(MAX_SCRIPT - head.length - '*/;'.length)}*/;`;
  }, { ok: true }],
];

describe('applyScript — 1,000,000자 스크립트의 계산량: 건너뛰는 실행 주석과 NBSP', () => {
  it.each(SKIPPED_CASES)('%s', (_name, make, expected) => checkCase(make, expected, undefined, SKIPPED_BOUND_MS), TEST_TIMEOUT_MS);
});

// 마지막 문장 뒤와 문장 없는 덩어리의 실행 주석 표지 (리뷰 13회차 F1·R13-1): 마지막 문장 뒤의 검사가 표지마다 번호를 보기 전에 첫 '*/' 를 원문 끝까지 찾고 그 글을 다시 훑어
// 제곱 시간이라, 닫지 않은 표지가 가득한 1,000,000자 스크립트 하나가 43~50 초였다. 번호를 먼저 보고 표지마다 첫 '*/' 까지만 훑는다 — 받은 주석 안에는 '/*' 가 없어 다음
// 표지는 그 뒤에 있다. 여기서는 3 초 안을 본다
const AFTER_DDL = 'ALTER TABLE member ADD a INT;\n';
const TRAILING_CASES: Case[] = [
  ['번호 없는 표지 (Claude 재현)', () => fill(() => '/*!', '', AFTER_DDL), { ok: true }],
  ['어느 판이든 실행하는 표지', () => fill(() => '/*!40101 ', '', AFTER_DDL), { ok: true }],
  ['8.0·8.4 가 모두 건너뛰는 표지 (Claude 재현)', () => fill(() => '/*!99999 ', '', AFTER_DDL), { index: 0, errno: RE_EXPORT_ERRNO }],
  ['판에 따라 건너뛰는 표지', () => fill(() => '/*!80400 ', '', AFTER_DDL), { index: 0, errno: RE_EXPORT_ERRNO }],
  ['닫는 */ 하나 앞의 표지 (Codex 재현)', () => fill(() => '/*!99999 ', '', AFTER_DDL, '*/'), { index: 0, errno: RE_EXPORT_ERRNO }],
  ['닫은 건너뛰는 주석', () => fill(() => '/*!99999 */', '', AFTER_DDL), { ok: true }],
  ['줄 주석이 앞 줄에서 끝나는 판에 따라 갈리는 주석', () => fill(() => '/*!80400 -- x\n*/', '', AFTER_DDL), { ok: true }],
  ['문장 없는 덩어리의 판에 따라 갈리는 주석', () => fill(() => '/*!80400 -- x\n*/;', '', '', `\n${AFTER_DDL}`), { ok: true }],
];

describe('applyScript — 1,000,000자 스크립트의 계산량: 마지막 문장 뒤와 문장 없는 덩어리의 실행 주석', () => {
  it.each(TRAILING_CASES)('%s', (_name, make, expected) => checkCase(make, expected, undefined, SKIPPED_BOUND_MS), TEST_TIMEOUT_MS);
});

// DELIMITER 줄 앞의 클라이언트 버퍼 (리뷰 15회차 F1·F2): 줄마다 앞 경계 뒤부터 그 줄 앞까지만 훑어 원문 길이에 비례한다. 여기서는 3 초 안을 본다
const COMMAND_CASES: Case[] = [
  ['DELIMITER 줄마다 앞에 블록 주석', () => fill(() => '/* 메모 */\nDELIMITER ;;', '\n', '', '\nALTER TABLE member ADD a INT;;'), { ok: true }],
  ['DELIMITER 줄 하나 앞에 블록 주석이 가득', () => fill(() => '/* 메모 */', ' ', 'ALTER TABLE member ADD a INT;\n', '\nDELIMITER ;;\nALTER TABLE member ADD b INT;;'), { ok: true }],
];

describe('applyScript — 1,000,000자 스크립트의 계산량: DELIMITER 줄 앞의 클라이언트 버퍼', () => {
  it.each(COMMAND_CASES)('%s', (_name, make, expected) => checkCase(make, expected, undefined, SKIPPED_BOUND_MS), TEST_TIMEOUT_MS);
});
