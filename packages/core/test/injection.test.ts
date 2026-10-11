// 입력 값 → 실행 DDL 주입 방지 (스펙 4.6.x): MD·SQL 덤프의 자유 텍스트가 실행 문장 밖으로 새지 않아야 한다
// (a) 파싱 단계 화이트리스트 — 문법에 맞지 않는 값은 parseError
// (b) 최종 단일 문장 검사 — 출처와 무관하게 실행 문장이 정확히 한 문장이 아니면 수동 확인으로 돌린다
import { describe, expect, it } from 'vitest';
import { generateDdl, renderDdl, statementText } from '../src/ddl';
import { diffSchemas } from '../src/diff';
import type { SchemaModel, Table } from '../src/model';
import { parseSqlDump, splitStatements } from '../src/parse-dump';
import { parseMdDump } from '../src/parse-md';
import { parseCreateTable } from '../src/parse-table';
import { parseCreateView } from '../src/parse-view';
import { isSingleStatement, UNSAFE_STATEMENT_REASON } from '../src/statement-check';
import { cols, ID, INJ, info, MD_INJECTIONS, MD_OK, MD_VIEW_INJECTIONS, mdDump, OK_INFO, PRECIOUS, sqlTable } from './injection-fixtures';

// 출력 전체를 mysql 클라이언트처럼 나눴을 때 precious 를 지우는 문장
const drops = (text: string) => splitStatements(text).filter((p) => /^DROP\s+TABLE\s+`?precious/i.test(p.ddl));

function generated(target: SchemaModel) {
  const base = parseSqlDump(PRECIOUS).model;
  const d = diffSchemas(base, { ...target, tables: [...target.tables, base.tables[0]] });
  return { stmts: generateDdl(d), partial: d.partial };
}

describe('MD 주입: 파싱 단계 화이트리스트', () => {
  it.each(Object.keys(MD_INJECTIONS))('%s: parse-error 테이블이 되고 실행 문장에 DROP 이 없다', (name) => {
    const { model, warnings } = parseMdDump(mdDump({ t_ok: MD_OK, [name]: MD_INJECTIONS[name] }));
    expect(warnings.map((w) => [w.code, w.object])).toEqual([['parse-error', name]]);
    expect(model.tables.find((t) => t.name === name)?.parseError).toBeTruthy();
    const { stmts, partial } = generated(model);
    expect(drops(renderDdl(stmts, partial))).toEqual([]);
  });

  it.each(Object.keys(MD_VIEW_INJECTIONS))('%s: parse-error 뷰가 되고 실행 문장에 DROP 이 없다', (name) => {
    const { model, warnings } = parseMdDump(mdDump({ t_ok: MD_OK, [name]: MD_VIEW_INJECTIONS[name] }));
    expect(warnings.map((w) => [w.code, w.kind, w.object])).toEqual([['parse-error', 'view', name]]);
    const { stmts, partial } = generated(model);
    expect(stmts.find((s) => s.kind === 'view')?.comment).toBe(true);
    expect(drops(renderDdl(stmts, partial))).toEqual([]);
  });

  it('정상 값은 그대로 읽는다 (타입·엔진·콜레이션·FK 동작·ON UPDATE·식)', () => {
    const ok = OK_INFO + cols([
      ID, '|d|decimal(10,2) unsigned zerofill|YES||||||', "|e|enum('a','b,c','it''s')|YES||||||", '|u|varchar(36)|YES|uuid()||||DEFAULT_GENERATED||',
      '|ts|timestamp(3)|YES|CURRENT_TIMESTAMP(3)||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP(3)||', '|pid|int|YES||||MUL||',
    ]) + '**Index**\n- [Normal]ix_l(lower(`u`))\n\n**Constraint**\n- fk_ok FOREIGN KEY (pid) Reference t_ok.id ON DELETE SET NULL ON UPDATE NO ACTION\n\n';
    const { model, warnings } = parseMdDump(mdDump({ t_ok: MD_OK, t_good: ok }));
    expect(warnings).toEqual([]);
    const t = model.tables.find((x) => x.name === 't_good')!;
    expect(t.columns.map((c) => c.type)).toEqual(['int', 'decimal(10,2) unsigned zerofill', "enum('a','b,c','it''s')", 'varchar(36)', 'timestamp(3)', 'int']);
    expect(t.columns[3].default).toBe('(uuid())');
    expect(t.columns[4].onUpdate).toBe('CURRENT_TIMESTAMP(3)');
    expect(t.foreignKeys[0]).toMatchObject({ onDelete: 'SET NULL', onUpdate: 'NO ACTION' });
  });
});


describe('SQL 덤프 주입: 인용된 옵션 값', () => {
  const cases: [string, string][] = [
    ['컬럼 CHARACTER SET 문자열', sqlTable(`  \`a\` varchar(10) CHARACTER SET 'latin1; ${INJ}' DEFAULT NULL`)],
    ['컬럼 COLLATE 문자열', sqlTable(`  \`a\` varchar(10) COLLATE 'latin1_bin; ${INJ}' DEFAULT NULL`)],
    ['테이블 DEFAULT CHARSET 문자열', sqlTable('  `a` int DEFAULT NULL', `ENGINE=InnoDB DEFAULT CHARSET='utf8mb4; ${INJ}'`)],
    ['테이블 COLLATE 문자열', sqlTable('  `a` int DEFAULT NULL', `ENGINE=InnoDB COLLATE='a_b; ${INJ}'`)],
    ['테이블 ENGINE 문자열', sqlTable('  `a` int DEFAULT NULL', `ENGINE='InnoDB; ${INJ}'`)],
    ['인덱스 USING 문자열', sqlTable(`  \`a\` int DEFAULT NULL,\n  KEY \`ix\` (\`a\`) USING 'BTREE; ${INJ}'`)],
    ['ON UPDATE 식', sqlTable('  `a` timestamp NULL DEFAULT NULL ON UPDATE x')],
    ['생성 컬럼 식의 주석', sqlTable('  `a` int GENERATED ALWAYS AS (1 /* x */) VIRTUAL')],
  ];
  it.each(cases)('%s: parseError', (_, ddl) => {
    expect(() => parseCreateTable(ddl)).toThrow();
  });

  it('뷰 ALGORITHM·SQL SECURITY 문자열은 parseError', () => {
    expect(() => parseCreateView(`CREATE ALGORITHM='MERGE; ${INJ}' VIEW \`v\` AS select 1`)).toThrow();
    expect(() => parseCreateView(`CREATE SQL SECURITY 'DEFINER; ${INJ}' VIEW \`v\` AS select 1`)).toThrow();
  });

  it('BASE 컬럼 문자셋 변경 + 주입 TARGET: 실행 문장에 DROP 이 없다', () => {
    const base = parseSqlDump(`${PRECIOUS}\n${sqlTable('  `a` varchar(10) CHARACTER SET latin1 DEFAULT NULL')};`).model;
    const target = parseSqlDump(`${PRECIOUS}\n${sqlTable(`  \`a\` varchar(10) CHARACTER SET 'latin1; ${INJ}' DEFAULT NULL`)};`).model;
    const out = renderDdl(generateDdl(diffSchemas(base, target)));
    expect(drops(out)).toEqual([]);
  });

  it('인용된 다른 테이블 옵션(COMMENT·CONNECTION 등)은 문자열로 다시 인용한다', () => {
    const t = parseCreateTable(sqlTable('  `a` int DEFAULT NULL', "ENGINE=InnoDB CONNECTION='x'' y' COMMENT='a\\'b'"));
    expect(t.options).toEqual([{ key: 'ENGINE', value: 'InnoDB' }, { key: 'CONNECTION', value: "'x'' y'" }, { key: 'COMMENT', value: "'a''b'" }]);
  });
});

// 검증을 거치지 않은 모델(앱 JSON 등)로 만든 문장도 실행 문장은 한 문장이어야 한다
describe('최종 단일 문장 검사 (출처 무관)', () => {
  const evilTable = (patch: (t: Table) => Table): SchemaModel => {
    const t = parseCreateTable(sqlTable('  `a` int DEFAULT NULL'));
    return { name: 's', tables: [patch(t)], views: [], routines: [] };
  };
  const empty: SchemaModel = { name: 's', tables: [], views: [], routines: [] };
  const patches: [string, (t: Table) => Table][] = [
    ['타입', (t) => ({ ...t, columns: [t.columns[0], { ...t.columns[1], type: `int); ${INJ}` }] })],
    ['옵션', (t) => ({ ...t, options: [{ key: 'ENGINE', value: `InnoDB; ${INJ}` }] })],
    ['줄 주석이 끝 ; 를 가림', (t) => ({ ...t, options: [{ key: 'ENGINE', value: 'InnoDB -- x' }] })],
    ['백슬래시 명령', (t) => ({ ...t, options: [{ key: 'ENGINE', value: 'InnoDB \\g DROP TABLE precious' }] })],
    ['DELIMITER 줄', (t) => ({ ...t, options: [{ key: 'ENGINE', value: 'InnoDB\nDELIMITER ;;' }] })],
    ['닫히지 않은 따옴표', (t) => ({ ...t, options: [{ key: 'COMMENT', value: "'x" }] })],
  ];
  it.each(patches)('%s: 수동 확인 문장으로 바뀐다', (_, patch) => {
    const stmts = generateDdl(diffSchemas(empty, evilTable(patch)));
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatchObject({ comment: true });
    expect(stmts[0].sql).toContain(UNSAFE_STATEMENT_REASON);
    expect(drops(renderDdl(stmts))).toEqual([]);
  });

  it('주입된 새 테이블을 참조하는 FK·뷰도 함께 막는다', () => {
    const evil = evilTable((t) => ({ ...t, options: [{ key: 'ENGINE', value: `InnoDB; ${INJ}` }] }));
    const child = parseCreateTable('CREATE TABLE `c` (\n  `id` int NOT NULL,\n  `tid` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `fk` (`tid`),\n  CONSTRAINT `fk` FOREIGN KEY (`tid`) REFERENCES `t` (`id`)\n) ENGINE=InnoDB');
    const view = parseCreateView('CREATE VIEW `v` AS select `t`.`id` AS `id` from `t`');
    const stmts = generateDdl(diffSchemas(empty, { ...evil, tables: [...evil.tables, child], views: [view] }));
    expect(stmts.filter((s) => !s.comment).map((s) => `${s.kind} ${s.object} ${s.op}`)).toEqual([]);
  });

  it('정상 문장·루틴(DELIMITER 래핑)은 통과한다', () => {
    const dump = parseSqlDump([
      sqlTable('  `a` int DEFAULT NULL') + ';',
      "SET @OLD_ROUTINE_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_BACKSLASH_ESCAPES';",
      'DELIMITER ;;',
      "CREATE DEFINER=`root`@`localhost` PROCEDURE `p`()\nBEGIN\n  -- 주석;; 안의 구분자\n  SELECT 'a\\';\n  SELECT 1;\nEND ;;",
      'DELIMITER ;',
    ].join('\n')).model;
    const stmts = generateDdl(diffSchemas(empty, dump));
    expect(stmts.map((s) => s.comment)).toEqual([false, false]);
    for (const s of stmts) expect(isSingleStatement(s), statementText(s)).toBe(true);
  });

  it('루틴 본문에 구분자가 들어 있으면 수동 확인', () => {
    const dump = parseSqlDump([
      'DELIMITER $$',
      'CREATE DEFINER=`root`@`localhost` PROCEDURE `p`()\nBEGIN\n  SELECT 1;;\n  DROP TABLE precious;\nEND $$',
      'DELIMITER ;',
    ].join('\n')).model;
    const [st] = generateDdl(diffSchemas(empty, dump));
    expect(st.comment).toBe(true);
    expect(drops(renderDdl([st]))).toEqual([]);
  });
});
