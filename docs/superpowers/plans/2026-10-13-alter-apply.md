# ALTER 적용으로 새 버전 만들기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SQL 출처 버전의 모델에 사람이 쓴 ALTER 스크립트를 적용해 새 버전을 만든다. 결과는 같은 스크립트를 MySQL 8.0/8.4에 실행한 결과와 같아야 한다.

**Architecture:**
- `@tdm/core`에 `src/apply/`를 추가한다. 스크립트를 문장으로 나눠 작업용 모델 사본에 MySQL 규칙대로 적용하고, 결과를 td-export 0.1.52 형식 SQL(`printSqlDump`)로 출력한다.
- 서버는 출력한 SQL을 원문으로 기존 `ingest` 경로에 넘긴다. 같은 트랜잭션에서 기준 버전·스크립트(`schema_version_derivations`), 기준 버전에서 물려받은 완전성 판정, rename 매핑을 저장한다.
- 정확성은 `test:mysql`의 ALTER 시나리오가 실제 MySQL과 비교해 보장한다. 기준은 비교 엔진으로 양방향 0문장이다.

**Tech Stack:** TypeScript (core: 런타임 의존성 없음), Fastify 5 + node:sqlite, React 19 + TanStack Query 5, vitest, mysql2(테스트 전용), MySQL 8.0/8.4 컨테이너

**Spec:** `docs/superpowers/specs/2026-10-13-alter-apply-design.md`

## Global Constraints

- **브랜치:** `feat/alter-apply`. main에 직접 커밋하지 않는다.
- **core 의존성:** `packages/core/src`에는 런타임 의존성이 없고 `node:` import를 쓰지 않는다. 웹이 core를 번들한다.
- **언어 규칙:**
  - 주석과 화면 문구는 한국어, 식별자는 영어로 쓴다.
  - 커밋 메시지는 Conventional Commits(`feat:`, `fix:`, `test:`, `docs:`)로 쓰고, 본문은 한국어로 쓴다.
- **스테이징:**
  - `samples/`, `bin/`, `mysql.txt`, `.playwright-mcp/`, `.code-review-graph/`는 스테이징하지 않는다.
  - 경로를 지정해 스테이징한다(`git add <path>`).
- **제어 문자:** 변경한 파일에 제어 문자(탭·개행 제외)를 넣지 않는다. 테스트 문자열은 `\n` 같은 이스케이프로 만든다.
- **기존 출력 불변:** 기존 골든 시나리오(`packages/core/test/fixtures/scenarios`, 66개)의 `expected.sql`과 기존 픽스처 파일은 바꾸지 않는다.
- **오류 메시지:** 실패 메시지에는 대응하는 MySQL 오류 번호를 `(MySQL NNNN)` 형식으로 넣는다. 1차 지원 범위 밖이면 그 이유와 "td-export 로 다시 뽑아 올려 주세요"를 넣는다.
- **불변성:** 입력 모델(`SchemaModel`)을 바꾸지 않는다. `applyScript`는 `structuredClone` 사본 하나만 고친다.
- **스키마 기본값:** `MYSQL_DEFAULTS`는 `{ charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }`이다.
- **루틴 SQL_MODE:** 루틴의 기본 SQL_MODE는 `ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION`이다.
- **완료 확인:** 각 Task가 끝나면 아래를 실행한다.
  - `npm test -w @tdm/core` (Task 8·9는 해당 워크스페이스)와 `npm run typecheck`
  - 마지막 Task에서는 루트 `npm test && npm run typecheck && npm run build`와 `npm run test:mysql -w @tdm/core`
- **MySQL 컨테이너:**
  - 탐색용으로는 로컬 MySQL 8.4 컨테이너 `tdm-my84`(127.0.0.1:33099, root/test)를 쓴다. 임시 DB만 만들고 끝나면 지운다. `shop` DB와 `tdm-pg`는 건드리지 않는다.
  - `test:mysql`은 compose(포트 33080/33084)를 띄우고, 끝나면 `docker compose -f packages/core/docker-compose.test.yml down`으로 내린다.

## File Structure

**core (`packages/core/src/apply/`, 신규)**

| 파일 | 책임 |
|---|---|
| `types.ts` | 공용 타입(`ApplyResult`·`ColumnSpec`·`DefaultSpec`·`ConstraintItem`…), `ApplyFailure`, `fail`, `MYSQL_DEFAULTS`, `DEFAULT_SQL_MODE` |
| `normalize-mysql.ts` | 사람이 쓴 타입·기본값·문자셋을 SHOW CREATE 모양으로 맞추기, `finalizeColumn` |
| `options.ts` | 테이블 옵션 값 정규화(ENGINE·ROW_FORMAT)와 `setOption`(SHOW CREATE 옵션 순서) |
| `def-parser.ts` | 관대한 컬럼·인덱스·FK 정의 파서(`parseColumnSpec`, `parseConstraint`, `parseTableItem`, `parsePosition`) |
| `state.ts` | 작업 상태(`State`), 기준 이름 추적(`Origins`), 이름 찾기 도우미 |
| `keys.ts` | 인덱스·FK 추가·삭제·재배치, FK 자동 인덱스, 테이블 검사(`checkTable`), MySQL 키 순서(`sortIndexes`) |
| `alter-table.ts` | ALTER TABLE 절 파싱과 단계별 적용, `CREATE INDEX … ON`·`DROP INDEX … ON` |
| `table-stmt.ts` | CREATE TABLE, DROP TABLE, RENAME TABLE |
| `object-stmt.ts` | CREATE/DROP FUNCTION·PROCEDURE, DROP VIEW |
| `session.ts` | `SET` 문(FOREIGN_KEY_CHECKS·SQL_MODE, `@OLD_…` 저장·복원) |
| `print-dump.ts` | `printSqlDump(model)` — td-export 0.1.52 형식 출력 |
| `index.ts` | `applyScript` — 문장 분할·분기·실패 처리·rename 수집 |

**core (수정)**
- `packages/core/src/parse-table.ts`: `indexKind`, `parseIndex`, `parseForeignKey`, `refAction` 앞에 `export`만 붙인다(동작은 바꾸지 않는다).
- `packages/core/src/index.ts`: `export * from './apply';`
- `packages/core/package.json`: `test:mysql`에 `test/apply.int.test.ts`를 추가한다.

**core 테스트**
- 단위 테스트: `packages/core/test/apply/*.test.ts`
- MySQL 시나리오: `packages/core/test/apply.int.test.ts`, `packages/core/test/fixtures/alter-scenarios/<이름>/{base.sql,script.sql[,expect-error.txt]}`
- 공용 덤프 도우미: `packages/core/test/mysql-dump.ts`. 기존 `mysql.int.test.ts`의 `dumpSchema`·`dumpRoutines`를 옮긴다.

**server**
- `apps/server/src/db/migrations/009_version_derivations.sql`
- `apps/server/src/repos/derivations.ts`
- `apps/server/src/services/alter.ts`
- 수정할 파일과 내용

| 파일 | 수정 내용 |
|---|---|
| `services/ingest.ts` | `evidence`·`onCreated` 옵션 추가 |
| `repos/renames.ts` | `writeRenames` 추출 |
| `repos/versions.ts` | `derivedFrom` 추가 |
| `services/evidence-backfill.ts` | 파생 버전의 판정 상속과 stale 전파 |
| `routes/versions.ts` | `POST /versions/:id/alter`, `GET /versions/:id/derivation` |
| `apps/server/README.md` | API 표 |

- user_version 기대값 테스트 3곳(8→9): `test/db.test.ts`, `test/backup.test.ts`, `test/evidence.test.ts`

**web**
- `apps/web/src/features/alter/AlterDialog.tsx`(신규)
- 수정: `api/types.ts`, `api/hooks.ts`, `pages/HistoryPage.tsx`
- 테스트: `apps/web/test/alter-dialog.test.tsx`

**docs**
- `README.md`, `README.ko.md`(기능 목록)
- 스펙 상태 줄

---

### Task 1: 공용 타입과 MySQL 정규화 규칙

**Files:**
- Modify: `packages/core/src/parse-table.ts` (`function indexKind`·`parseIndex`·`parseForeignKey`·`refAction` 앞에 `export`)
- Create: `packages/core/src/apply/types.ts`, `packages/core/src/apply/normalize-mysql.ts`, `packages/core/src/apply/options.ts`
- Test: `packages/core/test/apply/normalize-mysql.test.ts`, `packages/core/test/apply/options.test.ts`

**Interfaces:**
- Produces (뒤 Task 가 쓰는 이름):
  - `types.ts`: `ApplyDefaults`, `ApplyOptions`, `ApplyError`, `ApplyResult`, `ApplyFailure`, `fail(reason): never`, `MYSQL_DEFAULTS`, `DEFAULT_SQL_MODE`, `NowSpec`, `DefaultSpec`, `ColumnSpec`, `Position`, `IndexItem`, `FkItem`, `ConstraintItem`, `TableItem`
  - `normalize-mysql.ts`: `INT_TYPES`, `CHARSET_TYPES`, `BLOB_TYPES`, `NO_LITERAL_DEFAULT`, `baseType(type)`, `normalizeUserType(src)`, `enumMembers(type)`, `canonicalCharset(name)`, `canonicalCollation(name)`, `charsetOfCollation(coll)`, `primaryCollation(cs)`, `TableCharset`, `tableCharset(options, defaults)`, `columnCharset(type, written, table)`, `effectiveCollation(col, table)`, `nowText(type, now, what)`, `normalizeDefault(spec, col)`, `finalizeColumn(spec, table)`, `routineReturns(raw, charset)`
  - `options.ts`: `engineName(v)`, `rowFormatName(v)`, `setOption(options, key, value | undefined)`

- [ ] **Step 1: parse-table 의 도우미 4개를 export 한다**

`packages/core/src/parse-table.ts` 에서 아래 네 함수 선언 앞에 `export` 만 붙인다 (본문은 그대로):

```ts
export function indexKind(c: Cursor): IndexKind | undefined {
export function parseIndex(c: Cursor, kind: IndexKind, name: string): Index {
export function parseForeignKey(c: Cursor, name: string): ForeignKey {
export function refAction(c: Cursor): string {
```

Run: `npm test -w @tdm/core` — Expected: 기존 테스트 모두 PASS (동작 변화 없음)

- [ ] **Step 2: types.ts 를 만든다**

```ts
// ALTER 스크립트 적용(apply) 공용 타입
import type { RenameMapping } from '../diff';
import type { ColumnFormat, ColumnStorage, ForeignKey, Index, SchemaModel } from '../model';

// 스키마 기본 문자셋·콜레이션: 문자셋 없이 쓴 CREATE TABLE 과 문자열을 반환하는 함수에 MySQL 은 DB 기본값을 쓰는데,
// td-export 덤프에는 DB 기본값이 없어 사용자가 정한다
export interface ApplyDefaults {
  charset: string;
  collation: string;
}

export interface ApplyOptions {
  schemaName: string; // `cur`.`t` 처럼 한정한 이름과 USE 는 이 스키마일 때만 받는다
  defaults?: Partial<ApplyDefaults>;
}

export interface ApplyError {
  index: number; // 1부터 (0: 특정 문장이 아님)
  line: number;
  statement: string; // 앞 500자
  reason: string;
}

export type ApplyResult =
  | { ok: true; model: SchemaModel; applied: number; renames: RenameMapping[]; defaults: ApplyDefaults } // defaults: MySQL 표기로 맞춘 스키마 기본값
  | { ok: false; error: ApplyError };

// 문장을 적용할 수 없을 때 (MySQL 이 거부하거나 1차 지원 범위 밖). 메시지는 화면에 그대로 보인다
export class ApplyFailure extends Error {}

export const fail = (reason: string): never => {
  throw new ApplyFailure(reason);
};

export const MYSQL_DEFAULTS: ApplyDefaults = { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' };
// 스크립트에 SET SQL_MODE 가 없을 때 루틴에 붙는 SQL_MODE (MySQL 8.0/8.4 기본값)
export const DEFAULT_SQL_MODE = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

export interface NowSpec {
  fsp?: number; // CURRENT_TIMESTAMP(n) 의 n (0 이면 없음)
}

// 사람이 쓴 기본값 (정규화 전)
export type DefaultSpec =
  | { kind: 'null' }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: string } // 부호 포함 원문 ('-1', '0.5'). TRUE/FALSE 는 '1'/'0'
  | { kind: 'bit'; value: string } // b'101' 원문
  | ({ kind: 'now' } & NowSpec);

// 사람이 쓴 컬럼 정의 (정규화 전). type 은 normalizeUserType 을 거친 값
export interface ColumnSpec {
  name: string;
  type: string;
  charset?: string; // 쓴 그대로 (utf8 → utf8mb3 는 정규화 때)
  collation?: string;
  nullable?: boolean; // undefined: NULL/NOT NULL 을 쓰지 않음 (NULL 허용)
  default?: DefaultSpec;
  onUpdate?: NowSpec;
  autoIncrement: boolean;
  comment?: string;
  invisible: boolean;
  srid?: number;
  storage?: ColumnStorage;
  columnFormat?: ColumnFormat;
  primaryKey: boolean; // 컬럼 안 PRIMARY KEY (또는 KEY)
  unique: boolean; // 컬럼 안 UNIQUE [KEY]
}

export type Position = { first: true } | { after: string } | undefined;

// 인덱스 정의. named=false 면 이름은 '' 이고 적용할 때 MySQL 규칙으로 짓는다
export interface IndexItem {
  kind: 'index';
  index: Index;
  named: boolean;
}

// FK 정의. named=false 면 fk.name 은 '' 이고 '<테이블>_ibfk_N' 으로 짓는다. indexName: FOREIGN KEY 뒤에 쓴 인덱스 이름
export interface FkItem {
  kind: 'fk';
  fk: ForeignKey;
  indexName?: string;
  named: boolean;
}

export type ConstraintItem = IndexItem | FkItem;
export type TableItem = { kind: 'column'; spec: ColumnSpec } | ConstraintItem;
```

- [ ] **Step 3: options.ts 의 실패하는 테스트를 쓴다**

`packages/core/test/apply/options.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { engineName, rowFormatName, setOption } from '../../src/apply/options';
import { ApplyFailure } from '../../src/apply/types';

describe('테이블 옵션', () => {
  const base = [{ key: 'ENGINE', value: 'InnoDB' }, { key: 'DEFAULT CHARSET', value: 'utf8mb4' }, { key: 'COLLATE', value: 'utf8mb4_0900_ai_ci' }, { key: 'COMMENT', value: "'주문'" }];

  it('있던 옵션은 그 자리에서 바꾸고, 새 옵션은 SHOW CREATE 순서 자리에 넣고, undefined 는 지운다', () => {
    expect(setOption(base, 'COMMENT', "'새'").map((o) => o.value)).toEqual(['InnoDB', 'utf8mb4', 'utf8mb4_0900_ai_ci', "'새'"]);
    expect(setOption(base, 'ROW_FORMAT', 'DYNAMIC').map((o) => o.key)).toEqual(['ENGINE', 'DEFAULT CHARSET', 'COLLATE', 'ROW_FORMAT', 'COMMENT']);
    expect(setOption(base, 'COMMENT', undefined).map((o) => o.key)).toEqual(['ENGINE', 'DEFAULT CHARSET', 'COLLATE']);
    expect(base).toHaveLength(4); // 입력은 그대로
  });

  it('엔진·행 형식 이름을 MySQL 표기로 맞추고 모르는 값은 거부한다', () => {
    expect(engineName('innodb')).toBe('InnoDB');
    expect(rowFormatName('dynamic')).toBe('DYNAMIC');
    expect(() => engineName('foo')).toThrow(ApplyFailure);
    expect(() => rowFormatName('weird')).toThrow(ApplyFailure);
  });
});
```

Run: `npx vitest run test/apply/options.test.ts` (in `packages/core`) — Expected: FAIL (`Cannot find module '../../src/apply/options'`)

- [ ] **Step 4: options.ts 를 구현한다**

```ts
// 테이블 옵션: 값 정규화와 SHOW CREATE 옵션 순서
import type { TableOption } from '../model';
import { fail } from './types';

const ENGINES: Readonly<Record<string, string>> = {
  innodb: 'InnoDB', myisam: 'MyISAM', memory: 'MEMORY', heap: 'MEMORY', csv: 'CSV', archive: 'ARCHIVE', blackhole: 'BLACKHOLE',
};
const ROW_FORMATS: ReadonlySet<string> = new Set(['DEFAULT', 'DYNAMIC', 'FIXED', 'COMPRESSED', 'REDUNDANT', 'COMPACT']);
// SHOW CREATE TABLE 의 옵션 순서 (모르는 키는 COLLATE 와 ROW_FORMAT 사이)
const ORDER = ['ENGINE', 'DEFAULT CHARSET', 'COLLATE', 'ROW_FORMAT', 'KEY_BLOCK_SIZE', 'COMMENT'];

export const engineName = (v: string): string => ENGINES[v.toLowerCase()] ?? fail(`지원하지 않는 엔진입니다: ${v}`);

export function rowFormatName(v: string): string {
  const f = v.toUpperCase();
  return ROW_FORMATS.has(f) ? f : fail(`알 수 없는 ROW_FORMAT 입니다: ${v}`);
}

// 옵션을 바꾸거나(value) 지운다(undefined). 있던 옵션은 그 자리에서 바꾸고, 새 옵션은 SHOW CREATE 순서에 맞는 자리에 넣는다
export function setOption(options: readonly TableOption[], key: string, value: string | undefined): TableOption[] {
  if (value === undefined) return options.filter((o) => o.key !== key);
  if (options.some((o) => o.key === key)) return options.map((o) => (o.key === key ? { key, value } : o));
  const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : 2.5);
  const at = options.findIndex((o) => rank(o.key) > rank(key));
  return at < 0 ? [...options, { key, value }] : [...options.slice(0, at), { key, value }, ...options.slice(at)];
}
```

Run: `npx vitest run test/apply/options.test.ts` — Expected: PASS

- [ ] **Step 5: normalize-mysql 의 실패하는 테스트를 쓴다**

`packages/core/test/apply/normalize-mysql.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { columnCharset, finalizeColumn, normalizeDefault, normalizeUserType, routineReturns, tableCharset } from '../../src/apply/normalize-mysql';
import { ApplyFailure, type ColumnSpec, type DefaultSpec } from '../../src/apply/types';

const spec = (over: Partial<ColumnSpec>): ColumnSpec => ({ name: 'c', type: 'int', autoIncrement: false, invisible: false, primaryKey: false, unique: false, ...over });
const T = { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' };
const col = (type: string, nullable = true) => ({ name: 'c', type, nullable });

describe('normalizeUserType', () => {
  it.each([
    ['INT(11)', 'int'], ['INTEGER UNSIGNED', 'int unsigned'], ['tinyint(1)', 'tinyint(1)'], ['BOOLEAN', 'tinyint(1)'],
    ['DECIMAL', 'decimal(10,0)'], ['NUMERIC(8)', 'decimal(8,0)'], ['DEC(12, 4)', 'decimal(12,4)'], ['CHAR', 'char(1)'],
    ['VARCHAR (20)', 'varchar(20)'], ['DOUBLE PRECISION', 'double'], ['REAL', 'double'], ['FLOAT(30)', 'double'], ['FLOAT(7,4)', 'float(7,4)'],
    ['DATETIME(0)', 'datetime'], ['TIMESTAMP(3)', 'timestamp(3)'], ['YEAR(4)', 'year'], ['BIT', 'bit(1)'], ['BIGINT SIGNED', 'bigint'],
    ["ENUM('a' , \"b\", 'c  ')", "enum('a','b','c')"], ["SET('x','it''s')", "set('x','it''s')"], ['JSON', 'json'], ['LONGTEXT', 'longtext'],
  ])('%s → %s', (src, out) => expect(normalizeUserType(src)).toBe(out));

  it.each([['VARCHAR'], ['SERIAL'], ['INT ZEROFILL'], ['TEXT(100)'], ['NCHAR(2)'], ['FOO'], ["ENUM('a','A')"], ['VARCHAR(10) UNSIGNED'], ['YEAR(2)'], ['CHAR(1,2)']])('%s 는 거부', (src) => {
    expect(() => normalizeUserType(src)).toThrow(ApplyFailure);
  });
});

describe('normalizeDefault', () => {
  it.each([
    [{ kind: 'number', value: '0' }, 'int', "'0'"],
    [{ kind: 'number', value: '-1' }, 'int', "'-1'"],
    [{ kind: 'number', value: '0' }, 'decimal(12,4)', "'0.0000'"],
    [{ kind: 'number', value: '1.5' }, 'double', "'1.5'"],
    [{ kind: 'string', value: '5' }, 'int', "'5'"],
    [{ kind: 'number', value: '5' }, 'varchar(10)', "'5'"],
    [{ kind: 'string', value: "it's" }, 'varchar(10)', "'it''s'"],
    [{ kind: 'now' }, 'datetime', 'CURRENT_TIMESTAMP'],
    [{ kind: 'now', fsp: 3 }, 'timestamp(3)', 'CURRENT_TIMESTAMP(3)'],
    [{ kind: 'string', value: 'B' }, "enum('a','b')", "'b'"],
    [{ kind: 'string', value: 'y,x' }, "set('x','y')", "'x,y'"],
    [{ kind: 'number', value: '1' }, 'bit(1)', "b'1'"],
    [{ kind: 'null' }, 'int', 'NULL'],
  ] as const)('%j on %s → %s', (s, type, out) => expect(normalizeDefault(s as DefaultSpec, col(type))).toBe(out));

  it.each([
    [{ kind: 'null' }, col('int', false)], [{ kind: 'string', value: 'x' }, col('text')], [{ kind: 'now' }, col('date')],
    [{ kind: 'now' }, col('datetime(3)')], [{ kind: 'number', value: '1.5' }, col('int')], [{ kind: 'string', value: 'z' }, col("enum('a')")],
    [{ kind: 'number', value: '-1' }, col('int unsigned')], [{ kind: 'string', value: 'abc' }, col('int')],
  ] as const)('%j 는 거부', (s, c) => expect(() => normalizeDefault(s as DefaultSpec, c)).toThrow(ApplyFailure));
});

describe('문자셋 (SHOW CREATE 표기)', () => {
  it('테이블 기본값을 물려받으면 문자셋 기본 콜레이션이 아닐 때만 COLLATE', () => {
    expect(columnCharset('varchar(10)', {}, T)).toEqual({ collation: 'utf8mb4_general_ci' });
    expect(columnCharset('varchar(10)', {}, { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' })).toEqual({});
  });

  it('다른 콜레이션이면 CHARACTER SET, COLLATE 를 직접 쓰면 둘 다', () => {
    expect(columnCharset('varchar(10)', { charset: 'latin1' }, T)).toEqual({ charset: 'latin1' });
    expect(columnCharset('varchar(10)', { charset: 'utf8mb4' }, T)).toEqual({ charset: 'utf8mb4' }); // utf8mb4_0900_ai_ci ≠ 테이블 general_ci
    expect(columnCharset('varchar(10)', { collation: 'utf8mb4_bin' }, T)).toEqual({ charset: 'utf8mb4', collation: 'utf8mb4_bin' });
    expect(columnCharset('text', { charset: 'utf8' }, T)).toEqual({ charset: 'utf8mb3' });
  });

  it('문자열이 아닌 타입·맞지 않는 콜레이션·모르는 문자셋은 거부', () => {
    expect(() => columnCharset('int', { charset: 'utf8mb4' }, T)).toThrow(ApplyFailure);
    expect(() => columnCharset('varchar(1)', { charset: 'latin1', collation: 'utf8mb4_bin' }, T)).toThrow(/1253/);
    expect(() => columnCharset('varchar(1)', { charset: 'klingon' }, T)).toThrow(/1115/);
  });

  it('tableCharset: 옵션의 문자셋·콜레이션, 없으면 기본값', () => {
    expect(tableCharset([{ key: 'DEFAULT CHARSET', value: 'latin1' }], T)).toEqual({ charset: 'latin1', collation: 'latin1_swedish_ci' });
    expect(tableCharset([{ key: 'DEFAULT CHARSET', value: 'utf8mb4' }, { key: 'COLLATE', value: 'utf8mb4_bin' }], T)).toEqual({ charset: 'utf8mb4', collation: 'utf8mb4_bin' });
    expect(tableCharset([], T)).toEqual(T);
  });

  it('routineReturns: 문자열 반환 타입에는 CHARSET <스키마 기본> 을 붙인다', () => {
    expect(routineReturns('INT', 'utf8mb4')).toBe('int');
    expect(routineReturns('VARCHAR(20)', 'utf8mb4')).toBe('varchar(20) CHARSET utf8mb4');
    expect(() => routineReturns('VARCHAR(20) CHARSET latin1', 'utf8mb4')).toThrow(ApplyFailure);
  });
});

describe('finalizeColumn', () => {
  it('NULL 허용 컬럼은 DEFAULT NULL (TEXT·JSON 제외), NOT NULL 은 기본값 없음', () => {
    expect(finalizeColumn(spec({ type: 'int' }), T)).toEqual({ name: 'c', type: 'int', nullable: true, invisible: false, autoIncrement: false, default: 'NULL' });
    expect(finalizeColumn(spec({ type: 'text' }), T)).toEqual({ name: 'c', type: 'text', collation: 'utf8mb4_general_ci', nullable: true, invisible: false, autoIncrement: false });
    expect(finalizeColumn(spec({ type: 'int', nullable: false }), T).default).toBeUndefined();
  });

  it('컬럼 안 PRIMARY KEY 는 NOT NULL, AUTO_INCREMENT 는 DEFAULT 없음', () => {
    const c = finalizeColumn(spec({ type: 'int unsigned', primaryKey: true, autoIncrement: true }), T);
    expect(c).toMatchObject({ nullable: false, autoIncrement: true });
    expect(c.default).toBeUndefined();
  });

  it('ON UPDATE·COMMENT, 빈 COMMENT 는 없앤다', () => {
    const c = finalizeColumn(spec({ type: 'datetime', nullable: false, default: { kind: 'now' }, onUpdate: {}, comment: '' }), T);
    expect(c).toMatchObject({ default: 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' });
    expect(c.comment).toBeUndefined();
  });

  it('PRIMARY KEY NULL·문자열 AUTO_INCREMENT·AUTO_INCREMENT 기본값은 거부', () => {
    expect(() => finalizeColumn(spec({ primaryKey: true, nullable: true }), T)).toThrow(/1171/);
    expect(() => finalizeColumn(spec({ type: 'varchar(1)', autoIncrement: true }), T)).toThrow(/1063/);
    expect(() => finalizeColumn(spec({ autoIncrement: true, default: { kind: 'number', value: '1' } }), T)).toThrow(/1067/);
  });
});
```

Run: `npx vitest run test/apply/normalize-mysql.test.ts` — Expected: FAIL (모듈 없음)

- [ ] **Step 6: normalize-mysql.ts 를 구현한다**

```ts
// 사람이 쓴 타입·기본값·문자셋을 MySQL SHOW CREATE 모양으로 맞춘다 (8.0/8.4).
// 규칙마다 test:mysql 의 ALTER 시나리오(test/apply.int.test.ts)가 실제 MySQL 결과와 비교한다
import { Cursor, splitTopLevel } from '../cursor';
import { quoteString, tokenize, type Token } from '../lexer';
import type { Column, TableOption } from '../model';
import { normalizeType } from '../normalize';
import { fail, type ColumnSpec, type DefaultSpec, type NowSpec } from './types';

export const INT_TYPES: ReadonlySet<string> = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'bigint']);
const NUMERIC: ReadonlySet<string> = new Set([...INT_TYPES, 'decimal', 'float', 'double']);
// 문자셋·콜레이션이 붙는 타입
export const CHARSET_TYPES: ReadonlySet<string> = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set']);
export const BLOB_TYPES: ReadonlySet<string> = new Set(['tinytext', 'text', 'mediumtext', 'longtext', 'tinyblob', 'blob', 'mediumblob', 'longblob']);
// 리터럴 기본값을 쓸 수 없는 타입 (MySQL 1101). NULL 허용이어도 SHOW CREATE 에 DEFAULT NULL 이 없다
export const NO_LITERAL_DEFAULT: ReadonlySet<string> = new Set([...BLOB_TYPES, 'json',
  'geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection', 'geomcollection']);
const KNOWN: ReadonlySet<string> = new Set([...NUMERIC, ...CHARSET_TYPES, ...NO_LITERAL_DEFAULT, 'bit', 'date', 'datetime', 'timestamp', 'time', 'year', 'binary', 'varbinary']);
const TWO_ARGS: ReadonlySet<string> = new Set(['decimal', 'float', 'double']);
const AUTO_INCREMENT_TYPES: ReadonlySet<string> = new Set([...INT_TYPES, 'float', 'double']);
const ALIASES: Readonly<Record<string, string>> = {
  integer: 'int', int1: 'tinyint', int2: 'smallint', int3: 'mediumint', int4: 'int', int8: 'bigint', middleint: 'mediumint',
  dec: 'decimal', numeric: 'decimal', fixed: 'decimal', real: 'double', character: 'char',
};
const NATIONAL = 'NATIONAL·NCHAR 타입은 문자셋이 따로 붙어 1차 지원 범위가 아닙니다';
const REJECTED: Readonly<Record<string, string>> = {
  serial: 'SERIAL 은 UNIQUE 인덱스가 따로 생겨 1차 지원 범위가 아닙니다',
  national: NATIONAL, nchar: NATIONAL, nvarchar: NATIONAL,
  long: 'LONG·LONG VARCHAR 는 1차 지원 범위가 아닙니다 — MEDIUMTEXT 로 쓰세요',
};

export const baseType = (type: string): string => /^\w+/.exec(type)?.[0] ?? '';

// 'INT(11) UNSIGNED' → 'int unsigned', 'DECIMAL' → 'decimal(10,0)', "ENUM('a' , \"b\")" → "enum('a','b')"
export function normalizeUserType(src: string): string {
  const c = new Cursor(tokenize(src), src);
  const first = c.next();
  if (first.t !== 'word') return fail(`타입이 필요합니다: ${src}`);
  const word = first.v.toLowerCase();
  if (REJECTED[word]) return fail(REJECTED[word]);
  if (word === 'bool' || word === 'boolean') return c.done ? 'tinyint(1)' : fail(`BOOLEAN 뒤에는 수식어를 쓸 수 없습니다: ${src}`);
  if (word === 'double') c.acceptWord('PRECISION');
  const name = ALIASES[word] ?? word;
  if (!KNOWN.has(name)) return fail(`지원하지 않는 타입입니다: ${first.v}`);
  const inner = c.isOp('(') ? c.parenTokens() : undefined;
  let unsigned = false;
  while (!c.done) {
    if (c.acceptWord('UNSIGNED')) unsigned = true;
    else if (c.acceptWord('SIGNED')) unsigned = false;
    else if (c.isWord('ZEROFILL')) fail('ZEROFILL 은 1차 지원 범위가 아닙니다 (MySQL 8.0.17 부터 폐기 예정)');
    else fail(`알 수 없는 타입 수식어: ${c.peek()!.v}`);
  }
  if (unsigned && !NUMERIC.has(name)) fail(`UNSIGNED 는 숫자 타입에만 쓸 수 있습니다: ${src}`);
  return withArgs(name, inner, src) + (unsigned ? ' unsigned' : '');
}

function withArgs(name: string, inner: Token[] | undefined, src: string): string {
  if (name === 'enum' || name === 'set') return `${name}(${enumValues(inner, src).map(quoteString).join(',')})`;
  const args = inner && splitTopLevel(inner).map((part) => (part.length === 1 && part[0].t === 'number' && /^\d+$/.test(part[0].v) ? String(Number(part[0].v)) : fail(`타입 인자가 올바르지 않습니다: ${src}`)));
  if (args && args.length > (TWO_ARGS.has(name) ? 2 : 1)) fail(`타입 인자가 너무 많습니다: ${src}`);
  switch (name) {
    case 'decimal': return `decimal(${args?.[0] ?? 10},${args?.[1] ?? 0})`;
    case 'char': case 'binary': case 'bit': return `${name}(${args?.[0] ?? 1})`;
    case 'varchar': case 'varbinary': return args ? `${name}(${args[0]})` : fail(`${name.toUpperCase()} 는 길이가 필요합니다 (MySQL 1064)`);
    case 'float': return !args ? 'float' : args.length === 1 ? (Number(args[0]) <= 24 ? 'float' : 'double') : `float(${args.join(',')})`;
    case 'double': return args ? `double(${args.join(',')})` : 'double';
    case 'year': return !args || args[0] === '4' ? 'year' : fail('YEAR(2) 는 MySQL 8.0 에서 지원하지 않습니다');
    case 'datetime': case 'timestamp': case 'time':
      if (args && Number(args[0]) > 6) fail(`소수 초 자릿수는 0~6 이어야 합니다: ${src} (MySQL 1426)`);
      return args && args[0] !== '0' ? `${name}(${args[0]})` : name;
    default:
      if (INT_TYPES.has(name)) return normalizeType(args ? `${name}(${args[0]})` : name); // int(11) → int, tinyint(1) 유지
      return args ? fail(`${name.toUpperCase()}(n) 은 1차 지원 범위가 아닙니다 (MySQL 이 길이로 타입을 고릅니다)`) : name;
  }
}

// MySQL 은 ENUM·SET 값 끝 공백을 지운다. 대소문자만 다른 같은 값이면 1291
function enumValues(inner: Token[] | undefined, src: string): string[] {
  const values = (inner ? splitTopLevel(inner) : []).map((part) => (part.length === 1 && part[0].t === 'string' ? part[0].v.replace(/ +$/, '') : fail(`ENUM·SET 값은 문자열이어야 합니다: ${src}`)));
  if (!values.length) fail(`ENUM·SET 값이 없습니다: ${src}`);
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v.toLowerCase())) fail(`ENUM·SET 값 '${v}' 이 두 번 있습니다 (MySQL 1291)`);
    seen.add(v.toLowerCase());
  }
  return values;
}

export const enumMembers = (type: string): string[] => tokenize(type).filter((t) => t.t === 'string').map((t) => t.v);

// 문자셋의 기본(primary) 콜레이션 — MySQL 8.0/8.4 SHOW CHARACTER SET 의 Default collation
const PRIMARY_COLLATION: Readonly<Record<string, string>> = {
  utf8mb4: 'utf8mb4_0900_ai_ci', utf8mb3: 'utf8mb3_general_ci', latin1: 'latin1_swedish_ci', latin2: 'latin2_general_ci', ascii: 'ascii_general_ci',
  binary: 'binary', ucs2: 'ucs2_general_ci', utf16: 'utf16_general_ci', utf16le: 'utf16le_general_ci', utf32: 'utf32_general_ci',
  euckr: 'euckr_korean_ci', gbk: 'gbk_chinese_ci', gb2312: 'gb2312_chinese_ci', gb18030: 'gb18030_chinese_ci', big5: 'big5_chinese_ci',
  sjis: 'sjis_japanese_ci', ujis: 'ujis_japanese_ci', cp932: 'cp932_japanese_ci', eucjpms: 'eucjpms_japanese_ci', cp1250: 'cp1250_general_ci',
  cp1251: 'cp1251_general_ci', cp1256: 'cp1256_general_ci', cp1257: 'cp1257_general_ci', greek: 'greek_general_ci', hebrew: 'hebrew_general_ci',
  tis620: 'tis620_thai_ci', koi8r: 'koi8r_general_ci', koi8u: 'koi8u_general_ci',
};

export function canonicalCharset(name: string): string {
  const cs = name.toLowerCase() === 'utf8' ? 'utf8mb3' : name.toLowerCase();
  return PRIMARY_COLLATION[cs] ? cs : fail(`알 수 없는 문자셋입니다: ${name} (MySQL 1115)`);
}

export function canonicalCollation(name: string): string {
  const coll = name.toLowerCase().replace(/^utf8_/, 'utf8mb3_');
  charsetOfCollation(coll);
  return coll;
}

export function charsetOfCollation(coll: string): string {
  const cs = coll === 'binary' ? 'binary' : coll.split('_')[0];
  return PRIMARY_COLLATION[cs] ? cs : fail(`알 수 없는 콜레이션입니다: ${coll} (MySQL 1273)`);
}

export const primaryCollation = (cs: string): string => PRIMARY_COLLATION[cs];

export interface TableCharset {
  charset: string;
  collation: string;
}

// 테이블 기본 문자셋 (SHOW CREATE 의 DEFAULT CHARSET=·COLLATE= 옵션). 없으면 스키마 기본값
export function tableCharset(options: readonly TableOption[], defaults: TableCharset): TableCharset {
  const value = (...keys: string[]) => options.find((o) => keys.includes(o.key))?.value;
  const charsetRaw = value('DEFAULT CHARSET', 'CHARSET', 'DEFAULT CHARACTER SET', 'CHARACTER SET');
  const collationRaw = value('COLLATE', 'DEFAULT COLLATE');
  const collation = collationRaw ? canonicalCollation(collationRaw) : charsetRaw ? primaryCollation(canonicalCharset(charsetRaw)) : defaults.collation;
  return { charset: charsetOfCollation(collation), collation };
}

// 컬럼 문자셋 표기 (SHOW CREATE 규칙): 콜레이션이 테이블 기본과 다르면 CHARACTER SET, 문자셋 기본 콜레이션이 아니면 COLLATE.
// COLLATE 를 직접 쓰면 둘 다 붙인다 (MySQL 은 명시한 콜레이션을 기억한다 — 비교 엔진은 COLLATE 만 있는 표기와 같게 본다)
export function columnCharset(type: string, written: Pick<ColumnSpec, 'charset' | 'collation'>, table: TableCharset): Pick<Column, 'charset' | 'collation'> {
  if (!CHARSET_TYPES.has(baseType(type))) return written.charset || written.collation ? fail(`문자열이 아닌 타입에는 CHARACTER SET·COLLATE 를 쓸 수 없습니다: ${type}`) : {};
  const charset = written.charset ? canonicalCharset(written.charset) : written.collation ? charsetOfCollation(canonicalCollation(written.collation)) : table.charset;
  const collation = written.collation ? canonicalCollation(written.collation) : written.charset ? primaryCollation(charset) : table.collation;
  if (charsetOfCollation(collation) !== charset) fail(`COLLATE ${collation} 은 문자셋 ${charset} 의 콜레이션이 아닙니다 (MySQL 1253)`);
  if (written.collation) return { charset, collation };
  return { ...(collation !== table.collation ? { charset } : {}), ...(collation !== primaryCollation(charset) ? { collation } : {}) };
}

// 컬럼의 실제 콜레이션 (문자열 타입이 아니면 '')
export function effectiveCollation(col: Pick<Column, 'type' | 'charset' | 'collation'>, table: TableCharset): string {
  if (!CHARSET_TYPES.has(baseType(col.type))) return '';
  return col.collation ?? (col.charset ? primaryCollation(canonicalCharset(col.charset)) : table.collation);
}

const fspOf = (type: string): number => Number(/^(?:datetime|timestamp|time)\((\d)\)/.exec(type)?.[1] ?? 0);

// CURRENT_TIMESTAMP 기본값·ON UPDATE: DATETIME·TIMESTAMP 에만, 소수 초 자릿수는 컬럼과 같아야 한다
export function nowText(type: string, now: NowSpec, what: string): string {
  const base = baseType(type);
  if (base !== 'datetime' && base !== 'timestamp') fail(`${what} CURRENT_TIMESTAMP 은 DATETIME·TIMESTAMP 에만 쓸 수 있습니다 (MySQL 1067)`);
  if ((now.fsp ?? 0) !== fspOf(type)) fail(`${what} CURRENT_TIMESTAMP 의 소수 초 자릿수가 컬럼(${type})과 다릅니다 (MySQL 1067)`);
  return now.fsp ? `CURRENT_TIMESTAMP(${now.fsp})` : 'CURRENT_TIMESTAMP';
}

// 기본값 원문 (SHOW CREATE 표기): 숫자도 따옴표로 감싸고 타입 자릿수에 맞춘다
export function normalizeDefault(spec: DefaultSpec, col: Pick<Column, 'name' | 'type' | 'nullable'>): string {
  const base = baseType(col.type);
  const bad = (why: string): never => fail(`컬럼 \`${col.name}\` 의 기본값이 올바르지 않습니다: ${why} (MySQL 1067)`);
  if (spec.kind === 'null') return col.nullable ? 'NULL' : bad('NOT NULL 컬럼에 NULL');
  if (NO_LITERAL_DEFAULT.has(base)) return fail(`${base.toUpperCase()} 컬럼에는 리터럴 기본값을 쓸 수 없습니다 (MySQL 1101)`);
  if (spec.kind === 'now') return nowText(col.type, spec, `컬럼 \`${col.name}\` 의 기본값`);
  if (base === 'bit') return spec.kind === 'bit' ? spec.value : /^\d+$/.test(spec.value) ? `b'${BigInt(spec.value).toString(2)}'` : bad(spec.value);
  if (spec.kind === 'bit') return bad(spec.value);
  if (NUMERIC.has(base) || base === 'year') return quoteString(numericDefault(spec.value, col.type, bad));
  if (base === 'enum') return quoteString(enumMembers(col.type).find((m) => m.toLowerCase() === spec.value.replace(/ +$/, '').toLowerCase()) ?? bad(`'${spec.value}' 은 ENUM 값이 아닙니다`));
  if (base === 'set') return quoteString(setDefault(spec.value, col.type, bad));
  return quoteString(spec.value);
}

// ponytail: 정수 범위·DECIMAL 자릿수 초과(MySQL 1067)는 검사하지 않는다 — 필요해지면 타입별 범위표를 둔다
function numericDefault(text: string, type: string, bad: (why: string) => never): string {
  const t = text.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return bad(`'${text}' 은 숫자가 아닙니다`);
  const base = baseType(type);
  if (/ unsigned$/.test(type) && t.startsWith('-') && Number(t) !== 0) return bad('UNSIGNED 컬럼에 음수');
  if (INT_TYPES.has(base) || base === 'year') return /^[+-]?\d+$/.test(t) ? BigInt(t).toString() : bad(`정수 컬럼에 '${text}'`);
  if (base === 'decimal') return Number(t).toFixed(Number(/^decimal\(\d+,(\d+)\)/.exec(type)![1]));
  return String(Number(t)); // float·double
}

// SET 기본값: 값마다 멤버여야 하고, 정의 순서로 다시 쓴다
function setDefault(text: string, type: string, bad: (why: string) => never): string {
  const members = enumMembers(type);
  const picked = text === '' ? [] : text.split(',').map((v) => members.find((m) => m.toLowerCase() === v.toLowerCase()) ?? bad(`'${v}' 은 SET 값이 아닙니다`));
  return members.filter((m) => picked.includes(m)).join(',');
}

// 사람이 쓴 컬럼 정의 → SHOW CREATE 모양 Column (table: 이 컬럼이 들어갈 테이블의 기본 문자셋)
export function finalizeColumn(spec: ColumnSpec, table: TableCharset): Column {
  const base = baseType(spec.type);
  if (spec.primaryKey && spec.nullable === true) fail(`PRIMARY KEY 컬럼 \`${spec.name}\` 은 NULL 일 수 없습니다 (MySQL 1171)`);
  if (spec.autoIncrement && !AUTO_INCREMENT_TYPES.has(base)) fail(`AUTO_INCREMENT 는 정수·실수 컬럼에만 쓸 수 있습니다: \`${spec.name}\` (MySQL 1063)`);
  if (spec.autoIncrement && spec.default) fail(`AUTO_INCREMENT 컬럼 \`${spec.name}\` 에는 기본값을 쓸 수 없습니다 (MySQL 1067)`);
  const nullable = spec.primaryKey ? false : spec.nullable ?? true;
  const col: Column = { name: spec.name, type: spec.type, ...columnCharset(spec.type, spec, table), nullable, invisible: spec.invisible, autoIncrement: spec.autoIncrement };
  if (spec.srid !== undefined) col.srid = spec.srid;
  if (spec.storage) col.storage = spec.storage;
  if (spec.columnFormat) col.columnFormat = spec.columnFormat;
  if (spec.default) col.default = normalizeDefault(spec.default, col);
  else if (nullable && !spec.autoIncrement && !NO_LITERAL_DEFAULT.has(base)) col.default = 'NULL';
  if (spec.onUpdate) col.onUpdate = nowText(spec.type, spec.onUpdate, `컬럼 \`${spec.name}\` 의 ON UPDATE`);
  if (spec.comment) col.comment = spec.comment;
  return col;
}

// 함수 RETURNS 타입: 타입 규칙으로 맞추고 문자열 타입이면 MySQL 처럼 ' CHARSET <스키마 기본 문자셋>' 을 붙인다
export function routineReturns(raw: string, charset: string): string {
  if (/\b(CHARSET|CHARACTER\s+SET|COLLATE)\b/i.test(raw)) fail(`RETURNS 안의 CHARSET·COLLATE 는 1차 지원 범위가 아닙니다: ${raw}`);
  const type = normalizeUserType(raw);
  return CHARSET_TYPES.has(baseType(type)) ? `${type} CHARSET ${canonicalCharset(charset)}` : type;
}
```

Run: `npx vitest run test/apply/normalize-mysql.test.ts` — Expected: PASS. 하나라도 실패하면 기대값이 아니라 구현을 고친다 (기대값은 MySQL 8.0/8.4 문서 기준이다. Task 9 의 실측과 다르면 그때 둘 다 고친다).

- [ ] **Step 7: 타입 검사와 커밋**

Run: `npm run typecheck -w @tdm/core` — Expected: 오류 없음

```bash
git add packages/core/src/parse-table.ts packages/core/src/apply/types.ts packages/core/src/apply/normalize-mysql.ts packages/core/src/apply/options.ts packages/core/test/apply/normalize-mysql.test.ts packages/core/test/apply/options.test.ts
git commit -m "feat(core): ALTER 적용 — 사람이 쓴 타입·기본값·문자셋을 SHOW CREATE 모양으로 맞추는 규칙"
```

---

### Task 2: 관대한 정의 파서

**Files:**
- Create: `packages/core/src/apply/def-parser.ts`
- Test: `packages/core/test/apply/def-parser.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `normalizeUserType`, `fail`, `ColumnSpec`, `DefaultSpec`, `NowSpec`, `Position`, `ConstraintItem`, `TableItem`; parse-table 의 `indexKind`, `parseIndex`, `parseForeignKey`, `refAction`
- Produces:
  - `parseColumnSpec(c: Cursor): ColumnSpec` — FIRST·AFTER 앞에서 멈춘다
  - `parsePosition(c: Cursor): Position`
  - `parseConstraint(c: Cursor): ConstraintItem`
  - `parseTableItem(c: Cursor): TableItem` — 끝까지 소비한다
  - `startsConstraint(c: Cursor): boolean`
  - `parseDefault(c: Cursor): DefaultSpec` — `DEFAULT` 뒤의 값
  - `parseIndexBody(c: Cursor, kind: IndexKind, name?: string): Index` — `[USING x] (키 파트) [옵션]`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/core/test/apply/def-parser.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseColumnSpec, parseConstraint, parsePosition, parseTableItem } from '../../src/apply/def-parser';
import { ApplyFailure } from '../../src/apply/types';
import { Cursor } from '../../src/cursor';
import { tokenize } from '../../src/lexer';

const cur = (src: string) => new Cursor(tokenize(src), src);

describe('parseColumnSpec', () => {
  it('백틱 없는 이름·소문자 키워드·타입 별칭·속성', () => {
    expect(parseColumnSpec(cur("price dec(12,4) not null default 0 comment '가격'"))).toEqual({
      name: 'price', type: 'decimal(12,4)', nullable: false, default: { kind: 'number', value: '0' }, comment: '가격',
      autoIncrement: false, invisible: false, primaryKey: false, unique: false,
    });
  });

  it('부호 있는 숫자·NOW()·ON UPDATE·컬럼 안 PRIMARY KEY·UNIQUE·REFERENCES(무시)·TRUE', () => {
    expect(parseColumnSpec(cur('n INT DEFAULT -1')).default).toEqual({ kind: 'number', value: '-1' });
    expect(parseColumnSpec(cur('f BOOL DEFAULT TRUE')).default).toEqual({ kind: 'number', value: '1' });
    expect(parseColumnSpec(cur('ts DATETIME(3) DEFAULT NOW(3) ON UPDATE CURRENT_TIMESTAMP(3)'))).toMatchObject({ type: 'datetime(3)', default: { kind: 'now', fsp: 3 }, onUpdate: { fsp: 3 } });
    expect(parseColumnSpec(cur('id INT AUTO_INCREMENT PRIMARY KEY'))).toMatchObject({ autoIncrement: true, primaryKey: true });
    expect(parseColumnSpec(cur('code VARCHAR(10) UNIQUE KEY'))).toMatchObject({ unique: true });
    expect(parseColumnSpec(cur('pid INT REFERENCES parent(id) ON DELETE CASCADE'))).toMatchObject({ name: 'pid', type: 'int' });
    expect(parseColumnSpec(cur('s VARCHAR(5) CHARACTER SET latin1 COLLATE latin1_bin'))).toMatchObject({ charset: 'latin1', collation: 'latin1_bin' });
  });

  it('FIRST·AFTER 앞에서 멈춘다', () => {
    const c = cur('a INT NOT NULL AFTER b');
    expect(parseColumnSpec(c).nullable).toBe(false);
    expect(parsePosition(c)).toEqual({ after: 'b' });
    expect(parsePosition(cur('FIRST'))).toEqual({ first: true });
  });

  it.each([['g INT AS (a + 1)'], ['g INT GENERATED ALWAYS AS (a) STORED'], ['c INT CHECK (c > 0)'], ['d INT DEFAULT (1 + 1)'], ['b VARCHAR(1) BINARY'], ['x INT FOO'], ['h BINARY(2) DEFAULT 0x0102']])('%s 는 거부', (src) => {
    expect(() => parseColumnSpec(cur(src))).toThrow(ApplyFailure);
  });
});

describe('parseConstraint / parseTableItem', () => {
  it('이름 없는 인덱스·USING 앞자리·CONSTRAINT UNIQUE·PRIMARY KEY 이름 무시', () => {
    expect(parseConstraint(cur('INDEX (a, b DESC)'))).toEqual({ kind: 'index', named: false, index: { name: '', kind: 'INDEX', parts: [{ column: 'a', desc: false }, { column: 'b', desc: true }], invisible: false } });
    expect(parseConstraint(cur('KEY ix USING BTREE (a)'))).toMatchObject({ named: true, index: { name: 'ix', using: 'BTREE' } });
    expect(parseConstraint(cur('CONSTRAINT uq UNIQUE (code)'))).toMatchObject({ named: true, index: { name: 'uq', kind: 'UNIQUE' } });
    expect(parseConstraint(cur('PRIMARY KEY pk (id)'))).toMatchObject({ named: true, index: { name: 'PRIMARY', kind: 'PRIMARY' } });
    expect(parseConstraint(cur("FULLTEXT KEY ft (title) WITH PARSER ngram COMMENT 'x'"))).toMatchObject({ index: { kind: 'FULLTEXT', parser: 'ngram', comment: 'x' } });
  });

  it('FOREIGN KEY: CONSTRAINT 이름·인덱스 이름', () => {
    expect(parseConstraint(cur('CONSTRAINT fk_p FOREIGN KEY ix_p (pid) REFERENCES parent (id) ON DELETE CASCADE'))).toEqual({
      kind: 'fk', named: true, indexName: 'ix_p', fk: { name: 'fk_p', columns: ['pid'], refTable: 'parent', refColumns: ['id'], onDelete: 'CASCADE' },
    });
    expect(parseConstraint(cur('FOREIGN KEY (pid) REFERENCES parent(id)'))).toMatchObject({ kind: 'fk', named: false, fk: { name: '' } });
  });

  it('컬럼과 제약을 가른다, 함수 인덱스·CHECK·끝에 남은 내용은 거부', () => {
    expect(parseTableItem(cur('`key` INT')).kind).toBe('column');
    expect(parseTableItem(cur('UNIQUE KEY (a)')).kind).toBe('index');
    expect(() => parseConstraint(cur('INDEX ((a + 1))'))).toThrow(ApplyFailure);
    expect(() => parseConstraint(cur('CONSTRAINT c CHECK (a > 0)'))).toThrow(ApplyFailure);
    expect(() => parseTableItem(cur('a INT FIRST'))).toThrow(ApplyFailure);
  });
});
```

Run: `npx vitest run test/apply/def-parser.test.ts` — Expected: FAIL (모듈 없음)

- [ ] **Step 2: def-parser.ts 를 구현한다**

```ts
// 사람이 쓴 컬럼·인덱스·FK 정의를 읽는다 (ALTER TABLE ADD·MODIFY·CHANGE, CREATE TABLE, CREATE INDEX).
// 백틱 없는 이름·소문자 키워드·컬럼 안 제약(PRIMARY KEY·UNIQUE·REFERENCES)을 받는다. 덤프용 parse-table 은 SHOW CREATE 형식만
// 읽으므로 따로 두고, 키 파트·인덱스 옵션·FK 본문은 그 파서를 그대로 쓴다
import type { Cursor } from '../cursor';
import type { ColumnFormat, ColumnStorage, Index, IndexKind } from '../model';
import { indexKind, parseForeignKey, parseIndex, refAction } from '../parse-table';
import { normalizeUserType } from './normalize-mysql';
import { fail, type ColumnSpec, type ConstraintItem, type DefaultSpec, type NowSpec, type Position, type TableItem } from './types';

const OUT_OF_SCOPE = '은(는) 1차 지원 범위가 아닙니다 (MySQL 이 식을 다시 써서 저장합니다) — td-export 로 다시 뽑아 올려 주세요';
const TYPE_MODIFIERS: ReadonlySet<string> = new Set(['UNSIGNED', 'SIGNED', 'ZEROFILL', 'PRECISION', 'VARYING']);
const CONSTRAINT_START: ReadonlySet<string> = new Set(['PRIMARY', 'KEY', 'INDEX', 'UNIQUE', 'FULLTEXT', 'SPATIAL', 'CONSTRAINT', 'FOREIGN', 'CHECK']);
const NOW_WORDS: ReadonlySet<string> = new Set(['CURRENT_TIMESTAMP', 'NOW', 'LOCALTIME', 'LOCALTIMESTAMP']);

// 컬럼 정의: 이름 타입 [속성…]. FIRST·AFTER 앞에서 멈춘다 (위치는 parsePosition)
export function parseColumnSpec(c: Cursor): ColumnSpec {
  const name = c.ident();
  const typeStart = c.next();
  let typeEnd = typeStart;
  for (;;) {
    if (c.isOp('(')) {
      c.next();
      typeEnd = c.closeParen();
      continue;
    }
    const t = c.peek();
    if (t?.t === 'word' && TYPE_MODIFIERS.has(t.v.toUpperCase())) {
      typeEnd = c.next();
      continue;
    }
    break;
  }
  const spec: ColumnSpec = { name, type: normalizeUserType(c.src.slice(typeStart.s, typeEnd.e)), autoIncrement: false, invisible: false, primaryKey: false, unique: false };
  while (!c.done && !c.isWord('FIRST') && !c.isWord('AFTER')) columnAttr(c, spec);
  return spec;
}

function columnAttr(c: Cursor, s: ColumnSpec): void {
  if (c.acceptWord('NOT', 'NULL')) s.nullable = false;
  else if (c.acceptWord('NULL')) s.nullable = true;
  else if (c.acceptWord('DEFAULT')) s.default = parseDefault(c);
  else if (c.acceptWord('ON', 'UPDATE')) s.onUpdate = nowSpec(c) ?? fail('ON UPDATE 에는 CURRENT_TIMESTAMP 만 쓸 수 있습니다');
  else if (c.acceptWord('AUTO_INCREMENT')) s.autoIncrement = true;
  else if (c.acceptWord('PRIMARY', 'KEY') || c.acceptWord('KEY')) s.primaryKey = true;
  else if (c.acceptWord('UNIQUE')) {
    c.acceptWord('KEY');
    s.unique = true;
  } else if (c.acceptWord('COMMENT')) s.comment = c.string();
  else if (c.acceptWord('CHARACTER', 'SET') || c.acceptWord('CHARSET')) s.charset = c.ident();
  else if (c.acceptWord('COLLATE')) s.collation = c.ident();
  else if (c.acceptWord('VISIBLE')) s.invisible = false;
  else if (c.acceptWord('INVISIBLE')) s.invisible = true;
  else if (c.acceptWord('SRID')) s.srid = Number(c.next().v);
  else if (c.acceptWord('STORAGE')) s.storage = oneOf(c, ['DISK', 'MEMORY']) as ColumnStorage;
  else if (c.acceptWord('COLUMN_FORMAT')) s.columnFormat = oneOf(c, ['FIXED', 'DYNAMIC', 'DEFAULT']) as ColumnFormat;
  else if (c.acceptWord('REFERENCES')) skipReferences(c); // MySQL 은 컬럼 안 REFERENCES 를 읽고 무시한다
  else if (c.isWord('CHECK')) fail(`CHECK 제약 ${OUT_OF_SCOPE}`);
  else if (c.isWord('GENERATED') || c.isWord('AS')) fail(`생성 컬럼 ${OUT_OF_SCOPE}`);
  else if (c.isWord('SERIAL')) fail('SERIAL DEFAULT VALUE 는 1차 지원 범위가 아닙니다');
  else if (c.isWord('BINARY')) fail('컬럼 속성 BINARY 는 1차 지원 범위가 아닙니다 — COLLATE …_bin 으로 쓰세요');
  else fail(`알 수 없는 컬럼 속성 '${c.peek()!.v}'`);
}

function oneOf(c: Cursor, values: readonly string[]): string {
  const v = c.next().v.toUpperCase();
  return values.includes(v) ? v : fail(`${values.join('|')} 가 필요합니다`);
}

function skipReferences(c: Cursor): void {
  c.ident();
  if (c.acceptOp('.')) c.ident();
  if (c.isOp('(')) c.parenTokens();
  for (;;) {
    if (c.acceptWord('MATCH')) c.next();
    else if (c.acceptWord('ON', 'DELETE') || c.acceptWord('ON', 'UPDATE')) refAction(c);
    else return;
  }
}

// DEFAULT 뒤의 값 (ALTER COLUMN … SET DEFAULT 도 쓴다)
export function parseDefault(c: Cursor): DefaultSpec {
  const t = c.next();
  if (t.t === 'op' && (t.v === '-' || t.v === '+')) {
    const n = c.next();
    if (n.t !== 'number') return fail(`기본값으로 쓸 수 없는 값입니다: ${t.v}${n.v}`);
    return { kind: 'number', value: (t.v === '-' ? '-' : '') + n.v };
  }
  if (t.t === 'op' && t.v === '(') return fail(`식 기본값 DEFAULT (…) ${OUT_OF_SCOPE}`);
  if (t.t === 'string') return { kind: 'string', value: t.v };
  if (t.t === 'number') {
    if (/^[bB]'/.test(t.v)) return { kind: 'bit', value: `b'${t.v.slice(2, -1)}'` };
    if (/^(0[xb]|[xX]')/.test(t.v)) return fail('16진수 기본값은 1차 지원 범위가 아닙니다');
    return { kind: 'number', value: t.v };
  }
  if (t.t === 'word') {
    const w = t.v.toUpperCase();
    if (w === 'NULL') return { kind: 'null' };
    if (w === 'TRUE' || w === 'FALSE') return { kind: 'number', value: w === 'TRUE' ? '1' : '0' };
    c.i--;
    const now = nowSpec(c);
    if (now) return { kind: 'now', ...now };
  }
  return fail(`기본값으로 쓸 수 없는 값입니다: ${t.v} (1차 지원 범위: 리터럴, NULL, CURRENT_TIMESTAMP)`);
}

// CURRENT_TIMESTAMP[()|(n)], NOW([n]), LOCALTIME[()], LOCALTIMESTAMP[()]. 해당하지 않으면 소비하지 않고 undefined
function nowSpec(c: Cursor): NowSpec | undefined {
  const t = c.peek();
  if (t?.t !== 'word' || !NOW_WORDS.has(t.v.toUpperCase())) return undefined;
  c.next();
  if (!c.isOp('(')) return t.v.toUpperCase() === 'NOW' ? fail('NOW 뒤에 () 가 필요합니다') : {};
  const raw = c.parenRaw();
  if (raw === '' || raw === '0') return {};
  return /^[1-6]$/.test(raw) ? { fsp: Number(raw) } : fail(`소수 초 자릿수는 0~6 이어야 합니다: ${raw}`);
}

export function parsePosition(c: Cursor): Position {
  if (c.acceptWord('FIRST')) return { first: true };
  if (c.acceptWord('AFTER')) return { after: c.ident() };
  return undefined;
}

export const startsConstraint = (c: Cursor): boolean => {
  const t = c.peek();
  return t?.t === 'word' && CONSTRAINT_START.has(t.v.toUpperCase());
};

// CREATE TABLE 괄호 안 항목 하나 (끝까지 소비한다)
export function parseTableItem(c: Cursor): TableItem {
  const item: TableItem = startsConstraint(c) ? parseConstraint(c) : { kind: 'column', spec: parseColumnSpec(c) };
  if (!c.done) fail(`정의 뒤에 알 수 없는 내용이 있습니다: ${c.peek()!.v}`);
  return item;
}

// 인덱스·제약 정의 (CREATE TABLE 항목, ALTER TABLE ADD 뒤)
export function parseConstraint(c: Cursor): ConstraintItem {
  let symbol: string | undefined;
  if (c.acceptWord('CONSTRAINT') && !['PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK'].some((w) => c.isWord(w))) symbol = c.ident();
  if (c.isWord('CHECK')) return fail(`CHECK 제약 추가${OUT_OF_SCOPE}`);
  if (c.acceptWord('PRIMARY', 'KEY')) return { kind: 'index', index: { ...parseIndexBody(c, 'PRIMARY'), name: 'PRIMARY' }, named: true };
  if (c.acceptWord('FOREIGN', 'KEY')) {
    const indexName = c.isOp('(') ? undefined : c.ident();
    return { kind: 'fk', fk: parseForeignKey(c, symbol ?? ''), ...(indexName !== undefined ? { indexName } : {}), named: symbol !== undefined };
  }
  const kind = indexKind(c) ?? fail(`알 수 없는 정의입니다: ${c.peek()?.v ?? '(끝)'}`);
  if (symbol !== undefined && kind !== 'UNIQUE') fail('CONSTRAINT 이름은 PRIMARY KEY·UNIQUE·FOREIGN KEY 에만 붙일 수 있습니다');
  const name = c.isOp('(') || c.isWord('USING') ? symbol : c.ident();
  return { kind: 'index', index: parseIndexBody(c, kind, name ?? ''), named: name !== undefined };
}

// [USING x] (키 파트) [옵션…]. PRIMARY KEY 뒤의 이름은 MySQL 이 무시한다. 함수 인덱스는 1차 범위 밖
export function parseIndexBody(c: Cursor, kind: IndexKind, name = ''): Index {
  if (kind === 'PRIMARY' && !c.isOp('(') && !c.isWord('USING')) c.ident();
  const using = c.acceptWord('USING') ? c.ident().toUpperCase() : undefined;
  const index = parseIndex(c, kind, name);
  if (index.parts.some((p) => p.expr !== undefined)) fail(`함수 인덱스${OUT_OF_SCOPE}`);
  return using && !index.using ? { ...index, using } : index;
}
```

Run: `npx vitest run test/apply/def-parser.test.ts` — Expected: PASS

- [ ] **Step 3: 타입 검사와 커밋**

Run: `npm run typecheck -w @tdm/core` — Expected: 오류 없음

```bash
git add packages/core/src/apply/def-parser.ts packages/core/test/apply/def-parser.test.ts
git commit -m "feat(core): ALTER 적용 — 사람이 쓴 컬럼·인덱스·FK 정의를 읽는 관대한 파서"
```

---

### Task 3: 적용 상태·SET 문·applyScript 뼈대

**Files:**
- Create: `packages/core/src/apply/lists.ts`, `packages/core/src/apply/state.ts`, `packages/core/src/apply/session.ts`, `packages/core/src/apply/index.ts`
- Modify: `packages/core/src/apply/def-parser.ts` (`checkList` 를 `splitList` 로), `packages/core/src/apply/normalize-mysql.ts` (ENUM·SET 값·타입 인자 목록을 `splitList` 로)
- Test: `packages/core/test/apply/lists.test.ts`, `packages/core/test/apply/session.test.ts`, `packages/core/test/apply/apply-script.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `fail`, `ApplyFailure`, `MYSQL_DEFAULTS`, `DEFAULT_SQL_MODE`, `ApplyOptions`, `ApplyResult`, `canonicalCharset`, `canonicalCollation`, `charsetOfCollation`; parse-dump 의 `splitDump`; sql-safety 의 `UnsafeValueError`
- Produces:
  - `lists.ts`: `splitList(toks, what): Token[][]` — 쉼표 목록. 빈 목록·빈 항목·끝 쉼표는 `(MySQL 1064)` (`splitTopLevel` 은 끝 쉼표를 조용히 버린다)
  - `state.ts`: `State`, `Origins`, `initialState(base, schemaName, defaults, sqlMode)`, `trackNew(origins, table, fromBase)`, `moveOrigins(origins, from, to)`, `forgetOrigins(origins, name)`, `sameName(a, b)`, `findColumn(t, name)`, `findTable(st, name)`, `nameTaken(st, name)`, `needTable(st, name)`, `replaceTable(st, name, next)`, `objectName(c, st)`, `objectNameList(c, st)`
  - `session.ts`: `applySet(st, c)` — `c` 는 `SET` 앞
  - `index.ts`: `applyScript(base, script, opts): ApplyResult`, re-export `MYSQL_DEFAULTS`·타입. 문장 분기 함수 `applyStatement` 는 Task 5~7 이 한 줄씩 늘린다

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/core/test/apply/lists.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { splitList } from '../../src/apply/lists';
import { ApplyFailure } from '../../src/apply/types';
import { tokenize } from '../../src/lexer';

const items = (src: string) => splitList(tokenize(src), '테스트').map((toks) => toks.map((t) => t.v).join(' '));

describe('splitList', () => {
  it('깊이 0 쉼표로 나눈다', () => {
    expect(items('a INT, b VARCHAR(10, 2), c')).toEqual(['a INT', 'b VARCHAR ( 10 , 2 )', 'c']);
  });

  it.each([[''], ['a,'], ['a,,b'], [',a']])('%j 는 1064', (src) => {
    expect(() => items(src)).toThrow(ApplyFailure);
    expect(() => items(src)).toThrow(/1064/);
  });
});
```

`packages/core/test/apply/session.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applySet } from '../../src/apply/session';
import { initialState } from '../../src/apply/state';
import { ApplyFailure, DEFAULT_SQL_MODE, MYSQL_DEFAULTS } from '../../src/apply/types';
import { Cursor } from '../../src/cursor';
import { tokenize } from '../../src/lexer';

const empty = { name: 'shop', tables: [], views: [], routines: [] };

describe('SET 문', () => {
  it('FOREIGN_KEY_CHECKS 의 @OLD_ 저장·복원과 SQL_MODE (DEFAULT 포함)를 따른다', () => {
    const st = initialState(empty, 'shop', MYSQL_DEFAULTS, DEFAULT_SQL_MODE);
    const set = (sql: string) => applySet(st, new Cursor(tokenize(sql), sql));
    set('SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0');
    expect(st.fkChecks).toBe(false);
    set('SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS');
    expect(st.fkChecks).toBe(true);
    set("SET SESSION sql_mode = 'ansi_quotes,strict_trans_tables'");
    expect(st.sqlMode).toBe('ANSI_QUOTES,STRICT_TRANS_TABLES');
    set('SET @@session.sql_mode = DEFAULT');
    expect(st.sqlMode).toBe(DEFAULT_SQL_MODE);
    set("SET NAMES utf8mb4, time_zone = '+00:00'");
    expect(st.fkChecks).toBe(true);
  });

  it('GLOBAL·식 값·저장하지 않은 변수는 거부한다', () => {
    const st = initialState(empty, 'shop', MYSQL_DEFAULTS, DEFAULT_SQL_MODE);
    const set = (sql: string) => () => applySet(st, new Cursor(tokenize(sql), sql));
    expect(set('SET GLOBAL foreign_key_checks = 0')).toThrow(ApplyFailure);
    expect(set("SET sql_mode = CONCAT(@@sql_mode, ',X')")).toThrow(ApplyFailure);
    expect(set('SET FOREIGN_KEY_CHECKS = @never_saved')).toThrow(ApplyFailure);
  });
});
```

`packages/core/test/apply/apply-script.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyScript } from '../../src/apply';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

const base = parseSqlDump(tdExport('CREATE TABLE `t` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;\n')).model;
const run = (script: string) => applyScript(base, script, { schemaName: 'shop' });

describe('applyScript — 문장 처리', () => {
  it('SET·USE·주석만 있으면 적용할 문장이 없다', () => {
    expect(run('SET NAMES utf8mb4; SET FOREIGN_KEY_CHECKS = 0; USE shop; -- 주석\n')).toEqual({ ok: false, error: { index: 0, line: 1, statement: '', reason: '적용할 DDL 문장이 없습니다' } });
  });

  it('지원하지 않는 문장·다른 스키마 USE·VIEW 는 그 문장 번호·줄과 함께 실패한다', () => {
    expect(run('SET NAMES utf8mb4;\nINSERT INTO t VALUES (1);')).toMatchObject({ ok: false, error: { index: 2, line: 2, statement: 'INSERT INTO t VALUES (1)' } });
    expect(run('USE other;')).toMatchObject({ ok: false, error: { index: 1 } });
    expect(run('CREATE OR REPLACE VIEW v AS SELECT 1;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('VIEW') } });
  });

  it('닫히지 않은 따옴표는 문장으로 나누지 못한다', () => {
    expect(run("ALTER TABLE t COMMENT 'x;")).toMatchObject({ ok: false, error: { index: 0, reason: expect.stringContaining('나누지 못했습니다') } });
  });

  it('입력 모델을 바꾸지 않고, 맞지 않는 스키마 기본값은 거부한다', () => {
    const before = JSON.stringify(base);
    run('INSERT INTO t VALUES (1);');
    expect(JSON.stringify(base)).toBe(before);
    expect(applyScript(base, 'SET NAMES utf8mb4;', { schemaName: 'shop', defaults: { charset: 'latin1', collation: 'utf8mb4_bin' } })).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1253') } });
  });
});
```

Run: `npx vitest run test/apply/lists.test.ts test/apply/session.test.ts test/apply/apply-script.test.ts` (in `packages/core`) — Expected: FAIL (모듈 없음)

- [ ] **Step 2: lists.ts 를 만들고 앞 Task 의 목록 검사를 이것으로 모은다**

`packages/core/src/apply/lists.ts`:

```ts
// 쉼표 목록. splitTopLevel(덤프 파서와 공용)은 끝 쉼표를 조용히 버리고 빈 항목을 남긴다 — 사람이 쓴 스크립트에서는 MySQL 처럼 1064 로 거부한다
import { splitTopLevel } from '../cursor';
import type { Token } from '../lexer';
import { fail } from './types';

export function splitList(toks: readonly Token[], what: string): Token[][] {
  if (!toks.length) fail(`${what} 목록이 비었습니다 (MySQL 1064)`);
  const last = toks[toks.length - 1];
  if (last.t === 'op' && last.v === ',') fail(`${what} 목록이 쉼표로 끝납니다 (MySQL 1064)`);
  const items = splitTopLevel([...toks]);
  if (items.some((i) => !i.length)) fail(`${what} 목록에 빈 항목이 있습니다 (MySQL 1064)`);
  return items;
}
```

그리고 앞 Task 의 두 곳을 이 함수로 바꾼다 (동작은 같거나 더 엄격하다 — 기존 테스트는 그대로 통과해야 한다):
- `def-parser.ts` 의 `checkList(inner, what)` 본문을 `splitList(inner, what);` 한 줄로 바꾼다 (결과는 쓰지 않는다 — 키 파트·FK 목록 파싱은 parse-table 이 한다).
- `normalize-mysql.ts` 의 `enumValues` 와 `withArgs` 에서 `splitTopLevel(inner)` 를 `splitList(inner, 'ENUM·SET 값')`·`splitList(inner, '타입 인자')` 로 바꾼다. `ENUM('a','b',)`·`DECIMAL(10,)` 가 1064 로 거부되는 테스트를 normalize-mysql.test.ts 에 더한다. 빈 괄호 검사가 이미 있으면 메시지가 바뀌어도 테스트가 통과하는지 확인한다.

- [ ] **Step 3: state.ts 를 구현한다**

```ts
// ALTER 적용 중 상태: 작업용 모델 사본, 세션 값(FOREIGN_KEY_CHECKS·SQL_MODE), 기준 이름 추적
import { Cursor } from '../cursor';
import type { Column, SchemaModel, Table } from '../model';
import { splitList } from './lists';
import { fail, type ApplyDefaults } from './types';

// 지금 이름 → 기준 버전 이름 (스크립트에서 새로 만든 것은 undefined). 끝에서 rename 매핑을 만든다
export interface Origins {
  tables: Map<string, string | undefined>;
  columns: Map<string, Map<string, string | undefined>>; // 테이블(지금 이름) → (컬럼 지금 이름 → 기준 이름)
  indexes: Map<string, Map<string, string | undefined>>;
}

export interface State {
  model: SchemaModel; // ponytail: 작업용 사본 하나를 고쳐 쓴다 (입력 모델은 그대로, 실패하면 통째로 버린다)
  readonly schemaName: string;
  readonly defaults: ApplyDefaults;
  fkChecks: boolean;
  sqlMode: string;
  readonly saved: Map<string, string>; // SET @v = … 로 저장한 사용자 변수 (소문자, '@' 포함)
  readonly origins: Origins;
}

export function initialState(base: SchemaModel, schemaName: string, defaults: ApplyDefaults, sqlMode: string): State {
  const model = structuredClone(base);
  const origins: Origins = { tables: new Map(), columns: new Map(), indexes: new Map() };
  for (const t of model.tables) trackNew(origins, t, true);
  return { model, schemaName, defaults, fkChecks: true, sqlMode, saved: new Map(), origins };
}

// 테이블의 이름 추적을 시작한다 (fromBase: 기준 버전에 있던 테이블이면 지금 이름이 곧 기준 이름)
export function trackNew(origins: Origins, t: Table, fromBase: boolean): void {
  const origin = (name: string) => (fromBase ? name : undefined);
  origins.tables.set(t.name, origin(t.name));
  origins.columns.set(t.name, new Map(t.columns.map((c) => [c.name, origin(c.name)])));
  origins.indexes.set(t.name, new Map(t.indexes.map((i) => [i.name, origin(i.name)])));
}

export function moveOrigins(origins: Origins, from: string, to: string): void {
  for (const m of [origins.tables, origins.columns, origins.indexes] as Map<string, unknown>[]) {
    if (!m.has(from)) continue;
    m.set(to, m.get(from));
    m.delete(from);
  }
}

export function forgetOrigins(origins: Origins, name: string): void {
  origins.tables.delete(name);
  origins.columns.delete(name);
  origins.indexes.delete(name);
}

// 컬럼·인덱스·제약 이름은 대소문자를 구분하지 않는다
export const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
export const findColumn = (t: Pick<Table, 'columns'>, name: string): Column | undefined => t.columns.find((c) => sameName(c.name, name));
// 테이블 이름은 대소문자를 구분한다 (Linux 기본 lower_case_table_names=0)
export const findTable = (st: State, name: string): Table | undefined => st.model.tables.find((t) => t.name === name);
// 테이블·뷰는 이름 공간을 함께 쓴다
export const nameTaken = (st: State, name: string): boolean => st.model.tables.some((t) => t.name === name) || st.model.views.some((v) => v.name === name);

export function needTable(st: State, name: string): Table {
  const t = findTable(st, name) ?? fail(`테이블 \`${name}\` 이 없습니다 (MySQL 1146)`);
  if (t.parseError) fail(`테이블 \`${name}\` 은 파싱하지 못한 정의라 바꿀 수 없습니다 — td-export 로 다시 뽑아 올려 주세요`);
  return t;
}

export function replaceTable(st: State, name: string, next: Table): void {
  st.model.tables = st.model.tables.map((t) => (t.name === name ? next : t));
}

// 스키마 한정 이름: `cur`.`t` 는 현재 스키마일 때만 받는다
export function objectName(c: Cursor, st: State): string {
  const first = c.ident();
  if (!c.acceptOp('.')) return first;
  if (first !== st.schemaName) fail(`다른 스키마 \`${first}\` 의 객체는 바꿀 수 없습니다 — 이 버전은 스키마 \`${st.schemaName}\` 하나를 나타냅니다`);
  return c.ident();
}

// 'a [, b …] [RESTRICT|CASCADE]' 이름 목록 (DROP TABLE·DROP VIEW). c 는 목록 앞
export function objectNameList(c: Cursor, st: State): string[] {
  return splitList(c.toks.slice(c.i), '이름').map((toks) => {
    const one = new Cursor(toks, c.src);
    const name = objectName(one, st);
    if (!one.acceptWord('RESTRICT')) one.acceptWord('CASCADE');
    if (!one.done) fail(`알 수 없는 내용입니다: ${one.peek()!.v}`);
    return name;
  });
}
```

- [ ] **Step 4: session.ts 를 구현한다**

```ts
// SET 문: FOREIGN_KEY_CHECKS·SQL_MODE 만 추적한다 (NAMES 등 나머지는 스키마에 영향이 없어 무시).
// td-export·마이그레이션 스크립트의 'SET @OLD_X = @@X, X = 0' 저장과 'SET X = @OLD_X' 복원을 따른다
import { Cursor } from '../cursor';
import { splitList } from './lists';
import type { State } from './state';
import { DEFAULT_SQL_MODE, fail } from './types';

export function applySet(st: State, c: Cursor): void {
  c.expectWord('SET');
  for (const toks of splitList(c.toks.slice(c.i), 'SET')) assign(st, new Cursor(toks, c.src));
}

function assign(st: State, a: Cursor): void {
  if (a.isWord('NAMES') || a.isWord('CHARACTER') || a.isWord('CHARSET')) return;
  if (a.isWord('GLOBAL') || a.isWord('PERSIST') || a.isWord('PERSIST_ONLY')) fail('SET GLOBAL·PERSIST 는 받을 수 없습니다');
  if (!a.acceptWord('SESSION')) a.acceptWord('LOCAL');
  const target = variable(a);
  if (!a.acceptOp('=')) {
    a.expectOp(':');
    a.expectOp('=');
  }
  const value = valueOf(st, a);
  if (!a.done) fail(`SET 값은 리터럴·@변수·@@변수만 받습니다: ${a.src.slice(a.peek()!.s).trim()}`);
  if (target.startsWith('@')) st.saved.set(target, value);
  else if (target === 'foreign_key_checks') st.fkChecks = !['0', 'OFF'].includes(value.toUpperCase());
  else if (target === 'sql_mode') st.sqlMode = sqlModeOf(value);
}

// '@v' (사용자 변수), '@@[session.]x' 와 'x' (세션 변수, 소문자)
function variable(a: Cursor): string {
  if (!a.acceptOp('@')) return a.ident().toLowerCase();
  return a.acceptOp('@') ? systemName(a) : `@${a.ident().toLowerCase()}`;
}

function systemName(a: Cursor): string {
  const first = a.ident().toLowerCase();
  if (!a.acceptOp('.')) return first;
  if (first === 'global') fail('SET GLOBAL 은 받을 수 없습니다');
  return a.ident().toLowerCase();
}

function valueOf(st: State, a: Cursor): string {
  if (a.acceptOp('@')) {
    if (a.acceptOp('@')) return current(st, systemName(a));
    const name = `@${a.ident().toLowerCase()}`;
    return st.saved.get(name) ?? fail(`값을 저장하지 않은 변수입니다: ${name}`);
  }
  const t = a.next();
  if (t.t === 'string' || t.t === 'number') return t.v;
  if (t.t === 'word') return t.v.toUpperCase();
  return fail(`SET 값을 읽을 수 없습니다: ${t.v}`);
}

const current = (st: State, name: string): string => (name === 'foreign_key_checks' ? (st.fkChecks ? '1' : '0') : name === 'sql_mode' ? st.sqlMode : '');

function sqlModeOf(value: string): string {
  if (value === 'DEFAULT') return DEFAULT_SQL_MODE;
  return /^[A-Za-z_,]*$/.test(value) ? value.toUpperCase() : fail(`SQL_MODE 값을 읽을 수 없습니다: ${value}`);
}
```

- [ ] **Step 5: index.ts 를 구현한다**

```ts
// ALTER 스크립트 → 새 모델. 문장마다 MySQL 과 같은 결과를 만들고, 받을 수 없는 문장에서 멈춘다 (부분 적용하지 않는다)
import { Cursor, ParseError } from '../cursor';
import type { RenameMapping } from '../diff';
import { LexError, tokenize } from '../lexer';
import type { SchemaModel } from '../model';
import { splitDump } from '../parse-dump';
import { UnsafeValueError } from '../sql-safety';
import { canonicalCharset, canonicalCollation, charsetOfCollation } from './normalize-mysql';
import { applySet } from './session';
import { initialState, type State } from './state';
import { ApplyFailure, DEFAULT_SQL_MODE, fail, MYSQL_DEFAULTS, type ApplyDefaults, type ApplyOptions, type ApplyResult } from './types';

export { MYSQL_DEFAULTS, type ApplyDefaults, type ApplyError, type ApplyOptions, type ApplyResult } from './types';

const MAX_STATEMENT_TEXT = 500;
const VIEW_RE = /^(?:CREATE\s+(?:OR\s+REPLACE\s+)?|ALTER\s+)(?:ALGORITHM\s*=\s*\w+\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:SQL\s+SECURITY\s+\w+\s+)?VIEW\b/i;

export function applyScript(base: SchemaModel, script: string, opts: ApplyOptions): ApplyResult {
  let statements;
  let defaults: ApplyDefaults;
  try {
    statements = splitDump(script.replace(/^\uFEFF/, ''));
    defaults = checkDefaults({ ...MYSQL_DEFAULTS, ...opts.defaults });
  } catch (e) {
    if (e instanceof LexError) return failure(0, 1, '', `스크립트를 문장으로 나누지 못했습니다: ${e.message}`);
    if (e instanceof ApplyFailure) return failure(0, 1, '', e.message);
    throw e;
  }
  const st = initialState(base, opts.schemaName, defaults, DEFAULT_SQL_MODE);
  let applied = 0;
  for (const [i, s] of statements.entries()) {
    try {
      if (applyStatement(st, s.ddl, s.noBackslashEscapes)) applied++;
    } catch (e) {
      if (e instanceof ApplyFailure || e instanceof ParseError || e instanceof LexError || e instanceof UnsafeValueError) return failure(i + 1, s.line, s.ddl, e.message);
      throw e;
    }
  }
  if (applied === 0) return failure(0, 1, '', '적용할 DDL 문장이 없습니다');
  return { ok: true, model: st.model, applied, renames: collectRenames(st), defaults };
}

const failure = (index: number, line: number, statement: string, reason: string): ApplyResult =>
  ({ ok: false, error: { index, line, statement: statement.slice(0, MAX_STATEMENT_TEXT), reason } });

// 스키마 기본 문자셋·콜레이션: 이름을 MySQL 표기로 맞추고 서로 맞는지 본다
function checkDefaults(d: ApplyDefaults): ApplyDefaults {
  const charset = canonicalCharset(d.charset);
  const collation = canonicalCollation(d.collation);
  if (charsetOfCollation(collation) !== charset) fail(`스키마 기본 콜레이션 ${collation} 은 문자셋 ${charset} 의 콜레이션이 아닙니다 (MySQL 1253)`);
  return { charset, collation };
}

// DDL 을 적용했으면 true, 세션 문장(SET·USE)이면 false
function applyStatement(st: State, ddl: string, noBackslashEscapes: boolean): boolean {
  const c = new Cursor(tokenize(ddl, { noBackslashEscapes }), ddl);
  if (c.isWord('SET')) {
    applySet(st, c);
    return false;
  }
  if (c.acceptWord('USE')) {
    const db = c.ident();
    if (db !== st.schemaName || !c.done) fail(`다른 스키마로 USE 할 수 없습니다: ${db}`);
    return false;
  }
  // 문장 종류별 처리 (Task 5~7 에서 이 자리에 추가한다)
  return fail(unsupported(ddl));
}

function unsupported(ddl: string): string {
  if (VIEW_RE.test(ddl)) return 'CREATE·ALTER VIEW 는 1차 지원 범위가 아닙니다 (MySQL 이 뷰 본문을 다시 써서 저장합니다) — td-export 로 다시 뽑아 올려 주세요';
  const head = ddl.split(/\s+/).slice(0, 3).join(' ');
  return `지원하지 않는 문장입니다: ${head} — 1차 지원 범위는 ALTER·CREATE·DROP·RENAME TABLE, CREATE·DROP INDEX, CREATE·DROP FUNCTION·PROCEDURE, DROP VIEW 입니다`;
}

// 기준 → 결과 이름 대응 (diff 의 rename 매핑 형식). 새로 만든 객체·지운 객체는 들어가지 않는다
function collectRenames(st: State): RenameMapping[] {
  const out: RenameMapping[] = [];
  for (const [to, from] of st.origins.tables) if (from !== undefined && from !== to) out.push({ kind: 'table', from, to });
  for (const [table, cols] of st.origins.columns) for (const [to, from] of cols) if (from !== undefined && from !== to) out.push({ kind: 'column', table, from, to });
  for (const [table, idx] of st.origins.indexes) for (const [to, from] of idx) if (from !== undefined && from !== to && to !== 'PRIMARY') out.push({ kind: 'index', table, from, to });
  return out;
}
```

Run: `npx vitest run test/apply/lists.test.ts test/apply/session.test.ts test/apply/apply-script.test.ts test/apply/def-parser.test.ts test/apply/normalize-mysql.test.ts` — Expected: PASS

- [ ] **Step 6: 타입 검사와 커밋**

Run: `npm run typecheck -w @tdm/core` — Expected: 오류 없음

```bash
git add packages/core/src/apply/lists.ts packages/core/src/apply/state.ts packages/core/src/apply/session.ts packages/core/src/apply/index.ts packages/core/src/apply/def-parser.ts packages/core/src/apply/normalize-mysql.ts packages/core/test/apply/lists.test.ts packages/core/test/apply/session.test.ts packages/core/test/apply/apply-script.test.ts packages/core/test/apply/normalize-mysql.test.ts
git commit -m "feat(core): ALTER 적용 — 작업 상태·SET 문(FOREIGN_KEY_CHECKS·SQL_MODE)·applyScript 뼈대"
```

---

### Task 4: 인덱스·FK 규칙 (keys.ts)

**Files:**
- Create: `packages/core/src/apply/keys.ts`
- Test: `packages/core/test/apply/keys.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `baseType`, `BLOB_TYPES`, `effectiveCollation`, `tableCharset`, `TableCharset`, `fail`, `IndexItem`, `FkItem`; Task 3 의 `State`, `findColumn`, `findTable`, `sameName`; lexer 의 `quotedIdentifiers`
- Produces:
  - `KeyDrop = { what: 'index' | 'primary' | 'fk' | 'check' | 'constraint'; name: string }`
  - `leadsWith(index, columns): boolean`
  - `uniqueIndexName(t, base): string`
  - `nextFkName(t): string`
  - `exprUses(expr, column): boolean`
  - `addIndex(t, item): Table`
  - `addForeignKey(st, t, item): Table` — 자동 인덱스는 만들지 않는다
  - `ensureFkIndexes(t, added: { name; indexName?; named }[]): Table`
  - `addKeys(st, t, items: ConstraintItem[]): Table` — 인덱스·FK 를 차례로 붙이고 FK 자동 인덱스까지 (ALTER·CREATE 공용)
  - `dropKeys(t, drops): Table`
  - `remapKeys(t, dropped: Set<소문자>, renamed: Map<소문자, 새 이름>): Table`
  - `renameIndex(t, from, to): Table`
  - `setIndexVisibility(t, name, invisible): Table`
  - `checkTable(st, t, renamed?): void`
  - `sortIndexes(t): Index[]`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/core/test/apply/keys.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addForeignKey, addIndex, addKeys, checkTable, dropKeys, ensureFkIndexes, nextFkName, remapKeys, sortIndexes, uniqueIndexName } from '../../src/apply/keys';
import { initialState, type State } from '../../src/apply/state';
import { DEFAULT_SQL_MODE, MYSQL_DEFAULTS, type FkItem, type IndexItem } from '../../src/apply/types';
import type { IndexKind, Table } from '../../src/model';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

const DUMP = tdExport([
  'CREATE TABLE `parent` (\n  `id` int unsigned NOT NULL,\n  `code` varchar(10) NOT NULL,\n  `note` text,\n  PRIMARY KEY (`id`),\n  KEY `code` (`code`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  'CREATE TABLE `child` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  `pid` int unsigned DEFAULT NULL,\n  `name` varchar(20) DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  KEY `pid` (`pid`),\n  CONSTRAINT `child_ibfk_1` FOREIGN KEY (`pid`) REFERENCES `parent` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
].join('\n\n'));
const fresh = (): State => initialState(parseSqlDump(DUMP).model, 'shop', MYSQL_DEFAULTS, DEFAULT_SQL_MODE);
const table = (st: State, name: string): Table => st.model.tables.find((t) => t.name === name)!;
const idx = (name: string, kind: IndexKind, cols: string[], named = true, length?: number): IndexItem =>
  ({ kind: 'index', named, index: { name, kind, parts: cols.map((column) => ({ column, desc: false, ...(length ? { length } : {}) })), invisible: false } });
const fk = (named: boolean, columns: string[], refTable: string, refColumns: string[], name = ''): FkItem => ({ kind: 'fk', named, fk: { name, columns, refTable, refColumns } });

describe('이름 짓기', () => {
  it('자동 인덱스 이름은 첫 컬럼, 겹치면 _2 …; FK 는 <테이블>_ibfk_<최대+1>', () => {
    const st = fresh();
    expect(uniqueIndexName(table(st, 'parent'), 'code')).toBe('code_2');
    expect(uniqueIndexName(table(st, 'parent'), 'note')).toBe('note');
    expect(nextFkName(table(st, 'child'))).toBe('child_ibfk_2');
  });
});

describe('addIndex', () => {
  it('InnoDB 의 USING HASH 는 지우고 USING BTREE 는 남긴다', () => {
    const st = fresh();
    const hash = idx('h', 'INDEX', ['name']);
    expect(addIndex(table(st, 'child'), { ...hash, index: { ...hash.index, using: 'HASH' } }).indexes.at(-1)!.using).toBeUndefined();
    expect(addIndex(table(st, 'child'), { ...hash, index: { ...hash.index, using: 'BTREE' } }).indexes.at(-1)!.using).toBe('BTREE');
  });

  it('이름 없는 UNIQUE 는 첫 컬럼 이름, PRIMARY KEY 는 컬럼을 NOT NULL 로 만든다', () => {
    const st = fresh();
    expect(addIndex(table(st, 'child'), idx('', 'UNIQUE', ['name'], false)).indexes.at(-1)).toMatchObject({ name: 'name', kind: 'UNIQUE' });
    const p = addIndex(dropKeys(table(st, 'child'), [{ what: 'primary', name: 'PRIMARY' }]), idx('PRIMARY', 'PRIMARY', ['name']));
    const name = p.columns.find((c) => c.name === 'name')!;
    expect(name.nullable).toBe(false);
    expect(name.default).toBeUndefined();
  });

  it.each([
    ['child', idx('PRIMARY', 'PRIMARY', ['name']), /1068/],
    ['child', idx('x', 'INDEX', ['nope']), /1072/],
    ['child', idx('pid', 'INDEX', ['name']), /1061/],
    ['parent', idx('n', 'INDEX', ['note']), /1170/],
    ['parent', idx('n', 'INDEX', ['code'], true, 20), /1089/],
    ['parent', idx('f', 'FULLTEXT', ['id']), /1283/],
  ] as const)('%s %j 는 거부', (name, item, re) => {
    const st = fresh();
    expect(() => addIndex(table(st, name), item)).toThrow(re);
  });
});

describe('addForeignKey / ensureFkIndexes', () => {
  it('이름 없는 FK 는 다음 ibfk 번호, 받치는 인덱스가 없으면 자동 인덱스 (CONSTRAINT 이름 또는 첫 컬럼)', () => {
    const st = fresh();
    const c = table(st, 'child');
    const withCol: Table = { ...c, columns: [...c.columns, { name: 'pid2', type: 'int unsigned', nullable: true, invisible: false, autoIncrement: false, default: 'NULL' }] };
    const unnamed = addForeignKey(st, withCol, fk(false, ['pid2'], 'parent', ['id']));
    expect(unnamed.foreignKeys.at(-1)!.name).toBe('child_ibfk_2');
    expect(ensureFkIndexes(unnamed, [{ name: 'child_ibfk_2', named: false }]).indexes.at(-1)).toMatchObject({ name: 'pid2', parts: [{ column: 'pid2' }] });
    const named = addForeignKey(st, withCol, fk(true, ['pid2'], 'parent', ['id'], 'fk_p2'));
    expect(ensureFkIndexes(named, [{ name: 'fk_p2', named: true }]).indexes.at(-1)!.name).toBe('fk_p2');
    expect(ensureFkIndexes(named, [{ name: 'fk_p2', indexName: 'ix_p2', named: true }]).indexes.at(-1)!.name).toBe('fk_p2'); // CONSTRAINT 이름이 먼저
    expect(ensureFkIndexes(unnamed, [{ name: 'child_ibfk_2', indexName: 'ix_p2', named: false }]).indexes.at(-1)!.name).toBe('ix_p2');
    const reuse = addForeignKey(st, c, fk(true, ['pid'], 'parent', ['id'], 'fk_again'));
    expect(ensureFkIndexes(reuse, [{ name: 'fk_again', named: true }]).indexes).toHaveLength(c.indexes.length); // KEY pid 가 받친다
  });

  it('부모 없음(FOREIGN_KEY_CHECKS=1)·타입 다름·표준 키 아님·이름 겹침은 거부, FOREIGN_KEY_CHECKS=0 이면 부모가 없어도 된다', () => {
    const st = fresh();
    const c = table(st, 'child');
    expect(() => addForeignKey(st, c, fk(false, ['pid'], 'nope', ['id']))).toThrow(/1824/);
    expect(() => addForeignKey(st, c, fk(false, ['id'], 'parent', ['id']))).toThrow(/3780/); // int ↔ int unsigned
    expect(() => addForeignKey(st, c, fk(false, ['name'], 'parent', ['code']))).toThrow(/6125/); // KEY code 는 UNIQUE 가 아니다
    expect(() => addForeignKey(st, c, fk(true, ['pid'], 'parent', ['id'], 'child_ibfk_1'))).toThrow(/1826/);
    st.fkChecks = false;
    expect(addForeignKey(st, c, fk(false, ['pid'], 'nope', ['id'])).foreignKeys).toHaveLength(2);
  });

  it('addKeys: 정의를 차례로 붙이고 붙인 FK 에 받치는 인덱스를 만든다', () => {
    const st = fresh();
    const c = table(st, 'child');
    const t = addKeys(st, c, [idx('ix_name', 'INDEX', ['name'])]);
    expect(t.indexes.map((i) => i.name)).toEqual(['PRIMARY', 'pid', 'ix_name']);
    const withFk = addKeys(st, { ...c, columns: [...c.columns, { name: 'pid2', type: 'int unsigned', nullable: true, invisible: false, autoIncrement: false, default: 'NULL' }] }, [fk(false, ['pid2'], 'parent', ['id'])]);
    expect(withFk.foreignKeys.at(-1)!.name).toBe('child_ibfk_2');
    expect(withFk.indexes.at(-1)!.name).toBe('pid2');
  });
});

describe('삭제·이름 반영·검사·순서', () => {
  it('dropKeys: DROP INDEX `PRIMARY` 도 PK 를 지우고, 없는 키는 1091·3821', () => {
    const st = fresh();
    expect(dropKeys(table(st, 'child'), [{ what: 'index', name: 'primary' }]).indexes.some((i) => i.kind === 'PRIMARY')).toBe(false);
    expect(() => dropKeys(table(st, 'child'), [{ what: 'index', name: 'nope' }])).toThrow(/1091/);
    expect(() => dropKeys(table(st, 'child'), [{ what: 'check', name: 'nope' }])).toThrow(/3821/);
  });

  it('remapKeys: 지운 컬럼은 키 파트에서 빠지고(다 빠지면 인덱스도 없어진다) 바뀐 이름은 따라간다', () => {
    const st = fresh();
    const c = table(st, 'child');
    const t: Table = { ...c, indexes: [...c.indexes, { name: 'pn', kind: 'INDEX', parts: [{ column: 'pid', desc: false }, { column: 'name', desc: false }], invisible: false }, { name: 'only_name', kind: 'INDEX', parts: [{ column: 'name', desc: false }], invisible: false }] };
    const r = remapKeys(t, new Set(['name']), new Map([['pid', 'parent_id']]));
    expect(r.indexes.find((i) => i.name === 'pn')!.parts).toEqual([{ column: 'parent_id', desc: false }]);
    expect(r.indexes.some((i) => i.name === 'only_name')).toBe(false);
    expect(r.foreignKeys[0].columns).toEqual(['parent_id']);
  });

  it('checkTable: FK 를 받치는 인덱스·부모 키를 지우면 1553, 키 없는 AUTO_INCREMENT 는 1075', () => {
    const st = fresh();
    expect(() => checkTable(st, dropKeys(table(st, 'child'), [{ what: 'index', name: 'pid' }]))).toThrow(/1553/);
    expect(() => checkTable(st, dropKeys(table(st, 'parent'), [{ what: 'primary', name: 'PRIMARY' }]))).toThrow(/1553/);
    expect(() => checkTable(st, dropKeys(table(st, 'child'), [{ what: 'primary', name: 'PRIMARY' }]))).toThrow(/1075/);
  });

  it('sortIndexes: UNIQUE(NULL 없음) → UNIQUE(NULL 있음) → 일반 → FULLTEXT, 같은 무리는 원래 순서', () => {
    const st = fresh();
    let t = addIndex(table(st, 'child'), idx('ft', 'FULLTEXT', ['name']));
    t = addIndex(t, idx('u_name', 'UNIQUE', ['name']));
    t = addIndex(t, idx('u_id', 'UNIQUE', ['id']));
    expect(sortIndexes(t).map((i) => i.name)).toEqual(['PRIMARY', 'u_id', 'u_name', 'pid', 'ft']);
  });
});
```

Run: `npx vitest run test/apply/keys.test.ts` — Expected: FAIL (모듈 없음)

- [ ] **Step 2: keys.ts 를 구현한다**

```ts
// 인덱스·FK: 추가·삭제·이름 변경·자동 이름, FK 자동 인덱스, 문장 끝 테이블 검사, MySQL 키 저장 순서
import { quotedIdentifiers } from '../lexer';
import type { Column, ForeignKey, Index, Table } from '../model';
import { baseType, BLOB_TYPES, effectiveCollation, tableCharset, type TableCharset } from './normalize-mysql';
import { findColumn, findTable, sameName, type State } from './state';
import { fail, type ConstraintItem, type FkItem, type IndexItem } from './types';

export interface KeyDrop {
  what: 'index' | 'primary' | 'fk' | 'check' | 'constraint';
  name: string;
}

const LENGTH_TYPES: ReadonlySet<string> = new Set(['char', 'varchar', 'binary', 'varbinary']);
const FULLTEXT_TYPES: ReadonlySet<string> = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext']);

// 인덱스 i 의 앞쪽 키 파트가 columns 와 같은지 (길이 있는 파트·식 파트·FULLTEXT·SPATIAL 은 FK 를 받치지 못한다)
export function leadsWith(i: Index, columns: readonly string[]): boolean {
  if (i.kind === 'FULLTEXT' || i.kind === 'SPATIAL' || i.parts.length < columns.length) return false;
  return columns.every((c, k) => i.parts[k].column !== undefined && i.parts[k].length === undefined && sameName(i.parts[k].column!, c));
}

// MySQL 자동 인덱스 이름: 기준 이름이 이미 있으면 _2, _3 … (대소문자 무시)
export function uniqueIndexName(t: Pick<Table, 'indexes'>, base: string): string {
  const taken = (n: string) => t.indexes.some((i) => sameName(i.name, n));
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}_${n}`)) return `${base}_${n}`;
}

// '<테이블>_ibfk_<N>': N 은 이 테이블의 같은 꼴 FK 번호 중 가장 큰 값 + 1
export function nextFkName(t: Pick<Table, 'name' | 'foreignKeys'>): string {
  const prefix = `${t.name}_ibfk_`;
  const used = t.foreignKeys.filter((f) => f.name.startsWith(prefix)).map((f) => Number(f.name.slice(prefix.length))).filter((n) => Number.isInteger(n));
  return `${prefix}${Math.max(0, ...used) + 1}`;
}

// 식(생성 컬럼·CHECK·함수 인덱스)이 컬럼을 쓰는지. SHOW CREATE 의 식은 컬럼을 늘 백틱으로 쓴다
export const exprUses = (expr: string, column: string): boolean => (quotedIdentifiers(expr) ?? []).some((n) => sameName(n, column));

// PRIMARY KEY 에 들어간 컬럼은 NOT NULL 이 되고 DEFAULT NULL 은 없어진다
function notNull(c: Column): Column {
  if (!c.nullable) return c;
  const next: Column = { ...c, nullable: false };
  if (next.default === 'NULL') delete next.default;
  return next;
}

export function addIndex(t: Table, item: IndexItem): Table {
  const parts = item.index.parts.map((p) => ({ ...p, column: (findColumn(t, p.column!) ?? fail(`키 컬럼 \`${p.column}\` 이 없습니다 (MySQL 1072)`)).name }));
  const index: Index = withoutInnodbHash(t, { ...item.index, parts });
  checkKeyParts(t, index);
  if (index.kind === 'PRIMARY') {
    if (t.indexes.some((i) => i.kind === 'PRIMARY')) fail('PRIMARY KEY 가 이미 있습니다 (MySQL 1068)');
    if (index.invisible) fail('PRIMARY KEY 는 INVISIBLE 로 둘 수 없습니다 (MySQL 3522)');
    const pk = new Set(parts.map((p) => p.column.toLowerCase()));
    return { ...t, columns: t.columns.map((c) => (pk.has(c.name.toLowerCase()) ? notNull(c) : c)), indexes: [...t.indexes, { ...index, name: 'PRIMARY' }] };
  }
  const name = item.named ? index.name : uniqueIndexName(t, parts[0].column);
  if (sameName(name, 'PRIMARY')) fail('인덱스 이름으로 PRIMARY 는 쓸 수 없습니다 (MySQL 1280)');
  if (t.indexes.some((i) => sameName(i.name, name))) fail(`인덱스 이름 \`${name}\` 이 이미 있습니다 (MySQL 1061)`);
  return { ...t, indexes: [...t.indexes, { ...index, name }] };
}

// InnoDB 는 USING HASH 를 BTREE 로 만들고 SHOW CREATE 에서 지운다 (USING BTREE 는 남긴다 — MySQL 8.0 실측)
function withoutInnodbHash(t: Table, index: Index): Index {
  if (index.using !== 'HASH' || t.options.find((o) => o.key === 'ENGINE')?.value !== 'InnoDB') return index;
  const next: Index = { ...index };
  delete next.using;
  return next;
}

function checkKeyParts(t: Table, index: Index): void {
  for (const p of index.parts) {
    const col = findColumn(t, p.column!)!;
    const base = baseType(col.type);
    if (base === 'json') fail(`JSON 컬럼 \`${col.name}\` 에는 인덱스를 직접 만들 수 없습니다 (MySQL 3152)`);
    if (index.kind === 'FULLTEXT') {
      if (!FULLTEXT_TYPES.has(base)) fail(`FULLTEXT 인덱스에는 문자열 컬럼만 쓸 수 있습니다: \`${col.name}\` (MySQL 1283)`);
      continue;
    }
    if (BLOB_TYPES.has(base) && p.length === undefined) fail(`TEXT·BLOB 컬럼 \`${col.name}\` 의 인덱스에는 길이가 필요합니다 (MySQL 1170)`);
    if (p.length === undefined) continue;
    if (!BLOB_TYPES.has(base) && !LENGTH_TYPES.has(base)) fail(`\`${col.name}\` 에는 길이 있는 키 파트를 쓸 수 없습니다 (MySQL 1089)`);
    if (LENGTH_TYPES.has(base) && p.length > Number(/\((\d+)\)/.exec(col.type)?.[1])) fail(`키 파트 길이가 컬럼 \`${col.name}\` 의 길이보다 깁니다 (MySQL 1089)`);
  }
}

// FK 를 붙인다 (받치는 인덱스는 ensureFkIndexes 가 문장 끝에 만든다)
export function addForeignKey(st: State, t: Table, item: FkItem): Table {
  const { refSchema, ...rest } = item.fk;
  if (refSchema !== undefined && refSchema !== st.schemaName) fail(`다른 스키마 \`${refSchema}\` 를 참조하는 FK 는 1차 지원 범위가 아닙니다`);
  const columns = rest.columns.map((n) => (findColumn(t, n) ?? fail(`FK 컬럼 \`${n}\` 이 없습니다 (MySQL 1072)`)).name);
  const parent = rest.refTable === t.name ? t : findTable(st, rest.refTable);
  if (!parent && st.fkChecks) fail(`참조하는 테이블 \`${rest.refTable}\` 이 없습니다 (MySQL 1824)`);
  const refColumns = parent ? parentKey(st, t, columns, rest.refColumns, parent) : rest.refColumns;
  const name = item.named ? rest.name : nextFkName(t);
  if (st.model.tables.some((x) => x.name !== t.name && x.foreignKeys.some((f) => sameName(f.name, name))) || t.foreignKeys.some((f) => sameName(f.name, name))) fail(`FK 이름 \`${name}\` 이 이미 있습니다 (MySQL 1826)`);
  const fk: ForeignKey = { ...rest, name, columns, refColumns };
  return { ...t, foreignKeys: [...t.foreignKeys, fk] };
}

// 부모 쪽 검사: 참조 컬럼이 있고, 타입·콜레이션이 맞고(3780), 참조 컬럼에 정확히 맞는 PRIMARY KEY·UNIQUE 가 있어야 한다 (8.4 6125).
// 돌려주는 값: 부모 컬럼 표기로 쓴 참조 컬럼 이름
function parentKey(st: State, child: Table, columns: readonly string[], refNames: readonly string[], parent: Table): string[] {
  const refs = refNames.map((n) => findColumn(parent, n) ?? fail(`참조 컬럼 \`${parent.name}\`.\`${n}\` 이 없습니다 (MySQL 3734)`));
  if (refs.length !== columns.length) fail('FK 컬럼 수와 참조 컬럼 수가 다릅니다 (MySQL 1239)');
  const childCs = tableCharset(child.options, st.defaults);
  const parentCs = tableCharset(parent.options, st.defaults);
  columns.forEach((n, k) => {
    const a = findColumn(child, n)!;
    if (!fkCompatible(a, childCs, refs[k], parentCs)) fail(`FK 컬럼 \`${a.name}\` 과 참조 컬럼 \`${refs[k].name}\` 의 타입·문자셋이 맞지 않습니다 (MySQL 3780)`);
  });
  const names = refs.map((r) => r.name);
  const standard = parent.indexes.some((i) => (i.kind === 'PRIMARY' || i.kind === 'UNIQUE') && i.parts.length === names.length && leadsWith(i, names));
  if (!standard) fail(`참조 컬럼 (${names.join(', ')}) 에 정확히 맞는 PRIMARY KEY·UNIQUE 인덱스가 없습니다 (MySQL 8.4 6125 — 8.0 은 일반 인덱스도 받지만 1차에서는 8.4 규칙을 따릅니다)`);
  return names;
}

// 정수·DECIMAL 은 크기·부호까지 같아야 하고, 문자열은 길이는 달라도 되지만 문자셋·콜레이션이 같아야 한다
function fkCompatible(a: Column, aCs: TableCharset, b: Column, bCs: TableCharset): boolean {
  const kind = (c: Column) => {
    const base = baseType(c.type);
    return base === 'char' || base === 'varchar' ? 'string' : base === 'binary' || base === 'varbinary' ? 'binary' : c.type;
  };
  return kind(a) === kind(b) && effectiveCollation(a, aCs) === effectiveCollation(b, bCs);
}

// 이 문장에서 붙인 FK 에 받치는 인덱스가 없으면 만든다. 이름: CONSTRAINT 이름 → FOREIGN KEY 뒤에 쓴 인덱스 이름 → 첫 컬럼 (겹치면 _2 …, MySQL 8.0 실측)
export function ensureFkIndexes(t: Table, added: readonly { name: string; indexName?: string; named: boolean }[]): Table {
  let next = t;
  for (const a of added) {
    const fk = next.foreignKeys.find((f) => f.name === a.name)!;
    if (next.indexes.some((i) => leadsWith(i, fk.columns))) continue;
    const name = uniqueIndexName(next, a.named ? fk.name : (a.indexName ?? fk.columns[0]));
    next = { ...next, indexes: [...next.indexes, { name, kind: 'INDEX', parts: fk.columns.map((column) => ({ column, desc: false })), invisible: false }] };
  }
  return next;
}

// 인덱스·FK 정의를 차례로 붙이고, 붙인 FK 에 받치는 인덱스가 없으면 만든다 (ALTER TABLE ADD·CREATE TABLE 공용)
export function addKeys(st: State, t: Table, items: readonly ConstraintItem[]): Table {
  let next = t;
  const added: { name: string; indexName?: string; named: boolean }[] = [];
  for (const item of items) {
    if (item.kind === 'index') next = addIndex(next, item);
    else {
      next = addForeignKey(st, next, item);
      added.push({ name: next.foreignKeys.at(-1)!.name, ...(item.indexName !== undefined ? { indexName: item.indexName } : {}), named: item.named });
    }
  }
  return ensureFkIndexes(next, added);
}

export function dropKeys(t: Table, drops: readonly KeyDrop[]): Table {
  let next = t;
  for (const d of drops) {
    const isPk = d.what === 'primary' || (d.what === 'index' && sameName(d.name, 'PRIMARY'));
    const index = isPk
      ? next.indexes.find((i) => i.kind === 'PRIMARY')
      : d.what === 'index' || d.what === 'constraint' ? next.indexes.find((i) => sameName(i.name, d.name) && (d.what === 'index' || i.kind === 'UNIQUE')) : undefined;
    const fk = d.what === 'fk' || d.what === 'constraint' ? next.foreignKeys.find((f) => sameName(f.name, d.name)) : undefined;
    const check = d.what === 'check' || d.what === 'constraint' ? next.checks.find((k) => sameName(k.name, d.name)) : undefined;
    if (index) next = { ...next, indexes: next.indexes.filter((i) => i !== index) };
    else if (fk) next = { ...next, foreignKeys: next.foreignKeys.filter((f) => f !== fk) };
    else if (check) next = { ...next, checks: next.checks.filter((k) => k !== check) };
    else fail(missingKey(d));
  }
  return next;
}

const missingKey = (d: KeyDrop): string =>
  d.what === 'check' ? `CHECK \`${d.name}\` 이 없습니다 (MySQL 3821)`
    : d.what === 'constraint' ? `제약 \`${d.name}\` 이 없습니다 (MySQL 3940)`
      : `${d.what === 'fk' ? 'FK' : '인덱스'} \`${d.name}\` 이 없습니다 (MySQL 1091)`;

// 컬럼 삭제·이름 변경을 남은 인덱스·자기 FK 에 반영한다 (dropped: 지운 컬럼 이름(소문자), renamed: 문장 전 이름(소문자) → 새 이름)
export function remapKeys(t: Table, dropped: ReadonlySet<string>, renamed: ReadonlyMap<string, string>): Table {
  const rename = (n: string) => renamed.get(n.toLowerCase()) ?? n;
  const indexes = t.indexes.flatMap((i) => {
    const parts = i.parts.filter((p) => p.column === undefined || !dropped.has(p.column.toLowerCase())).map((p) => (p.column === undefined ? p : { ...p, column: rename(p.column) }));
    return parts.length ? [{ ...i, parts }] : [];
  });
  const foreignKeys = t.foreignKeys.map((f) => ({ ...f, columns: f.columns.map(rename), ...(f.refTable === t.name && f.refSchema === undefined ? { refColumns: f.refColumns.map(rename) } : {}) }));
  return { ...t, indexes, foreignKeys };
}

export function renameIndex(t: Table, from: string, to: string): Table {
  const index = t.indexes.find((i) => sameName(i.name, from)) ?? fail(`인덱스 \`${from}\` 이 없습니다 (MySQL 1176)`);
  if (index.kind === 'PRIMARY' || sameName(to, 'PRIMARY')) fail('PRIMARY KEY 의 이름은 바꿀 수 없습니다 (MySQL 1280)');
  if (!sameName(from, to) && t.indexes.some((i) => sameName(i.name, to))) fail(`인덱스 이름 \`${to}\` 이 이미 있습니다 (MySQL 1061)`);
  return { ...t, indexes: t.indexes.map((i) => (i === index ? { ...i, name: to } : i)) };
}

export function setIndexVisibility(t: Table, name: string, invisible: boolean): Table {
  const index = t.indexes.find((i) => sameName(i.name, name)) ?? fail(`인덱스 \`${name}\` 이 없습니다 (MySQL 1176)`);
  if (index.kind === 'PRIMARY' && invisible) fail('PRIMARY KEY 는 INVISIBLE 로 둘 수 없습니다 (MySQL 3522)');
  return { ...t, indexes: t.indexes.map((i) => (i === index ? { ...i, invisible } : i)) };
}

// 문장 끝 검사 (MySQL 이 거부하는 상태): AUTO_INCREMENT 는 하나이고 인덱스 첫 컬럼(1075), 보이는 컬럼 하나 이상(4028),
// 모든 FK 에 받치는 인덱스 — 자기 쪽과 부모 쪽 (1553). renamed: 이 문장에서 바뀐 t 의 컬럼 이름 (다른 테이블 FK 의 참조 이름은 아직 옛 이름)
export function checkTable(st: State, t: Table, renamed: ReadonlyMap<string, string> = new Map()): void {
  const autos = t.columns.filter((c) => c.autoIncrement);
  if (autos.length > 1) fail('AUTO_INCREMENT 컬럼은 하나만 둘 수 있습니다 (MySQL 1075)');
  if (autos.length && !t.indexes.some((i) => i.parts[0]?.column !== undefined && sameName(i.parts[0].column, autos[0].name))) fail(`AUTO_INCREMENT 컬럼 \`${autos[0].name}\` 은 인덱스의 첫 컬럼이어야 합니다 (MySQL 1075)`);
  if (t.columns.every((c) => c.invisible)) fail('보이는 컬럼이 하나 이상 있어야 합니다 (MySQL 4028)');
  for (const fk of t.foreignKeys) if (!t.indexes.some((i) => leadsWith(i, fk.columns))) fail(`FK \`${fk.name}\` 에 필요한 인덱스를 지울 수 없습니다 (MySQL 1553)`);
  for (const child of [...st.model.tables.filter((x) => x.name !== t.name), t]) {
    for (const fk of child.foreignKeys) {
      if (fk.refTable !== t.name || fk.refSchema !== undefined) continue;
      const refs = child === t ? fk.refColumns : fk.refColumns.map((n) => renamed.get(n.toLowerCase()) ?? n);
      if (!t.indexes.some((i) => leadsWith(i, refs))) fail(`\`${child.name}\` 의 FK \`${fk.name}\` 가 쓰는 인덱스를 지울 수 없습니다 (MySQL 1553)`);
    }
  }
}

// MySQL 이 키를 저장하는 순서 (sql_table.cc sort_keys): UNIQUE(PRIMARY 포함) 먼저 — 그 안에서 NULL 허용 컬럼이 없는 것, PRIMARY,
// 길이 있는 파트가 없는 것 순 — 그다음 일반 인덱스, FULLTEXT 는 마지막. 같은 무리 안은 원래 순서
export function sortIndexes(t: Table): Index[] {
  const nullable = (i: Index) => i.parts.some((p) => p.column !== undefined && findColumn(t, p.column)?.nullable === true);
  const rank = (i: Index): number[] =>
    i.kind === 'PRIMARY' || i.kind === 'UNIQUE'
      ? [0, nullable(i) ? 1 : 0, i.kind === 'PRIMARY' ? 0 : 1, i.parts.some((p) => p.length !== undefined) ? 1 : 0]
      : [1, i.kind === 'FULLTEXT' ? 1 : 0, 0, 0];
  const cmp = (a: number[], b: number[]) => a.reduce((r, x, k) => r || x - b[k], 0);
  return t.indexes.map((i, n) => ({ i, n, r: rank(i) })).sort((a, b) => cmp(a.r, b.r) || a.n - b.n).map((x) => x.i);
}
```

Run: `npx vitest run test/apply/keys.test.ts` — Expected: PASS

- [ ] **Step 3: 타입 검사와 커밋**

Run: `npm run typecheck -w @tdm/core` — Expected: 오류 없음

```bash
git add packages/core/src/apply/keys.ts packages/core/test/apply/keys.test.ts
git commit -m "feat(core): ALTER 적용 — 인덱스·FK 추가·삭제·자동 이름·FK 자동 인덱스·키 순서·문장 끝 검사"
```

---

### Task 5: ALTER TABLE 문 (alter-table.ts)

**Files:**
- Create: `packages/core/src/apply/alter-table.ts`, `packages/core/src/apply/table-stmt.ts` (이 Task 에서는 `renameTable` 만)
- Modify: `packages/core/src/apply/options.ts` (`optionValue` 추가), `packages/core/src/apply/index.ts` (문장 분기)
- Test: `packages/core/test/apply/alter-table.test.ts`

**Interfaces:**
- Consumes:
  - Task 1~4 의 함수 전부
  - parse-table 의 파서
  - `auto-name.ts` 의 `renamedAutoName`, `fkAutoNameCollides`
- Produces:
  - `alter-table.ts`: `alterTable(st, c)`, `createIndex(st, c)`, `dropIndexOn(st, c)`
    - `alterTable` 의 `c` 는 `ALTER TABLE` 뒤를 가리킨다
    - `createIndex` 의 `c` 는 `CREATE` 뒤를 가리킨다
    - `dropIndexOn` 의 `c` 는 `DROP INDEX` 뒤를 가리킨다
  - `table-stmt.ts`: `renameTable(st, from, to)`
  - `options.ts`: `optionValue(c)`, `parseCommonOption(c)`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/core/test/apply/alter-table.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyScript } from '../../src/apply';
import type { SchemaModel, Table } from '../../src/model';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

const BASE = parseSqlDump(tdExport([
  "CREATE TABLE `member` (\n  `id` int unsigned NOT NULL AUTO_INCREMENT,\n  `email` varchar(100) NOT NULL,\n  `name` varchar(50) DEFAULT NULL,\n  `age` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `email` (`email`),\n  KEY `name_age` (`name`,`age`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='회원';",
  'CREATE TABLE `orders` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  `member_id` int unsigned NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `member_id` (`member_id`),\n  CONSTRAINT `orders_ibfk_1` FOREIGN KEY (`member_id`) REFERENCES `member` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
].join('\n\n'))).model;
const apply = (script: string) => applyScript(BASE, script, { schemaName: 'shop' });
const ok = (script: string) => {
  const r = apply(script);
  if (!r.ok) throw new Error(`${r.error.index}: ${r.error.reason}`);
  return r;
};
const tbl = (r: { model: SchemaModel }, name: string): Table => r.model.tables.find((t) => t.name === name)!;
const col = (r: { model: SchemaModel }, table: string, name: string) => tbl(r, table).columns.find((c) => c.name === name)!;

describe('ALTER TABLE — 컬럼', () => {
  it('ADD 여러 개·FIRST·AFTER, 새 컬럼은 정규화된다', () => {
    const r = ok("ALTER TABLE member ADD COLUMN nick VARCHAR(20) NOT NULL DEFAULT '' AFTER email, ADD (score INT DEFAULT 0, memo TEXT), ADD seq INT FIRST;");
    expect(tbl(r, 'member').columns.map((c) => c.name)).toEqual(['seq', 'id', 'email', 'nick', 'name', 'age', 'score', 'memo']);
    expect(col(r, 'member', 'score')).toMatchObject({ type: 'int', default: "'0'" });
    expect(col(r, 'member', 'memo').default).toBeUndefined();
  });

  it('MODIFY 는 정의 전체를 바꾸고, 대소문자만 다른 이름은 거부한다', () => {
    const r = ok('ALTER TABLE member MODIFY name VARCHAR(80) NOT NULL;');
    expect(col(r, 'member', 'name')).toEqual({ name: 'name', type: 'varchar(80)', nullable: false, invisible: false, autoIncrement: false });
    expect(apply('ALTER TABLE member MODIFY NAME VARCHAR(80);')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('CHANGE') } });
  });

  it('CHANGE·RENAME COLUMN 은 인덱스를 따라 바꾸고 rename 매핑을 남긴다, 한 문장 맞바꾸기', () => {
    const r = ok('ALTER TABLE member CHANGE name full_name VARCHAR(50) DEFAULT NULL, RENAME COLUMN age TO years;');
    expect(tbl(r, 'member').indexes.find((i) => i.name === 'name_age')!.parts.map((p) => p.column)).toEqual(['full_name', 'years']);
    expect(r.renames).toEqual([{ kind: 'column', table: 'member', from: 'name', to: 'full_name' }, { kind: 'column', table: 'member', from: 'age', to: 'years' }]);
    const swap = ok('ALTER TABLE member RENAME COLUMN name TO age, RENAME COLUMN age TO name;');
    expect(tbl(swap, 'member').columns.map((c) => `${c.name}:${c.type}`)).toEqual(['id:int unsigned', 'email:varchar(100)', 'age:varchar(50)', 'name:int']);
  });

  it('DROP COLUMN 은 인덱스에서 빠지고, FK 컬럼·참조되는 컬럼은 거부한다', () => {
    const r = ok('ALTER TABLE member DROP COLUMN age;');
    expect(tbl(r, 'member').indexes.find((i) => i.name === 'name_age')!.parts.map((p) => p.column)).toEqual(['name']);
    expect(apply('ALTER TABLE orders DROP COLUMN member_id;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1828') } });
    expect(apply('ALTER TABLE member DROP COLUMN id;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1829') } });
  });

  it('ALTER COLUMN SET/DROP DEFAULT·SET INVISIBLE', () => {
    const r = ok('ALTER TABLE member ALTER COLUMN age SET DEFAULT 20, ALTER name DROP DEFAULT, ALTER COLUMN email SET INVISIBLE;');
    expect(col(r, 'member', 'age').default).toBe("'20'");
    expect(col(r, 'member', 'name').default).toBe('NULL');
    expect(col(r, 'member', 'email').invisible).toBe(true);
  });

  it.each([
    ['ALTER TABLE member MODIFY nope INT;', '1054'],
    ['ALTER TABLE member ADD email INT;', '1060'],
    ['ALTER TABLE member DROP COLUMN nope;', '1091'],
    ['ALTER TABLE member MODIFY age INT, ALTER COLUMN age SET DEFAULT 1;', '두 번'],
    ['ALTER TABLE member CONVERT TO CHARACTER SET latin1;', '문자셋'],
    ['ALTER TABLE member ADD PARTITION (PARTITION p1 VALUES LESS THAN (10));', '파티션'],
    ['ALTER TABLE member MODIFY id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT;', 'FK 로 이어진'],
    ['ALTER TABLE nope ADD x INT;', '1146'],
    ['ALTER TABLE other.member ADD x INT;', '다른 스키마'],
    ['ALTER TABLE member ADD COLUMN g INT AS (age + 1);', '생성 컬럼'],
    ['ALTER TABLE member ADD x INT,;', '쉼표'],
    ['ALTER TABLE member ADD (x INT, y INT,);', '쉼표'],
  ])('%s → %s', (script, needle) => {
    expect(apply(script)).toMatchObject({ ok: false, error: { reason: expect.stringContaining(needle) } });
  });
});

describe('ALTER TABLE — 키·옵션·이름', () => {
  it('ADD INDEX 이름 없음·RENAME INDEX·ALTER INDEX, rename 매핑(index)', () => {
    const r = ok('ALTER TABLE member ADD INDEX (age), RENAME INDEX name_age TO ix_name_age, ALTER INDEX email INVISIBLE;');
    const t = tbl(r, 'member');
    expect(t.indexes.map((i) => i.name)).toEqual(['PRIMARY', 'email', 'ix_name_age', 'age']);
    expect(t.indexes.find((i) => i.name === 'email')!.invisible).toBe(true);
    expect(r.renames).toEqual([{ kind: 'index', table: 'member', from: 'name_age', to: 'ix_name_age' }]);
  });

  it('FK 추가는 이름·자동 인덱스를 MySQL 규칙으로, DROP FOREIGN KEY', () => {
    const r = ok('ALTER TABLE orders ADD COLUMN ref_id INT UNSIGNED, ADD FOREIGN KEY (ref_id) REFERENCES member (id) ON DELETE SET NULL;');
    const t = tbl(r, 'orders');
    expect(t.foreignKeys.at(-1)).toEqual({ name: 'orders_ibfk_2', columns: ['ref_id'], refTable: 'member', refColumns: ['id'], onDelete: 'SET NULL' });
    expect(t.indexes.map((i) => i.name)).toEqual(['PRIMARY', 'member_id', 'ref_id']);
    expect(tbl(ok('ALTER TABLE orders DROP FOREIGN KEY orders_ibfk_1;'), 'orders').foreignKeys).toEqual([]);
  });

  it('부모 컬럼 이름을 바꾸면 자식 FK 참조가 따라간다', () => {
    expect(tbl(ok('ALTER TABLE member RENAME COLUMN id TO member_no;'), 'orders').foreignKeys[0].refColumns).toEqual(['member_no']);
  });

  it('FK 를 받치는 인덱스 삭제는 1553, PRIMARY KEY 바꾸기', () => {
    expect(apply('ALTER TABLE orders DROP INDEX member_id;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1553') } });
    const r = ok('ALTER TABLE orders DROP PRIMARY KEY, ADD PRIMARY KEY (id, member_id);');
    expect(tbl(r, 'orders').indexes[0].parts.map((p) => p.column)).toEqual(['id', 'member_id']);
  });

  it('테이블 옵션: COMMENT·ROW_FORMAT, ROW_FORMAT=DEFAULT 는 옵션을 지운다, AUTO_INCREMENT·ALGORITHM 은 무시', () => {
    const r = ok("ALTER TABLE member COMMENT = '회원(v2)' ROW_FORMAT=DYNAMIC, ALGORITHM=INPLACE, AUTO_INCREMENT=100;");
    expect(tbl(r, 'member').options).toEqual([
      { key: 'ENGINE', value: 'InnoDB' }, { key: 'DEFAULT CHARSET', value: 'utf8mb4' }, { key: 'COLLATE', value: 'utf8mb4_0900_ai_ci' },
      { key: 'ROW_FORMAT', value: 'DYNAMIC' }, { key: 'COMMENT', value: "'회원(v2)'" },
    ]);
    expect(tbl(ok('ALTER TABLE member ROW_FORMAT=DYNAMIC; ALTER TABLE member ROW_FORMAT=DEFAULT;'), 'member').options.some((o) => o.key === 'ROW_FORMAT')).toBe(false);
  });

  it('CREATE INDEX … ON (ALGORITHM·LOCK 무시)·DROP INDEX … ON', () => {
    const r = ok('CREATE UNIQUE INDEX uq_name ON member (name) ALGORITHM=INPLACE LOCK=NONE;\nDROP INDEX name_age ON member;');
    expect(tbl(r, 'member').indexes.map((i) => i.name)).toEqual(['PRIMARY', 'email', 'uq_name']);
  });

  it('ALTER TABLE … RENAME TO 는 자식 FK 참조·자동 FK 이름을 바꾼다', () => {
    const r = ok('ALTER TABLE orders RENAME TO purchase; ALTER TABLE member RENAME TO person;');
    expect(tbl(r, 'purchase').foreignKeys[0]).toMatchObject({ name: 'purchase_ibfk_1', refTable: 'person' });
    expect(r.renames).toEqual(expect.arrayContaining([{ kind: 'table', from: 'orders', to: 'purchase' }, { kind: 'table', from: 'member', to: 'person' }]));
  });
});
```

Run: `npx vitest run test/apply/alter-table.test.ts` — Expected: FAIL (`지원하지 않는 문장입니다: ALTER TABLE …`)

- [ ] **Step 2: options.ts 에 optionValue 를 더한다**

`packages/core/src/apply/options.ts` 맨 위 import 에 `import type { Cursor } from '../cursor';` 와 `import { quoteString } from '../lexer';` 를 넣고, 파일 끝에 덧붙인다:

```ts
// 옵션 값: [=] 값 (따옴표 값도 받는다)
export function optionValue(c: Cursor): string {
  c.acceptOp('=');
  return c.next().v;
}

// COMMENT·ROW_FORMAT·KEY_BLOCK_SIZE 옵션 하나 (ALTER TABLE·CREATE TABLE 공용). 이 셋이 아니면 소비하지 않고 undefined.
// value undefined 는 옵션을 지운다 (COMMENT=''·ROW_FORMAT=DEFAULT·KEY_BLOCK_SIZE=0)
export function parseCommonOption(c: Cursor): { key: string; value: string | undefined } | undefined {
  if (c.acceptWord('COMMENT')) {
    c.acceptOp('=');
    const v = c.string();
    return { key: 'COMMENT', value: v === '' ? undefined : quoteString(v) };
  }
  if (c.acceptWord('ROW_FORMAT')) {
    const v = rowFormatName(optionValue(c));
    return { key: 'ROW_FORMAT', value: v === 'DEFAULT' ? undefined : v };
  }
  if (c.acceptWord('KEY_BLOCK_SIZE')) {
    const v = optionValue(c);
    if (!/^\d+$/.test(v)) fail(`KEY_BLOCK_SIZE 는 숫자여야 합니다: ${v}`);
    return { key: 'KEY_BLOCK_SIZE', value: Number(v) === 0 ? undefined : String(Number(v)) };
  }
  return undefined;
}
```

- [ ] **Step 3: table-stmt.ts 에 renameTable 을 만든다**

```ts
// CREATE·DROP·RENAME TABLE
import { fkAutoNameCollides, renamedAutoName } from '../auto-name';
import type { Table } from '../model';
import { moveOrigins, nameTaken, needTable, type State } from './state';
import { fail } from './types';

// 테이블(또는 뷰) 이름 변경: 다른 테이블 FK 의 참조 테이블과 자동 제약명('<옛>_ibfk_N'·'<옛>_chk_N')이 따라 바뀐다 (MySQL 8.0)
export function renameTable(st: State, from: string, to: string): void {
  if (nameTaken(st, to)) fail(`이름 \`${to}\` 인 테이블·뷰가 이미 있습니다 (MySQL 1050)`);
  if (st.model.views.some((v) => v.name === from)) {
    st.model.views = st.model.views.map((v) => (v.name === from ? { ...v, name: to } : v));
    return;
  }
  const t = needTable(st, from);
  if (fkAutoNameCollides(t.foreignKeys, from, to)) fail(`이름을 바꾸면 자동 FK 이름이 다른 FK 와 겹칩니다: \`${from}\` → \`${to}\` (MySQL 1826)`);
  const renamed: Table = {
    ...t,
    name: to,
    foreignKeys: t.foreignKeys.map((f) => ({ ...f, name: renamedAutoName(f.name, from, to, 'ibfk') })),
    checks: t.checks.map((k) => ({ ...k, name: renamedAutoName(k.name, from, to, 'chk') })),
  };
  st.model.tables = st.model.tables
    .map((x) => (x.name === from ? renamed : x))
    .map((x) => ({ ...x, foreignKeys: x.foreignKeys.map((f) => (f.refTable === from && f.refSchema === undefined ? { ...f, refTable: to } : f)) }));
  moveOrigins(st.origins, from, to);
}
```

- [ ] **Step 4: alter-table.ts 를 구현한다**

```ts
// ALTER TABLE 한 문장. 절 순서와 무관하게 MySQL 과 같은 단계로 적용한다 (sql_table.cc mysql_prepare_alter_table):
// 1) 기존 컬럼 삭제 2) 기존 컬럼 변경 — 이름은 문장 전 컬럼 기준 (RENAME COLUMN a TO b, b TO a 맞바꾸기가 된다) 3) 컬럼 추가
// 4) 위치(FIRST·AFTER) 5) 키 삭제 → 남은 키에 컬럼 삭제·이름 변경 반영 → 인덱스 이름 변경·가시성 6) 키 추가, FK 자동 인덱스
// 7) 검사·키 순서 8) 테이블 옵션 9) 다른 테이블 FK 가 참조하는 컬럼 이름 10) 테이블 이름 변경
import { Cursor } from '../cursor';
import type { Token } from '../lexer';
import type { Column, IndexKind, Table } from '../model';
import { parseColumnSpec, parseConstraint, parseDefault, parseIndexBody, parsePosition, parseUsing, startsConstraint } from './def-parser';
import { addKeys, checkTable, dropKeys, exprUses, remapKeys, renameIndex, setIndexVisibility, sortIndexes, type KeyDrop } from './keys';
import { splitList } from './lists';
import { baseType, BLOB_TYPES, effectiveCollation, finalizeColumn, normalizeDefault, tableCharset, type TableCharset } from './normalize-mysql';
import { engineName, optionValue, parseCommonOption, setOption } from './options';
import { findColumn, needTable, objectName, replaceTable, sameName, type State } from './state';
import { renameTable } from './table-stmt';
import { fail, type ColumnSpec, type ConstraintItem, type Position } from './types';

const PARTITION = '파티션 절은 1차 지원 범위가 아닙니다 (MySQL 이 행을 옮깁니다) — td-export 로 다시 뽑아 올려 주세요';
const CHARSET = '테이블 문자셋 변경(CONVERT TO·CHARACTER SET=·COLLATE=)은 1차 지원 범위가 아닙니다 — td-export 로 다시 뽑아 올려 주세요';
const PARTITION_WORDS: ReadonlySet<string> = new Set(['PARTITION', 'REMOVE', 'COALESCE', 'REORGANIZE', 'TRUNCATE', 'EXCHANGE', 'ANALYZE', 'CHECK', 'OPTIMIZE', 'REBUILD', 'REPAIR', 'DISCARD', 'IMPORT']);
const CHARSET_WORDS: ReadonlySet<string> = new Set(['CONVERT', 'DEFAULT', 'CHARACTER', 'CHARSET', 'COLLATE']);

type Clause =
  | { k: 'add'; spec: ColumnSpec; pos: Position }
  | { k: 'modify'; old: string; spec: ColumnSpec; pos: Position; rename: boolean } // MODIFY(rename=false)·CHANGE(true)
  | { k: 'renameColumn'; old: string; to: string }
  | { k: 'alterColumn'; old: string; set: (col: Column) => Column }
  | { k: 'dropColumn'; name: string }
  | { k: 'key'; item: ConstraintItem }
  | ({ k: 'dropKey' } & KeyDrop)
  | { k: 'renameIndex'; old: string; to: string }
  | { k: 'indexVisibility'; name: string; invisible: boolean }
  | { k: 'option'; key: string; value: string | undefined }
  | { k: 'renameTable'; to: string }
  | { k: 'noop' };

interface Entry {
  from?: string; // 문장 전 이름 (새 컬럼은 없음)
  col: Column;
  pos: Position;
}

export function alterTable(st: State, c: Cursor): void {
  const name = objectName(c, st);
  const clauses = splitList(c.toks.slice(c.i), 'ALTER TABLE 절').flatMap((toks) => parseClause(new Cursor(toks, c.src), st));
  if (!clauses.length) fail('ALTER TABLE 에 바꿀 내용이 없습니다');
  alterWith(st, name, clauses);
}

// CREATE [UNIQUE|FULLTEXT|SPATIAL] INDEX name [USING x] ON t (키 파트) [옵션] [ALGORITHM=…] [LOCK=…] = ALTER TABLE t ADD …
export function createIndex(st: State, c: Cursor): void {
  const kind: IndexKind = c.acceptWord('UNIQUE') ? 'UNIQUE' : c.acceptWord('FULLTEXT') ? 'FULLTEXT' : c.acceptWord('SPATIAL') ? 'SPATIAL' : 'INDEX';
  c.expectWord('INDEX');
  const name = c.ident();
  const using = parseUsing(c);
  c.expectWord('ON');
  const table = objectName(c, st);
  const index = parseIndexBody(new Cursor(withoutAlgorithmLock(c.toks.slice(c.i)), c.src), kind, name);
  alterWith(st, table, [{ k: 'key', item: { kind: 'index', index: using && !index.using ? { ...index, using } : index, named: true } }]);
}

// DROP INDEX name ON t [ALGORITHM=…] [LOCK=…] = ALTER TABLE t DROP INDEX name
export function dropIndexOn(st: State, c: Cursor): void {
  const name = c.ident();
  c.expectWord('ON');
  const table = objectName(c, st);
  const rest = withoutAlgorithmLock(c.toks.slice(c.i));
  if (rest.length) fail(`알 수 없는 내용입니다: ${rest[0].v}`);
  alterWith(st, table, [{ k: 'dropKey', what: sameName(name, 'PRIMARY') ? 'primary' : 'index', name }]);
}

function alterWith(st: State, name: string, clauses: readonly Clause[]): void {
  const before = needTable(st, name);
  const { table, renamed } = applyClauses(st, before, clauses);
  replaceTable(st, name, table);
  renameReferencedColumns(st, name, renamed);
  const rename = clauses.filter((x): x is Extract<Clause, { k: 'renameTable' }> => x.k === 'renameTable').at(-1);
  if (rename && rename.to !== name) renameTable(st, name, rename.to);
}

function parseClause(c: Cursor, st: State): Clause[] {
  if (c.acceptWord('ADD')) return parseAdd(c);
  if (c.acceptWord('MODIFY')) {
    c.acceptWord('COLUMN');
    const spec = parseColumnSpec(c);
    return [end(c, { k: 'modify', old: spec.name, spec, pos: parsePosition(c), rename: false })];
  }
  if (c.acceptWord('CHANGE')) {
    c.acceptWord('COLUMN');
    const old = c.ident();
    const spec = parseColumnSpec(c);
    return [end(c, { k: 'modify', old, spec, pos: parsePosition(c), rename: true })];
  }
  if (c.acceptWord('DROP')) return [end(c, parseDrop(c))];
  if (c.acceptWord('RENAME')) return [end(c, parseRename(c, st))];
  if (c.acceptWord('ALTER')) return [end(c, parseAlter(c))];
  return parseOptions(c);
}

// 절 끝: 남은 토큰이 있으면 실패
function end<T>(c: Cursor, clause: T): T {
  if (!c.done) fail(`알 수 없는 내용입니다: ${c.peek()!.v}`);
  return clause;
}

function parseAdd(c: Cursor): Clause[] {
  if (c.isWord('PARTITION')) return fail(PARTITION);
  if (!c.acceptWord('COLUMN') && startsConstraint(c)) return [end(c, { k: 'key', item: parseConstraint(c) })];
  if (c.isOp('(')) {
    const specs = splitList(c.parenTokens(), '컬럼').map((toks) => {
      const one = new Cursor(toks, c.src);
      return end(one, parseColumnSpec(one));
    });
    return end(c, specs.map((spec): Clause => ({ k: 'add', spec, pos: undefined })));
  }
  const spec = parseColumnSpec(c);
  return [end(c, { k: 'add', spec, pos: parsePosition(c) })];
}

function parseDrop(c: Cursor): Clause {
  if (c.acceptWord('PRIMARY', 'KEY')) return { k: 'dropKey', what: 'primary', name: 'PRIMARY' };
  if (c.acceptWord('INDEX') || c.acceptWord('KEY')) return { k: 'dropKey', what: 'index', name: c.ident() };
  if (c.acceptWord('FOREIGN', 'KEY')) return { k: 'dropKey', what: 'fk', name: c.ident() };
  if (c.acceptWord('CHECK')) return { k: 'dropKey', what: 'check', name: c.ident() };
  if (c.acceptWord('CONSTRAINT')) return { k: 'dropKey', what: 'constraint', name: c.ident() };
  if (c.isWord('PARTITION')) return fail(PARTITION);
  c.acceptWord('COLUMN');
  const name = c.ident();
  if (!c.acceptWord('RESTRICT')) c.acceptWord('CASCADE');
  return { k: 'dropColumn', name };
}

function parseRename(c: Cursor, st: State): Clause {
  if (c.acceptWord('COLUMN')) {
    const old = c.ident();
    c.expectWord('TO');
    return { k: 'renameColumn', old, to: c.ident() };
  }
  if (c.acceptWord('INDEX') || c.acceptWord('KEY')) {
    const old = c.ident();
    c.expectWord('TO');
    return { k: 'renameIndex', old, to: c.ident() };
  }
  if (!c.acceptWord('TO')) c.acceptWord('AS');
  return { k: 'renameTable', to: objectName(c, st) };
}

function parseAlter(c: Cursor): Clause {
  if (c.acceptWord('INDEX')) {
    const name = c.ident();
    if (c.acceptWord('INVISIBLE')) return { k: 'indexVisibility', name, invisible: true };
    c.expectWord('VISIBLE');
    return { k: 'indexVisibility', name, invisible: false };
  }
  if (c.isWord('CHECK') || c.isWord('CONSTRAINT')) return fail('ALTER CHECK·CONSTRAINT 는 1차 지원 범위가 아닙니다');
  c.acceptWord('COLUMN');
  const old = c.ident();
  if (c.acceptWord('SET', 'DEFAULT')) {
    if (c.isOp('(')) return fail('식 기본값 SET DEFAULT (…) 은 1차 지원 범위가 아닙니다 — td-export 로 다시 뽑아 올려 주세요');
    const value = parseDefault(c);
    return { k: 'alterColumn', old, set: (col) => withDefault(col, normalizeDefault(value, col)) };
  }
  if (c.acceptWord('DROP', 'DEFAULT')) return { k: 'alterColumn', old, set: dropDefault };
  if (c.acceptWord('SET', 'VISIBLE')) return { k: 'alterColumn', old, set: (col) => ({ ...col, invisible: false }) };
  if (c.acceptWord('SET', 'INVISIBLE')) return { k: 'alterColumn', old, set: (col) => ({ ...col, invisible: true }) };
  return fail(`알 수 없는 ALTER COLUMN 절입니다: ${c.peek()?.v ?? '(끝)'}`);
}

// 기본값을 바꾼다 (undefined 면 DEFAULT 절이 없다 — 키를 남기지 않는다: 모델 해시·왕복 비교가 키 유무를 본다)
function withDefault(col: Column, value: string | undefined): Column {
  const next: Column = { ...col };
  delete next.default;
  return value === undefined ? next : { ...next, default: value };
}

// DROP DEFAULT: 기본값이 없어진다. NULL 허용 컬럼은 SHOW CREATE 에 DEFAULT NULL 로 보인다 (TEXT·BLOB 계열은 DEFAULT 가 보이지 않는다)
const dropDefault = (col: Column): Column =>
  withDefault(col, col.nullable && !col.autoIncrement && !BLOB_TYPES.has(baseType(col.type)) ? 'NULL' : undefined);

// 테이블 옵션 (쉼표 없이 이어 쓸 수 있다). ROW_FORMAT=DEFAULT·KEY_BLOCK_SIZE=0·COMMENT='' 는 옵션을 지운다
function parseOptions(c: Cursor): Clause[] {
  const out: Clause[] = [];
  while (!c.done) {
    const word = c.peek()!.v.toUpperCase();
    const common = parseCommonOption(c);
    if (common) out.push({ k: 'option', ...common });
    else if (c.acceptWord('ENGINE')) out.push({ k: 'option', key: 'ENGINE', value: engineName(optionValue(c)) });
    else if (c.acceptWord('AUTO_INCREMENT') || c.acceptWord('ALGORITHM') || c.acceptWord('LOCK')) {
      optionValue(c);
      out.push({ k: 'noop' });
    } else if (c.acceptWord('FORCE')) out.push({ k: 'noop' });
    else if (CHARSET_WORDS.has(word)) fail(CHARSET);
    else if (PARTITION_WORDS.has(word)) fail(PARTITION);
    else fail(`지원하지 않는 ALTER TABLE 절입니다: ${c.peek()!.v}`);
  }
  return out;
}

function applyClauses(st: State, before: Table, clauses: readonly Clause[]): { table: Table; renamed: Map<string, string> } {
  const charset = tableCharset(before.options, st.defaults);
  const pick = <K extends Clause['k']>(k: K) => clauses.filter((x): x is Extract<Clause, { k: K }> => x.k === k);
  const keyDrops = pick('dropKey');
  // 1) 기존 컬럼 삭제
  const dropped = new Set(pick('dropColumn').map((d) => (findColumn(before, d.name) ?? fail(`컬럼 \`${d.name}\` 이 없습니다 (MySQL 1091)`)).name.toLowerCase()));
  // 2) 기존 컬럼 변경 (이름은 문장 전 기준)
  const entries: Entry[] = before.columns.filter((col) => !dropped.has(col.name.toLowerCase())).map((col) => ({ from: col.name, col, pos: undefined }));
  changeColumns(st, before, entries, clauses, charset);
  // 3) 컬럼 추가 4) 위치
  for (const a of pick('add')) entries.push({ col: finalizeColumn(a.spec, charset), pos: a.pos });
  for (const e of entries.filter((x) => x.pos)) placeEntry(entries, e);
  assertUniqueColumns(entries);
  const renamed = new Map(entries.filter((e) => e.from !== undefined && e.from !== e.col.name).map((e) => [e.from!.toLowerCase(), e.col.name]));
  assertNoDependents(st, before, dropped, renamed, keyDrops);
  updateColumnOrigins(st, before.name, entries);
  // 5) 키 삭제 → 컬럼 변화 반영 → 인덱스 이름 변경·가시성
  let t = remapKeys(dropKeys({ ...before, columns: entries.map((e) => e.col) }, keyDrops), dropped, renamed);
  for (const r of pick('renameIndex')) {
    t = renameIndex(t, r.old, r.to);
    moveIndexOrigin(st, before.name, r.old, r.to);
  }
  for (const v of pick('indexVisibility')) t = setIndexVisibility(t, v.name, v.invisible);
  // 6) 키 추가와 FK 자동 인덱스
  t = addKeys(st, t, pick('key').map((x) => x.item));
  // 7) 검사·키 순서 8) 테이블 옵션
  checkTable(st, t, renamed);
  t = { ...t, indexes: sortIndexes(t) };
  syncIndexOrigins(st, before.name, t);
  for (const o of pick('option')) t = { ...t, options: setOption(t.options, o.key, o.value) };
  return { table: t, renamed };
}

function changeColumns(st: State, before: Table, entries: Entry[], clauses: readonly Clause[], charset: TableCharset): void {
  const touched = new Set<string>();
  for (const ch of clauses) {
    if (ch.k !== 'modify' && ch.k !== 'renameColumn' && ch.k !== 'alterColumn') continue;
    const e = entries.find((x) => x.from !== undefined && sameName(x.from, ch.old)) ?? fail(`컬럼 \`${ch.old}\` 이 없습니다 (MySQL 1054)`);
    if (touched.has(e.from!)) fail(`한 문장에서 컬럼 \`${ch.old}\` 을 두 번 바꿀 수 없습니다`);
    touched.add(e.from!);
    if (ch.k === 'renameColumn') e.col = { ...e.col, name: ch.to };
    else if (ch.k === 'alterColumn') e.col = ch.set(e.col);
    else {
      if (!ch.rename && ch.spec.name !== e.col.name) fail(`MODIFY 에 쓴 이름 \`${ch.spec.name}\` 이 컬럼 \`${e.col.name}\` 과 대소문자가 다릅니다 — 이름을 바꾸려면 CHANGE 를 쓰세요`);
      const next = finalizeColumn(ch.spec, charset);
      assertRetypeAllowed(st, before, e.col, next, charset);
      e.col = next;
      e.pos = ch.pos;
    }
  }
}

function placeEntry(entries: Entry[], e: Entry): void {
  entries.splice(entries.indexOf(e), 1);
  if (e.pos && 'first' in e.pos) {
    entries.unshift(e);
    return;
  }
  const after = (e.pos as { after: string }).after;
  const at = entries.findIndex((x) => sameName(x.col.name, after));
  if (at < 0) fail(`AFTER 에 쓴 컬럼 \`${after}\` 이 없습니다 (MySQL 1054)`);
  entries.splice(at + 1, 0, e);
}

function assertUniqueColumns(entries: readonly Entry[]): void {
  if (!entries.length) fail('테이블의 모든 컬럼을 지울 수 없습니다 — DROP TABLE 을 쓰세요 (MySQL 1090)');
  const seen = new Set<string>();
  for (const { col } of entries) {
    if (seen.has(col.name.toLowerCase())) fail(`컬럼 \`${col.name}\` 이 두 번 있습니다 (MySQL 1060)`);
    seen.add(col.name.toLowerCase());
  }
}

// 지우거나 이름을 바꾸는 컬럼을 쓰는 것: 생성 컬럼(3108)·CHECK(3959)·함수 인덱스(3837)는 MySQL 이 거부하고, 지우는 컬럼을 쓰는
// FK 는 자기 쪽 1828, 다른 테이블(자기 참조 포함) 쪽 1829. 같은 문장에서 함께 지우는 키는 빼고 본다
function assertNoDependents(st: State, t: Table, dropped: ReadonlySet<string>, renamed: ReadonlyMap<string, string>, keyDrops: readonly KeyDrop[]): void {
  const changed = [...dropped, ...renamed.keys()];
  if (!changed.length) return;
  const keyDropped = (what: KeyDrop['what'], name: string) => keyDrops.some((d) => (d.what === what || d.what === 'constraint') && sameName(d.name, name));
  for (const name of changed) {
    const gen = t.columns.find((c) => c.generated && !dropped.has(c.name.toLowerCase()) && exprUses(c.generated.expr, name));
    if (gen) fail(`생성 컬럼 \`${gen.name}\` 이 쓰는 컬럼 \`${name}\` 은 지우거나 이름을 바꿀 수 없습니다 (MySQL 3108)`);
    const check = t.checks.find((k) => !keyDropped('check', k.name) && exprUses(k.expr, name));
    if (check) fail(`CHECK \`${check.name}\` 이 쓰는 컬럼 \`${name}\` 은 지우거나 이름을 바꿀 수 없습니다 (MySQL 3959)`);
    const fn = t.indexes.find((i) => !keyDropped('index', i.name) && i.parts.some((p) => p.expr !== undefined && exprUses(p.expr, name)));
    if (fn) fail(`함수 인덱스 \`${fn.name}\` 이 쓰는 컬럼 \`${name}\` 은 지우거나 이름을 바꿀 수 없습니다 (MySQL 3837)`);
  }
  for (const name of dropped) {
    const own = t.foreignKeys.find((f) => !keyDropped('fk', f.name) && f.columns.some((c) => sameName(c, name)));
    if (own) fail(`FK \`${own.name}\` 가 쓰는 컬럼 \`${name}\` 은 지울 수 없습니다 (MySQL 1828)`);
    for (const child of st.model.tables) {
      const fk = child.foreignKeys.find((f) => f.refTable === t.name && f.refSchema === undefined && !(child.name === t.name && keyDropped('fk', f.name)) && f.refColumns.some((c) => sameName(c, name)));
      if (fk) fail(`\`${child.name}\` 의 FK \`${fk.name}\` 가 참조하는 컬럼 \`${name}\` 은 지울 수 없습니다 (MySQL 1829)`);
    }
  }
}

// FK 로 이어진 컬럼(자기 FK 컬럼·다른 테이블이 참조하는 컬럼)의 타입·콜레이션 변경은 1차 범위 밖 (MySQL 3780 과 허용 사례를 가르지 않는다)
function assertRetypeAllowed(st: State, t: Table, old: Column, next: Column, charset: TableCharset): void {
  if (old.type === next.type && effectiveCollation(old, charset) === effectiveCollation(next, charset)) return;
  const linked = t.foreignKeys.some((f) => f.columns.some((c) => sameName(c, old.name)))
    || st.model.tables.some((x) => x.foreignKeys.some((f) => f.refTable === t.name && f.refSchema === undefined && f.refColumns.some((c) => sameName(c, old.name))));
  if (linked) fail(`FK 로 이어진 컬럼 \`${old.name}\` 의 타입·문자셋 변경은 1차 지원 범위가 아닙니다 — td-export 로 다시 뽑아 올려 주세요`);
}

function updateColumnOrigins(st: State, table: string, entries: readonly Entry[]): void {
  const before = st.origins.columns.get(table) ?? new Map<string, string | undefined>();
  st.origins.columns.set(table, new Map(entries.map((e) => [e.col.name, e.from === undefined ? undefined : before.get(e.from)])));
}

function moveIndexOrigin(st: State, table: string, from: string, to: string): void {
  const m = st.origins.indexes.get(table);
  const key = m && [...m.keys()].find((k) => sameName(k, from));
  if (!m || key === undefined) return;
  const origin = m.get(key);
  m.delete(key);
  m.set(to, origin);
}

// 키 목록에 맞춰 인덱스 이름 추적을 정리한다 (지운 키는 빠지고 새 키는 undefined)
function syncIndexOrigins(st: State, table: string, t: Table): void {
  const m = st.origins.indexes.get(table) ?? new Map<string, string | undefined>();
  st.origins.indexes.set(table, new Map(t.indexes.map((i) => [i.name, m.get(i.name)])));
}

// 다른 테이블 FK 가 참조하는 이 테이블 컬럼 이름도 따라 바뀐다 (MySQL 8.0)
function renameReferencedColumns(st: State, table: string, renamed: ReadonlyMap<string, string>): void {
  if (!renamed.size) return;
  const rename = (n: string) => renamed.get(n.toLowerCase()) ?? n;
  st.model.tables = st.model.tables.map((x) => (x.name === table ? x : {
    ...x,
    foreignKeys: x.foreignKeys.map((f) => (f.refTable === table && f.refSchema === undefined ? { ...f, refColumns: f.refColumns.map(rename) } : f)),
  }));
}

// 끝의 ALGORITHM [=] x · LOCK [=] x 는 스키마에 영향이 없어 뺀다
function withoutAlgorithmLock(toks: readonly Token[]): Token[] {
  const out = [...toks];
  const isKey = (k: number) => out[k]?.t === 'word' && /^(ALGORITHM|LOCK)$/i.test(out[k].v);
  for (;;) {
    const n = out.length;
    if (n >= 3 && isKey(n - 3) && out[n - 2].t === 'op' && out[n - 2].v === '=') out.splice(n - 3, 3);
    else if (n >= 2 && isKey(n - 2)) out.splice(n - 2, 2);
    else return out;
  }
}
```

- [ ] **Step 5: index.ts 의 문장 분기에 ALTER TABLE·CREATE INDEX·DROP INDEX 를 넣는다**

`packages/core/src/apply/index.ts` 에서 import 에 `import { alterTable, createIndex, dropIndexOn } from './alter-table';` 를 더하고, `applyStatement` 의 아래 두 줄을

```ts
  // 문장 종류별 처리 (Task 5~7 에서 이 자리에 추가한다)
  return fail(unsupported(ddl));
```

다음으로 바꾼다:

```ts
  if (c.acceptWord('ALTER', 'TABLE')) alterTable(st, c);
  else if (c.acceptWord('DROP', 'INDEX')) dropIndexOn(st, c);
  else if (c.isWord('CREATE', 'INDEX') || ['UNIQUE', 'FULLTEXT', 'SPATIAL'].some((w) => c.isWord('CREATE', w, 'INDEX'))) {
    c.next();
    createIndex(st, c);
  }
  // Task 6·7: 여기에 else if 를 더한다
  else return fail(unsupported(ddl));
  return true;
```

Run: `npx vitest run test/apply` — Expected: PASS (alter-table.test.ts 포함 전부)

- [ ] **Step 6: 타입 검사와 커밋**

Run: `npm run typecheck -w @tdm/core` — Expected: 오류 없음

```bash
git add packages/core/src/apply/alter-table.ts packages/core/src/apply/table-stmt.ts packages/core/src/apply/options.ts packages/core/src/apply/index.ts packages/core/test/apply/alter-table.test.ts
git commit -m "feat(core): ALTER 적용 — ALTER TABLE 절(컬럼·키·옵션·RENAME TO)과 CREATE·DROP INDEX … ON"
```

---

### Task 6: CREATE·DROP·RENAME TABLE

**Files:**
- Modify: `packages/core/src/apply/table-stmt.ts`, `packages/core/src/apply/index.ts`
- Test: `packages/core/test/apply/table-stmt.test.ts`

**Interfaces:**
- Consumes: Task 1~5
- Produces: `createTable(st, c)` (`c` 는 `CREATE TABLE` 뒤), `dropTable(st, c)` (`DROP TABLE` 뒤), `renameTables(st, c)` (`RENAME TABLE` 뒤)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/core/test/apply/table-stmt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyScript } from '../../src/apply';
import type { SchemaModel, Table } from '../../src/model';
import { parseSqlDump } from '../../src/parse-dump';
import { tdExport } from '../helpers';

const BASE = parseSqlDump(tdExport([
  'CREATE TABLE `member` (\n  `id` int unsigned NOT NULL AUTO_INCREMENT,\n  `email` varchar(100) NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
  'CREATE TABLE `orders` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  `member_id` int unsigned NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `member_id` (`member_id`),\n  CONSTRAINT `orders_ibfk_1` FOREIGN KEY (`member_id`) REFERENCES `member` (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
].join('\n\n'))).model;
const apply = (script: string, defaults?: { charset: string; collation: string }) => applyScript(BASE, script, { schemaName: 'shop', ...(defaults ? { defaults } : {}) });
const ok = (script: string, defaults?: { charset: string; collation: string }) => {
  const r = apply(script, defaults);
  if (!r.ok) throw new Error(`${r.error.index}: ${r.error.reason}`);
  return r;
};
const tbl = (r: { model: SchemaModel }, name: string): Table => r.model.tables.find((t) => t.name === name)!;

describe('CREATE TABLE', () => {
  it('사람이 쓴 정의를 SHOW CREATE 모양으로: 백틱 없는 이름·INT(11)·BOOL·컬럼 안 PRIMARY KEY·UNIQUE·REFERENCES 무시·스키마 기본 문자셋', () => {
    const r = ok("CREATE TABLE tag (\n  tag_id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  label VARCHAR(30) NOT NULL UNIQUE,\n  active BOOL NOT NULL DEFAULT TRUE,\n  member_id INT UNSIGNED REFERENCES member (id),\n  note TEXT\n) COMMENT='태그';", { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' });
    const t = tbl(r, 'tag');
    expect(t.columns.map((c) => `${c.name} ${c.type}`)).toEqual(['tag_id int', 'label varchar(30)', 'active tinyint(1)', 'member_id int unsigned', 'note text']);
    expect(t.columns.find((c) => c.name === 'label')!.collation).toBe('utf8mb4_general_ci');
    expect(t.indexes.map((i) => `${i.kind} ${i.name}`)).toEqual(['PRIMARY PRIMARY', 'UNIQUE label']);
    expect(t.foreignKeys).toEqual([]); // 컬럼 안 REFERENCES 는 MySQL 이 무시한다
    expect(t.options).toEqual([{ key: 'ENGINE', value: 'InnoDB' }, { key: 'DEFAULT CHARSET', value: 'utf8mb4' }, { key: 'COLLATE', value: 'utf8mb4_general_ci' }, { key: 'COMMENT', value: "'태그'" }]);
  });

  it('표 수준 FK·자기 참조 FK 와 자동 인덱스, 문자셋만 쓴 옵션은 그 문자셋 기본 콜레이션', () => {
    const r = ok('CREATE TABLE coupon (id INT UNSIGNED NOT NULL AUTO_INCREMENT, member_id INT UNSIGNED, parent_id INT UNSIGNED, PRIMARY KEY (id), CONSTRAINT fk_cm FOREIGN KEY (member_id) REFERENCES member (id), FOREIGN KEY (parent_id) REFERENCES coupon (id)) ENGINE=InnoDB DEFAULT CHARSET=latin1;');
    const t = tbl(r, 'coupon');
    expect(t.foreignKeys.map((f) => f.name)).toEqual(['fk_cm', 'coupon_ibfk_1']);
    expect(t.indexes.map((i) => i.name)).toEqual(['PRIMARY', 'fk_cm', 'parent_id']);
    expect(t.options.find((o) => o.key === 'COLLATE')!.value).toBe('latin1_swedish_ci');
  });

  it('IF NOT EXISTS 는 있는 테이블을 그대로 두고, 없는 IF NOT EXISTS·LIKE·파티션·중복은 거부', () => {
    expect(tbl(ok('CREATE TABLE IF NOT EXISTS member (x INT);'), 'member').columns.map((c) => c.name)).toEqual(['id', 'email']);
    expect(apply('CREATE TABLE member (x INT);')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1050') } });
    expect(apply('CREATE TABLE copy LIKE member;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('LIKE') } });
    expect(apply('CREATE TABLE p (id INT) PARTITION BY HASH (id) PARTITIONS 2;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('파티션') } });
    expect(apply('CREATE TABLE d (a INT, A INT);')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1060') } });
    expect(apply('CREATE TABLE e (a INT,);')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('쉼표') } });
  });
});

describe('DROP·RENAME TABLE', () => {
  it('FK 가 참조하는 테이블은 FOREIGN_KEY_CHECKS=1 이면 지울 수 없고, 함께 지우거나 0 이면 지운다', () => {
    expect(apply('DROP TABLE member;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('3730') } });
    expect(ok('DROP TABLE orders, member;').model.tables).toEqual([]);
    expect(ok('SET FOREIGN_KEY_CHECKS = 0; DROP TABLE member;').model.tables.map((t) => t.name)).toEqual(['orders']);
    expect(ok('DROP TABLE IF EXISTS nope, orders;').model.tables.map((t) => t.name)).toEqual(['member']);
    expect(apply('DROP TABLE nope;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1051') } });
  });

  it('RENAME TABLE 맞바꾸기: FK 참조·자동 FK 이름이 따라가고 rename 매핑이 남는다', () => {
    const r = ok('RENAME TABLE member TO tmp, orders TO member, tmp TO orders;');
    expect(tbl(r, 'member').foreignKeys[0]).toMatchObject({ name: 'member_ibfk_1', refTable: 'orders' });
    expect(r.renames).toEqual(expect.arrayContaining([{ kind: 'table', from: 'member', to: 'orders' }, { kind: 'table', from: 'orders', to: 'member' }]));
    expect(apply('RENAME TABLE member TO orders;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1050') } });
  });
});
```

Run: `npx vitest run test/apply/table-stmt.test.ts` — Expected: FAIL (`지원하지 않는 문장입니다: CREATE TABLE …`)

- [ ] **Step 2: table-stmt.ts 에 createTable·dropTable·renameTables 를 더한다**

파일 맨 위 import 를 아래로 바꾼다:

```ts
import { fkAutoNameCollides, renamedAutoName } from '../auto-name';
import { Cursor } from '../cursor';
import type { Table, TableOption } from '../model';
import { parseTableItem } from './def-parser';
import { addKeys, checkTable, sortIndexes } from './keys';
import { splitList } from './lists';
import { canonicalCharset, canonicalCollation, charsetOfCollation, finalizeColumn, primaryCollation, tableCharset } from './normalize-mysql';
import { engineName, optionValue, parseCommonOption, setOption } from './options';
import { findTable, forgetOrigins, moveOrigins, nameTaken, needTable, objectName, objectNameList, trackNew, type State } from './state';
import { fail, type ColumnSpec, type ConstraintItem, type IndexItem } from './types';
```

그리고 `renameTable` 아래에 덧붙인다:

```ts
// CREATE TABLE [IF NOT EXISTS] name (정의…) [옵션…]. LIKE·SELECT·파티션은 1차 범위 밖
export function createTable(st: State, c: Cursor): void {
  const ifNotExists = c.acceptWord('IF', 'NOT', 'EXISTS');
  const name = objectName(c, st);
  if (!c.isOp('(')) fail('CREATE TABLE … LIKE·SELECT 는 1차 지원 범위가 아닙니다 — td-export 로 다시 뽑아 올려 주세요');
  if (nameTaken(st, name)) {
    if (ifNotExists) return; // MySQL 은 경고만 남기고 아무것도 하지 않는다
    fail(`테이블 \`${name}\` 이 이미 있습니다 (MySQL 1050)`);
  }
  const items = splitList(c.parenTokens(), '테이블 정의').map((toks) => parseTableItem(new Cursor(toks, c.src)));
  const options = createOptions(c, st);
  const charset = tableCharset(options, st.defaults);
  const specs = items.flatMap((i) => (i.kind === 'column' ? [i.spec] : []));
  if (!specs.length) fail('테이블에는 컬럼이 하나 이상 있어야 합니다 (MySQL 4028)');
  const seen = new Set<string>();
  for (const s of specs) {
    if (seen.has(s.name.toLowerCase())) fail(`컬럼 \`${s.name}\` 이 두 번 있습니다 (MySQL 1060)`);
    seen.add(s.name.toLowerCase());
  }
  let t: Table = { kind: 'table', name, columns: specs.map((s) => finalizeColumn(s, charset)), indexes: [], foreignKeys: [], checks: [], options, fidelity: 'full' };
  t = addKeys(st, t, [...inlineKeys(specs), ...items.filter((i): i is ConstraintItem => i.kind !== 'column')]);
  checkTable(st, t);
  t = { ...t, indexes: sortIndexes(t) };
  st.model.tables = [...st.model.tables, t];
  trackNew(st.origins, t, false);
}

// 컬럼 안 PRIMARY KEY·UNIQUE → 인덱스 (문장에서 표 수준 정의보다 먼저 나온다)
function inlineKeys(specs: readonly ColumnSpec[]): IndexItem[] {
  const key = (s: ColumnSpec, kind: 'PRIMARY' | 'UNIQUE'): IndexItem => ({
    kind: 'index', named: kind === 'PRIMARY', index: { name: kind === 'PRIMARY' ? 'PRIMARY' : '', kind, parts: [{ column: s.name, desc: false }], invisible: false },
  });
  return specs.flatMap((s) => [...(s.primaryKey ? [key(s, 'PRIMARY')] : []), ...(s.unique ? [key(s, 'UNIQUE')] : [])]);
}

// CREATE TABLE 의 테이블 옵션 → SHOW CREATE 모양 (ENGINE·DEFAULT CHARSET·COLLATE 는 늘 있다)
function createOptions(c: Cursor, st: State): TableOption[] {
  let engine = 'InnoDB';
  let charset: string | undefined;
  let collation: string | undefined;
  let rest: TableOption[] = [];
  while (!c.done) {
    c.acceptWord('DEFAULT');
    const common = parseCommonOption(c);
    if (common) rest = setOption(rest, common.key, common.value);
    else if (c.acceptWord('ENGINE')) engine = engineName(optionValue(c));
    else if (c.acceptWord('CHARACTER', 'SET') || c.acceptWord('CHARSET')) charset = canonicalCharset(optionValue(c));
    else if (c.acceptWord('COLLATE')) collation = canonicalCollation(optionValue(c));
    else if (c.acceptWord('AUTO_INCREMENT')) optionValue(c);
    else if (c.isWord('PARTITION')) fail('파티션 절은 1차 지원 범위가 아닙니다 — td-export 로 다시 뽑아 올려 주세요');
    else fail(`지원하지 않는 테이블 옵션입니다: ${c.peek()?.v ?? '(끝)'}`);
    c.acceptOp(',');
  }
  const coll = collation ?? (charset ? primaryCollation(charset) : st.defaults.collation);
  const cs = charsetOfCollation(coll);
  if (charset && charset !== cs) fail(`COLLATE ${coll} 은 문자셋 ${charset} 의 콜레이션이 아닙니다 (MySQL 1253)`);
  return [{ key: 'ENGINE', value: engine }, { key: 'DEFAULT CHARSET', value: cs }, { key: 'COLLATE', value: coll }, ...rest];
}

// DROP TABLE [IF EXISTS] a [, b …] [RESTRICT|CASCADE]. 하나라도 없으면(IF EXISTS 제외) 아무것도 지우지 않는다
export function dropTable(st: State, c: Cursor): void {
  const ifExists = c.acceptWord('IF', 'EXISTS');
  const names = objectNameList(c, st);
  const targets = names.filter((n) => findTable(st, n) !== undefined || (ifExists ? false : fail(`테이블 \`${n}\` 이 없습니다 (MySQL 1051)`)));
  if (st.fkChecks) {
    for (const child of st.model.tables) {
      if (targets.includes(child.name)) continue;
      const fk = child.foreignKeys.find((f) => f.refSchema === undefined && targets.includes(f.refTable));
      if (fk) fail(`\`${child.name}\` 의 FK \`${fk.name}\` 가 참조하는 테이블 \`${fk.refTable}\` 은 지울 수 없습니다 (MySQL 3730)`);
    }
  }
  st.model.tables = st.model.tables.filter((t) => !targets.includes(t.name));
  for (const n of targets) forgetOrigins(st.origins, n);
}

// RENAME TABLE a TO b [, c TO d …] — 앞에서부터 차례로 (맞바꾸기는 임시 이름을 거친다)
export function renameTables(st: State, c: Cursor): void {
  for (const toks of splitList(c.toks.slice(c.i), 'RENAME TABLE')) {
    const one = new Cursor(toks, c.src);
    const from = objectName(one, st);
    one.expectWord('TO');
    const to = objectName(one, st);
    if (!one.done) fail(`알 수 없는 내용입니다: ${one.peek()!.v}`);
    renameTable(st, from, to);
  }
}
```

- [ ] **Step 3: index.ts 분기에 세 문장을 더한다**

`import { createTable, dropTable, renameTables } from './table-stmt';` 를 더하고, `// Task 6·7: 여기에 else if 를 더한다` 줄 바로 위에 넣는다:

```ts
  else if (c.acceptWord('CREATE', 'TABLE')) createTable(st, c);
  else if (c.acceptWord('DROP', 'TABLE')) dropTable(st, c);
  else if (c.acceptWord('RENAME', 'TABLE')) renameTables(st, c);
```

Run: `npx vitest run test/apply` — Expected: PASS

- [ ] **Step 4: 타입 검사와 커밋**

Run: `npm run typecheck -w @tdm/core` — Expected: 오류 없음

```bash
git add packages/core/src/apply/table-stmt.ts packages/core/src/apply/index.ts packages/core/test/apply/table-stmt.test.ts
git commit -m "feat(core): ALTER 적용 — CREATE TABLE(사람이 쓴 정의)·DROP TABLE·RENAME TABLE"
```

---

### Task 7: 루틴과 DROP VIEW

**Files:**
- Create: `packages/core/src/apply/object-stmt.ts`
- Modify: `packages/core/src/apply/index.ts`
- Test: `packages/core/test/apply/object-stmt.test.ts`

**Interfaces:**
- Consumes: parse-routine 의 `parseRoutine`, diff 의 `routineNameKey`, Task 1 의 `routineReturns`, Task 3 의 `objectName`
- Produces:
  - `isCreateRoutine(ddl): boolean`
  - `createRoutine(st, ddl, noBackslashEscapes)`
  - `dropRoutine(st, c)` — `c` 는 `DROP` 뒤
  - `dropView(st, c)` — `c` 는 `DROP VIEW` 뒤

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/core/test/apply/object-stmt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyScript } from '../../src/apply';
import { DEFAULT_SQL_MODE } from '../../src/apply/types';
import { parseSqlDump } from '../../src/parse-dump';
import { fixture } from '../helpers';

const SHOP = parseSqlDump(fixture('td-export-0152/shop.sql')).model; // 함수 tax, 프로시저 mark_paid, 뷰 paid_orders·big_paid
const apply = (script: string) => applyScript(SHOP, script, { schemaName: 'shop' });
const ok = (script: string) => {
  const r = apply(script);
  if (!r.ok) throw new Error(`${r.error.index}: ${r.error.reason}`);
  return r;
};

describe('루틴·뷰', () => {
  it('CREATE FUNCTION 은 RETURNS 를 정규화하고(문자열은 CHARSET) 그때 세션 SQL_MODE 를 붙인다', () => {
    const r = ok("SET SESSION sql_mode = 'STRICT_TRANS_TABLES';\nCREATE FUNCTION fn_double(x INT) RETURNS INT DETERMINISTIC RETURN x * 2;\nSET sql_mode = DEFAULT;\nDELIMITER ;;\nCREATE FUNCTION fn_label(p VARCHAR(10)) RETURNS VARCHAR(20) DETERMINISTIC\nBEGIN\n  RETURN CONCAT('[', p, ']');\nEND;;\nDELIMITER ;");
    const fn = (name: string) => r.model.routines.find((x) => x.name === name)!;
    expect(fn('fn_double')).toMatchObject({ kind: 'function', params: 'x INT', returns: 'int', sqlMode: 'STRICT_TRANS_TABLES', characteristics: { deterministic: true }, body: 'RETURN x * 2' });
    expect(fn('fn_label')).toMatchObject({ returns: 'varchar(20) CHARSET utf8mb4', sqlMode: DEFAULT_SQL_MODE });
  });

  it('같은 이름(대소문자 무시)은 1304, IF NOT EXISTS 는 그대로 둔다; DROP … IF EXISTS', () => {
    expect(apply('CREATE FUNCTION TAX(a INT) RETURNS INT DETERMINISTIC RETURN a;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1304') } });
    expect(ok('CREATE FUNCTION IF NOT EXISTS tax(a INT) RETURNS INT DETERMINISTIC RETURN a;').model.routines).toHaveLength(2);
    const r = ok('DROP FUNCTION tax; DROP PROCEDURE IF EXISTS nope; DROP VIEW IF EXISTS big_paid, nope;');
    expect(r.model.routines.map((x) => x.name)).toEqual(['mark_paid']);
    expect(r.model.views.map((v) => v.name)).toEqual(['paid_orders']);
    expect(apply('DROP PROCEDURE nope;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1305') } });
    expect(apply('DROP VIEW big_paid, nope;')).toMatchObject({ ok: false, error: { reason: expect.stringContaining('1051') } });
  });
});
```

Run: `npx vitest run test/apply/object-stmt.test.ts` — Expected: FAIL

- [ ] **Step 2: object-stmt.ts 를 구현한다**

```ts
// CREATE·DROP FUNCTION·PROCEDURE, DROP VIEW. 루틴 본문은 쓴 그대로 저장한다 (MySQL SHOW CREATE 도 그렇다)
import type { Cursor } from '../cursor';
import { routineNameKey } from '../diff';
import type { RoutineKind } from '../model';
import { parseRoutine } from '../parse-routine';
import { routineReturns } from './normalize-mysql';
import { objectName, objectNameList, type State } from './state';
import { fail } from './types';

const CREATE_ROUTINE_RE = /^CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?(?:FUNCTION|PROCEDURE)\b/i;
const IF_NOT_EXISTS_RE = /^(CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?(?:FUNCTION|PROCEDURE)\s+)IF\s+NOT\s+EXISTS\s+/i;
const label = (kind: RoutineKind) => (kind === 'function' ? 'FUNCTION' : 'PROCEDURE');

export const isCreateRoutine = (ddl: string): boolean => CREATE_ROUTINE_RE.test(ddl);

// 루틴은 만들 때의 세션 SQL_MODE 를 기억한다. 이름은 대소문자를 구분하지 않는다
export function createRoutine(st: State, ddl: string, noBackslashEscapes: boolean): void {
  const ifNotExists = IF_NOT_EXISTS_RE.test(ddl);
  const r = parseRoutine(ifNotExists ? ddl.replace(IF_NOT_EXISTS_RE, '$1') : ddl, { noBackslashEscapes });
  if (st.model.routines.some((x) => x.kind === r.kind && routineNameKey(x.name) === routineNameKey(r.name))) {
    if (ifNotExists) return;
    fail(`${label(r.kind)} \`${r.name}\` 이 이미 있습니다 (MySQL 1304)`);
  }
  const returns = r.returns === undefined ? {} : { returns: routineReturns(r.returns, st.defaults.charset) };
  st.model.routines = [...st.model.routines, { ...r, ...returns, sqlMode: st.sqlMode }];
}

// DROP {FUNCTION|PROCEDURE} [IF EXISTS] name
export function dropRoutine(st: State, c: Cursor): void {
  let kind: RoutineKind = 'function';
  if (!c.acceptWord('FUNCTION')) {
    c.expectWord('PROCEDURE');
    kind = 'procedure';
  }
  const ifExists = c.acceptWord('IF', 'EXISTS');
  const name = objectName(c, st);
  if (!c.done) fail(`알 수 없는 내용입니다: ${c.peek()!.v}`);
  const left = st.model.routines.filter((r) => !(r.kind === kind && routineNameKey(r.name) === routineNameKey(name)));
  if (left.length === st.model.routines.length && !ifExists) fail(`${label(kind)} \`${name}\` 이 없습니다 (MySQL 1305)`);
  st.model.routines = left;
}

// DROP VIEW [IF EXISTS] v [, w …] [RESTRICT|CASCADE]. 하나라도 없으면(IF EXISTS 제외) 아무것도 지우지 않는다
export function dropView(st: State, c: Cursor): void {
  const ifExists = c.acceptWord('IF', 'EXISTS');
  const names = objectNameList(c, st);
  const missing = names.filter((n) => !st.model.views.some((v) => v.name === n));
  if (missing.length && !ifExists) fail(`뷰 \`${missing.join('`, `')}\` 이 없습니다 (MySQL 1051)`);
  st.model.views = st.model.views.filter((v) => !names.includes(v.name));
}
```

- [ ] **Step 3: index.ts 분기에 더한다**

`import { createRoutine, dropRoutine, dropView, isCreateRoutine } from './object-stmt';` 를 더하고, `// Task 6·7: 여기에 else if 를 더한다` 줄 바로 위에 넣는다:

```ts
  else if (c.acceptWord('DROP', 'VIEW')) dropView(st, c);
  else if (c.isWord('DROP', 'FUNCTION') || c.isWord('DROP', 'PROCEDURE')) {
    c.next();
    dropRoutine(st, c);
  } else if (isCreateRoutine(ddl)) createRoutine(st, ddl, noBackslashEscapes);
```

그리고 그 안내 주석 줄(`// Task 6·7: …`)은 지운다.

Run: `npx vitest run test/apply` — Expected: PASS

- [ ] **Step 4: 타입 검사와 커밋**

Run: `npm run typecheck -w @tdm/core` — Expected: 오류 없음

```bash
git add packages/core/src/apply/object-stmt.ts packages/core/src/apply/index.ts packages/core/test/apply/object-stmt.test.ts
git commit -m "feat(core): ALTER 적용 — CREATE·DROP FUNCTION·PROCEDURE, DROP VIEW"
```

---

### Task 8: printSqlDump 와 core 공개

**Files:**
- Create: `packages/core/src/apply/print-dump.ts`
- Modify: `packages/core/src/apply/index.ts` (`printSqlDump` re-export), `packages/core/src/index.ts` (`export * from './apply';`)
- Test: `packages/core/test/apply/print-dump.test.ts`

**Interfaces:**
- Consumes: print.ts 의 `printTable`·`printView`·`printRoutine`
- Produces:
  - `printSqlDump(model: SchemaModel): string` — `@tdm/core` 에서 `applyScript`·`printSqlDump`·`MYSQL_DEFAULTS`·`ApplyDefaults`·`ApplyError`·`ApplyOptions`·`ApplyResult` 를 import 할 수 있다

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/core/test/apply/print-dump.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyScript, printSqlDump } from '../../src';
import { canonicalJson } from '../../src/canonical';
import type { SchemaModel } from '../../src/model';
import { parseSqlDump } from '../../src/parse-dump';
import { fixture } from '../helpers';

const same = (a: SchemaModel, b: SchemaModel) => canonicalJson([a.tables, a.views, a.routines]) === canonicalJson([b.tables, b.views, b.routines]);

describe('printSqlDump', () => {
  it('td-export 0.1.52 형식: 완전한 덤프로 읽히고, 경고 없이 같은 모델로 돌아온다 (루틴·뷰 포함)', () => {
    const shop = parseSqlDump(fixture('td-export-0152/shop.sql')).model;
    const r = applyScript(shop, "CREATE TABLE extra (id INT PRIMARY KEY, label VARCHAR(10) COMMENT 'it''s');\nDELIMITER $$\nCREATE PROCEDURE p_x() BEGIN SELECT ';;'; END$$\nDELIMITER ;", { schemaName: 'shop' });
    if (!r.ok) throw new Error(r.error.reason);
    const text = printSqlDump(r.model);
    expect(text.startsWith('/* Database : shop */\nSET NAMES utf8mb4;')).toBe(true);
    const again = parseSqlDump(text);
    expect(again.warnings).toEqual([]);
    expect(again.model.evidence?.level).toBe('complete');
    expect(same(again.model, r.model)).toBe(true);
  });

  it("스키마 이름에 '*/'·줄바꿈이 있으면 머리말을 쓸 수 없어 실패한다", () => {
    expect(() => printSqlDump({ name: 'a*/b', tables: [], views: [], routines: [] })).toThrow();
  });
});
```

Run: `npx vitest run test/apply/print-dump.test.ts` — Expected: FAIL (`printSqlDump` 없음)

- [ ] **Step 2: print-dump.ts 를 구현한다**

```ts
// 모델 → td-export 0.1.52 형식 SQL. 서버가 ALTER 적용 결과를 원문으로 저장한다 — parseSqlDump 로 다시 읽으면 같은 모델이 나와야 한다
import type { Routine, SchemaModel } from '../model';
import { printRoutine, printTable, printView } from '../print';
import { fail } from './types';

const HEADER = ['SET NAMES utf8mb4;', 'SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;', "SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';"];
const TRAILER = ['SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;', 'SET SQL_MODE = @OLD_SQL_MODE;'];
const DELIMITERS = [';;', '$$', '//'];
const UNSAFE_COMMENT = /\*\/|[\r\n]/;
// 객체 순서는 td-export 처럼 이름순 (코드 유닛 비교 — 로케일과 무관)
const byName = <T extends { name: string }>(xs: readonly T[]): T[] => [...xs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
// 객체 머리 주석. 이름에 주석을 닫는 문자가 있으면 주석을 쓰지 않는다 (파서는 주석을 보지 않는다)
const heading = (name: string): string[] => (UNSAFE_COMMENT.test(name) ? [] : [`/* Table : ${name} */`]);

export function printSqlDump(model: SchemaModel): string {
  if (UNSAFE_COMMENT.test(model.name)) fail(`스키마 이름에 '*/'·줄바꿈이 있어 덤프 머리말을 쓸 수 없습니다: ${model.name}`);
  const out = [`/* Database : ${model.name} */`, ...HEADER, ''];
  if (model.routines.length) out.push('/* Routines */', ...byName(model.routines).flatMap(routineBlock));
  for (const t of byName(model.tables)) out.push('', ...heading(t.name), `${printTable(t)};`, '');
  for (const v of byName(model.views)) out.push('', ...heading(v.name), `${printView(v)};`, '');
  return [...out, '', ...TRAILER, ''].join('\n');
}

// td-export 0.1.52 의 루틴 블록: SQL_MODE 저장·설정 → DELIMITER → CREATE → 복원
function routineBlock(r: Routine): string[] {
  const ddl = printRoutine(r);
  const delimiter = DELIMITERS.find((d) => !ddl.includes(d)) ?? fail(`루틴 \`${r.name}\` 본문에 구분자로 쓸 수 있는 문자열이 없습니다`);
  const mode = r.sqlMode === undefined ? [] : [`SET @OLD_ROUTINE_SQL_MODE = @@SQL_MODE, SQL_MODE = '${r.sqlMode}';`];
  return [...mode, `DELIMITER ${delimiter}`, `${ddl}${delimiter}`, 'DELIMITER ;', ...(mode.length ? ['SET SQL_MODE = @OLD_ROUTINE_SQL_MODE;'] : [])];
}
```

- [ ] **Step 3: 공개 export 를 더한다**

`packages/core/src/apply/index.ts` 의 re-export 줄 아래에 `export { printSqlDump } from './print-dump';` 를 더하고, `packages/core/src/index.ts` 끝에 `export * from './apply';` 를 더한다.

Run: `npx vitest run test/apply` — Expected: PASS. 루틴 왕복이 다르면(예: `body` 공백) `printRoutine` 이 아니라 테스트 입력을 바꾸지 말고, 차이를 출력해 원인을 찾는다 (`normalizeBody` 규칙과 같아야 한다).

- [ ] **Step 4: core 전체 테스트·타입 검사와 커밋**

Run: `npm test -w @tdm/core && npm run typecheck -w @tdm/core` — Expected: 전부 PASS, 기존 골든 출력 변화 없음

```bash
git add packages/core/src/apply/print-dump.ts packages/core/src/apply/index.ts packages/core/src/index.ts packages/core/test/apply/print-dump.test.ts
git commit -m "feat(core): ALTER 적용 — 결과 모델을 td-export 0.1.52 형식으로 출력(printSqlDump)하고 공개"
```

---

### Task 9: 실제 MySQL 과 비교하는 ALTER 시나리오

**Files:**
- Create: `packages/core/test/mysql-dump.ts`
  - 기존 `mysql.int.test.ts` 의 `portOf`·`TARGETS`·`dumpSchema`·`dumpRoutines` 를 옮긴다
- Modify:
  - `packages/core/test/mysql.int.test.ts`: 옮긴 함수를 import 한다
  - `packages/core/package.json`: `test:mysql` 스크립트에 `test/apply.int.test.ts` 를 더한다
- Create: `packages/core/test/apply.int.test.ts`
- Create: `packages/core/test/fixtures/alter-scenarios/_base.sql`
- Create: 시나리오 폴더 23개 — `packages/core/test/fixtures/alter-scenarios/<이름>/script.sql`, 실패 시나리오에는 `expect-error.txt` 를 함께 둔다
- 실측과 다르면 Modify: `packages/core/src/apply/*.ts`
  - 고칠 때마다 `packages/core/test/apply/*.test.ts` 에 그 규칙의 단위 테스트를 더한다

**Interfaces:**
- Consumes: `applyScript`, `printSqlDump`, `parseSqlDump`, `splitStatements`, `diffSchemas`, `generateDdl`, `canonicalJson`
- Produces:
  - `mysql-dump.ts`: `MYSQL_TARGETS: { name: string; port: number }[]`, `dumpSchema(conn, db): Promise<SchemaModel>`
  - 시나리오 형식:
    - `script.sql` 이 필수다. 기준 덤프는 `base.sql` 이 있으면 그 파일, 없으면 `_base.sql` 이다
    - 덤프 안의 `__DB__` 는 시나리오 DB 이름(`ap_<이름>`)으로 바뀐다
    - `expect-error.txt` 는 MySQL 오류 번호다
    - `only.txt` 는 `MySQL 8.4` 처럼 그 버전에서만 돌릴 때 둔다

- [ ] **Step 1: mysql-dump.ts 로 공용 도우미를 옮긴다**

`packages/core/test/mysql-dump.ts`:

```ts
// MySQL 실증 테스트 공용: 대상 서버(8.0·8.4)와 SHOW CREATE 로 스키마 모델 읽기
import type { Connection, RowDataPacket } from 'mysql2/promise';
import type { Routine, SchemaModel, Table, View } from '../src/model';
import { routineLexMode } from '../src/normalize';
import { parseRoutine } from '../src/parse-routine';
import { parseCreateTable } from '../src/parse-table';
import { parseCreateView } from '../src/parse-view';

// 포트는 MYSQL80_PORT / MYSQL84_PORT 로 바꿀 수 있다 (기본 33080 / 33084 — docker-compose.test.yml)
function portOf(env: string | undefined, fallback: number): number {
  if (env === undefined || env === '') return fallback;
  const port = Number(env);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`잘못된 MySQL 포트: ${env}`);
  return port;
}

export const MYSQL_TARGETS = [
  { name: 'MySQL 8.0', port: portOf(process.env.MYSQL80_PORT, 33080) },
  { name: 'MySQL 8.4', port: portOf(process.env.MYSQL84_PORT, 33084) },
];

// 지금 DB(USE)의 테이블·뷰·루틴을 SHOW CREATE 로 읽는다
export async function dumpSchema(conn: Connection, db: string): Promise<SchemaModel> {
  const [rows] = await conn.query<RowDataPacket[]>('SHOW FULL TABLES');
  const tables: Table[] = [];
  const views: View[] = [];
  for (const row of rows) {
    const name = String(Object.values(row)[0]);
    const [created] = await conn.query<RowDataPacket[]>(`SHOW CREATE TABLE \`${name}\``);
    if (row.Table_type === 'VIEW') views.push(parseCreateView(String(created[0]['Create View'])));
    else tables.push(parseCreateTable(String(created[0]['Create Table'])));
  }
  return { name: db, tables, views, routines: await dumpRoutines(conn, db) };
}

// SHOW CREATE FUNCTION/PROCEDURE 와 그 sql_mode 로 루틴을 읽는다
async function dumpRoutines(conn: Connection, db: string): Promise<Routine[]> {
  const out: Routine[] = [];
  for (const kind of ['FUNCTION', 'PROCEDURE'] as const) {
    const [rows] = await conn.query<RowDataPacket[]>(`SHOW ${kind} STATUS WHERE Db = ?`, [db]);
    for (const row of rows) {
      const [created] = await conn.query<RowDataPacket[]>(`SHOW CREATE ${kind} \`${String(row.Name)}\``);
      const ddl = String(created[0][kind === 'FUNCTION' ? 'Create Function' : 'Create Procedure']);
      const sqlMode = String(created[0].sql_mode);
      out.push({ ...parseRoutine(ddl, routineLexMode(sqlMode)), sqlMode });
    }
  }
  return out;
}
```

`packages/core/test/mysql.int.test.ts` 에서는 다음과 같이 바꾼다.
- `portOf` 함수와 `TARGETS` 상수, 파일 끝의 `dumpSchema`·`dumpRoutines` 함수를 지운다.
- `import { dumpSchema, MYSQL_TARGETS } from './mysql-dump';` 를 더한다.
- `suite.each(TARGETS)` 를 `suite.each(MYSQL_TARGETS)` 로 바꾼다.
- 지운 함수만 쓰던 import(`RowDataPacket`, `parseRoutine`, `routineLexMode` 등)가 남으면 typecheck 가 알려 주는 대로 정리한다.

Run: `npm run typecheck -w @tdm/core` — Expected: 오류 없음

- [ ] **Step 2: 시나리오 하네스를 쓴다**

`packages/core/test/apply.int.test.ts`:

```ts
// ALTER 적용 실증: 같은 스크립트를 MySQL 에 실행한 결과와 applyScript 결과가 같은지 확인한다.
// 기준: 비교 엔진으로 양방향 0문장 + 테이블마다 컬럼·인덱스·FK·CHECK 이름 순서가 같음 + printSqlDump 왕복
import { readdirSync } from 'node:fs';
import mysql, { type Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyScript, printSqlDump } from '../src/apply';
import { canonicalJson } from '../src/canonical';
import { generateDdl } from '../src/ddl';
import { diffSchemas } from '../src/diff';
import type { SchemaModel } from '../src/model';
import { parseSqlDump, splitStatements } from '../src/parse-dump';
import { fixture, hasFixture } from './helpers';
import { dumpSchema, MYSQL_TARGETS } from './mysql-dump';

const SCENARIOS = readdirSync(new URL('./fixtures/alter-scenarios/', import.meta.url), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const suite = process.env.MYSQL_IT === '1' ? describe : describe.skip;
const COMPLETE = { level: 'complete' as const, objects: [] };
const at = (name: string, file: string) => `alter-scenarios/${name}/${file}`;
const zeroDiff = (from: SchemaModel, to: SchemaModel) => generateDdl(diffSchemas({ ...from, evidence: COMPLETE }, { ...to, evidence: COMPLETE })).map((s) => s.sql);
const names = (m: SchemaModel) => Object.fromEntries(m.tables.map((t) => [t.name, {
  columns: t.columns.map((c) => c.name), indexes: t.indexes.map((i) => i.name), fks: t.foreignKeys.map((f) => f.name), checks: t.checks.map((k) => k.name),
}]));

suite.each(MYSQL_TARGETS)('$name ALTER 적용', ({ name: target, port }) => {
  let conn: Connection;

  beforeAll(async () => {
    conn = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: 'test' });
  });

  afterAll(async () => {
    await conn?.end();
  });

  it.each(SCENARIOS)('%s', async (name) => {
    if (hasFixture(at(name, 'only.txt')) && fixture(at(name, 'only.txt')).trim() !== target) return;
    const db = `ap_${name.replace(/-/g, '_')}`;
    const baseText = (hasFixture(at(name, 'base.sql')) ? fixture(at(name, 'base.sql')) : fixture('alter-scenarios/_base.sql')).replaceAll('__DB__', db);
    const script = fixture(at(name, 'script.sql')).replaceAll('__DB__', db);
    const expectError = hasFixture(at(name, 'expect-error.txt')) ? Number(fixture(at(name, 'expect-error.txt')).trim()) : undefined;
    await conn.query(`DROP DATABASE IF EXISTS \`${db}\``);
    await conn.query(`CREATE DATABASE \`${db}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    await conn.query(`USE \`${db}\``);
    await conn.query('SET SESSION sql_mode = DEFAULT, foreign_key_checks = 1');
    try {
      for (const { ddl } of splitStatements(baseText)) await conn.query(ddl);
      const base = parseSqlDump(baseText).model;
      expect(zeroDiff(base, await dumpSchema(conn, db)), 'base.sql 이 MySQL 출력과 같아야 한다').toEqual([]);
      const ours = applyScript(base, script, { schemaName: db });
      let mysqlError: number | undefined;
      try {
        for (const { ddl } of splitStatements(script)) await conn.query(ddl);
      } catch (e) {
        mysqlError = (e as { errno?: number }).errno ?? -1;
      }
      if (expectError !== undefined) {
        expect(mysqlError, 'MySQL 이 거부해야 한다').toBe(expectError);
        expect(ours.ok, '우리도 거부해야 한다').toBe(false);
        return;
      }
      expect(mysqlError, 'MySQL 이 스크립트를 받아야 한다').toBeUndefined();
      if (!ours.ok) throw new Error(`applyScript 실패 — ${ours.error.index}번째 문장 (줄 ${ours.error.line}): ${ours.error.reason}`);
      const dumped = await dumpSchema(conn, db);
      expect(zeroDiff(ours.model, dumped), '우리 → MySQL').toEqual([]);
      expect(zeroDiff(dumped, ours.model), 'MySQL → 우리').toEqual([]);
      expect(names(ours.model), '이름 순서').toEqual(names(dumped));
      const again = parseSqlDump(printSqlDump(ours.model));
      expect(again.warnings, 'printSqlDump 왕복 경고').toEqual([]);
      expect(canonicalJson([again.model.tables, again.model.views, again.model.routines])).toBe(canonicalJson([ours.model.tables, ours.model.views, ours.model.routines]));
    } finally {
      await conn.query(`DROP DATABASE IF EXISTS \`${db}\``);
    }
  });
});
```

`packages/core/package.json` 의 `test:mysql` 을 다음으로 바꾼다:

```json
"test:mysql": "docker compose -f docker-compose.test.yml up -d --wait && MYSQL_IT=1 vitest run test/mysql.int.test.ts test/apply.int.test.ts",
```

- [ ] **Step 3: 공용 기준 덤프와 성공 시나리오 13개를 만든다**

`packages/core/test/fixtures/alter-scenarios/_base.sql`:

```sql
/* Database : __DB__ */
SET NAMES utf8mb4;
SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;
SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';

/* Table : member */
CREATE TABLE `member` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `email` varchar(100) COLLATE utf8mb4_general_ci NOT NULL,
  `name` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `age` int DEFAULT NULL,
  `memo` text COLLATE utf8mb4_general_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  KEY `name_age` (`name`,`age`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='회원';


/* Table : orders */
CREATE TABLE `orders` (
  `id` int NOT NULL AUTO_INCREMENT,
  `member_id` int unsigned NOT NULL,
  `amount` decimal(12,2) NOT NULL DEFAULT '0.00',
  PRIMARY KEY (`id`),
  KEY `member_id` (`member_id`),
  CONSTRAINT `orders_ibfk_1` FOREIGN KEY (`member_id`) REFERENCES `member` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;
SET SQL_MODE = @OLD_SQL_MODE;
```

시나리오마다 `script.sql` 을 아래 내용으로 만든다(폴더 이름 = 시나리오 이름):

`add-columns/script.sql`:

```sql
ALTER TABLE member
  ADD COLUMN nick VARCHAR(20) NOT NULL DEFAULT '' AFTER email,
  ADD COLUMN point INT(11) UNSIGNED DEFAULT 0,
  ADD COLUMN rate DECIMAL(5,2) NOT NULL DEFAULT 1,
  ADD COLUMN is_vip BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN grade ENUM('basic', "gold", 'vip') NOT NULL DEFAULT 'BASIC',
  ADD COLUMN visited_at TIMESTAMP,
  ADD COLUMN updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  ADD COLUMN seq BIGINT FIRST;
ALTER TABLE orders ADD (note VARCHAR(200) COMMENT '메모 ''따옴표''', paid TINYINT(1) DEFAULT NULL);
```

`modify-change/script.sql`:

```sql
ALTER TABLE member MODIFY name VARCHAR(80) NOT NULL DEFAULT '이름 없음' COMMENT '이름', MODIFY age SMALLINT UNSIGNED DEFAULT NULL AFTER email;
ALTER TABLE member CHANGE memo profile MEDIUMTEXT, CHANGE COLUMN created_at joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP FIRST;
ALTER TABLE orders MODIFY amount DECIMAL(14,2) NOT NULL DEFAULT 0;
```

`rename-drop-columns/script.sql`:

```sql
ALTER TABLE member RENAME COLUMN name TO full_name, RENAME COLUMN age TO years;
ALTER TABLE member RENAME COLUMN full_name TO years, RENAME COLUMN years TO full_name;
ALTER TABLE member DROP COLUMN memo, DROP COLUMN years;
ALTER TABLE member ALTER COLUMN full_name SET DEFAULT 7, ALTER COLUMN email SET INVISIBLE;
ALTER TABLE member ALTER COLUMN full_name DROP DEFAULT;
ALTER TABLE orders RENAME COLUMN member_id TO buyer_id;
```

`indexes/script.sql`:

```sql
ALTER TABLE member ADD INDEX (age), ADD UNIQUE (name), ADD INDEX ix_created (created_at DESC), ADD FULLTEXT INDEX ft_memo (memo) WITH PARSER ngram, ADD INDEX ix_email_prefix (email(10)) COMMENT '접두';
ALTER TABLE member ADD KEY (age), RENAME INDEX name_age TO ix_name_age, ALTER INDEX ix_created INVISIBLE;
CREATE INDEX ix_amount USING BTREE ON orders (amount) ALGORITHM=INPLACE LOCK=NONE;
DROP INDEX ix_email_prefix ON member;
ALTER TABLE member DROP INDEX `name`;
```

`primary-key/script.sql`:

```sql
ALTER TABLE orders DROP PRIMARY KEY, ADD PRIMARY KEY (id, member_id);
CREATE TABLE seq_test (a INT, b INT, PRIMARY KEY (a));
ALTER TABLE seq_test MODIFY a INT NOT NULL AUTO_INCREMENT;
```

`foreign-keys/script.sql`:

```sql
CREATE TABLE coupon (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  member_id INT UNSIGNED,
  order_id INT,
  parent_id INT UNSIGNED,
  CONSTRAINT fk_coupon_member FOREIGN KEY (member_id) REFERENCES member (id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE SET NULL ON UPDATE CASCADE,
  FOREIGN KEY ix_parent (parent_id) REFERENCES coupon (id)
) ENGINE=InnoDB;
ALTER TABLE orders ADD COLUMN coupon_id INT UNSIGNED, ADD CONSTRAINT fk_orders_coupon FOREIGN KEY (coupon_id) REFERENCES coupon (id);
ALTER TABLE orders DROP FOREIGN KEY orders_ibfk_1;
```

`create-table/script.sql`:

```sql
CREATE TABLE IF NOT EXISTS member (x INT);
CREATE TABLE `tag` (
  tag_id int(11) NOT NULL AUTO_INCREMENT,
  label varchar(30) NOT NULL UNIQUE,
  slug VARCHAR(30) CHARACTER SET latin1 COLLATE latin1_bin NOT NULL,
  weight double precision DEFAULT 1.5,
  active bool NOT NULL DEFAULT true,
  created timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note text,
  PRIMARY KEY (tag_id),
  KEY ix_slug (slug),
  UNIQUE KEY uq_slug_label (slug, label)
) ENGINE=innodb DEFAULT CHARSET=utf8mb4 COMMENT='태그';
CREATE TABLE plain (id INT PRIMARY KEY, name VARCHAR(10));
```

`drop-rename-tables/script.sql`:

```sql
RENAME TABLE member TO tmp_member, orders TO member, tmp_member TO orders;
CREATE TABLE tmp1 (id INT PRIMARY KEY);
CREATE TABLE tmp2 (id INT PRIMARY KEY, t1 INT, FOREIGN KEY (t1) REFERENCES tmp1 (id));
DROP TABLE IF EXISTS nope, tmp2, tmp1;
ALTER TABLE orders RENAME TO members_renamed;
```

`table-options/script.sql`:

```sql
ALTER TABLE member COMMENT 'members (v2)', ENGINE=InnoDB;
ALTER TABLE member ROW_FORMAT=COMPRESSED KEY_BLOCK_SIZE=8;
ALTER TABLE orders ROW_FORMAT=DYNAMIC, COMMENT='주문';
ALTER TABLE orders ROW_FORMAT=DEFAULT, COMMENT='';
ALTER TABLE member AUTO_INCREMENT = 1000, FORCE;
```

`routines/script.sql`:

```sql
SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION';
CREATE FUNCTION fn_double(x INT) RETURNS INT DETERMINISTIC RETURN x * 2;
SET SESSION sql_mode = DEFAULT;
DELIMITER ;;
CREATE PROCEDURE sp_touch(IN p_id INT UNSIGNED)
  MODIFIES SQL DATA
  COMMENT '회원 갱신'
BEGIN
  UPDATE member SET age = age WHERE id = p_id;
END;;
CREATE FUNCTION fn_label(p_name VARCHAR(50)) RETURNS VARCHAR(60) DETERMINISTIC
BEGIN
  RETURN CONCAT('[', p_name, ']');
END;;
DELIMITER ;
DROP FUNCTION IF EXISTS fn_missing;
DROP PROCEDURE IF EXISTS sp_missing;
```

`session-fk-checks/script.sql`:

```sql
SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;
DROP TABLE member;
CREATE TABLE audit (id INT PRIMARY KEY, ref_id INT, FOREIGN KEY (ref_id) REFERENCES later_table (id));
SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;
```

`qualified-names/script.sql`:

```sql
USE __DB__;
ALTER TABLE __DB__.member ADD COLUMN q INT;
CREATE INDEX ix_q ON `__DB__`.`member` (q);
RENAME TABLE __DB__.orders TO __DB__.orders2;
```

`charset-columns/script.sql`:

```sql
ALTER TABLE member
  ADD COLUMN a VARCHAR(10),
  ADD COLUMN b VARCHAR(10) CHARACTER SET latin1,
  ADD COLUMN c VARCHAR(10) COLLATE utf8mb4_bin,
  ADD COLUMN d VARCHAR(10) CHARACTER SET utf8mb4,
  ADD COLUMN e VARCHAR(10) CHARACTER SET utf8 COLLATE utf8_unicode_ci,
  ADD COLUMN f ENUM('x','y') CHARACTER SET ascii;
ALTER TABLE member MODIFY name VARCHAR(50);
```

- [ ] **Step 4: 실패 시나리오 10개를 만든다 (`script.sql` 과 `expect-error.txt`)**

| 폴더 | script.sql | expect-error.txt |
|---|---|---|
| `error-drop-fk-column` | `ALTER TABLE orders DROP COLUMN member_id;` | `1828` |
| `error-drop-referenced-table` | `DROP TABLE member;` | `3730` |
| `error-auto-increment-key` | `ALTER TABLE orders DROP PRIMARY KEY;` | `1075` |
| `error-duplicate-column` | `ALTER TABLE member ADD COLUMN email INT;` | `1060` |
| `error-unknown-column` | `ALTER TABLE member MODIFY nope INT;` | `1054` |
| `error-blob-key-length` | `ALTER TABLE member ADD INDEX (memo);` | `1170` |
| `error-fk-type` | `ALTER TABLE orders ADD COLUMN m2 BIGINT, ADD FOREIGN KEY (m2) REFERENCES member (id);` | `3780` |
| `error-drop-fk-index` | `ALTER TABLE orders DROP INDEX member_id;` | `1553` |
| `error-duplicate-pk` | `ALTER TABLE member ADD PRIMARY KEY (email);` | `1068` |
| `error-drop-last-column` | `CREATE TABLE one_col (x INT);` 다음 줄에 `ALTER TABLE one_col DROP COLUMN x;` | `1090` |

`expect-error.txt` 에는 숫자 한 줄만 쓴다.

- [ ] **Step 5: MySQL 에서 돌리고, 다른 부분을 고친다**

Run (저장소 루트): `npm run test:mysql -w @tdm/core`

Expected:
- 처음에는 일부 시나리오가 실패할 수 있다. 설계 4장에서 실측으로 정하기로 한 규칙들이다.
  - FK 자동 인덱스 이름, FK·CHECK 순서
  - `DROP DEFAULT`, 명시한 `COLLATE` 표기
  - `RETURNS` 문자셋 표기, 루틴 params 표기
  - 한 문장 RENAME COLUMN 맞바꾸기
  - `ROW_FORMAT=DEFAULT`, `KEY_BLOCK_SIZE`, TIMESTAMP NULL 표기, DECIMAL·ENUM 기본값

실패마다 아래 순서로 처리한다.
1. 실패 메시지를 읽고 무엇이 다른지 확인한다.
   - `우리 → MySQL`·`MySQL → 우리` 의 DDL 문장은 무엇이 다른지 그대로 보여 준다.
   - `이름 순서` 는 순서가 다른 목록을 보여 준다.
2. 필요하면 tdm-my84(127.0.0.1:33099)에 임시 DB 를 만들어 같은 문장을 실행한다. `SHOW CREATE TABLE`·`SHOW CREATE FUNCTION` 으로 MySQL 이 실제로 내는 표기를 확인한 뒤, 임시 DB 는 지운다.
3. 그 규칙을 고정하는 단위 테스트를 `packages/core/test/apply/` 의 해당 파일에 먼저 쓰고(RED), `src/apply/` 의 규칙을 고친다(GREEN).
4. 처리 방법은 경우에 따라 다르다.

| 경우 | 처리 |
|---|---|
| MySQL 이 받는 스크립트를 우리가 거부 | 규칙을 고쳐 받게 한다. 1차 범위 밖이 맞으면 시나리오에서 그 문장을 빼고 이유를 스펙 3.2 에 적는다 |
| MySQL 이 거부하는 스크립트를 우리가 받음 | 우리도 거부하게 하고, `expect-error.txt` 시나리오로 옮긴다 |
| 8.0 과 8.4 가 다름 | 8.4 를 따르고, 8.0 에서 다른 부분은 `only.txt`(`MySQL 8.4`)로 그 시나리오를 8.4 전용으로 표시한다. 차이는 스펙 4장에 적는다 |

5. 정한 규칙은 스펙 `docs/superpowers/specs/2026-10-13-alter-apply-design.md` 4장의 해당 항목에 "8.0/8.4 실측: …" 으로 한 줄씩 적는다.
   - 대상: "시나리오로 확인한 MySQL 동작을 따른다"고 적은 이름 표기·FK 자동 인덱스 이름 등.
   - 대소문자만 다른 이름을 쓰는 절의 실측 결과도 적는다. 규칙이 정해지면 Task 5 의 거부를 그 규칙으로 바꾼다.

다시 Run: `npm run test:mysql -w @tdm/core` — Expected: 8.0·8.4 모두 PASS. 기존 `mysql.int.test.ts` 결과도 그대로여야 한다.
끝나면: `docker compose -f packages/core/docker-compose.test.yml down`

- [ ] **Step 6: core 전체 테스트·타입 검사와 커밋**

Run: `npm test -w @tdm/core && npm run typecheck -w @tdm/core` — Expected: PASS

```bash
git add packages/core/test/mysql-dump.ts packages/core/test/mysql.int.test.ts packages/core/test/apply.int.test.ts packages/core/test/fixtures/alter-scenarios packages/core/package.json packages/core/src/apply packages/core/test/apply docs/superpowers/specs/2026-10-13-alter-apply-design.md
git commit -m "test(core): ALTER 적용을 실제 MySQL 8.0/8.4 결과와 비교하는 시나리오 (성공 13·실패 10) — 실측에 맞춘 규칙 보정"
```

---

### Task 10: 서버 — ALTER 적용 API·저장·재판정

**Files:**
- Create: `apps/server/src/db/migrations/009_version_derivations.sql`, `apps/server/src/repos/derivations.ts`, `apps/server/src/services/alter.ts`
- Modify:

| 파일 | 수정 내용 |
|---|---|
| `apps/server/src/services/ingest.ts` | `evidence`·`onCreated` 옵션 |
| `apps/server/src/repos/renames.ts` | `writeRenames` 추출 |
| `apps/server/src/repos/versions.ts` | `derivedFrom` |
| `apps/server/src/services/evidence-backfill.ts` | 파생 버전 상속·stale 전파 |
| `apps/server/src/routes/versions.ts` | 두 라우트 추가 |
| `apps/server/src/limits.ts` | 스크립트 크기 한도 |
| `apps/server/README.md` | API 표 |

- Test:
  - 새로 만든다: `apps/server/test/alter.test.ts`
  - user_version 기대값을 8 → 9 로 바꾼다: `apps/server/test/db.test.ts`(16·24행), `apps/server/test/backup.test.ts`(22행), `apps/server/test/evidence.test.ts`(54행)

**Interfaces:**
- Consumes: `@tdm/core` 의 `applyScript`, `printSqlDump`, `parseSqlDump`, `diffSchemas`, `MYSQL_DEFAULTS`, `ApplyDefaults`, `RenameMapping`, `SchemaDiff`, `SchemaEvidence`
- Produces:
  - `POST /api/versions/:id/alter`
    - 권한: admin·dba
    - 본문: `{ script, filename?, note?, dryRun?, defaults?: { charset?, collation? } }`
    - 응답 `AlterResult`:
      - `{ status: 'preview'; applied; changes: AlterChange[]; renames }`
      - `{ status: 'ok' | 'duplicate'; versionId; versionNo; applied; changes }`
    - `AlterChange = { kind: 'table' | 'view' | 'function' | 'procedure'; name; op: 'add' | 'drop' | 'modify' | 'rename' }`
  - `GET /api/versions/:id/derivation`
    - 권한: 로그인
    - 응답 `Derivation = { baseVersionId: number | null; baseVersionNo; script; statementCount; defaults: { charset; collation } }`
    - ALTER 로 만든 버전이 아니면 404
  - `VersionMeta.derivedFrom?: { baseVersionNo: number; statementCount: number; defaults: { charset: string; collation: string } }`
    - `GET /schemas/:id/versions` 와 `GET /versions/:id` 에 실린다

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`apps/server/test/alter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { one, run } from '../src/db/connection';
import { loadEvidence, loadStaleReason } from '../src/repos/evidence';
import { listRenames } from '../src/repos/renames';
import { backfillEvidence } from '../src/services/evidence-backfill';
import { ingest } from '../src/services/ingest';
import { CSRF, loggedInApp, SAMPLE_MD, sampleText } from './helpers';

const TABLE = 'CREATE TABLE `member` (\n  `id` int unsigned NOT NULL AUTO_INCREMENT,\n  `name` varchar(50) DEFAULT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;';
const dump = (db: string, table = TABLE) => [
  `/* Database : ${db} */`, 'SET NAMES utf8mb4;', 'SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;', "SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';", '',
  table, '', 'SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;', 'SET SQL_MODE = @OLD_SQL_MODE;', '',
].join('\n');

async function setup() {
  const ctx = await loggedInApp();
  const base = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'shop', filename: 'shop.sql', text: dump('shop'), userId: 1 });
  const schemaId = Number(one<{ schema_id: number }>(ctx.db, 'SELECT schema_id FROM schema_versions WHERE id = ?', base.versionId)!.schema_id);
  const alter = (id: number, payload: Record<string, unknown>, headers: Record<string, string> = ctx.admin) =>
    ctx.app.inject({ method: 'POST', url: `/api/versions/${id}/alter`, headers, payload });
  return { ...ctx, baseId: base.versionId, schemaId, alter };
}

describe('POST /versions/:id/alter', () => {
  it('미리보기는 저장하지 않고 변경 목록과 rename 을 돌려준다', async () => {
    const ctx = await setup();
    const res = await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD COLUMN age INT;\nALTER TABLE member RENAME COLUMN name TO full_name;', dryRun: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'preview', applied: 2, changes: [{ kind: 'table', name: 'member', op: 'modify' }], renames: [{ kind: 'column', table: 'member', from: 'name', to: 'full_name' }] });
    expect(one(ctx.db, 'SELECT count(*) AS n FROM schema_versions')).toEqual({ n: 1 });
  });

  it('저장하면 새 버전(원문은 td-export 형식)·파생 정보·rename 매핑·기준 판정 상속', async () => {
    const ctx = await setup();
    const res = await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member RENAME COLUMN name TO full_name;', note: '이름 변경', filename: 'rename.sql' });
    expect(res.json()).toMatchObject({ status: 'ok', versionNo: 2, applied: 1 });
    const id = res.json().versionId as number;
    const derivation = await ctx.app.inject({ method: 'GET', url: `/api/versions/${id}/derivation`, headers: ctx.viewer });
    expect(derivation.json()).toEqual({ baseVersionId: ctx.baseId, baseVersionNo: 1, script: 'ALTER TABLE member RENAME COLUMN name TO full_name;', statementCount: 1, defaults: { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' } });
    expect(listRenames(ctx.db, ctx.baseId, id)).toEqual([{ kind: 'column', table: 'member', from: 'name', to: 'full_name' }]);
    const list = (await ctx.app.inject({ method: 'GET', url: `/api/schemas/${ctx.schemaId}/versions`, headers: ctx.viewer })).json();
    expect(list[0]).toMatchObject({ versionNo: 2, sourceFilename: 'rename.sql', note: '이름 변경', derivedFrom: { baseVersionNo: 1, statementCount: 1, defaults: { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' } } });
    expect(list[1].derivedFrom).toBeUndefined();
    const source = await ctx.app.inject({ method: 'GET', url: `/api/versions/${id}/source`, headers: ctx.viewer });
    expect(source.body.startsWith('/* Database : shop */\nSET NAMES utf8mb4;')).toBe(true);
    expect(loadEvidence(ctx.db, id)).toEqual(loadEvidence(ctx.db, ctx.baseId));
    expect((await ctx.app.inject({ method: 'GET', url: `/api/versions/${ctx.baseId}/derivation`, headers: ctx.viewer })).statusCode).toBe(404);
  });

  it('권한·잘못된 스크립트·변경 없음·없는 버전', async () => {
    const ctx = await setup();
    expect((await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD x INT;' }, ctx.viewer)).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/versions/${ctx.baseId}/alter`, headers: CSRF, payload: { script: 'x' } })).statusCode).toBe(401);
    expect((await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD x INT;' }, ctx.dba)).statusCode).toBe(200);
    const bad = await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD COLUMN id INT;', dryRun: true });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('1번째 문장 (줄 1)');
    expect(bad.json().details.error).toMatchObject({ index: 1, line: 1 });
    expect((await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ENGINE=InnoDB;', dryRun: true })).json().error).toContain('변경 없음');
    expect((await ctx.alter(9999, { script: 'ALTER TABLE member ADD x INT;' })).statusCode).toBe(404);
    expect((await ctx.alter(ctx.baseId, { script: '' })).statusCode).toBe(400);
  });

  it('MD 기준·stale 기준은 거부하고, 같은 결과를 다시 저장하면 duplicate', async () => {
    const ctx = await setup();
    const md = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'app', filename: SAMPLE_MD, text: sampleText(SAMPLE_MD), userId: 1 });
    expect((await ctx.alter(md.versionId, { script: 'ALTER TABLE x ADD y INT;' })).json().error).toContain('MD');
    const first = await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD age INT;' });
    const again = await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD age INT;' });
    expect(again.json()).toMatchObject({ status: 'duplicate', versionId: first.json().versionId });
    run(ctx.db, "UPDATE schema_version_evidence SET stale_reason = '예전 파서로 저장된 모델' WHERE version_id = ?", ctx.baseId);
    expect((await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD y INT;' })).json().error).toContain('예전 파서');
  });

  it('기동 재판정: 파생 버전은 기준 판정(unknown 포함)을 물려받고, 기준이 stale 이면 파생 버전도 stale', async () => {
    const ctx = await setup();
    const legacy = ingest(ctx.db, { databaseName: 'db-01', schemaName: 'legacy', filename: 'legacy.sql', text: `/* Database : legacy */\n${TABLE}\n`, userId: 1 });
    const fromLegacy = (await ctx.alter(legacy.versionId, { script: 'ALTER TABLE member ADD age INT;' })).json();
    expect(loadEvidence(ctx.db, fromLegacy.versionId)?.level).toBe('unknown');
    const derived = (await ctx.alter(ctx.baseId, { script: 'ALTER TABLE member ADD age INT;' })).json();
    run(ctx.db, 'UPDATE schema_version_sources SET source_text = ? WHERE version_id = ?', dump('shop', TABLE.replace('varchar(50)', 'varchar(60)')), ctx.baseId);
    run(ctx.db, 'UPDATE schema_version_evidence SET judge_rev = 0');
    expect(backfillEvidence(ctx.db)).toBe(4);
    expect(loadStaleReason(ctx.db, ctx.baseId)).toBeDefined();
    expect(loadStaleReason(ctx.db, derived.versionId)).toContain('기준 버전 v1');
    expect(loadEvidence(ctx.db, derived.versionId)?.level).toBe('complete');
    expect(loadEvidence(ctx.db, fromLegacy.versionId)?.level).toBe('unknown');
    expect(loadStaleReason(ctx.db, fromLegacy.versionId)).toBeUndefined();
  });
});
```

Run: `npx vitest run test/alter.test.ts` (in `apps/server`) — Expected: FAIL (라우트 404)

- [ ] **Step 2: 마이그레이션 009 를 만든다**

`apps/server/src/db/migrations/009_version_derivations.sql`:

```sql
-- 스키마 v9: ALTER 스크립트를 적용해 만든 버전(파생 버전)의 기준 버전·스크립트·스키마 기본 문자셋.
-- 파생 버전의 원문(schema_version_sources)은 결과 모델을 td-export 0.1.52 형식으로 출력한 덤프다 — 완전성 판정은 원문이 아니라
-- 기준 버전에서 물려받는다 (출력한 덤프에는 늘 헤더·트레일러가 있다). base_version_no 는 기준 버전이 지워져도 '기준 vN' 을 보여 준다
CREATE TABLE schema_version_derivations (
  version_id INTEGER PRIMARY KEY REFERENCES schema_versions (id) ON DELETE CASCADE,
  base_version_id INTEGER REFERENCES schema_versions (id) ON DELETE SET NULL,
  base_version_no INTEGER NOT NULL CHECK (base_version_no > 0),
  script TEXT NOT NULL CHECK (length(script) > 0),
  statement_count INTEGER NOT NULL CHECK (statement_count > 0),
  default_charset TEXT NOT NULL CHECK (length(default_charset) > 0),
  default_collation TEXT NOT NULL CHECK (length(default_collation) > 0)
) STRICT;
CREATE INDEX ix_version_derivations_base ON schema_version_derivations (base_version_id);
```

`apps/server/test/db.test.ts`(16·24행), `apps/server/test/backup.test.ts`(22행), `apps/server/test/evidence.test.ts`(54행) 의 `toBe(8)` 을 `toBe(9)` 로 바꾼다.

- [ ] **Step 3: derivations 저장소를 만들고 renames 의 쓰기를 뽑는다**

`apps/server/src/repos/derivations.ts`:

```ts
import type { ApplyDefaults } from '@tdm/core';
import { one, run, type Db } from '../db/connection';

// ALTER 적용으로 만든 버전의 기준·스크립트 (009)
export interface Derivation {
  baseVersionId: number | null; // 기준 버전이 지워지면 null
  baseVersionNo: number;
  script: string;
  statementCount: number;
  defaults: ApplyDefaults;
}

export function saveDerivation(db: Db, versionId: number, d: Derivation): void {
  run(db, `INSERT INTO schema_version_derivations (version_id, base_version_id, base_version_no, script, statement_count, default_charset, default_collation)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
    versionId, d.baseVersionId, d.baseVersionNo, d.script, d.statementCount, d.defaults.charset, d.defaults.collation);
}

export function loadDerivation(db: Db, versionId: number): Derivation | undefined {
  const r = one<{ base_version_id: number | null; base_version_no: number; script: string; statement_count: number; default_charset: string; default_collation: string }>(db,
    'SELECT base_version_id, base_version_no, script, statement_count, default_charset, default_collation FROM schema_version_derivations WHERE version_id = ?', versionId);
  if (!r) return undefined;
  return {
    baseVersionId: r.base_version_id === null ? null : Number(r.base_version_id), baseVersionNo: Number(r.base_version_no), script: r.script,
    statementCount: Number(r.statement_count), defaults: { charset: r.default_charset, collation: r.default_collation },
  };
}
```

`apps/server/src/repos/renames.ts` 의 `replaceRenames` 를 둘로 나눈다. 본문은 그대로 `writeRenames` 로 옮긴다:

```ts
// (base, target) 쌍의 매핑 전체를 바꾸고, 이 쌍에 저장했음을 기록한다 (같은 버전끼리는 매핑이 없어 기록하지 않는다).
// 트랜잭션은 호출자가 연다 (ALTER 적용은 새 버전과 같은 트랜잭션에서 쓴다)
export function writeRenames(db: Db, baseId: number, targetId: number, renames: RenameMapping[], userId: number): void {
  run(db, 'DELETE FROM rename_mappings WHERE base_version_id = ? AND target_version_id = ?', baseId, targetId);
  if (baseId !== targetId) run(db, 'INSERT OR IGNORE INTO rename_mapping_sets (base_version_id, target_version_id) VALUES (?, ?)', baseId, targetId);
  for (const r of renames) {
    run(db, `INSERT INTO rename_mappings (base_version_id, target_version_id, kind, table_name, old_name, new_name, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`, baseId, targetId, r.kind, r.table ?? null, r.from, r.to, userId);
  }
}

export function replaceRenames(db: Db, baseId: number, targetId: number, renames: RenameMapping[], userId: number): void {
  tx(db, () => writeRenames(db, baseId, targetId, renames, userId));
}
```

- [ ] **Step 4: ingest 에 판정 지정·생성 콜백을 더한다**

`apps/server/src/services/ingest.ts`:

`IngestInput` 에 두 필드를 더한다:

```ts
  evidence?: SchemaEvidence; // 완전성 판정을 원문 대신 이 값으로 (ALTER 적용 버전: 기준 버전의 판정을 물려받는다)
  onCreated?: (versionId: number) => void; // 새 버전을 만든 같은 트랜잭션 안에서 부른다 (duplicate 면 부르지 않는다)
```

`ingest` 본문에서 아래 두 줄을

```ts
  const warnings = withUnverifiedWarning(model, withEmptySchemaWarning(format, parsed));
```
```ts
  const evidence = model.evidence ?? UNJUDGED;
```

다음으로 바꾸고 순서를 맞춘다(evidence 를 먼저 정한다):

```ts
  const evidence = input.evidence ?? model.evidence ?? UNJUDGED;
  const warnings = withUnverifiedWarning({ ...model, evidence }, withEmptySchemaWarning(format, parsed));
```

그리고 `for (const obj of [...model.tables, ...model.views, ...model.routines]) linkObject(...)` 줄 바로 다음에 `input.onCreated?.(versionId);` 를 넣는다.

- [ ] **Step 5: versions 메타에 derivedFrom 을 싣는다**

`apps/server/src/repos/versions.ts`:

- `VersionMeta` 에 `derivedFrom?: { baseVersionNo: number; statementCount: number; defaults: { charset: string; collation: string } };` 를 더한다 (주석: `// ALTER 적용으로 만든 버전 (009)`).
- `MetaRecord` 에 `base_version_no: number | null; statement_count: number | null; default_charset: string | null; default_collation: string | null;` 를 더한다.
- `META_SQL` 의 SELECT 목록 끝에 `, dv.base_version_no, dv.statement_count, dv.default_charset, dv.default_collation` 을, `JOIN users u ON u.id = v.uploaded_by` 다음 줄에 `LEFT JOIN schema_version_derivations dv ON dv.version_id = v.id` 를 더한다.
- `toMeta` 의 반환 객체 끝에 다음을 더한다:

```ts
  ...(r.base_version_no === null ? {} : {
    derivedFrom: { baseVersionNo: Number(r.base_version_no), statementCount: Number(r.statement_count), defaults: { charset: r.default_charset!, collation: r.default_collation! } },
  }),
```

- [ ] **Step 6: ALTER 적용 서비스를 만든다**

`apps/server/src/services/alter.ts`:

```ts
// ALTER 스크립트를 기준 버전 모델에 적용해 새 버전을 만든다: core applyScript → printSqlDump(원문) → ingest (같은 트랜잭션에서
// 파생 정보·rename 매핑을 쓰고, 완전성 판정은 기준 버전에서 물려받는다)
import { applyScript, diffSchemas, MYSQL_DEFAULTS, parseSqlDump, printSqlDump, type ApplyDefaults, type RenameMapping, type SchemaDiff, type SchemaEvidence } from '@tdm/core';
import type { Db } from '../db/connection';
import { AppError } from '../errors';
import { saveDerivation } from '../repos/derivations';
import { loadEvidence } from '../repos/evidence';
import { writeRenames } from '../repos/renames';
import { loadVersion } from '../repos/versions';
import { ingest } from './ingest';

export interface AlterInput {
  baseId: number;
  script: string;
  filename?: string;
  note?: string;
  defaults?: Partial<ApplyDefaults>;
  dryRun?: boolean;
  userId: number;
}

export interface AlterChange {
  kind: 'table' | 'view' | 'function' | 'procedure';
  name: string;
  op: 'add' | 'drop' | 'modify' | 'rename';
}

export type AlterResult =
  | { status: 'preview'; applied: number; changes: AlterChange[]; renames: RenameMapping[] }
  | { status: 'ok' | 'duplicate'; versionId: number; versionNo: number; applied: number; changes: AlterChange[] };

const NO_EVIDENCE: SchemaEvidence = { level: 'unknown', reason: '기준 버전의 완전성 판정이 없습니다', objects: [] };

export function applyAlter(db: Db, input: AlterInput): AlterResult {
  const base = loadVersion(db, input.baseId);
  if (base.version.sourceFormat !== 'sql') throw new AppError(400, 'MD 로 올린 버전에는 ALTER 를 적용할 수 없습니다 — SQL 덤프 버전을 기준으로 고르세요');
  if (base.staleReason) throw new AppError(400, `기준 버전 v${base.version.versionNo} 은 예전 파서로 저장된 모델이라 ALTER 를 적용할 수 없습니다 — 같은 원문을 다시 올린 버전을 기준으로 고르세요`);
  const result = applyScript(base.model, input.script, { schemaName: base.version.schemaName, defaults: { ...MYSQL_DEFAULTS, ...input.defaults } });
  if (!result.ok) {
    const { index, line, reason } = result.error;
    throw new AppError(400, index > 0 ? `${index}번째 문장 (줄 ${line}): ${reason}` : reason, { error: result.error });
  }
  const text = printSqlDump({ ...result.model, name: base.version.schemaName });
  const changes = changesOf(diffSchemas(base.model, parseSqlDump(text).model, result.renames));
  if (!changes.length) throw new AppError(400, '변경 없음 — 스크립트를 적용해도 기준 버전과 같습니다');
  if (input.dryRun) return { status: 'preview', applied: result.applied, changes, renames: result.renames };
  const filename = input.filename ?? 'alter.sql';
  if (!/\.sql$/i.test(filename)) throw new AppError(400, 'ALTER 스크립트 파일 이름은 .sql 로 끝나야 합니다');
  const saved = ingest(db, {
    databaseName: base.version.databaseName, schemaName: base.version.schemaName, filename, text, note: input.note, userId: input.userId,
    evidence: loadEvidence(db, input.baseId) ?? NO_EVIDENCE,
    onCreated: (versionId) => {
      saveDerivation(db, versionId, { baseVersionId: input.baseId, baseVersionNo: base.version.versionNo, script: input.script, statementCount: result.applied, defaults: result.defaults });
      writeRenames(db, input.baseId, versionId, result.renames, input.userId);
    },
  });
  return { status: saved.status, versionId: saved.versionId, versionNo: saved.versionNo, applied: result.applied, changes };
}

function changesOf(diff: SchemaDiff): AlterChange[] {
  return [
    ...diff.tables.map((t): AlterChange => ({ kind: 'table', name: t.name, op: t.op })),
    ...diff.views.map((v): AlterChange => ({ kind: 'view', name: v.name, op: v.op })),
    ...diff.routines.map((r): AlterChange => ({ kind: r.kind, name: r.name, op: r.op })),
  ];
}
```

저장하는 `defaults` 는 core 가 MySQL 표기로 맞춘 값(`result.defaults`, 예: `utf8` → `utf8mb3`)이다.

- [ ] **Step 7: 라우트와 한도를 더한다**

`apps/server/src/limits.ts` 끝에:

```ts
// ALTER 적용 스크립트 (JSON 문자열). 본문 한도는 이스케이프로 늘어나는 만큼 여유를 둔다
export const MAX_ALTER_SCRIPT = 1_000_000;
export const ALTER_BODY_LIMIT = 4 * 1024 * 1024;
```

`apps/server/src/routes/versions.ts`:

- import 를 더한다:
  - `z` from 'zod'
  - `AppError` from '../errors'
  - `ALTER_BODY_LIMIT`, `MAX_ALTER_SCRIPT` from '../limits'
  - `NoteSchema`, `SafeFilename` from '../schemas'
  - `loadDerivation` from '../repos/derivations'
  - `applyAlter` from '../services/alter'
  - `getVersionMeta` 를 '../repos/versions' import 에 추가
- 파일 위쪽(함수 밖)에 둔다:

```ts
const CharsetName = z.string().regex(/^\w{1,64}$/, '문자셋·콜레이션 이름은 영문·숫자·_ 만 쓸 수 있습니다');
const AlterBody = z.object({
  script: z.string().min(1, '스크립트가 비어 있습니다').max(MAX_ALTER_SCRIPT, `스크립트는 ${MAX_ALTER_SCRIPT}자 이하여야 합니다`),
  filename: SafeFilename.optional(),
  note: NoteSchema.optional(),
  dryRun: z.boolean().optional(),
  defaults: z.object({ charset: CharsetName.optional(), collation: CharsetName.optional() }).optional(),
});
```

- `versionRoutes` 안에 두 라우트를 더한다. 권한은 본문을 읽기 전(onRequest)에 확인한다:

```ts
  app.post('/versions/:id/alter', { onRequest: requireEditor, bodyLimit: ALTER_BODY_LIMIT }, async (req) => {
    const { id } = IdParams.parse(req.params);
    return applyAlter(ctx.db, { baseId: id, ...AlterBody.parse(req.body), userId: req.user!.id });
  });

  app.get('/versions/:id/derivation', { onRequest: requireLogin }, async (req) => {
    const { id } = IdParams.parse(req.params);
    getVersionMeta(ctx.db, id); // 없는 버전은 404
    const derivation = loadDerivation(ctx.db, id);
    if (!derivation) throw new AppError(404, 'ALTER 적용으로 만든 버전이 아닙니다');
    return derivation;
  });
```

- [ ] **Step 8: 재판정에 파생 버전 규칙을 넣는다**

`apps/server/src/services/evidence-backfill.ts`:
- import 에 `loadStaleReason` (repos/evidence)와 `loadDerivation` (repos/derivations)을 더한다.
- `judgeVersion` 의 마지막 두 줄(`const staleReason = …` 과 `saveEvidence(…, staleReason);`) 사이에 넣는다:

```ts
  const derivation = loadDerivation(db, versionId);
  if (derivation) {
    // ALTER 적용 버전: 원문(출력한 덤프)에는 늘 헤더·트레일러가 있어 원문 판정은 항상 complete 다 — 기준 버전의 판정을 물려받는다.
    // 기준이 stale 이면 이 버전도 stale 이다 (기준 모델에 스크립트를 적용했으므로). 기준이 지워졌으면 저장된 판정을 유지한다.
    // 기준은 id 가 더 작아 먼저 판정된다
    const baseId = derivation.baseVersionId;
    const inherited = (baseId === null ? loadEvidence(db, versionId) : loadEvidence(db, baseId)) ?? NO_SOURCE;
    const baseStale = baseId === null ? undefined : loadStaleReason(db, baseId);
    saveEvidence(db, versionId, inherited, 'backfill', staleReason ?? (baseStale ? `기준 버전 v${derivation.baseVersionNo} 이 예전 파서로 저장된 모델입니다 — ${STALE_MODEL_REASON}` : null));
    return;
  }
```

Run: `npx vitest run test/alter.test.ts` — Expected: PASS
Run: `npm test -w @tdm/server` — Expected: 전부 PASS (user_version 9). 기존 `judge-rev.test.ts` 스냅샷은 바뀌지 않아야 한다 (파서를 바꾸지 않았다)

- [ ] **Step 9: 서버 README 의 API 표를 갱신하고 커밋한다**

`apps/server/README.md` 의 API 표(`| DELETE | \`/versions/:id\` | admin, dba |` 행 근처)에 두 행을 더한다:

```markdown
| POST | `/versions/:id/alter` (JSON: `script`, `filename?`, `note?`, `dryRun?`, `defaults?: { charset?, collation? }` — SQL 출처 버전에 ALTER 스크립트를 적용해 새 버전을 만든다. `dryRun` 은 저장하지 않고 변경 목록만) | admin, dba |
| GET | `/versions/:id/derivation` (ALTER 적용으로 만든 버전의 기준 버전·스크립트) | login |
```

Run: `npm run typecheck` (루트) — Expected: 오류 없음

```bash
git add apps/server/src/db/migrations/009_version_derivations.sql apps/server/src/repos/derivations.ts apps/server/src/repos/renames.ts apps/server/src/repos/versions.ts apps/server/src/services/alter.ts apps/server/src/services/ingest.ts apps/server/src/services/evidence-backfill.ts apps/server/src/routes/versions.ts apps/server/src/limits.ts apps/server/README.md apps/server/test/alter.test.ts apps/server/test/db.test.ts apps/server/test/backup.test.ts apps/server/test/evidence.test.ts
git commit -m "feat(server): ALTER 적용 API — 미리보기·저장(td-export 형식 원문, 기준 판정 상속, rename 매핑)·파생 버전 재판정 (migration 009)"
```

---

### Task 11: 웹 — ALTER 적용 대화상자와 이력 배지

**Files:**
- Create: `apps/web/src/features/alter/AlterDialog.tsx`
- Modify: `apps/web/src/api/types.ts`, `apps/web/src/api/hooks.ts`, `apps/web/src/pages/HistoryPage.tsx`
- Test: `apps/web/test/alter-dialog.test.tsx`

**Interfaces:**
- Consumes: Task 10 의 API (`POST /api/versions/:id/alter`, `GET /api/versions/:id/derivation`, `VersionSummary.derivedFrom`)
- Produces:
  - `AlterDialog({ versions: VersionSummary[]; onClose: () => void })`
  - 훅: `useApplyAlter()`, `useDerivation(id?)`
  - 타입: `DerivedFrom`, `AlterChange`, `AlterRequest`, `AlterResponse`, `Derivation`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`apps/web/test/alter-dialog.test.tsx`:

```tsx
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { VersionSummary } from '../src/api/types';
import { AlterDialog } from '../src/features/alter/AlterDialog';
import { HistoryPage } from '../src/pages/HistoryPage';
import { mockApi, renderWithProviders } from './render';

const version = (id: number, versionNo: number, sourceFormat: 'sql' | 'md', extra: Partial<VersionSummary> = {}): VersionSummary => ({
  id, schemaId: 7, databaseId: 1, databaseName: 'db', schemaName: 'shop', versionNo, sourceFormat, sourceFilename: `shop-v${versionNo}.${sourceFormat}`,
  note: null, uploadedBy: 'admin', uploadedAt: '2026-10-13T00:00:00.000Z', changedObjects: 1, ...extra,
});
const DERIVED = { baseVersionNo: 1, statementCount: 1, defaults: { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' } };

describe('AlterDialog', () => {
  it('SQL 버전만 기준으로 고르고(기본: 최신), 미리보기 뒤에만 저장한다 — 스키마 기본값은 마지막 ALTER 적용 값', async () => {
    const calls = mockApi({
      'POST /api/versions/3/alter': (init: RequestInit) => (JSON.parse(String(init.body)).dryRun
        ? { status: 'preview', applied: 1, changes: [{ kind: 'table', name: 'member', op: 'modify' }], renames: [] }
        : { status: 'ok', versionId: 4, versionNo: 4, applied: 1, changes: [{ kind: 'table', name: 'member', op: 'modify' }] }),
    });
    renderWithProviders(<AlterDialog versions={[version(9, 4, 'md'), version(3, 3, 'sql', { derivedFrom: DERIVED }), version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    expect(within(screen.getByLabelText('기준 버전')).getAllByRole('option').map((o) => o.textContent)).toEqual(['v3 · shop-v3.sql', 'v1 · shop-v1.sql']);
    expect(screen.getByLabelText('스키마 기본 콜레이션')).toHaveValue('utf8mb4_general_ci');
    const save = screen.getByRole('button', { name: '저장' });
    await user.type(screen.getByLabelText('ALTER 스크립트'), 'ALTER TABLE member ADD COLUMN nick VARCHAR(20);');
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    const results = await screen.findByRole('list', { name: '미리보기 결과' });
    expect(within(results).getByText('member')).toBeInTheDocument();
    expect(save).toBeEnabled();
    await user.click(save);
    expect(await screen.findByText('v4 생성')).toBeInTheDocument();
    const bodies = calls.filter((c) => c.url === '/api/versions/3/alter').map((c) => JSON.parse(String(c.init.body)));
    expect(bodies).toEqual([
      { script: 'ALTER TABLE member ADD COLUMN nick VARCHAR(20);', dryRun: true, defaults: { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' } },
      { script: 'ALTER TABLE member ADD COLUMN nick VARCHAR(20);', dryRun: false, defaults: { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' } },
    ]);
  });

  it('실패하면 서버 메시지(문장 번호·줄)를 보여 주고, 스크립트를 고치면 미리보기를 지운다', async () => {
    const fail = () => new Response(JSON.stringify({ error: '1번째 문장 (줄 1): 컬럼 `id` 이 두 번 있습니다 (MySQL 1060)' }), { status: 400, headers: { 'content-type': 'application/json' } });
    mockApi({ 'POST /api/versions/1/alter': fail });
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('ALTER 스크립트'), 'ALTER TABLE member ADD id INT;');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('1번째 문장 (줄 1)');
    await user.type(screen.getByLabelText('ALTER 스크립트'), ' ');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('HistoryPage — ALTER 적용', () => {
  it('editor 에게 ALTER 적용 버튼, 파생 버전에는 기준 배지와 스크립트 보기', async () => {
    mockApi({
      '/api/auth/me': { id: 3, username: 'park', role: 'dba' },
      '/api/schemas/7': { id: 7, name: 'shop', databaseId: 1, databaseName: 'db' },
      '/api/schemas/7/versions': [version(12, 2, 'sql', { derivedFrom: DERIVED }), version(11, 1, 'sql')],
      '/api/versions/12/derivation': { baseVersionId: 11, baseVersionNo: 1, script: 'ALTER TABLE member ADD age INT;', statementCount: 1, defaults: DERIVED.defaults },
    });
    renderWithProviders(<HistoryPage />, { route: '/db/1/schema/7/history', path: '/db/:dbId/schema/:schemaId/history' });
    const user = userEvent.setup();
    expect(await screen.findByRole('button', { name: 'ALTER 적용' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'ALTER 적용 (기준 v1)' }));
    expect(await screen.findByText('ALTER TABLE member ADD age INT;')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'ALTER 적용' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'ALTER 적용' })).toBeInTheDocument());
  });
});
```

Run: `npx vitest run test/alter-dialog.test.tsx` (in `apps/web`) — Expected: FAIL (모듈 없음)

- [ ] **Step 2: 타입과 훅을 더한다**

`apps/web/src/api/types.ts`:
- `VersionMeta` 에 `derivedFrom?: DerivedFrom;` 를 더한다.
- 파일에 덧붙인다:

```ts
// ALTER 적용으로 만든 버전 (서버 009)
export interface DerivedFrom {
  baseVersionNo: number;
  statementCount: number;
  defaults: { charset: string; collation: string };
}

export interface AlterChange {
  kind: 'table' | 'view' | 'function' | 'procedure';
  name: string;
  op: 'add' | 'drop' | 'modify' | 'rename';
}

export interface AlterRequest {
  script: string;
  filename?: string;
  note?: string;
  dryRun?: boolean;
  defaults?: { charset?: string; collation?: string };
}

export type AlterResponse =
  | { status: 'preview'; applied: number; changes: AlterChange[]; renames: RenameMapping[] }
  | { status: 'ok' | 'duplicate'; versionId: number; versionNo: number; applied: number; changes: AlterChange[] };

export interface Derivation {
  baseVersionId: number | null;
  baseVersionNo: number;
  script: string;
  statementCount: number;
  defaults: { charset: string; collation: string };
}
```

`apps/web/src/api/hooks.ts`:
- import 할 타입에 `AlterRequest`, `AlterResponse`, `Derivation` 을 더한다.
- `CATALOG_CACHE_KEYS` 배열에 `['derivation']` 을 더한다.
- `useDeleteVersion` 의 `onSuccess` 에 `client.removeQueries({ queryKey: ['derivation'] });` 를 더한다.
- 덧붙인다:

```ts
// ALTER 스크립트 적용 (미리보기는 저장하지 않으므로 캐시를 건드리지 않는다)
export function useApplyAlter() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { baseId: number; body: AlterRequest }) => api<AlterResponse>(`/versions/${input.baseId}/alter`, { method: 'POST', json: input.body }),
    onSuccess: (data) => {
      if (data.status === 'preview') return;
      client.invalidateQueries({ queryKey: queryKeys.tree });
      client.invalidateQueries({ queryKey: ['versions'] });
      client.invalidateQueries({ queryKey: ['object-history'] });
    },
  });
}

export const useDerivation = (id?: number) =>
  useQuery({ queryKey: ['derivation', id] as const, queryFn: () => api<Derivation>(`/versions/${id}/derivation`), enabled: id !== undefined, staleTime: Infinity });
```

- [ ] **Step 3: AlterDialog 를 만든다**

`apps/web/src/features/alter/AlterDialog.tsx`:

```tsx
import { useRef, useState } from 'react';
import { useApplyAlter } from '../../api/hooks';
import type { AlterChange, AlterRequest, AlterResponse, VersionSummary } from '../../api/types';
import { Icon } from '../../components/Icon';
import { trapTab, useDialogFocus } from '../../hooks/useDialog';
import s from '../upload/UploadDialog.module.css';

const MYSQL_DEFAULTS = { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' };
const OP_TEXT: Record<AlterChange['op'], string> = { add: '추가', drop: '삭제', modify: '변경', rename: '이름 변경' };
const KIND_TEXT: Record<AlterChange['kind'], string> = { table: '테이블', view: '뷰', function: '함수', procedure: '프로시저' };

// 스키마의 SQL 버전에 ALTER 스크립트를 적용해 새 버전을 만든다 (미리보기 → 저장). versions: 최신 버전이 앞
export function AlterDialog({ versions, onClose }: { versions: VersionSummary[]; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, onClose);
  const candidates = versions.filter((v) => v.sourceFormat === 'sql');
  const last = versions.find((v) => v.derivedFrom)?.derivedFrom?.defaults ?? MYSQL_DEFAULTS;
  const [baseId, setBaseId] = useState(candidates[0]?.id);
  const [script, setScript] = useState('');
  const [filename, setFilename] = useState<string>();
  const [note, setNote] = useState('');
  const [charset, setCharset] = useState(last.charset);
  const [collation, setCollation] = useState(last.collation);
  const [result, setResult] = useState<AlterResponse>();
  const alter = useApplyAlter();
  // 입력이 바뀌면 이전 미리보기·오류는 더 이상 맞지 않는다
  const edited = () => {
    setResult(undefined);
    alter.reset();
  };
  const submit = (dryRun: boolean) => {
    if (baseId === undefined) return;
    const body: AlterRequest = { script, dryRun, defaults: { charset: charset.trim(), collation: collation.trim() }, ...(filename ? { filename } : {}), ...(note.trim() ? { note: note.trim() } : {}) };
    alter.mutate({ baseId, body }, { onSuccess: setResult });
  };
  const ready = baseId !== undefined && script.trim().length > 0 && !alter.isPending;
  const saved = result && result.status !== 'preview' ? result : undefined;
  return (
    <div className={s.backdrop} role="presentation" onClick={onClose}>
      <div ref={dialogRef} className={s.dialog} role="dialog" aria-modal="true" aria-labelledby="alter-title" onClick={(e) => e.stopPropagation()} onKeyDown={trapTab}>
        <header className={s.head}>
          <h2 id="alter-title">ALTER 적용</h2>
          <button type="button" className={s.iconBtn} aria-label="닫기" onClick={onClose}><Icon name="x" /></button>
        </header>
        {candidates.length === 0 && <p className={s.warn}>SQL 덤프로 올린 버전이 없습니다 — MD 버전에는 ALTER 를 적용할 수 없습니다</p>}
        <fieldset className={s.row} aria-label="기준 버전과 스키마 기본값">
          <label>기준 버전
            <select value={baseId} aria-label="기준 버전" onChange={(e) => { setBaseId(Number(e.target.value)); edited(); }}>
              {candidates.map((v) => <option key={v.id} value={v.id}>v{v.versionNo} · {v.sourceFilename}</option>)}
            </select>
          </label>
          <label>스키마 기본 문자셋<input value={charset} aria-label="스키마 기본 문자셋" onChange={(e) => { setCharset(e.target.value); edited(); }} /></label>
          <label>스키마 기본 콜레이션<input value={collation} aria-label="스키마 기본 콜레이션" onChange={(e) => { setCollation(e.target.value); edited(); }} /></label>
          <label>메모<input value={note} maxLength={500} aria-label="메모" onChange={(e) => setNote(e.target.value)} /></label>
        </fieldset>
        <label className={s.drop}>
          <Icon name="upload" size={20} />
          <span>.sql 파일을 고르거나 아래에 스크립트를 붙여 넣으세요</span>
          <input type="file" accept=".sql" aria-label="스크립트 파일" className="visually-hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setScript(await file.text());
              setFilename(file.name);
              edited();
            }} />
        </label>
        <textarea className="mono" rows={10} spellCheck={false} aria-label="ALTER 스크립트" value={script} placeholder="ALTER TABLE member ADD COLUMN nick VARCHAR(20);"
          onChange={(e) => { setScript(e.target.value); setFilename(undefined); edited(); }} />
        <p className={s.warnLine}>
          받는 문장: ALTER·CREATE·DROP·RENAME TABLE, CREATE·DROP INDEX, CREATE·DROP FUNCTION·PROCEDURE, DROP VIEW. VIEW·CHECK·생성 컬럼·식 기본값·파티션·문자셋 변환은 td-export 로 다시 뽑아 올려 주세요.
          이 도구는 MySQL 의 모든 검사를 재현하지 않아, 실제 DB 에서는 거부될 스크립트를 받을 수 있습니다.
        </p>
        {result?.status === 'preview' && (
          <ul className={s.results} aria-label="미리보기 결과">
            <li className={s.ok}><b>문장 {result.applied}개 적용</b> <span>변경 객체 {result.changes.length}개</span></li>
            {result.changes.map((c) => <li key={`${c.kind}:${c.name}`}>{KIND_TEXT[c.kind]} <span className="mono">{c.name}</span> {OP_TEXT[c.op]}</li>)}
          </ul>
        )}
        {saved && <p role="status" className={s.ok}>{saved.status === 'ok' ? `v${saved.versionNo} 생성` : `v${saved.versionNo}와 내용이 같습니다`}</p>}
        {alter.error && <p role="alert" className={s.warn}>{alter.error.message}</p>}
        <footer className={s.foot}>
          <button type="button" className={s.btn} onClick={onClose}>닫기</button>
          <button type="button" className={s.btn} disabled={!ready} onClick={() => submit(true)}>미리보기</button>
          <button type="button" className={`${s.btn} ${s.primary}`} disabled={!ready || result?.status !== 'preview'} onClick={() => submit(false)}>저장</button>
        </footer>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: HistoryPage 에 버튼·배지·스크립트 보기를 넣는다**

`apps/web/src/pages/HistoryPage.tsx`:
- import 를 더한다:
  - `Fragment`, `useState` from 'react'
  - `useDerivation` 을 hooks import 에 추가
  - `import { AlterDialog } from '../features/alter/AlterDialog';`
- 컴포넌트 안에 상태 두 개를 둔다:

```tsx
  const [alterOpen, setAlterOpen] = useState(false);
  const [scriptOf, setScriptOf] = useState<number>();
```

- editor 버튼 줄(`<div className={s.row}>` 안, `Schema 삭제` 버튼 앞)에 넣는다:

```tsx
          {list.some((v) => v.sourceFormat === 'sql') && <button type="button" className={s.btn} onClick={() => setAlterOpen(true)}>ALTER 적용</button>}
```

- 행을 `Fragment` 로 감싼다.
  - `<tr key={v.id}>` 를 `<Fragment key={v.id}><tr>` 로, 그 행의 `</tr>` 를 `</tr>…</Fragment>` 로 바꾼다.
  - 형식 칸을 다음으로 바꾼다:

```tsx
                  <td>
                    {v.sourceFormat.toUpperCase()}
                    {v.derivedFrom && (
                      <button type="button" className={s.btn} aria-expanded={scriptOf === v.id} onClick={() => setScriptOf(scriptOf === v.id ? undefined : v.id)}>
                        ALTER 적용 (기준 v{v.derivedFrom.baseVersionNo})
                      </button>
                    )}
                  </td>
```

  - 행의 `</tr>` 바로 뒤(`</Fragment>` 앞)에 넣는다:

```tsx
                {scriptOf === v.id && <tr><td colSpan={8}><DerivationScript id={v.id} /></td></tr>}
```

- `</section>` 바로 앞에 `{alterOpen && <AlterDialog versions={list} onClose={() => setAlterOpen(false)} />}` 를 넣는다.
- 파일 끝에 덧붙인다:

```tsx
// ALTER 적용으로 만든 버전의 스크립트 원문
function DerivationScript({ id }: { id: number }) {
  const derivation = useDerivation(id);
  if (derivation.error) return <p role="alert" className={s.error}>{derivation.error.message}</p>;
  if (!derivation.data) return <p className={s.empty}>불러오는 중…</p>;
  return <pre className="mono">{derivation.data.script}</pre>;
}
```

Run: `npx vitest run test/alter-dialog.test.tsx test/pages.test.tsx` — Expected: PASS
Run: `npm test -w @tdm/web && npm run typecheck -w @tdm/web` — Expected: PASS

- [ ] **Step 5: 브라우저에서 확인하고 커밋한다**

Run: `npm run build` (루트), 서버를 띄운다(`COOKIE_SECURE=false npm start`, 이미 떠 있으면 재시작). 브라우저에서 아래를 확인한다.
- SQL 버전이 있는 스키마의 버전 이력에 **ALTER 적용** 버튼이 보인다.
- 미리보기 → 저장 → 새 버전과 `ALTER 적용 (기준 vN)` 배지 → 스크립트 보기가 동작한다.
- 저장한 버전을 기준 버전과 비교하면 rename 이 DROP+ADD 가 아니라 rename 으로 보인다.

```bash
git add apps/web/src/features/alter/AlterDialog.tsx apps/web/src/api/types.ts apps/web/src/api/hooks.ts apps/web/src/pages/HistoryPage.tsx apps/web/test/alter-dialog.test.tsx
git commit -m "feat(web): ALTER 적용 대화상자 — 기준 버전·스키마 기본값·미리보기·저장, 이력의 기준 배지와 스크립트 보기"
```

---

### Task 12: 문서와 마무리 검증

**Files:**
- Modify: `README.md`, `README.ko.md` (기능 목록), `docs/superpowers/specs/2026-10-13-alter-apply-design.md` (상태 줄)

- [ ] **Step 1: README 에 기능을 한 줄씩 더한다**

`README.md` 의 기능 목록에 더한다:

```markdown
- **Apply ALTER scripts**: paste or upload an ALTER script against a stored SQL version to create the next version without re-exporting (columns, indexes, foreign keys, table options, CREATE/DROP/RENAME TABLE, routines; results are verified against real MySQL 8.0/8.4 in CI).
```

`README.ko.md` 의 기능 목록에 더한다:

```markdown
- **ALTER 적용**: 저장된 SQL 버전에 ALTER 스크립트를 붙여 넣거나 올려 td-export 를 다시 뽑지 않고 다음 버전을 만든다 (컬럼·인덱스·FK·테이블 옵션·CREATE/DROP/RENAME TABLE·루틴. 결과는 CI 에서 실제 MySQL 8.0/8.4 와 비교해 검증한다).
```

- [ ] **Step 2: 스펙 상태를 바꾼다**

스펙 첫머리의 `상태:` 줄을 `상태: 구현 완료 (2026-10-13, 계획 docs/superpowers/plans/2026-10-13-alter-apply.md)` 로 바꾼다. 편집한 .md 마다 한 줄이 자기 내용을 두 번 이어 붙인 꼴이 아닌지 확인한다:

```bash
python3 -c "import sys
for p in sys.argv[1:]:
  L=open(p,encoding='utf-8').read().split('\n'); print(p, sum(1 for l in L if l.strip() and len(l)%2==0 and l[:len(l)//2]==l[len(l)//2:]))" README.md README.ko.md docs/superpowers/specs/2026-10-13-alter-apply-design.md
```

Expected: 모두 0

- [ ] **Step 3: 전체 검증**

Run (저장소 루트):

```bash
npm test && npm run typecheck && npm run build
npm run test:mysql -w @tdm/core
docker compose -f packages/core/docker-compose.test.yml down
```

Expected: 모두 PASS. 기존 골든 66개 `expected.sql` 과 픽스처는 바뀌지 않았다 (`git diff --stat main -- packages/core/test/fixtures/scenarios` 가 비어 있어야 한다).

제어 문자 검사:

```bash
git diff --name-only main | xargs grep -lP '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' || echo 'clean'
```

Expected: `clean`

- [ ] **Step 4: 커밋**

```bash
git add README.md README.ko.md docs/superpowers/specs/2026-10-13-alter-apply-design.md
git commit -m "docs: ALTER 적용 기능 안내"
```

