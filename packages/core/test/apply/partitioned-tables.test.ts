import { describe, expect, it } from 'vitest';
import { applyScript } from '../../src/apply';
import type { SchemaModel } from '../../src/model';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

// 파티션 절은 1차 범위 밖이라 만들거나 바꾸지 않지만, 파티션된 기준 테이블(td-export 덤프에 있다)에 다른 ALTER 를 적용할 수는 있다.
// MySQL 8.0.46·8.4.11 실측: 파티션 식이 쓰는 컬럼은 지우거나 이름을 바꿀 수 없고 (3855), 모든 PRIMARY KEY·UNIQUE 는 그 컬럼을 (prefix 없이) 모두 포함해야 한다 (1503)
const LOGS = [
  'CREATE TABLE `logs` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `created` date NOT NULL,\n  `msg` varchar(100) DEFAULT NULL,\n  `region` varchar(10) NOT NULL,\n  PRIMARY KEY (`id`,`created`),\n  KEY `ix_msg` (`msg`)',
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci\n/*!50100 PARTITION BY RANGE (year(`created`))\n(PARTITION p2023 VALUES LESS THAN (2024) ENGINE = InnoDB,\n PARTITION pmax VALUES LESS THAN MAXVALUE ENGINE = InnoDB) */;',
];
// RANGE COLUMNS·LIST COLUMNS·KEY 의 컬럼 목록은 SHOW CREATE 가 백틱 없이 찍는다 (필요할 때만 백틱 — 8.0.46·8.4.11 실측). HASH·RANGE·LIST 의 식은 컬럼을 백틱으로 찍는다
const COLUMNS = [
  'CREATE TABLE `cols` (\n  `id` bigint NOT NULL,\n  `created` date NOT NULL,\n  `my col` varchar(10) NOT NULL,\n  `msg` varchar(100) DEFAULT NULL,\n  PRIMARY KEY (`id`,`created`,`my col`)',
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci\n/*!50500 PARTITION BY RANGE  COLUMNS(created,`my col`)\n(PARTITION p1 VALUES LESS THAN ('2024-01-01','m') ENGINE = InnoDB,\n PARTITION pmax VALUES LESS THAN (MAXVALUE,MAXVALUE) ENGINE = InnoDB) */;",
];
const KEYED = [
  'CREATE TABLE `keyed` (\n  `id` int NOT NULL,\n  `a` int NOT NULL,\n  `msg` varchar(10) DEFAULT NULL,\n  PRIMARY KEY (`id`,`a`)',
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci\n/*!50100 PARTITION BY KEY (id,a)\nPARTITIONS 2 */;',
];
const PLAIN = 'CREATE TABLE `plain` (\n  `id` int NOT NULL,\n  `msg` varchar(10) DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;';
const BASE: SchemaModel = parseSqlDump(tdExport([LOGS.join(''), COLUMNS.join(''), KEYED.join(''), PLAIN].join('\n\n'))).model;

const reasonOf = (script: string): string => {
  const r = applyScript(BASE, script, { schemaName: 'shop' });
  if (r.ok) throw new Error(`적용되어 버렸다: ${script}`);
  return r.error.reason;
};
const ok = (script: string) => {
  const r = applyScript(BASE, script, { schemaName: 'shop' });
  if (!r.ok) throw new Error(`${r.error.index}: ${r.error.reason}`);
  return r;
};

describe('파티션 식이 쓰는 컬럼은 지우거나 이름을 바꿀 수 없다 (3855)', () => {
  it.each([
    ['ALTER TABLE logs DROP COLUMN created;'],
    ['ALTER TABLE logs RENAME COLUMN created TO made;'],
    ['ALTER TABLE logs CHANGE created made DATE NOT NULL;'],
    ['ALTER TABLE cols DROP COLUMN `my col`;'], // RANGE COLUMNS 의 두 번째 컬럼 (백틱이 든 이름)
    ['ALTER TABLE cols RENAME COLUMN created TO made;'],
    ['ALTER TABLE keyed DROP COLUMN a;'], // KEY (id,a)
    ['ALTER TABLE keyed CHANGE id id2 INT NOT NULL;'],
  ])('%s', (script) => {
    expect(reasonOf(script)).toContain('(MySQL 3855)');
  });

  it('이름을 안 바꾸는 MODIFY·파티션과 상관없는 컬럼·컬럼 추가는 파티션 절을 그대로 둔다', () => {
    const r = ok('ALTER TABLE logs MODIFY created DATETIME NOT NULL;\nALTER TABLE logs DROP COLUMN msg;\nALTER TABLE logs ADD COLUMN src VARCHAR(10) AFTER id, ADD INDEX ix_src (src);\nALTER TABLE logs COMMENT = \'로그\';');
    const logs = r.model.tables.find((t) => t.name === 'logs')!;
    expect(logs.columns.map((c) => c.name)).toEqual(['id', 'src', 'created', 'region']);
    expect(logs.partition).toEqual(BASE.tables.find((t) => t.name === 'logs')!.partition);
  });
});

describe('PRIMARY KEY·UNIQUE 는 파티션 컬럼을 모두 포함해야 한다 (1503)', () => {
  it.each([
    ['ALTER TABLE logs ADD UNIQUE KEY uq_msg (msg);'],
    ['ALTER TABLE logs ADD UNIQUE KEY uq_msg (msg, region);'], // 일부만 포함하지 않는다: created 가 없다
    ['CREATE UNIQUE INDEX uq_msg ON logs (msg);'],
    ['ALTER TABLE logs DROP PRIMARY KEY, ADD PRIMARY KEY (id);'],
    ['ALTER TABLE cols ADD UNIQUE KEY uq (id, created);'], // RANGE COLUMNS: `my col` 이 없다
    ['ALTER TABLE cols DROP PRIMARY KEY, ADD PRIMARY KEY (id, `my col`);'],
    ['ALTER TABLE keyed ADD UNIQUE KEY uq (msg, id);'], // KEY (id,a): a 가 없다
  ])('%s', (script) => {
    expect(reasonOf(script)).toContain('(MySQL 1503)');
  });

  it('파티션 컬럼을 모두 넣으면 받는다 (일반 인덱스는 상관없다)', () => {
    expect(ok('ALTER TABLE logs ADD UNIQUE KEY uq_msg (msg, created);').model.tables.find((t) => t.name === 'logs')!.indexes.map((i) => i.name)).toEqual(['PRIMARY', 'uq_msg', 'ix_msg']);
    expect(ok('ALTER TABLE logs ADD INDEX ix_region (region);').model.tables.find((t) => t.name === 'logs')!.indexes.map((i) => i.name)).toEqual(['PRIMARY', 'ix_msg', 'ix_region']);
    expect(ok('ALTER TABLE cols ADD UNIQUE KEY uq (`my col`, created, msg);').model.tables.find((t) => t.name === 'cols')!.indexes).toHaveLength(2);
    expect(ok('ALTER TABLE keyed ADD UNIQUE KEY uq (msg, a, id);').model.tables.find((t) => t.name === 'keyed')!.indexes).toHaveLength(2);
  });

  it('파티션 컬럼의 prefix 만 가진 키는 포함으로 치지 않는다', () => {
    expect(reasonOf('ALTER TABLE cols ADD UNIQUE KEY uq (id, created, `my col`(3));')).toContain('(MySQL 1503)');
  });

  it('파티션되지 않은 테이블은 상관없다', () => {
    expect(ok('ALTER TABLE plain ADD UNIQUE KEY uq_msg (msg);').model.tables.find((t) => t.name === 'plain')!.indexes).toHaveLength(2);
  });
});
