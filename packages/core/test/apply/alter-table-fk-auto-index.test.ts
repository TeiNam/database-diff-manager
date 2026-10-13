// ALTER TABLE — FK 가 자동으로 만든 인덱스 (MySQL 8.0.46·8.4.11 실측, 두 버전 결과가 같다)
//
// MySQL 은 FK 마다 "자동 키" 후보를 하나 만들고(sql_table.cc mysql_prepare_create_table·foreign_key_prefix), 같은 컬럼으로 시작하는 다른 키가 있으면 자동 키를 버린다.
// 키 목록은 [문장 뒤에 남은 기존 키] + [문장에서 더한 키·FK 의 자동 키, 절 순서] 이고, 자동 키 여부는 SHOW CREATE 에 안 나오지만 테이블에 남는다.
// - 자동 키 g 는 다른 키 n 이 앞쪽 파트(컬럼 이름·prefix 길이·정렬 방향)를 g 와 똑같이 가지면 버려진다. n 의 종류(UNIQUE·PRIMARY·FULLTEXT)·가시성은 상관없다.
//   둘 다 자동 키면 짧은 쪽이, 길이가 같으면 앞선 쪽이 버려진다. 직접 만든 인덱스는 버려지지 않는다
// - 버려질 키는 이름을 차지하지 않는다 (같은 이름의 인덱스를 더해도 1061 이 아니다). 살아남은 키는 키 목록 순서대로 이름을 받는다
// - FK 를 지워도 자동 인덱스는 남고 자동 키 표시도 남는다 (앞 문장에서 FK 만 지운 뒤의 동작은 이 모델이 따라가지 못한다 — 아래 '한계'). RENAME INDEX 는 표시를 지운다
// - 자동 키는 FK 를 더한 절의 자리에 만들어진다 (뒤에 오는 일반 인덱스보다 앞). 새 FK 가 같은 컬럼의 자동 키를 대신하면 키 목록 끝으로 옮겨진다
// 덤프(SHOW CREATE)로는 자동 키인지 알 수 없어 이름으로 가린다: FK 이름과 같으면 자동, FK 첫 컬럼 이름(또는 <컬럼>_N)이면 알 수 없음(문장 결과가 달라지면 거부), 그 밖은 직접 만든 것
import { describe, expect, it } from 'vitest';
import { applyScript } from '../../src/apply';
import { RE_EXPORT } from '../../src/apply/types';
import type { SchemaModel, Table } from '../../src/model';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

const TAIL = ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;';
const PARENTS = [
  `CREATE TABLE \`par\` (\n  \`id\` int NOT NULL,\n  PRIMARY KEY (\`id\`)\n${TAIL}`,
  `CREATE TABLE \`par2\` (\n  \`a\` int NOT NULL,\n  \`b\` int NOT NULL,\n  PRIMARY KEY (\`a\`,\`b\`)\n${TAIL}`,
  `CREATE TABLE \`parv\` (\n  \`v\` varchar(20) NOT NULL,\n  PRIMARY KEY (\`v\`)\n${TAIL}`,
];

// 변형별 SHOW CREATE TABLE t (MySQL 에서 뽑은 그대로). named: CONSTRAINT f 가 자동으로 만든 KEY f, unnamed: 이름 없는 FK 가 만든 KEY x0 (첫 컬럼 이름),
// ixname: FOREIGN KEY ix_g (x0) 가 만든 KEY ix_g, added: ALTER 로 FK 를 붙여 KEY f 가 끝에 있다, user: 직접 만든 KEY k0 가 받친다
const BASES: Record<string, string> = {
  named: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ka` (`x1`),\n  KEY `f` (`x0`),\n  KEY `kz` (`x2`),\n  CONSTRAINT `f` FOREIGN KEY (`x0`) REFERENCES `par` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  unnamed: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ka` (`x1`),\n  KEY `x0` (`x0`),\n  KEY `kz` (`x2`),\n  CONSTRAINT `t_ibfk_1` FOREIGN KEY (`x0`) REFERENCES `par` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  ixname: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ka` (`x1`),\n  KEY `ix_g` (`x0`),\n  KEY `kz` (`x2`),\n  CONSTRAINT `t_ibfk_1` FOREIGN KEY (`x0`) REFERENCES `par` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  added: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ka` (`x1`),\n  KEY `kz` (`x2`),\n  KEY `f` (`x0`),\n  CONSTRAINT `f` FOREIGN KEY (`x0`) REFERENCES `par` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  user: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ka` (`x1`),\n  KEY `k0` (`x0`),\n  KEY `kz` (`x2`),\n  CONSTRAINT `f` FOREIGN KEY (`x0`) REFERENCES `par` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  composite: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ka` (`x1`),\n  KEY `f` (`x0`,`x1`),\n  KEY `kz` (`x2`),\n  CONSTRAINT `f` FOREIGN KEY (`x0`, `x1`) REFERENCES `par2` (`a`, `b`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  plain: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ka` (`x1`),\n  KEY `kz` (`x2`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  text: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `v` varchar(20) DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ka` (`x1`),\n  KEY `f` (`v`),\n  CONSTRAINT `f` FOREIGN KEY (`v`) REFERENCES `parv` (`v`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
};
const baseOf = (variant: string): SchemaModel => parseSqlDump(tdExport([...PARENTS, BASES[variant]].join('\n\n'))).model;
const tableT = (model: SchemaModel): Table => model.tables.find((t) => t.name === 't')!;
const run = (variant: string, script: string) => applyScript(baseOf(variant), script, { schemaName: 'shop' });
const ok = (variant: string, script: string): SchemaModel => {
  const r = run(variant, script);
  if (!r.ok) throw new Error(`${r.error.index}: ${r.error.reason}`);
  return r.model;
};

// 키 목록을 SHOW CREATE 의 순서대로 'PRIMARY(id) ka(x1) U:uq(x0,x1) ix(x0-desc) f(v) ix(v(5))' 꼴로, 그 뒤에 ' | ' 와 FK 이름들
const shown = (t: Table): string => {
  const keys = t.indexes.map((i) => {
    const parts = i.parts.map((p) => `${p.column}${p.length !== undefined ? `(${p.length})` : ''}${p.desc ? '-desc' : ''}`).join(',');
    return `${i.kind === 'UNIQUE' ? 'U:' : i.kind === 'FULLTEXT' ? 'F:' : ''}${i.name}(${parts})`;
  });
  return `${keys.join(' ')} | ${t.foreignKeys.map((f) => f.name).join(',')}`;
};

// [변형, 스크립트, MySQL 이 낸 결과] — 'error N' 이면 (MySQL N) 으로 거부
const CASES: [variant: string, script: string, expected: string][] = [
  // 이름이 FK 이름과 같은 인덱스 (CONSTRAINT f 가 만든 KEY f) — MySQL 이 자동으로 만든 것
  ['named', 'ALTER TABLE t ADD INDEX ix (x0, x1)', 'PRIMARY(id) ka(x1) kz(x2) ix(x0,x1) | f'],
  ['named', 'ALTER TABLE t ADD UNIQUE (x0)', 'PRIMARY(id) U:x0(x0) ka(x1) kz(x2) | f'],
  ['named', 'ALTER TABLE t ADD INDEX ix (x0)', 'PRIMARY(id) ka(x1) kz(x2) ix(x0) | f'],
  ['named', 'ALTER TABLE t ADD INDEX ix (x1, x0)', 'PRIMARY(id) ka(x1) f(x0) kz(x2) ix(x1,x0) | f'],
  ['named', 'ALTER TABLE t ADD INDEX ix (x0 DESC)', 'PRIMARY(id) ka(x1) f(x0) kz(x2) ix(x0-desc) | f'],
  ['named', 'ALTER TABLE t DROP PRIMARY KEY, ADD PRIMARY KEY (x0, id)', 'PRIMARY(x0,id) ka(x1) kz(x2) | f'],
  ['named', 'ALTER TABLE t ENGINE=InnoDB', 'PRIMARY(id) ka(x1) f(x0) kz(x2) | f'],
  ['named', 'ALTER TABLE t ADD INDEX ix (x0, x1), ADD INDEX iy (x0, x2)', 'PRIMARY(id) ka(x1) kz(x2) ix(x0,x1) iy(x0,x2) | f'],
  ['named', 'ALTER TABLE t ADD INDEX ix (x0, x1), DROP INDEX ka', 'PRIMARY(id) kz(x2) ix(x0,x1) | f'],
  ['named', 'ALTER TABLE t ADD UNIQUE KEY uq (x0, x1)', 'PRIMARY(id) U:uq(x0,x1) ka(x1) kz(x2) | f'],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f, ADD CONSTRAINT g FOREIGN KEY (x0) REFERENCES par (id)', 'PRIMARY(id) ka(x1) kz(x2) g(x0) | g'],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f, ADD FOREIGN KEY (x0) REFERENCES par (id)', 'PRIMARY(id) ka(x1) kz(x2) x0(x0) | t_ibfk_1'],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f, ADD INDEX z (x0)', 'PRIMARY(id) ka(x1) kz(x2) z(x0) | '],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f, ADD INDEX z (x0, x1)', 'PRIMARY(id) ka(x1) kz(x2) z(x0,x1) | '],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f, ADD CONSTRAINT g FOREIGN KEY (x1) REFERENCES par (id)', 'PRIMARY(id) ka(x1) f(x0) kz(x2) | g'],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f', 'PRIMARY(id) ka(x1) f(x0) kz(x2) | '],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f, ADD FOREIGN KEY ix_n (x0) REFERENCES par (id)', 'PRIMARY(id) ka(x1) kz(x2) ix_n(x0) | t_ibfk_1'],
  ['named', 'ALTER TABLE t ADD CONSTRAINT h FOREIGN KEY (x0) REFERENCES par (id)', 'PRIMARY(id) ka(x1) kz(x2) h(x0) | f,h'],
  ['named', 'ALTER TABLE t ADD FOREIGN KEY (x0) REFERENCES par (id)', 'PRIMARY(id) ka(x1) kz(x2) x0(x0) | f,t_ibfk_1'],
  ['named', 'ALTER TABLE t ADD CONSTRAINT h FOREIGN KEY (x0, x1) REFERENCES par2 (a, b)', 'PRIMARY(id) ka(x1) kz(x2) h(x0,x1) | f,h'],
  ['named', 'ALTER TABLE t ADD INDEX f (x0, x1)', 'PRIMARY(id) ka(x1) kz(x2) f(x0,x1) | f'],
  ['named', 'ALTER TABLE t ADD UNIQUE KEY f (x0)', 'PRIMARY(id) U:f(x0) ka(x1) kz(x2) | f'],
  ['named', 'ALTER TABLE t ADD INDEX f (x1, x0)', 'error 1061'],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f, ADD INDEX f (x0, x1)', 'PRIMARY(id) ka(x1) kz(x2) f(x0,x1) | '],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f, ADD INDEX f (x1, x0)', 'error 1061'],
  ['named', 'ALTER TABLE t DROP INDEX f, ADD INDEX ix (x0, x1)', 'PRIMARY(id) ka(x1) kz(x2) ix(x0,x1) | f'],
  ['named', 'ALTER TABLE t ADD INDEX ix (x0), ADD INDEX iy (x0)', 'PRIMARY(id) ka(x1) kz(x2) ix(x0) iy(x0) | f'],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f, ADD CONSTRAINT g FOREIGN KEY (x0) REFERENCES par (id), ADD INDEX z (x0, x1)', 'PRIMARY(id) ka(x1) kz(x2) z(x0,x1) | g'],
  ['named', 'ALTER TABLE t ADD INDEX ix (x0) INVISIBLE', 'PRIMARY(id) ka(x1) kz(x2) ix(x0) | f'],
  ['named', 'ALTER TABLE t ADD INDEX ix (x0) USING HASH', 'PRIMARY(id) ka(x1) kz(x2) ix(x0) | f'],
  ['named', 'ALTER TABLE t RENAME INDEX f TO g, ADD INDEX ix (x0, x1)', 'PRIMARY(id) ka(x1) g(x0) kz(x2) ix(x0,x1) | f'],
  ['named', 'CREATE INDEX ix ON t (x0, x1)', 'PRIMARY(id) ka(x1) kz(x2) ix(x0,x1) | f'],
  ['named', 'ALTER TABLE t ADD INDEX ix (x0, x1);\nALTER TABLE t DROP INDEX ix', 'error 1553'],
  ['named', 'ALTER TABLE t RENAME INDEX f TO g;\nALTER TABLE t ADD INDEX ix (x0, x1)', 'PRIMARY(id) ka(x1) g(x0) kz(x2) ix(x0,x1) | f'],
  ['named', 'ALTER TABLE t CHANGE x0 y0 int;\nALTER TABLE t ADD INDEX ix (y0, x1)', 'PRIMARY(id) ka(x1) kz(x2) ix(y0,x1) | f'],
  ['named', 'ALTER TABLE t ADD INDEX ix (x0, x1);\nALTER TABLE t DROP FOREIGN KEY f', 'PRIMARY(id) ka(x1) kz(x2) ix(x0,x1) | '],
  // ALTER 로 FK 를 붙여 자동 인덱스가 키 목록 끝에 있는 표
  ['added', 'ALTER TABLE t ADD INDEX ix (x0, x1)', 'PRIMARY(id) ka(x1) kz(x2) ix(x0,x1) | f'],
  ['added', 'ALTER TABLE t ADD INDEX ix (x1, x0)', 'PRIMARY(id) ka(x1) kz(x2) f(x0) ix(x1,x0) | f'],
  ['added', 'ALTER TABLE t DROP FOREIGN KEY f, ADD FOREIGN KEY (x0) REFERENCES par (id)', 'PRIMARY(id) ka(x1) kz(x2) x0(x0) | t_ibfk_1'],
  ['added', 'ALTER TABLE t DROP FOREIGN KEY f', 'PRIMARY(id) ka(x1) kz(x2) f(x0) | '],
  ['added', 'ALTER TABLE t DROP FOREIGN KEY f, ADD INDEX z (x0)', 'PRIMARY(id) ka(x1) kz(x2) z(x0) | '],
  // 직접 만든 인덱스 k0 가 FK 를 받친다 (자동 인덱스가 생기지 않았다)
  ['user', 'ALTER TABLE t ADD INDEX ix (x0, x1)', 'PRIMARY(id) ka(x1) k0(x0) kz(x2) ix(x0,x1) | f'],
  ['user', 'ALTER TABLE t ADD UNIQUE (x0)', 'PRIMARY(id) U:x0(x0) ka(x1) k0(x0) kz(x2) | f'],
  ['user', 'ALTER TABLE t DROP FOREIGN KEY f, ADD CONSTRAINT g FOREIGN KEY (x0) REFERENCES par (id)', 'PRIMARY(id) ka(x1) k0(x0) kz(x2) | g'],
  ['user', 'ALTER TABLE t DROP FOREIGN KEY f, ADD INDEX z (x0)', 'PRIMARY(id) ka(x1) k0(x0) kz(x2) z(x0) | '],
  ['user', 'ALTER TABLE t ADD CONSTRAINT h FOREIGN KEY (x0, x1) REFERENCES par2 (a, b)', 'PRIMARY(id) ka(x1) k0(x0) kz(x2) h(x0,x1) | f,h'],
  ['user', 'ALTER TABLE t ADD INDEX k0 (x0, x1)', 'error 1061'],
  ['user', 'ALTER TABLE t ADD CONSTRAINT h FOREIGN KEY (x0) REFERENCES par (id)', 'PRIMARY(id) ka(x1) k0(x0) kz(x2) | f,h'],
  ['user', 'ALTER TABLE t DROP FOREIGN KEY f, DROP INDEX k0', 'PRIMARY(id) ka(x1) kz(x2) | '],
  // 컬럼이 둘인 FK 의 자동 인덱스 (x0, x1)
  ['composite', 'ALTER TABLE t ADD CONSTRAINT h FOREIGN KEY (x0) REFERENCES par (id)', 'PRIMARY(id) ka(x1) f(x0,x1) kz(x2) | f,h'],
  ['composite', 'ALTER TABLE t ADD INDEX ix (x0, x1, x2)', 'PRIMARY(id) ka(x1) kz(x2) ix(x0,x1,x2) | f'],
  ['composite', 'ALTER TABLE t ADD INDEX ix (x0)', 'PRIMARY(id) ka(x1) f(x0,x1) kz(x2) ix(x0) | f'],
  ['composite', 'ALTER TABLE t ADD INDEX ix (x0, x1)', 'PRIMARY(id) ka(x1) kz(x2) ix(x0,x1) | f'],
  ['composite', 'ALTER TABLE t ADD UNIQUE (x0, x1)', 'PRIMARY(id) U:x0(x0,x1) ka(x1) kz(x2) | f'],
  // FK·받치는 인덱스가 없는 표: 절 순서와 자동 키 이름
  ['plain', 'ALTER TABLE t ADD FOREIGN KEY (x0) REFERENCES par (id), ADD INDEX ix (x1, x2)', 'PRIMARY(id) ka(x1) kz(x2) x0(x0) ix(x1,x2) | t_ibfk_1'],
  ['plain', 'ALTER TABLE t ADD INDEX ix (x1, x2), ADD FOREIGN KEY (x0) REFERENCES par (id)', 'PRIMARY(id) ka(x1) kz(x2) ix(x1,x2) x0(x0) | t_ibfk_1'],
  ['plain', 'ALTER TABLE t ADD INDEX ix (x2, x1), ADD FOREIGN KEY (x0) REFERENCES par (id), ADD INDEX iy (x1, x0)', 'PRIMARY(id) ka(x1) kz(x2) ix(x2,x1) x0(x0) iy(x1,x0) | t_ibfk_1'],
  ['plain', 'ALTER TABLE t ADD FOREIGN KEY (x0) REFERENCES par (id), ADD INDEX ix (x0, x1)', 'PRIMARY(id) ka(x1) kz(x2) ix(x0,x1) | t_ibfk_1'],
  ['plain', 'ALTER TABLE t ADD FOREIGN KEY (x0) REFERENCES par (id), ADD UNIQUE (x0)', 'PRIMARY(id) U:x0(x0) ka(x1) kz(x2) | t_ibfk_1'],
  ['plain', 'ALTER TABLE t ADD UNIQUE (x0), ADD FOREIGN KEY (x0) REFERENCES par (id)', 'PRIMARY(id) U:x0(x0) ka(x1) kz(x2) | t_ibfk_1'],
  ['plain', 'ALTER TABLE t ADD FOREIGN KEY (x0) REFERENCES par (id), ADD INDEX x0 (x1)', 'error 1061'],
  ['plain', 'ALTER TABLE t ADD INDEX x0 (x1), ADD FOREIGN KEY (x0) REFERENCES par (id)', 'PRIMARY(id) ka(x1) kz(x2) x0(x1) x0_2(x0) | t_ibfk_1'],
  ['plain', 'ALTER TABLE t ADD CONSTRAINT h1 FOREIGN KEY (x0) REFERENCES par (id), ADD CONSTRAINT h2 FOREIGN KEY (x0) REFERENCES par (id)', 'PRIMARY(id) ka(x1) kz(x2) h2(x0) | h1,h2'],
  ['plain', 'ALTER TABLE t ADD CONSTRAINT h1 FOREIGN KEY (x0, x1) REFERENCES par2 (a, b), ADD CONSTRAINT h2 FOREIGN KEY (x0) REFERENCES par (id)', 'PRIMARY(id) ka(x1) kz(x2) h1(x0,x1) | h1,h2'],
  ['plain', 'ALTER TABLE t ADD CONSTRAINT h2 FOREIGN KEY (x0) REFERENCES par (id), ADD CONSTRAINT h1 FOREIGN KEY (x0, x1) REFERENCES par2 (a, b)', 'PRIMARY(id) ka(x1) kz(x2) h1(x0,x1) | h1,h2'],
  ['plain', 'ALTER TABLE t ADD FOREIGN KEY (x0) REFERENCES par (id), ADD FOREIGN KEY (x0) REFERENCES par (id)', 'PRIMARY(id) ka(x1) kz(x2) x0(x0) | t_ibfk_1,t_ibfk_2'],
  // 문자열 FK 컬럼: FULLTEXT·prefix 길이
  ['text', 'ALTER TABLE t ADD FULLTEXT (v)', 'error 1553'],
  ['text', 'ALTER TABLE t ADD INDEX ix (v(5))', 'PRIMARY(id) ka(x1) f(v) ix(v(5)) | f'],
  ['text', 'ALTER TABLE t ADD INDEX ix (v(20))', 'PRIMARY(id) ka(x1) f(v) ix(v) | f'],
  ['text', 'ALTER TABLE t ADD INDEX ix (v, x1)', 'PRIMARY(id) ka(x1) ix(v,x1) | f'],
  ['text', 'ALTER TABLE t ADD INDEX ix (v(20), x1)', 'PRIMARY(id) ka(x1) f(v) ix(v,x1) | f'],
];

describe('ALTER TABLE — FK 자동 인덱스: MySQL 이 낸 결과와 같다', () => {
  it.each(CASES)('%s: %s', (variant, script, expected) => {
    if (expected.startsWith('error ')) {
      expect(run(variant, script)).toMatchObject({ ok: false, error: { reason: expect.stringContaining(`(MySQL ${expected.slice(6)})`) } });
      return;
    }
    expect(shown(tableT(ok(variant, script)))).toBe(expected);
  });
});

// 이름이 첫 컬럼(KEY x0 (x0))이면 FK 가 자동으로 만든 것인지 직접 만든 것인지 덤프만으로 알 수 없다. 자동이면 MySQL 이 지우거나 바꾸고 직접 만든 것이면 그대로 둔다 (실측).
// 두 읽기의 결과가 다른 문장은 거부하고 (인덱스 이름을 알리고 RE_EXPORT 로 끝난다), 같은 문장은 받는다
describe('ALTER TABLE — FK 자동 인덱스: 자동인지 알 수 없을 때', () => {
  const REJECTED = [
    'ALTER TABLE t ADD INDEX ix (x0, x1);',
    'ALTER TABLE t ADD UNIQUE (x0);',
    'CREATE INDEX ix ON t (x0, x1);',
    'ALTER TABLE t DROP PRIMARY KEY, ADD PRIMARY KEY (x0, id);',
    'ALTER TABLE t DROP FOREIGN KEY t_ibfk_1, ADD CONSTRAINT g FOREIGN KEY (x0) REFERENCES par (id);',
    'ALTER TABLE t DROP FOREIGN KEY t_ibfk_1, ADD INDEX z (x0);',
    'ALTER TABLE t ADD CONSTRAINT h FOREIGN KEY (x0) REFERENCES par (id);', // 같은 컬럼의 두 번째 FK: 자동 키라면 새 키가 대신한다
    'ALTER TABLE t ADD CONSTRAINT h FOREIGN KEY (x0, x1) REFERENCES par2 (a, b);', // 자동 키라면 더 긴 새 자동 키가 대신한다
  ];
  it.each(REJECTED)('거부: %s', (script) => {
    const r = run('unnamed', script);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toContain('`x0`');
    expect(r.error.reason).toContain('자동으로 만든 것인지');
    expect(r.error.reason.endsWith(RE_EXPORT)).toBe(true);
  });

  it.each([
    ['ALTER TABLE t ADD INDEX ix (x0, x1), ADD INDEX ix (x2);', '1061'], // 어느 쪽으로 읽어도 MySQL 오류인 문장은 그 오류가 먼저다
    ['ALTER TABLE t ADD INDEX ix (x0, x1), DROP INDEX nope;', '1091'],
  ])('거부 대신 MySQL 오류: %s', (script, errno) => {
    expect(run('unnamed', script)).toMatchObject({ ok: false, error: { reason: expect.stringContaining(`(MySQL ${errno})`) } });
  });

  const SAME_EITHER_WAY: [script: string, expected: string][] = [
    ['ALTER TABLE t ADD INDEX ix (x1, x0);', 'PRIMARY(id) ka(x1) x0(x0) kz(x2) ix(x1,x0) | t_ibfk_1'], // 앞쪽이 아니다
    ['ALTER TABLE t ADD INDEX ix (x0 DESC);', 'PRIMARY(id) ka(x1) x0(x0) kz(x2) ix(x0-desc) | t_ibfk_1'], // 방향이 다르다
    ['ALTER TABLE t ADD INDEX ix (x1);', 'PRIMARY(id) ka(x1) x0(x0) kz(x2) ix(x1) | t_ibfk_1'],
    ['ALTER TABLE t ENGINE=InnoDB;', 'PRIMARY(id) ka(x1) x0(x0) kz(x2) | t_ibfk_1'],
    ['ALTER TABLE t DROP FOREIGN KEY t_ibfk_1;', 'PRIMARY(id) ka(x1) x0(x0) kz(x2) | '], // FK 만 지우면 인덱스는 남는다
    ['ALTER TABLE t DROP FOREIGN KEY t_ibfk_1, ADD CONSTRAINT g FOREIGN KEY (x1) REFERENCES par (id);', 'PRIMARY(id) ka(x1) x0(x0) kz(x2) | g'], // ka 가 새 FK 를 받친다
    ['ALTER TABLE t DROP FOREIGN KEY t_ibfk_1, DROP INDEX x0;', 'PRIMARY(id) ka(x1) kz(x2) | '], // 인덱스도 함께 지운다
    ['ALTER TABLE t ADD FOREIGN KEY (x2) REFERENCES par (id);', 'PRIMARY(id) ka(x1) x0(x0) kz(x2) | t_ibfk_1,t_ibfk_2'], // kz 가 받친다
  ];
  it.each(SAME_EITHER_WAY)('받는다: %s', (script, expected) => {
    expect(shown(tableT(ok('unnamed', script)))).toBe(expected);
  });
});

// 한계: 덤프만으로 알 수 없는 것. 아래는 MySQL 과 다른 결과를 일부러 못 박는다 (고치려면 인덱스마다 '자동' 표시를 모델에 둬야 한다)
describe('ALTER TABLE — FK 자동 인덱스: 알려진 한계', () => {
  it('FOREIGN KEY 뒤에 쓴 인덱스 이름(ix_g)은 직접 만든 인덱스로 본다 — MySQL 은 자동 키라 ADD INDEX 때 지운다', () => {
    expect(shown(tableT(ok('ixname', 'ALTER TABLE t ADD INDEX ix (x0, x1);')))).toBe('PRIMARY(id) ka(x1) ix_g(x0) kz(x2) ix(x0,x1) | t_ibfk_1'); // MySQL: ka kz ix
  });

  it('앞 문장에서 이 스크립트가 직접 더한 인덱스도 이름이 첫 컬럼이면 알 수 없는 인덱스로 본다 — MySQL 은 직접 만든 것이라 남긴다', () => {
    const script = 'ALTER TABLE t ADD INDEX (x0);\nALTER TABLE t ADD INDEX ix (x0, x1);';
    const r = run('named', script); // MySQL: PRIMARY(id) ka(x1) kz(x2) x0(x0) ix(x0,x1) | f
    expect(r).toMatchObject({ ok: false, error: { index: 2, reason: expect.stringContaining('`x0`') } });
  });

  it('앞 문장에서 FK 만 지우면 남은 자동 인덱스를 더는 알아보지 못한다 — MySQL 은 뒤 문장의 새 인덱스·FK 가 대신한다', () => {
    const script = 'ALTER TABLE t DROP FOREIGN KEY f;\nALTER TABLE t ADD INDEX z (x0);';
    expect(shown(tableT(ok('named', script)))).toBe('PRIMARY(id) ka(x1) f(x0) kz(x2) z(x0) | '); // MySQL: ka kz z
  });
});
