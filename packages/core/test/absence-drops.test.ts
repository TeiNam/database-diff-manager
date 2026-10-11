// 부재 기반 파괴 문장 판정 (17회차 3): TARGET 에 없다는 이유로 나오는 삭제를 한 함수(absenceDrops)로 모은다.
// 객체(테이블·뷰·함수·프로시저)·컬럼·파티션(LIST 값 포함)·인덱스·PRIMARY KEY·FK·CHECK 를 모두 열거하고, 교체(DROP→ADD 쌍)는 뺀다
import { describe, expect, it } from 'vitest';
import { absenceDrops } from '../src/absence-drops';
import { generateDdl, type Statement } from '../src/ddl';
import { diffSchemas } from '../src/diff';
import type { SchemaModel } from '../src/model';
import { parseSqlDump } from '../src/parse-dump';
import { parseMdDump } from '../src/parse-md';
import { fixture, tdExport } from './helpers';

const t = (name: string, body: string, tail = '') =>
  `/* Table : ${name} */\nCREATE TABLE \`${name}\` (\n${body}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci${tail};\n`;
// complete: td-export 헤더·트레일러가 있는 완전한 덤프, unknown: 0.1.15 형식(헤더 SET·트레일러 없음)
const dump = (text: string, complete = true): SchemaModel => parseSqlDump(complete ? tdExport(text) : `/* Database : shop */\n${text}`).model;
const kinds = (base: SchemaModel, target: SchemaModel) => absenceDrops(diffSchemas(base, target)).map((d) => `${d.kind}:${d.object}${d.name === undefined ? '' : `.${d.name}`}`);

const parent = t('p', '  `id` int NOT NULL,\n  PRIMARY KEY (`id`)');
const FULL = [
  '  `id` int NOT NULL',
  '  `pid` int NOT NULL',
  '  `a` int NOT NULL',
  '  `b` int NOT NULL',
  '  PRIMARY KEY (`id`)',
  '  KEY `ix_a` (`a`)',
  '  KEY `fk_c_p` (`pid`)',
  '  CONSTRAINT `fk_c_p` FOREIGN KEY (`pid`) REFERENCES `p` (`id`)',
  '  CONSTRAINT `ck_b` CHECK ((`b` > 0))',
];
const child = (lines: string[], tail = '') => t('c', lines.join(',\n'), tail);
const without = (...drop: string[]) => FULL.filter((l) => !drop.some((d) => l.includes(d)));

describe('absenceDrops: 부재 기반 파괴 문장의 종류를 모두 열거한다', () => {
  const base = dump(parent + child(FULL));

  it.each([
    ['테이블', dump(parent), ['table:c']],
    ['컬럼', dump(parent + child(without('`b` int', 'ck_b'))), ['column:c.b', 'check:c.ck_b']],
    ['인덱스', dump(parent + child(without('ix_a'))), ['index:c.ix_a']],
    ['PRIMARY KEY', dump(parent + child(without('PRIMARY KEY'))), ['primary-key:c.PRIMARY']],
    ['FK', dump(parent + child(without('CONSTRAINT `fk_c_p`'))), ['foreign-key:c.fk_c_p']],
    ['CHECK', dump(parent + child(without('ck_b'))), ['check:c.ck_b']],
  ])('%s', (_, target, expected) => {
    expect(kinds(base, target)).toEqual(expected);
  });

  it('뷰·함수·프로시저 삭제', () => {
    const view = 'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v` AS select 1 AS `x`;\n';
    const fn = 'DELIMITER ;;\nCREATE DEFINER=`root`@`%` FUNCTION `f`() RETURNS int\n    NO SQL\nRETURN 1;;\nDELIMITER ;\n';
    const proc = 'DELIMITER ;;\nCREATE DEFINER=`root`@`%` PROCEDURE `pr`()\nBEGIN\nEND;;\nDELIMITER ;\n';
    expect(kinds(dump(parent + view + fn + proc), dump(parent))).toEqual(['view:v', 'function:f', 'procedure:pr']);
  });

  it('파티션 삭제와 LIST 값 제거 (행이 지워지는 파티션 변경)', () => {
    const part = (defs: string) => dump(t('l', '  `id` int NOT NULL,\n  `r` int NOT NULL', `\n/*!50100 PARTITION BY LIST (\`r\`)\n(${defs}) */`));
    const two = part('PARTITION p1 VALUES IN (1) ENGINE = InnoDB,\n PARTITION p2 VALUES IN (2,3) ENGINE = InnoDB');
    expect(kinds(two, part('PARTITION p2 VALUES IN (2,3) ENGINE = InnoDB'))).toEqual(['partition:l']);
    expect(kinds(two, part('PARTITION p1 VALUES IN (1) ENGINE = InnoDB,\n PARTITION p2 VALUES IN (2) ENGINE = InnoDB'))).toEqual(['partition:l']);
    expect(kinds(two, part('PARTITION p1 VALUES IN (1) ENGINE = InnoDB,\n PARTITION p2 VALUES IN (2,3) ENGINE = InnoDB,\n PARTITION p3 VALUES IN (4) ENGINE = InnoDB'))).toEqual([]);
  });

  it('교체(DROP→ADD 쌍: 인덱스·FK·CHECK·PK 정의 변경)와 추가는 부재 기반이 아니다', () => {
    const changed = FULL.map((l) => l
      .replace('KEY `ix_a` (`a`)', 'KEY `ix_a` (`a`,`b`)')
      .replace('REFERENCES `p` (`id`)', 'REFERENCES `p` (`id`) ON DELETE CASCADE')
      .replace('(`b` > 0)', '(`b` > 1)')
      .replace('PRIMARY KEY (`id`)', 'PRIMARY KEY (`id`,`a`)'));
    expect(kinds(base, dump(parent + child([...changed, '  KEY `ix_b` (`b`)'])))).toEqual([]);
  });
});

// 실행 문장(수동 확인·안내 주석 제외) 중 TARGET 에 없다는 이유로 지우는 문장
const ABSENCE_DROP = /\bDROP\s+(TABLE|VIEW|FUNCTION|PROCEDURE|COLUMN|PARTITION|INDEX|FOREIGN\s+KEY|CHECK|CONSTRAINT|PRIMARY\s+KEY)\b|\bREORGANIZE\s+PARTITION\b/i;
const executed = (stmts: Statement[]) => stmts.filter((s) => !s.comment && ABSENCE_DROP.test(s.sql)).map((s) => s.sql);

describe('TARGET 완전성 증거가 없으면 인덱스·PK·FK·CHECK 삭제도 수동 확인 (17회차 3)', () => {
  const base = (complete: boolean) => dump(parent + child(FULL), complete);
  it.each([
    ['인덱스', without('ix_a')],
    ['PRIMARY KEY', without('PRIMARY KEY')],
    ['FK', without('CONSTRAINT `fk_c_p`')],
    ['CHECK', without('ck_b')],
  ])('%s', (_, lines) => {
    expect(executed(generateDdl(diffSchemas(base(true), dump(parent + child(lines), true)))).length).toBeGreaterThan(0);
    const held = generateDdl(diffSchemas(base(true), dump(parent + child(lines), false)));
    expect(executed(held)).toEqual([]);
    expect(held.some((s) => s.evidenceHold)).toBe(true);
  });

  it('교체(DROP→ADD 쌍)는 증거가 없어도 실행한다', () => {
    const changed = FULL.map((l) => l.replace('KEY `ix_a` (`a`)', 'KEY `ix_a` (`a`,`b`)'));
    const stmts = generateDdl(diffSchemas(base(true), dump(parent + child(changed), false)));
    expect(stmts.map((s) => [s.comment, s.evidenceHold])).toEqual([[false, undefined]]);
    expect(stmts[0].sql).toContain('DROP INDEX `ix_a`');
  });
});

// MD 잘림 퍼즈 (17회차 3, 결정적): 실출력 MD 를 마지막 **Index**·**Constraint** 머리글 직전과 모든 줄 경계에서 자른 TARGET 으로
// 원본 MD BASE 와 비교해도 부재 기반 파괴 문장이 실행 문장으로 나오지 않는다
const MD_FUZZ = ['td-export-0115/sample-app.md', 'td-export-0130/sample-app.md', 'td-export-0152/shop.md', 'md/v3.md'];
// 인덱스·Constraint 목록이 있는 실출력 (shop.md 는 없다)
const MD_WITH_KEYS = MD_FUZZ.filter((n) => n !== 'td-export-0152/shop.md');
const cutsOf = (text: string): string[] => {
  const cuts: string[] = [];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) cuts.push(text.slice(0, i), text.slice(0, i + 1));
  return cuts.filter((c) => c !== text && c !== text.replace(/\n$/, ''));
};

describe('MD 잘림 TARGET 은 인덱스·FK 를 지우지 않는다', () => {
  it.each(MD_WITH_KEYS)('%s: 마지막 Index·Constraint 직전 절단', (name) => {
    const text = fixture(name);
    const base = parseMdDump(text).model;
    const at = Math.max(text.lastIndexOf('**Index**'), text.lastIndexOf('**Constraint**'));
    expect(at).toBeGreaterThan(0);
    for (const cut of [text.slice(0, at), text.slice(0, at).replace(/\n+$/, '\n'), text.slice(0, at).trimEnd()]) {
      expect(executed(generateDdl(diffSchemas(base, parseMdDump(cut).model)))).toEqual([]);
    }
  });

  it.each(MD_FUZZ)('%s: 모든 줄 경계 절단', (name) => {
    const text = fixture(name);
    const base = parseMdDump(text).model;
    const leaked = cutsOf(text).filter((cut) => executed(generateDdl(diffSchemas(base, parseMdDump(cut).model))).length > 0);
    expect(leaked.map((c) => c.length)).toEqual([]);
  });
});
