// 주석 주입 방지: 주석 줄에 들어가는 이름·사유·notes 는 주석 밖으로 새지 않아야 하고, 실행 문장의 식별자는 그대로 인용돼야 한다
import { describe, expect, it } from 'vitest';
import { escapeCommentText } from '../src/comment-text';
import { generateDdl, renderDdl, statementText } from '../src/ddl';
import { diffSchemas, type RenameMapping } from '../src/diff';
import { quoteIdent as q, tokenize } from '../src/lexer';
import { parseSqlDump, splitStatements } from '../src/parse-dump';
import { commentPart } from './helpers';

// 개행·CR·블록 주석 끝·문장 끝·백틱·DELIMITER·줄 주석·NUL 을 담은 이름들 (제어 문자는 이스케이프로 만든다)
const EVIL = [
  'a\nDROP TABLE precious;',
  'b\r\nDROP TABLE precious;',
  'c\rDROP TABLE precious;',
  'd*/ DROP TABLE precious; /*',
  'e`;DROP TABLE precious;',
  'f\nDELIMITER ;;\nDROP TABLE precious;;\nDELIMITER ;',
  'g\n-- x\n# y\nDROP TABLE precious',
  'h\u0000\u000bDROP TABLE precious;',
];

const OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci';
const table = (name: string, cols: string[], extra: string[] = []) =>
  `CREATE TABLE ${q(name)} (\n${[...cols, ...extra].map((c) => `  ${c}`).join(',\n')}\n) ${OPTS};`;
// 파서가 읽지 못하는 인덱스 속성 → 파싱 실패 테이블 (생성 문장이 수동 확인 주석이 된다)
const unparsed = (name: string) => table(name, ['`id` int NOT NULL', '`a` int DEFAULT NULL', 'PRIMARY KEY (`id`)'], ["KEY `ix` (`a`) /*!80021 SECONDARY_ENGINE_ATTRIBUTE '{\"y\": 2}' */"]);
const routine = (name: string) => [
  'DELIMITER ;;',
  `CREATE DEFINER=\`root\`@\`localhost\` FUNCTION ${q(name)}() RETURNS int\n    NO SQL\n    DETERMINISTIC\nRETURN 1;;`,
  'DELIMITER ;',
].join('\n');

// 이름 하나로 테이블 추가·변경·삭제·rename, FK, 뷰, 루틴, 파싱 실패 테이블, 컬럼 rename 충돌을 모두 만드는 BASE/TARGET
function schemas(name: string, i: number) {
  const col = `${name}_col`;
  const parent = table(`${name}_p`, ['`id` int NOT NULL', 'PRIMARY KEY (`id`)']);
  const base = [
    parent,
    table(`${name}_mod`, ['`id` int NOT NULL', `${q(col)} int DEFAULT NULL`, '`x` int DEFAULT NULL', '`y` int DEFAULT NULL', 'PRIMARY KEY (`id`)']),
    table(`${name}_drop`, ['`id` int NOT NULL', '`pid` int NOT NULL', 'PRIMARY KEY (`id`)', `KEY ${q(`${name}_fk`)} (\`pid\`)`],
      [`CONSTRAINT ${q(`${name}_fk`)} FOREIGN KEY (\`pid\`) REFERENCES ${q(`${name}_p`)} (\`id\`)`]),
    table(`${name}_old`, ['`id` int NOT NULL', 'PRIMARY KEY (`id`)']),
    `CREATE ALGORITHM=UNDEFINED DEFINER=\`root\`@\`localhost\` SQL SECURITY DEFINER VIEW ${q(`${name}_v`)} AS select 1 AS ${q(col)};`,
  ].join('\n\n');
  const target = [
    parent,
    table(`${name}_mod`, ['`id` int NOT NULL', `${q(col)} bigint DEFAULT NULL`, '`x2` int DEFAULT NULL', '`y` int DEFAULT NULL', `${q(`${col}2`)} int DEFAULT NULL`, 'PRIMARY KEY (`id`)']),
    table(`${name}_new`, ['`id` int NOT NULL', '`pid` int NOT NULL', 'PRIMARY KEY (`id`)', `KEY ${q(`${name}_fk2`)} (\`pid\`)`],
      [`CONSTRAINT ${q(`${name}_fk2`)} FOREIGN KEY (\`pid\`) REFERENCES ${q(`${name}_p`)} (\`id\`)`]),
    table(`${name}_renamed`, ['`id` int NOT NULL', 'PRIMARY KEY (`id`)']),
    unparsed(`${name}_pe`),
    `CREATE ALGORITHM=UNDEFINED DEFINER=\`root\`@\`localhost\` SQL SECURITY DEFINER VIEW ${q(`${name}_v`)} AS select 2 AS ${q(col)};`,
    routine(`${name}_fn${i}`),
  ].join('\n\n');
  const renames: RenameMapping[] = [
    { kind: 'table', from: `${name}_old`, to: `${name}_renamed` },
    // y 는 그대로 남아 있어 이름 충돌 (사유·notes 에 이름이 들어간다)
    { kind: 'column', table: `${name}_mod`, from: 'x', to: 'y' },
  ];
  return { base: parseSqlDump(base).model, target: parseSqlDump(target).model, renames };
}

// MySQL 이 주석으로 보지 않는 줄을 끝내는 문자: \n 말고도 CR·그 밖의 제어 문자가 남으면 안 된다
const CONTROL_EXCEPT_NEWLINE_TAB = /[\x00-\x08\x0b-\x1f\x7f]/;


describe('주석 주입 방지 (퍼즈)', () => {
  it.each(EVIL.map((n, i) => [n, i] as const))('이름 %j: 주석 문장·헤더·notes 에는 MySQL 이 실행할 토큰이 0개', (name, i) => {
    const { base, target, renames } = schemas(name, i);
    const stmts = generateDdl(diffSchemas(base, target, renames));
    expect(stmts.some((s) => s.comment)).toBe(true);
    for (const st of stmts) {
      const text = commentPart(st);
      expect(tokenize(text), text).toEqual([]);
      expect(CONTROL_EXCEPT_NEWLINE_TAB.test(text), text).toBe(false);
      for (const line of text.split('\n').filter((l) => l !== '')) expect(line.startsWith('-- '), line).toBe(true);
    }
  });

  it.each(EVIL.map((n, i) => [n, i] as const))('이름 %j: 실행 문장은 이름을 백틱으로 인용해 한 문장으로 남는다', (name, i) => {
    const { base, target, renames } = schemas(name, i);
    const stmts = generateDdl(diffSchemas(base, target, renames)).filter((s) => !s.comment);
    expect(stmts.length).toBeGreaterThan(0);
    for (const st of stmts) {
      // mysql 클라이언트처럼 DELIMITER 를 따라 나눈다: SQL_MODE 설정·복원(SET)을 빼면 한 문장
      const parts = splitStatements(statementText(st));
      expect(parts.filter((p) => !/^SET /.test(p.ddl)).length, statementText(st)).toBe(1);
      const idents = parts.flatMap((p) => tokenize(p.ddl).filter((t) => t.t === 'ident').map((t) => t.v));
      expect(idents.some((v) => v.startsWith(name)), statementText(st)).toBe(true);
      expect(parts.some((p) => /^DROP TABLE `?precious/i.test(p.ddl))).toBe(false);
    }
  });

  it('렌더 전체도 precious 를 지우는 문장을 만들지 않는다', () => {
    for (const [i, name] of EVIL.entries()) {
      const { base, target, renames } = schemas(name, i);
      const all = splitStatements(renderDdl(generateDdl(diffSchemas(base, target, renames))));
      expect(all.filter((p) => /^DROP\s+TABLE\s+`?precious/i.test(p.ddl))).toEqual([]);
    }
  });
});

describe('escapeCommentText', () => {
  it('줄바꿈·CR·제어 문자를 이스케이프하고 탭·일반 문자는 둔다', () => {
    expect(escapeCommentText('a\nb\r\nc\u0000d\u007fe\tf */ ;')).toBe('a\\nb\\r\\nc\\x00d\\x7fe\tf */ ;');
  });
});
