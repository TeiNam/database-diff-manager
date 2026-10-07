# Core 엔진 (파서·프린터·diff·DDL) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** td-export의 `.sql`/`.md` 출력을 스키마 모델로 파싱하고, 두 모델의 차이와 그 차이를 만드는 MySQL 8.0/8.4 DDL을 생성하는 순수 TypeScript 패키지 `@tdm/core`를 만든다.

**Architecture:** 파이프라인은 `lexer → cursor → parse-table / parse-view / parse-dump / parse-md → model → print → diff → ddl` 순서다. 모든 모듈은 I/O 없는 순수 함수라서 서버(Node)와 브라우저(Vite)가 같은 소스를 쓴다. 빌드 단계 없이 `.ts` 소스를 그대로 export한다. 정확성은 세 겹으로 검증한다: 실데이터 왕복 테스트(`print(parse(x)) === normalize(x)`), 골든 DDL 테스트, 실제 MySQL 8.0/8.4 컨테이너 실증 테스트.

**Tech Stack:** Node.js 22, TypeScript(strict), npm workspaces, vitest. 실증 테스트에만 `mysql2`와 Docker Compose를 쓴다.

**Spec:** `docs/superpowers/specs/2026-10-07-table-diff-manager-design.md` (4장 `core` 패키지, 8장 테스트)

## Global Constraints

- 대상 DB: MySQL 8.0 / 8.4 (5.7 미지원). DDL은 8.0 문법(`RENAME COLUMN`, `RENAME INDEX`, `ALTER INDEX … VISIBLE`)을 사용한다.
- `packages/core/src`는 런타임 의존성 0개이며 `node:` 모듈을 import하지 않는다(브라우저 공유). `node:fs`는 테스트 코드에서만 허용한다.
- diff에서 제외: 테이블 옵션 `AUTO_INCREMENT=N`, 뷰 `DEFINER`, 정수 표시 폭(`int(11)`, 단 `tinyint(1)`과 `zerofill`은 유지).
- 식별자는 항상 백틱으로 인용하고 내부 백틱은 이중화한다(`quoteIdent`). 문자열은 MySQL `SHOW CREATE` 규칙으로 인용한다(`quoteString`: `'`→`''`, `\`→`\\`, 개행→`\n`).
- 변수·함수명은 영어, 주석·에러 메시지는 한국어.
- 커밋 메시지: `<type>: <설명>` (feat/test/chore …), 본문은 한국어.
- 브랜치: 작업 시작 전 `git switch -c feat/core-engine`.
- 파일은 800줄 미만, 함수는 50줄 미만을 목표로 한다.

## File Structure

```
package.json                         워크스페이스 루트
tsconfig.base.json                   공통 TS 설정
packages/core/
  package.json                       @tdm/core (src/index.ts를 그대로 export)
  tsconfig.json
  docker-compose.test.yml            MySQL 8.0 / 8.4 (Task 8)
  src/
    index.ts                         공개 API 재export
    lexer.ts                         tokenize, quoteIdent, quoteString
    cursor.ts                        Cursor(토큰 탐색), splitTopLevel, ParseError, lineOf
    model.ts                         스키마 모델 타입
    normalize.ts                     normalizeType, normalizeDdl
    parse-table.ts                   parseCreateTable (컬럼·인덱스·FK·CHECK·옵션·파티션)
    parse-view.ts                    parseCreateView
    parse-dump.ts                    splitStatements, parseSqlDump (+왕복 검증)
    parse-md.ts                      parseMdDump
    print.ts                         printTable, printColumn, printIndex, printView …
    canonical.ts                     canonicalJson (키 정렬 JSON, 해시·비교용)
    diff.ts                          diffSchemas, diffTable, 타입, rename 후보, lcs
    partition-ddl.ts                 partitionStatements, listPartitionStatements
    ddl.ts                           generateDdl, renderDdl
  test/
    helpers.ts                       fixture(), sample(), scenario()
    lexer.test.ts  parse-table.test.ts  parse-dump.test.ts  print.test.ts
    canonical.test.ts  diff.test.ts  partition-ddl.test.ts  ddl.test.ts  parse-md.test.ts
    mysql.int.test.ts                실증 테스트 (MYSQL_IT=1일 때만)
    fixtures/
      parse-table.sql  view.sql  md/basic.md
      scenarios/<name>/{base.sql,target.sql,expected.sql,renames.json?}
```

시나리오 이름: `columns`, `tables`, `rename-table`, `rename-column`, `partitions`, `order-view`, `mysql8`.

---

### Task 1: 워크스페이스 + 렉서

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `packages/core/package.json`, `packages/core/tsconfig.json`
- Create: `packages/core/src/lexer.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/lexer.test.ts`

**Interfaces:**
- Produces:
  - `type TokenType = 'ident' | 'string' | 'number' | 'word' | 'op'`
  - `interface Token { t: TokenType; v: string; s: number; e: number }`: `v`는 디코딩된 값, `s`/`e`는 원문 오프셋 `[s, e)`
  - `tokenize(src: string): Token[]`: `/*!NNNNN`·`*/` 버전 주석 표식은 버리고 내용은 토큰으로 남긴다. 일반 주석은 버린다.
  - `quoteIdent(name: string): string`, `quoteString(value: string): string`
  - `class LexError extends Error`

- [ ] **Step 1: 브랜치와 워크스페이스 파일 생성**

```bash
git switch -c feat/core-engine
mkdir -p packages/core/src packages/core/test/fixtures
```

`package.json`:
```json
{
  "name": "table-diff-manager",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "test": "npm test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

`packages/core/package.json`:
```json
{
  "name": "@tdm/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p ."
  }
}
```

`packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test"]
}
```

설치:
```bash
npm install -D -w @tdm/core typescript vitest @types/node
```

- [ ] **Step 2: 실패하는 테스트 작성**

`packages/core/test/lexer.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { quoteIdent, quoteString, tokenize } from '../src/lexer';

describe('tokenize', () => {
  it('식별자·문자열·단어·숫자·기호를 구분한다', () => {
    const toks = tokenize("`a``b` 'it''s' DEFAULT 10 (");
    expect(toks.map((t) => [t.t, t.v])).toEqual([
      ['ident', 'a`b'],
      ['string', "it's"],
      ['word', 'DEFAULT'],
      ['number', '10'],
      ['op', '('],
    ]);
  });

  it('버전 주석 표식은 버리고 내용은 토큰으로 남긴다', () => {
    const toks = tokenize('KEY `k` (`c`) /*!80000 INVISIBLE */');
    expect(toks.map((t) => t.v)).toEqual(['KEY', 'k', '(', 'c', ')', 'INVISIBLE']);
  });

  it('일반 주석은 건너뛴다', () => {
    expect(tokenize('/* Table : x */ CREATE -- 끝\n').map((t) => t.v)).toEqual(['CREATE']);
  });

  it('백슬래시 이스케이프를 디코딩한다', () => {
    expect(tokenize("'a\\nb\\\\c'")[0].v).toBe('a\nb\\c');
  });

  it('토큰 오프셋으로 원문을 복원할 수 있다', () => {
    const src = "COMMENT '한글, 쉼표'";
    const str = tokenize(src)[1];
    expect(src.slice(str.s, str.e)).toBe("'한글, 쉼표'");
  });

  it('닫히지 않은 문자열은 오류', () => {
    expect(() => tokenize("'abc")).toThrow(/닫히지 않은 따옴표/);
  });
});

describe('quote', () => {
  it('MySQL SHOW CREATE 규칙으로 인용한다', () => {
    expect(quoteIdent('a`b')).toBe('`a``b`');
    expect(quoteString("it's\n\\")).toBe("'it''s\\n\\\\'");
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npm test -w @tdm/core`
Expected: FAIL. `Failed to resolve import "../src/lexer"`

- [ ] **Step 4: 구현**

`packages/core/src/lexer.ts`:
```ts
// SQL 텍스트를 토큰으로 나눈다. MySQL SHOW CREATE 출력 형식을 대상으로 한다.
export type TokenType = 'ident' | 'string' | 'number' | 'word' | 'op';

export interface Token {
  t: TokenType;
  v: string; // 디코딩된 값 (따옴표·이스케이프 제거)
  s: number; // 원문 시작 오프셋
  e: number; // 원문 끝 오프셋 (exclusive)
}

export class LexError extends Error {}

const WORD_START = /[A-Za-z_$\u0080-\uFFFF]/;
const WORD_CHAR = /[A-Za-z0-9_$\u0080-\uFFFF]/;
const DIGIT = /[0-9]/;
const ESCAPES: Record<string, string> = { '0': '\0', n: '\n', r: '\r', t: '\t', Z: '\x1a', b: '\b' };

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let versioned = 0; // 열려 있는 /*!NNNNN 주석 수
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (src.startsWith('/*!', i)) {
      i += 3;
      while (i < src.length && DIGIT.test(src[i])) i++;
      versioned++;
      continue;
    }
    if (versioned > 0 && src.startsWith('*/', i)) { i += 2; versioned--; continue; }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new LexError(`닫히지 않은 주석 (위치 ${i})`);
      i = end + 2;
      continue;
    }
    if (src.startsWith('-- ', i) || c === '#') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === '`' || c === "'" || c === '"') {
      const [v, e] = readQuoted(src, i, c);
      out.push({ t: c === '`' ? 'ident' : 'string', v, s: i, e });
      i = e;
      continue;
    }
    if (DIGIT.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ t: 'number', v: src.slice(i, j), s: i, e: j });
      i = j;
      continue;
    }
    if (WORD_START.test(c)) {
      let j = i;
      while (j < src.length && WORD_CHAR.test(src[j])) j++;
      out.push({ t: 'word', v: src.slice(i, j), s: i, e: j });
      i = j;
      continue;
    }
    out.push({ t: 'op', v: c, s: i, e: i + 1 });
    i++;
  }
  return out;
}

function readQuoted(src: string, start: number, quote: string): [string, number] {
  let value = '';
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === quote) {
      if (src[i + 1] === quote) { value += quote; i += 2; continue; }
      return [value, i + 1];
    }
    if (c === '\\' && quote !== '`') {
      const n = src[i + 1] ?? '';
      value += ESCAPES[n] ?? n;
      i += 2;
      continue;
    }
    value += c;
    i++;
  }
  throw new LexError(`닫히지 않은 따옴표 (위치 ${start})`);
}

export function quoteIdent(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

// SHOW CREATE TABLE의 문자열 인용 규칙 (sql_show.cc append_unescaped)
export function quoteString(value: string): string {
  const body = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\0/g, '\\0')
    .replace(/\x1a/g, '\\Z');
  return `'${body}'`;
}
```

`packages/core/src/index.ts`:
```ts
export * from './lexer';
```

- [ ] **Step 5: 통과 확인**

Run: `npm test -w @tdm/core && npm run typecheck -w @tdm/core`
Expected: PASS (7 tests), 타입 오류 없음

- [ ] **Step 6: 커밋**

```bash
git add package.json package-lock.json tsconfig.base.json packages/core
git commit -m "feat: core 워크스페이스와 SQL 렉서 추가"
```

---

### Task 2: 모델 + Cursor + CREATE TABLE 파서

**Files:**
- Create: `packages/core/src/model.ts`, `packages/core/src/cursor.ts`, `packages/core/src/normalize.ts`, `packages/core/src/parse-table.ts`
- Create: `packages/core/test/helpers.ts`, `packages/core/test/fixtures/parse-table.sql`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/parse-table.test.ts`

**Interfaces:**
- Consumes: `tokenize`, `Token` (Task 1)
- Produces:
  - 아래 `model.ts`의 모든 타입. 이후 모든 Task가 이 이름을 그대로 쓴다.
  - `class Cursor` (`i`, `toks`, `src`, `done`, `peek`, `next`, `isWord`, `acceptWord`, `expectWord`, `isOp`, `acceptOp`, `expectOp`, `ident`, `string`, `closeParen`, `parenTokens`, `parenRaw`, `valueRaw`, `error`)
  - `splitTopLevel(toks: Token[]): Token[][]`, `class ParseError`, `lineOf(src, pos): number`
  - `normalizeType(raw: string): string`
  - `parseCreateTable(ddl: string): Table`: 실패 시 `ParseError`를 던진다.

- [ ] **Step 1: 모델 타입 작성** (타입만 있는 파일이라 테스트 없음)

`packages/core/src/model.ts`:
```ts
// 스키마 모델. 'unknown' 목록에 있는 속성은 출처(MD)에서 알 수 없으므로 diff에서 건너뛴다.
export type Fidelity = 'full' | 'partial';

export type ColumnField = 'charset' | 'collation' | 'default' | 'onUpdate' | 'generated' | 'invisible' | 'srid';

export interface Column {
  name: string;
  type: string; // 정규화된 타입 원문: 'varchar(32)', 'int unsigned', "enum('a','b')"
  charset?: string; // DDL에 명시된 경우만
  collation?: string;
  generated?: { expr: string; stored: boolean }; // expr은 바깥 괄호 안쪽 원문
  nullable: boolean;
  srid?: number;
  invisible: boolean;
  default?: string; // SQL 원문: "NULL", "'0'", "CURRENT_TIMESTAMP", "(uuid())". undefined = DEFAULT 절 없음
  onUpdate?: string;
  autoIncrement: boolean;
  comment?: string; // 디코딩된 값
  unknown?: ColumnField[];
}

export type IndexKind = 'PRIMARY' | 'UNIQUE' | 'INDEX' | 'FULLTEXT' | 'SPATIAL';
export type IndexField = 'kind' | 'partDetails' | 'partOrder' | 'using' | 'parser' | 'comment' | 'invisible';

export interface IndexPart {
  column?: string;
  expr?: string; // 함수형 키 파트: ((expr))의 안쪽
  length?: number; // prefix 길이
  desc: boolean;
}

export interface Index {
  name: string; // PK는 'PRIMARY'
  kind: IndexKind;
  parts: IndexPart[];
  using?: string;
  parser?: string;
  comment?: string;
  invisible: boolean;
  unknown?: IndexField[];
}

export interface ForeignKey {
  name: string;
  columns: string[];
  refSchema?: string;
  refTable: string;
  refColumns: string[];
  onDelete?: string; // undefined = 기본(RESTRICT/NO ACTION)
  onUpdate?: string;
}

export interface Check {
  name: string;
  expr: string; // CHECK (...)의 안쪽
  enforced: boolean;
}

export interface TableOption {
  key: string; // 'ENGINE', 'DEFAULT CHARSET', 'COLLATE', 'ROW_FORMAT', 'COMMENT' …
  value: string; // SQL 원문 ('InnoDB', "'주문'")
}

export interface PartitionDef {
  name: string;
  def: string; // 이름 뒤 원문: "VALUES LESS THAN (202511) COMMENT = '…' ENGINE = InnoDB"
}

export interface Partitioning {
  version: string; // /*!50100 의 숫자
  clause: string; // 'PARTITION BY …' 전체 원문 (출력용)
  method: string; // 'RANGE', 'RANGE COLUMNS', 'HASH', 'LINEAR KEY' … (대문자)
  expr: string; // 분할 표현식 (괄호 안쪽 원문)
  count?: number; // PARTITIONS n
  partitions: PartitionDef[];
}

export type TableField = 'checks' | 'partition';

export interface Table {
  kind: 'table';
  name: string;
  columns: Column[];
  indexes: Index[];
  foreignKeys: ForeignKey[];
  checks: Check[];
  options: TableOption[];
  partition?: Partitioning;
  fidelity: Fidelity;
  unknown?: TableField[];
  comparableOptions?: string[]; // partial 출처에서 비교 가능한 옵션 키. undefined = 전부 비교
  parseError?: string;
  rawDdl?: string; // 파싱 실패 또는 왕복 불일치 시 정규화된 원문
}

export interface View {
  kind: 'view';
  name: string;
  algorithm?: string;
  security?: string;
  checkOption?: string; // 'CASCADED' | 'LOCAL'
  columnList?: string; // VIEW `v` (…) 의 안쪽 원문
  body: string; // AS 뒤 SELECT 원문
  fidelity: Fidelity;
  parseError?: string;
  rawDdl?: string;
}

export interface SchemaModel {
  name: string;
  tables: Table[];
  views: View[];
}
```

- [ ] **Step 2: 테스트 도우미와 픽스처 작성**

`packages/core/test/helpers.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export const fixture = (rel: string): string => readFileSync(path(`./fixtures/${rel}`), 'utf8');
export const hasFixture = (rel: string): boolean => existsSync(path(`./fixtures/${rel}`));

// 실데이터 샘플 (td-export 0.1.10, sample-app 스키마 33개 테이블)
export const sample = (kind: 'sql' | 'md'): string =>
  readFileSync(
    path(kind === 'sql' ? '../../../samples/v1/sample-app(10.0.0.15).sql' : '../../../samples/v1/sample-app.md'),
    'utf8',
  );
```

`packages/core/test/fixtures/parse-table.sql` (끝에 `;` 없음, `FULLTEXT` 줄 끝의 ` */ ,`는 MySQL 실제 출력 형태):
```sql
CREATE TABLE `chat_history` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'PK',
  `conv` char(18) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL COMMENT '대화, 세션',
  `n` int(11) DEFAULT NULL,
  `flag` tinyint(1) NOT NULL DEFAULT '0',
  `kind` enum('a','b,c') NOT NULL DEFAULT 'a',
  `b` int GENERATED ALWAYS AS ((`n` * 2)) VIRTUAL,
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `update_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`,`create_at`),
  UNIQUE KEY `uk_conv` (`conv`(10)),
  KEY `ix_user` (`n`,`create_at` DESC) COMMENT 'idx',
  KEY `ix_fn` ((lower(`conv`))) /*!80000 INVISIBLE */,
  FULLTEXT KEY `ft` (`conv`) /*!50100 WITH PARSER `ngram` */ ,
  CONSTRAINT `fk_u` FOREIGN KEY (`n`) REFERENCES `other`.`users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_n` CHECK ((`n` > 0)) /*!80016 NOT ENFORCED */
) ENGINE=InnoDB AUTO_INCREMENT=31 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='AI 챗봇'
/*!50100 PARTITION BY RANGE (((year(`create_at`) * 100) + month(`create_at`)))
(PARTITION p202510 VALUES LESS THAN (202511) COMMENT = '2025년 10월' ENGINE = InnoDB,
 PARTITION pmax VALUES LESS THAN MAXVALUE ENGINE = InnoDB) */
```

- [ ] **Step 3: 실패하는 테스트 작성**

`packages/core/test/parse-table.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseCreateTable } from '../src/parse-table';
import { fixture } from './helpers';

const table = parseCreateTable(fixture('parse-table.sql'));
const col = (name: string) => table.columns.find((c) => c.name === name)!;
const idx = (name: string) => table.indexes.find((i) => i.name === name)!;

describe('parseCreateTable: 컬럼', () => {
  it('이름과 순서를 유지한다', () => {
    expect(table.name).toBe('chat_history');
    expect(table.columns.map((c) => c.name)).toEqual(['id', 'conv', 'n', 'flag', 'kind', 'b', 'create_at', 'update_at']);
  });

  it('속성을 해석한다', () => {
    expect(col('id')).toMatchObject({ type: 'int unsigned', nullable: false, autoIncrement: true, comment: 'PK' });
    expect(col('conv')).toMatchObject({ type: 'char(18)', charset: 'utf8mb4', collation: 'utf8mb4_general_ci', comment: '대화, 세션' });
    expect(col('flag')).toMatchObject({ type: 'tinyint(1)', default: "'0'" });
    expect(col('kind').type).toBe("enum('a','b,c')");
    expect(col('b').generated).toEqual({ expr: '(`n` * 2)', stored: false });
    expect(col('update_at')).toMatchObject({ type: 'datetime(3)', default: 'CURRENT_TIMESTAMP(3)', onUpdate: 'CURRENT_TIMESTAMP(3)' });
  });

  it('정수 표시 폭은 제거한다 (tinyint(1) 제외)', () => {
    expect(col('n')).toMatchObject({ type: 'int', nullable: true, default: 'NULL' });
  });
});

describe('parseCreateTable: 인덱스·제약', () => {
  it('인덱스 종류와 순서', () => {
    expect(table.indexes.map((i) => [i.kind, i.name])).toEqual([
      ['PRIMARY', 'PRIMARY'],
      ['UNIQUE', 'uk_conv'],
      ['INDEX', 'ix_user'],
      ['INDEX', 'ix_fn'],
      ['FULLTEXT', 'ft'],
    ]);
  });

  it('키 파트: prefix, DESC, 함수형, 옵션', () => {
    expect(idx('PRIMARY').parts).toEqual([{ column: 'id', desc: false }, { column: 'create_at', desc: false }]);
    expect(idx('uk_conv').parts).toEqual([{ column: 'conv', length: 10, desc: false }]);
    expect(idx('ix_user')).toMatchObject({ parts: [{ column: 'n', desc: false }, { column: 'create_at', desc: true }], comment: 'idx' });
    expect(idx('ix_fn')).toMatchObject({ parts: [{ expr: 'lower(`conv`)', desc: false }], invisible: true });
    expect(idx('ft').parser).toBe('ngram');
  });

  it('FK와 CHECK', () => {
    expect(table.foreignKeys).toEqual([
      { name: 'fk_u', columns: ['n'], refSchema: 'other', refTable: 'users', refColumns: ['id'], onDelete: 'CASCADE' },
    ]);
    expect(table.checks).toEqual([{ name: 'chk_n', expr: '(`n` > 0)', enforced: false }]);
  });
});

describe('parseCreateTable: 옵션·파티션', () => {
  it('AUTO_INCREMENT를 뺀 옵션을 순서대로 보존한다', () => {
    expect(table.options).toEqual([
      { key: 'ENGINE', value: 'InnoDB' },
      { key: 'DEFAULT CHARSET', value: 'utf8mb4' },
      { key: 'COLLATE', value: 'utf8mb4_general_ci' },
      { key: 'COMMENT', value: "'AI 챗봇'" },
    ]);
  });

  it('파티션을 구조화한다', () => {
    expect(table.partition).toMatchObject({
      version: '50100',
      method: 'RANGE',
      expr: '((year(`create_at`) * 100) + month(`create_at`))',
      partitions: [
        { name: 'p202510', def: "VALUES LESS THAN (202511) COMMENT = '2025년 10월' ENGINE = InnoDB" },
        { name: 'pmax', def: 'VALUES LESS THAN MAXVALUE ENGINE = InnoDB' },
      ],
    });
    expect(table.partition!.clause.startsWith('PARTITION BY RANGE')).toBe(true);
    expect(table.partition!.clause.endsWith('ENGINE = InnoDB)')).toBe(true);
  });
});

describe('parseCreateTable: 오류', () => {
  it('알 수 없는 컬럼 속성은 줄 번호와 함께 실패한다', () => {
    expect(() => parseCreateTable('CREATE TABLE `x` (\n  `a` int NOT NULL FOO\n)')).toThrow("알 수 없는 컬럼 속성 'FOO' (줄 2)");
  });
});
```

- [ ] **Step 4: 실패 확인**

Run: `npm test -w @tdm/core -- parse-table`
Expected: FAIL. `Failed to resolve import "../src/parse-table"`

- [ ] **Step 5: Cursor 구현**

`packages/core/src/cursor.ts`:
```ts
// 토큰 배열 위를 움직이는 파서 도우미
import type { Token } from './lexer';

export class ParseError extends Error {}

export function lineOf(src: string, pos: number): number {
  return src.slice(0, pos).split('\n').length;
}

export class Cursor {
  i = 0;

  constructor(readonly toks: Token[], readonly src: string) {}

  get done(): boolean {
    return this.i >= this.toks.length;
  }

  peek(offset = 0): Token | undefined {
    return this.toks[this.i + offset];
  }

  next(): Token {
    const t = this.toks[this.i];
    if (!t) throw this.error('예상치 못한 끝');
    this.i++;
    return t;
  }

  // 연속된 단어가 모두 일치하는지 (대소문자 무시)
  isWord(...words: string[]): boolean {
    return words.every((w, k) => {
      const t = this.peek(k);
      return t?.t === 'word' && t.v.toUpperCase() === w;
    });
  }

  acceptWord(...words: string[]): boolean {
    if (!this.isWord(...words)) return false;
    this.i += words.length;
    return true;
  }

  expectWord(...words: string[]): void {
    if (!this.acceptWord(...words)) throw this.error(`${words.join(' ')} 필요`);
  }

  isOp(v: string): boolean {
    const t = this.peek();
    return t?.t === 'op' && t.v === v;
  }

  acceptOp(v: string): boolean {
    if (!this.isOp(v)) return false;
    this.i++;
    return true;
  }

  expectOp(v: string): void {
    if (!this.acceptOp(v)) throw this.error(`'${v}' 필요`);
  }

  ident(): string {
    const t = this.next();
    if (t.t !== 'ident' && t.t !== 'word') throw this.error('식별자 필요', t);
    return t.v;
  }

  string(): string {
    const t = this.next();
    if (t.t !== 'string') throw this.error('문자열 필요', t);
    return t.v;
  }

  // '(' 를 이미 소비한 상태에서 짝이 맞는 ')' 까지 소비하고 그 토큰을 반환
  closeParen(): Token {
    let depth = 1;
    for (;;) {
      const t = this.next();
      if (t.t !== 'op') continue;
      if (t.v === '(') depth++;
      else if (t.v === ')' && --depth === 0) return t;
    }
  }

  // 괄호 블록을 소비하고 안쪽 토큰을 반환
  parenTokens(): Token[] {
    this.expectOp('(');
    const start = this.i;
    this.closeParen();
    return this.toks.slice(start, this.i - 1);
  }

  // 괄호 블록을 소비하고 안쪽 원문을 반환
  parenRaw(): string {
    const open = this.peek();
    this.expectOp('(');
    const close = this.closeParen();
    return this.src.slice(open!.e, close.s).trim();
  }

  // 값 하나의 원문: 리터럴, 단어, 괄호식, CURRENT_TIMESTAMP(3), b'0'
  valueRaw(): string {
    const first = this.next();
    let last = first;
    if (first.t === 'op' && first.v === '(') {
      last = this.closeParen();
    } else {
      const n = this.peek();
      const adjacent = n !== undefined && n.s === first.e;
      if (adjacent && n.t === 'string') last = this.next();
      else if (adjacent && n.t === 'op' && n.v === '(') { this.i++; last = this.closeParen(); }
    }
    return this.src.slice(first.s, last.e);
  }

  error(message: string, at: Token | undefined = this.peek()): ParseError {
    return new ParseError(`${message} (줄 ${at ? lineOf(this.src, at.s) : '끝'})`);
  }
}

// 괄호 깊이 0의 쉼표로 토큰을 나눈다
export function splitTopLevel(toks: Token[]): Token[][] {
  const out: Token[][] = [];
  let cur: Token[] = [];
  let depth = 0;
  for (const t of toks) {
    if (t.t === 'op') {
      if (t.v === '(') depth++;
      else if (t.v === ')') depth--;
      else if (t.v === ',' && depth === 0) {
        out.push(cur);
        cur = [];
        continue;
      }
    }
    cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}
```

- [ ] **Step 6: normalizeType 구현**

`packages/core/src/normalize.ts`:
```ts
// diff 노이즈를 없애는 정규화 규칙은 이 파일에만 둔다

const INT_WIDTH = /^(tinyint|smallint|mediumint|int|bigint)\((\d+)\)/i;

// 정수 표시 폭 제거 (8.0.19+ 출력과 맞춤). tinyint(1)과 zerofill은 유지
export function normalizeType(raw: string): string {
  const type = raw.trim();
  if (/\bzerofill\b/i.test(type)) return type;
  return type.replace(INT_WIDTH, (m, base: string, width: string) =>
    base.toLowerCase() === 'tinyint' && width === '1' ? m : base,
  );
}
```

- [ ] **Step 7: CREATE TABLE 파서 구현**

`packages/core/src/parse-table.ts`:
```ts
// SHOW CREATE TABLE 출력 → Table 모델
import { Cursor, splitTopLevel } from './cursor';
import { tokenize } from './lexer';
import type { Check, Column, ForeignKey, Index, IndexKind, IndexPart, PartitionDef, Partitioning, Table } from './model';
import { normalizeType } from './normalize';

// 컬럼 타입이 끝나고 속성이 시작됨을 알리는 단어
const COLUMN_ATTRS = new Set([
  'CHARACTER', 'CHARSET', 'COLLATE', 'GENERATED', 'AS', 'NOT', 'NULL', 'DEFAULT', 'ON', 'AUTO_INCREMENT',
  'COMMENT', 'INVISIBLE', 'VISIBLE', 'SRID', 'COLUMN_FORMAT', 'STORAGE', 'VIRTUAL', 'STORED',
  'PRIMARY', 'UNIQUE', 'KEY', 'CHECK', 'REFERENCES',
]);

const REF_ACTIONS = [['SET', 'NULL'], ['SET', 'DEFAULT'], ['NO', 'ACTION'], ['CASCADE'], ['RESTRICT']];

export function parseCreateTable(ddl: string): Table {
  const toks = tokenize(ddl);
  if (toks.at(-1)?.v === ';') toks.pop();
  const c = new Cursor(toks, ddl);
  c.expectWord('CREATE');
  c.acceptWord('TEMPORARY');
  c.expectWord('TABLE');
  c.acceptWord('IF', 'NOT', 'EXISTS');
  const table: Table = {
    kind: 'table', name: c.ident(), columns: [], indexes: [], foreignKeys: [], checks: [], options: [], fidelity: 'full',
  };
  for (const item of splitTopLevel(c.parenTokens())) parseItem(new Cursor(item, ddl), table);
  parseTail(c, table);
  return table;
}

function parseItem(c: Cursor, t: Table): void {
  if (c.peek()?.t === 'ident') { t.columns.push(parseColumn(c)); return; }
  if (c.acceptWord('PRIMARY', 'KEY')) { t.indexes.push(parseIndex(c, 'PRIMARY', 'PRIMARY')); return; }
  const kind = indexKind(c);
  if (kind) { t.indexes.push(parseIndex(c, kind, c.ident())); return; }
  if (c.acceptWord('CONSTRAINT')) {
    const name = c.ident();
    if (c.acceptWord('FOREIGN', 'KEY')) { t.foreignKeys.push(parseForeignKey(c, name)); return; }
    if (c.acceptWord('CHECK')) { t.checks.push(parseCheck(c, name)); return; }
  }
  throw c.error('알 수 없는 테이블 요소');
}

function parseColumn(c: Cursor): Column {
  const name = c.ident();
  const typeStart = c.peek();
  if (!typeStart) throw c.error('컬럼 타입 필요');
  let typeEnd = typeStart;
  while (!c.done) {
    const t = c.peek()!;
    if (t.t === 'word' && COLUMN_ATTRS.has(t.v.toUpperCase())) break;
    if (t.t === 'op' && t.v === '(') { c.next(); typeEnd = c.closeParen(); continue; }
    typeEnd = c.next();
  }
  const col: Column = {
    name, type: normalizeType(c.src.slice(typeStart.s, typeEnd.e)), nullable: true, invisible: false, autoIncrement: false,
  };
  while (!c.done) parseColumnAttr(c, col);
  return col;
}

function parseColumnAttr(c: Cursor, col: Column): void {
  if (c.acceptWord('CHARACTER', 'SET') || c.acceptWord('CHARSET')) col.charset = c.next().v;
  else if (c.acceptWord('COLLATE')) col.collation = c.next().v;
  else if (c.acceptWord('GENERATED', 'ALWAYS', 'AS') || c.acceptWord('AS')) {
    const expr = c.parenRaw();
    const stored = c.acceptWord('STORED');
    if (!stored) c.acceptWord('VIRTUAL');
    col.generated = { expr, stored };
  } else if (c.acceptWord('NOT', 'NULL')) col.nullable = false;
  else if (c.acceptWord('NULL')) col.nullable = true;
  else if (c.acceptWord('SRID')) col.srid = Number(c.next().v);
  else if (c.acceptWord('INVISIBLE')) col.invisible = true;
  else if (c.acceptWord('VISIBLE')) col.invisible = false;
  else if (c.acceptWord('DEFAULT')) col.default = c.valueRaw();
  else if (c.acceptWord('ON', 'UPDATE')) col.onUpdate = c.valueRaw();
  else if (c.acceptWord('AUTO_INCREMENT')) col.autoIncrement = true;
  else if (c.acceptWord('COMMENT')) col.comment = c.string();
  else throw c.error(`알 수 없는 컬럼 속성 '${c.peek()!.v}'`);
}

function indexKind(c: Cursor): IndexKind | undefined {
  if (c.acceptWord('KEY') || c.acceptWord('INDEX')) return 'INDEX';
  for (const kind of ['UNIQUE', 'FULLTEXT', 'SPATIAL'] as const) {
    if (c.acceptWord(kind)) {
      if (!c.acceptWord('KEY')) c.acceptWord('INDEX');
      return kind;
    }
  }
  return undefined;
}

function parseIndex(c: Cursor, kind: IndexKind, name: string): Index {
  const index: Index = { name, kind, parts: parseIndexParts(c), invisible: false };
  while (!c.done) {
    if (c.acceptWord('USING')) index.using = c.next().v.toUpperCase();
    else if (c.acceptWord('WITH', 'PARSER')) index.parser = c.ident();
    else if (c.acceptWord('COMMENT')) index.comment = c.string();
    else if (c.acceptWord('INVISIBLE')) index.invisible = true;
    else if (c.acceptWord('VISIBLE')) index.invisible = false;
    else throw c.error(`알 수 없는 인덱스 옵션 '${c.peek()!.v}'`);
  }
  return index;
}

function parseIndexParts(c: Cursor): IndexPart[] {
  return splitTopLevel(c.parenTokens()).map((toks) => {
    const p = new Cursor(toks, c.src);
    const part: IndexPart = { desc: false };
    if (p.isOp('(')) part.expr = p.parenRaw();
    else {
      part.column = p.ident();
      if (p.isOp('(')) part.length = Number(p.parenRaw());
    }
    if (p.acceptWord('DESC')) part.desc = true;
    else p.acceptWord('ASC');
    if (!p.done) throw p.error('알 수 없는 키 파트');
    return part;
  });
}

function identList(c: Cursor): string[] {
  return splitTopLevel(c.parenTokens()).map((toks) => {
    if (toks.length !== 1) throw c.error('식별자 목록 필요', toks[0]);
    return toks[0].v;
  });
}

function parseForeignKey(c: Cursor, name: string): ForeignKey {
  const columns = identList(c);
  c.expectWord('REFERENCES');
  let refTable = c.ident();
  let refSchema: string | undefined;
  if (c.acceptOp('.')) { refSchema = refTable; refTable = c.ident(); }
  const fk: ForeignKey = { name, columns, refTable, refColumns: identList(c) };
  if (refSchema) fk.refSchema = refSchema;
  while (!c.done) {
    if (c.acceptWord('ON', 'DELETE')) fk.onDelete = refAction(c);
    else if (c.acceptWord('ON', 'UPDATE')) fk.onUpdate = refAction(c);
    else throw c.error('알 수 없는 FK 옵션');
  }
  return fk;
}

function refAction(c: Cursor): string {
  for (const words of REF_ACTIONS) if (c.acceptWord(...words)) return words.join(' ');
  throw c.error('참조 동작 필요');
}

function parseCheck(c: Cursor, name: string): Check {
  const expr = c.parenRaw();
  const enforced = !c.acceptWord('NOT', 'ENFORCED');
  c.acceptWord('ENFORCED');
  if (!c.done) throw c.error('알 수 없는 CHECK 옵션');
  return { name, expr, enforced };
}

// ')' 뒤: 테이블 옵션과 파티션 절
function parseTail(c: Cursor, t: Table): void {
  while (!c.done && !c.isWord('PARTITION', 'BY')) {
    const key: string[] = [];
    while (c.peek()?.t === 'word' && !c.isWord('PARTITION', 'BY')) key.push(c.next().v.toUpperCase());
    if (!key.length) throw c.error('테이블 옵션 필요');
    c.acceptOp('='); // TABLESPACE `x` 처럼 '=' 없는 형식 허용
    const value = c.valueRaw();
    if (key.join(' ') !== 'AUTO_INCREMENT') t.options.push({ key: key.join(' '), value });
  }
  if (!c.done) t.partition = parsePartition(c);
}

function parsePartition(c: Cursor): Partitioning {
  const first = c.peek()!;
  const last = c.toks[c.toks.length - 1];
  const version = /\/\*!(\d+)\s*$/.exec(c.src.slice(0, first.s))?.[1] ?? '50100';
  c.expectWord('PARTITION', 'BY');
  const method: string[] = [];
  while (!c.done && !c.isOp('(')) method.push(c.next().v.toUpperCase());
  const p: Partitioning = {
    version, clause: c.src.slice(first.s, last.e), method: method.join(' '), expr: c.parenRaw(), partitions: [],
  };
  if (c.acceptWord('PARTITIONS')) p.count = Number(c.next().v);
  while (!c.done) {
    if (c.isOp('(') && c.peek(1)?.t === 'word' && c.peek(1)!.v.toUpperCase() === 'PARTITION') p.partitions = parsePartitionList(c);
    else if (c.isOp('(')) c.parenTokens(); // SUBPARTITION BY … (expr) 는 clause에만 보존
    else c.next();
  }
  return p;
}

function parsePartitionList(c: Cursor): PartitionDef[] {
  return splitTopLevel(c.parenTokens()).map((toks) => {
    const pc = new Cursor(toks, c.src);
    pc.expectWord('PARTITION');
    const name = pc.ident();
    const rest = pc.peek();
    return { name, def: rest ? c.src.slice(rest.s, toks[toks.length - 1].e) : '' };
  });
}
```

`packages/core/src/index.ts`에 추가:
```ts
export * from './cursor';
export * from './model';
export * from './normalize';
export * from './parse-table';
```

- [ ] **Step 8: 통과 확인**

Run: `npm test -w @tdm/core && npm run typecheck -w @tdm/core`
Expected: PASS, 타입 오류 없음

- [ ] **Step 9: 커밋**

```bash
git add packages/core
git commit -m "feat: SHOW CREATE TABLE 파서와 스키마 모델 추가"
```

---

### Task 3: 뷰 파서 + 덤프 분할 (실데이터 33개 테이블)

**Files:**
- Create: `packages/core/src/parse-view.ts`, `packages/core/src/parse-dump.ts`, `packages/core/test/fixtures/view.sql`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/parse-dump.test.ts`

**Interfaces:**
- Consumes: `Cursor`, `tokenize`, `parseCreateTable`, `normalizeDdl`(Task 4에서 추가되므로 이 Task에서는 쓰지 않음), 모델 타입
- Produces:
  - `parseCreateView(ddl: string): View`
  - `interface ParseWarning { object: string; line: number; message: string }`
  - `interface ParsedDump { model: SchemaModel; warnings: ParseWarning[] }`
  - `splitStatements(text: string): { ddl: string; line: number }[]`: `;` 기준 분할. 앞쪽 주석은 제외하고 `;`도 포함하지 않는다.
  - `parseSqlDump(text: string): ParsedDump`: 객체 하나가 실패해도 계속 진행하고, 실패한 객체는 `parseError`·`rawDdl`로 남긴다.

- [ ] **Step 1: 픽스처와 실패하는 테스트 작성**

`packages/core/test/fixtures/view.sql`:
```sql
CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v_daily` AS select `o`.`id` AS `id` from `orders` `o` WITH CASCADED CHECK OPTION
```

`packages/core/test/parse-dump.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseSqlDump, splitStatements } from '../src/parse-dump';
import { parseCreateView } from '../src/parse-view';
import { fixture, sample } from './helpers';

describe('parseCreateView', () => {
  it('옵션과 본문을 나누고 DEFINER는 버린다', () => {
    expect(parseCreateView(fixture('view.sql'))).toEqual({
      kind: 'view',
      name: 'v_daily',
      algorithm: 'UNDEFINED',
      security: 'DEFINER',
      checkOption: 'CASCADED',
      body: 'select `o`.`id` AS `id` from `orders` `o`',
      fidelity: 'full',
    });
  });
});

describe('splitStatements', () => {
  it('문자열 안의 ;는 무시하고 앞쪽 주석은 제외한다', () => {
    const text = "/* Database : s */\n/* Table : a */\nCREATE TABLE `a` (`x` int COMMENT 'a;b');\n\n/* Table : b */\nCREATE TABLE `b` (`y` int);\n";
    expect(splitStatements(text)).toEqual([
      { ddl: "CREATE TABLE `a` (`x` int COMMENT 'a;b')", line: 3 },
      { ddl: 'CREATE TABLE `b` (`y` int)', line: 6 },
    ]);
  });
});

describe('parseSqlDump', () => {
  it('실패한 객체만 parseError로 남기고 나머지는 계속 파싱한다', () => {
    const text = '/* Database : s */\nCREATE TABLE `bad` (`a` int NOT NULL FOO);\nCREATE TABLE `ok` (`b` int);\n';
    const { model, warnings } = parseSqlDump(text);
    expect(model.name).toBe('s');
    expect(model.tables.map((t) => [t.name, Boolean(t.parseError)])).toEqual([['bad', true], ['ok', false]]);
    expect(model.tables[0].rawDdl).toContain('FOO');
    expect(warnings).toEqual([{ object: 'bad', line: 2, message: "알 수 없는 컬럼 속성 'FOO' (줄 1)" }]);
  });

  it('뷰를 구분한다', () => {
    const { model } = parseSqlDump(fixture('view.sql') + ';');
    expect(model.views.map((v) => v.name)).toEqual(['v_daily']);
  });

  it('실데이터 샘플 33개 테이블을 오류 없이 파싱한다', () => {
    const { model } = parseSqlDump(sample('sql'));
    expect(model.name).toBe('sample-app');
    expect(model.tables).toHaveLength(33);
    expect(model.tables.filter((t) => t.parseError).map((t) => [t.name, t.parseError])).toEqual([]);
    expect(model.tables.filter((t) => t.partition)).toHaveLength(6);
    const chat = model.tables.find((t) => t.name === 'chat_history')!;
    expect(chat.partition!.partitions.at(-1)!.name).toBe('pmax');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @tdm/core -- parse-dump`
Expected: FAIL. `Failed to resolve import "../src/parse-dump"`

- [ ] **Step 3: 구현**

`packages/core/src/parse-view.ts`:
```ts
// SHOW CREATE VIEW 출력 → View 모델 (DEFINER는 비교 대상이 아니므로 버린다)
import { Cursor } from './cursor';
import { tokenize } from './lexer';
import type { View } from './model';

const CHECK_OPTION = /\s+WITH\s+(?:(CASCADED|LOCAL)\s+)?CHECK\s+OPTION$/i;

export function parseCreateView(ddl: string): View {
  const c = new Cursor(tokenize(ddl), ddl);
  c.expectWord('CREATE');
  c.acceptWord('OR', 'REPLACE');
  const view: View = { kind: 'view', name: '', body: '', fidelity: 'full' };
  while (!c.isWord('VIEW')) {
    if (c.acceptWord('ALGORITHM')) { c.expectOp('='); view.algorithm = c.next().v.toUpperCase(); }
    else if (c.acceptWord('DEFINER')) { c.expectOp('='); c.next(); if (c.acceptOp('@')) c.next(); }
    else if (c.acceptWord('SQL', 'SECURITY')) view.security = c.next().v.toUpperCase();
    else throw c.error('알 수 없는 뷰 옵션');
  }
  c.expectWord('VIEW');
  view.name = c.ident();
  if (c.isOp('(')) view.columnList = c.parenRaw();
  c.expectWord('AS');
  const start = c.peek();
  if (!start) throw c.error('뷰 본문 없음');
  let body = ddl.slice(start.s).trim().replace(/;$/, '').trimEnd();
  const m = CHECK_OPTION.exec(body);
  if (m) {
    view.checkOption = (m[1] ?? 'CASCADED').toUpperCase();
    body = body.slice(0, m.index);
  }
  return { ...view, body };
}
```

`packages/core/src/parse-dump.ts`:
```ts
// td-export SQL 파일 → SchemaModel
import { lineOf } from './cursor';
import { tokenize, type Token } from './lexer';
import type { SchemaModel } from './model';
import { parseCreateTable } from './parse-table';
import { parseCreateView } from './parse-view';

export interface ParseWarning {
  object: string;
  line: number;
  message: string;
}

export interface ParsedDump {
  model: SchemaModel;
  warnings: ParseWarning[];
}

const VIEW_RE = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:ALGORITHM\s*=\s*\w+\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:SQL\s+SECURITY\s+\w+\s+)?VIEW\b/i;
const NAME_RE = /\b(?:TABLE|VIEW)\s+`((?:[^`]|``)+)`/i;
const DATABASE_RE = /\/\*\s*Database\s*:\s*(.+?)\s*\*\//;

export function splitStatements(text: string): { ddl: string; line: number }[] {
  const out: { ddl: string; line: number }[] = [];
  let start: Token | undefined;
  for (const t of tokenize(text)) {
    if (t.t === 'op' && t.v === ';') {
      if (start) out.push({ ddl: text.slice(start.s, t.s).trim(), line: lineOf(text, start.s) });
      start = undefined;
      continue;
    }
    start ??= t;
  }
  if (start) out.push({ ddl: text.slice(start.s).trim(), line: lineOf(text, start.s) });
  return out;
}

export function parseSqlDump(text: string): ParsedDump {
  const clean = text.replace(/^\uFEFF/, '');
  const model: SchemaModel = { name: DATABASE_RE.exec(clean)?.[1] ?? '', tables: [], views: [] };
  const warnings: ParseWarning[] = [];
  for (const { ddl, line } of splitStatements(clean)) {
    const isView = VIEW_RE.test(ddl);
    const object = NAME_RE.exec(ddl)?.[1].replace(/``/g, '`') ?? '(unknown)';
    try {
      if (isView) model.views.push(parseCreateView(ddl));
      else model.tables.push(parseCreateTable(ddl));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      warnings.push({ object, line, message });
      const failed = { name: object, fidelity: 'full' as const, parseError: message, rawDdl: ddl };
      if (isView) model.views.push({ kind: 'view', body: '', ...failed });
      else model.tables.push({ kind: 'table', columns: [], indexes: [], foreignKeys: [], checks: [], options: [], ...failed });
    }
  }
  return { model, warnings };
}
```

`packages/core/src/index.ts`에 추가:
```ts
export * from './parse-dump';
export * from './parse-view';
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @tdm/core && npm run typecheck -w @tdm/core`
Expected: PASS. 실데이터 테스트가 실패하면 `parseError` 메시지(테이블명, 줄 번호)를 보고 파서를 고친다. 테스트 기대값은 바꾸지 않는다.

- [ ] **Step 5: 커밋**

```bash
git add packages/core
git commit -m "feat: 뷰 파서와 td-export SQL 덤프 파서 추가"
```

---

### Task 4: 프린터 + normalizeDdl + 왕복 검증

**Files:**
- Create: `packages/core/src/print.ts`
- Modify: `packages/core/src/normalize.ts` (normalizeDdl 추가), `packages/core/src/parse-dump.ts` (왕복 검증), `packages/core/src/index.ts`
- Test: `packages/core/test/print.test.ts`

**Interfaces:**
- Consumes: 모델 타입, `quoteIdent`, `quoteString`, `parseCreateTable`, `parseCreateView`, `parseSqlDump`
- Produces:
  - `normalizeDdl(ddl: string): string`
  - `printColumn(c: Column, versioned?: boolean): string`: `versioned=false`이면 `/*!80023 INVISIBLE */` 대신 `INVISIBLE`을 쓴다(ALTER용).
  - `printIndexParts(parts: IndexPart[]): string`, `printIndex(i: Index): string`
  - `printForeignKey(f: ForeignKey): string`, `printCheck(c: Check, versioned?: boolean): string`
  - `printTable(t: Table, opts?: { foreignKeys?: boolean }): string`: `;` 없이 `SHOW CREATE TABLE` 형식으로 출력한다.
  - `printView(v: View, opts?: { orReplace?: boolean }): string`
  - 이 Task부터 `parseSqlDump`는 왕복 불일치 객체에 경고를 남기고 `rawDdl`(정규화본)을 채운다.

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/core/test/print.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { normalizeDdl } from '../src/normalize';
import { parseSqlDump } from '../src/parse-dump';
import { parseCreateTable } from '../src/parse-table';
import { parseCreateView } from '../src/parse-view';
import { printColumn, printTable, printView } from '../src/print';
import { fixture, sample } from './helpers';

describe('normalizeDdl', () => {
  it('AUTO_INCREMENT=N, 정수 표시 폭, 줄 끝 공백, 끝 세미콜론을 제거한다', () => {
    const ddl = 'CREATE TABLE `t` (\n  `a` int(11) NOT NULL,\n  `b` tinyint(1) NOT NULL,\n  `c` int(10) unsigned zerofill \n) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4;';
    expect(normalizeDdl(ddl)).toBe(
      'CREATE TABLE `t` (\n  `a` int NOT NULL,\n  `b` tinyint(1) NOT NULL,\n  `c` int(10) unsigned zerofill\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    );
  });

  it('뷰 DEFINER를 제거한다', () => {
    expect(normalizeDdl('CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v` AS select 1')).toBe(
      'CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v` AS select 1',
    );
  });
});

describe('print 왕복', () => {
  it('테이블: print(parse(x)) === normalize(x)', () => {
    const ddl = fixture('parse-table.sql');
    expect(printTable(parseCreateTable(ddl))).toBe(normalizeDdl(ddl));
  });

  it('뷰: print(parse(x)) === normalize(x)', () => {
    const ddl = fixture('view.sql');
    expect(printView(parseCreateView(ddl))).toBe(normalizeDdl(ddl));
  });

  it('실데이터 33개 테이블 모두 왕복이 일치한다', () => {
    const { warnings } = parseSqlDump(sample('sql'));
    expect(warnings).toEqual([]);
  });

  it('왕복 불일치는 경고와 rawDdl로 남긴다', () => {
    // TABLESPACE 는 '=' 없이 출력되어 재출력 형식이 다르다
    const { model, warnings } = parseSqlDump('CREATE TABLE `t` (\n  `a` int\n) TABLESPACE `ts`;');
    expect(warnings.map((w) => w.object)).toEqual(['t']);
    expect(model.tables[0].rawDdl).toBe('CREATE TABLE `t` (\n  `a` int\n) TABLESPACE `ts`');
  });
});

describe('printColumn', () => {
  it('ALTER용(versioned=false)은 버전 주석을 쓰지 않는다', () => {
    const col = { name: 'a', type: 'int', nullable: false, invisible: true, autoIncrement: false };
    expect(printColumn(col)).toBe('`a` int NOT NULL /*!80023 INVISIBLE */');
    expect(printColumn(col, false)).toBe('`a` int NOT NULL INVISIBLE');
  });

  it('nullable timestamp는 NULL을 명시한다', () => {
    expect(printColumn({ name: 't', type: 'timestamp', nullable: true, invisible: false, autoIncrement: false, default: 'NULL' })).toBe(
      '`t` timestamp NULL DEFAULT NULL',
    );
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @tdm/core -- print`
Expected: FAIL. `Failed to resolve import "../src/print"`

- [ ] **Step 3: normalizeDdl 구현**

`packages/core/src/normalize.ts`에 추가:
```ts
// 컬럼 줄의 정수 표시 폭: "  `col` int(11)" (zerofill 제외)
const COLUMN_INT_WIDTH = /^( {2}`(?:[^`]|``)+` )(tinyint|smallint|mediumint|int|bigint)\((\d+)\)(?!(?: unsigned)? zerofill)/gm;

// 왕복 비교와 diff 노이즈 제거를 위한 DDL 원문 정규화
export function normalizeDdl(ddl: string): string {
  return ddl
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
    .replace(/;$/, '')
    .replace(/ \*\/ ,$/gm, ' */,') // FULLTEXT … WITH PARSER 뒤 공백
    .replace(/^(\).*?) AUTO_INCREMENT=\d+/m, '$1')
    .replace(/^(CREATE (?:OR REPLACE )?(?:ALGORITHM=\w+ )?)DEFINER=\S+ /, '$1')
    .replace(COLUMN_INT_WIDTH, (m, head: string, base: string, width: string) =>
      base === 'tinyint' && width === '1' ? m : head + base,
    );
}
```

- [ ] **Step 4: 프린터 구현**

`packages/core/src/print.ts`:
```ts
// 모델 → MySQL SHOW CREATE 형식 DDL (세미콜론 없음)
import { quoteIdent as q, quoteString } from './lexer';
import type { Check, Column, ForeignKey, Index, IndexKind, IndexPart, Table, TableOption, View } from './model';
import { normalizeDdl } from './normalize';

const KEY_PREFIX: Record<IndexKind, string> = {
  PRIMARY: 'PRIMARY KEY', UNIQUE: 'UNIQUE KEY', INDEX: 'KEY', FULLTEXT: 'FULLTEXT KEY', SPATIAL: 'SPATIAL KEY',
};

// SHOW CREATE 속성 순서: 타입, 문자셋, 콜레이션, GENERATED, NULL, SRID, INVISIBLE, DEFAULT, ON UPDATE, AUTO_INCREMENT, COMMENT
export function printColumn(c: Column, versioned = true): string {
  let s = `${q(c.name)} ${c.type}`;
  if (c.charset) s += ` CHARACTER SET ${c.charset}`;
  if (c.collation) s += ` COLLATE ${c.collation}`;
  if (c.generated) s += ` GENERATED ALWAYS AS (${c.generated.expr}) ${c.generated.stored ? 'STORED' : 'VIRTUAL'}`;
  if (!c.nullable) s += ' NOT NULL';
  else if (/^timestamp\b/i.test(c.type)) s += ' NULL';
  if (c.srid !== undefined) s += versioned ? ` /*!80003 SRID ${c.srid} */` : ` SRID ${c.srid}`;
  if (c.invisible) s += versioned ? ' /*!80023 INVISIBLE */' : ' INVISIBLE';
  if (c.default !== undefined) s += ` DEFAULT ${c.default}`;
  if (c.onUpdate) s += ` ON UPDATE ${c.onUpdate}`;
  if (c.autoIncrement) s += ' AUTO_INCREMENT';
  if (c.comment !== undefined) s += ` COMMENT ${quoteString(c.comment)}`;
  return s;
}

export function printIndexParts(parts: IndexPart[]): string {
  const items = parts.map((p) => {
    const base = p.expr !== undefined ? `(${p.expr})` : q(p.column ?? '') + (p.length ? `(${p.length})` : '');
    return base + (p.desc ? ' DESC' : '');
  });
  return `(${items.join(',')})`;
}

export function printIndex(i: Index): string {
  let s = KEY_PREFIX[i.kind] + (i.kind === 'PRIMARY' ? '' : ` ${q(i.name)}`) + ` ${printIndexParts(i.parts)}`;
  if (i.using) s += ` USING ${i.using}`;
  if (i.parser) s += ` /*!50100 WITH PARSER ${q(i.parser)} */`;
  if (i.comment !== undefined) s += ` COMMENT ${quoteString(i.comment)}`;
  if (i.invisible) s += ' /*!80000 INVISIBLE */';
  return s;
}

export function printForeignKey(f: ForeignKey): string {
  const ref = (f.refSchema ? `${q(f.refSchema)}.` : '') + q(f.refTable);
  let s = `CONSTRAINT ${q(f.name)} FOREIGN KEY (${f.columns.map(q).join(', ')}) REFERENCES ${ref} (${f.refColumns.map(q).join(', ')})`;
  if (f.onDelete) s += ` ON DELETE ${f.onDelete}`;
  if (f.onUpdate) s += ` ON UPDATE ${f.onUpdate}`;
  return s;
}

export function printCheck(c: Check, versioned = true): string {
  const enforced = c.enforced ? '' : versioned ? ' /*!80016 NOT ENFORCED */' : ' NOT ENFORCED';
  return `CONSTRAINT ${q(c.name)} CHECK (${c.expr})${enforced}`;
}

const printOption = (o: TableOption): string => `${o.key}=${o.value}`;

export function printTable(t: Table, opts: { foreignKeys?: boolean } = {}): string {
  if (t.parseError && t.rawDdl) return normalizeDdl(t.rawDdl);
  const items = [
    ...t.columns.map((c) => printColumn(c)),
    ...t.indexes.map(printIndex),
    ...(opts.foreignKeys === false ? [] : t.foreignKeys.map(printForeignKey)),
    ...t.checks.map((c) => printCheck(c)),
  ];
  let s = `CREATE TABLE ${q(t.name)} (\n${items.map((x) => `  ${x}`).join(',\n')}\n)`;
  if (t.options.length) s += ` ${t.options.map(printOption).join(' ')}`;
  if (t.partition) s += `\n/*!${t.partition.version} ${t.partition.clause} */`;
  return s;
}

export function printView(v: View, opts: { orReplace?: boolean } = {}): string {
  if (v.parseError && v.rawDdl) return normalizeDdl(v.rawDdl);
  let s = opts.orReplace ? 'CREATE OR REPLACE' : 'CREATE';
  if (v.algorithm) s += ` ALGORITHM=${v.algorithm}`;
  if (v.security) s += ` SQL SECURITY ${v.security}`;
  s += ` VIEW ${q(v.name)}`;
  if (v.columnList) s += ` (${v.columnList})`;
  s += ` AS ${v.body}`;
  if (v.checkOption) s += ` WITH ${v.checkOption} CHECK OPTION`;
  return s;
}
```

- [ ] **Step 5: parseSqlDump에 왕복 검증 추가**

`packages/core/src/parse-dump.ts`. import 추가:
```ts
import type { SchemaModel, Table, View } from './model';
import { normalizeDdl } from './normalize';
import { printTable, printView } from './print';
```
(기존 `import type { SchemaModel } from './model';` 줄은 위 줄로 바꾼다)

`try` 블록의 두 줄을 아래로 바꾼다:
```ts
      if (isView) {
        const view = parseCreateView(ddl);
        model.views.push(checkRoundTrip(view, printView(view), ddl, line, warnings));
      } else {
        const table = parseCreateTable(ddl);
        model.tables.push(checkRoundTrip(table, printTable(table), ddl, line, warnings));
      }
```

`catch` 블록의 `rawDdl: ddl`을 `rawDdl: normalizeDdl(ddl)`로 바꾼다.

파일 끝에 추가:
```ts
// 재출력 결과가 원문과 다르면 경고하고, 화면에서 원문을 볼 수 있도록 rawDdl을 남긴다
function checkRoundTrip<T extends Table | View>(obj: T, printed: string, ddl: string, line: number, warnings: ParseWarning[]): T {
  const normalized = normalizeDdl(ddl);
  if (printed === normalized) return obj;
  warnings.push({ object: obj.name, line, message: '왕복 불일치: 재출력한 DDL이 원문과 다릅니다. 원문 보기로 확인하세요' });
  return { ...obj, rawDdl: normalized };
}
```

`packages/core/src/index.ts`에 추가:
```ts
export * from './print';
```

- [ ] **Step 6: 통과 확인**

Run: `npm test -w @tdm/core && npm run typecheck -w @tdm/core`
Expected: PASS. `parse-dump.test.ts`의 "실패한 객체만 parseError로 남기고…" 테스트는 `rawDdl`이 정규화본이어도 `toContain('FOO')`라서 그대로 통과한다. "실데이터 33개 테이블 모두 왕복이 일치한다"가 실패하면 `warnings`의 객체명으로 해당 테이블 DDL을 찾아 `printTable` 출력과 줄 단위로 비교하고 **프린터나 정규화를** 고친다.

- [ ] **Step 7: 커밋**

```bash
git add packages/core
git commit -m "feat: SHOW CREATE 형식 프린터와 왕복 검증 추가"
```

---

### Task 5: canonicalJson + diff 엔진

**Files:**
- Create: `packages/core/src/canonical.ts`, `packages/core/src/diff.ts`
- Create: 시나리오 픽스처 `packages/core/test/fixtures/scenarios/*/{base.sql,target.sql,renames.json}` (아래 목록)
- Modify: `packages/core/test/helpers.ts` (scenario 추가), `packages/core/src/index.ts`
- Test: `packages/core/test/canonical.test.ts`, `packages/core/test/diff.test.ts`

**Interfaces:**
- Consumes: 모델 타입, `printColumn`, `printTable`, `printView`, `parseSqlDump`
- Produces:
  - `canonicalJson(value: unknown): string`: 키를 정렬하고 `undefined` 값은 뺀다. 서버가 해시 계산에 쓴다.
  - `type Op = 'add' | 'drop' | 'modify' | 'rename'`
  - `interface Change<T> { op: Op; name: string; oldName?: string; from?: T; to?: T; fields: string[] }`
  - `interface OptionChange { key: string; from?: string; to?: string }`
  - `interface TableDiff { op: Op; name: string; oldName?: string; from?: Table; to?: Table; columns: Change<Column>[]; moved: string[]; indexes: Change<Index>[]; foreignKeys: Change<ForeignKey>[]; checks: Change<Check>[]; options: OptionChange[]; partition?: { from?: Partitioning; to?: Partitioning }; skipped: string[]; unparsed: boolean }`
  - `interface ViewDiff { op: 'add' | 'drop' | 'modify'; name: string; from?: View; to?: View; fields: string[] }`
  - `interface RenameMapping { kind: 'table' | 'column' | 'index'; table?: string; from: string; to: string }`: column/index의 `table`은 TARGET 테이블명
  - `interface SchemaDiff { tables: TableDiff[]; views: ViewDiff[]; renameCandidates: RenameMapping[]; partial: boolean }`: 변경 없는 객체는 포함하지 않는다. 순서는 BASE 순서(drop/modify/rename) 다음 TARGET에만 있는 것(add).
  - `diffSchemas(base: SchemaModel, target: SchemaModel, renames?: RenameMapping[]): SchemaDiff`
  - `lcs(a: string[], b: string[]): Set<string>`

- [ ] **Step 1: 시나리오 픽스처 작성**

`packages/core/test/fixtures/scenarios/columns/base.sql`:
```sql
/* Database : shop */
/* Table : orders */
CREATE TABLE `orders` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint unsigned NOT NULL,
  `status` varchar(20) NOT NULL,
  `memo` varchar(100) DEFAULT NULL,
  `total_amt` decimal(12,2) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_user` (`user_id`)
) ENGINE=InnoDB AUTO_INCREMENT=10 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='주문';
```

`packages/core/test/fixtures/scenarios/columns/target.sql`:
```sql
/* Database : shop */
/* Table : orders */
CREATE TABLE `orders` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint unsigned NOT NULL,
  `status` varchar(32) NOT NULL COMMENT '주문 상태',
  `total_amt` decimal(12,2) NOT NULL,
  `discount_amt` decimal(10,2) NOT NULL DEFAULT '0.00',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_orders_user_created` (`user_id`,`created_at` DESC)
) ENGINE=InnoDB AUTO_INCREMENT=99 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='주문 정보';
```

`packages/core/test/fixtures/scenarios/tables/base.sql`:
```sql
/* Database : shop */
/* Table : users */
CREATE TABLE `users` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `email` varchar(100) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

/* Table : legacy_log */
CREATE TABLE `legacy_log` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `msg` text,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

/* Table : posts */
CREATE TABLE `posts` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `user_id` int unsigned NOT NULL,
  `title` varchar(200) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

`packages/core/test/fixtures/scenarios/tables/target.sql`:
```sql
/* Database : shop */
/* Table : users */
CREATE TABLE `users` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `email` varchar(100) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

/* Table : posts */
CREATE TABLE `posts` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `user_id` int unsigned NOT NULL,
  `title` varchar(200) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_posts_user` (`user_id`),
  CONSTRAINT `fk_posts_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

/* Table : coupon */
CREATE TABLE `coupon` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `user_id` int unsigned NOT NULL,
  `code` varchar(20) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_coupon_code` (`code`),
  KEY `fk_coupon_user` (`user_id`),
  CONSTRAINT `fk_coupon_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

`packages/core/test/fixtures/scenarios/rename-table/base.sql`:
```sql
/* Database : shop */
CREATE TABLE `members` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `nick` varchar(30) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

`packages/core/test/fixtures/scenarios/rename-table/target.sql`:
```sql
/* Database : shop */
CREATE TABLE `member` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `nick` varchar(30) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

`packages/core/test/fixtures/scenarios/rename-table/renames.json`:
```json
[{ "kind": "table", "from": "members", "to": "member" }]
```

`packages/core/test/fixtures/scenarios/rename-column/base.sql`:
```sql
/* Database : shop */
CREATE TABLE `member` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `nick` varchar(30) NOT NULL,
  `email` varchar(100) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_old` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

`packages/core/test/fixtures/scenarios/rename-column/target.sql`:
```sql
/* Database : shop */
CREATE TABLE `member` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `nickname` varchar(30) NOT NULL,
  `email` varchar(100) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

`packages/core/test/fixtures/scenarios/rename-column/renames.json`:
```json
[
  { "kind": "column", "table": "member", "from": "nick", "to": "nickname" },
  { "kind": "index", "table": "member", "from": "ix_old", "to": "ix_email" }
]
```

`packages/core/test/fixtures/scenarios/partitions/base.sql`:
```sql
/* Database : shop */
CREATE TABLE `chat_log` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`,`create_at`)
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
/*!50100 PARTITION BY RANGE (((year(`create_at`) * 100) + month(`create_at`)))
(PARTITION p202510 VALUES LESS THAN (202511) ENGINE = InnoDB,
 PARTITION p202511 VALUES LESS THAN (202512) ENGINE = InnoDB,
 PARTITION pmax VALUES LESS THAN MAXVALUE ENGINE = InnoDB) */;
```

`packages/core/test/fixtures/scenarios/partitions/target.sql`:
```sql
/* Database : shop */
CREATE TABLE `chat_log` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `create_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`,`create_at`)
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
/*!50100 PARTITION BY RANGE (((year(`create_at`) * 100) + month(`create_at`)))
(PARTITION p202511 VALUES LESS THAN (202512) ENGINE = InnoDB,
 PARTITION p202512 VALUES LESS THAN (202601) ENGINE = InnoDB,
 PARTITION pmax VALUES LESS THAN MAXVALUE ENGINE = InnoDB) */;
```

`packages/core/test/fixtures/scenarios/order-view/base.sql`:
```sql
/* Database : shop */
CREATE TABLE `t1` (
  `a` int NOT NULL,
  `b` int DEFAULT NULL,
  `c` varchar(10) DEFAULT NULL,
  PRIMARY KEY (`a`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v_a` AS select `t1`.`a` AS `a` from `t1`;
```

`packages/core/test/fixtures/scenarios/order-view/target.sql`:
```sql
/* Database : shop */
CREATE TABLE `t1` (
  `a` int NOT NULL,
  `c` varchar(10) DEFAULT NULL,
  `b` int DEFAULT NULL,
  PRIMARY KEY (`a`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v_a` AS select `t1`.`a` AS `a`,`t1`.`c` AS `c` from `t1`;
```

`packages/core/test/fixtures/scenarios/mysql8/base.sql`:
```sql
/* Database : shop */
CREATE TABLE `t2` (
  `a` int NOT NULL,
  `b` int GENERATED ALWAYS AS ((`a` * 2)) VIRTUAL,
  PRIMARY KEY (`a`),
  KEY `ix_b` (`b`),
  CONSTRAINT `chk_a` CHECK ((`a` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

`packages/core/test/fixtures/scenarios/mysql8/target.sql`:
```sql
/* Database : shop */
CREATE TABLE `t2` (
  `a` int NOT NULL,
  `b` int GENERATED ALWAYS AS ((`a` * 2)) VIRTUAL,
  PRIMARY KEY (`a`),
  KEY `ix_b` (`b`) /*!80000 INVISIBLE */,
  CONSTRAINT `chk_a` CHECK ((`a` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;
```

`packages/core/test/helpers.ts`에 추가 (import 두 줄은 파일 상단으로):
```ts
import type { RenameMapping } from '../src/diff';
import { parseSqlDump } from '../src/parse-dump';

export const SCENARIOS = ['columns', 'tables', 'rename-table', 'rename-column', 'partitions', 'order-view', 'mysql8'];

export function scenario(name: string) {
  const dir = `scenarios/${name}`;
  return {
    base: parseSqlDump(fixture(`${dir}/base.sql`)).model,
    target: parseSqlDump(fixture(`${dir}/target.sql`)).model,
    renames: (hasFixture(`${dir}/renames.json`) ? JSON.parse(fixture(`${dir}/renames.json`)) : []) as RenameMapping[],
  };
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`packages/core/test/canonical.test.ts`:
```ts
import { expect, it } from 'vitest';
import { canonicalJson } from '../src/canonical';

it('키 순서와 undefined 값에 무관하다', () => {
  expect(canonicalJson({ b: 1, a: [{ y: 2, x: undefined }] })).toBe(canonicalJson({ a: [{ y: 2 }], b: 1 }));
  expect(canonicalJson({ a: 1 })).toBe('{"a":1}');
});
```

`packages/core/test/diff.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { diffSchemas, lcs } from '../src/diff';
import { parseSqlDump } from '../src/parse-dump';
import { sample, scenario } from './helpers';

const run = (name: string, withRenames = false) => {
  const s = scenario(name);
  return diffSchemas(s.base, s.target, withRenames ? s.renames : []);
};

describe('lcs', () => {
  it('공통 부분 수열', () => {
    expect([...lcs(['a', 'b', 'c'], ['a', 'c', 'b'])]).toEqual(['a', 'c']);
  });
});

describe('diffSchemas', () => {
  it('같은 실데이터끼리는 변경이 없다', () => {
    const m = parseSqlDump(sample('sql')).model;
    expect(diffSchemas(m, m)).toEqual({ tables: [], views: [], renameCandidates: [], partial: false });
  });

  it('columns: 컬럼·인덱스·옵션 변경, AUTO_INCREMENT는 무시', () => {
    const [t] = run('columns').tables;
    expect(t.op).toBe('modify');
    expect(t.columns.map((c) => [c.op, c.name, c.fields])).toEqual([
      ['modify', 'status', ['type', 'comment']],
      ['drop', 'memo', []],
      ['add', 'discount_amt', []],
    ]);
    expect(t.moved).toEqual([]);
    expect(t.indexes.map((i) => [i.op, i.name])).toEqual([['drop', 'ix_user'], ['add', 'ix_orders_user_created']]);
    expect(t.options).toEqual([{ key: 'COMMENT', from: "'주문'", to: "'주문 정보'" }]);
  });

  it('tables: 테이블 추가·삭제와 FK 추가', () => {
    const d = run('tables');
    expect(d.tables.map((t) => [t.op, t.name])).toEqual([['drop', 'legacy_log'], ['modify', 'posts'], ['add', 'coupon']]);
    const posts = d.tables[1];
    expect(posts.indexes.map((i) => [i.op, i.name])).toEqual([['add', 'fk_posts_user']]);
    expect(posts.foreignKeys.map((f) => [f.op, f.name])).toEqual([['add', 'fk_posts_user']]);
    expect(d.renameCandidates).toEqual([]);
  });

  it('rename-table: 후보를 제시하고, 매핑하면 rename 하나로 합친다', () => {
    const plain = run('rename-table');
    expect(plain.tables.map((t) => [t.op, t.name])).toEqual([['drop', 'members'], ['add', 'member']]);
    expect(plain.renameCandidates).toEqual([{ kind: 'table', from: 'members', to: 'member' }]);
    const mapped = run('rename-table', true);
    expect(mapped.tables.map((t) => [t.op, t.name, t.oldName])).toEqual([['rename', 'member', 'members']]);
  });

  it('rename-column: 컬럼·인덱스 후보와 매핑', () => {
    const plain = run('rename-column');
    expect(plain.renameCandidates).toEqual([
      { kind: 'column', table: 'member', from: 'nick', to: 'nickname' },
      { kind: 'index', table: 'member', from: 'ix_old', to: 'ix_email' },
    ]);
    const [t] = run('rename-column', true).tables;
    expect(t.columns.map((c) => [c.op, c.name, c.oldName, c.fields])).toEqual([['rename', 'nickname', 'nick', []]]);
    expect(t.indexes.map((i) => [i.op, i.name, i.oldName])).toEqual([['rename', 'ix_email', 'ix_old']]);
  });

  it('partitions: 파티션 구성 변경', () => {
    const [t] = run('partitions').tables;
    expect(t.partition?.from?.partitions.map((p) => p.name)).toEqual(['p202510', 'p202511', 'pmax']);
    expect(t.partition?.to?.partitions.map((p) => p.name)).toEqual(['p202511', 'p202512', 'pmax']);
  });

  it('order-view: 컬럼 위치 변경과 뷰 본문 변경', () => {
    const d = run('order-view');
    expect(d.tables[0].moved).toEqual(['b']);
    expect(d.tables[0].columns).toEqual([]);
    expect(d.views.map((v) => [v.op, v.name, v.fields])).toEqual([['modify', 'v_a', ['body']]]);
  });

  it('mysql8: 인덱스 가시성, CHECK, 옵션 추가', () => {
    const [t] = run('mysql8').tables;
    expect(t.indexes.map((i) => [i.op, i.name, i.fields])).toEqual([['modify', 'ix_b', ['invisible']]]);
    expect(t.checks.map((c) => [c.op, c.name, c.fields])).toEqual([['modify', 'chk_a', ['expr']]]);
    expect(t.options).toEqual([{ key: 'ROW_FORMAT', to: 'DYNAMIC' }]);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npm test -w @tdm/core -- diff canonical`
Expected: FAIL. `Failed to resolve import "../src/canonical"`

- [ ] **Step 4: canonicalJson 구현**

`packages/core/src/canonical.ts`:
```ts
// 키를 정렬하고 undefined를 뺀 JSON. 내용 비교와 해시 입력에 쓴다
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const body = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
```

- [ ] **Step 5: diff 엔진 구현**

`packages/core/src/diff.ts`:
```ts
// 두 스키마 모델의 차이 계산. unknown 목록의 속성은 비교하지 않고 skipped에 기록한다
import { canonicalJson } from './canonical';
import type { Check, Column, ForeignKey, Index, IndexField, Partitioning, SchemaModel, Table, View } from './model';
import { printColumn, printTable, printView } from './print';

export type Op = 'add' | 'drop' | 'modify' | 'rename';

export interface Change<T> {
  op: Op;
  name: string;
  oldName?: string;
  from?: T;
  to?: T;
  fields: string[];
}

export interface OptionChange {
  key: string;
  from?: string;
  to?: string;
}

export interface TableDiff {
  op: Op;
  name: string;
  oldName?: string;
  from?: Table;
  to?: Table;
  columns: Change<Column>[];
  moved: string[]; // 위치가 바뀐 컬럼 (TARGET 이름)
  indexes: Change<Index>[];
  foreignKeys: Change<ForeignKey>[];
  checks: Change<Check>[];
  options: OptionChange[];
  partition?: { from?: Partitioning; to?: Partitioning };
  skipped: string[]; // partial 출처라 비교하지 못한 속성 ('column.charset' 등)
  unparsed: boolean; // 파싱 실패 객체의 원문이 달라졌음
}

export interface ViewDiff {
  op: 'add' | 'drop' | 'modify';
  name: string;
  from?: View;
  to?: View;
  fields: string[];
}

export interface RenameMapping {
  kind: 'table' | 'column' | 'index';
  table?: string; // column/index: TARGET 테이블명
  from: string;
  to: string;
}

export interface SchemaDiff {
  tables: TableDiff[];
  views: ViewDiff[];
  renameCandidates: RenameMapping[];
  partial: boolean;
}

const COLUMN_FIELDS = ['type', 'charset', 'collation', 'generated', 'nullable', 'srid', 'invisible', 'default', 'onUpdate', 'autoIncrement', 'comment'] as const;
const INDEX_FIELDS = ['kind', 'using', 'parser', 'comment', 'invisible'] as const;
const FK_FIELDS = ['columns', 'refSchema', 'refTable', 'refColumns', 'onDelete', 'onUpdate'] as const;
const CHECK_FIELDS = ['expr', 'enforced'] as const;
const VIEW_FIELDS = ['algorithm', 'security', 'checkOption', 'columnList', 'body'] as const;

type Equal = (field: string, a: unknown, b: unknown) => boolean;
const sameJson: Equal = (_, a, b) => canonicalJson(a) === canonicalJson(b);
// InnoDB에서 RESTRICT, NO ACTION, 미지정은 같은 동작이다
const fkAction = (v: unknown) => (v === undefined || v === 'RESTRICT' || v === 'NO ACTION' ? 'RESTRICT' : v);
const fkEqual: Equal = (f, a, b) => (f === 'onDelete' || f === 'onUpdate' ? fkAction(a) === fkAction(b) : sameJson(f, a, b));

export function diffSchemas(base: SchemaModel, target: SchemaModel, renames: RenameMapping[] = []): SchemaDiff {
  const tables = diffTables(base.tables, target.tables, renames);
  const all = [...base.tables, ...target.tables, ...base.views, ...target.views];
  return {
    tables,
    views: diffViews(base.views, target.views),
    renameCandidates: findRenameCandidates(tables),
    partial: all.some((o) => o.fidelity === 'partial'),
  };
}

function diffTables(base: Table[], target: Table[], renames: RenameMapping[]): TableDiff[] {
  const details = new Map<string, TableDiff>();
  const { changes } = matchByName(base, target, mappingOf(renames, 'table'), (b, t) => {
    const d = diffTable(b, t, renames);
    details.set(t.name, d);
    return hasChanges(d) ? ['definition'] : [];
  });
  return changes.map((c) => {
    if (c.op === 'drop') return emptyDiff('drop', c.name, c.from, undefined);
    if (c.op === 'add') return emptyDiff('add', c.name, undefined, c.to);
    return { ...details.get(c.name)!, op: c.op, oldName: c.oldName };
  });
}

export function diffTable(b: Table, t: Table, renames: RenameMapping[] = []): TableDiff {
  const base = emptyDiff('modify', t.name, b, t);
  if (b.parseError || t.parseError) return { ...base, unparsed: printTable(b) !== printTable(t) };
  const skipped = new Set<string>();
  const columns = matchByName(b.columns, t.columns, mappingOf(renames, 'column', t.name), (x, y) =>
    fieldDiff(x, y, COLUMN_FIELDS, skipped, 'column.'),
  );
  const baseOrder = columns.pairs.map(([, y]) => y.name);
  const targetOrder = t.columns.map((c) => c.name).filter((n) => baseOrder.includes(n));
  const keep = lcs(baseOrder, targetOrder);
  const indexes = matchByName(b.indexes, t.indexes, mappingOf(renames, 'index', t.name), (x, y) => indexFields(x, y, skipped));
  const foreignKeys = matchByName(b.foreignKeys, t.foreignKeys, new Map(), (x, y) => fieldDiff(x, y, FK_FIELDS, skipped, 'fk.', fkEqual));
  return {
    ...base,
    columns: columns.changes,
    moved: targetOrder.filter((n) => !keep.has(n)),
    indexes: indexes.changes,
    foreignKeys: foreignKeys.changes,
    checks: checkChanges(b, t, skipped),
    options: optionChanges(b, t, skipped),
    partition: partitionChange(b, t, skipped),
    skipped: [...skipped].sort(),
  };
}

function emptyDiff(op: Op, name: string, from: Table | undefined, to: Table | undefined): TableDiff {
  return { op, name, from, to, columns: [], moved: [], indexes: [], foreignKeys: [], checks: [], options: [], skipped: [], unparsed: false };
}

function hasChanges(d: TableDiff): boolean {
  return d.unparsed || d.columns.length > 0 || d.moved.length > 0 || d.indexes.length > 0 || d.foreignKeys.length > 0
    || d.checks.length > 0 || d.options.length > 0 || d.partition !== undefined;
}

function mappingOf(renames: RenameMapping[], kind: RenameMapping['kind'], table?: string): Map<string, string> {
  return new Map(renames.filter((r) => r.kind === kind && (table === undefined || r.table === table)).map((r) => [r.from, r.to]));
}

// 이름으로 짝을 맞춘다. rename 매핑은 BASE에 새 이름이 없고 TARGET에 옛 이름이 없을 때만 적용한다
function matchByName<T extends { name: string }>(
  base: T[], target: T[], renames: Map<string, string>, fields: (a: T, b: T) => string[],
): { changes: Change<T>[]; pairs: [T, T][] } {
  const baseNames = new Set(base.map((x) => x.name));
  const targetByName = new Map(target.map((x) => [x.name, x]));
  const consumed = new Set<string>();
  const changes: Change<T>[] = [];
  const pairs: [T, T][] = [];
  for (const b of base) {
    const renamed = renames.get(b.name);
    const useRename = renamed !== undefined && targetByName.has(renamed) && !baseNames.has(renamed) && !targetByName.has(b.name);
    const t = targetByName.get(useRename ? renamed : b.name);
    if (!t) {
      changes.push({ op: 'drop', name: b.name, from: b, fields: [] });
      continue;
    }
    consumed.add(t.name);
    pairs.push([b, t]);
    const f = fields(b, t);
    if (useRename) changes.push({ op: 'rename', name: t.name, oldName: b.name, from: b, to: t, fields: f });
    else if (f.length) changes.push({ op: 'modify', name: t.name, from: b, to: t, fields: f });
  }
  for (const t of target) if (!consumed.has(t.name)) changes.push({ op: 'add', name: t.name, to: t, fields: [] });
  return { changes, pairs };
}

function fieldDiff<T extends object>(
  a: T, b: T, fields: readonly (keyof T & string)[], skipped: Set<string>, prefix: string, eq: Equal = sameJson,
): string[] {
  const unknownOf = (x: T) => (x as { unknown?: readonly string[] }).unknown ?? [];
  return fields.filter((f) => {
    if (unknownOf(a).includes(f) || unknownOf(b).includes(f)) {
      skipped.add(prefix + f);
      return false;
    }
    return !eq(f, a[f], b[f]);
  });
}

function indexFields(a: Index, b: Index, skipped: Set<string>): string[] {
  const fields = fieldDiff(a, b, INDEX_FIELDS, skipped, 'index.');
  const has = (f: IndexField) => Boolean(a.unknown?.includes(f) || b.unknown?.includes(f));
  if (has('partDetails')) skipped.add('index.partDetails');
  if (has('partOrder')) skipped.add('index.partOrder');
  const key = (i: Index): string => {
    if (!has('partDetails') && !has('partOrder')) return canonicalJson(i.parts);
    const names = i.parts.map((p) => p.column ?? p.expr ?? '');
    return canonicalJson(has('partOrder') ? [...names].sort() : names);
  };
  return key(a) === key(b) ? fields : [...fields, 'parts'];
}

function checkChanges(a: Table, b: Table, skipped: Set<string>): Change<Check>[] {
  if (a.unknown?.includes('checks') || b.unknown?.includes('checks')) {
    skipped.add('checks');
    return [];
  }
  return matchByName(a.checks, b.checks, new Map(), (x, y) => fieldDiff(x, y, CHECK_FIELDS, skipped, 'check.')).changes;
}

function optionChanges(a: Table, b: Table, skipped: Set<string>): OptionChange[] {
  const limit = a.comparableOptions && b.comparableOptions
    ? a.comparableOptions.filter((k) => b.comparableOptions!.includes(k))
    : (a.comparableOptions ?? b.comparableOptions);
  if (limit) skipped.add('options');
  const value = (t: Table, key: string) => t.options.find((o) => o.key === key)?.value;
  const keys = [...new Set([...a.options, ...b.options].map((o) => o.key))].filter((k) => !limit || limit.includes(k));
  return keys.flatMap((key) => {
    const from = value(a, key);
    const to = value(b, key);
    return from === to ? [] : [{ key, from, to }];
  });
}

function partitionChange(a: Table, b: Table, skipped: Set<string>): TableDiff['partition'] {
  if (a.unknown?.includes('partition') || b.unknown?.includes('partition')) {
    skipped.add('partition');
    return undefined;
  }
  const key = (p?: Partitioning) => (p ? canonicalJson({ method: p.method, expr: p.expr, count: p.count, partitions: p.partitions }) : '');
  return key(a.partition) === key(b.partition) ? undefined : { from: a.partition, to: b.partition };
}

function diffViews(base: View[], target: View[]): ViewDiff[] {
  const { changes } = matchByName(base, target, new Map(), (a, b) => {
    if (a.parseError || b.parseError) return printView(a) === printView(b) ? [] : ['body'];
    return fieldDiff(a, b, VIEW_FIELDS, new Set(), 'view.');
  });
  return changes.map((c) => ({ op: c.op as ViewDiff['op'], name: c.name, from: c.from, to: c.to, fields: c.fields }));
}

// 이름만 다른 drop/add 쌍을 rename 후보로 제시한다 (자동 적용하지 않음)
function findRenameCandidates(tables: TableDiff[]): RenameMapping[] {
  const out: RenameMapping[] = [];
  const tableSig = (t: Table) => t.columns.map((c) => printColumn(c, false)).join('\n');
  const dropped = tables.filter((t) => t.op === 'drop').map((t) => ({ op: 'drop' as const, name: t.name, from: t.from, fields: [] }));
  const added = tables.filter((t) => t.op === 'add').map((t) => ({ op: 'add' as const, name: t.name, to: t.to, fields: [] }));
  pairCandidates<Table>([...dropped, ...added], tableSig, (from, to) => out.push({ kind: 'table', from, to }));
  for (const t of tables) {
    if (t.op !== 'modify' && t.op !== 'rename') continue;
    pairCandidates<Column>(t.columns, (c) => printColumn({ ...c, name: '' }, false), (from, to) => out.push({ kind: 'column', table: t.name, from, to }));
    const indexes = t.indexes.filter((i) => (i.from ?? i.to)!.kind !== 'PRIMARY');
    pairCandidates<Index>(indexes, (i) => canonicalJson({ ...i, name: '' }), (from, to) => out.push({ kind: 'index', table: t.name, from, to }));
  }
  return out;
}

function pairCandidates<T>(changes: Change<T>[], sig: (x: T) => string, emit: (from: string, to: string) => void): void {
  const adds = changes.filter((c) => c.op === 'add');
  const used = new Set<string>();
  for (const d of changes.filter((c) => c.op === 'drop')) {
    const match = adds.find((a) => !used.has(a.name) && sig(a.to!) === sig(d.from!));
    if (!match) continue;
    used.add(match.name);
    emit(d.name, match.name);
  }
}

export function lcs(a: string[], b: string[]): Set<string> {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.add(a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return out;
}
```

`packages/core/src/index.ts`에 추가:
```ts
export * from './canonical';
export * from './diff';
```

- [ ] **Step 6: 통과 확인**

Run: `npm test -w @tdm/core && npm run typecheck -w @tdm/core`
Expected: PASS

- [ ] **Step 7: 커밋**

```bash
git add packages/core
git commit -m "feat: 스키마 diff 엔진과 rename 후보 탐지 추가"
```

---

### Task 6: DDL 생성기 (+ 파티션 DDL, 골든 테스트)

**Files:**
- Create: `packages/core/src/partition-ddl.ts`, `packages/core/src/ddl.ts`
- Create: `packages/core/test/fixtures/scenarios/*/expected.sql` (7개)
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/partition-ddl.test.ts`, `packages/core/test/ddl.test.ts`

**Interfaces:**
- Consumes: `SchemaDiff`, `TableDiff`, `ViewDiff`, `Op`, `printColumn`, `printIndexParts`, `printForeignKey`, `printCheck`, `printTable`, `printView`, `quoteIdent`, `quoteString`
- Produces:
  - `interface Statement { object: string; kind: 'table' | 'view'; op: Op; sql: string }`: `sql`에는 `;`가 없다. `--`로 시작하면 실행하지 않는 안내 주석이다.
  - `generateDdl(diff: SchemaDiff): Statement[]`: 스펙 4.6의 9단계 순서
  - `renderDdl(stmts: Statement[], partial?: boolean): string`: 객체 머리 주석 `-- [+|-|~|>] TABLE name`과 `;`를 붙이고, 블록 사이를 빈 줄 하나로 구분한다. 끝에 개행 하나.
  - `partitionStatements(d: TableDiff): string[]`, `listPartitionStatements(table: string, a: PartitionDef[], b: PartitionDef[]): string[]` (`table`은 인용된 이름)

- [ ] **Step 1: 파티션 DDL 실패 테스트 작성**

`packages/core/test/partition-ddl.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { listPartitionStatements, partitionStatements } from '../src/partition-ddl';
import type { TableDiff } from '../src/diff';
import type { Partitioning } from '../src/model';

const P = (name: string, bound = name.slice(1)) => ({ name, def: `VALUES LESS THAN (${bound})` });
const MAX = { name: 'pmax', def: 'VALUES LESS THAN MAXVALUE' };

describe('listPartitionStatements', () => {
  it('끝에 추가만 되면 ADD PARTITION', () => {
    expect(listPartitionStatements('`t`', [P('p1'), P('p2')], [P('p1'), P('p2'), P('p3')])).toEqual([
      'ALTER TABLE `t` ADD PARTITION (\n PARTITION `p3` VALUES LESS THAN (3))',
    ]);
  });

  it('앞쪽 삭제 + MAXVALUE 앞 추가 = DROP + REORGANIZE pmax', () => {
    expect(listPartitionStatements('`t`', [P('p1'), P('p2'), MAX], [P('p2'), P('p3'), MAX])).toEqual([
      'ALTER TABLE `t` DROP PARTITION `p1`',
      'ALTER TABLE `t` REORGANIZE PARTITION `pmax` INTO (\n PARTITION `p3` VALUES LESS THAN (3),\n PARTITION `pmax` VALUES LESS THAN MAXVALUE)',
    ]);
  });

  it('앞쪽 병합은 DROP이 아니라 REORGANIZE', () => {
    expect(listPartitionStatements('`t`', [P('p1'), P('p2'), P('p3')], [P('p12', '2'), P('p3')])).toEqual([
      'ALTER TABLE `t` REORGANIZE PARTITION `p1`, `p2` INTO (\n PARTITION `p12` VALUES LESS THAN (2))',
    ]);
  });

  it('중간 삭제는 DROP PARTITION', () => {
    expect(listPartitionStatements('`t`', [P('p1'), P('p2'), P('p3')], [P('p1'), P('p3')])).toEqual([
      'ALTER TABLE `t` DROP PARTITION `p2`',
    ]);
  });

  it('COMMENT만 바뀌면 안내 주석만', () => {
    const a = [{ name: 'p1', def: "VALUES LESS THAN (1) COMMENT = 'a'" }];
    const b = [{ name: 'p1', def: "VALUES LESS THAN (1) COMMENT = 'b'" }];
    expect(listPartitionStatements('`t`', a, b)).toEqual([
      '-- 파티션 COMMENT 변경(p1): MySQL은 COMMENT만 바꾸는 DDL이 없습니다. 필요하면 REORGANIZE PARTITION으로 재정의하세요',
    ]);
  });
});

describe('partitionStatements', () => {
  const hash = (count: number): Partitioning => ({ version: '50100', clause: `PARTITION BY HASH (\`id\`)\nPARTITIONS ${count}`, method: 'HASH', expr: '`id`', count, partitions: [] });
  const diff = (from?: Partitioning, to?: Partitioning) => ({ name: 't', partition: { from, to } }) as TableDiff;

  it('HASH 개수 증감', () => {
    expect(partitionStatements(diff(hash(4), hash(6)))).toEqual(['ALTER TABLE `t` ADD PARTITION PARTITIONS 2']);
    expect(partitionStatements(diff(hash(6), hash(4)))).toEqual(['ALTER TABLE `t` COALESCE PARTITION 2']);
  });

  it('방식이 바뀌면 전체 재정의, 없어지면 REMOVE PARTITIONING', () => {
    const key: Partitioning = { ...hash(4), method: 'KEY', clause: 'PARTITION BY KEY (`id`)\nPARTITIONS 4' };
    expect(partitionStatements(diff(hash(4), key))).toEqual(['ALTER TABLE `t` PARTITION BY KEY (`id`)\nPARTITIONS 4']);
    expect(partitionStatements(diff(hash(4), undefined))).toEqual(['ALTER TABLE `t` REMOVE PARTITIONING']);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @tdm/core -- partition-ddl`
Expected: FAIL. `Failed to resolve import "../src/partition-ddl"`

- [ ] **Step 3: 파티션 DDL 구현**

`packages/core/src/partition-ddl.ts`:
```ts
// 파티션 변경 → 최소 DDL. 월별 RANGE 파티션 운영(앞쪽 DROP, MAXVALUE 앞 추가)을 우선 처리한다
import type { TableDiff } from './diff';
import { quoteIdent as q } from './lexer';
import type { PartitionDef } from './model';

const COMMENT_RE = /\s*COMMENT\s*=?\s*'(?:[^']|'')*'/i;
const stripComment = (def: string) => def.replace(COMMENT_RE, '');
const sameStructure = (a: PartitionDef, b: PartitionDef) => a.name === b.name && stripComment(a.def) === stripComment(b.def);
const printPart = (p: PartitionDef) => ` PARTITION ${q(p.name)} ${p.def}`;
const names = (ps: PartitionDef[]) => ps.map((p) => q(p.name)).join(', ');

export function partitionStatements(d: TableDiff): string[] {
  const p = d.partition;
  if (!p) return [];
  const table = q(d.name);
  if (!p.to) return [`ALTER TABLE ${table} REMOVE PARTITIONING`];
  if (!p.from || p.from.method !== p.to.method || p.from.expr !== p.to.expr) return [`ALTER TABLE ${table} ${p.to.clause}`];
  if (!p.from.partitions.length && !p.to.partitions.length) {
    const delta = (p.to.count ?? 1) - (p.from.count ?? 1);
    if (delta > 0) return [`ALTER TABLE ${table} ADD PARTITION PARTITIONS ${delta}`];
    if (delta < 0) return [`ALTER TABLE ${table} COALESCE PARTITION ${-delta}`];
    return [];
  }
  return listPartitionStatements(table, p.from.partitions, p.to.partitions);
}

export function listPartitionStatements(table: string, a: PartitionDef[], b: PartitionDef[]): string[] {
  const out: string[] = [];
  const bNames = new Set(b.map((p) => p.name));
  // 1) 보관 기간 정리: TARGET이 기존 파티션으로 시작할 때만 앞쪽의 사라진 파티션을 DROP
  let lead = 0;
  if (b.length && a.some((p) => p.name === b[0].name)) while (lead < a.length && !bNames.has(a[lead].name)) lead++;
  if (lead) out.push(`ALTER TABLE ${table} DROP PARTITION ${names(a.slice(0, lead))}`);
  // 2) 공통 앞·뒤를 제외한 가운데 구간만 재구성
  const rest = a.slice(lead);
  let pre = 0;
  while (pre < rest.length && pre < b.length && sameStructure(rest[pre], b[pre])) pre++;
  let suf = 0;
  while (suf < rest.length - pre && suf < b.length - pre && sameStructure(rest[rest.length - 1 - suf], b[b.length - 1 - suf])) suf++;
  let from = rest.slice(pre, rest.length - suf);
  let to = b.slice(pre, b.length - suf);
  if (!from.length && to.length && suf === 0) out.push(`ALTER TABLE ${table} ADD PARTITION (\n${to.map(printPart).join(',\n')})`);
  else if (from.length && !to.length) out.push(`ALTER TABLE ${table} DROP PARTITION ${names(from)}`);
  else if (to.length) {
    if (!from.length) {
      // MAXVALUE 같은 뒤쪽 파티션 앞에 끼워 넣기: 뒤쪽 첫 파티션을 쪼갠다
      from = [rest[rest.length - suf]];
      to = [...to, b[b.length - suf]];
    }
    out.push(`ALTER TABLE ${table} REORGANIZE PARTITION ${names(from)} INTO (\n${to.map(printPart).join(',\n')})`);
  }
  // 3) COMMENT만 바뀐 파티션
  const commentOnly = b.filter((y) => {
    const x = a.find((p) => p.name === y.name);
    return x !== undefined && x.def !== y.def && stripComment(x.def) === stripComment(y.def);
  });
  if (commentOnly.length) {
    out.push(`-- 파티션 COMMENT 변경(${commentOnly.map((p) => p.name).join(', ')}): MySQL은 COMMENT만 바꾸는 DDL이 없습니다. 필요하면 REORGANIZE PARTITION으로 재정의하세요`);
  }
  return out;
}
```

- [ ] **Step 4: 파티션 테스트 통과 확인**

Run: `npm test -w @tdm/core -- partition-ddl`
Expected: PASS (7 tests)

- [ ] **Step 5: 골든 expected.sql 작성**

`packages/core/test/fixtures/scenarios/columns/expected.sql`:
```sql
-- [~] TABLE orders
ALTER TABLE `orders`
  DROP INDEX `ix_user`,
  DROP COLUMN `memo`,
  MODIFY COLUMN `status` varchar(32) NOT NULL COMMENT '주문 상태',
  ADD COLUMN `discount_amt` decimal(10,2) NOT NULL DEFAULT '0.00' AFTER `total_amt`,
  ADD INDEX `ix_orders_user_created` (`user_id`,`created_at` DESC),
  COMMENT='주문 정보';
```

`packages/core/test/fixtures/scenarios/tables/expected.sql`:
```sql
-- [+] TABLE coupon
CREATE TABLE `coupon` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `user_id` int unsigned NOT NULL,
  `code` varchar(20) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_coupon_code` (`code`),
  KEY `fk_coupon_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- [~] TABLE posts
ALTER TABLE `posts`
  ADD INDEX `fk_posts_user` (`user_id`);

-- [-] TABLE legacy_log
DROP TABLE `legacy_log`;

-- [~] TABLE posts
ALTER TABLE `posts`
  ADD CONSTRAINT `fk_posts_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

-- [+] TABLE coupon
ALTER TABLE `coupon`
  ADD CONSTRAINT `fk_coupon_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`);
```

`packages/core/test/fixtures/scenarios/rename-table/expected.sql`:
```sql
-- [>] TABLE member
RENAME TABLE `members` TO `member`;
```

`packages/core/test/fixtures/scenarios/rename-column/expected.sql`:
```sql
-- [~] TABLE member
ALTER TABLE `member`
  RENAME COLUMN `nick` TO `nickname`,
  RENAME INDEX `ix_old` TO `ix_email`;
```

`packages/core/test/fixtures/scenarios/partitions/expected.sql`:
```sql
-- [~] TABLE chat_log
ALTER TABLE `chat_log` DROP PARTITION `p202510`;

-- [~] TABLE chat_log
ALTER TABLE `chat_log` REORGANIZE PARTITION `pmax` INTO (
 PARTITION `p202512` VALUES LESS THAN (202601) ENGINE = InnoDB,
 PARTITION `pmax` VALUES LESS THAN MAXVALUE ENGINE = InnoDB);
```

`packages/core/test/fixtures/scenarios/order-view/expected.sql`:
```sql
-- [~] TABLE t1
ALTER TABLE `t1`
  MODIFY COLUMN `b` int DEFAULT NULL AFTER `c`;

-- [~] VIEW v_a
CREATE OR REPLACE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v_a` AS select `t1`.`a` AS `a`,`t1`.`c` AS `c` from `t1`;
```

`packages/core/test/fixtures/scenarios/mysql8/expected.sql`:
```sql
-- [~] TABLE t2
ALTER TABLE `t2`
  DROP CHECK `chk_a`,
  ALTER INDEX `ix_b` INVISIBLE,
  ADD CONSTRAINT `chk_a` CHECK ((`a` >= 0)),
  ROW_FORMAT=DYNAMIC;
```

모든 expected.sql은 개행 하나로 끝난다.

- [ ] **Step 6: DDL 실패 테스트 작성**

`packages/core/test/ddl.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { generateDdl, renderDdl } from '../src/ddl';
import { diffSchemas } from '../src/diff';
import { parseSqlDump } from '../src/parse-dump';
import { fixture, sample, scenario, SCENARIOS } from './helpers';

describe.each(SCENARIOS)('골든: %s', (name) => {
  it('expected.sql과 같은 DDL을 생성한다', () => {
    const { base, target, renames } = scenario(name);
    const d = diffSchemas(base, target, renames);
    expect(renderDdl(generateDdl(d), d.partial)).toBe(fixture(`scenarios/${name}/expected.sql`));
  });
});

describe('generateDdl', () => {
  it('역방향(target → base)도 생성한다', () => {
    const { base, target } = scenario('columns');
    const sql = renderDdl(generateDdl(diffSchemas(target, base)));
    expect(sql).toContain('ADD COLUMN `memo` varchar(100) DEFAULT NULL AFTER `status`');
    expect(sql).toContain('DROP COLUMN `discount_amt`');
  });

  it('실데이터: 타입 변경만 반영하고 AUTO_INCREMENT 차이는 무시한다', () => {
    const v1 = sample('sql');
    const v2 = v1
      .replace('`feature` varchar(50) NOT NULL', '`feature` varchar(80) NOT NULL')
      .replace('AUTO_INCREMENT=15 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci', 'AUTO_INCREMENT=999 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
    const d = diffSchemas(parseSqlDump(v1).model, parseSqlDump(v2).model);
    expect(renderDdl(generateDdl(d))).toBe(
      "-- [~] TABLE ai_usage_log\nALTER TABLE `ai_usage_log`\n  MODIFY COLUMN `feature` varchar(80) NOT NULL COMMENT 'youtube_summary, sentence_ai, exam_feedback, diary_ai 등';\n",
    );
  });

  it('변경이 없으면 빈 문자열', () => {
    const m = parseSqlDump(sample('sql')).model;
    expect(renderDdl(generateDdl(diffSchemas(m, m)))).toBe('');
  });

  it('파싱 실패 객체는 수동 확인 주석', () => {
    const a = parseSqlDump('CREATE TABLE `x` (`a` int NOT NULL FOO);').model;
    const b = parseSqlDump('CREATE TABLE `x` (`a` int NOT NULL BAR);').model;
    expect(renderDdl(generateDdl(diffSchemas(a, b)))).toBe(
      '-- [~] TABLE x\n-- [수동 확인 필요] x: 파싱할 수 없는 DDL이 변경되었습니다. 원문을 비교하세요\n',
    );
  });
});
```

- [ ] **Step 7: 실패 확인**

Run: `npm test -w @tdm/core -- ddl`
Expected: FAIL. `Failed to resolve import "../src/ddl"`

- [ ] **Step 8: DDL 생성기 구현**

`packages/core/src/ddl.ts`:
```ts
// SchemaDiff → BASE를 TARGET으로 바꾸는 DDL. 순서는 FK·뷰 의존성 때문에 고정 (스펙 4.6)
import type { Change, Op, OptionChange, SchemaDiff, TableDiff, ViewDiff } from './diff';
import { quoteIdent as q, quoteString } from './lexer';
import type { Index, IndexKind } from './model';
import { partitionStatements } from './partition-ddl';
import { printCheck, printColumn, printForeignKey, printIndexParts, printTable, printView } from './print';

export interface Statement {
  object: string;
  kind: 'table' | 'view';
  op: Op;
  sql: string; // ';' 없음. '--'로 시작하면 안내 주석
}

const MARK: Record<Op, string> = { add: '+', drop: '-', modify: '~', rename: '>' };
const PARTIAL_NOTE = '-- [MD 기반] 일부 속성(인덱스 종류·순서, 파티션, CHECK, 문자셋)은 비교하지 않았습니다';
const ADD_KEYWORD: Record<IndexKind, string> = {
  PRIMARY: 'PRIMARY KEY', UNIQUE: 'UNIQUE INDEX', INDEX: 'INDEX', FULLTEXT: 'FULLTEXT INDEX', SPATIAL: 'SPATIAL INDEX',
};
// 옵션을 지울 때 기본값으로 되돌리는 구문
const OPTION_RESET: Record<string, string> = {
  COMMENT: "COMMENT=''",
  ROW_FORMAT: 'ROW_FORMAT=DEFAULT',
  KEY_BLOCK_SIZE: 'KEY_BLOCK_SIZE=0',
  STATS_PERSISTENT: 'STATS_PERSISTENT=DEFAULT',
  STATS_AUTO_RECALC: 'STATS_AUTO_RECALC=DEFAULT',
  STATS_SAMPLE_PAGES: 'STATS_SAMPLE_PAGES=DEFAULT',
  COMPRESSION: "COMPRESSION='None'",
};

export function generateDdl(diff: SchemaDiff): Statement[] {
  const out: Statement[] = [];
  const table = (d: TableDiff, sql: string) => out.push({ object: d.name, kind: 'table', op: d.op, sql });
  const view = (v: ViewDiff, sql: string) => out.push({ object: v.name, kind: 'view', op: v.op, sql });
  const altered = diff.tables.filter((d) => d.op === 'modify' || d.op === 'rename');

  // 1. FK 삭제 (rename 전 이름 사용)
  for (const d of altered) {
    const drops = d.foreignKeys.filter((f) => f.op === 'drop' || f.op === 'modify');
    if (drops.length) table(d, alter(d.oldName ?? d.name, drops.map((f) => `DROP FOREIGN KEY ${q(f.name)}`)));
  }
  // 2. 뷰 삭제
  for (const v of diff.views) if (v.op === 'drop') view(v, `DROP VIEW ${q(v.name)}`);
  // 3. 테이블 rename
  for (const d of altered) if (d.op === 'rename') table(d, `RENAME TABLE ${q(d.oldName!)} TO ${q(d.name)}`);
  // 4. 테이블 생성 (FK는 8단계에서)
  for (const d of diff.tables) if (d.op === 'add') table(d, printTable(d.to!, { foreignKeys: false }));
  // 5·6. 테이블 변경, 파티션
  for (const d of altered) {
    if (d.unparsed) {
      table(d, `-- [수동 확인 필요] ${d.name}: 파싱할 수 없는 DDL이 변경되었습니다. 원문을 비교하세요`);
      continue;
    }
    const { clauses, notes } = alterClauses(d);
    if (clauses.length) table(d, alter(d.name, clauses));
    for (const note of notes) table(d, note);
    for (const sql of partitionStatements(d)) table(d, sql);
  }
  // 7. 테이블 삭제
  for (const d of diff.tables) if (d.op === 'drop') table(d, `DROP TABLE ${q(d.name)}`);
  // 8. FK 추가
  for (const d of diff.tables) {
    const adds = d.op === 'add' ? d.to!.foreignKeys
      : d.op === 'drop' ? []
      : d.foreignKeys.filter((f) => f.op === 'add' || f.op === 'modify').map((f) => f.to!);
    if (adds.length) table(d, alter(d.name, adds.map((f) => `ADD ${printForeignKey(f)}`)));
  }
  // 9. 뷰 생성·교체 (뷰가 참조하는 뷰를 먼저)
  for (const v of sortViews(diff.views.filter((x) => x.op !== 'drop'))) {
    view(v, v.to!.parseError ? `-- [수동 확인 필요] ${v.name}: 파싱할 수 없는 뷰입니다. 원문을 확인하세요` : printView(v.to!, { orReplace: true }));
  }
  return out;
}

export function renderDdl(stmts: Statement[], partial = false): string {
  const blocks = stmts.map((s) => `-- [${MARK[s.op]}] ${s.kind.toUpperCase()} ${s.object}\n${s.sql.startsWith('--') ? s.sql : `${s.sql};`}`);
  if (partial && blocks.length) blocks.unshift(PARTIAL_NOTE);
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

function alter(name: string, clauses: string[]): string {
  return `ALTER TABLE ${q(name)}\n${clauses.map((c) => `  ${c}`).join(',\n')}`;
}

// 절 순서: 삭제(CHECK·인덱스·컬럼) → 컬럼 추가·변경(TARGET 순서) → 인덱스 추가·rename·가시성 → CHECK 추가 → 옵션
function alterClauses(d: TableDiff): { clauses: string[]; notes: string[] } {
  const clauses: string[] = [];
  for (const c of d.checks) if (c.op === 'drop' || c.op === 'modify') clauses.push(`DROP CHECK ${q(c.name)}`);
  for (const i of d.indexes) if (rebuildsIndex(i) || i.op === 'drop') clauses.push(dropIndex(i.oldName ?? i.name, i.from!.kind));
  for (const c of d.columns) if (c.op === 'drop') clauses.push(`DROP COLUMN ${q(c.name)}`);
  clauses.push(...columnClauses(d));
  for (const i of d.indexes) {
    if (i.op === 'add' || rebuildsIndex(i)) clauses.push(addIndex(i.to!));
    else if (i.op === 'rename') clauses.push(`RENAME INDEX ${q(i.oldName!)} TO ${q(i.name)}`);
    else if (i.op === 'modify') clauses.push(`ALTER INDEX ${q(i.name)} ${i.to!.invisible ? 'INVISIBLE' : 'VISIBLE'}`);
  }
  for (const c of d.checks) if (c.op === 'add' || c.op === 'modify') clauses.push(`ADD ${printCheck(c.to!, false)}`);
  const options = optionClauses(d.options);
  return { clauses: [...clauses, ...options.clauses], notes: options.notes };
}

function columnClauses(d: TableDiff): string[] {
  const to = d.to!;
  const changes = new Map(d.columns.map((c) => [c.name, c]));
  const moved = new Set(d.moved);
  return to.columns.flatMap((col, idx) => {
    const ch = changes.get(col.name);
    const isMoved = moved.has(col.name);
    if (!isMoved && (!ch || ch.op === 'drop')) return [];
    const pos = idx === 0 ? ' FIRST' : ` AFTER ${q(to.columns[idx - 1].name)}`;
    const def = printColumn(col, false);
    if (ch?.op === 'add') return [`ADD COLUMN ${def}${idx === to.columns.length - 1 ? '' : pos}`];
    if (ch?.op === 'rename') {
      return [ch.fields.length || isMoved ? `CHANGE COLUMN ${q(ch.oldName!)} ${def}${isMoved ? pos : ''}` : `RENAME COLUMN ${q(ch.oldName!)} TO ${q(col.name)}`];
    }
    return [`MODIFY COLUMN ${def}${isMoved ? pos : ''}`];
  });
}

// 가시성만 바뀐 인덱스는 ALTER INDEX로 처리, 그 외 변경은 DROP 후 ADD
function rebuildsIndex(i: Change<Index>): boolean {
  if (i.op === 'rename') return i.fields.length > 0;
  if (i.op !== 'modify') return false;
  return !(i.fields.length === 1 && i.fields[0] === 'invisible' && i.to!.kind !== 'PRIMARY');
}

function dropIndex(name: string, kind: IndexKind): string {
  return kind === 'PRIMARY' ? 'DROP PRIMARY KEY' : `DROP INDEX ${q(name)}`;
}

function addIndex(i: Index): string {
  let s = `ADD ${ADD_KEYWORD[i.kind]}${i.kind === 'PRIMARY' ? '' : ` ${q(i.name)}`} ${printIndexParts(i.parts)}`;
  if (i.using) s += ` USING ${i.using}`;
  if (i.parser) s += ` WITH PARSER ${q(i.parser)}`;
  if (i.comment !== undefined) s += ` COMMENT ${quoteString(i.comment)}`;
  if (i.invisible) s += ' INVISIBLE';
  return s;
}

function optionClauses(changes: OptionChange[]): { clauses: string[]; notes: string[] } {
  const clauses: string[] = [];
  const notes: string[] = [];
  for (const o of changes) {
    if (o.to !== undefined) clauses.push(`${o.key}=${o.to}`);
    else if (OPTION_RESET[o.key]) clauses.push(OPTION_RESET[o.key]);
    else notes.push(`-- [수동 확인 필요] ${o.key} 옵션 제거: 기본값으로 되돌리는 구문이 없습니다`);
  }
  return { clauses, notes };
}

function sortViews(views: ViewDiff[]): ViewDiff[] {
  const done = new Set<string>();
  const out: ViewDiff[] = [];
  const visit = (v: ViewDiff) => {
    if (done.has(v.name)) return;
    done.add(v.name);
    for (const dep of views) if (dep !== v && v.to!.body.includes(q(dep.name))) visit(dep);
    out.push(v);
  };
  views.forEach(visit);
  return out;
}
```

`packages/core/src/index.ts`에 추가:
```ts
export * from './ddl';
export * from './partition-ddl';
```

- [ ] **Step 9: 통과 확인**

Run: `npm test -w @tdm/core && npm run typecheck -w @tdm/core`
Expected: PASS (골든 7개 포함). 골든이 실패하면 vitest diff에서 **생성기 쪽** 원인을 찾아 고친다. expected.sql은 스펙 4.6의 순서·형식 정의이므로 바꾸지 않는다.

- [ ] **Step 10: 커밋**

```bash
git add packages/core
git commit -m "feat: diff 기반 MySQL DDL 생성기와 파티션 최소 DDL 추가"
```

---

### Task 7: MD 파서 + SQL 교차 검증

**Files:**
- Create: `packages/core/src/parse-md.ts`, `packages/core/test/fixtures/md/basic.md`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/parse-md.test.ts`

**Interfaces:**
- Consumes: `ParsedDump`, `ParseWarning`, `parseCreateView`, `normalizeType`, `quoteString`, `diffSchemas`, 모델 타입
- Produces:
  - `parseMdDump(text: string): ParsedDump`: 테이블은 `fidelity: 'partial'`, `unknown: ['checks','partition']`, `comparableOptions: ['ENGINE','COLLATE','COMMENT']`
  - 컬럼 `unknown`에는 `charset`, `collation`, `srid`가 항상 들어가고, 상황에 따라 `default`, `generated`가 추가된다.
  - 인덱스 `unknown`: `partDetails`, `using`, `parser`, `comment`, `invisible`, 그리고 `[Normal]`이면 `kind`. PK는 `Key=PRI` 컬럼으로 만들고 `partOrder` unknown을 붙인다.

- [ ] **Step 1: 픽스처와 실패 테스트 작성**

`packages/core/test/fixtures/md/basic.md` (td-export MD 형식):
````markdown
shop 
=============

## Table List
- [Orders (주문)](#orders)
 - [v_sales ()](#v_sales)
 
## orders
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_0900_ai_ci|주문|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|id|bigint unsigned|NO||||PRI|auto_increment|주문 ID|
|user_id|int unsigned|NO||||MUL|||
|status|varchar(20)|NO|ready|utf8mb4|utf8mb4_0900_ai_ci||||
|memo|text|YES||utf8mb4|utf8mb4_0900_ai_ci|||a|b 메모|
|note|varchar(10)|YES||utf8mb4|utf8mb4_0900_ai_ci||||
|created_at|datetime|NO|CURRENT_TIMESTAMP|||PRI|DEFAULT_GENERATED on update CURRENT_TIMESTAMP||

**Index**
- [Unique]uk_status(status,user_id)
- [Normal]ix_user(user_id)

**Constraint**
- fk_user FOREIGN KEY (user_id) Reference users.id ON DELETE CASCADE ON UPDATE NO ACTION

 
## v_sales
**Information**
|Table type|Charset|Collate|
|---|---|---|
|VIEW|utf8mb4|utf8mb4_0900_ai_ci|

**View Create SQL**

```sql
CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v_sales` AS select `orders`.`id` AS `id` from `orders`
```
 
````

`packages/core/test/parse-md.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { diffSchemas } from '../src/diff';
import { parseMdDump } from '../src/parse-md';
import { parseSqlDump } from '../src/parse-dump';
import { fixture, sample } from './helpers';

const { model, warnings } = parseMdDump(fixture('md/basic.md'));
const orders = model.tables[0];
const col = (name: string) => orders.columns.find((c) => c.name === name)!;

describe('parseMdDump: 기본 형식', () => {
  it('스키마명, Table List의 원래 대소문자', () => {
    expect(warnings).toEqual([]);
    expect(model.name).toBe('shop');
    expect(orders).toMatchObject({ name: 'Orders', fidelity: 'partial', unknown: ['checks', 'partition'] });
  });

  it('옵션', () => {
    expect(orders.options).toEqual([
      { key: 'ENGINE', value: 'InnoDB' },
      { key: 'COLLATE', value: 'utf8mb4_0900_ai_ci' },
      { key: 'COMMENT', value: "'주문'" },
    ]);
  });

  it('컬럼 기본값·Extra·| 포함 코멘트', () => {
    expect(col('id')).toMatchObject({ type: 'bigint unsigned', nullable: false, autoIncrement: true, comment: '주문 ID' });
    expect(col('status').default).toBe("'ready'");
    expect(col('user_id').unknown).toContain('default');
    expect(col('memo')).toMatchObject({ default: undefined, comment: 'a|b 메모' });
    expect(col('note').default).toBe('NULL');
    expect(col('created_at')).toMatchObject({ default: 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' });
  });

  it('PK는 Key=PRI 컬럼, Normal 인덱스는 종류 미상', () => {
    expect(orders.indexes.map((i) => [i.kind, i.name, i.parts.map((p) => p.column), i.unknown?.includes('kind')])).toEqual([
      ['PRIMARY', 'PRIMARY', ['id', 'created_at'], false],
      ['UNIQUE', 'uk_status', ['status', 'user_id'], false],
      ['INDEX', 'ix_user', ['user_id'], true],
    ]);
    expect(orders.indexes[0].unknown).toContain('partOrder');
  });

  it('FK', () => {
    expect(orders.foreignKeys).toEqual([
      { name: 'fk_user', columns: ['user_id'], refTable: 'users', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
    ]);
  });

  it('뷰', () => {
    expect(model.views).toMatchObject([{ name: 'v_sales', algorithm: 'UNDEFINED', body: 'select `orders`.`id` AS `id` from `orders`' }]);
  });
});

describe('parseMdDump: 실데이터 교차 검증', () => {
  const sql = parseSqlDump(sample('sql')).model;

  it('같은 스키마의 SQL 모델과 비교 가능한 속성이 모두 같다', () => {
    const md = parseMdDump(sample('md'));
    expect(md.warnings).toEqual([]);
    expect(md.model.tables.map((t) => t.name).sort()).toEqual(sql.tables.map((t) => t.name).sort());
    const d = diffSchemas(sql, md.model);
    expect(d.partial).toBe(true);
    expect(d.tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => [c.name, c.fields]), indexes: t.indexes.map((i) => [i.op, i.name, i.fields]), moved: t.moved, options: t.options }))).toEqual([]);
  });

  it('MD 쪽 실제 변경은 감지한다', () => {
    const md = parseMdDump(sample('md').replace('|feature|varchar(50)|', '|feature|varchar(80)|')).model;
    const d = diffSchemas(sql, md);
    expect(d.tables.map((t) => [t.name, t.columns.map((c) => [c.name, c.fields])])).toEqual([['ai_usage_log', [['feature', ['type']]]]]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @tdm/core -- parse-md`
Expected: FAIL. `Failed to resolve import "../src/parse-md"`

- [ ] **Step 3: 구현**

`packages/core/src/parse-md.ts`:
```ts
// td-export Markdown 정의서 → SchemaModel (partial: 일부 속성은 알 수 없음)
import { quoteString } from './lexer';
import type { Column, ForeignKey, Index, IndexField, Table, View } from './model';
import { normalizeType } from './normalize';
import type { ParsedDump, ParseWarning } from './parse-dump';
import { parseCreateView } from './parse-view';

// 기본값이 없는 타입: nullable이어도 SHOW CREATE에 DEFAULT NULL이 붙지 않는다 (json은 붙는다)
const NO_DEFAULT_TYPES = /^((tiny|medium|long)?(blob|text)|geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geomcollection|geometrycollection)\b/i;
const MD_OPTION_KEYS = ['ENGINE', 'COLLATE', 'COMMENT'];
const TABLE_LIST_RE = /^\s*- \[(\S+) \(.*\)\]\(#(.*)\)\s*$/;
const INDEX_RE = /^- \[(Normal|Unique)\](.+?)\((.*)\)(?: WHERE .*)?$/;
const FK_RE = /^- (\S+) FOREIGN KEY \((.*)\) Reference (\S+) ON DELETE (.+) ON UPDATE (.+)$/;

interface Section {
  heading: string;
  line: number;
  body: string[];
}

export function parseMdDump(text: string): ParsedDump {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  const realNames = new Map<string, string>(); // 앵커(소문자) → 원래 이름
  for (const l of lines) {
    const m = TABLE_LIST_RE.exec(l);
    if (m) realNames.set(m[2], m[1]);
  }
  const tables: Table[] = [];
  const views: View[] = [];
  const warnings: ParseWarning[] = [];
  for (const sec of sections(lines)) {
    if (sec.heading === 'Table List') continue;
    const name = realNames.get(sec.heading) ?? sec.heading;
    try {
      const obj = parseSection(name, sec.body);
      if (obj.kind === 'view') views.push(obj);
      else tables.push(obj);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      warnings.push({ object: name, line: sec.line, message });
      tables.push({ kind: 'table', name, columns: [], indexes: [], foreignKeys: [], checks: [], options: [], fidelity: 'partial', parseError: message, rawDdl: sec.body.join('\n') });
    }
  }
  return { model: { name: (lines[0] ?? '').trim(), tables, views }, warnings };
}

function sections(lines: string[]): Section[] {
  const out: Section[] = [];
  lines.forEach((l, i) => {
    const m = /^## (.+?)\s*$/.exec(l);
    if (m) out.push({ heading: m[1], line: i + 1, body: [] });
    else out.at(-1)?.body.push(l);
  });
  return out;
}

function parseSection(name: string, body: string[]): Table | View {
  const header = body.find((l) => l.startsWith('|Table type|'));
  if (!header) throw new Error('Information 표 없음');
  if (header.startsWith('|Table type|Charset|')) return parseViewSection(name, body);
  const info = rowsAfter(body, header, 5)[0];
  if (!info) throw new Error('Information 행 없음');
  const [, engine, , collate, comment] = info;
  const columns: Column[] = [];
  const pk: string[] = [];
  const colHeader = body.find((l) => l.startsWith('|Name|Type|'));
  for (const cells of colHeader ? rowsAfter(body, colHeader, 9) : []) {
    const { col, isPk } = mdColumn(cells);
    columns.push(col);
    if (isPk) pk.push(col.name);
  }
  const indexes: Index[] = pk.length
    ? [{ name: 'PRIMARY', kind: 'PRIMARY', parts: pk.map((column) => ({ column, desc: false })), invisible: false, unknown: ['partOrder', 'partDetails', 'using', 'comment', 'invisible'] }]
    : [];
  indexes.push(...listAfter(body, '**Index**').map(mdIndex));
  return {
    kind: 'table',
    name,
    columns,
    indexes,
    foreignKeys: mergeForeignKeys(listAfter(body, '**Constraint**').map(mdForeignKey)),
    checks: [],
    options: [
      ...(engine ? [{ key: 'ENGINE', value: engine }] : []),
      ...(collate ? [{ key: 'COLLATE', value: collate }] : []),
      ...(comment ? [{ key: 'COMMENT', value: quoteString(comment) }] : []),
    ],
    fidelity: 'partial',
    unknown: ['checks', 'partition'],
    comparableOptions: MD_OPTION_KEYS,
  };
}

// 표 머리줄 다음 구분줄을 건너뛰고 '|'로 시작하는 행을 읽는다
function rowsAfter(body: string[], header: string, n: number): string[][] {
  const out: string[][] = [];
  for (let i = body.indexOf(header) + 2; i < body.length && body[i].startsWith('|'); i++) out.push(cells(body[i], n));
  return out;
}

// td-export는 셀 안의 '|'를 이스케이프하지 않으므로 넘친 셀은 마지막 열로 합친다
function cells(line: string, n: number): string[] {
  const parts = line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|');
  return parts.length > n ? [...parts.slice(0, n - 1), parts.slice(n - 1).join('|')] : parts;
}

function listAfter(body: string[], marker: string): string[] {
  const out: string[] = [];
  const start = body.indexOf(marker);
  if (start < 0) return out;
  for (let i = start + 1; i < body.length && body[i].startsWith('- '); i++) out.push(body[i]);
  return out;
}

function mdColumn(c: string[]): { col: Column; isPk: boolean } {
  const [name, type, nullable, def = '', , , key, extra = '', comment = ''] = c;
  const ex = extra.toLowerCase();
  const unknown: Column['unknown'] = ['charset', 'collation', 'srid'];
  const col: Column = {
    name, type: normalizeType(type), nullable: nullable === 'YES', invisible: /\binvisible\b/.test(ex), autoIncrement: ex.includes('auto_increment'), unknown,
  };
  const onUpdate = /on update (\S+)/i.exec(extra);
  if (onUpdate) col.onUpdate = onUpdate[1];
  if (/(virtual|stored) generated/.test(ex)) {
    col.generated = { expr: '', stored: ex.includes('stored generated') };
    unknown.push('generated');
  } else if (def === '' && !col.nullable) {
    unknown.push('default'); // '' 기본값과 기본값 없음을 구분할 수 없다
  } else {
    col.default = mdDefault(def, col, ex.includes('default_generated'));
  }
  if (comment) col.comment = comment;
  return { col, isPk: key === 'PRI' };
}

function mdDefault(value: string, col: Column, isExpression: boolean): string | undefined {
  if (value === '') return NO_DEFAULT_TYPES.test(col.type) || col.autoIncrement ? undefined : 'NULL';
  if (/^current_timestamp(\(\d*\))?$/i.test(value)) return value;
  if (isExpression) return `(${value})`;
  if (/^b'[01]*'$/.test(value)) return value;
  return quoteString(value);
}

function mdIndex(line: string): Index {
  const m = INDEX_RE.exec(line);
  if (!m) throw new Error(`인덱스 형식 오류: ${line}`);
  const unknown: IndexField[] = ['partDetails', 'using', 'parser', 'comment', 'invisible'];
  // td-export는 non_unique 조회 실패 시 UNIQUE도 Normal로 출력한다 → Normal은 종류를 확신할 수 없다
  if (m[1] === 'Normal') unknown.push('kind');
  return {
    name: m[2],
    kind: m[1] === 'Unique' ? 'UNIQUE' : 'INDEX',
    parts: m[3].split(',').filter(Boolean).map((column) => ({ column, desc: false })),
    invisible: false,
    unknown,
  };
}

function mdForeignKey(line: string): ForeignKey {
  const m = FK_RE.exec(line);
  if (!m) throw new Error(`FK 형식 오류: ${line}`);
  const dot = m[3].lastIndexOf('.');
  return {
    name: m[1], columns: m[2].split(','), refTable: m[3].slice(0, dot), refColumns: [m[3].slice(dot + 1)],
    onDelete: m[4].trim(), onUpdate: m[5].trim(),
  };
}

// td-export는 복합 FK를 참조 컬럼별로 여러 줄 출력한다 → 이름으로 합친다
function mergeForeignKeys(fks: ForeignKey[]): ForeignKey[] {
  const byName = new Map<string, ForeignKey>();
  for (const fk of fks) {
    const prev = byName.get(fk.name);
    byName.set(fk.name, prev
      ? { ...prev, columns: [...new Set([...prev.columns, ...fk.columns])], refColumns: [...prev.refColumns, ...fk.refColumns] }
      : fk);
  }
  return [...byName.values()];
}

function parseViewSection(name: string, body: string[]): View {
  const open = body.findIndex((l) => /^`{3,}sql$/.test(l));
  if (open < 0) throw new Error('View Create SQL 블록 없음');
  const fence = body[open].slice(0, -3);
  const close = body.indexOf(fence, open + 1);
  const view = parseCreateView(body.slice(open + 1, close < 0 ? undefined : close).join('\n'));
  return { ...view, name };
}
```

`packages/core/src/index.ts`에 추가:
```ts
export * from './parse-md';
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @tdm/core && npm run typecheck -w @tdm/core`
Expected: PASS. 교차 검증이 실패하면 vitest diff의 `[컬럼명, fields]`로 MD 매핑 규칙(`mdDefault`, `NO_DEFAULT_TYPES` 등)을 고친다. SQL 쪽 파서는 Task 4에서 검증이 끝났으므로 건드리지 않는다.

- [ ] **Step 5: 커밋**

```bash
git add packages/core
git commit -m "feat: td-export Markdown 정의서 파서와 SQL 교차 검증 추가"
```

---

### Task 8: MySQL 8.0 / 8.4 실증 테스트

**Files:**
- Create: `packages/core/docker-compose.test.yml`, `packages/core/test/mysql.int.test.ts`
- Modify: `packages/core/package.json` (scripts, devDependency `mysql2`), `packages/core/vitest.config.ts` 생성

**Interfaces:**
- Consumes: `splitStatements`, `parseCreateTable`, `parseCreateView`, `diffSchemas`, `generateDdl`, `scenario`, `SCENARIOS`, `fixture`
- Produces: `npm run test:mysql -w @tdm/core`. 기본 `npm test`에서는 이 테스트가 skip된다.

- [ ] **Step 1: 설정 파일 작성**

`packages/core/docker-compose.test.yml` (로컬 테스트 전용 컨테이너, 비밀번호는 테스트용 고정값):
```yaml
services:
  mysql80:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: test
    ports: ["33080:3306"]
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "-ptest"]
      interval: 2s
      retries: 60
  mysql84:
    image: mysql:8.4
    environment:
      MYSQL_ROOT_PASSWORD: test
    ports: ["33084:3306"]
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "-ptest"]
      interval: 2s
      retries: 60
```

`packages/core/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { testTimeout: 60_000 } });
```

`packages/core/package.json`의 `scripts`에 추가:
```json
"test:mysql": "docker compose -f docker-compose.test.yml up -d --wait && MYSQL_IT=1 vitest run test/mysql.int.test.ts"
```

설치:
```bash
npm install -D -w @tdm/core mysql2
```

- [ ] **Step 2: 테스트 작성**

`packages/core/test/mysql.int.test.ts`:
```ts
// 실증: base에 생성 DDL을 실제로 적용한 뒤 SHOW CREATE 결과가 target과 같은지 확인한다
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateDdl } from '../src/ddl';
import { diffSchemas } from '../src/diff';
import type { SchemaModel, Table, View } from '../src/model';
import { splitStatements } from '../src/parse-dump';
import { parseCreateTable } from '../src/parse-table';
import { parseCreateView } from '../src/parse-view';
import { fixture, scenario, SCENARIOS } from './helpers';

const TARGETS = [
  { name: 'MySQL 8.0', port: 33080 },
  { name: 'MySQL 8.4', port: 33084 },
];
const suite = process.env.MYSQL_IT === '1' ? describe : describe.skip;

suite.each(TARGETS)('$name', ({ port }) => {
  let conn: Connection;

  beforeAll(async () => {
    conn = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: 'test', multipleStatements: true });
  });

  afterAll(async () => {
    await conn?.end();
  });

  it.each(SCENARIOS)('%s: base + 생성 DDL = target', async (name) => {
    const db = `it_${name.replace(/-/g, '_')}`;
    await conn.query(`DROP DATABASE IF EXISTS \`${db}\`; CREATE DATABASE \`${db}\`; USE \`${db}\``);
    for (const { ddl } of splitStatements(fixture(`scenarios/${name}/base.sql`))) await conn.query(ddl);

    const { base, target, renames } = scenario(name);
    for (const s of generateDdl(diffSchemas(base, target, renames))) {
      if (!s.sql.startsWith('--')) await conn.query(s.sql);
    }

    const after = diffSchemas(await dumpSchema(conn, db), target);
    expect({ tables: after.tables.map((t) => t.name), views: after.views.map((v) => v.name) }).toEqual({ tables: [], views: [] });
  });
});

async function dumpSchema(conn: Connection, db: string): Promise<SchemaModel> {
  const [rows] = await conn.query<RowDataPacket[]>('SHOW FULL TABLES');
  const tables: Table[] = [];
  const views: View[] = [];
  for (const row of rows) {
    const name = String(Object.values(row)[0]);
    const [created] = await conn.query<RowDataPacket[]>(`SHOW CREATE TABLE \`${name}\``);
    if (row.Table_type === 'VIEW') views.push(parseCreateView(String(created[0]['Create View'])));
    else tables.push(parseCreateTable(String(created[0]['Create Table'])));
  }
  return { name: db, tables, views };
}
```

- [ ] **Step 3: 기본 테스트에서 skip되는지 확인**

Run: `npm test -w @tdm/core`
Expected: PASS, `mysql.int.test.ts`는 skipped

- [ ] **Step 4: 실증 실행**

Run: `npm run test:mysql -w @tdm/core`
Expected: PASS (2 버전 × 7 시나리오 = 14 tests)

실패하면 MySQL 오류 메시지 또는 남은 diff를 보고 **생성기를** 고친다. 고친 뒤에는 해당 골든 `expected.sql`도 함께 갱신하고 `npm test`를 다시 통과시킨다. 미리 확인해 둔 위험 지점은 두 가지다.
- `mysql8` 시나리오에서 같은 ALTER 안에 `DROP CHECK chk_a`와 `ADD CONSTRAINT chk_a`가 함께 있으면 "Duplicate check constraint name"으로 거부될 수 있다. 이때는 `alterClauses`에서 CHECK 변경을 `ALTER TABLE … DROP CHECK`와 `ALTER TABLE … ADD CONSTRAINT …` 두 문장으로 분리한다(`notes`처럼 별도 Statement로 내보낸다).
- FK 열 목록을 MySQL이 `(\`a\`,\`b\`)`(공백 없음)로 출력하면, `printForeignKey`의 `join(', ')`을 `join(',')`로 바꾸고 `parse-table.sql` 픽스처는 그대로 둔다(단일 열이라 영향 없음).

- [ ] **Step 5: 정리와 커밋**

```bash
docker compose -f packages/core/docker-compose.test.yml down
git add packages/core package-lock.json
git commit -m "test: MySQL 8.0/8.4 컨테이너 DDL 실증 테스트 추가"
```

---

## 완료 기준

- `npm test -w @tdm/core` 전체 통과 (실데이터 왕복, 골든 7개, MD 교차 검증 포함)
- `npm run typecheck -w @tdm/core` 오류 없음
- `npm run test:mysql -w @tdm/core` 14개 통과
- `packages/core/src`에 `node:` import 없음: `grep -r "from 'node:" packages/core/src`의 결과가 비어 있어야 한다

## 후속 계획 (별도 문서)

- Plan 2: `apps/server`: SQLite 스키마, 인증, 업로드(파싱 경고·중복 409), diff API, rename 매핑 저장. 해시는 `canonicalJson` + `node:crypto` SHA-256
- Plan 3: `apps/web`: 디자인 토큰·테마, 트리, 객체 diff(SQL Split/Unified, 표 좌우), DDL 탭, 업로드·이력·계정 화면
