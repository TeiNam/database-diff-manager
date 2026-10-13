# ALTER 적용으로 새 버전 만들기 — 설계

작성일: 2026-10-13 · 상태: 검토 완료 (2026-10-13, 구현 계획 작성 중 보완)

## 1. 목적

ALTER 문 몇 개 때문에 실제 DB에 적용하고 td-export로 다시 뽑아 올리는 과정이 번거롭다. 기존 버전의 모델에 ALTER 스크립트를 적용해서 새 버전을 바로 만든다.

- 운영 서버에는 MySQL이 필요 없다. 적용은 `@tdm/core`가 모델 위에서 한다.
- 결과가 실제 MySQL과 같다는 것은 `test:mysql`(로컬·CI)이 보장한다. 같은 스크립트를 MySQL 8.0/8.4에 적용한 결과와 비교한다.
- 지원 범위 밖의 문장은 추측해서 적용하지 않는다. 거부하고 이유를 알려 준다.

## 2. 사용자 흐름

1. 스키마의 버전 목록에서 **ALTER 적용**을 누른다. admin·dba만 보인다.
2. 기준 버전을 고른다. 기본값은 최신 버전이다.
3. 스크립트를 넣는다. `.sql` 파일을 고르거나 텍스트를 붙여 넣는다.
   - **스키마 기본 문자셋·콜레이션**도 확인한다. 기본값은 MySQL 8.0/8.4 서버 기본값인 `utf8mb4` / `utf8mb4_0900_ai_ci`이다. 문자셋 없이 쓴 `CREATE TABLE`과 문자열을 반환하는 함수에 MySQL은 DB 기본값을 쓰는데, td-export 덤프에는 DB 기본값이 없기 때문이다. 입력값은 저장되고, 같은 스키마에서 다음에 열 때 기본값으로 쓴다.
4. **미리보기**를 누르면 서버가 저장하지 않고 적용만 해서 돌려준다.
   - 성공하면 적용한 문장 수와 "기준 → 결과" 비교 요약(객체별 변경 개수)을 보여 준다.
   - 실패하면 `N번째 문장 (줄 L): 이유`와 그 문장을 보여 준다.
5. **저장**을 누르면 새 버전이 생긴다.
   - 버전 이력에는 `ALTER 적용 (기준 vN)` 배지가 붙고, 적용한 스크립트 원문을 볼 수 있다.
   - 메모 칸은 기존 업로드와 같다.

기준 버전 조건은 다음과 같다. 조건에 맞지 않으면 버튼을 비활성화하고 이유를 툴팁으로 보여 준다.

| 기준 버전 | 처리 |
|---|---|
| SQL 출처 (ALTER로 만든 버전 포함) | 적용 가능 |
| MD 출처 | 거부: 모델 정보가 부분적이라 결과를 MySQL과 맞출 수 없다 |
| stale | 거부: 저장된 모델이 현재 파서와 다르다. 원문을 다시 올린 버전을 기준으로 쓴다 |

## 3. 지원 범위 (1차)

### 3.1 지원하는 문장

| 분류 | 문장·절 |
|---|---|
| ALTER TABLE 컬럼 절 | `ADD [COLUMN] def [FIRST\|AFTER c]`, `ADD [COLUMN] (def, …)`, `MODIFY [COLUMN]`, `CHANGE [COLUMN] old new def`, `RENAME COLUMN a TO b`, `DROP [COLUMN]`, `ALTER [COLUMN] c SET DEFAULT lit \| DROP DEFAULT \| SET VISIBLE \| SET INVISIBLE` |
| ALTER TABLE 인덱스 절 | `ADD {INDEX\|KEY} [name] (parts) [opts]`, `ADD [CONSTRAINT [sym]] UNIQUE [INDEX\|KEY] …`, `ADD FULLTEXT …`, `ADD SPATIAL …`, `ADD [CONSTRAINT [sym]] PRIMARY KEY (…)`, `DROP {INDEX\|KEY} name`, `DROP PRIMARY KEY`, `RENAME {INDEX\|KEY} a TO b`, `ALTER INDEX name {VISIBLE\|INVISIBLE}` |
| ALTER TABLE 제약 절 | `ADD [CONSTRAINT [sym]] FOREIGN KEY [name] (cols) REFERENCES t (cols) [ON DELETE …] [ON UPDATE …]`, `DROP FOREIGN KEY name`, `DROP CHECK name`, `DROP CONSTRAINT name` |
| ALTER TABLE 테이블 절 | `COMMENT [=] '…'`, `ENGINE [=] …`, `ROW_FORMAT [=] …`, `KEY_BLOCK_SIZE [=] n`, `RENAME [TO\|AS] new`, `ALGORITHM=…`·`LOCK=…`(무시) |
| 단독 문장 | `CREATE [UNIQUE\|FULLTEXT\|SPATIAL] INDEX name ON t (…)`, `DROP INDEX name ON t`, `RENAME TABLE a TO b [, c TO d …]`, `CREATE TABLE [IF NOT EXISTS] …`, `DROP TABLE [IF EXISTS] a [, b …]`, `CREATE FUNCTION/PROCEDURE …`(DELIMITER 포함), `DROP {FUNCTION\|PROCEDURE} [IF EXISTS] …`, `DROP VIEW [IF EXISTS] …` |
| 세션 문장 | `SET FOREIGN_KEY_CHECKS = 0\|1`(`@OLD_…` 저장·복원 포함): 0인 동안은 MySQL처럼 FK 부모 테이블이 없어도 되는 검사(FK 추가 시 부모 없음, 참조되는 테이블 삭제)를 건너뛴다. `SET [SESSION] SQL_MODE = '…'`: 뒤에 만드는 루틴의 SQL_MODE로 쓴다 |
| 무시하는 문장 | `SET NAMES …`와 그 밖의 `SET`, 주석, 현재 스키마와 같은 `USE` |

- `CREATE TABLE`의 컬럼 정의 안에 `PRIMARY KEY`, `UNIQUE [KEY]`, `KEY`(PK의 동의어)를 쓰면 인덱스로 바꾼다.
- 컬럼 정의 안의 `REFERENCES …`는 MySQL처럼 무시한다.
- `IF NOT EXISTS`는 대상이 이미 있으면 아무것도 하지 않는다. `IF EXISTS`는 대상이 없으면 아무것도 하지 않는다. MySQL의 경고 동작과 같다.

### 3.2 거부하는 문장 (1차)

거부하면 이유와 함께 "이 변경은 td-export로 다시 뽑아 올려 주세요"라고 안내한다.

| 구분 | 대상 | 이유 |
|---|---|---|
| 식이 들어가는 정의 | `CREATE/ALTER VIEW`, `CREATE OR REPLACE VIEW`, `CHECK (…)` 추가, 생성 컬럼(`GENERATED ALWAYS AS`, `AS (…)`), 식 기본값 `DEFAULT (…)`, 함수 인덱스 키 파트 `((…))` | MySQL이 식을 다시 써서 저장한다(``(`price` > 0)``, ``select `t`.`a` AS `a` …``). 모델에서 똑같이 만들 수 없다 |
| 문자셋·파티션 | `CONVERT TO CHARACTER SET`, `[DEFAULT] CHARACTER SET=`·`COLLATE=` 테이블 옵션, 파티션 절 전부(`PARTITION BY`, `ADD/DROP/REORGANIZE/COALESCE/TRUNCATE PARTITION`, `REMOVE PARTITIONING`) | 컬럼 상속과 행 이동 규칙이 복잡하다 |
| FK로 이어진 타입 변경 | FK 컬럼 또는 FK가 참조하는 컬럼의 타입·문자셋·콜레이션을 바꾸는 `MODIFY`/`CHANGE` | MySQL이 거부하는 경우(3780)와 허용하는 경우를 1차에서는 가르지 않는다 |
| 데이터·권한·기타 | `INSERT`·`UPDATE`·`DELETE`·`REPLACE`·`TRUNCATE`, `GRANT`, `CREATE TABLE … SELECT`, `CREATE TABLE … LIKE`, `CREATE/DROP TRIGGER·EVENT`, `ALTER DATABASE`, 그 밖에 표에 없는 문장 | 범위 밖 |
| 다른 스키마 | 다른 스키마를 한정한 이름(`other.t`), 다른 스키마로의 `USE` | 버전은 스키마 하나를 나타낸다. 현재 스키마 이름으로 한정한 경우(`cur.t`)는 허용한다 |

## 4. MySQL 정규화 규칙

적용 결과는 MySQL이 같은 스크립트를 실행한 뒤의 `SHOW CREATE` 모양과 같아야 한다. 판정 기준은 "기존 비교 엔진(`diffSchemas` + `generateDdl`)으로 비교했을 때 DDL 문장이 0개"이다. 아래 규칙은 각각 `test:mysql` 시나리오로 MySQL 8.0과 8.4에서 확인한다. 두 버전의 동작이 다르면 8.4를 따르고 그 차이를 시나리오에 적는다.

- **이름 비교:** 테이블 이름은 대소문자를 구분한다(Linux 기본 `lower_case_table_names=0`과 같다). 컬럼·인덱스·제약 이름은 구분하지 않는다.
- **이름 표기:** 결과에 어느 표기가 남는지(예: 기존 컬럼 `name`을 `MODIFY NAME …`으로 바꿀 때)는 시나리오로 확인한 MySQL 동작을 따른다. 결정하기 전까지 대소문자만 다른 이름을 쓰는 절은 거부한다.
- **타입:**
  - 소문자로 쓴다. `INTEGER`→`int`, `INT(11)`→`int`
  - 정수 표시 폭은 지운다. 예외는 `tinyint(1)`과 `ZEROFILL`이다.
  - `BOOL`/`BOOLEAN`→`tinyint(1)`, `DEC`/`NUMERIC`/`DECIMAL`→`decimal(M,D)`(기본 `(10,0)`), `CHAR`→`char(1)`, `BINARY`→`binary(1)`, `BIT`→`bit(1)`
  - `DOUBLE PRECISION`/`REAL`→`double`, `CHARACTER VARYING`→`varchar`, `utf8`→`utf8mb3`
  - `SERIAL`은 거부한다. `UNIQUE` 인덱스가 따로 생기는 규칙이 있다.
  - ENUM·SET 값은 작은따옴표로 다시 인용한다.
- **기본값과 NULL:**
  - 숫자 리터럴은 따옴표로 감싸고 타입 자릿수에 맞춘다(`DEFAULT 0` → `decimal(12,4)`면 `'0.0000'`).
  - `NOW()`·`CURRENT_TIMESTAMP()`·`LOCALTIME`류는 `CURRENT_TIMESTAMP[(fsp)]`로 바꾼다. `ON UPDATE` 가 잘못되면 MySQL 1294 다.
  - NULL 허용 컬럼에 기본값이 없으면 `DEFAULT NULL`을 붙인다. TEXT·BLOB 계열은 붙이지 않는다(명시한 `DEFAULT NULL`도 SHOW CREATE 에 보이지 않는다). JSON 은 붙인다(td-export 실출력 `json DEFAULT NULL`). GEOMETRY 계열은 시나리오로 확인한다.
  - 리터럴 기본값은 TEXT·BLOB·JSON·GEOMETRY 계열에 쓸 수 없다(MySQL 1101).
  - `timestamp`는 `explicit_defaults_for_timestamp=ON`(8.0 기본) 규칙을 따른다.
  - PRIMARY KEY에 들어간 컬럼은 NOT NULL이 되고, `DEFAULT NULL`은 사라진다.
- **문자셋:**
  - 새 문자열 컬럼(그리고 문자셋 없이 쓴 `MODIFY`·`CHANGE`)은 테이블 기본 문자셋·콜레이션을 물려받는다. 예전 컬럼의 문자셋을 물려받지 않는 것도 MySQL과 같다.
  - 저장 표기는 `SHOW CREATE` 규칙을 따른다. 컬럼 콜레이션이 테이블 기본 콜레이션과 다르면 `CHARACTER SET`을 붙이고, 콜레이션이 그 문자셋의 기본 콜레이션이 아니면 `COLLATE`를 붙인다. `COLLATE`를 명시하면 둘 다 붙인다.
  - 새 테이블은 옵션에 쓴 문자셋·콜레이션을 쓰고, 없으면 2장의 스키마 기본값을 쓴다. 문자셋만 쓰면 그 문자셋의 기본 콜레이션, 콜레이션만 쓰면 그 콜레이션의 문자셋이다.
- **자동 이름:**
  - 이름 없는 인덱스·UNIQUE는 첫 키 파트의 컬럼 이름을 쓴다. 이미 있으면 `_2`, `_3`…을 붙인다.
  - 이름 없는 FK는 `<테이블>_ibfk_<N>`이다. N은 기존 최대값+1이다.
  - FK에 쓸 수 있는 인덱스(FK 컬럼이 앞부분과 같은 인덱스)가 없으면 인덱스를 자동으로 만든다. 그 이름 규칙은 시나리오로 확인한 MySQL 동작을 따른다.
- **연쇄 변경:**
  - 컬럼을 지우면 그 컬럼을 인덱스에서 빼고, 빈 인덱스는 지운다.
  - `RENAME COLUMN`·`CHANGE`로 이름이 바뀌면 같은 테이블의 인덱스·FK와, 그 컬럼을 참조하는 다른 테이블의 FK `refColumns`를 바꾼다.
  - `RENAME TABLE`은 다른 테이블 FK의 `refTable`을 바꾼다. 뷰 본문은 바꾸지 않는다. MySQL도 바꾸지 않는다.
- **루틴:**
  - 본문은 쓴 그대로 저장한다. MySQL의 `SHOW CREATE FUNCTION`도 그렇다.
  - `sqlMode`는 스크립트에서 그 문장 앞의 마지막 `SET [SESSION] SQL_MODE` 값을 쓴다. 없으면 MySQL 8.0/8.4 기본 모드(`ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION`)를 쓴다.
  - DEFINER는 저장하지 않는다. 비교 대상이 아니다.
  - 함수의 `RETURNS` 타입은 타입 규칙으로 정규화한다. 문자열 타입이면 MySQL처럼 ` CHARSET <스키마 기본 문자셋>`을 붙인다. `RETURNS` 안에 `CHARSET`·`COLLATE`를 직접 쓴 경우는 1차에서 거부한다.
- **테이블 옵션:**
  - `ENGINE` 값은 MySQL 표기로 맞춘다(`innodb`→`InnoDB`). `ROW_FORMAT`은 대문자로 쓴다.
  - `COMMENT=''`이면 옵션을 지운다.
  - `AUTO_INCREMENT=n`은 비교에서 무시되므로 기준 값을 그대로 둔다.

### 4.1 오류로 처리하는 경우

MySQL이 오류를 내는 다음 경우는 적용을 실패시킨다.

- **없는 대상:** 테이블·컬럼·인덱스·FK·CHECK를 바꾸거나 지우려 할 때(`IF EXISTS`는 제외)
- **중복 이름:** 같은 이름의 컬럼·인덱스·FK·테이블을 만들려 할 때(`IF NOT EXISTS`는 제외)
- **마지막 컬럼:** 테이블의 마지막 컬럼을 지우려 할 때
- **FK가 쓰는 대상:** FK가 쓰는 컬럼을 지우거나(1828), FK가 필요로 하는 인덱스를 지우려 할 때(1553)
- **FK 부모:** 다른 테이블 FK가 참조하는 테이블을 지우려 할 때(3730). 같은 문장 안에서 함께 지우는 경우는 제외한다.
- **AUTO_INCREMENT:** 키가 없는 AUTO_INCREMENT 컬럼(1075), AUTO_INCREMENT 컬럼이 둘 이상인 경우
- **PK 중복:** PRIMARY KEY를 두 번 정의할 때(1068)
- **FK 정의:** 없는 컬럼이나 테이블을 참조하는 FK. 참조 컬럼의 타입이 다른 FK(3780)
- **키 파트:** TEXT·BLOB 키 파트에 prefix 길이가 없을 때(1170)

MySQL의 모든 검사를 재현하지는 않는다. 화면 안내와 이 문서에 "실제 DB에 적용했을 때 MySQL이 거부할 수 있는 스크립트를 이 도구가 받아들일 수 있다"고 적는다. 예를 들어 키 길이 한도나 행 크기 한도 검사는 하지 않는다.

## 5. 구조

### 5.1 `@tdm/core` — 새 디렉터리 `src/apply/`

순수 TypeScript이고 런타임 의존성이 없으며 `node:`를 쓰지 않는다. 모델은 바꾸지 않고 새 객체를 돌려준다.

| 파일 | 책임 |
|---|---|
| `index.ts` | `applyScript(model, script, { schemaName, defaults? }): ApplyResult` — 문장을 나누고(기존 `splitDump`·세션 SQL_MODE 추적 재사용) 문장마다 처리기로 보낸다. 실패하면 즉시 `{ ok: false, error }` |
| `types.ts` | 공용 타입, `ApplyFailure`, `MYSQL_DEFAULTS`, `DEFAULT_SQL_MODE` |
| `normalize-mysql.ts` | 4장의 정규화 규칙(타입·기본값·NULL·문자셋), `finalizeColumn` |
| `options.ts` | 테이블 옵션 값 정규화와 SHOW CREATE 옵션 순서 |
| `def-parser.ts` | 사람이 쓴 컬럼 정의·인덱스 정의·FK 정의를 읽는 관대한 파서. 백틱 없는 이름, 소문자 키워드, 생략 가능한 키워드, 컬럼 안 제약을 받는다. 기존 lexer·cursor·parse-table 의 키 파트·FK 파서 재사용 |
| `state.ts` | 작업용 모델 사본, 세션 값, 기준 이름 추적(rename 매핑용) |
| `session.ts` | `SET` 문 (FOREIGN_KEY_CHECKS·SQL_MODE, `@OLD_…` 저장·복원) |
| `keys.ts` | 인덱스·FK 추가·삭제·자동 이름, FK 자동 인덱스, 문장 끝 검사(4.1), MySQL 키 순서 |
| `alter-table.ts` | ALTER TABLE 절 처리(단계별 적용, 연쇄 변경), `CREATE INDEX … ON`·`DROP INDEX … ON` |
| `table-stmt.ts` | CREATE/DROP/RENAME TABLE |
| `object-stmt.ts` | CREATE/DROP FUNCTION·PROCEDURE, DROP VIEW |
| `print-dump.ts` | `printSqlDump(model): string` — td-export 0.1.52 형식(헤더 주석, `SET @OLD_…`, 테이블·뷰·루틴, 복원 트레일러)으로 출력 |

`ApplyResult`의 모양은 다음과 같다.

```ts
type ApplyResult =
  | { ok: true; model: SchemaModel; applied: number; renames: RenameMapping[]; defaults: ApplyDefaults }
  | { ok: false; error: { index: number; line: number; statement: string; reason: string } };
```

- `renames`에는 스크립트의 `RENAME TABLE`·`RENAME COLUMN`·`CHANGE`(이름 변경)·`RENAME INDEX`로 생긴 기준→결과 이름 대응을 기존 `RenameMapping` 형식으로 담는다. 같은 대상의 이름이 여러 번 바뀌면 처음 이름에서 마지막 이름으로 접는다.
- 결과 모델은 덤프 파서가 만드는 모델과 같은 불변식을 지킨다. 예를 들어 `fidelity: 'full'`이고, 정렬과 이름 규칙이 같다. 그래서 `printSqlDump` → `parseSqlDump`가 같은 모델을 돌려준다. 이 왕복이 깨지면 서버 시작 시 재판정에서 stale로 잘못 표시되므로 테스트로 고정한다.

### 5.2 서버

- **마이그레이션 `009_version_derivations.sql`:**
  - `schema_version_derivations(version_id PK → schema_versions ON DELETE CASCADE, base_version_id → schema_versions ON DELETE SET NULL, base_version_no INTEGER NOT NULL, script TEXT NOT NULL, statement_count INTEGER NOT NULL, default_charset TEXT NOT NULL, default_collation TEXT NOT NULL)`. `base_version_no`는 기준 버전이 지워져도 배지에 `기준 vN`을 보여 주려고 남긴다
- **`POST /versions/:id/alter`:**
  - 권한은 admin·dba이다. `onRequest`에서 검사하는 기존 방식을 따르고 CSRF 헤더도 기존대로 요구한다.
  - 본문은 JSON `{ script: string, filename?: string, note?: string, dryRun?: boolean, defaults?: { charset?: string, collation?: string } }`이다. 크기 제한은 업로드와 같다.
  - `:id` 버전이 SQL 출처가 아니거나 stale이면 400을 돌려준다.
  - `dryRun: true`면 `{ applied, summary }`를 돌려준다. `summary`는 기존 비교 요약과 같은 모양이다.
  - 결과 모델을 `printSqlDump`로 출력하고 다시 파싱한 모델을 쓴다. 그래야 저장 모델과 원문 재파싱 모델이 항상 같아서 서버 시작 시 stale로 잘못 표시되지 않는다.
  - "변경 없음" 판정은 모델 해시가 아니라 기존 비교 엔진으로 한다(`diffSchemas(기준, 결과, renames)`의 변경이 0개).
  - 저장할 때는 출력한 텍스트를 원문으로 기존 `ingest` 경로에 넘겨 새 버전을 만든다. `source_filename`은 업로드한 파일 이름 또는 `alter.sql`이다. 같은 트랜잭션에서 아래를 기록한다.
    - (a) `schema_version_derivations` 행
    - (b) 완전성 판정: 기준 버전의 판정 수준과 사유를 복사한다
    - (c) `renames`를 (기준, 새 버전) 쌍의 rename 매핑으로 저장한다(기존 저장 경로와 rename set 표시 재사용)
  - 결과 모델이 기준과 같으면 400("변경 없음")을 돌려준다. 같은 원문이 이미 있으면 기존 중복 규칙대로 duplicate를 돌려준다.
- **서버 시작 시 재판정(`evidence-backfill`):**
  - 파생 버전의 완전성은 원문에서 다시 판정하지 않는다. 기준 버전 사슬을 따라 올라가 첫 비파생 버전의 수준을 쓴다. 기준이 지워졌으면 저장된 값을 유지한다.
  - stale 판정은 기존대로 원문 재파싱과 모델 비교로 한다. 기준 버전이 stale이면 파생 버전도 stale로 표시한다. 사유는 "기준 버전 vN 이 stale"이다.

### 5.3 웹

- 버전 목록(스키마 화면)에 **ALTER 적용** 버튼을 둔다. admin·dba에게만 보인다.
- 대화상자의 구성은 다음과 같다.
  - 기준 버전 선택 (SQL 출처 버전만)
  - 스키마 기본 문자셋·콜레이션 (이 스키마의 마지막 ALTER 적용 값, 없으면 `utf8mb4` / `utf8mb4_0900_ai_ci`)
  - 파일 선택 또는 텍스트 붙여넣기
  - 메모
  - 미리보기 결과
  - 저장
- 실패하면 해당 문장을 강조해서 보여 준다.
- SQL 출처 버전이 없으면 버튼을 보이지 않는다. 기준 버전이 stale 이면(목록에서는 알 수 없다) 서버가 400 으로 이유를 돌려주고 대화상자가 그대로 보여 준다.
- 버전 이력의 배지는 `ALTER 적용 (기준 vN)`이다. 배지를 누르면 스크립트 원문을 보는 패널이 열린다.

## 6. 검증

- **TDD:** 절마다 단위 테스트를 먼저 쓴다(`packages/core/test/apply/*.test.ts`).
- **`test:mysql` ALTER 시나리오:**
  - 위치는 `packages/core/test/fixtures/alter-scenarios/<이름>/`이고, 파일은 `base.sql`(td-export 형식)과 `script.sql`이다. 실패 시나리오에는 `expect-error.txt`(MySQL 오류 번호)를 둔다.
  - 성공 시나리오는 다음을 확인한다.
    - MySQL 8.0/8.4에 `base.sql`을 적용하고 `script.sql`을 mysql 클라이언트로 실행한 뒤, `SHOW CREATE` 결과를 덤프 파서로 읽는다.
    - `applyScript(parse(base), script)` 결과와 비교해 `generateDdl(diffSchemas(ours, mysql))`이 0문장이어야 한다.
    - 반대 방향 비교도 0문장이어야 한다.
  - 실패 시나리오는 MySQL이 거부하고 `applyScript`도 거부해야 한다.
  - 처음 시나리오 묶음은 다음과 같다.
    - 3.1의 각 절
    - 4장의 각 정규화 규칙(타입 별칭, 숫자 기본값, NULL 기본값, timestamp, PK NOT NULL, 자동 인덱스·FK 이름, FK 자동 인덱스)
    - 연쇄 변경(rename 뒤 다른 테이블 FK, 컬럼 삭제와 인덱스 축소)
    - 4.1의 오류 경우
    - 여러 문장이 섞인 실제 사용 예(`samples/v1` 스키마에 여러 ALTER 적용)
- **왕복:** 모든 성공 시나리오에서 `parseSqlDump(printSqlDump(result))`가 `result`와 같은 `modelHash`를 내야 한다.
- **서버:** API 권한(viewer 403, 익명 401), dryRun, 저장, 중복, 변경 없음, MD·stale 기준 거부, 파생 버전 재판정(완전성 상속, 기준 stale 전파), rename 매핑 자동 저장을 테스트한다.
- **CI:** 기존 `test-mysql` 잡이 ALTER 시나리오를 함께 실행한다.

## 7. 범위 밖 (2차 후보)

- 3.2에서 거부한 구문들. VIEW·CHECK·생성 컬럼은 MySQL의 식 정규화를 구현하거나, 서버가 선택적으로 MySQL에 연결해 정규화하는 방식으로 다룰 수 있다.
- MD 출처 기준 버전에 적용
- 여러 스키마에 걸친 스크립트
