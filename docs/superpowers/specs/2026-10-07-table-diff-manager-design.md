# Table Diff Manager — 설계 문서

- 작성일: 2026-10-07
- 상태: 설계 확정 대기 (사용자 리뷰 필요)
- 대상 DB: MySQL 8.0 / 8.4 (5.7 미지원)

## 1. 목적

`bin/td-export`(../table-define-exporter 빌드)가 출력한 `.sql` / `.md` 정의서를 업로드한다. 업로드할 때마다 스키마 단위 버전이 생성되고, 임의의 두 버전을 비교한다. 비교 결과는 다음 세 가지다.

1. **변경 내역**: 테이블·뷰 추가/삭제, 컬럼 추가/삭제/변경(타입·NULL·기본값·코멘트·순서), 인덱스·FK·CHECK·테이블 옵션·파티션 변경
2. **GitHub 스타일 diff 화면**: SQL 모드(기본)와 표 모드 모두 좌측 BASE, 우측 TARGET
3. **차이를 만드는 DDL**: BASE를 TARGET으로 바꾸는 MySQL 8.0 문법 DDL. 화면에 보여주고 복사·다운로드만 지원하며, 앱이 직접 실행하지 않는다.

팀 공용 서버로 운영한다. 자체 계정과 `admin` / `viewer` 두 역할을 둔다.

### 비목표 (YAGNI)

- DDL을 DB에 직접 실행하거나 DB에 접속해 스키마를 수집하는 기능 (수집은 td-export가 담당)
- PostgreSQL. `core`의 dialect 경계만 열어 두고 구현하지 않는다.
- 트리거·프로시저·이벤트. td-export 출력에 없다.
- Excel(.xlsx) 업로드
- SSO/OIDC

## 2. 계층과 버전 모델

```
Database (인스턴스 = 물리적 엔진 1개, 예: prod-db-01)
 └─ Schema (엔진 내 DB, 예: shop)
     └─ SchemaVersion v1, v2, v3 …   ← 업로드 1파일 = 1버전
         └─ Object (table | view)  → ObjectRevision r1, r2 … (내용 해시가 바뀔 때만 증가)
```

- **스키마 버전**: 파일 1개를 업로드하면 해당 스키마의 `version_no`가 1 증가한다. 한 번에 여러 파일을 올리면 파일마다 각 스키마의 버전이 하나씩 만들어진다.
- **객체 리비전**: 객체(테이블·뷰)의 정규화된 모델 해시가 직전 리비전과 다를 때만 새 리비전을 만든다. 버전은 "객체 → 리비전" 매핑 스냅샷이다. 따라서 "orders 테이블은 v3, v7에서 변경됨" 같은 객체 이력이 별도 계산 없이 나온다.
- **동일 내용 재업로드**: 정규화 모델이 직전 버전과 완전히 같으면 해당 파일 결과를 `duplicate`로 돌려주고 "변경 없음"을 안내한다(요청 전체는 200).
- **비교 대상**: 같은 스키마의 두 버전이 기본이다. 다른 Database/Schema의 버전과도 비교할 수 있다(예: stg.shop v4 ↔ prod.shop v9의 드리프트 확인). 엔진은 두 모델만 받으므로 추가 비용이 없다.
- **방향**: 엔진이 대칭이라 BASE와 TARGET을 바꾸면 역방향 DDL이 나온다. DMS 전환 매핑이 걸린 Schema 쌍은 역방향에서도 매핑을 뒤집어 rename 으로 반영한다(2026-10-08-dms-migration-mapping-design.md).

## 3. 아키텍처

Node.js 22 + TypeScript, npm workspaces 모노레포.

```
packages/core   순수 TS. 파서·모델·정규화·diff·DDL 생성. I/O 없음. 서버와 브라우저가 공유
apps/server     Fastify + node:sqlite. 인증, 업로드, 저장, diff API, 빌드된 web 정적 서빙
apps/web        React + Vite + TanStack Query + React Router. CSS Modules + CSS 변수 토큰
```

- **배포**: 프로세스 1개가 API와 정적 파일을 함께 서빙한다. Docker 이미지로 배포하고, SQLite 파일은 `DATA_DIR` 볼륨에 둔다.
- **`core` 공유 효과**
  - 업로드 미리보기(스키마명 감지, 파싱 경고)를 브라우저에서 즉시 계산한다.
  - 서버는 받은 원문을 **다시 파싱**한다. 클라이언트 결과는 신뢰하지 않는다.
  - API 응답 타입(`SchemaDiff` 등)을 양쪽이 같은 정의로 쓴다.
- **주요 의존성**
  - `fastify`, `@fastify/cookie`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/multipart`, `@fastify/static`
  - `zod`(server 전용; core는 의존성 0)
  - `diff`(jsdiff, 줄·단어 단위 diff)
  - `react`, `react-router`, `@tanstack/react-query`
  - 비밀번호 해시는 `node:crypto`의 `scrypt`를 쓴다(stdlib).
  - SQLite는 Node 표준 `node:sqlite`(DatabaseSync)를 쓴다(네이티브 빌드 불필요).

## 4. `core` 패키지

### 4.1 모델

```ts
type Fidelity = 'full' | 'partial';           // sql 업로드 = full, md 업로드 = partial
// 출처(md)에서 알 수 없는 속성은 객체별 `unknown` 목록에 적는다. diff는 한쪽이라도 unknown인 속성을 건너뛰고 skipped에 기록한다.
// 정확한 타입 정의는 구현 계획(docs/superpowers/plans/2026-10-07-core-engine.md) Task 2의 model.ts를 따른다.

interface Column {
  name: string; type: string;                  // 'varchar(32)', 'bigint unsigned', "enum('a','b')"
  nullable: boolean; default?: string | null;  // null = DEFAULT NULL, undefined = 기본값 없음/알 수 없음
  charset?: string; collation?: string;
  autoIncrement: boolean; onUpdate?: string;
  generated?: { expr: string; stored: boolean };
  invisible: boolean; srid?: number; comment?: string;
}
interface IndexPart { column?: string; expr?: string; length?: number; desc: boolean }
interface Index {
  name: string;                                // PK는 'PRIMARY'
  kind: 'PRIMARY' | 'UNIQUE' | 'INDEX' | 'FULLTEXT' | 'SPATIAL';
  parts: IndexPart[]; using?: 'BTREE' | 'HASH'; invisible: boolean; comment?: string; parser?: string;
}
interface ForeignKey { name: string; columns: string[]; refSchema?: string; refTable: string; refColumns: string[]; onDelete: string; onUpdate: string }
interface Check { name: string; expr: string; enforced: boolean }
interface TableOptions { engine?: string; charset?: string; collate?: string; rowFormat?: string; comment?: string; keyBlockSize?: number; other: Record<string, string> }
interface Table { kind: 'table'; name: string; columns: Column[]; indexes: Index[]; foreignKeys: ForeignKey[]; checks: Check[]; options: TableOptions; partition?: Partitioning; fidelity: Fidelity; parseError?: string; rawDdl?: string }
interface View  { kind: 'view'; name: string; algorithm?: string; security?: string; checkOption?: string; body: string; fidelity: Fidelity; parseError?: string; rawDdl?: string }
interface Partitioning { type: 'RANGE' | 'RANGE COLUMNS' | 'LIST' | 'LIST COLUMNS' | 'HASH' | 'LINEAR HASH' | 'KEY' | 'LINEAR KEY';
  expr: string; count?: number /* HASH/KEY PARTITIONS n */; subpartition?: string /* 서브파티션 절은 문자열 보존 */;
  partitions: { name: string; values?: string /* LESS THAN (…) | IN (…) */; comment?: string; engine?: string }[] }
interface SchemaModel { name: string; tables: Table[]; views: View[] }
```

### 4.2 SQL 파서 (`parseSqlDump`)

- **입력**: td-export SQL 파일. `/* Database : x */` 헤더 뒤에 `/* Table : t */` + DDL이 반복된다. DDL은 `SHOW CREATE TABLE` 원문이다.
  - td-export 0.1.30+는 맨 앞에 `SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;`, 맨 끝에 `SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;`를 붙인다. `SET`으로 시작하는 문장은 경고 없이 건너뛴다. 단 `;`가 빠져 뒤의 `CREATE`가 같은 문장에 붙었으면(같은 줄이든 다음 줄이든, 문자열·주석 밖의 `CREATE` 토큰이면) 건너뛰지 않고 `parse-error`로 남긴다. 그 밖의 CREATE가 아닌 문장은 계속 `parse-error` 경고를 낸다.
- **분할**: 따옴표·백틱·괄호 깊이를 인식하는 토크나이저로 문장(`;`)과 최상위 쉼표를 나눈다. 줄 단위로 나누지 않는다. COMMENT 문자열 안의 쉼표나 개행이 있어도 깨지지 않게 하기 위해서다.
- **CREATE TABLE 해석 범위**
  - 컬럼 속성 전체: CHARACTER SET, COLLATE, NULL/NOT NULL, DEFAULT(리터럴·`CURRENT_TIMESTAMP`·`(expr)`), AUTO_INCREMENT, ON UPDATE, GENERATED ALWAYS AS … VIRTUAL/STORED, INVISIBLE, SRID, COMMENT
  - 키: PRIMARY/UNIQUE/KEY/FULLTEXT/SPATIAL. prefix 길이, DESC, 함수형 키 파트 `((expr))`, `USING`, `COMMENT`, `/*!80000 INVISIBLE */`, `WITH PARSER`
  - `CONSTRAINT … FOREIGN KEY … REFERENCES …`, `CONSTRAINT … CHECK (…) [/*!80016 NOT ENFORCED */]`
  - 테이블 옵션: 나머지 `KEY=VALUE`는 `other`에 보존
  - `/*!50100 PARTITION BY … */`: 타입·표현식·파티션 목록(이름, VALUES, COMMENT, ENGINE)을 구조화해 파싱. 서브파티션 절만 문자열 보존
- **CREATE VIEW 해석**: `CREATE ALGORITHM=… DEFINER=… SQL SECURITY … VIEW \`v\` AS … [WITH … CHECK OPTION]`. DEFINER는 버린다.
- **파싱 실패**: 파일 전체를 거부하지 않는다. 해당 객체만 `parseError` + `rawDdl`로 저장하고 업로드 결과에 경고로 표시한다(5.2 참고).
- **정규화** (diff 노이즈 제거)
  - 테이블 옵션의 `AUTO_INCREMENT=N`은 제거한다.
  - 정수형 표시 폭(`int(11)`)은 제거한다. 단, `tinyint(1)`은 유지한다(8.0.19+ 출력 기준).
  - 타입 키워드는 소문자, 식별자는 원문 대소문자를 유지한다.
  - 정규화 규칙은 `normalize.ts` 한 곳에서만 관리한다.

### 4.3 MD 파서 (`parseMdDump`)

td-export MD 형식을 따른다.

- **스키마명**: 첫 줄 제목에서 읽는다.
- **테이블명**: `## Table List`의 `[Name (comment)](#anchor)`에서 원래 대소문자를 복원한다. 섹션 헤딩 `## name`은 소문자라서 쓰지 않는다.
- **표 섹션**
  - Information 표: Engine / Row format / Collate / Comment
  - Columns 표: Name, Type, Nullable, Default, Charset, Collation, Key, Extra, Comment
  - td-export 0.1.22+는 셀 안의 `|`를 `\|`로, 줄바꿈을 `<br>`로 이스케이프한다. 0.1.22를 직접 가리키는 표기가 없으므로 상세 인덱스 형식(0.1.19+)으로 판별된 파일만 이스케이프되지 않은 `|`로 셀을 나누고 `\|`를 되돌린다. 그 밖의 파일은 모든 `|`로 나눈다(0.1.15 코멘트가 `C:\`처럼 `\`로 끝나도 그대로 읽는다). `<br>`은 버전과 관계없이 줄바꿈으로 읽는다(0.1.21 이하 코멘트에 `<br>` 글자가 그대로 있으면 SQL과 다르게 보인다).
  - td-export 0.1.30도 백슬래시는 이스케이프하지 않는다. 그래서 0.1.22+ 파일에서 `\`로 끝나는 셀 뒤의 구분자 `|`는 `\|`(이스케이프된 `|`)와 구분할 수 없어, 그 셀과 다음 셀이 합쳐진다. 단 줄 끝의 `|`는 항상 표 구분자로 먼저 떼어 내므로 마지막 셀(Comment)의 `C:\`와 `C:|`는 구분된다.
  - 그 이전 버전은 `|`를 이스케이프하지 않는다. 셀 수가 열 수보다 많으면 넘친 셀을 마지막 Comment로 합친다.
- **형식 판별(파일 단위)**: 이전 버전이 낼 수 없는 표기가 하나라도 있으면 그 버전 이상으로 본다.

  | td-export | Default 칸 | Index 목록 | 판별 근거 |
  |---|---|---|---|
  | ~0.1.14 (legacy) | NULL·`''`·기본값 없음이 모두 빈 칸 → nullable 컬럼 기본값은 unknown | `[Normal\|Unique]` + 컬럼명만 | 아래 어느 것도 없음 |
  | 0.1.15~0.1.20 (v2) | 기본값 없는 nullable → `NULL`, NOT NULL → 빈 칸, 빈 문자열 → `''`, 문자열은 따옴표 없이(`Y`) | (0.1.19+) 아래 상세 형식 | Default가 정확히 `NULL` 또는 `''` |
  | 0.1.21+ (quoted) | 문자열·날짜 리터럴을 SQL처럼 인용(`'Y'`, `'it''s'`, `'a\\b'`, `'NULL'`). 숫자·bit·`CURRENT_TIMESTAMP`·표현식은 그대로 | 상세 형식 | 문자열·날짜 컬럼에 따옴표 없는 리터럴 Default가 없고, 따옴표로 감싼 비어 있지 않은 Default가 1개 이상 |

  - quoted 판별은 반대 증거를 먼저 본다. 문자열·날짜 계열(char/varchar/text/enum/set/date/datetime/time/timestamp) 컬럼에 따옴표 없는 Default가 하나라도 있으면(0.1.21+도 맨몸으로 내는 `NULL`·`CURRENT_TIMESTAMP[(n)]`·숫자, `DEFAULT_GENERATED` 표현식, 생성 컬럼은 제외) 0.1.20 이하로 보고 `'x'` 같은 Default는 값 자체(`'''x'''`)로 읽는다. 셀 이스케이프를 아직 모르므로 `|` 전부로 나눈 결과와 `\|`를 빼고 나눈 결과가 모두 맨몸일 때만 증거로 쓴다. 그런 증거가 없고 따옴표 Default가 있으면 quoted다.
  - 판별 근거가 둘 다 없으면(문자열 기본값이 없고 따옴표 Default도 없음) 따옴표 규칙은 쓸 일이 없다. 인덱스 상세 형식은 상세 표기가 있을 때만 켜므로, 이런 0.1.30 파일에서 상세 표기가 하나도 없으면(예: 숫자 컬럼 인덱스뿐) 보수적으로 키 파트 상세를 unknown으로 둔다.
  - quoted의 따옴표 리터럴은 디코딩해 `SHOW CREATE` 인용 규칙(`quoteString`)으로 다시 쓴다. 숫자(`0`, `0.00`)는 `SHOW CREATE`처럼 `'0'`으로 인용한다. 문자열 `'NULL'`과 `DEFAULT NULL`을 구분한다.
- **Index 목록**: `- [Normal|Unique|Fulltext|Spatial]name(parts) [WHERE …]`. MD에는 PRIMARY가 목록에 나오지 않는다.
  - 상세 형식(0.1.19+, `[Fulltext]`/`[Spatial]`·` DESC`·괄호가 하나라도 있거나 quoted면 파일 전체에 적용): 키 파트는 `col`, `col(10)`(prefix), `col DESC`, 함수식 `lower(\`c\`)`(바깥 괄호 없음, information_schema가 백슬래시 이스케이프를 한 겹 더 씌운 원문)이다. 이스케이프를 한 겹 벗긴 글자로 괄호·따옴표 밖의 쉼표를 찾아 나누고, 키 파트 원문이 테이블 컬럼명(prefix 포함)이면 컬럼(식별자는 이스케이프되지 않으므로 원문 그대로), 아니면 이스케이프를 벗긴 함수식으로 읽는다. 이때 키 파트 상세(DESC·prefix·함수식)를 비교한다. SPATIAL은 prefix 길이를 출력하지 않는다(`SHOW CREATE`와 같음).
  - 상세 형식이 아니면 컬럼명만 읽고 키 파트 상세는 unknown이다.
- **td-export 버그 대응**: `non_unique` 조회 실패 시 UNIQUE 인덱스도 `[Normal]`로 출력된다(샘플에서 13개 UNIQUE가 모두 Normal). `[Unique]`는 신뢰하고, `[Normal]`은 인덱스 종류를 unknown으로 둔다. 상세 형식(0.1.19+)의 `[Normal]`은 INDEX와 UNIQUE 중 무엇인지만 모르므로, 양쪽 키 파트 상세가 알려져 있으면 FULLTEXT·SPATIAL과의 차이(`Normal` ↔ `Fulltext`)는 종류 변경으로 비교한다. 0.1.19 미만은 FULLTEXT·SPATIAL도 `[Normal]`로 출력하므로 계열도 비교하지 않는다.
- **PK**: Columns 표의 `Key=PRI` 컬럼들로 구성한다. 복합 PK의 컬럼 순서는 표 순서로 추정한다 → `partial`.
- **Extra 정규화**: `DEFAULT_GENERATED`는 버리고, `on update X`는 `onUpdate`로, `auto_increment`는 `autoIncrement`로, `VIRTUAL/STORED GENERATED`는 `generated`(표현식 미상)로 옮긴다.
- **Constraint 목록**: FK만 있다. `- name FOREIGN KEY (c1, c2) Reference t.col|t(r1, r2) ON DELETE … ON UPDATE …`.
  - 0.1.28 이하는 다중 컬럼 FK를 참조 컬럼마다 한 줄씩 낸다 → 이름으로 합친다. 0.1.29+는 한 줄에 `t(r1, r2)`로 낸다.
  - 0.1.29+는 다른 스키마를 참조하면 `schema.t.col` / `schema.t(r1, r2)`로 낸다 → `refSchema`.
- **뷰**: fenced ```sql 블록에서 읽는다.
- **알 수 없는 속성**(undefined로 둔다): 인덱스 USING·코멘트·가시성·PARSER, `[Normal]`의 종류, PK 키 파트 순서·상세, CHECK, 파티션, generated 표현식, 컬럼 charset/collation·SRID, 테이블 charset(collate에서 추정하지 않음). 0.1.19 미만 형식이면 FULLTEXT/SPATIAL 구분, prefix 길이, DESC도 알 수 없다.
- **MD가 원리적으로 표현할 수 없는 예외**
  - `binary`/`varbinary` 기본값: information_schema는 16진수(`0x6162`), `SHOW CREATE`는 문자열(`'ab'`)로 준다 → 16진수 기본값은 unknown으로 둔다. **따라서 MD가 끼는 비교에서는 binary/varbinary 컬럼의 기본값 변경이 보이지 않는다.**
  - 인덱스 함수식이 아니라 컬럼으로 오인할 수 있는 경우: 키 파트 원문이 마침 테이블 컬럼명과 같으면 컬럼으로 읽는다(실제로는 생기지 않는다). 백슬래시가 들어간 컬럼명은 원문으로 비교하므로 보존된다.
  - 실데이터 샘플(td-export 0.1.30 `sample-app`)에서는 위 예외가 없어 SQL과 MD의 diff가 비어 있다.
- **fidelity**: `partial`로 표시한다.

### 4.4 프린터 (`printTable`, `printView`)

- 모델을 MySQL `SHOW CREATE TABLE`과 **같은 형식**으로 출력한다. 2칸 들여쓰기, 한 줄에 요소 하나, 컬럼 → 키 → FK → CHECK 순서, 닫는 괄호 뒤에 옵션.
- SQL 모드 diff 화면은 원문 대신 **프린터 출력끼리** 비교한다. 이유는 두 가지다.
  - MD 출처 버전과 SQL 출처 버전을 같은 형식으로 비교할 수 있다.
  - 정규화가 화면에도 일관되게 적용된다.
- **왕복 보장**: `print(parse(ddl)) === normalize(ddl)`를 테스트 불변식으로 둔다. 업로드할 때 왕복이 깨진 객체는 경고를 띄우고, 화면에는 원문을 함께 볼 수 있게 한다.

### 4.5 diff 엔진 (`diffSchemas(base, target, renames) → SchemaDiff`)

```ts
type Op = 'add' | 'drop' | 'modify' | 'rename';
interface Change<T> { op: Op; name: string; oldName?: string; from?: T; to?: T; fields: string[] }
interface OptionChange { key: string; from?: string; to?: string }   // key: 'ENGINE', 'DEFAULT CHARSET', 'COLLATE' …
interface TableDiff { op: Op; name: string; oldName?: string; from?: Table; to?: Table;
  columns: Change<Column>[]; moved: string[] /* 위치가 바뀐 컬럼(TARGET 이름) */; indexes: Change<Index>[];
  foreignKeys: Change<ForeignKey>[]; checks: Change<Check>[]; options: OptionChange[];
  partition?: { from?: Partitioning; to?: Partitioning };
  skipped: string[] /* partial 출처라 비교 못 한 속성 ('column.charset', 'checks' …) */;
  unparsed: boolean /* 파싱 실패 객체의 원문이 달라짐 */ }
interface ViewDiff { op: 'add' | 'drop' | 'modify'; name: string; from?: View; to?: View; fields: string[] }
interface RenameMapping { kind: 'table' | 'column' | 'index'; table?: string /* column/index: TARGET 테이블명 */; from: string; to: string }
interface SchemaDiff { tables: TableDiff[]; views: ViewDiff[];
  renameCandidates: RenameMapping[];
  ignoredRenames: { mapping: RenameMapping; reason: string }[] /* 대상 없음·원본 없음·이름 충돌·중복 매핑·테이블 없음 */;
  partial: boolean /* 한쪽이라도 partial 출처 */ }
```

- **매칭 기준**
  - 객체·컬럼·인덱스·FK·CHECK는 이름으로 매칭한다.
  - 테이블/컬럼명 비교는 대소문자를 구분한다. `lower_case_table_names` 설정은 사용자가 맞춘다고 가정한다.
- **컬럼 순서**: 양쪽에 공통으로 있는 컬럼의 LCS를 구한다. LCS에 들지 않는 컬럼만 "위치 변경"으로 표시한다(불필요한 `AFTER` 남발 방지).
- **rename 후보** (자동 적용 안 함, 5.4 참고)
  - 컬럼: 같은 테이블에서 drop 1개와 add 1개의 정의(이름 제외)가 같으면 후보로 둔다.
  - 인덱스: 정의가 같고 이름만 다르면 후보로 둔다.
  - 테이블: drop된 테이블과 add된 테이블의 컬럼 구성이 같으면 후보로 둔다.
- **rename 매핑을 받으면** drop+add 쌍을 `rename` 하나로 합치고, 나머지 속성 차이는 `fields`에 담는다.
  - 매핑은 BASE에 새 이름이 없고, TARGET에 옛 이름이 없고, 같은 대상이 아직 짝지어지지 않았을 때만 적용한다. 적용하지 못한 매핑은 이유와 함께 `ignoredRenames`에 담는다.
  - 파싱 실패 테이블은 테이블 rename 후보에서 뺀다.
- **파티션**: 방식·표현식·개수·파티션 목록과 `SUBPARTITION BY …` 절을 비교한다.
- **비교 제외**: 뷰 DEFINER, `AUTO_INCREMENT=N`. 4.2 정규화 단계에서 제거한다.

### 4.6 DDL 생성기 (`generateDdl(diff) → Statement[]`)

```ts
interface Statement {
  object: string; kind: 'table' | 'view'; op: Op;
  sql: string;        // ';' 없음. comment=true면 '-- ' 주석 줄로만 이루어진다
  comment: boolean;   // 실행할 SQL이 없는 안내 문장 (수동 확인, 파티션 COMMENT 변경 등)
  notes?: string[];   // 문장 위에 '-- '로 붙는 안내 (MD 기반 미확인 속성 등)
}
```

**문장 순서** (FK·뷰 의존성 때문에 이 순서를 고정한다)

1. 삭제·변경되는 FK를 `ALTER TABLE … DROP FOREIGN KEY`
2. 삭제되는 뷰를 `DROP VIEW`
3. `RENAME TABLE a TO b` (매핑된 것만)
4. 새 테이블을 `CREATE TABLE`. **FK를 뺀 정의**로 만들고 FK는 8단계에서 추가한다(테이블 간 생성 순서 문제 회피).
5. 변경 테이블마다 `ALTER TABLE` 문 **하나**. 절 순서는 다음과 같다.
   - `DROP CHECK` / `DROP INDEX`(PK면 `DROP PRIMARY KEY`)
   - `RENAME COLUMN`(이름만 바뀐 경우), 이름과 정의가 함께 바뀌면 `CHANGE COLUMN old new <정의>`
   - `MODIFY COLUMN <전체 정의> [FIRST|AFTER x]` (속성 변경, 위치 변경)
   - `ADD COLUMN <정의> [FIRST|AFTER x]`
   - `DROP COLUMN`
   - `ADD PRIMARY KEY` / `ADD [UNIQUE|FULLTEXT|SPATIAL] INDEX`, 인덱스가 변경되면 DROP 후 ADD
   - `RENAME INDEX a TO b`
   - `ALTER INDEX x [IN]VISIBLE` (가시성만 바뀐 경우)
   - `ADD CONSTRAINT … CHECK`
   - 테이블 옵션: `ENGINE=`, `DEFAULT CHARSET= COLLATE=`, `ROW_FORMAT=`, `COMMENT=`
   - 테이블 기본 문자셋·콜레이션이 바뀌면 손실 없는 변환일 때만 이 ALTER **앞에** `ALTER TABLE … CONVERT TO CHARACTER SET cs COLLATE coll` 문장을 따로 둔다(같은 ALTER 안에서는 CONVERT가 컬럼별 문자셋 지정을 덮어쓴다). 손실 없는 변환은 모든 문자열 컬럼이 TARGET에서 테이블 기본값을 상속하고, 테이블과 각 컬럼의 문자셋 변화가 같은 문자셋(콜레이션만 변경)·ascii에서·latin1/ascii/utf8mb3에서 utf8mb4로 중 하나인 경우다. 이때 BASE에서 명시했던 컬럼과 CONVERT가 넓힌 TEXT 계열 컬럼을 이 ALTER에서 `MODIFY`로 다시 정의하고, DEFAULT CHARSET/COLLATE 옵션 절은 생략한다. 본 ALTER가 수동 확인 문장이면 CONVERT도 수동 확인 문장이 된다.
   - 그 밖에는 CONVERT를 쓰지 않는다. 이 ALTER에 `DEFAULT CHARSET=…`(·`COLLATE=…`) 옵션 절과, 실제 문자셋·콜레이션이 바뀌는 문자열 컬럼의 `MODIFY`를 넣는다(같은 ALTER의 MODIFY는 새 테이블 기본값을 상속한다). 문자셋이 좁아지는 컬럼이 있으면 문장 notes에 `[데이터 확인]` 안내를 단다.
   - 테이블 콜레이션과 같은 `COLLATE`만 붙은 컬럼은 상속한 값이므로 `COLLATE`를 빼고 출력한다(명시하면 `SHOW CREATE` 출력이 달라진다).
6. 파티션 변경은 테이블별로 별도 `ALTER TABLE` 하나로 처리한다(다른 변경과 섞지 않는다).
   - 타입·표현식이 같고 **RANGE/LIST 파티션이 끝에 추가만 됨**: `ADD PARTITION (…)`. 월별 파티션 운영에서 가장 흔한 경우다.
   - 같은 조건에서 파티션이 **삭제됨**: `DROP PARTITION p1, p2`
   - 같은 조건에서 중간 파티션의 경계·구성이 바뀜: `REORGANIZE PARTITION … INTO (…)`
   - 파티션 COMMENT/ENGINE만 바뀜: DDL 없이 `-- 파티션 메타 변경` 주석
   - HASH/KEY 개수만 바뀜: `ADD PARTITION PARTITIONS n` / `COALESCE PARTITION n`
   - 타입·표현식이 바뀌거나 새로 파티셔닝: `PARTITION BY …` 전체 재정의
   - 파티셔닝 제거: `REMOVE PARTITIONING`
7. 삭제되는 테이블을 `DROP TABLE`
8. 추가·변경되는 FK를 `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY`
9. 추가·변경되는 뷰를 `CREATE OR REPLACE [ALGORITHM=…] [SQL SECURITY …] VIEW … AS …`. 뷰 본문에서 다른 뷰 이름 참조를 찾아 위상 정렬한다.

**특수 처리**

- `parseError`가 있는 객체는 DDL 대신 `-- [수동 확인 필요] <객체>: 파싱 불가` 주석 문장(`comment: true`)을 만든다.
- partial 출처가 있으면 출력 맨 위에 `-- [MD 기반] 일부 속성(…)은 비교하지 않았습니다` 주석을 단다.
- partial(MD) TARGET으로 문장을 만들 때
  - 변경·rename·위치 변경 컬럼과 재생성 인덱스의 `unknown` 속성은 짝지어진 BASE 객체 값으로 채운다(새 객체). 예: MD에서 타입만 바뀐 컬럼의 문자셋·기본값, 생성 컬럼 표현식, `[Normal]` 인덱스의 실제 종류(계열이 다르면, 예: BASE FULLTEXT → TARGET `[Normal]`, 채우지 않고 INDEX로 만들며 종류 미확인 안내를 단다).
  - 채우지 못한 속성은 그 문장의 `notes`에 `[MD 기반 미확인] 컬럼 \`c\`: default, charset, collation` 형식으로 적는다. 타입에 해당하지 않는 속성(정수 컬럼의 charset 등)은 적지 않는다.
  - 생성 컬럼 표현식을 채울 수 없으면(새 테이블·새 컬럼, BASE가 생성 컬럼이 아님) 잘못된 SQL 대신, 표현식 자리에 `/* 표현식 미상 */`을 넣은 SQL을 주석 처리한 수동 확인 문장(`comment: true`)을 만든다.
- 식별자는 모두 백틱으로 인용하고 내부 백틱은 이중화한다.
- 출력 형식(`renderDdl`): 문장마다 `-- [+|-|~|>] TABLE name` 머리 주석, `notes` 줄, SQL(`comment`가 아니면 끝에 `;`) 순서로 쓰고 문장 사이에 빈 줄 하나를 둔다.

## 5. 서버 (`apps/server`)

### 5.1 SQLite 스키마

```sql
CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','viewer')), disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL);
CREATE TABLE databases (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, created_at TEXT NOT NULL);
CREATE TABLE schemas (id INTEGER PRIMARY KEY, database_id INTEGER NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  name TEXT NOT NULL, UNIQUE (database_id, name));
CREATE TABLE schema_versions (id INTEGER PRIMARY KEY, schema_id INTEGER NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL, source_format TEXT NOT NULL CHECK (source_format IN ('sql','md')),
  source_filename TEXT NOT NULL, source_text TEXT NOT NULL, source_sha256 TEXT NOT NULL, model_hash TEXT NOT NULL,
  note TEXT, uploaded_by INTEGER NOT NULL REFERENCES users(id), uploaded_at TEXT NOT NULL,
  UNIQUE (schema_id, version_no));
CREATE TABLE objects (id INTEGER PRIMARY KEY, schema_id INTEGER NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('table','view')), name TEXT NOT NULL, UNIQUE (schema_id, kind, name));
CREATE TABLE object_revisions (id INTEGER PRIMARY KEY, object_id INTEGER NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL, content_hash TEXT NOT NULL, model_json TEXT NOT NULL, fidelity TEXT NOT NULL,
  parse_error TEXT, UNIQUE (object_id, revision_no));
CREATE TABLE version_objects (version_id INTEGER NOT NULL REFERENCES schema_versions(id) ON DELETE CASCADE,
  revision_id INTEGER NOT NULL REFERENCES object_revisions(id), PRIMARY KEY (version_id, revision_id));
CREATE TABLE rename_mappings (id INTEGER PRIMARY KEY, base_version_id INTEGER NOT NULL REFERENCES schema_versions(id) ON DELETE CASCADE,
  target_version_id INTEGER NOT NULL REFERENCES schema_versions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('table','column','index')), table_name TEXT, old_name TEXT NOT NULL, new_name TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id), UNIQUE (base_version_id, target_version_id, kind, table_name, old_name));
CREATE INDEX ix_versions_uploaded ON schema_versions (schema_id, uploaded_at);
CREATE INDEX ix_revisions_object ON object_revisions (object_id, revision_no);
```

- `PRAGMA journal_mode=WAL`, `foreign_keys=ON`을 켠다.
- 업로드 1건(버전 + 리비전 + 매핑)은 트랜잭션 하나로 처리한다.
- 마이그레이션은 `PRAGMA user_version` 기반 순차 SQL 파일로 관리한다.
- `source_text`에 원문을 보존한다. 파서를 개선하면 재파싱으로 모델을 다시 만들 수 있다.

### 5.2 API

| 메서드 | 경로 | 권한 | 설명 |
|---|---|---|---|
| POST | `/api/auth/login` | — | 로그인. 분당 5회 제한 |
| POST | `/api/auth/logout` | 로그인 | |
| GET | `/api/auth/me` | 로그인 | |
| GET/POST/PATCH | `/api/users` | admin | 계정 생성·역할 변경·비활성화·비밀번호 재설정 |
| GET | `/api/tree` | 로그인 | Database → Schema 목록 + 스키마별 최신 버전 번호 |
| POST/PATCH/DELETE | `/api/databases[/:id]` | admin | 삭제 시 확인용으로 이름 입력 필요 |
| GET | `/api/schemas/:id/versions` | 로그인 | 버전 이력(업로더, 메모, 변경 객체 수) |
| POST | `/api/uploads` | admin | multipart: 파일 1~N개 + 파일별 `{databaseId, schemaName, note}`. 파일별 결과를 반환한다 |
| GET | `/api/versions/:id` | 로그인 | 버전 메타 + 모델 + 객체 목록(객체 id, 리비전 번호) |
| GET | `/api/versions/:id/source` | 로그인 | 원본 파일 다운로드 |
| DELETE | `/api/versions/:id` | admin | 버전만 삭제한다. 스냅샷이 서로 독립이라 다른 버전은 영향 없음. 고아 리비전은 정리 |
| GET | `/api/diff?base=&target=` | 로그인 | `SchemaDiff` + 적용된 rename 매핑 + `Statement[]` + 양쪽 프린터 텍스트 |
| PUT | `/api/diff/renames` | 로그인(viewer 포함) | rename 매핑 저장/해제 (base, target, 목록) |
| GET | `/api/objects/:id/history` | 로그인 | 리비전 목록과 각 리비전이 처음 나온 버전 |

- **업로드 처리 흐름**
  1. 파일명 `{schema}({endpoint}).sql`, `{schema}({endpoint}).md`(td-export 0.1.15+), `{schema}.md`와 본문 헤더에서 Database/Schema 이름을 **제안**한다.
     - Database는 물리 엔진 인스턴스 하나다. td-export 0.1.20+는 기본 포트(3306)가 아니면 endpoint를 `{host}_{port}`로 쓴다(`:`는 파일명에 못 쓴다). 꼬리가 100~65535 범위의 `_숫자`(3~5자리, 앞자리 0 아님)이면 `{host}:{port}`로 제안한다(`sample-app(10.0.0.15_3309).sql` → `10.0.0.15:3309`). 그 밖에는 endpoint를 그대로 제안한다(`sample-app(10.0.0.15).sql` → `10.0.0.15`, `db_01`·`db_2` → 그대로). 서버 이름 검증(`NameSchema`, trim 후 1~128자)은 `:`를 허용한다.
     - xlsx(`{host}_{port}.xlsx`)는 업로드 대상이 아니다.
  2. 사용자가 확정하고, 없는 Database는 그 자리에서 생성한다.
  3. 서버가 재파싱한다.
  4. 정규화 모델 해시가 직전 버전과 같으면 해당 파일 결과를 `duplicate`로 반환한다(요청 전체는 200, 파일별 상태).
- **업로드 제한**: 파일당 20 MB, UTF-8만 허용(BOM은 제거).
- **업로드 응답**: 파일별로 `ok | duplicate | error`와 파싱 경고(객체, 줄 번호, 사유) 목록을 담는다.
- **diff 결과 캐시**: `(base, target, rename 매핑 해시)` 키로 메모리 LRU에 캐시한다. 버전 내용은 불변이라 무효화 조건이 rename 변경뿐이다.
- 입력 검증은 서버의 zod 스키마로 한다. core는 의존성이 없으므로 타입만 공유한다.

### 5.3 인증·보안

- **비밀번호**: `scrypt`(N=2^15, salt 16B)로 해시하고 비교는 `timingSafeEqual`로 한다.
- **세션**: 랜덤 32B 토큰의 SHA-256만 DB에 저장한다. 쿠키는 `HttpOnly; Secure; SameSite=Strict`, 만료 12시간 슬라이딩.
- **CSRF**: `SameSite=Strict`에 더해, 상태를 바꾸는 요청에는 `X-Requested-With` 헤더를 요구한다.
- **보안 헤더**: `@fastify/helmet`으로 CSP `default-src 'self'`를 걸고 인라인 스크립트를 쓰지 않는다.
- **최초 admin**: `npm run create-admin -- <username>`으로 만든다. 비밀번호는 프롬프트로 입력하며 env나 CLI 인자로 받지 않는다.
- **XSS**: DDL·코멘트는 텍스트 노드로만 렌더링한다. `dangerouslySetInnerHTML`은 쓰지 않는다.
- **오류 응답**: 사용자용 메시지만 담고 상세는 서버 로그(pino)에 남긴다.

### 5.4 rename 매핑 UX

- diff 화면에 rename 후보를 배너로 띄운다: "`orders.state` 삭제 + `orders.status` 추가 → 이름 변경일 수 있습니다 [이름 변경으로 처리]".
- 체크하면 매핑을 저장하고 diff와 DDL을 다시 계산한다.
- 매핑은 (base, target) 쌍에 묶이고 언제든 해제할 수 있다.

## 6. 웹 UI (`apps/web`)

시안: [`assets/2026-10-07-ui-mockup.html`](assets/2026-10-07-ui-mockup.html) (승인됨, 브라우저로 열기)

### 6.1 디자인 시스템

- **테마**: Dark와 Light **토글**. 초기값은 `prefers-color-scheme`, 선택값은 `localStorage`에 저장한다.
- **팔레트**: Developer Tool/IDE 계열(slate) + 의미색 add `#22C55E` / del `#F87171` / mod `#FBBF24` / accent `#38BDF8`. Light는 대비 4.5:1 이상인 진한 변형을 쓴다. 모든 색은 CSS 변수 토큰으로 관리한다.
- **폰트**: JetBrains Mono(코드·식별자) + IBM Plex Sans(UI). 셀프 호스팅, `font-display: swap`.
- **밀도**: 8~12px 간격, 본문 13px, 코드 12px/20px.
- **변경 표시**: 색에 더해 항상 `+ − ~` 기호를 함께 붙인다(색각 이상 대응). 삭제 객체는 취소선.
- **아이콘**: Lucide 스타일 SVG. 이모지는 쓰지 않는다.
- **접근성**: 트리는 `role="tree"`로 만들고 화살표 키 탐색, 포커스 링 유지, `prefers-reduced-motion`을 존중한다.

### 6.2 화면 구조 (Layout B)

```
┌ 상단바: 로고 · Database › Schema · [BASE v3 ▾] ⇄ [TARGET v5 ▾] · 버전 이력 · 업로드(admin) · 테마 · 사용자 ┐
├ 좌측 트리 ─────────┬ 탭: 요약 | 객체 diff | DDL ──────────────────────────────────────────────┤
│ 검색, [전체|변경]  │ 요약: 통계 카드 4개 + 변경 객체 표                                       │
│ ▾ prod-db-01       │ 객체 diff: 변경 객체를 GitHub "Files changed"처럼 세로로 나열             │
│   ▾ shop  v5       │   각 객체 = 파일 헤더(+n −m, 변경 막대, 접기) + 본문                      │
│     Tables 3/42    │   모드 [SQL(기본) | 표] · 레이아웃 [Split(기본) | Unified]               │
│      + coupon      │   SQL: hunk 헤더, 양쪽 줄 번호, 단어 하이라이트, 접힌 구간 ↕ 펼치기      │
│      − legacy_log  │   표: 좌 BASE 표 | 우 TARGET 표, 행 정렬, 빈 쪽 빗금, 셀 하이라이트      │
│      ~ orders      │ DDL: [v3→v5 | v5→v3] · 전체 복사 · .sql 다운로드 · 객체별 복사           │
└────────────────────┴───────────────────────────────────────────────────────────────────────────┘
```

- **트리 동작**: 트리에서 객체를 클릭하면 diff 탭의 해당 객체로 스크롤한다. 변경이 없는 객체를 클릭하면 단일 버전 정의(SQL/표)를 보여준다.
- **URL 상태**: `/db/:dbId/schema/:schemaId?base=3&target=5&tab=diff&obj=orders&mode=sql&layout=split`. 이 링크를 공유하면 같은 화면이 열린다.
- **버전 선택기**: 같은 스키마의 버전 목록(번호·날짜·업로더·메모)을 보여주고, 맨 아래 "다른 Database/Schema와 비교…" 항목을 둔다. 기본값은 직전 버전 → 최신 버전.
- **화면 목록**
  - 로그인
  - 메인(위 구조)
  - 버전 이력: 스키마 버전 타임라인. 각 버전의 변경 객체 수, 원본 다운로드, 삭제(admin)
  - 객체 이력: 리비전 목록. 인접 리비전 diff로 바로 이동
  - 업로드 모달: 드래그앤드롭 다중 파일. 파일별 감지된 Database/Schema 수정, 미리보기 경고, 메모 입력
  - 계정 관리(admin)
- **MD 출처 배너**: 비교 대상 중 하나라도 MD 출처면 "일부 속성(인덱스 타입·파티션·CHECK 등)은 비교되지 않았습니다"를 표시한다.
- **대용량 대응**: 변경 객체가 50개를 넘으면 객체 diff 목록을 가상 스크롤로 렌더링한다. 300줄을 넘는 객체는 기본으로 접는다.

## 7. 오류 처리

| 상황 | 처리 |
|---|---|
| 파일 인코딩/형식 불명 | 파일 단위 `error`. 다른 파일 업로드는 계속 진행 |
| 객체 하나 파싱 실패 | 해당 객체를 `parseError`로 저장하고 경고 표시. diff는 원문 텍스트로만, DDL은 수동 확인 주석 |
| 왕복(print∘parse) 불일치 | 업로드 경고. 화면에 "원문 보기" 제공 |
| 동일 내용 재업로드 | 파일 결과 `duplicate`. "v5와 동일" 안내 |
| 동시 업로드로 version_no 충돌 | 트랜잭션 안에서 `MAX+1`, UNIQUE 위반 시 1회 재시도 |
| 세션 만료 | 401 → 로그인 화면, 원래 URL로 복귀 |
| 서버 오류 | 사용자에게는 일반 메시지와 요청 ID, 로그에는 상세 |

## 8. 테스트

- **실데이터 샘플**: td-export 0.1.15로 `sample-app` 스키마(MySQL, 33개 테이블)에서 추출한 `.sql`·`.md` 사본을 `packages/core/test/fixtures/td-export-0115/`에 둔다(core·server 테스트 공용). 로컬 `samples/` 폴더는 git 추적에서 제외한다.
- **실데이터 샘플 (0.1.30)**: 같은 DB를 td-export 0.1.30으로 다시 뽑은 파일(파일명 `sample-app(10.0.0.15_3309).*`). `.sql`·`.md` 사본을 `packages/core/test/fixtures/td-export-0130/`에 두고, v1 SQL과 diff가 없는지, 같은 덤프의 SQL과 MD diff가 없는지 확인한다. 합성 픽스처 `fixtures/md/v3.sql`·`v3.md`는 MySQL 8.4에서 `SHOW CREATE`·information_schema 출력으로 검증한 0.1.30 형식(따옴표 기본값, `\|`·`<br>`, FULLTEXT/SPATIAL, DESC·prefix·함수식 키 파트, 다중 컬럼·다른 스키마 FK)이다.
  - 포함된 기능: RANGE 파티션(6개 테이블, 월별 + 파티션 COMMENT), `DESC` 인덱스, FULLTEXT, 복합 PK, 컬럼 단위 CHARACTER SET/COLLATE, `ON UPDATE CURRENT_TIMESTAMP`, enum, json, 한글 COMMENT
  - 없는 기능: 뷰, FK, CHECK, generated, SPATIAL, INVISIBLE → 아래 합성 픽스처로 보완
  - 변경 시나리오(v2, v3 …)는 v1 SQL을 복사해 손으로 수정한 파일로 만든다. 각 파일에 바꾼 의도를 주석으로 남긴다.
  - 접속 정보 `mysql.txt`는 `.gitignore`에 넣고 커밋하지 않는다.
- **core (vitest, 핵심)**
  - **파서 픽스처**: MySQL 8.0/8.4 Docker에 다양한 테이블(모든 타입, generated, functional index, FULLTEXT, SPATIAL, 파티션, CHECK, FK, INVISIBLE, 코멘트 내 특수문자)을 만든다. td-export로 `.sql`·`.md`를 뽑아 `packages/core/test/fixtures/`에 커밋한다.
  - **왕복**: 모든 픽스처에서 `print(parse(x)) === normalize(x)`.
  - **골든 테스트**: `base.sql` + `target.sql` → `expected.ddl` 쌍. 시나리오는 컬럼 추가/삭제/타입 변경/순서 변경, 인덱스 추가/삭제/변경/rename/가시성, FK 추가/삭제, 테이블 추가/삭제/rename, 뷰 변경, 파티션, 옵션.
  - **MD**: MD 파싱 결과가 같은 스키마 SQL 파싱 결과와, MD가 알 수 없는 속성을 빼면 일치하는지 확인.
- **DDL 실증 테스트 (`npm run test:mysql`, CI 별도 job)**: MySQL 8.0과 8.4 컨테이너에 base를 적용하고 → 생성된 DDL을 실행하고 → `SHOW CREATE TABLE` 결과를 파싱해 target 모델과 같은지 비교한다. 이게 DDL 정확성의 최종 확인이다.
- **server**: `fastify.inject`로 인증·권한 경계(viewer의 업로드 403), 업로드 → 버전/리비전 생성, 중복 업로드 duplicate 결과, 버전 삭제 후 리비전 정리를 확인한다.
- **web**: Playwright 스모크 1개(로그인 → 업로드 2회 → diff 확인 → DDL 복사)와 Dark/Light 스크린샷.

## 9. 구현 순서 (계획 단계에서 세분화)

1. `core`: 모델 → SQL 파서 + 프린터 + 왕복 테스트 → 정규화
2. `core`: diff 엔진 → DDL 생성기 → 골든 테스트 → MySQL 실증 테스트
3. `core`: MD 파서
4. `server`: SQLite 스키마/마이그레이션 → 인증 → 업로드 → diff API
5. `web`: 디자인 토큰/테마 → 셸·트리 → 객체 diff(SQL Split/Unified) → 표 모드 → DDL 탭 → 업로드·이력·계정 화면
6. Docker 이미지, README

## 10. 미결 사항 없음 — 결정 기록

| 항목 | 결정 |
|---|---|
| 입력 포맷 | SQL = 원본(full), MD = 보조(partial) |
| 버전 단위 | 스키마 단위. 객체 리비전은 내용 변경 시에만 증가 |
| 사용 형태 | 팀 공용 서버, 자체 계정 admin/viewer |
| rename | 기본 DROP+ADD. 후보를 표시하고 사용자가 매핑 |
| 대상 버전 | MySQL 8.0 / 8.4 (`RENAME COLUMN`, `RENAME INDEX`, `ALTER INDEX … VISIBLE` 사용) |
| 스택 | Node 22 + TS, Fastify, node:sqlite, React + Vite |
| DDL 출력 | 보여주기 + 복사/다운로드만. 실행 없음 |
| UI | Layout B, 객체 diff 기본 SQL Split(GitHub 스타일), 표 모드도 좌우 비교, Dark/Light 토글 |
