import { describe, it } from 'vitest';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';
import { checkCase, lines, TEST_TIMEOUT_MS, type Case } from './perf-cases';

// 테이블 3,000개가 FK 로 참조하는 허브 테이블(member)이 있는 기준 (리뷰 1회차 M-1, perf-cases.ts). 문장마다 모든 테이블·FK 를 훑으면 1,000,000자 스크립트가
// 10 초를 넘었다 (참조 검사 checkTable, 지우는 컬럼 assertNoDependents, 자식 테이블 이름 변경의 자동 FK 이름 assertRenamedFkNamesFree, 타입 변경 assertRetypeAllowed).
// 허브 테이블을 바꾸는 문장은 3 초 안에 끝나야 한다 (실측 0.3~0.5 초). 자식 테이블을 지우고 만들거나 이름을 바꾸는 문장은 테이블 수천 개짜리 이름 표(Map)의 항목을
// 지웠다 넣기를 되풀이해 그만큼 더 들어 (실측 1.4~1.7 초, 병렬로 돌면 두 배) 다른 계산량 테스트와 같은 한도를 쓴다.
// 허브 테이블 자체의 RENAME TABLE 은 자식 FK 3,000개의 참조 테이블 이름을 문장마다 고쳐야 해서 자식 수에 비례한다 (MySQL 도 같다) — 여기서 재지 않는다
const CHILDREN = 3000;
const HUB_BOUND_MS = 3000;
const HUB = parseSqlDump(tdExport([
  "CREATE TABLE `member` (\n  `id` int unsigned NOT NULL AUTO_INCREMENT,\n  `name` varchar(50) DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;",
  ...Array.from({ length: CHILDREN }, (_, i) => `CREATE TABLE \`t${i}\` (\n  \`id\` int NOT NULL,\n  \`m\` int unsigned DEFAULT NULL,\n  PRIMARY KEY (\`id\`),\n  KEY \`m\` (\`m\`),\n`
    + `  CONSTRAINT \`t${i}_ibfk_1\` FOREIGN KEY (\`m\`) REFERENCES \`member\` (\`id\`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`),
].join('\n\n'))).model;
const HUB_CASES: Case[] = [
  ['허브 테이블에 작은 ALTER 많이', () => lines(() => "ALTER TABLE member COMMENT 'x';"), { ok: true }],
  ['허브 테이블 ADD·DROP COLUMN 번갈아', () => lines((i) => (i % 2 ? 'ALTER TABLE member ADD cx INT;' : 'ALTER TABLE member DROP cx;')), { ok: true }],
  ['허브 테이블 RENAME COLUMN 번갈아', () => lines((i) => (i % 2 ? 'ALTER TABLE member RENAME COLUMN name TO n2;' : 'ALTER TABLE member RENAME COLUMN n2 TO name;')), { ok: true }],
  ['허브 테이블 컬럼 타입 바꾸기 번갈아', () => lines((i) => `ALTER TABLE member MODIFY name VARCHAR(${i % 2 ? 60 : 50});`), { ok: true }],
];
const CHILD_CASES: Case[] = [
  ['자식 테이블 RENAME TABLE 번갈아 (자동 FK 이름이 바뀐다)', () => lines((i) => (i % 2 ? 'RENAME TABLE t1 TO u1;' : 'RENAME TABLE u1 TO t1;')), { ok: true }],
  ['자식 테이블 DROP·CREATE 번갈아', () => lines((i) => (i % 2 ? 'DROP TABLE t1;' : 'CREATE TABLE t1 (id INT, m INT UNSIGNED, FOREIGN KEY (m) REFERENCES member (id));')), { ok: true }],
];

describe('applyScript — 1,000,000자 스크립트의 계산량: FK 로 참조되는 허브 테이블', () => {
  it.each(HUB_CASES)('%s', (_name, make, expected) => checkCase(make, expected, HUB, HUB_BOUND_MS), TEST_TIMEOUT_MS);
  it.each(CHILD_CASES)('%s', (_name, make, expected) => checkCase(make, expected, HUB), TEST_TIMEOUT_MS);
});
