// 주입 지점별 MD·SQL 픽스처 (injection.test 와 mysql.int.test 가 함께 쓴다). 제어 문자는 이스케이프로 만든다
export const INJ = 'DROP TABLE precious; -- ';
export const PRECIOUS = 'CREATE TABLE `precious` (\n  `id` int NOT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;';

export const info = (engine: string, collate: string) =>
  `**Information**\n|Table type|Engine|Row format|Collate|Comment|\n|---|---|---|---|---|\n|BASE TABLE|${engine}|Dynamic|${collate}||\n\n`;
export const cols = (rows: string[]) =>
  `**Columns**\n|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|\n|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\n`;
export const OK_INFO = info('InnoDB', 'utf8mb4_0900_ai_ci');
export const ID = '|id|int|NO||||PRI|||';

// 주입 지점마다 MD 섹션 하나 (td-export 0.1.21+ 형식이 되도록 따옴표 Default 를 하나 둔다)
export const MD_INJECTIONS: Record<string, string> = {
  t_type: OK_INFO + cols([ID, `|a|int); ${INJ}|YES||||||`]),
  t_engine: info(`InnoDB; ${INJ}`, 'utf8mb4_0900_ai_ci') + cols([ID]),
  t_collate: info('InnoDB', `utf8mb4_0900_ai_ci; ${INJ}`) + cols([ID]),
  t_onupd: OK_INFO + cols([ID, '|ts|timestamp|YES|CURRENT_TIMESTAMP||||DEFAULT_GENERATED on update CURRENT_TIMESTAMP;DROP/**/TABLE/**/precious;#||']),
  t_def: OK_INFO + cols([ID, `|a|int|YES|1); ${INJ}||||DEFAULT_GENERATED||`]),
  t_def_comment: OK_INFO + cols([ID, '|a|int|YES|1 /* x */||||DEFAULT_GENERATED||']),
  t_def_quoted: OK_INFO + cols([ID, `|s|varchar(9)|YES|'a'; ${INJ}'||||||`]),
  t_idx: OK_INFO + cols([ID, '|a|int|YES||||||']) + `**Index**\n- [Normal]ix(1)); ${INJ}()\n\n`,
  t_fk_del: OK_INFO + cols([ID, '|pid|int|YES||||MUL||']) + `**Constraint**\n- fk1 FOREIGN KEY (pid) Reference t_ok.id ON DELETE CASCADE; ${INJ}ON UPDATE CASCADE\n\n`,
  t_fk_upd: OK_INFO + cols([ID, '|pid|int|YES||||MUL||']) + `**Constraint**\n- fk2 FOREIGN KEY (pid) Reference t_ok.id ON DELETE CASCADE ON UPDATE CASCADE; ${INJ}\n\n`,
};
export const MD_OK = OK_INFO + cols([ID, "|s|varchar(5)|YES|'x'||||||"]);
const VIEW_SECTION = (sql: string) =>
  `**Information**\n|Table type|Charset|Collation|\n|---|---|---|\n|VIEW|utf8mb4|utf8mb4_0900_ai_ci|\n\n**View Create SQL**\n\`\`\`sql\n${sql}\n\`\`\`\n\n`;
export const MD_VIEW_INJECTIONS: Record<string, string> = {
  v_semi: VIEW_SECTION('CREATE VIEW `v_semi` AS select 1 AS `a`; DROP TABLE precious'),
  v_comment: VIEW_SECTION('CREATE VIEW `v_comment` AS select 1 AS `a` -- \nfrom `t_ok`'),
  v_delim: VIEW_SECTION('CREATE VIEW `v_delim` AS select 1 AS `a`\nDELIMITER ;;'),
  v_backslash: VIEW_SECTION('CREATE VIEW `v_backslash` AS select 1 AS `a` \\g DROP TABLE precious'),
};

export function mdDump(sections: Record<string, string>): string {
  const names = Object.keys(sections);
  return `s\n===\n\n## Table List\n${names.map((n) => `- [${n} ()](#${n})`).join('\n')}\n\n${names.map((n) => `## ${n}\n${sections[n]}`).join('')}`;
}

export const sqlTable = (cols: string, tail = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci') =>
  `CREATE TABLE \`t\` (\n  \`id\` int NOT NULL,\n${cols},\n  PRIMARY KEY (\`id\`)\n) ${tail}`;

// SQL 덤프 변경 경로(ALTER) 주입: 인용된 컬럼 문자셋, 문자셋 없이 인용된 테이블 콜레이션 (CONVERT 문자셋을 콜레이션에서 추정)
const changed = (name: string, col: string, tail: string) => `CREATE TABLE \`${name}\` (\n  \`id\` int NOT NULL,\n  ${col},\n  PRIMARY KEY (\`id\`)\n) ${tail};\n`;
export const SQL_INJECTION = {
  base: `${PRECIOUS}\n${changed('c1', '`a` varchar(10) CHARACTER SET latin1 DEFAULT NULL', 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci')}${changed('c2', '`a` varchar(10) DEFAULT NULL', 'ENGINE=InnoDB DEFAULT CHARSET=latin1')}`,
  target: `${PRECIOUS}\n${changed('c1', `\`a\` varchar(20) CHARACTER SET 'latin1; ${INJ}' DEFAULT NULL`, 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci')}${changed('c2', '`a` varchar(10) DEFAULT NULL', `ENGINE=InnoDB COLLATE='utf8mb4_bin; ${INJ}'`)}`,
};
