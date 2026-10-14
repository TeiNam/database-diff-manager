# ALTER 적용으로 새 버전 만들기 — 설계

작성일: 2026-10-13 · 상태: 구현 완료 (2026-10-14, 계획 docs/superpowers/plans/2026-10-13-alter-apply.md)

## 1. 목적

ALTER 문 몇 개 때문에 실제 DB에 적용하고 td-export로 다시 뽑아 올리는 과정이 번거롭다. 기존 버전의 모델에 ALTER 스크립트를 적용해서 새 버전을 바로 만든다.

- 운영 서버에는 MySQL이 필요 없다. 적용은 `@tdm/core`가 모델 위에서 한다.
- 결과가 실제 MySQL과 같다는 것은 `test:mysql`(로컬·CI)이 보장한다. 같은 스크립트를 MySQL 8.0/8.4에 적용한 결과와 비교한다.
- 지원 범위 밖의 문장은 추측해서 적용하지 않는다. 거부하고 이유를 알려 준다.

## 2. 사용자 흐름

1. 스키마의 버전 목록에서 **ALTER 적용**을 누른다. admin·dba만 보인다.
2. 기준 버전을 고른다. 목록에는 SQL 출처 버전만 나오고, 기본값은 그중 가장 최신 버전이다.
3. 스크립트를 넣는다. `.sql` 파일을 고르거나 텍스트를 붙여 넣는다.
   - **스키마 기본 문자셋·콜레이션**도 확인한다. 문자셋 없이 쓴 `CREATE TABLE`과 문자열을 반환하는 함수에 MySQL은 DB 기본값을 쓰는데, td-export 덤프에는 DB 기본값이 없기 때문이다. 같은 스키마에 ALTER 로 만든 버전이 있으면 그 마지막 입력값이 기본값이다. 없으면 기준 버전 테이블의 `DEFAULT CHARSET`·`COLLATE` 최빈값을 서버가 제안하고, 문자셋을 알 수 있는 테이블이 없으면 MySQL 8.0/8.4 서버 기본값인 `utf8mb4` / `utf8mb4_0900_ai_ci`이다. 문자셋 칸을 바꾸면 콜레이션 칸이 그 문자셋의 기본 콜레이션으로 따라 바뀐다(콜레이션이 이미 그 문자셋의 것이면 그대로 둔다). 입력값은 저장되고, 같은 스키마에서 다음에 열 때 기본값으로 쓴다.
4. **미리보기**를 누르면 서버가 저장하지 않고 적용만 해서 돌려준다.
   - 성공하면 적용한 문장 수와 "기준 → 결과"로 바뀌는 객체의 목록(종류·이름·추가/삭제/변경/이름 변경)을 보여 준다.
   - 실패하면 `N번째 문장 (줄 L): 이유` 메시지를 보여 준다. 특정 문장이 아닌 실패(적용할 문장이 없음 등)는 이유만 보여 준다. 문장 본문은 화면에 나오지 않는다.
5. **저장**을 누르면 새 버전이 생긴다.
   - 버전 이력에는 `ALTER 적용 (기준 vN)` 배지가 붙고, 적용한 스크립트 원문을 볼 수 있다.
   - 메모 칸은 기존 업로드와 같다.

기준 버전 조건은 다음과 같다. 기준 버전 목록에는 SQL 출처 버전만 나온다. 서버도 같은 조건을 검사해, 맞지 않으면 400으로 이유를 돌려주고 대화상자가 그 메시지를 그대로 보여 준다.

| 기준 버전 | 처리 |
|---|---|
| SQL 출처 (ALTER로 만든 버전 포함) | 적용 가능 |
| MD 출처 | 거부: 목록에서 뺀다. 모델 정보가 부분적이라 결과를 MySQL과 맞출 수 없다 |
| stale | 거부: 목록만으로는 알 수 없어 서버가 400으로 거부한다. 저장된 모델이 현재 파서와 다르다. 원문을 다시 올린 버전을 기준으로 쓴다 |

## 3. 지원 범위 (1차)

### 3.1 지원하는 문장

| 분류 | 문장·절 |
|---|---|
| ALTER TABLE 컬럼 절 | `ADD [COLUMN] def [FIRST\|AFTER c]`, `ADD [COLUMN] (def, …)`, `MODIFY [COLUMN]`, `CHANGE [COLUMN] old new def`, `RENAME COLUMN a TO b`, `DROP [COLUMN]`, `ALTER [COLUMN] c SET DEFAULT lit \| DROP DEFAULT \| SET VISIBLE \| SET INVISIBLE` |
| ALTER TABLE 인덱스 절 | `ADD {INDEX\|KEY} [name] (parts) [opts]`, `ADD [CONSTRAINT [sym]] UNIQUE [INDEX\|KEY] …`, `ADD FULLTEXT …`, `ADD SPATIAL …`, `ADD [CONSTRAINT [sym]] PRIMARY KEY (…)`, `DROP {INDEX\|KEY} name`, `DROP PRIMARY KEY`, `RENAME {INDEX\|KEY} a TO b`, `ALTER INDEX name {VISIBLE\|INVISIBLE}` |
| ALTER TABLE 제약 절 | `ADD [CONSTRAINT [sym]] FOREIGN KEY [name] (cols) REFERENCES t (cols) [ON DELETE …] [ON UPDATE …]`, `DROP FOREIGN KEY name`, `DROP CHECK name`, `DROP CONSTRAINT name` |
| ALTER TABLE 테이블 절 | `COMMENT [=] '…'`, `ENGINE [=] InnoDB`(그 밖의 엔진은 거부), `ROW_FORMAT [=] …`, `KEY_BLOCK_SIZE [=] n`, `RENAME [TO\|AS] new`, `ALGORITHM=…`·`LOCK=…`(무시) |
| 단독 문장 | `CREATE [UNIQUE\|FULLTEXT\|SPATIAL] INDEX name ON t (…)`, `DROP INDEX name ON t`, `RENAME TABLE a TO b [, c TO d …]`, `CREATE TABLE [IF NOT EXISTS] …`, `DROP TABLE [IF EXISTS] a [, b …]`, `CREATE FUNCTION/PROCEDURE …`(DELIMITER 포함), `DROP {FUNCTION\|PROCEDURE} [IF EXISTS] …`, `DROP VIEW [IF EXISTS] …` |
| 세션 문장 | `SET FOREIGN_KEY_CHECKS = 0\|1`(`@OLD_…` 저장·복원 포함): 0인 동안은 MySQL처럼 FK 부모 테이블이 없어도 되는 검사(FK 추가 시 부모 없음, 참조되는 테이블 삭제)를 건너뛴다. `SET [SESSION] SQL_MODE = '…'`: 뒤에 만드는 루틴의 SQL_MODE로 쓴다 |
| 무시하는 문장 | `SET NAMES …`, 스키마에 영향이 없는 세션 변수의 `SET`(`time_zone`·`unique_checks` 등), 서버 변수의 `SET`(`SET GLOBAL`·`PERSIST`·`PERSIST_ONLY`, `@@global.x` — 이 스크립트의 세션을 바꾸지 않는다. 앞에 쓴 수식어는 MySQL처럼 뒤 대입에도 이어진다), 트랜잭션 제어(`START TRANSACTION`·`BEGIN`·`COMMIT`·`ROLLBACK`), `LOCK`·`UNLOCK TABLES`, 데이터 문장(`INSERT`·`UPDATE`·`DELETE`·`REPLACE`·`TRUNCATE`), `GRANT`·`REVOKE`, 주석, 현재 스키마와 같은 `USE`. 이미 MySQL에서 돈 스크립트에 흔하고 SHOW CREATE 결과를 바꾸지 않는다(DDL은 MySQL이 암묵적으로 커밋해 `ROLLBACK`이 되돌리지 않는다). 적용한 문장 수에 세지 않는다. 다만 바꾼 구분자를 되돌리지 않았거나(`DELIMITER ;` 없음) `\g`를 써서 한 덩어리에 문장이 여럿 들어 있으면, 뒤 DDL이 함께 버려지지 않도록 무시하지 않고 거부한다 |
| 거부하는 SET | 이후 테이블 정의를 바꾸는 세션 변수(`default_storage_engine`·`explicit_defaults_for_timestamp`·`sql_require_primary_key` 등), 식으로 쓴 세션 `SQL_MODE`(`REPLACE(@@sql_mode, …)`), 알 수 없는 서버 변수 값(`@@global.x`)을 읽는 대입 |

- `CREATE TABLE`의 컬럼 정의 안에 `PRIMARY KEY`, `UNIQUE [KEY]`, `KEY`(PK의 동의어)를 쓰면 인덱스로 바꾼다.
- 컬럼 정의 안의 `REFERENCES …`는 MySQL처럼 무시한다.
- `IF NOT EXISTS`는 대상이 이미 있으면 아무것도 하지 않는다. `IF EXISTS`는 대상이 없으면 아무것도 하지 않는다. MySQL의 경고 동작과 같다.
- 실행 주석(`/*!NNNNN … */`, 번호 없는 `/*!`도)으로 감싼 문장은 안의 문장으로 읽는다. mysqldump 머리·꼬리의 `/*!40101 SET … */;`가 `SET`으로 무시된다. 루틴을 통째로 감싼 꼴(`/*!80000 CREATE FUNCTION … */`)도 닫는 `*/`를 본문에 남기지 않는다(본문 `RETURN 1`, 8.0/8.4 실측). 루틴 정의 안의 실행 주석은 받지 않는다(3.2).
- `DELIMITER` 인자는 mysql 클라이언트처럼 읽는다. 따옴표(`'`·`"`·`` ` ``)로 감쌌으면 짝 따옴표 안, 아니면 첫 공백 앞까지가 구분자이고 줄의 나머지(`-- …`·`# …` 주석)는 버린다. 탭은 인자를 끝내지 않는다(8.4.11 실측). 구분자 덩어리 하나에는 문장 하나(루틴이면 루틴 하나)만 받는다(3.2). 덩어리 끝의 `;`는 문장을 끝낼 뿐이라 떼고 읽는다. 구분자를 되돌리지 않은 파일 끝의 `ALTER …;`·`…;;`도 mysql 클라이언트가 실행한다(8.0/8.4 실측).

### 3.2 거부하는 문장 (1차)

거부하면 이유와 함께 "이 변경은 td-export로 다시 뽑아 올려 주세요"라고 안내한다.

| 구분 | 대상 | 이유 |
|---|---|---|
| 식이 들어가는 정의 | `CREATE/ALTER VIEW`, `CREATE OR REPLACE VIEW`, `CHECK (…)` 추가, 생성 컬럼(`GENERATED ALWAYS AS`, `AS (…)`), 식 기본값 `DEFAULT (…)`, 함수 인덱스 키 파트 `((…))` | MySQL이 식을 다시 써서 저장한다(``(`price` > 0)``, ``select `t`.`a` AS `a` …``). 모델에서 똑같이 만들 수 없다 |
| 문자셋·파티션 | `CONVERT TO CHARACTER SET`, `[DEFAULT] CHARACTER SET=`·`COLLATE=` 테이블 옵션, 파티션 절 전부(`PARTITION BY`, `ADD/DROP/REORGANIZE/COALESCE/TRUNCATE PARTITION`, `REMOVE PARTITIONING`) | 컬럼 상속과 행 이동 규칙이 복잡하다 |
| FK로 이어진 타입 변경 | FK 컬럼 또는 FK가 참조하는 컬럼의 타입·문자셋·콜레이션을 바꾸는 `MODIFY`/`CHANGE` | MySQL이 거부하는 경우(3780)와 허용하는 경우를 1차에서는 가르지 않는다 |
| 기타 | `CREATE TABLE … SELECT`, `CREATE TABLE … LIKE`, `CREATE/DROP TRIGGER·EVENT`, `ALTER DATABASE`, 그 밖에 3.1 표에 없는 문장 | 범위 밖 (데이터 문장·권한·트랜잭션 제어는 3.1처럼 무시한다) |
| 정의 옵션 | FK의 `MATCH FULL\|SIMPLE` 절, 인덱스(`KEY`·`UNIQUE`·`PRIMARY KEY`) 정의의 `KEY_BLOCK_SIZE` | MySQL이 `MATCH`를 읽고 무시한다. 인덱스의 `KEY_BLOCK_SIZE`는 테이블에 `KEY_BLOCK_SIZE`가 있을 때만 저장되고 문장 순서에 따라 달라진다(8.0/8.4 실측) |
| 날짜·시간 기본값의 비표준 꼴 | `DEFAULT '20200101'`, `'2020-1-1'`, `'2020-01-01T10:20:30'`, 숫자 리터럴(`DEFAULT 20200101`), 반올림되는 소수 초 | MySQL이 값을 다시 써서 저장한다. 표준 꼴(`YYYY-MM-DD[ HH:MM[:SS[.f]]]`, `[-]H:MM[:SS[.f]]`)만 다시 쓴다 |
| InnoDB가 아닌 엔진 | `ENGINE=`이 InnoDB가 아닌 `CREATE TABLE`·`ALTER TABLE`, InnoDB가 아닌 기준 테이블을 바꾸는 문장 | 1차는 InnoDB만 지원한다(사용자 결정) |
| 4바이트 문자 | 문자열 리터럴(DEFAULT·COMMENT·ENUM/SET 값)이나 루틴 COMMENT에 U+10000 이상 문자(이모지 등)가 든 문장 | SHOW CREATE가 COMMENT·ENUM·SET 값은 `?`로, 문자열 DEFAULT는 16진수(`0xF09F9880`)로 바꿔 찍는다(8.0/8.4 실측). 루틴 본문은 쓴 그대로라 받는다 |
| 루틴 경계를 MySQL과 같게 가를 수 없는 덩어리 | 구분자 덩어리에 루틴 뒤 다른 문장이 이어진 것(`DELIMITER ;;`를 되돌리지 않은 `RETURN 1; ALTER …`, `END; DROP …`, 루틴 둘, `\g`), 본문이 `BEGIN … END` 하나나 `;` 없는 문장 하나가 아닌 루틴, 루틴 정의 안의 실행 주석(`BEGIN /*!80000 … */ END`) | mysql 클라이언트는 덩어리를 다중 문장으로 보내고 서버는 루틴 뒤 문장을 따로 실행한다. 덩어리 전체를 본문으로 읽으면 뒤 DDL이 조용히 사라진다. 판정은 DDL 생성의 최종 단일 문장 검사와 같다. 실행 주석은 MySQL이 표지를 지운 본문으로 저장한다(8.0/8.4 실측) |
| 문장이 여럿 든 덩어리 | 루틴이 아닌 문장의 구분자 덩어리에 다른 문장이 이어진 것: 바꾼 구분자 대신 `;`로 끝낸 문장(`DELIMITER $$` 뒤 `DROP PROCEDURE IF EXISTS p;` 다음 줄의 `CREATE PROCEDURE … $$`), 되돌리지 않은 `DELIMITER` 뒤의 `CREATE TABLE IF NOT EXISTS …; ALTER …;`, `\g`·`\G` 같은 클라이언트 명령 | mysql 클라이언트는 덩어리의 문장을 모두 실행한다(8.0/8.4 실측: 이미 있는 테이블의 `CREATE TABLE IF NOT EXISTS` 뒤 `ALTER`·`DROP`도 실행된다). 첫 문장만 읽으면 뒤 DDL이 조용히 사라진다. 무시하는 문장도 같다(3.1) |
| ENUM·SET의 숫자 기본값 | `ENUM('2','1') DEFAULT 1`, `SET('2','a') DEFAULT 2`, `DEFAULT TRUE` | MySQL이 숫자를 값이 아니라 순번·비트로 읽는다(8.0/8.4 실측: `'2'`, `'a'`). 값은 따옴표로 쓴다 |
| 멤버 비교를 재현하지 않는 ENUM·SET 기본값 | 글자까지 같은 멤버가 없는데 언어별 콜레이션(`utf8mb4_turkish_ci`·`utf8mb4_tr_0900_ai_ci`·`utf8mb4_roman_ci`·`big5_chinese_ci` 등 4장 목록 밖)이나 ASCII가 아닌 글자로 견줘야 하는 값(`ENUM('i','ı') COLLATE utf8mb4_turkish_ci DEFAULT 'I'`, `ENUM('café') DEFAULT 'cafe'`) | MySQL은 콜레이션 규칙으로 멤버를 찾는다(8.0/8.4 실측: 터키어 `'I'`→`'ı'`, 로마 `'J'`→`'i'`, `big5_chinese_ci`의 `` '`' ``→`'E'`, `utf8mb4_0900_ai_ci`의 `'cafe'`→`'café'`). 언어별 대소문자·악센트 규칙은 재현하지 않는다. 멤버와 같은 글자로 쓴다 |
| BIT의 문자열 기본값 | `BIT(8) DEFAULT '1'`, BIT 컬럼의 `ALTER COLUMN … SET DEFAULT '0'` | MySQL이 문자열을 수가 아니라 글자의 바이트로 저장한다(8.0/8.4 실측: `BIT(8) DEFAULT '1'`→`b'110001'`, `BIT(1) DEFAULT '0'`→1067). 숫자나 `b'…'`로 쓴다 |
| 함수 식 UNIQUE 키의 순서를 정할 수 없는 문장 | 기준 테이블의 함수 식 UNIQUE 키(`UNIQUE KEY ((ifnull(a,0)))`)와 자리가 그 식의 NULL 허용 여부에 따라 갈리는 키를 더하거나 바꾸는 문장(NULL 허용 UNIQUE 추가, 식이 쓰는 컬럼의 정의 변경 등) | 식의 NULL 허용은 식에 따라 다르다(`IFNULL(a,0)`은 NOT NULL, `NULLIF(a,0)`은 NULL 허용). 짐작하지 않는다(4장 키 순서) |
| YEAR·DECIMAL 기본값의 비표준 꼴 | YEAR 기본값의 한두 자리(`20`, `'0'`, `0001`)와 `'+2020'`·`2020.5`, 가수가 15자리를 넘거나 지수가 70을 넘는 DECIMAL 지수 표기 | MySQL이 세기를 붙이거나(`20`→`'2020'`, `70`→`'1970'`) DOUBLE을 거쳐 값을 다시 쓴다 |
| 다른 스키마 | 다른 스키마를 한정한 이름(`other.t`), 다른 스키마로의 `USE` | 버전은 스키마 하나를 나타낸다. 현재 스키마 이름으로 한정한 경우(`cur.t`, 루틴 `cur.f` 포함)는 허용한다 |
| FLOAT·DOUBLE 기본값의 비표준 꼴 | MySQL이 반올림하거나 지수 표기로 다시 쓰는 값: (M,D)가 없을 때 유효숫자가 FLOAT 6·DOUBLE 15자리를 넘는 값, 지수 표기로 찍히는 값(`1e15`, `0.0000000000000001`), `-0`. (M,D)가 있을 때 소수 D자리 밖에 숫자가 있는 값, FLOAT 정밀도로 바뀌는 값, 찍는 자릿수가 DOUBLE 15자리를 넘는 값 | MySQL이 이진 부동소수점 값을 다시 찍는다(4장) |
| 테이블 문장을 다르게 읽게 하는 SQL_MODE | `REAL_AS_FLOAT`·`ANSI_QUOTES`(묶음 모드 `ANSI`·`TRADITIONAL`과 같이), 문장 나누기와 다르게 읽은 `NO_BACKSLASH_ESCAPES`(`SET @@sql_mode`·`:=`·`@변수`·큰따옴표·`SET GLOBAL` 꼴) 뒤의 백슬래시가 든 문장, `NO_BACKSLASH_ESCAPES` 세션의 ENUM·SET 값 백슬래시 | `REAL`을 FLOAT로, `"…"`를 식별자로 읽는 규칙을 모델에 반영하지 않는다. 문장 나누기는 `SET SQL_MODE = '…'` 꼴만 따라가므로 다른 꼴에서는 문자열을 MySQL과 다르게 읽는다. ENUM·SET 값은 타입 정규화가 보통 이스케이프 규칙으로 다시 읽는다(같은 세션의 COMMENT·DEFAULT 백슬래시는 MySQL과 같다, 8.4.11 실측) |
| FK가 많은 테이블 | FK가 64개를 넘는 테이블을 만들거나 바꾸는 문장 | MySQL에는 한도가 없지만(테이블 하나에 FK 2,000개면 MySQL도 CREATE TABLE에 16초가 걸린다, 8.4.11 실측) 문장마다 테이블의 FK를 모두 다시 확인하므로, 요청 하나의 계산량을 묶으려고 받지 않는다 |
| 바이트 한도를 넘는 정의 | 키 파트 하나가 3072바이트(`ROW_FORMAT=COMPACT`·`REDUNDANT`는 767바이트)를 넘는 키(FULLTEXT·SPATIAL 제외), 65535바이트를 넘는 `VARCHAR`·`VARBINARY`. 바이트는 글자 수(prefix가 있으면 prefix 길이) × 컬럼 문자셋의 글자당 최대 바이트(utf8mb4 4, utf8mb3 3, latin1 1, 이진 타입 1)다. `ROW_FORMAT`을 쓰지 않은 테이블은 DYNAMIC이다. 문장 끝 테이블의 키를 모두 보므로, 같은 문장의 `ROW_FORMAT` 변경과 `MODIFY`·`CHANGE`로 늘어난 컬럼도 걸린다 | 엄격 SQL_MODE는 1071·1074로 거부하지만, 엄격하지 않은 세션(`SQL_MODE='NO_AUTO_VALUE_ON_ZERO'` 같은 덤프 머리, 5.6 기본값을 둔 서버)은 일반 인덱스의 키 파트를 한도까지의 prefix로 줄이고(utf8mb4 `VARCHAR(769)`의 `KEY (c)`→`c(768)`, COMPACT의 `VARCHAR(192)`→`c(191)`) 긴 `VARCHAR`를 TEXT·BLOB 계열로 바꿔(utf8mb4 `VARCHAR(16384)`→`mediumtext`) 받는다(8.0/8.4 실측, 시나리오 `byte-limits`·`error-key-part-bytes`·`error-key-part-compact`·`error-varchar-bytes`). 쓴 그대로 저장하면 틀린 모델이 되므로 SQL_MODE와 상관없이 거부한다 |

## 4. MySQL 정규화 규칙

적용 결과는 MySQL이 같은 스크립트를 실행한 뒤의 `SHOW CREATE` 모양과 같아야 한다. 판정 기준은 "기존 비교 엔진(`diffSchemas` + `generateDdl`)으로 비교했을 때 DDL 문장이 0개"이다. 아래 규칙은 각각 `test:mysql` 시나리오로 MySQL 8.0과 8.4에서 확인한다. 두 버전의 동작이 다르면 8.4를 따르고 그 차이를 시나리오에 적는다.

- **이름 비교:** 테이블 이름은 대소문자를 구분한다(Linux 기본 `lower_case_table_names=0`과 같다). 컬럼·인덱스·제약 이름은 구분하지 않는다.
- **이름 표기:** 결과에 어느 표기가 남는지는 시나리오로 확인한 MySQL 동작을 따른다.
  - 8.0/8.4 실측: MySQL 은 받고 쓴 표기가 이긴다(`MODIFY NAME …` → 컬럼 `NAME`, 인덱스 파트도 따라간다). 참조(`AFTER`·키 파트·`DROP COLUMN`·`ALTER COLUMN`)는 대소문자를 무시하고 정의의 원래 표기를 쓴다.
  - 대소문자만 다른 이름으로 바꾸는 `CHANGE name NAME …`·`RENAME COLUMN name TO NAME`·`RENAME INDEX a TO A`는 MySQL과 같게 새 표기로 바꾼다(rename 매핑 `name→NAME`). 같은 일을 하는 `MODIFY NAME …`만 드문 꼴이라 거부하고 이름을 바꾸려면 `CHANGE`를 쓰라고 안내한다(사용자 결정: 희귀 케이스는 받지 않는다).
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
  - NULL 허용 컬럼에 기본값이 없으면 `DEFAULT NULL`을 붙인다. TEXT·BLOB 계열은 붙이지 않는다(명시한 `DEFAULT NULL`도 SHOW CREATE 에 보이지 않는다). JSON 은 붙인다(td-export 실출력 `json DEFAULT NULL`). GEOMETRY 계열도 NULL 허용이면 붙인다(8.0/8.4 실측, 시나리오 `column-geometry`).
  - 리터럴 기본값은 TEXT·BLOB·JSON·GEOMETRY 계열에 쓸 수 없다(MySQL 1101).
  - 날짜·시간 기본값은 MySQL이 값을 다시 써서 저장한다(8.0/8.4 실측, 시나리오 `temporal-defaults`). `DATETIME DEFAULT '2020-01-01'`은 `'2020-01-01 00:00:00'`, `DATETIME(3) DEFAULT '2020-01-01 10:20:30'`은 `'2020-01-01 10:20:30.000'`, `TIME DEFAULT '12:34'`는 `'12:34:00'`이다. 음수 TIME은 소수 초까지 쳐서 0이 아니면 부호가 남는다(`TIME(3) DEFAULT '-00:00:00.123'`은 그대로, `'-00:00:00.000'`은 `'00:00:00.000'`). TIME의 시는 값으로 찍어 앞의 0은 두 자리까지만 남는다(`'001:02:03'`→`'01:02:03'`, `'100:00:00'`은 그대로). 표준 꼴만 다시 쓰고(3.2), 없는 날짜(`2020-02-30`)·`0000-00-00`·시각 범위 밖은 1067이다. `0000-00-00`은 `NO_ZERO_DATE`가 꺼진 `SQL_MODE`에서는 MySQL이 받지만 1차는 받지 않는다.
  - `timestamp`는 `explicit_defaults_for_timestamp=ON`(8.0 기본) 규칙을 따른다.
  - PRIMARY KEY에 들어간 컬럼은 NOT NULL이 되고, `DEFAULT NULL`은 사라진다. 다른 기본값은 남는다. `NULL`이나 `DEFAULT NULL`을 직접 쓴 컬럼이 PRIMARY KEY에 들어가면 1171이다(컬럼 안 `DEFAULT NULL PRIMARY KEY`만 1067).
  - AUTO_INCREMENT 컬럼은 `NULL`을 써도 NOT NULL이 된다. `DEFAULT NULL`은 받되 남지 않고, 다른 기본값은 1067이다. `ALTER COLUMN … SET DEFAULT 5`는 받지만 SHOW CREATE에 찍히지 않으므로 저장하지 않는다.
  - `ALTER COLUMN … DROP DEFAULT`는 DEFAULT 절을 없앤다. NULL 허용 컬럼에도 `DEFAULT NULL`이 남지 않는다(8.0/8.4 실측).
  - `SET DEFAULT`는 생성 컬럼이면 1221, TEXT·BLOB·JSON·GEOMETRY 계열이면 `NULL`이어도 1101이다.
  - FLOAT·DOUBLE AUTO_INCREMENT는 8.4가 1063으로 거부하므로 8.0에서도 거부한다(`MySQL 8.4 1063`). 기준 덤프에 이미 있는 컬럼은 다시 검사하지 않는다.
  - STORED 생성 컬럼은 `AS` 없는 `MODIFY`·`CHANGE`로 일반 컬럼이 된다. VIRTUAL은 3106이다.
  - YEAR 기본값은 네 자리 연도(1901~2155)와 `0000`만 그대로 저장한다. 범위 밖(`1900`, `2156`, 세 자리, 다섯 자리 이상)은 1067이다(8.0/8.4 실측).
  - DECIMAL 기본값은 정확한 십진수로 scale 자리에 맞춘다. 반올림은 0에서 먼 쪽이다(`2.5`→`3`, `-2.5`→`-3`, `1.005`→`1.01`). 정수부가 `정밀도-scale` 자리를 넘으면(반올림해서 넘는 경우 포함) 1067이다(8.0/8.4 실측).
  - FLOAT·DOUBLE 기본값은 MySQL이 이진 부동소수점 값을 다시 찍는다(8.0/8.4 실측, 시나리오 `float-defaults`·`error-float-default`).
    - (M,D)가 없으면 FLOAT는 유효숫자 6자리로(`3.14159265`→`'3.14159'`, `1234567`→`'1234570'`), DOUBLE은 가장 짧은 표기로 찍는다. `f` 표기가 FLOAT 12자·DOUBLE 24자(음수는 한 자 적게)를 넘거나, DOUBLE의 소수점 위치가 범위 밖(1e15 이상·1e-15 미만)이면 지수 표기다(`1e15`, `1.2345678912e-13`). 유효숫자가 FLOAT 6·DOUBLE 15자리 이하이고 `f` 표기로 찍히는 값만 그 표기로 저장한다(`'1.50'`→`'1.5'`, `1e14`→`'100000000000000'`). 나머지와 `-0`(쓴 꼴에 따라 `'-0'`·`'0'`)은 거부한다.
    - (M,D)는 D가 30 이하(1425), D가 M 이하(1427), M이 1~255(1439)여야 한다(8.0/8.4 실측, 검사 순서도 같다). 기본값을 찍기 전에 본다. 기준 덤프 컬럼에 `SET DEFAULT`를 써도 같다.
    - (M,D)가 있으면 소수 D자리로 0을 채운다(`DOUBLE(10,2) DEFAULT 0`→`'0.00'`, `FLOAT(7,3) DEFAULT 1.5`→`'1.500'`). 정수부가 M-D자리를 넘으면 1067이다. D자리 밖 숫자는 이진 값의 소수부를 반올림해(`1.005`→`'1.00'`, `DOUBLE(10,0)`의 `1.5`→`'1'`) 십진 반올림과 달라 거부한다. FLOAT는 float로 바꾼 오차가 마지막 자리 단위의 1/4 이하일 때만(`FLOAT(10,2)`의 `123456.78`은 받고 `1234567.89`→`'1234567.88'`은 거부), DOUBLE은 찍는 자릿수가 15 이하일 때만 받는다.
  - BIT 기본값은 앞쪽 0을 뗀다(`b'00000101'`→`b'101'`, `b'00000000'`→`b'0'`, 8.0/8.4 실측). 숫자와 `b'…'`만 받는다(문자열은 3.2).
  - CHAR 기본값은 끝 공백(U+0020)을 뗀다(`CHAR(5) DEFAULT 'ab  '`→`'ab'`, `CHAR(1) DEFAULT ' '`→`''`, 8.0/8.4 실측). 앞 공백·탭과 VARCHAR는 그대로다.
  - 문자열 컬럼(CHAR·VARCHAR·BINARY·VARBINARY)에 쓴 숫자 리터럴은 MySQL이 수로 읽은 뒤 글자로 바꿔 저장한다. 정수부 앞 0을 떼고, 소수부는 쓴 그대로 두며(빈 소수부는 점까지 뗀다), 값이 0이면 부호를 뗀다(`001`→`'1'`, `001.50`→`'1.50'`, `1.`→`'1'`, `-0.0`→`'0.0'`, 8.0/8.4 실측, 시나리오 `string-number-defaults`). ENUM·SET의 숫자 기본값은 거부한다(3.2).
  - ENUM·SET 기본값은 컬럼의 실제 콜레이션으로 멤버를 찾아 멤버의 표기로 저장한다. 테이블에서 물려받은 콜레이션도, SHOW CREATE에 콜레이션이 찍히지 않는 기본 문자셋 binary 테이블의 컬럼도 같다. MySQL은 멤버를 하나씩 견주어 처음 같은 멤버를 쓴다. 그 비교를 재현할 수 있을 때만 판정한다(8.0/8.4 실측, 시나리오 `enum-set-collation-defaults`·`error-enum-collation-default`·`enum-collation-rules`).
    - binary 문자셋·`_bin`: 글자가 같은 멤버만 맞는다(`ENUM('a','A') COLLATE utf8mb4_bin`의 `SET DEFAULT 'A'`는 `'A'`, `ENUM('a','b') COLLATE utf8mb4_bin DEFAULT 'A'`는 1067).
    - 표준 `_ci`: 값과 멤버가 모두 ASCII(탭~CR, 0x20~0x7E)이면 대소문자만 무시한다(`DEFAULT 'B'`→`'b'`). 대소문자만 다른 멤버가 둘이면(엄격하지 않은 세션에서 만든 컬럼) 처음 것이다(`'A'`→`'a'`). 실측한 목록은 `<문자셋>_general_ci`·`_unicode_ci`·`_unicode_520_ci`(utf8mb4·utf8mb3·ucs2·utf16·utf32), `utf8mb4_0900_ai_ci`·`utf8mb4_0900_as_ci`, `latin1_swedish_ci`·`latin1_general_ci`·`euckr_korean_ci` 등 ASCII를 대소문자로만 견주는 콜레이션이다(`enum-member.ts`). 문자셋의 기본 콜레이션이어도 `big5_chinese_ci`·`gbk_chinese_ci`·`gb2312_chinese_ci`(`'Y'`=`'~'`)·`koi8u_general_ci`는 아니다.
    - 표준 `_cs`(`utf8mb4_0900_as_cs`·`latin1_general_cs`·`cp1251_general_cs`): ASCII이면 글자가 같아야 한다.
    - 그 밖(언어별 콜레이션, ASCII가 아닌 값·멤버)은 글자까지 같은 멤버만 받고 나머지는 거부한다(3.2). 멤버끼리는 콜레이션으로도 다르다고 본다. 엄격 SQL_MODE는 같은 멤버를 1291로 거부한다. 한계: 엄격하지 않은 세션에서 콜레이션으로 같은 멤버를 둔 정의(`ENUM('e','é')`, MySQL은 note 1291만 남긴다)의 `DEFAULT 'é'`는 MySQL이 앞의 `'e'`를 쓰는데 `'é'`로 둔다.
  - 문자열 리터럴의 `\%`·`\_`는 백슬래시를 남긴 두 글자로 읽는다(MySQL과 같다, 8.0/8.4 실측). 그 밖의 모르는 이스케이프(`\q`)는 백슬래시만 버린다.
- **문자셋:**
  - 새 문자열 컬럼(그리고 문자셋 없이 쓴 `MODIFY`·`CHANGE`)은 테이블 기본 문자셋·콜레이션을 물려받는다. 예전 컬럼의 문자셋을 물려받지 않는 것도 MySQL과 같다.
  - 저장 표기는 `SHOW CREATE` 규칙을 따른다(8.0/8.4 실측). 컬럼에 `CHARACTER SET`이나 `COLLATE`를 하나라도 쓰면 둘 다 붙는다. 문자셋만 쓰면 그 문자셋의 기본 콜레이션, `COLLATE`만 쓰면 그 콜레이션의 문자셋이다. 둘 다 안 쓰면 테이블 기본을 물려받고, 콜레이션이 그 문자셋의 기본 콜레이션이 아닐 때만 `COLLATE`를 붙인다.
  - `CHARACTER SET binary`·`COLLATE binary`는 MySQL이 타입을 VARBINARY·BLOB으로 바꾸므로 1차에서 거부한다. 기본 문자셋이 binary인 기준 테이블에 문자셋 없이 더하거나 바꾼 CHAR·VARCHAR·TEXT도 MySQL이 BINARY·VARBINARY·BLOB으로 바꾸므로 거부한다(8.0/8.4 실측: `VARCHAR(10)`→`varbinary(10)`, ENUM·SET은 그대로다).
  - 새 테이블은 옵션에 쓴 문자셋·콜레이션을 쓰고, 없으면 2장의 스키마 기본값을 쓴다. 문자셋만 쓰면 그 문자셋의 기본 콜레이션, 콜레이션만 쓰면 그 콜레이션의 문자셋이다.
  - 테이블 옵션 표기(8.0/8.4 실측): `SHOW CREATE TABLE`은 utf8mb4의 콜레이션은 늘 찍고(기본 `utf8mb4_0900_ai_ci`도), 그 밖의 문자셋은 콜레이션이 그 문자셋의 기본이면 `COLLATE`를 찍지 않는다. 예를 들어 `DEFAULT CHARSET=utf8`은 `DEFAULT CHARSET=utf8mb3`이고, `utf8_unicode_ci`는 `DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_unicode_ci`이다(시나리오 `create-table-charsets`·`schema-defaults-latin1`).
- **자동 이름:**
  - 이름 없는 인덱스·UNIQUE는 첫 키 파트의 컬럼 이름을 쓴다. 이미 있으면 `_2`, `_3`…을 붙인다.
  - 이름 없는 FK는 `<테이블>_ibfk_<N>`이다. N은 문장 앞 FK 이름(그 문장에서 지우는 것 포함)의 최댓값+1부터, 이름 없이 더한 FK마다 1씩 는다. 직접 쓴 `_ibfk_N` 이름은 세지 않고, 겹치면 1826이다. 같은 문장에서 지운 FK와 같은 이름의 FK도 1826이다(다시 만들려면 문장을 둘로 나눈다).
  - FK 목록은 이름을 소문자로 바꾼 코드 포인트 순이다(SHOW CREATE). FK를 더하거나 테이블 이름을 바꾼 문장에서만 다시 정렬한다. 라틴 확장·그리스·키릴 문자가 든 이름끼리의 순서는 재현하지 못한다.
  - FK에 쓸 수 있는 인덱스(FK 컬럼이 앞부분과 같은 인덱스)가 없으면 인덱스를 자동으로 만든다. 이름은 CONSTRAINT 이름, `FOREIGN KEY` 뒤 인덱스 이름, 첫 컬럼 이름(겹치면 `_2`…) 순으로 정한다. 앞의 두 이름이 기존 인덱스와 겹치면 1061(`PRIMARY`는 1280)이다.
  - 자동 인덱스는 다른 키가 같은 앞쪽 파트를 가지면 MySQL이 조용히 지우거나 새 자동 인덱스로 바꾼다. FK가 남아 있어도 그렇다(MySQL `foreign_key_prefix`).
  - 자동 인덱스라는 표시는 SHOW CREATE에 나오지 않는다. 한 번의 적용 안에서 만들었거나 FK만 지워서 남은 자동 인덱스는 출처를 따라가 MySQL과 같게 처리한다. 덤프의 인덱스는 이름으로 가린다.
    - FK 이름과 같은 인덱스는 자동으로 본다. 직접 만든 `KEY f` + `CONSTRAINT f`도 자동으로 보는 한계가 있다.
    - 그 밖의 인덱스는 직접 만든 것으로 본다. FK 이름이 `<테이블>_ibfk_N` 꼴이고 인덱스 이름이 FK의 첫 컬럼(`_N` 포함)이면 덤프만으로는 자동인지 알 수 없지만 직접 만든 것으로 본다(사용자 결정: FK 컬럼으로 시작하는 복합 인덱스 추가·FK 이름 정리 같은 흔한 마이그레이션을 막지 않는다). 덤프를 MySQL에 다시 만든 DB에서는 그 인덱스가 직접 만든 것이라 MySQL도 남긴다(시나리오 `fk-first-column-index`).
    - 한계: 직접 만든 것으로 본 인덱스가 실제로는 MySQL이 FK와 함께 자동으로 만든 것이면(FK만 써서 만든 라이브 스키마) MySQL은 같은 컬럼으로 시작하는 새 키·FK가 오는 문장에서 그 인덱스를 지우거나 바꾸는데, 모델은 남긴다. `FOREIGN KEY ix_g (…)`로 이름을 정한 자동 인덱스, 기준 덤프나 앞선 업로드에서 FK가 이미 지워져 남은 자동 인덱스도 같다. 파생 버전 사이에서도 같다: 한 번의 적용 안에서 만든 자동 인덱스의 출처는 저장하지 않으므로, 저장한 뒤 다음 ALTER 적용에서는 위 이름 규칙으로 다시 가린다.
  - 키 순서는 MySQL 규칙(PRIMARY, UNIQUE, 일반, FULLTEXT 무리)을 따르고, VIRTUAL 생성 컬럼·함수 파트가 든 키는 같은 무리 안에서 맨 뒤로 간다.
    - 함수 식 파트의 NULL 허용은 짐작하지 않는다. 컬럼 파트가 NULL 허용이면 키도 NULL 허용이고, 아니면 모른다. 모르는 값에 따라 순서가 갈리는 두 UNIQUE 키는 둘 다 문장 앞부터 있던 키이고 순서를 정하는 속성(파트 컬럼의 타입·NULL 허용·길이, 식이 쓰는 컬럼의 정의)이 이 문장에서 그대로면 원래 순서를 지킨다. MySQL이 정렬한 목록을 다시 정렬해도 같기 때문이다. 그 밖에는 거부한다(3.2, 8.0/8.4 실측, 시나리오 `functional-unique-order`).
  - 위 이름 규칙은 8.0/8.4 실측이고, 시나리오 `foreign-keys`·`keys-measured`·`alter-measured`·`error-fk-auto-index-name`·`fk-first-column-index`가 고정한다.
- **FK 옵션 표기:** `ON DELETE|UPDATE NO ACTION`은 저장하지 않는다. `SHOW CREATE`가 찍지 않기 때문이다(`RESTRICT`는 찍는다, 8.0/8.4 실측). MySQL Workbench 같은 ERD 도구가 늘 쓰는 꼴이다.
- **연쇄 변경:**
  - 컬럼을 지우면 그 컬럼을 인덱스에서 빼고, 빈 인덱스는 지운다.
  - 같은 문장에서 지운 컬럼을 같은 이름으로 다시 더하면 키 파트가 새 컬럼을 따라간다. 타입 모양이 달라지면 MySQL이 옛 키 파트의 바이트 길이를 prefix로 넘기므로, 1차에서는 거부하고 다시 추출하도록 안내한다.
  - 컬럼을 바꾼 뒤 기존 키 파트의 prefix가 새 길이 이상이거나 새 타입이 prefix를 가질 수 없으면 prefix를 지운다(MySQL이 조용히 지운다). 길이 없는 키 파트의 컬럼이 TEXT·BLOB이 되면 1170, JSON이 되면 3152, FULLTEXT의 컬럼이 문자열이 아니게 되면 1283이다.
  - `FIRST`·`AFTER`는 절 순서대로 하나씩 처리한다. 그 시점에 없는 컬럼을 `AFTER`로 가리키면 1054다.
  - `RENAME COLUMN`·`CHANGE`로 이름이 바뀌면 같은 테이블의 인덱스·FK와, 그 컬럼을 참조하는 다른 테이블의 FK `refColumns`를 바꾼다.
  - `RENAME TABLE`은 다른 테이블 FK의 `refTable`을 바꾼다. 뷰 본문은 바꾸지 않는다. MySQL도 바꾸지 않는다.
  - 기존 CHECK(td-export 덤프에 있다, 추가는 3.2에서 거부):
    - 8.0/8.4 실측: 컬럼을 지우면 그 컬럼만 쓰는 CHECK는 함께 사라진다(이름을 직접 붙인 것도, 같은 이름으로 다시 더해도 같다). 다른 컬럼도 쓰는 CHECK는 그 컬럼들을 모두 지워도 3959이고, 같은 문장에서 그 CHECK를 지우면 된다. 이름을 바꾸는 `RENAME COLUMN`·`CHANGE`는 하나의 컬럼만 쓰는 CHECK도 3959이다.
    - `SHOW CREATE`는 CHECK를 이름 순(FK와 같은 소문자 코드 포인트 순)으로 찍는다. 테이블 이름을 바꿔 자동 이름 `<테이블>_chk_N`이 바뀌면 다시 정렬한다(시나리오 `check-columns`).
  - 파티션된 기준 테이블(파티션 절 자체는 3.2에서 거부하지만 덤프에는 있다): 8.0/8.4 실측으로 파티션 식이 쓰는 컬럼을 지우거나 이름을 바꾸면 3855이고, PRIMARY KEY·UNIQUE가 파티션 컬럼을 (prefix 없이) 모두 포함하지 않으면 1503이다. 파티션 절은 그대로 둔다(시나리오 `partitioned-base`).
- **루틴:**
  - 본문은 쓴 그대로 저장한다. MySQL의 `SHOW CREATE FUNCTION`도 그렇다. 다만 `DELIMITER`를 `;`가 아닌 것으로 바꾸고 `RETURN x + 1; //`처럼 끝에 `;`를 함께 쓰면 MySQL은 그 `;`를 본문에 넣지 않는다(8.0/8.4 실측: 공백이 끼어도 `;`가 여럿이어도 같고, 뒤에 주석이 따르는 `;`는 남는다). 같은 규칙으로 끝의 `;`를 뗀다(시나리오 `routine-terminator`).
  - `sqlMode`는 스크립트에서 그 문장 앞의 마지막 `SET [SESSION] SQL_MODE` 값을 쓴다. 없으면 MySQL 8.0/8.4 기본 모드(`ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION`)를 쓴다. 모드 이름은 MySQL 순서로 정렬하고 중복을 지운다(SHOW CREATE 의 `sql_mode` 표기). 묶음 모드(`ANSI`·`TRADITIONAL`)와 테이블 문장을 다르게 읽게 하는 `REAL_AS_FLOAT`·`ANSI_QUOTES`는 거부하고 다시 추출하도록 안내한다(3.2).
  - DEFINER는 저장하지 않는다. 비교 대상이 아니다.
  - 함수의 `RETURNS` 타입은 타입 규칙으로 정규화한다. 문자열 타입이면 MySQL처럼 ` CHARSET <스키마 기본 문자셋>`을 붙이고, 스키마 기본 콜레이션이 그 문자셋의 기본(`utf8mb4_0900_ai_ci`·`latin1_swedish_ci`·`utf8mb3_general_ci` …)이 아니면 ` COLLATE <콜레이션>`도 붙인다(8.0/8.4 실측, 시나리오 `schema-defaults-unicode`). `RETURNS` 안에 `CHARSET`·`COLLATE`를 직접 쓴 경우는 1차에서 거부한다.
- **테이블 옵션:**
  - `ENGINE` 값은 MySQL 표기로 맞춘다(`innodb`→`InnoDB`). `ROW_FORMAT`은 대문자로 쓴다. `ROW_FORMAT=DEFAULT`·`KEY_BLOCK_SIZE=0`은 옵션을 지운다(8.0/8.4 실측, 시나리오 `table-options`).
  - `COMMENT=''`이면 옵션을 지운다. 인덱스 정의(`ADD INDEX`·`CREATE INDEX`·`CREATE TABLE`의 키)의 `COMMENT ''`도 남기지 않는다. SHOW CREATE가 빈 인덱스 COMMENT를 찍지 않는다(8.0/8.4 실측, 시나리오 `index-empty-comment`).
  - `AUTO_INCREMENT=n`은 비교에서 무시되므로 기준 값을 그대로 둔다.
  - InnoDB 테이블만 지원한다(사용자 결정). `ENGINE`을 InnoDB가 아닌 것으로 만들거나 바꾸는 문장, 그리고 InnoDB가 아닌 기준 테이블을 바꾸는 `ALTER TABLE`·`CREATE INDEX`·`DROP INDEX`는 거부하고 다시 추출하도록 안내한다. `DROP TABLE`·`RENAME TABLE`은 받는다. `ENGINE` 옵션이 없는 테이블은 InnoDB로 본다.

### 4.1 오류로 처리하는 경우

MySQL이 오류를 내는 다음 경우는 적용을 실패시킨다.

- **없는 대상:** 테이블·컬럼·인덱스·FK·CHECK를 바꾸거나 지우려 할 때(`IF EXISTS`는 제외)
- **중복 이름:** 같은 이름의 컬럼·인덱스·FK·테이블을 만들려 할 때(`IF NOT EXISTS`는 제외)
- **마지막 컬럼:** 테이블의 마지막 컬럼을 지우려 할 때
- **FK가 쓰는 대상:** FK가 쓰는 컬럼을 지우거나(1828), FK가 필요로 하는 인덱스를 지우려 할 때(1553)
- **FK 부모:** 다른 테이블 FK가 참조하는 테이블을 지우려 할 때(3730). 같은 문장 안에서 함께 지우는 경우는 제외한다.
- **AUTO_INCREMENT:** 키가 없는 AUTO_INCREMENT 컬럼(1075), AUTO_INCREMENT 컬럼이 둘 이상인 경우
- **PK 중복:** PRIMARY KEY를 두 번 정의할 때(1068)
- **FK 정의:** 없는 컬럼이나 테이블을 참조하는 FK. 참조 컬럼의 타입이 다른 FK(3780). 자기 테이블을 참조하는 FK의 부모 키(8.4 6125)는 문장의 키를 모두 더한 뒤 본다. 그래서 CREATE TABLE은 PRIMARY KEY·UNIQUE를 FK 뒤에 써도 받는다. ALTER TABLE은 InnoDB가 참조 컬럼의 인덱스를 문장 앞 테이블에서 찾으므로, 같은 문장에서 더한 키만 있으면 절 순서와 상관없이 1215다(8.0/8.4 실측, 시나리오 `self-fk-key-order`·`error-self-fk-same-alter`)
- **키 파트:** TEXT·BLOB 키 파트에 prefix 길이가 없을 때(1170)
- **NULL과 키:** PRIMARY KEY 컬럼에 NULL을 직접 쓸 때(1171). `ON DELETE`·`ON UPDATE SET NULL` FK의 컬럼이 NOT NULL이 될 때(1830). `ADD PRIMARY KEY`가 컬럼을 NOT NULL로 만드는 경우도 포함한다.
- **한 문장의 두 번째 참조:** 한 문장에서 같은 컬럼을 두 번 바꿀 때(1054), 같은 컬럼을 두 번 지울 때(1091)
- **CHECK:** 다른 컬럼도 쓰는 CHECK가 걸린 컬럼을 지울 때, CHECK가 쓰는 컬럼의 이름을 바꿀 때(3959)
- **파티션:** 파티션 식이 쓰는 컬럼을 지우거나 이름을 바꿀 때(3855), PRIMARY KEY·UNIQUE가 파티션 컬럼을 모두 포함하지 않을 때(1503)
- **날짜·시간 기본값:** 없는 날짜·시각, `0000-00-00`(1067)
- **8.4 규칙:** 8.4만 거부하는 문장은 8.0에서도 거부하고, 메시지에 `MySQL 8.4 NNNN`으로 적는다. 예: FLOAT·DOUBLE AUTO_INCREMENT(1063), 고유 키가 아닌 키를 참조하는 FK(6125)
- **테이블 한도:** 키(PRIMARY·FK 자동 인덱스 포함)가 64개를 넘을 때(1069 — 없는 컬럼 1072보다 먼저), 컬럼이 1017개를 넘을 때(1117) (8.0/8.4 실측). 이 한도로 테이블 하나를 다루는 계산량도 묶인다(5.1)

MySQL의 모든 검사를 재현하지는 않는다. 화면 안내와 이 문서에 "실제 DB에 적용했을 때 MySQL이 거부할 수 있는 스크립트를 이 도구가 받아들일 수 있다"고 적는다. 예를 들어 키 전체 길이 한도(키 파트 합 3072바이트, 1071)나 행 크기 한도(1118) 검사는 하지 않고, TIMESTAMP의 표현 범위(서버 시간대에 따라 달라진다)도 보지 않는다. 두 한도는 엄격하지 않은 세션에서도 MySQL이 거부하므로 모델이 조용히 틀어지지 않는다. 키 파트 하나와 `VARCHAR`의 바이트 한도는 엄격하지 않은 세션이 정의를 바꿔 받으므로 거부한다(3.2).

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
| `print-dump.ts` | `printSqlDump(model): string` — td-export 0.1.52 형식(헤더 주석, `SET @OLD_…`, 테이블·뷰·루틴, 복원 트레일러)으로 출력. 루틴 구분자는 본문에 없는 `;;`·`$$`·`//` 중 앞의 것이고, 셋 다 있으면 본문에 없는 `$$<번호>`(`$$1`, `$$2`, …)다 |

`ApplyResult`의 모양은 다음과 같다.

```ts
type ApplyResult =
  | { ok: true; model: SchemaModel; applied: number; renames: RenameMapping[]; defaults: ApplyDefaults }
  | { ok: false; error: { index: number; line: number; statement: string; reason: string } };
```

- `renames`에는 스크립트의 `RENAME TABLE`·`RENAME COLUMN`·`CHANGE`(이름 변경)·`RENAME INDEX`로 생긴 기준→결과 이름 대응을 기존 `RenameMapping` 형식으로 담는다. 같은 대상의 이름이 여러 번 바뀌면 처음 이름에서 마지막 이름으로 접는다.
- 결과 모델은 덤프 파서가 만드는 모델과 같은 불변식을 지킨다. 예를 들어 `fidelity: 'full'`이고, 정렬과 이름 규칙이 같다. 그래서 `printSqlDump` → `parseSqlDump`가 같은 모델을 돌려주도록 만들었다. 이 왕복은 설계 목표이지 보장이 아니다 — 기준에 이미 있던, 파싱하지 못한 객체나 원문과 다르게 다시 찍히는 객체(`rawDdl`)는 그대로 남는다. 서버가 저장 전에 객체마다 확인한다(5.2). 모든 성공 시나리오에서 테스트로 고정한다.
- **계산량:** 서버 한도(1,000,000자)를 채운 스크립트도 몇 초 안에 끝나야 한다(서버는 한 프로세스라 적용하는 동안 다른 요청이 멈춘다). 테이블 하나의 계산은 키 64개·컬럼 1017개·FK 64개 한도(4.1, 3.2)로 묶고, 문장마다 드는 시간이 스크립트 길이·테이블 수·FK 수에 비례하지 않게 한다(문장 줄 번호, 자동 인덱스 짝 비교, 이름 찾기). 패턴마다 1,000,000자 스크립트가 시간 안에 끝나는지 단위 테스트(`test/apply/apply-performance-*.test.ts`)가 본다.

### 5.2 서버

- **마이그레이션 `009_version_derivations.sql`:**
  - `schema_version_derivations(version_id PK → schema_versions ON DELETE CASCADE, base_version_id → schema_versions ON DELETE SET NULL, base_version_no INTEGER NOT NULL, script TEXT NOT NULL, statement_count INTEGER NOT NULL, default_charset TEXT NOT NULL, default_collation TEXT NOT NULL)`. `base_version_no`는 기준 버전이 지워져도 배지에 `기준 vN`을 보여 주려고 남긴다
- **`POST /versions/:id/alter`:**
  - 권한은 admin·dba이다. `onRequest`에서 검사하는 기존 방식을 따르고 CSRF 헤더도 기존대로 요구한다.
  - 본문은 JSON `{ script: string, filename?: string, note?: string, dryRun?: boolean, defaults?: { charset?: string, collation?: string } }`이다. `script`는 1,000,000자까지, 요청 본문은 4 MiB까지 받는다(`apps/server/src/limits.ts`의 `MAX_ALTER_SCRIPT`·`ALTER_BODY_LIMIT`). JSON 문자열의 따옴표 이스케이프로 본문이 늘어나는 만큼 본문 한도에 여유를 둔다.
  - `:id` 버전이 SQL 출처가 아니거나 stale이면 400을 돌려준다.
  - 스크립트 적용이 실패해도 400이다. 메시지는 `N번째 문장 (줄 L): 이유`이고(특정 문장이 아닌 실패는 이유만), `details.error`에 `{ index, line, statement, reason }`을 담는다.
  - `dryRun: true`면 저장하지 않고 `{ status: 'preview', applied, changes, renames }`를 돌려준다. `changes`는 기준과 결과를 기존 비교 엔진으로 비교해 바뀌는 객체를 모은 목록이고 항목은 `{ kind, name, op }`이다(`kind`는 table·view·function·procedure, `op`는 add·drop·modify·rename). `renames`는 `applyScript`가 모은 이름 대응이다. 저장하면 `{ status: 'ok' | 'duplicate', versionId, versionNo, applied, changes }`를 돌려준다.
  - 결과 모델을 `printSqlDump`로 출력하고 다시 파싱한 모델을 쓴다. 그래야 저장 모델과 원문 재파싱 모델이 항상 같아서 서버 시작 시 stale로 잘못 표시되지 않는다.
  - **안전망:** 다시 파싱한 모델이 적용 결과와 객체마다 같아야 저장한다(미리보기도 같다). 객체 목록이 같아야 하고, 스크립트가 바꾼 객체는 적용 결과와, 건드리지 않은 객체는 기준 버전의 객체와 같아야 한다. 파싱한 객체의 `rawDdl`은 보지 않는다(파생 버전의 원문은 출력한 덤프다). 파싱하지 못한 객체(`parseError`)만은 기준을 그대로 출력·다시 읽은 결과와 비교하고, 그 객체의 경고가 기준을 다시 읽을 때도 똑같이 났으면 받는다. 그래서 기준에 이상한 객체가 있어도 그 객체를 건드리지 않는 ALTER는 쓸 수 있다. 어긋나면 400이고, 이 도구의 출력·읽기가 어긋난 것이라 다시 뽑아 올리라고 안내하지 않는다: 메시지에 어긋난 객체와 요청 ID를 적고, 같은 내용을 서버 로그(warn)에 남긴다(스크립트는 남기지 않는다).
  - "변경 없음" 판정은 모델 해시가 아니라 기존 비교 엔진으로 한다(`diffSchemas(기준, 결과, renames)`의 변경이 0개).
  - 저장할 때는 출력한 텍스트를 원문으로 기존 `ingest` 경로에 넘겨 새 버전을 만든다. `source_filename`은 업로드한 파일 이름 또는 `alter.sql`이다. 같은 트랜잭션에서 아래를 기록한다.
    - (a) `schema_version_derivations` 행
    - (b) 완전성 판정: 기준 버전의 판정 수준과 사유를 복사한다
    - (c) `renames`를 (기준, 새 버전) 쌍의 rename 매핑으로 저장한다(기존 저장 경로와 rename set 표시 재사용)
  - 결과 모델이 기준과 같으면 400("변경 없음")을 돌려준다. 같은 원문이 이미 있으면 기존 중복 규칙대로 duplicate를 돌려준다.
- **`GET /versions/:id/alter-defaults`:**
  - 로그인한 사용자 누구나 읽는다. 기준 버전 테이블의 `DEFAULT CHARSET`·`COLLATE`를 MySQL 표기로 맞춰(문자셋만 있으면 그 기본 콜레이션) 가장 많은 쌍을 `{ defaults: { charset, collation } }`으로 돌려준다. 개수가 같으면 이름순으로 먼저 나온 테이블의 쌍이다. 옵션이 없는 테이블, 알 수 없는 이름·맞지 않는 쌍, `binary`는 세지 않고, 셀 수 있는 테이블이 없으면 `defaults`는 `null`이다.
  - `GET /versions/:id/derivation`은 ALTER 로 만든 버전에만 있어(그 밖은 404) 아직 ALTER 를 적용한 적 없는 스키마의 기준 버전에는 쓸 수 없으므로 따로 둔다.
- **서버 시작 시 재판정(`evidence-backfill`):**
  - 파생 버전의 완전성은 원문에서 다시 판정하지 않는다. 기준 버전 사슬을 따라 올라가 첫 비파생 버전의 수준을 쓴다. 기준이 지워졌으면 저장된 값을 유지한다.
  - stale 판정은 기존대로 원문 재파싱과 모델 비교로 한다. 기준 버전이 stale이면 파생 버전도 stale로 표시한다. 사유는 "기준 버전 vN 이 stale"이다.

### 5.3 웹

- 버전 목록(스키마 화면)에 **ALTER 적용** 버튼을 둔다. admin·dba에게만 보인다.
- 대화상자의 구성은 다음과 같다.
  - 기준 버전 선택 (SQL 출처 버전만)
  - 스키마 기본 문자셋·콜레이션 (이 스키마의 마지막 ALTER 적용 값, 없으면 기준 버전 테이블의 최빈값, 그것도 없으면 `utf8mb4` / `utf8mb4_0900_ai_ci`). 기준 버전 테이블에서 첫 값을 읽는 동안에는 두 칸을 잠그고 미리보기를 막는다. 읽지 못하면 이유를 알리고 MySQL 8 기본값을 채운다. 칸을 한 번 고치면 두 칸 모두 사용자가 정한 값이 되어 기준 버전을 바꿔도 따라가지 않는다
  - 파일 선택 또는 텍스트 붙여넣기
  - 메모
  - 미리보기 결과
  - 저장
- 실패하면 서버가 돌려준 메시지(`N번째 문장 (줄 L): 이유`)만 보여 준다. 문장 본문을 따로 보여 주거나 강조하지는 않는다.
- `.sql` 파일은 UTF-8 로만 읽는다(덤프 업로드와 같다). 다른 인코딩이면 한글 COMMENT·DEFAULT 가 깨진 채 저장되므로 이유를 알리고 지금 스크립트는 그대로 둔다.
- 대화상자는 연 스키마의 것이다. 주소가 다른 스키마로 바뀌면 닫는다. 고른 기준 버전이 목록에서 사라지면(다른 곳에서 지움) 미리보기를 지우고 미리보기·저장을 막은 채 다시 고르게 한다.
- 요청이 가는 동안에는 기준 버전·스키마 기본값·메모 칸을 잠가, 보낸 값과 화면의 값이 어긋나지 않게 한다.
- SQL 출처 버전이 없으면 버튼을 보이지 않는다. 기준 버전이 stale 이면(목록에서는 알 수 없다) 서버가 400 으로 이유를 돌려주고 대화상자가 그대로 보여 준다.
- 버전 이력의 배지는 `ALTER 적용 (기준 vN)`이다. 배지를 누르면 스크립트 원문을 보는 패널이 열린다.

## 6. 검증

- **TDD:** 절마다 단위 테스트를 먼저 쓴다(`packages/core/test/apply/*.test.ts`).
- **`test:mysql` ALTER 시나리오:**
  - 위치는 `packages/core/test/fixtures/alter-scenarios/<이름>/`이고, 파일은 `script.sql`(필수)과 `base.sql`(td-export 형식, 없으면 공용 `_base.sql`)이다. 실패 시나리오에는 `expect-error.txt`(MySQL 오류 번호)를 둔다. `only.txt`(`MySQL 8.4`처럼 그 버전에서만 실행)와 `defaults.json`(스키마 기본 문자셋·콜레이션, DB도 그 값으로 만든다)은 선택이다.
  - 성공 시나리오는 다음을 확인한다.
    - MySQL 8.0/8.4에 `base.sql`을 적용하고 `script.sql`을 문장 나누기(`splitStatements`)로 나눠 mysql2로 한 문장씩 실행한 뒤, `SHOW CREATE` 결과를 덤프 파서로 읽는다. 이미지는 실측한 8.0.46·8.4.11로 고정한다(CI·`docker-compose.test.yml`).
    - `applyScript(parse(base), script)` 결과와 비교해 `generateDdl(diffSchemas(ours, mysql))`이 0문장이어야 한다.
    - 반대 방향 비교도 0문장이어야 한다.
  - 실패 시나리오는 MySQL이 거부하고 `applyScript`도 같은 문장에서 같은 MySQL 오류 번호로 거부해야 한다(`re-export.txt`가 있으면 오류 번호 대신 `RE_EXPORT` 안내).
  - 실행 명령은 `npm run test:mysql -w @tdm/core`이다.
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
