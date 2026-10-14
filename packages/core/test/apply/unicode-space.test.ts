import { describe, expect, it } from 'vitest';
import { applyScript, type ApplyResult } from '../../src/apply';
import { RE_EXPORT } from '../../src/apply/types';
import { tokenize } from '../../src/lexer';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

// 리뷰 11회차 Claude F5 (8.0.46·8.4.11 실측): 따옴표·주석 밖의 ASCII 가 아닌 공백(NBSP U+00A0·U+3000·U+FEFF … — JS 의 \s)은 렉서가 토큰 사이에서 공백으로 건너뛰지만
// MySQL(utf8mb4)은 이름의 글자로 읽는다: 'ADD <NBSP>nick INT' 의 컬럼은 NBSP 로 시작하는 이름이고, 문장 맨 앞·'(' 앞에서는 1064 다. RE_EXPORT 로 거부한다.
// 문자열·백틱·주석 안의 것은 MySQL 도 그 글자로 읽어 받는다. 덤프 파서와 함께 쓰는 렉서는 그대로다
const NBSP = '\u00a0';
const IDEOGRAPHIC = '\u3000';
const BOM = '\ufeff';
const base = parseSqlDump(tdExport('CREATE TABLE `t` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;')).model;
const run = (script: string): ApplyResult => applyScript(base, script, { schemaName: 'shop' });
const expectRejected = (r: ApplyResult, index: number, code: string): void => {
  expect(r).toMatchObject({ ok: false, error: { index } });
  if (r.ok) return;
  expect(r.error.reason).toContain(`ASCII 가 아닌 공백(U+${code})`);
  expect(r.error.reason.endsWith(RE_EXPORT), r.error.reason).toBe(true);
};

describe('따옴표·주석 밖의 ASCII 가 아닌 공백', () => {
  it.each([
    ['이름 앞 (공백 다음 NBSP)', `ALTER TABLE t ADD ${NBSP}nick VARCHAR(20);`, '00A0'],
    ['이름 뒤 (단어에 붙은 NBSP)', `ALTER TABLE t ADD nick${NBSP} INT;`, '00A0'],
    ['NBSP 로 들여 쓴 CREATE TABLE 컬럼', `CREATE TABLE u (\n${NBSP}${NBSP}id INT PRIMARY KEY\n);`, '00A0'],
    ['문장 맨 앞', `${NBSP}ALTER TABLE t ADD nick INT;`, '00A0'],
    ['전각 공백 U+3000', `ALTER TABLE t ADD ${IDEOGRAPHIC}nick INT;`, '3000'],
    ['스크립트 가운데의 BOM', `ALTER TABLE t ADD a INT;\n${BOM}ALTER TABLE t ADD b INT;`, 'FEFF'],
    ['무시하는 문장', `SET${NBSP}@x = 1;\nALTER TABLE t ADD a INT;`, '00A0'],
    ['실행하는 실행 주석 안', `/*!40101 SET${NBSP} NAMES utf8mb4 */;\nALTER TABLE t ADD a INT;`, '00A0'],
  ])('%s 는 RE_EXPORT 로 거부한다', (_name, script, code) => {
    expectRejected(run(script), script.startsWith('ALTER TABLE t ADD a INT;') ? 2 : 1, code);
  });

  it('문자열·백틱·주석과 건너뛰는 실행 주석 안의 것, 스크립트 맨 앞 BOM 은 받는다', () => {
    const r = run([
      `${BOM}ALTER TABLE t ADD \`a${NBSP}b\` INT COMMENT 'x${NBSP}y';`, `ALTER TABLE t ADD c INT /* ${NBSP} */;`, `ALTER TABLE t ADD d INT -- ${NBSP}\n;`, `# ${NBSP}\nALTER TABLE t ADD e INT;`,
      `ALTER TABLE t ADD f INT /*!99999 ${NBSP}, ADD g INT */;`,
    ].join('\n'));
    expect(r).toMatchObject({ ok: true, applied: 5 });
    if (r.ok) expect(r.model.tables[0].columns.map((c) => [c.name, c.comment])).toEqual([['id', undefined], [`a${NBSP}b`, `x${NBSP}y`], ['c', undefined], ['d', undefined], ['e', undefined], ['f', undefined]]);
  });

  it('렉서는 그대로 토큰 사이의 NBSP 를 공백으로 건너뛴다 (덤프 파서)', () => {
    expect(tokenize(`ADD ${NBSP}nick INT`).map((t) => t.v)).toEqual(['ADD', 'nick', 'INT']);
  });
});
