// ALTER TABLE — FK 가 만드는 인덱스의 이름 충돌과 지운 FK 이름 (MySQL 8.0.46·8.4.11 실측)
import { describe, expect, it } from 'vitest';
import { applyScript } from '../../src/apply';
import type { SchemaModel, Table } from '../../src/model';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

const tbl = (r: { model: SchemaModel }, name: string): Table => r.model.tables.find((t) => t.name === name)!;
const col = (r: { model: SchemaModel }, table: string, name: string) => tbl(r, table).columns.find((c) => c.name === name)!;

// MySQL 8.0.46·8.4.11 실측: FK 에 받치는 인덱스가 없어 MySQL 이 인덱스를 만들 때, 이름을 직접 정했으면(CONSTRAINT 이름·FOREIGN KEY 뒤 인덱스 이름) 겹칠 때 `_2` 를 붙이지 않고 1061 이다
// (대소문자 무시, UNIQUE·같은 문장에서 더한 인덱스·지운 FK 가 남긴 인덱스와도, PRIMARY 는 1280). 이름을 안 정했을 때만 첫 컬럼 이름에 `_2`. 받치는 인덱스가 이미 있으면 새 인덱스가 필요 없어 겹치지 않는다.
// 같은 문장에서 지운 FK 와 같은 이름(대소문자 무시)의 FK 를 더하면 1826 — 인덱스 충돌이 먼저 걸리면 1061
describe('ALTER TABLE — FK 자동 인덱스 이름 충돌', () => {
  const IDX_BASE = parseSqlDump(tdExport([
    'CREATE TABLE `par` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
    'CREATE TABLE `par2` (\n  `a` int NOT NULL,\n  `b` int NOT NULL,\n  PRIMARY KEY (`a`,`b`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
    'CREATE TABLE `fk5` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `t_ibfk_5` (`x0`),\n  CONSTRAINT `t_ibfk_5` FOREIGN KEY (`x0`) REFERENCES `par` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
    'CREATE TABLE `kn` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uqf` (`x0`),\n  KEY `a` (`x0`),\n  KEY `fkname` (`x0`),\n  KEY `ix` (`x0`),\n  KEY `x1` (`x0`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
    'CREATE TABLE `ks` (\n  `id` int NOT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `fkn2` (`x1`),\n  KEY `ix2` (`x1`),\n  KEY `am` (`x1`,`x2`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  ].join('\n\n'))).model;
  const runIdx = (script: string) => applyScript(IDX_BASE, script, { schemaName: 'shop' });
  const okIdx = (script: string) => {
    const r = runIdx(script);
    if (!r.ok) throw new Error(`${r.error.index}: ${r.error.reason}`);
    return r;
  };
  const idxRejects = (script: string, errno: string) => expect(runIdx(script), script).toMatchObject({ ok: false, error: { reason: expect.stringContaining(`(MySQL ${errno})`) } });
  const keys = (r: { model: SchemaModel }, table: string) => tbl(r, table).indexes.map((i) => `${i.name}(${i.parts.map((p) => p.column).join(',')})`);
  const FK_X1 = 'REFERENCES par (id)';

  it.each([
    [`ALTER TABLE kn ADD CONSTRAINT fkname FOREIGN KEY (x1) ${FK_X1};`, '1061'], // CONSTRAINT 이름이 인덱스 이름이 된다
    [`ALTER TABLE kn ADD CONSTRAINT FKNAME FOREIGN KEY (x1) ${FK_X1};`, '1061'], // 대소문자 무시
    [`ALTER TABLE kn ADD CONSTRAINT uqf FOREIGN KEY (x1) ${FK_X1};`, '1061'], // UNIQUE 인덱스 이름과도
    ['ALTER TABLE kn ADD CONSTRAINT a FOREIGN KEY (x0, x1) REFERENCES par2 (a, b);', '1061'], // a (x0) 는 (x0, x1) 을 받치지 못한다
    [`ALTER TABLE kn ADD FOREIGN KEY ix (x1) ${FK_X1};`, '1061'], // FOREIGN KEY 뒤에 쓴 인덱스 이름
    [`ALTER TABLE kn ADD INDEX fk5 (x2), ADD CONSTRAINT fk5 FOREIGN KEY (x1) ${FK_X1};`, '1061'], // 같은 문장에서 더한 인덱스와도 (절 순서 무관)
    [`ALTER TABLE kn ADD CONSTRAINT fk5 FOREIGN KEY (x1) ${FK_X1}, ADD INDEX fk5 (x2);`, '1061'],
    [`ALTER TABLE kn ADD FOREIGN KEY ixx (x1) ${FK_X1}, ADD INDEX ixx (x2);`, '1061'],
    [`ALTER TABLE fk5 DROP FOREIGN KEY t_ibfk_5, ADD CONSTRAINT t_ibfk_5 FOREIGN KEY (x1) ${FK_X1};`, '1061'], // 지운 FK 의 인덱스 t_ibfk_5 가 남는다
    [`ALTER TABLE fk5 DROP FOREIGN KEY t_ibfk_5, ADD CONSTRAINT T_IBFK_5 FOREIGN KEY (x1) ${FK_X1};`, '1061'],
    [`ALTER TABLE fk5 DROP FOREIGN KEY t_ibfk_5;\nALTER TABLE fk5 ADD CONSTRAINT t_ibfk_5 FOREIGN KEY (x1) ${FK_X1};`, '1061'],
    [`ALTER TABLE kn ADD CONSTRAINT \`PRIMARY\` FOREIGN KEY (x1) ${FK_X1};`, '1280'],
  ])('이름을 직접 정한 FK 자동 인덱스가 겹치면 1061 (_2 를 붙이지 않는다): %s', (script, errno) => {
    idxRejects(script, errno);
  });

  it('받치는 인덱스가 이미 있으면 새 인덱스를 만들지 않아 이름이 겹쳐도 된다 (앞 문장에서 지운 FK 와 같은 이름도)', () => {
    const before = keys({ model: IDX_BASE }, 'ks');
    for (const script of [
      `ALTER TABLE ks ADD CONSTRAINT fkn2 FOREIGN KEY (x1) ${FK_X1};`, // 같은 이름·같은 컬럼의 인덱스
      `ALTER TABLE ks ADD FOREIGN KEY ix2 (x1) ${FK_X1};`,
      `ALTER TABLE ks ADD CONSTRAINT am FOREIGN KEY (x1) ${FK_X1};`, // am (x1, x2) 의 앞쪽 컬럼
    ]) expect(keys(okIdx(script), 'ks'), script).toEqual(before);
    expect(keys(okIdx(`ALTER TABLE ks ADD INDEX fk5 (x1), ADD CONSTRAINT fk5 FOREIGN KEY (x1) ${FK_X1};`), 'ks')).toEqual([...before, 'fk5(x1)']);
    expect(keys(okIdx(`ALTER TABLE ks ADD CONSTRAINT fk5 FOREIGN KEY (x1) ${FK_X1}, ADD INDEX fk5 (x1);`), 'ks')).toEqual([...before, 'fk5(x1)']);
    const recreated = okIdx(`ALTER TABLE fk5 DROP FOREIGN KEY t_ibfk_5;\nALTER TABLE fk5 ADD CONSTRAINT t_ibfk_5 FOREIGN KEY (x0) ${FK_X1} ON DELETE CASCADE;`);
    expect(keys(recreated, 'fk5')).toEqual(['PRIMARY(id)', 't_ibfk_5(x0)']); // 남은 인덱스를 그대로 쓴다
    expect(tbl(recreated, 'fk5').foreignKeys).toEqual([{ name: 't_ibfk_5', columns: ['x0'], refTable: 'par', refColumns: ['id'], onDelete: 'CASCADE' }]);
  });

  it('같은 문장에서 인덱스를 지우면 이름이 비어 새 인덱스를 만든다, 이름을 안 정했으면 첫 컬럼 이름에 _2', () => {
    expect(keys(okIdx(`ALTER TABLE kn DROP INDEX fkname, ADD CONSTRAINT fkname FOREIGN KEY (x1) ${FK_X1};`), 'kn').at(-1)).toBe('fkname(x1)');
    const unnamed = okIdx(`ALTER TABLE kn DROP INDEX x1, ADD FOREIGN KEY (x1) ${FK_X1};`);
    expect(keys(unnamed, 'kn')).toContain('x1(x1)');
    const suffixed = okIdx(`ALTER TABLE kn ADD FOREIGN KEY (x1) ${FK_X1};`); // 이름이 x1 인 인덱스(x0)가 이미 있다
    expect(keys(suffixed, 'kn').at(-1)).toBe('x1_2(x1)');
    expect(tbl(suffixed, 'kn').foreignKeys.map((f) => f.name)).toEqual(['kn_ibfk_1']);
  });

  it('같은 문장에서 지운 FK 와 같은 이름(대소문자 무시)으로 다시 더하면 1826, 다른 이름이거나 앞 문장에서 지웠으면 된다', () => {
    idxRejects(`ALTER TABLE fk5 DROP FOREIGN KEY t_ibfk_5, ADD CONSTRAINT t_ibfk_5 FOREIGN KEY (x0) ${FK_X1};`, '1826'); // 받치는 인덱스가 있어도 FK 이름 중복
    idxRejects(`ALTER TABLE fk5 DROP CONSTRAINT t_ibfk_5, ADD CONSTRAINT t_ibfk_5 FOREIGN KEY (x0) ${FK_X1};`, '1826');
    idxRejects(`ALTER TABLE fk5 DROP FOREIGN KEY t_ibfk_5, ADD CONSTRAINT T_IBFK_5 FOREIGN KEY (x0) ${FK_X1};`, '1826');
    const other = okIdx(`ALTER TABLE fk5 DROP FOREIGN KEY t_ibfk_5, ADD CONSTRAINT t_ibfk_6 FOREIGN KEY (x1) ${FK_X1};`);
    expect(keys(other, 'fk5')).toEqual(['PRIMARY(id)', 't_ibfk_5(x0)', 't_ibfk_6(x1)']);
    expect(tbl(other, 'fk5').foreignKeys.map((f) => f.name)).toEqual(['t_ibfk_6']);
  });
});
