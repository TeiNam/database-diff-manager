// ALTER TABLE — FK 가 자동으로 만든 인덱스 (MySQL 8.0.46·8.4.11 실측, 두 버전 결과가 같다)
//
// MySQL 은 FK 마다 "자동 키" 후보를 하나 만들고(sql_table.cc mysql_prepare_create_table·foreign_key_prefix), 같은 컬럼으로 시작하는 다른 키가 있으면 자동 키를 버린다.
// 키 목록은 [문장 뒤에 남은 기존 키] + [문장에서 더한 키·FK 의 자동 키, 절 순서] 이고, 자동 키 여부는 SHOW CREATE 에 안 나오지만 테이블에 남는다.
// - 자동 키 g 는 다른 키 n 이 앞쪽 파트(컬럼 이름·prefix 길이·정렬 방향)를 g 와 똑같이 가지면 버려진다. n 의 종류(UNIQUE·PRIMARY·FULLTEXT)·가시성은 상관없다.
//   둘 다 자동 키면 짧은 쪽이, 길이가 같으면 앞선 쪽이 버려진다. 직접 만든 인덱스는 버려지지 않는다
// - 버려질 키는 이름을 차지하지 않는다 (같은 이름의 인덱스를 더해도 1061 이 아니다). 살아남은 키는 키 목록 순서대로 이름을 받는다
// - 자동 키 표시는 FK 를 지워도 남고(앞 문장에서 FK 만 지운 뒤 같은 컬럼에 새 인덱스·FK 가 오면 남은 자동 인덱스를 대신한다), 컬럼·테이블 이름 변경·보이기 바꾸기·FORCE 에도 남는다.
//   RENAME INDEX 만 표시를 지운다 (원래 이름으로 되돌려도 그대로 직접 만든 인덱스다)
// - 자동 키는 FK 를 더한 절의 자리에 만들어진다 (뒤에 오는 일반 인덱스보다 앞). 새 FK 가 같은 컬럼의 자동 키를 대신하면 키 목록 끝으로 옮겨진다
// 덤프(SHOW CREATE)로는 자동 키인지 알 수 없어 이름으로 가린다: FK 이름과 같으면 자동, FK 첫 컬럼 이름(또는 <컬럼>_N)이면 — FK 이름이 <테이블>_ibfk_N 꼴일 때만 — 알 수 없음(문장 결과가 달라지면 거부),
// 그 밖은 직접 만든 것. 이 실행(applyScript) 안에서 만든 인덱스는 출처(auto·user)를 기억해 이름보다 먼저 쓴다
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
  colkey: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ka` (`x1`),\n  KEY `x0` (`x0`),\n  KEY `kz` (`x2`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;', // colkey: FK 없이 직접 만든 KEY x0 (x0) — 이름이 첫 컬럼이다
  shrink: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `k` (`x1`,`x0`),\n  KEY `f` (`x0`),\n  KEY `kz` (`x2`),\n  CONSTRAINT `f` FOREIGN KEY (`x0`) REFERENCES `par` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;', // shrink: KEY k (x1, x0) + 자동 f (x0) — x1 을 지우면 k 가 (x0) 가 된다
  shrinku: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `k` (`x1`,`x0`),\n  KEY `x0` (`x0`),\n  KEY `kz` (`x2`),\n  CONSTRAINT `t_ibfk_1` FOREIGN KEY (`x0`) REFERENCES `par` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;', // shrinku: 같은 모양인데 FK 가 이름 없음 (자동 인덱스 x0, FK t_ibfk_1)
  shrinkuser: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `k` (`x1`,`x0`),\n  KEY `k0` (`x0`),\n  KEY `kz` (`x2`),\n  CONSTRAINT `f` FOREIGN KEY (`x0`) REFERENCES `par` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;', // shrinkuser: k (x1, x0) + 직접 만든 k0 (x0) + FK f
  shrink3: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `k` (`x1`,`x2`,`x0`),\n  KEY `f` (`x0`),\n  CONSTRAINT `f` FOREIGN KEY (`x0`) REFERENCES `par` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;', // shrink3: KEY k (x1, x2, x0) + 자동 f (x0)
  shrinkuq: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `u` (`x1`,`x0`),\n  KEY `f` (`x0`),\n  KEY `kz` (`x2`),\n  CONSTRAINT `f` FOREIGN KEY (`x0`) REFERENCES `par` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;', // shrinkuq: UNIQUE KEY u (x1, x0) + 자동 f (x0)
  shrinkcomp: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `k` (`x2`,`x0`,`x1`),\n  KEY `f` (`x0`,`x1`),\n  CONSTRAINT `f` FOREIGN KEY (`x0`, `x1`) REFERENCES `par2` (`a`, `b`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;', // shrinkcomp: KEY k (x2, x0, x1) + FK f (x0, x1) 의 자동 f (x0, x1)
  shrinklong: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `k` (`x1`,`x0`),\n  KEY `f` (`x0`,`x2`),\n  CONSTRAINT `f` FOREIGN KEY (`x0`, `x2`) REFERENCES `par2` (`a`, `b`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;', // shrinklong: KEY k (x1, x0) + FK f (x0, x2) 의 자동 f (x0, x2)
  twoauto: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `f1` (`x1`,`x0`),\n  KEY `f2` (`x0`),\n  CONSTRAINT `f1` FOREIGN KEY (`x1`, `x0`) REFERENCES `par2` (`a`, `b`),\n  CONSTRAINT `f2` FOREIGN KEY (`x0`) REFERENCES `par` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;', // twoauto: 자동 f1 (x1, x0) 다음 자동 f2 (x0)
  twoauto2: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `f2` (`x0`),\n  KEY `f1` (`x1`,`x0`),\n  CONSTRAINT `f1` FOREIGN KEY (`x1`, `x0`) REFERENCES `par2` (`a`, `b`),\n  CONSTRAINT `f2` FOREIGN KEY (`x0`) REFERENCES `par` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;', // twoauto2: 자동 f2 (x0) 다음 자동 f1 (x1, x0)
  autoshrink: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `k0` (`x0`),\n  KEY `f` (`x1`,`x0`),\n  KEY `kz` (`x2`),\n  CONSTRAINT `f` FOREIGN KEY (`x1`, `x0`) REFERENCES `par2` (`a`, `b`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;', // autoshrink: 직접 만든 k0 (x0) + FK f (x1, x0) 의 자동 f (x1, x0)
  two: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ka` (`x1`),\n  KEY `f` (`x0`),\n  KEY `g` (`x2`),\n  CONSTRAINT `f` FOREIGN KEY (`x0`) REFERENCES `par` (`id`),\n  CONSTRAINT `g` FOREIGN KEY (`x2`) REFERENCES `par` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;', // two: FK f (x0)·g (x2) 둘의 자동 인덱스
  fkcol: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ka` (`x1`),\n  KEY `x0` (`x0`),\n  KEY `kz` (`x2`),\n  CONSTRAINT `fk_a` FOREIGN KEY (`x0`) REFERENCES `par` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;', // fkcol: 직접 만든 KEY x0 (x0) + CONSTRAINT fk_a (이름이 첫 컬럼이어도 FK 이름이 자동 꼴이 아니다)
  sym: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ka` (`x1`),\n  KEY `fk_a` (`x0`),\n  KEY `kz` (`x2`),\n  CONSTRAINT `fk_a` FOREIGN KEY (`x0`) REFERENCES `par` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;', // sym: CONSTRAINT fk_a FOREIGN KEY ix_n (x0) — 자동 인덱스 이름은 CONSTRAINT 이름 fk_a
  symcol: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `x0` int DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  `x2` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ka` (`x1`),\n  KEY `fk_a` (`x0`),\n  KEY `kz` (`x2`),\n  CONSTRAINT `fk_a` FOREIGN KEY (`x0`) REFERENCES `par` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;', // symcol: CONSTRAINT fk_a FOREIGN KEY x0 (x0) — 역시 fk_a
  text: 'CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `v` varchar(20) DEFAULT NULL,\n  `x1` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ka` (`x1`),\n  KEY `f` (`v`),\n  CONSTRAINT `f` FOREIGN KEY (`v`) REFERENCES `parv` (`v`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
};
const baseOf = (variant: string): SchemaModel => parseSqlDump(tdExport([...PARENTS, BASES[variant]].join('\n\n'))).model;
const tableT = (model: SchemaModel): Table => model.tables.find((t) => t.name === 't' || t.name === 't2')!; // t2: 같은 시나리오에서 이름을 바꾼 테이블
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
  // ALTER INDEX … VISIBLE|INVISIBLE 가 같은 문장이 버리는 자동 인덱스를 가리키면 1176 (자동 키가 먼저 버려져 대상이 없다). 절 순서·버리는 키의 종류(인덱스·UNIQUE·새 FK)·FK 만 지운 뒤 남은 자동 인덱스와 상관없다
  ['named', 'ALTER TABLE t ALTER INDEX f INVISIBLE, ADD INDEX ix (x0);', 'error 1176'],
  ['named', 'ALTER TABLE t ALTER INDEX f VISIBLE, ADD INDEX ix (x0, x1);', 'error 1176'],
  ['named', 'ALTER TABLE t ADD INDEX ix (x0), ALTER INDEX f INVISIBLE;', 'error 1176'],
  ['named', 'ALTER TABLE t ALTER INDEX f INVISIBLE, ADD UNIQUE (x0);', 'error 1176'],
  ['named', 'ALTER TABLE t ALTER INDEX f INVISIBLE, ADD CONSTRAINT h FOREIGN KEY (x0) REFERENCES par (id);', 'error 1176'],
  ['named', 'ALTER TABLE t ALTER INDEX f INVISIBLE, ALTER INDEX ka INVISIBLE, ADD INDEX ix (x0);', 'error 1176'],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f;\nALTER TABLE t ALTER INDEX f INVISIBLE, ADD INDEX z (x0);', 'error 1176'],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f, ALTER INDEX f INVISIBLE, ADD INDEX z (x0);', 'error 1176'],
  ['plain', 'ALTER TABLE t ADD FOREIGN KEY (x0) REFERENCES par (id);\nALTER TABLE t ALTER INDEX x0 INVISIBLE, ADD INDEX ix (x0);', 'error 1176'],
  // 같은 문장의 다른 오류와 겹치면: 인덱스 이름 충돌(1061)·없는 컬럼(1072)이 먼저고(자동 키를 버린 뒤에야 대상이 없는 것이 드러난다), 처음부터 없는 대상(1176)은 이름 충돌보다 먼저다
  ['named', 'ALTER TABLE t ALTER INDEX f INVISIBLE, ADD INDEX ka (x0, x1);', 'error 1061'],
  ['named', 'ALTER TABLE t ALTER INDEX f INVISIBLE, ADD INDEX ix (x0, nope);', 'error 1072'],
  ['named', 'ALTER TABLE t ALTER INDEX nope INVISIBLE, ADD INDEX ka (x0);', 'error 1176'],
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

// 문장이 여럿인 스크립트: 앞 문장이 남긴 출처(FK 가 만든 자동 인덱스·직접 더한 인덱스·RENAME INDEX)를 기억해 MySQL 이 낸 결과와 같다
const SCRIPT_CASES: [variant: string, script: string, expected: string][] = [
  // 고아 자동 인덱스: 앞 문장에서 FK 만 지우고, 뒤 문장이 같은 컬럼을 건드린다
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f;\nALTER TABLE t ADD INDEX z (x0);', 'PRIMARY(id) ka(x1) kz(x2) z(x0) | '],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f;\nALTER TABLE t ADD INDEX z (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) z(x0,x1) | '],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f;\nALTER TABLE t ADD CONSTRAINT g FOREIGN KEY (x0) REFERENCES par (id);', 'PRIMARY(id) ka(x1) kz(x2) g(x0) | g'],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f;\nALTER TABLE t ADD FOREIGN KEY (x0) REFERENCES par (id);', 'PRIMARY(id) ka(x1) kz(x2) x0(x0) | t_ibfk_1'],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f;\nALTER TABLE t ADD FOREIGN KEY ix_n (x0) REFERENCES par (id);', 'PRIMARY(id) ka(x1) kz(x2) ix_n(x0) | t_ibfk_1'],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f;\nALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (x0) REFERENCES par (id);', 'PRIMARY(id) ka(x1) kz(x2) f(x0) | f'],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f;\nALTER TABLE t ADD CONSTRAINT g FOREIGN KEY (x1) REFERENCES par (id);\nALTER TABLE t ADD INDEX z (x0);', 'PRIMARY(id) ka(x1) kz(x2) z(x0) | g'],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f;\nALTER TABLE t ADD INDEX (x0);', 'PRIMARY(id) ka(x1) kz(x2) x0(x0) | '],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f;\nALTER TABLE t CHANGE x0 y0 int;\nALTER TABLE t ADD INDEX z (y0);', 'PRIMARY(id) ka(x1) kz(x2) z(y0) | '],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f;\nALTER TABLE t RENAME TO t2;\nALTER TABLE t2 ADD INDEX z (x0);', 'PRIMARY(id) ka(x1) kz(x2) z(x0) | '],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f, RENAME TO t2;\nALTER TABLE t2 ADD INDEX z (x0);', 'PRIMARY(id) ka(x1) kz(x2) z(x0) | '],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f;\nALTER TABLE t ADD INDEX f2 (x1, x0);\nALTER TABLE t ADD INDEX z (x0);', 'PRIMARY(id) ka(x1) kz(x2) f2(x1,x0) z(x0) | '],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f;\nALTER TABLE t DROP INDEX f;\nALTER TABLE t ADD INDEX f (x0);\nALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) f(x0) ix(x0,x1) | '],
  ['named', 'ALTER TABLE t ADD CONSTRAINT h FOREIGN KEY (x0) REFERENCES par (id);\nALTER TABLE t DROP FOREIGN KEY h;\nALTER TABLE t ADD INDEX z (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) z(x0,x1) | f'],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f;\nALTER TABLE t ADD FOREIGN KEY (x0) REFERENCES par (id);\nALTER TABLE t ADD INDEX z (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) z(x0,x1) | t_ibfk_1'],
  ['added', 'ALTER TABLE t DROP FOREIGN KEY f;\nALTER TABLE t ADD INDEX z (x0);', 'PRIMARY(id) ka(x1) kz(x2) z(x0) | '],
  ['two', 'ALTER TABLE t DROP FOREIGN KEY f;\nALTER TABLE t ADD INDEX z (x0);', 'PRIMARY(id) ka(x1) g(x2) z(x0) | g'],
  ['two', 'ALTER TABLE t DROP FOREIGN KEY g;\nALTER TABLE t ADD INDEX z (x2, x0);', 'PRIMARY(id) ka(x1) f(x0) z(x2,x0) | f'],
  ['user', 'ALTER TABLE t DROP FOREIGN KEY f;\nALTER TABLE t ADD INDEX z (x0);', 'PRIMARY(id) ka(x1) k0(x0) kz(x2) z(x0) | '],
  ['sym', 'ALTER TABLE t DROP FOREIGN KEY fk_a;\nALTER TABLE t ADD INDEX z (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) z(x0,x1) | '],
  ['fkcol', 'ALTER TABLE t DROP FOREIGN KEY fk_a;\nALTER TABLE t ADD INDEX z (x0, x1);', 'PRIMARY(id) ka(x1) x0(x0) kz(x2) z(x0,x1) | '],
  // RENAME INDEX 는 자동 표시를 지운다 (다시 원래 이름으로 바꿔도 그대로다)
  ['named', 'ALTER TABLE t RENAME INDEX f TO g;\nALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) g(x0) kz(x2) ix(x0,x1) | f'],
  ['named', 'ALTER TABLE t RENAME INDEX f TO g;\nALTER TABLE t RENAME INDEX g TO f;\nALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) f(x0) kz(x2) ix(x0,x1) | f'],
  ['named', 'ALTER TABLE t DROP FOREIGN KEY f;\nALTER TABLE t RENAME INDEX f TO g;\nALTER TABLE t ADD INDEX z (x0);', 'PRIMARY(id) ka(x1) g(x0) kz(x2) z(x0) | '],
  ['named', 'ALTER TABLE t RENAME INDEX f TO f2;\nALTER TABLE t ADD CONSTRAINT h FOREIGN KEY (x0) REFERENCES par (id);', 'PRIMARY(id) ka(x1) f2(x0) kz(x2) | f,h'],
  ['named', 'ALTER TABLE t RENAME INDEX f TO g, ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) g(x0) kz(x2) ix(x0,x1) | f'],
  ['unnamed', 'ALTER TABLE t RENAME INDEX x0 TO y0;\nALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) y0(x0) kz(x2) ix(x0,x1) | t_ibfk_1'],
  ['unnamed', 'ALTER TABLE t RENAME INDEX x0 TO y0;\nALTER TABLE t RENAME INDEX y0 TO x0;\nALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) x0(x0) kz(x2) ix(x0,x1) | t_ibfk_1'],
  ['plain', 'ALTER TABLE t ADD FOREIGN KEY (x0) REFERENCES par (id);\nALTER TABLE t RENAME INDEX x0 TO y0;\nALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) y0(x0) ix(x0,x1) | t_ibfk_1'],
  ['plain', 'ALTER TABLE t ADD FOREIGN KEY (x0) REFERENCES par (id);\nALTER TABLE t DROP FOREIGN KEY t_ibfk_1;\nALTER TABLE t RENAME INDEX x0 TO y0;\nALTER TABLE t ADD INDEX z (x0);', 'PRIMARY(id) ka(x1) kz(x2) y0(x0) z(x0) | '],
  // 보이기 바꾸기·테이블 이름 바꾸기·FORCE 는 자동 표시를 지우지 않는다
  ['named', 'ALTER TABLE t ALTER INDEX f INVISIBLE;\nALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) ix(x0,x1) | f'],
  ['named', 'ALTER TABLE t ALTER INDEX f INVISIBLE;\nALTER TABLE t ALTER INDEX f VISIBLE;\nALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) ix(x0,x1) | f'],
  ['named', 'ALTER TABLE t RENAME TO t2;\nALTER TABLE t2 ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) ix(x0,x1) | f'],
  ['named', 'ALTER TABLE t FORCE;\nALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) ix(x0,x1) | f'],
  ['plain', 'ALTER TABLE t ADD FOREIGN KEY (x0) REFERENCES par (id);\nALTER TABLE t ALTER INDEX x0 INVISIBLE;\nALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) ix(x0,x1) | t_ibfk_1'],
  ['plain', 'ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (x0) REFERENCES par (id);\nALTER TABLE t RENAME TO t2;\nALTER TABLE t2 ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) ix(x0,x1) | f'],
  // 이 스크립트가 만든 인덱스: FK 가 만든 것은 자동, ADD INDEX 로 더한 것은 직접 만든 것 (이름이 첫 컬럼이어도)
  ['plain', 'ALTER TABLE t ADD FOREIGN KEY (x0) REFERENCES par (id);\nALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) ix(x0,x1) | t_ibfk_1'],
  ['plain', 'ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (x0) REFERENCES par (id);\nALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) ix(x0,x1) | f'],
  ['plain', 'ALTER TABLE t ADD FOREIGN KEY ixn (x0) REFERENCES par (id);\nALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) ix(x0,x1) | t_ibfk_1'],
  ['plain', 'ALTER TABLE t ADD INDEX x0 (x0);\nALTER TABLE t ADD FOREIGN KEY (x0) REFERENCES par (id);\nALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) x0(x0) ix(x0,x1) | t_ibfk_1'],
  ['plain', 'ALTER TABLE t ADD INDEX (x0);\nALTER TABLE t ADD FOREIGN KEY (x0) REFERENCES par (id);\nALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) x0(x0) ix(x0,x1) | t_ibfk_1'],
  ['plain', 'ALTER TABLE t ADD FOREIGN KEY (x0) REFERENCES par (id);\nALTER TABLE t DROP FOREIGN KEY t_ibfk_1;\nALTER TABLE t ADD INDEX z (x0);', 'PRIMARY(id) ka(x1) kz(x2) z(x0) | '],
  ['plain', 'ALTER TABLE t ADD FOREIGN KEY ixn (x0) REFERENCES par (id);\nALTER TABLE t DROP FOREIGN KEY t_ibfk_1;\nALTER TABLE t ADD CONSTRAINT g FOREIGN KEY (x0) REFERENCES par (id);', 'PRIMARY(id) ka(x1) kz(x2) g(x0) | g'],
  ['named', 'ALTER TABLE t ADD INDEX (x0);\nALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) x0(x0) ix(x0,x1) | f'],
  // FK 이름이 <테이블>_ibfk_N 꼴이 아니면 첫 컬럼 이름 인덱스는 직접 만든 것이다 (CONSTRAINT 이름이 있으면 자동 인덱스는 늘 그 이름)
  ['fkcol', 'ALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) x0(x0) kz(x2) ix(x0,x1) | fk_a'],
  ['sym', 'ALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) ix(x0,x1) | fk_a'],
  ['symcol', 'ALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) ix(x0,x1) | fk_a'],
  ['plain', 'ALTER TABLE t ADD CONSTRAINT fk_a FOREIGN KEY ixn (x0) REFERENCES par (id);', 'PRIMARY(id) ka(x1) kz(x2) fk_a(x0) | fk_a'],
  ['plain', 'ALTER TABLE t ADD CONSTRAINT fk_a FOREIGN KEY x0 (x0) REFERENCES par (id);', 'PRIMARY(id) ka(x1) kz(x2) fk_a(x0) | fk_a'],
  ['plain', 'ALTER TABLE t ADD CONSTRAINT t_ibfk_7 FOREIGN KEY (x0) REFERENCES par (id);', 'PRIMARY(id) ka(x1) kz(x2) t_ibfk_7(x0) | t_ibfk_7'],
  // 이미 있던 인덱스가 새 FK 를 받치면 그 인덱스는 FK 가 만든 것이 아니다 (FK 이름이 <테이블>_ibfk_N 꼴이어도 첫 컬럼 이름 인덱스를 알 수 없음으로 보지 않는다)
  ['fkcol', 'ALTER TABLE t ADD FOREIGN KEY (x0) REFERENCES par (id);\nALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) x0(x0) kz(x2) ix(x0,x1) | fk_a,t_ibfk_1'],
  ['colkey', 'ALTER TABLE t ADD FOREIGN KEY (x0) REFERENCES par (id);\nALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) x0(x0) kz(x2) ix(x0,x1) | t_ibfk_1'],
  ['colkey', 'ALTER TABLE t ADD FOREIGN KEY (x0) REFERENCES par (id);\nALTER TABLE t DROP FOREIGN KEY t_ibfk_1;\nALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) x0(x0) kz(x2) ix(x0,x1) | '],
  ['colkey', 'ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (x0) REFERENCES par (id);\nALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) x0(x0) kz(x2) ix(x0,x1) | f'],
  ['colkey', 'ALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) x0(x0) kz(x2) ix(x0,x1) | '],
  // ALTER INDEX 가 버려지지 않는 인덱스를 가리키면 받는다: 자동 인덱스를 못 덮는 키와 함께, 직접 만든 인덱스·스크립트가 더한 인덱스, 문장을 나눈 경우
  ['named', 'ALTER TABLE t ALTER INDEX f INVISIBLE, ADD INDEX ix (x1, x0);', 'PRIMARY(id) ka(x1) f(x0) kz(x2) ix(x1,x0) | f'],
  ['named', 'ALTER TABLE t ALTER INDEX ka INVISIBLE, ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) ix(x0,x1) | f'],
  ['user', 'ALTER TABLE t ALTER INDEX k0 INVISIBLE, ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) k0(x0) kz(x2) ix(x0,x1) | f'],
  ['plain', 'ALTER TABLE t ADD INDEX x0 (x0);\nALTER TABLE t ADD FOREIGN KEY (x0) REFERENCES par (id);\nALTER TABLE t ALTER INDEX x0 INVISIBLE, ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) x0(x0) ix(x0,x1) | t_ibfk_1'],
  ['named', 'ALTER TABLE t ALTER INDEX f INVISIBLE;\nALTER TABLE t ADD INDEX ix (x0);', 'PRIMARY(id) ka(x1) kz(x2) ix(x0) | f'],
  ['named', 'ALTER TABLE t ALTER INDEX f INVISIBLE, ADD INDEX f (x0, x1);', 'PRIMARY(id) ka(x1) kz(x2) f(x0,x1) | f'], // 같은 이름의 새 f 가 자동 f 를 대신해 대상이 있다 (새 f 는 보이는 채로 남는다)
  ['unnamed', 'ALTER TABLE t ALTER INDEX x0 INVISIBLE, ADD INDEX ix (x1, x0);', 'PRIMARY(id) ka(x1) x0(x0) kz(x2) ix(x1,x0) | t_ibfk_1'],
  // DROP COLUMN 이 기존 키의 앞쪽을 줄여 FK 자동 인덱스와 같아지면 자동 인덱스가 버려진다 (키 종류·컬럼 수와 상관없다; 직접 만든 인덱스끼리는 버리지 않는다)
  ['shrink', 'ALTER TABLE t DROP COLUMN x1;', 'PRIMARY(id) k(x0) kz(x2) | f'],
  ['shrink', 'ALTER TABLE t DROP FOREIGN KEY f;\nALTER TABLE t DROP COLUMN x1;', 'PRIMARY(id) k(x0) kz(x2) | '],
  ['shrink', 'ALTER TABLE t DROP FOREIGN KEY f, DROP COLUMN x1;', 'PRIMARY(id) k(x0) kz(x2) | '],
  ['shrink', 'ALTER TABLE t DROP COLUMN x1, ADD INDEX z (x2);', 'PRIMARY(id) k(x0) kz(x2) z(x2) | f'],
  ['shrink', 'ALTER TABLE t DROP COLUMN x2;', 'PRIMARY(id) k(x1,x0) f(x0) | f'],
  ['shrinkuser', 'ALTER TABLE t DROP COLUMN x1;', 'PRIMARY(id) k(x0) k0(x0) kz(x2) | f'],
  ['shrink3', 'ALTER TABLE t DROP COLUMN x1;', 'PRIMARY(id) k(x2,x0) f(x0) | f'],
  ['shrink3', 'ALTER TABLE t DROP COLUMN x2;', 'PRIMARY(id) k(x1,x0) f(x0) | f'],
  ['shrink3', 'ALTER TABLE t DROP COLUMN x1, DROP COLUMN x2;', 'PRIMARY(id) k(x0) | f'],
  ['shrinkuq', 'ALTER TABLE t DROP COLUMN x1;', 'PRIMARY(id) U:u(x0) kz(x2) | f'],
  ['shrinkcomp', 'ALTER TABLE t DROP COLUMN x2;', 'PRIMARY(id) k(x0,x1) | f'],
  ['shrinklong', 'ALTER TABLE t DROP COLUMN x1;', 'PRIMARY(id) k(x0) f(x0,x2) | f'],
  ['twoauto', 'ALTER TABLE t DROP FOREIGN KEY f1, DROP COLUMN x1;', 'PRIMARY(id) f2(x0) | f2'],
  ['twoauto2', 'ALTER TABLE t DROP FOREIGN KEY f1, DROP COLUMN x1;', 'PRIMARY(id) f1(x0) | f2'],
  ['twoauto', 'ALTER TABLE t DROP FOREIGN KEY f1;\nALTER TABLE t DROP COLUMN x1;', 'PRIMARY(id) f2(x0) | f2'],
  ['autoshrink', 'ALTER TABLE t DROP FOREIGN KEY f, DROP COLUMN x1;', 'PRIMARY(id) k0(x0) kz(x2) | '],
  ['shrinku', 'ALTER TABLE t DROP COLUMN x2;', 'PRIMARY(id) k(x1,x0) x0(x0) | t_ibfk_1'],
  // RENAME INDEX 는 옛 이름·새 이름을 자동 분류에서 뺀다: 이름을 이어받은 인덱스를 자동 인덱스로 보지 않는다
  ['named', 'ALTER TABLE t RENAME INDEX f TO g, RENAME INDEX ka TO f, ADD INDEX ix (x1, x2);', 'PRIMARY(id) f(x1) g(x0) kz(x2) ix(x1,x2) | f'],
  ['named', 'ALTER TABLE t RENAME INDEX f TO g, RENAME INDEX ka TO f, ADD INDEX ix (x0, x1);', 'PRIMARY(id) f(x1) g(x0) kz(x2) ix(x0,x1) | f'],
  ['named', 'ALTER TABLE t RENAME INDEX f TO F, ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) F(x0) kz(x2) ix(x0,x1) | f'],
  ['named', 'ALTER TABLE t RENAME INDEX f TO F;\nALTER TABLE t ADD INDEX ix (x0, x1);', 'PRIMARY(id) ka(x1) F(x0) kz(x2) ix(x0,x1) | f'],
  ['unnamed', 'ALTER TABLE t RENAME INDEX x0 TO y0, RENAME INDEX ka TO x0, ADD INDEX ix (x1, x2);', 'PRIMARY(id) x0(x1) y0(x0) kz(x2) ix(x1,x2) | t_ibfk_1'],
];

describe('ALTER TABLE — FK 자동 인덱스: 스크립트 안에서 출처를 기억한다', () => {
  it.each(SCRIPT_CASES)('%s: %s', (variant, script, expected) => {
    expect(shown(tableT(ok(variant, script)))).toBe(expected);
  });
});

describe('ALTER TABLE — DROP COLUMN 이 줄인 키가 자동인지 알 수 없는 인덱스를 버릴 때', () => {
  // shrinku: KEY k (x1, x0) + FK t_ibfk_1 의 이름이 첫 컬럼인 인덱스 x0 — x1 을 지우면 k 가 (x0) 가 되어, x0 이 자동이면 MySQL 이 버리고 직접 만든 것이면 남긴다
  it.each([
    'ALTER TABLE t DROP COLUMN x1;',
    'ALTER TABLE t DROP FOREIGN KEY t_ibfk_1;\nALTER TABLE t DROP COLUMN x1;', // FK 를 지운 뒤에도 알 수 없다는 사실이 이어진다
  ])('거부: %j', (script) => {
    const r = run('shrinku', script);
    expect(r).toMatchObject({ ok: false, error: { reason: expect.stringContaining('`x0`') } });
    if (!r.ok) expect(r.error.reason.endsWith(RE_EXPORT)).toBe(true);
  });
});

describe('ALTER TABLE — ALTER INDEX 와 같은 문장이 버리는 FK 자동 인덱스', () => {
  it('거부 메시지는 인덱스 이름과 MySQL 1176 을 말한다', () => {
    const r = run('named', 'ALTER TABLE t ALTER INDEX f INVISIBLE, ADD INDEX ix (x0);');
    expect(r).toMatchObject({ ok: false, error: { index: 1, reason: expect.stringMatching(/`f`.*\(MySQL 1176\)/) } });
  });

  it('같은 이름의 새 인덱스가 자동 인덱스를 대신하면 ALTER INDEX 는 받고 새 인덱스는 보이는 채로 남는다 (MySQL 8.0.46·8.4.11 실측)', () => {
    const t = tableT(ok('named', 'ALTER TABLE t ALTER INDEX f INVISIBLE, ADD INDEX f (x0, x1);'));
    expect(t.indexes.find((i) => i.name === 'f')).toMatchObject({ parts: [{ column: 'x0' }, { column: 'x1' }], invisible: false });
  });

  it('자동 인덱스를 덮지 못하는 키와 함께면 INVISIBLE 이 적용되고 자동 인덱스는 남는다', () => {
    const t = tableT(ok('named', 'ALTER TABLE t ALTER INDEX f INVISIBLE, ADD INDEX ix (x1, x0);'));
    expect(t.indexes.find((i) => i.name === 'f')!.invisible).toBe(true);
    expect(t.indexes.find((i) => i.name === 'ix')!.invisible).toBe(false);
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
    'ALTER TABLE t ALTER INDEX x0 INVISIBLE, ADD INDEX ix (x0);', // 자동이면 MySQL 은 1176, 직접 만든 것이면 받는다 — 1176 이 아니라 재추출 안내
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

  // 알 수 없다는 사실도 문장을 넘어 이어진다: FK 를 지운 뒤에도, 테이블 이름을 바꾼 뒤에도 (MySQL 은 자동 표시가 남아 있으면 지우고 없으면 남긴다)
  it.each([
    'ALTER TABLE t DROP FOREIGN KEY t_ibfk_1;\nALTER TABLE t ADD INDEX ix (x0, x1);',
    'ALTER TABLE t DROP FOREIGN KEY t_ibfk_1;\nALTER TABLE t ADD FOREIGN KEY (x0) REFERENCES par (id);', // 자동이면 새 자동 키가 끝으로 옮겨 가고 직접 만든 것이면 그 자리에 남는다
    'ALTER TABLE t DROP FOREIGN KEY t_ibfk_1, RENAME TO t2;\nALTER TABLE t2 ADD INDEX ix (x0, x1);',
    'ALTER TABLE t RENAME TO t2;\nALTER TABLE t2 ADD INDEX ix (x0, x1);',
  ])('뒤 문장이 거부한다: %j', (script) => {
    const r = run('unnamed', script);
    expect(r).toMatchObject({ ok: false, error: { index: 2, reason: expect.stringContaining('`x0`') } });
    if (!r.ok) expect(r.error.reason.endsWith(RE_EXPORT)).toBe(true);
  });

  it('FK 를 지운 뒤에도 받침을 가리지 않는 문장은 받는다 — 인덱스가 그대로 남는다', () => {
    const script = 'ALTER TABLE t DROP FOREIGN KEY t_ibfk_1;\nALTER TABLE t ADD INDEX ix (x1, x0);';
    expect(shown(tableT(ok('unnamed', script)))).toBe('PRIMARY(id) ka(x1) x0(x0) kz(x2) ix(x1,x0) | ');
  });
});

// 알려진 한계: 덤프(SHOW CREATE)에는 자동 표시가 없다. 이 실행 안에서 만든 인덱스는 위 표처럼 따라가지만, 기준 덤프나 앞선 업로드에서 온 인덱스는 이름으로만 가린다.
// 아래는 MySQL 과 다른 결과를 일부러 못 박는다
describe('ALTER TABLE — FK 자동 인덱스: 알려진 한계', () => {
  it('FOREIGN KEY 뒤에 쓴 인덱스 이름(ix_g)은 덤프에서 직접 만든 인덱스로 본다 — MySQL 은 자동 키라 ADD INDEX 때 지운다', () => {
    expect(shown(tableT(ok('ixname', 'ALTER TABLE t ADD INDEX ix (x0, x1);')))).toBe('PRIMARY(id) ka(x1) ix_g(x0) kz(x2) ix(x0,x1) | t_ibfk_1'); // MySQL: ka kz ix
  });

  it('기준 덤프에 FK 없이 남은 인덱스(앞선 업로드에서 FK 만 지운 자동 인덱스)는 직접 만든 것으로 본다 — 라이브 DB 는 표시가 남아 새 인덱스가 대신한다', () => {
    const leftover = parseSqlDump(tdExport([...PARENTS, BASES.named.replace(/,\n  CONSTRAINT `f` FOREIGN KEY \(`x0`\) REFERENCES `par` \(`id`\)/, '')].join('\n\n'))).model;
    const r = applyScript(leftover, 'ALTER TABLE t ADD INDEX z (x0);', { schemaName: 'shop' });
    expect(r.ok && shown(tableT(r.model))).toBe('PRIMARY(id) ka(x1) f(x0) kz(x2) z(x0) | '); // MySQL(라이브): ka kz z
  });

  it('FK 이름과 같은 이름으로 직접 만든 인덱스(KEY f + CONSTRAINT f)는 덤프가 자동 인덱스와 글자까지 같아 자동으로 본다', () => {
    // 'named' 기준 표가 둘 다를 나타낸다: 직접 만든 KEY f 였다면 MySQL 은 ADD INDEX ix (x0, x1) 때 f 를 남긴다
    expect(shown(tableT(ok('named', 'ALTER TABLE t ADD INDEX ix (x0, x1);')))).toBe('PRIMARY(id) ka(x1) kz(x2) ix(x0,x1) | f');
  });
});
