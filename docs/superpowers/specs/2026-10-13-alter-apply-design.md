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
| 세션 문장 | `SET FOREIGN_KEY_CHECKS = 0\|1`(`@OLD_…` 저장·복원 포함): 0인 동안은 MySQL처럼 FK 부모 테이블이 없어도 되는 검사(FK 추가 시 부모 없음, 참조되는 테이블 삭제)를 건너뛴다. `SET [SESSION] SQL_MODE = '…'`: 뒤에 만드는 루틴의 SQL_MODE로 쓴다. 숫자로 쓴 `SQL_MODE = 0`은 MySQL처럼 빈 모드다(MySQL은 정수를 모드 비트로 읽는다 — 8.0/8.4 실측, 시나리오 `numeric-sql-mode`). 그 밖의 숫자(`1`은 `REAL_AS_FLOAT`, `0.0`은 1232, `0x00`은 1231)와 숫자가 든 변수(정수인지 문자열 — `'0'`은 1231 — 인지 따라가지 않는다)는 RE_EXPORT로 거부한다(리뷰 11회차 Claude F8 — 10회차까지는 `0`도 1231로 거부했다). 따옴표 없는 `FALSE`·`TRUE`도 MySQL처럼 정수 0·1로 읽어 `FALSE`는 빈 모드, `TRUE`는 `1`처럼 RE_EXPORT다(8.0/8.4 실측, 리뷰 12회차 Claude F4, 시나리오 `boolean-sql-mode` — 11회차는 모드 이름으로 읽어 1231로 거부했다). 변수에 담은 `FALSE`·`TRUE`는 숫자가 든 변수처럼 거부하고, 따옴표 친 `'FALSE'`는 모드 이름이라 1231이다. 세션 문자셋(`SET NAMES x [COLLATE y]`·`SET CHARACTER SET x`·`CHARSET x`, `character_set_client`·`character_set_connection`·`character_set_results`·`collation_connection`): 처음은 `utf8mb4`와 그 기본 콜레이션 `utf8mb4_0900_ai_ci`로 보고(스크립트는 UTF-8이고 mysql 클라이언트 8.0의 기본 연결이다) 값을 따라간다. `SET NAMES x`는 client·results·connection을 x로, `collation_connection`을 `COLLATE y`나 x의 기본 콜레이션으로 두고(`NAMES DEFAULT COLLATE y`는 1064), `SET CHARACTER SET x`는 MySQL처럼 client·results를 x로, connection과 그 콜레이션을 스키마 기본값(`character_set_database`·`collation_database`)으로 둔다. `character_set_connection`을 정하면 콜레이션은 그 문자셋의 기본 콜레이션이 되고, `collation_connection`을 정하면 문자셋은 그 콜레이션의 문자셋이 된다(8.0/8.4 실측). `DEFAULT`는 서버의 전역 값이라 모르는 값이다. `@@character_set_client`·`@@character_set_connection`·`@@character_set_results`·`@@collation_connection`은 따라간 값을 읽어 mysqldump의 `SET @saved_cs_client = @@character_set_client` … 되돌림, mysqldump·phpMyAdmin 머리·꼬리의 `@OLD_COLLATION_CONNECTION`, mysqldump `--routines`가 루틴마다 내는 `@saved_col_connection` 되돌림 뒤의 한글 DDL을 받는다(리뷰 12회차 R12-2·Claude F1, 시나리오 `dump-charset-restore` — 11회차는 `@@collation_connection`을 모르는 값으로 읽어 되돌린 뒤의 한글 DDL을 거부했다). 이 도구가 기본 콜레이션을 모르는 문자셋(`armscii8` 등)으로 정한 연결의 콜레이션은 모르는 값이다. 저장 함수 안의 `SET NAMES`는 함수에서 돌아올 때 MySQL이 되돌린다(8.0/8.4 실측). 두 문자셋이 UTF-8 계열(`utf8mb4`·`utf8mb3`·`utf8`)이나 `binary`가 아니거나 모르면 ASCII 밖 글자가 든 DDL·루틴 문장을 거부한다(3.2, 리뷰 11회차 Claude F4). `SET [SESSION] time_zone = …`(mysqldump의 `/*!40103 SET TIME_ZONE='+00:00' */` 포함): UTC(`'+00:00'`·`'+0:00'`·`'-00:00'`·`'UTC'`·`'GMT'`)로 정했는지만 기억하고, UTC로 정한 뒤에만 TIMESTAMP 리터럴 기본값을 받는다(3.2). 다른 값, `DEFAULT`, 변수에서 되돌리는 대입(`SET TIME_ZONE=@OLD_TIME_ZONE`)은 UTC가 아닌 것으로 본다. 무시하는 문장이 저장 함수를 부른 뒤에는 다시 정할 때까지 UTC로 보지 않는다(3.2). 셋 다 값을 모르는 변수(저장하지 않았거나 저장 함수 호출 뒤 잊은 사용자 변수, 서버 변수 `@@global.x`, 이 도구가 값을 따라가지 않는 시스템 변수 — `@@time_zone`·`@@unique_checks`·`@@sql_notes`·한정하지 않은 전역 전용 변수 `@@init_connect` 등, 리뷰 11회차 R11-3 — 바뀌었을 수 있는 전역 값을 읽는 `SQL_MODE = DEFAULT`)에서 정해도 그 `SET`은 받고 세션 값을 모르는 값으로 둔다. 그 값에 기대는 뒤 문장만 거부하고, 리터럴로 다시 정하면 다시 안다(3.2 모르는 세션 값, 리뷰 10회차). 한 `SET` 문의 대입은 MySQL처럼 값을 모두 먼저 계산한 뒤 차례로 대입한다(`set_var.cc`, 8.0/8.4 실측): 뒤 대입이 앞 대입이 바꾼 변수를 읽어도 문장 전의 값이다 — 설정을 앞에 쓴 `SET SQL_MODE = '…', @OLD_SQL_MODE = @@SQL_MODE`의 `@OLD_SQL_MODE`는 문장 전 값이고, `SET @m = 'A', sql_mode = @m`의 `sql_mode`는 문장 전의 `@m`이다(리뷰 11회차 Claude F2, 시나리오 `set-evaluation-order`) |
| 무시하는 문장 | 스키마에 영향이 없는 세션 변수의 `SET`(`unique_checks`·`sql_notes`·`autocommit` 등 — 값을 버리므로 값을 모르는 변수에서 되돌려도 받는다: 저장하지 않았거나 저장 함수 호출 뒤 잊은 `@OLD_…`(`SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS`), 서버 변수 `@@global.x`. 값에 식은 쓸 수 없다, 리뷰 9회차), 트랜잭션 특성·역할·자원 그룹의 `SET`(`SET [GLOBAL\|SESSION\|LOCAL\|PERSIST\|PERSIST_ONLY] TRANSACTION ISOLATION LEVEL …`·`READ ONLY` — `PERSIST` 꼴도 MySQL이 받는다, `SET ROLE …`, `SET DEFAULT ROLE … TO …`, `SET RESOURCE GROUP rg [FOR id …]` — 권한·트랜잭션·스레드 자원만 바꾸고 MySQL 문법에 식이 들어갈 자리가 없다, 리뷰 9회차·10회차. 키워드 뒤에 아무것도 없는 `SET TRANSACTION`·`SET ROLE`·`SET DEFAULT ROLE`·`SET RESOURCE GROUP`은 MySQL처럼 1064로 거부한다, 8.0/8.4 실측), 서버 변수의 `SET`(`SET GLOBAL`·`PERSIST`·`PERSIST_ONLY`, `@@global.x` — 이 스크립트의 세션을 바꾸지 않는다. 앞에 쓴 수식어는 MySQL처럼 뒤 대입에도 이어진다. 서버 `sql_mode`를 바꾸면 뒤의 세션 `SET sql_mode = DEFAULT`가 정한 SQL_MODE는 모르는 값이다, 4장 루틴), 트랜잭션 제어(`START TRANSACTION`·`BEGIN`·`COMMIT`·`ROLLBACK`), `LOCK`·`UNLOCK TABLES`, 데이터 문장(`INSERT`·`UPDATE`·`DELETE`·`REPLACE`·`TRUNCATE` — 사용자 변수에 대입하는 꼴(`INSERT … VALUES ((@v := …))`)은 실행하지 않아 대입한 값을 모르므로, 뒤 `SET`이 그 변수를 읽지 못하게 조회 문장처럼 거부한다, 리뷰 6회차), `GRANT`·`REVOKE`, `FLUSH PRIVILEGES`·`FLUSH TABLES`(그 밖의 `FLUSH`는 받지 않는다), `DROP USER`·`RENAME USER`(비밀번호를 담지 않는다 — `CREATE USER`·`ALTER USER`·`SET PASSWORD`는 3.2), 조회(`SELECT`·`SHOW`·`DESC`·`DESCRIBE`·`EXPLAIN`·`DO` — 함수는 DDL을 실행할 수 없다. 사용자 변수에 대입하는 꼴(`:=`·`INTO`)은 뒤 `SET`이 읽는 저장 값을 바꿀 수 있어 거부한다), 테이블 점검(`ANALYZE`·`OPTIMIZE`·`CHECK`·`CHECKSUM TABLE` 이름 목록과 `CHECK`의 검사 방식 — 결과 행만 낸다. MySQL은 없는 테이블을 결과 행의 오류로만 알리지만 `DISABLE KEYS`처럼 1146으로 거부하고, 히스토그램 절 같은 그 밖의 꼴은 받지 않는다), `DISABLE KEYS`·`ENABLE KEYS`만 쓴 `ALTER TABLE`(mysqldump 데이터 덤프의 `/*!40000 ALTER TABLE … DISABLE KEYS */`. InnoDB는 note 1031만 남긴다, 없는 테이블은 1146), 현재 스키마의 `CREATE {SCHEMA\|DATABASE} IF NOT EXISTS`(Workbench 스크립트 첫 줄·mysqldump `--databases` 머리, note 1007 — 있는 스키마라 MySQL은 문자셋·콜레이션·`ENCRYPTION` 옵션도 무시하고 스키마 기본값은 그대로다. 옵션의 이름은 MySQL처럼 본다: 1115·1273·1253), 주석, 현재 스키마와 같은 `USE`(8.0/8.4 실측, 시나리오 `no-op-statements`·`no-op-queries`·`no-op-admin`). 이미 MySQL에서 돈 스크립트에 흔하고 SHOW CREATE 결과를 바꾸지 않는다(DDL은 MySQL이 암묵적으로 커밋해 `ROLLBACK`이 되돌리지 않는다). 적용한 문장 수에 세지 않는다. 무시하는 문장(조회·데이터 문장·서버 변수 `SET`)이 저장 함수를 불러도 문장은 받는다. 다만 함수가 바꿨을 수 있는 사용자 변수·세션 `time_zone`·전역 `sql_mode`를 모르는 값으로 두고, 그 값에 기대는 뒤 문장(그 값으로 정한 세션 SQL_MODE로 만드는 루틴, TIMESTAMP 리터럴 기본값 등)은 거부한다(3.2, 리뷰 8회차·10회차). 또 바꾼 구분자를 되돌리지 않았거나(`DELIMITER ;` 없음) `\g`를 써서 한 덩어리에 문장이 여럿 들어 있으면, 뒤 DDL이 함께 버려지지 않도록 무시하지 않고 거부한다 |
| 거부하는 SET | 이후 테이블 정의를 바꾸는 세션 변수(`default_storage_engine`·`explicit_defaults_for_timestamp`·`sql_require_primary_key` 등), 식으로 쓴 세션 변수 값(`SQL_MODE = REPLACE(@@sql_mode, …)` — 값을 버리는 변수도 같다. 값 안의 저장 함수 호출이 숨지 않게 한다. 값을 알 수 없는 변수를 읽는 대입은 받는다 — 세션 셋은 위 세션 문장 행), `변수 = 값` 꼴이 아닌 그 밖의 `SET`(`SET autocommit 1` — 무엇을 바꾸는지 가르지 않는다, 리뷰 9회차) |

- `CREATE TABLE`의 컬럼 정의 안에 `PRIMARY KEY`, `UNIQUE [KEY]`, `KEY`(PK의 동의어)를 쓰면 인덱스로 바꾼다.
- 컬럼 정의 안의 `REFERENCES …`는 MySQL처럼 무시한다.
- `IF NOT EXISTS`는 대상이 이미 있으면 아무것도 하지 않는다. `IF EXISTS`는 대상이 없으면 아무것도 하지 않는다. MySQL의 경고 동작과 같다.
- 실행 주석(`/*!NNNNN … */`, 번호 없는 `/*!`도)으로 감싼 문장은 안의 문장으로 읽는다. mysqldump 머리·꼬리의 `/*!40101 SET … */;`가 `SET`으로 무시된다. 버전 번호는 MySQL처럼 본다(리뷰 11회차 R11-2, 8.0/8.4 실측 — MySQL은 번호가 서버 버전 이하일 때만 안의 글을 실행하고, 높으면 표지부터 첫 `*/`까지를 주석으로 건너뛴다. 8.0.46은 80046까지, 8.4.11은 80411까지 실행한다). 번호가 없거나 80046 이하면 실행하고, 80500 이상이면 8.0·8.4의 어느 판도 실행하지 않으므로 주석으로 본다: 문장을 통째로 감싼 `/*!99999 ALTER … */;`는 주석뿐인 문장이라 적용하지 않고(MySQL도 오류 없이 지나간다, 문장 수에는 센다), 문장 가운데의 `ALTER TABLE t ADD d INT /*!90000 , ADD e INT */`는 그 글만 건너뛰며, 건너뛴 `SET`은 세션 값을 바꾸지 않는다(시나리오 `version-comments`). 문장 없이 끝난 덩어리(`/*!80400 */;`·`/*!99999 */;`)와 `DELIMITER` 줄의 실행 주석은 뒤 문장의 것이 아니다: 안에 토큰이 없어 번호가 판에 따라 갈려도 8.0·8.4가 실행하든 건너뛰든 같아 받는다(다섯 자리가 아닌 번호와, 건너뛰는 것 안의 주석·줄 주석은 문장 안의 것처럼 거부한다, 리뷰 12회차 Claude F5 — 11회차는 버렸다). 80047~80499는 서버의 판에 따라 실행 여부가 갈리고(8.0.46은 건너뛰고 8.4는 판에 따라 실행한다), 다섯 자리가 아닌 번호는 MySQL이 다르게 읽어(다섯 자리보다 짧으면 실행할 글, 여섯 자리는 8.0이 앞 다섯 자리만 번호로 읽는데 8.4는 공백이 뒤따르면 여섯 자리를 번호로 읽는다) 거부한다(3.2). 덤프 파서와 함께 쓰는 렉서는 번호와 상관없이 내용을 읽는 그대로 두고(덤프의 `/*!80023 INVISIBLE */`), 적용 쪽에서 문장 나누기가 알려 준 표지로 가른다. 구분자를 바꾼 동안 `/*!40101 ALTER … */;$$`처럼 닫는 `*/` 뒤에 `;`를 붙인 꼴도 끝의 `;`를 먼저 떼고 안의 문장으로 읽는다(mysql 클라이언트가 그대로 보내고 MySQL이 실행한다, 8.0/8.4 실측). 루틴을 통째로 감싼 꼴(`/*!80000 CREATE FUNCTION … */`)도 닫는 `*/`를 본문에 남기지 않는다(본문 `RETURN 1`, 8.0/8.4 실측). 루틴 정의 안의 실행 주석은 받지 않는다(3.2).
- `DELIMITER` 인자는 mysql 클라이언트처럼 읽는다. 따옴표(`'`·`"`·`` ` ``)로 감쌌으면 짝 따옴표 안, 아니면 첫 공백 앞까지가 구분자이고 줄의 나머지(`-- …`·`# …` 주석)는 버린다. 탭은 인자를 끝내지 않는다(8.4.11 실측). `DELIMITER` 줄이나 그 앞의 문장 없는 덩어리에 따옴표·주석 밖의 ASCII 밖 공백(NBSP 등)이 있으면 클라이언트가 그 줄을 명령으로 읽지 않아 거부한다(3.2, 리뷰 12회차 Claude F5). 구분자 덩어리 하나에는 문장 하나(루틴이면 루틴 하나)만 받는다(3.2). 덩어리 끝의 `;`는 문장을 끝낼 뿐이라 떼고 읽는다. 구분자를 되돌리지 않은 파일 끝의 `ALTER …;`·`…;;`도 mysql 클라이언트가 실행한다(8.0/8.4 실측).

### 3.2 거부하는 문장 (1차)

거부하면 이유와 함께 "이 변경은 td-export로 다시 뽑아 올려 주세요"라고 안내한다.

| 구분 | 대상 | 이유 |
|---|---|---|
| 식이 들어가는 정의 | `CREATE/ALTER VIEW`, `CREATE OR REPLACE VIEW`, `CHECK (…)` 추가, 생성 컬럼(`GENERATED ALWAYS AS`, `AS (…)`), 식 기본값 `DEFAULT (…)`, 함수 인덱스 키 파트 `((…))` | MySQL이 식을 다시 써서 저장한다(``(`price` > 0)``, ``select `t`.`a` AS `a` …``). 모델에서 똑같이 만들 수 없다 |
| 문자셋·파티션 | `CONVERT TO CHARACTER SET`, `[DEFAULT] CHARACTER SET=`·`COLLATE=` 테이블 옵션, 파티션 절 전부(`PARTITION BY`, `ADD/DROP/REORGANIZE/COALESCE/TRUNCATE PARTITION`, `REMOVE PARTITIONING`) | 컬럼 상속과 행 이동 규칙이 복잡하다 |
| FK로 이어진 타입 변경 | FK 컬럼 또는 FK가 참조하는 컬럼의 타입·문자셋·콜레이션을 바꾸는 `MODIFY`/`CHANGE` | MySQL이 거부하는 경우(3780)와 허용하는 경우를 1차에서는 가르지 않는다 |
| 기타 | `CREATE TABLE … SELECT`, `CREATE TABLE … LIKE`, `CREATE/DROP TRIGGER·EVENT`, `ALTER DATABASE`, `CALL`·`PREPARE`·`EXECUTE`(DDL을 실행할 수 있다), 다른 스키마를 만들거나 `IF NOT EXISTS`가 없는 `CREATE SCHEMA`·`DATABASE`(스키마 기본값은 적용 화면에서 정한다), 다른 절과 함께 쓴 `DISABLE KEYS`·`ENABLE KEYS`, 그 밖에 3.1 표에 없는 문장 | 범위 밖 (데이터 문장·권한·트랜잭션 제어·조회·테이블 점검은 3.1처럼 무시한다) |
| 계정 문장 | `CREATE USER`, `ALTER USER`, `SET PASSWORD` | 스키마를 바꾸지 않지만 비밀번호를 담을 수 있고, 적용한 스크립트는 버전 이력에 원문 그대로 남는다. 무시하지 않고 비밀번호가 든 계정 문장을 지우고 다시 넣으라고 안내한다(문장 글자는 안내에 넣지 않는다) |
| 정의 옵션 | FK의 `MATCH FULL\|SIMPLE` 절, 인덱스(`KEY`·`UNIQUE`·`PRIMARY KEY`) 정의의 `KEY_BLOCK_SIZE` | MySQL이 `MATCH`를 읽고 무시한다. 인덱스의 `KEY_BLOCK_SIZE`는 테이블에 `KEY_BLOCK_SIZE`가 있을 때만 저장되고 문장 순서에 따라 달라진다(8.0/8.4 실측) |
| 날짜·시간 기본값의 비표준 꼴 | `DEFAULT '20200101'`, `'2020-1-1'`, `'2020-01-01T10:20:30'`, 숫자 리터럴(`DEFAULT 20200101`), 반올림되는 소수 초 | MySQL이 값을 다시 써서 저장한다. 표준 꼴(`YYYY-MM-DD[ HH:MM[:SS[.f]]]`, `[-]H:MM[:SS[.f]]`)만 다시 쓴다 |
| InnoDB가 아닌 엔진 | `ENGINE=`이 InnoDB가 아닌 `CREATE TABLE`·`ALTER TABLE`, InnoDB가 아닌 기준 테이블을 바꾸는 문장 | 1차는 InnoDB만 지원한다(사용자 결정) |
| 4바이트 문자 | 문자열 리터럴(DEFAULT·COMMENT·ENUM/SET 값)이나 루틴 COMMENT에 U+10000 이상 문자(이모지 등)가 든 문장 | SHOW CREATE가 COMMENT·ENUM·SET 값은 `?`로, 문자열 DEFAULT는 16진수(`0xF09F9880`)로 바꿔 찍는다(8.0/8.4 실측). 루틴 본문은 쓴 그대로라 받는다 |
| 서버 버전에 따라 실행 여부가 갈리는 실행 주석 | 버전 번호가 80047~80499인 실행 주석(`/*!80400 ALTER … */`, 문장 가운데의 것 포함), 다섯 자리가 아닌 번호(`/*!1 …`·`/*!100000 …`), 건너뛰는 실행 주석(80500 이상) 안의 주석(`/*!99999 … /* 메모 */ … */`)과 줄 주석(`#`·`-- ` — 따옴표 안의 것도 함께, 마지막 문장 뒤의 것도. 마지막 문장 뒤면 문장 번호 없이 그 줄을 밝힌다). 건너뛰는 실행 주석이 문장 안에서 닫히지 않으면(구분자가 그 안에 있다 — mysql 클라이언트가 주석 가운데서 문장을 끊는다) MySQL처럼 1064다 | 8.0.46은 80046까지, 8.4.11은 80411까지 실행한다(8.0/8.4 실측). 80047~80499는 스크립트를 실행한 서버의 판을 알아야 실행했는지 알 수 있다. 다섯 자리보다 짧은 숫자는 MySQL이 실행할 글로 읽는데 렉서는 표지로 떼고, 여섯 자리는 8.0이 1064, 8.4가 건너뛴다(리뷰 11회차 R11-2). 서버는 건너뛰는 주석을 첫 `*/`까지 그대로 건너뛰지만, mysql 클라이언트는 `/*!` 안에서도 줄 주석을 줄 끝까지 떼고 보내거나(8.0 기본) 그대로 보내(8.4 기본·`--comments`) 같은 스크립트가 판에 따라 1064이거나 다른 DDL을 실행한다(8.0/8.4에서 mysql 클라이언트로 실측: `/*!99999 -- x */ ALTER …;`은 8.0이 1064, 8.4가 그 `ALTER`를 실행하고, `ADD a INT /*!99999 # 메모 */`(줄바꿈)`, ADD b INT */`는 8.0이 `a`만, 8.4가 1064다). 렉서는 줄 주석으로 읽어 닫는 `*/`와 뒤 DDL을 삼켜, 11회차는 그 DDL을 조용히 버리거나 `a`·`b`를 더했다(리뷰 12회차 R12-3·Claude F3) |
| UTF-8이 아닌 세션 문자셋의 ASCII 밖 글자 | `character_set_client`나 `character_set_connection`이 UTF-8 계열(`utf8mb4`·`utf8mb3`·`utf8`)·`binary`가 아니거나 모르는 값인 동안(`SET NAMES latin1`, mysqldump `--default-character-set=latin1`의 `/*!40101 SET NAMES latin1 */`, `SET CHARACTER SET utf8mb4`에 latin1 스키마, `SET NAMES DEFAULT`, 모르는 변수에서 되돌림) 문자열·이름·COMMENT에 ASCII 밖 글자(한글 등)가 든 DDL·루틴 문장. 주석 속 글자와 데이터 문장·`SET`은 받는다 | MySQL은 문장의 바이트를 `character_set_client`로 읽어 이름·COMMENT를 utf8mb3로, 문자열 리터럴을 `character_set_connection`으로 바꾼다. 스크립트는 UTF-8이므로(5.3) `SET NAMES latin1` 뒤의 `DEFAULT '가'`·`COMMENT '회원 이름'`·`` `가` ``는 `'ê°€'`·`'íšŒì› ì´ë¦„'`·`` `ê°€` ``로 저장되고, connection만 latin1이어도 `DEFAULT '가'`는 `'?'`, `ENUM('가','나')`는 1291이다(8.0/8.4에서 mysql 클라이언트로 실측). 깨진 글자는 재현하지 않는다(리뷰 11회차 Claude F4) |
| 따옴표·주석 밖의 ASCII가 아닌 공백 | 문자열·백틱 식별자·주석 밖에 NBSP(U+00A0)·전각 공백(U+3000)·BOM(U+FEFF, 스크립트 맨 앞은 뗀다) 같은 유니코드 공백이 든 문장(무시하는 문장·실행하는 실행 주석 안 포함, 건너뛰는 실행 주석 안은 받는다). 앞 문장 뒤의 문장 없이 끝난 덩어리(`<NBSP>;`, `/*!40101 <NBSP> */;`)와 `DELIMITER` 줄·그 앞(`<NBSP>`만 있는 줄 다음이나 같은 줄 앞의 `DELIMITER ;;`, `DELIMITER <NBSP>;;`)의 것도 거부한다 — 문장 번호는 뒤 문장이고 안내에 그 줄을 밝힌다. 마지막 문장 뒤의 것은 받는다 | 렉서는 이 글자를 토큰 사이 공백으로 건너뛰지만 MySQL은 이름의 글자로 읽는다(8.0/8.4 실측: `ADD <NBSP>nick INT`의 컬럼 이름은 NBSP로 시작하고, `nick<NBSP> INT`는 NBSP로 끝나며, 문장 맨 앞·`(` 앞에서는 1064). 웹·위키에서 복사한 스크립트에 흔하다. 덤프 파서와 함께 쓰는 렉서는 그대로 두고 적용 쪽에서 거부한다(리뷰 11회차 Claude F5). mysql 클라이언트도 이 글자를 공백으로 보지 않아, 문장 없는 덩어리의 것은 문장으로 보내 1064로 멈추고 버퍼가 비지 않아 뒤의 `DELIMITER` 줄을 명령으로 읽지 않는다(8.0/8.4에서 mysql 클라이언트로 실측 — 11회차는 렉서가 건너뛴 것을 버려 루틴과 뒤 DDL을 받았다, 리뷰 12회차 Claude F5). `DELIMITER ;; <NBSP>`처럼 인자 뒤에 둔 것은 클라이언트가 버리지만 함께 거부한다(보수적). 마지막 문장 뒤의 것은 MySQL이 오류를 내도 앞 DDL을 모두 적용한 뒤라 모델이 같다 |
| 루틴 경계를 MySQL과 같게 가를 수 없는 덩어리 | 구분자 덩어리에 루틴 뒤 다른 문장이 이어진 것(`DELIMITER ;;`를 되돌리지 않은 `RETURN 1; ALTER …`, `END; DROP …`, 루틴 둘, `\g`), 본문이 `BEGIN … END` 하나나 `;` 없는 문장 하나가 아닌 루틴, 루틴 정의 안의 실행 주석(`BEGIN /*!80000 … */ END`) | mysql 클라이언트는 덩어리를 다중 문장으로 보내고 서버는 루틴 뒤 문장을 따로 실행한다. 덩어리 전체를 본문으로 읽으면 뒤 DDL이 조용히 사라진다. 판정은 DDL 생성의 최종 단일 문장 검사와 같다. 실행 주석은 MySQL이 표지를 지운 본문으로 저장한다(8.0/8.4 실측) |
| 문장이 여럿 든 덩어리 | 루틴이 아닌 문장의 구분자 덩어리에 다른 문장이 이어진 것: 바꾼 구분자 대신 `;`로 끝낸 문장(`DELIMITER $$` 뒤 `DROP PROCEDURE IF EXISTS p;` 다음 줄의 `CREATE PROCEDURE … $$`), 되돌리지 않은 `DELIMITER` 뒤의 `CREATE TABLE IF NOT EXISTS …; ALTER …;`, `\g`·`\G` 같은 클라이언트 명령 | mysql 클라이언트는 덩어리의 문장을 모두 실행한다(8.0/8.4 실측: 이미 있는 테이블의 `CREATE TABLE IF NOT EXISTS` 뒤 `ALTER`·`DROP`도 실행된다). 첫 문장만 읽으면 뒤 DDL이 조용히 사라진다. 무시하는 문장도 같다(3.1) |
| 저장 함수 호출 뒤 그 함수가 바꿨을 수 있는 값에 기대는 문장 | 무시하는 문장(3.1의 조회·데이터 문장과, 값을 읽지 않고 버리는 서버 변수 `SET`)이 저장 함수를 부른 뒤, 다시 정하지 않은 사용자 변수(호출 전에 저장한 값·다른 변수에서 옮긴 값·저장한 적 없는 변수 모두 — 함수는 어느 사용자 변수든 바꿀 수 있다)나 바뀌었을 수 있는 전역 sql_mode(`SET [SESSION] SQL_MODE = DEFAULT`, 4장 루틴)에서 정한 세션 `SQL_MODE`·`TIME_ZONE`·`FOREIGN_KEY_CHECKS`에 기대는 뒤 문장(아래 모르는 세션 값 행), UTC로 정한 뒤 `time_zone`을 다시 정하지 않은 TIMESTAMP 리터럴 기본값. 값을 정하는 `SET` 자체(`SET SQL_MODE = @m`, `SET @x = @m`, mysqldump·Workbench 꼬리의 `SET TIME_ZONE=@OLD_TIME_ZONE`·`SET SQL_MODE=@OLD_SQL_MODE`·`SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS` 같은 `@OLD_…` 복원)는 받는다(리뷰 10회차 — 9회차까지는 이 `SET`에서 거부했다). 그래서 mysqldump·Workbench 머리·꼬리 사이에서 도우미 함수를 부르는 마이그레이션도 꼬리까지 받는다(시나리오 `stored-call-dump-footer`). 호출 전에 저장한 변수면(따라가지 않는 시스템 변수를 읽어 이미 모르는 값이었던 mysqldump 머리의 `SET @OLD_TIME_ZONE=@@TIME_ZONE`도) 안내에 그렇게 밝힌다(리뷰 9회차·11회차). 값을 버리는 세션 변수의 복원(`SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS`·`SQL_NOTES` …)도 받는다(3.1, 시나리오 `builtin-call-spacing`). 문자셋 변수의 복원(`CHARACTER_SET_CLIENT`·`CHARACTER_SET_RESULTS`·`COLLATION_CONNECTION`)도 받고, 뒤의 ASCII 밖 글자가 든 DDL만 거부한다(`CHARACTER_SET_RESULTS`는 DDL을 읽는 데 쓰지 않아 거부하지 않는다, 리뷰 11회차·12회차). 호출하는 문장은 받는다: `SELECT f(1)`, `DO f()`, `INSERT … VALUES (f(1))`, `UPDATE t SET v = f(v)`, `SET GLOBAL x = f()`. 호출로 보는 꼴은 이름 뒤에 `(`가 오는 것이다(사이의 공백·주석 포함). 이름은 단어·백틱 식별자·숫자로 시작하는 이름(`1f(` — 렉서는 숫자와 단어로 나누지만 MySQL은 식별자 하나로 읽는다, 리뷰 8회차 R8-2)이고, 스키마로 한정한 자리(`.` 바로 뒤)는 숫자처럼 보이는 이름(`cur.0xface(`·`cur.0b101(`·`cur.123(` — 렉서는 16진수·비트·숫자 리터럴로 읽지만 MySQL은 식별자로 읽는다, 리뷰 9회차 R9-2)도 이름이다. 스키마를 붙이지 않은 이름과 현재 스키마로 한정한 이름(`cur.f(`)은 모델의 함수(같은 스크립트에서 앞서 만든 것 포함, 대소문자 무시)일 때만 센다. 모델에 없는 이름·이름이 같은 프로시저·`INTO` 뒤 이름(`INSERT INTO f (…)`의 테이블)은 세지 않는다. 다른 스키마로 한정한 이름(`other.f(`)은 늘 센다. 따옴표·스키마 없이 쓴 MySQL 8.0/8.4 내장 함수 이름 391개(`native-functions.ts`, 리뷰 10회차 R10-1 — `CONCAT(`·`NOW(`·`IFNULL(`·`JSON_LENGTH(`·`POW(`·`DAYOFMONTH(`·`CHAR(`·`COUNT(` …)는 이름이 같은 저장 함수가 있어도 세지 않는다(리뷰 8회차 R8-1). 그 가운데 356개는 이름과 `(` 사이에 공백·줄바꿈·주석을 끼워도 같다(`CONCAT ('a','b')`·`IFNULL/**/(…)`, 리뷰 9회차 R9-1). 바로 `(`가 붙어야 내장 함수인 35개(MySQL `lex.h`의 `SYM_FN`: `ADDDATE`·`BIT_AND`·`BIT_OR`·`BIT_XOR`·`CAST`·`COUNT`·`CURDATE`·`CURTIME`·`DATE_ADD`·`DATE_SUB`·`EXTRACT`·`GROUP_CONCAT`·`JSON_ARRAYAGG`·`JSON_OBJECTAGG`·`MAX`·`MID`·`MIN`·`NOW`·`POSITION`·`SESSION_USER`·`ST_COLLECT`·`STD`·`STDDEV`·`STDDEV_POP`·`STDDEV_SAMP`·`SUBDATE`·`SUBSTR`·`SUBSTRING`·`SUM`·`SYSDATE`·`SYSTEM_USER`·`TRIM`·`VAR_POP`·`VAR_SAMP`·`VARIANCE`)는 바로 붙인 꼴만 빼고, 세션 SQL_MODE에 `IGNORE_SPACE`가 있으면 공백(공백·탭·줄바꿈·CR·VT·FF)만 끼운 꼴도 뺀다(시나리오 `builtin-ignore-space`). 그 SQL_MODE는 호출을 읽는 문장 앞의 값이다 — 한 `SET` 문 안의 앞 대입이 바꾼 값으로 뒤 대입을 읽지 않는다. 세션 SQL_MODE를 모르거나(3.2 모르는 세션 값) 지금 값이 처음 세션 SQL_MODE(4장 루틴, 짐작한 서버 값)에서 왔으면(`SET` 없이 시작했거나, `DEFAULT`나 짐작한 값을 저장한 `@@sql_mode`·사용자 변수로 그 값에 돌아왔다) 공백 낀 꼴도 센다(보수적). `SET SQL_MODE = '…'` 리터럴로 정한 값은 짐작한 값과 같아도 그 값을 따르고(리뷰 11회차 R11-1 — 10회차는 처음 값에 `IGNORE_SPACE`가 있으면 리터럴로 정한 뒤에도 셌다), 그 값을 `@@sql_mode`·사용자 변수로 옮겨 되돌려도 같다(`SET @m = @@sql_mode` … `SET sql_mode = @m`, `SET @copy = @m`, `SET sql_mode = @@sql_mode`, 리터럴을 담은 `@m` — 리뷰 12회차 R12-1. 11회차는 변수에서 되돌린 값을 모두 짐작한 값으로 보았다). 값이 어디서 왔는지는 대입마다 값과 함께 계산한다(한 `SET` 문의 앞 대입 전 값이면 그 값이 온 곳이다). 목록 밖의 이름, 백틱을 쓴 꼴(`` `now`() ``·`` `coalesce`() ``), 주석을 끼운 35개(`NOW/**/()`), `IGNORE_SPACE`가 아닌 세션의 공백 낀 35개(`NOW ()`·`COUNT (1)`)는 이름이 같은 저장 함수가 모델에 있으면 센다 | 저장 함수는 `SET @m = …`으로 사용자 변수를, `SET time_zone`으로 세션 시간대를, `SET GLOBAL sql_mode`로 전역 값을 바꿀 수 있고, 함수에서 돌아와도 MySQL은 이 값을 되돌리지 않는다(8.0/8.4 실측. 세션 `sql_mode`·`FOREIGN_KEY_CHECKS`는 되돌려 그대로 쓴다). 문장을 실행하지 않아 바뀐 값을 모르므로, 옛 값을 쓰면 루틴에 틀린 SQL_MODE를 붙이거나 TIMESTAMP 기본값을 틀리게 둔다. 호출하는 문장 자체는 받는다 — 도우미 함수를 만들어 데이터를 고친 뒤 지우는 마이그레이션이 흔하고, 뒤에서 그 값을 읽지 않으면 모델이 틀어지지 않는다(리뷰 7회차 R7-2, 8회차). 값을 버리는 세션 변수는 되돌린 값을 모델에 쓰지 않으므로 그 값을 몰라도 모델이 틀어지지 않는다(리뷰 9회차). MySQL은 따옴표·스키마 없는 내장 함수 이름을 내장 함수로 읽는다. 목록은 8.0.46·8.4.11의 `mysql.help_topic`에서 함수 도움말 분류의 이름과 매뉴얼 별칭(`SHA`, `ST_` 별칭)을 모아, 이름마다 그 이름의 저장 함수를 만든 뒤 바로 붙인 꼴과 공백·탭·줄바꿈·CR·VT·FF·NBSP·주석(`/**/`·`/* x */`·`-- x`·`# x`·`/*!50000 */`)을 끼운 꼴로 기본 SQL_MODE와 `IGNORE_SPACE`에서 불러, 두 버전에서 같게 내장 함수인 이름만 남겼다. 연산자(`AND`·`IN`·`LIKE` …), 시스템 뷰 전용 내부 함수(`INTERNAL_*`·`CAN_ACCESS_*`·`GET_DD_*` — 사용자가 부르면 3554), 커뮤니티판에 없는 Enterprise Encryption 함수(저장 함수가 돈다), 8.4에서 없어진 `WAIT_UNTIL_SQL_THREAD_AFTER_GTIDS`는 뺐다. 공백·주석은 이름에 따라 다르다: `SYM_FN` 이름(매뉴얼 "Function Name Parsing and Resolution"의 목록에 `JSON_ARRAYAGG`·`JSON_OBJECTAGG`·`ST_COLLECT`가 더 있다)은 바로 `(`가 붙어야 내장 함수이고, 공백·주석을 끼우면 식별자로 읽어 저장 함수를 부른다(`NOW ()`). `IGNORE_SPACE` 세션에서는 공백만 끼운 꼴도 내장 함수이고, 주석·NBSP를 끼우면 저장 함수다. 나머지는 공백·주석과 상관없이 내장 함수다(`CONCAT (`). 처음 세션 SQL_MODE는 짐작한 값이라 거기서 온 `IGNORE_SPACE`는 믿지 않는다(리터럴로 정한 값은 변수로 옮겨 되돌려도 믿는다). 백틱은 함수에 따라 다르므로(`` `now`() ``·`` `coalesce`() ``는 저장 함수, `` `concat`() ``는 내장 함수) 늘 센다. 목록 밖의 이름은 세므로 빠진 내장 함수가 있어도 보수적이다 — 지나치게 세면 그 값에 기대는 뒤 문장만 거부된다. 스키마로 한정한 자리는 `.` 바로 뒤를 식별자로 읽는다(`cur.0xface()`·`cur.123()`은 저장 함수 호출이고, 따옴표 친 스키마 뒤의 `` `cur`.0xface() ``와 `.` 앞뒤에 공백을 둔 꼴은 1064, 8.0.46·8.4.11 실측). 한정하지 않은 `0xface()`도 1064라 세지 않는다. 다른 스키마의 함수는 이 버전에 없어 본문을 알 수 없다. `INTO`를 뺀 `INSERT other.t (…)`의 테이블은 호출과 가르지 않는다(보수적). 한계: 함수가 그 밖의 세션 변수를 바꾸는 경우는 따라가지 않는다. 이 표 위에서 거부하는 SET의 변수 가운데 `default_storage_engine`·`sql_generate_invisible_primary_key`·`innodb_strict_mode`는 함수 안에서도 바뀌고 남는다(8.4.11 실측, `explicit_defaults_for_timestamp`는 함수 안에서 1765). 이를 막으려면 호출 뒤의 `ENGINE` 없는 `CREATE TABLE`을 거의 모두 거부해야 하는데, 그런 함수는 드물어 받는다 |
| ENUM·SET의 숫자 기본값 | `ENUM('2','1') DEFAULT 1`, `SET('2','a') DEFAULT 2`, `DEFAULT TRUE` | MySQL이 숫자를 값이 아니라 순번·비트로 읽는다(8.0/8.4 실측: `'2'`, `'a'`). 값은 따옴표로 쓴다 |
| 모르는 세션 값에 기대는 문장 | 값을 모르는 변수(위 행의 저장 함수 호출 뒤 잊은 사용자 변수, 저장하지 않은 사용자 변수, 서버 변수 `@@global.x`·`@@persist.x`, 이 도구가 값을 따라가지 않는 시스템 변수(`@@time_zone`·`@@unique_checks`·`@@sql_notes`·한정하지 않은 전역 전용 변수 `@@init_connect` … — 9회차까지는 `''`로 읽어 `SET sql_mode = @@unique_checks`·`SET sql_mode = @@init_connect` 뒤의 루틴이 빈 SQL_MODE를 기억했다. MySQL은 `@@unique_checks`를 정수 1로 읽어 `REAL_AS_FLOAT`가 되고, `@@init_connect`는 전역 값을 읽는다, 리뷰 11회차 R11-3), 바뀌었을 수 있는 전역 값을 읽는 `SQL_MODE = DEFAULT`, 모르는 세션 값을 옮긴 `@@sql_mode`·`@@foreign_key_checks`)에서 정한 세션 값에 기대는 뒤 문장. 모르는 `SQL_MODE`: `CREATE FUNCTION`·`PROCEDURE`(이미 있는 루틴의 `IF NOT EXISTS`는 받는다), 백슬래시가 든 문장(`NO_BACKSLASH_ESCAPES`, 무시하는 문장 포함), 큰따옴표로 감싼 글이 든 문장(`ANSI_QUOTES` — phpMyAdmin 꼴의 `SET SQL_MODE = "…"`도 거부하고, 작은따옴표 문자열·주석 속 큰따옴표는 받는다), DDL의 `REAL` 타입(`REAL_AS_FLOAT`). 모르는 `TIME_ZONE`: TIMESTAMP 리터럴 기본값. 모르는 `FOREIGN_KEY_CHECKS`: 켜져 있으면 FK 검사에 걸리는 문장(부모 없는 FK, 다른 테이블이 참조하는 테이블 삭제)은 MySQL 오류 번호 대신 다시 추출하도록 안내하고, 켜져 있든 꺼져 있든 받는 문장(부모가 있는 FK, 참조하는 테이블과 함께 지우는 부모)은 받는다(시나리오 `error-unknown-fk-checks`). 리터럴로 다시 정하면(`SET SQL_MODE = '…'`, 서버 값을 바꾸지 않은 `SQL_MODE = DEFAULT`, `SET time_zone = '+00:00'`, `SET FOREIGN_KEY_CHECKS = 0\|1`) 다시 안다. 안내는 값을 모르게 만든 앞 `SET` 문장과 그 까닭(어느 변수를 왜 모르는지, 옮긴 변수면 옮긴 문장까지)을 밝힌다(리뷰 10회차, `unknown-session.ts`). 옮길 때마다 앞 까닭을 감싸므로 까닭이 500자를 넘으면 가운데를 줄여 가장 가까운 대입과 처음 까닭을 남긴다(옮기는 `SET`이 수만 번 이어진 스크립트의 안내가 수백만 자가 되지 않게, 리뷰 11회차 Claude F7) | 값을 정하는 `SET`에서 거부하면 그 값을 쓰지 않는 스크립트(mysqldump·Workbench 꼬리는 복원 뒤에 문장이 없다)도 받지 못한다. 모르는 값은 그 값에 따라 결과가 달라지는 곳에서만 거부해도 모델이 틀어지지 않는다. 이 도구에서 SQL_MODE에 따라 MySQL이 다르게 읽는 곳은 루틴의 SQL_MODE, 문자열의 백슬래시, 큰따옴표, `REAL` 타입이다(그 밖의 모드가 바꾸는 식 정의는 1차 범위 밖이고, 0인 날짜 기본값은 모드와 상관없이 거부한다). 백슬래시·큰따옴표는 모르는 모드로 읽으면 문장 나누기도 어긋날 수 있어 무시하는 문장도 거부한다 |
| 세션 `time_zone`을 UTC로 정하지 않은 TIMESTAMP 리터럴 기본값 | 스크립트 앞에서 세션 `time_zone`을 UTC로 정하지 않은 채(`SET time_zone` 없음, `'+09:00'`·`'SYSTEM'` 같은 다른 값, `SET TIME_ZONE=@OLD_TIME_ZONE` 같은 변수) TIMESTAMP 컬럼의 리터럴 기본값을 쓰는 `ADD`·`MODIFY`·`CHANGE`·`CREATE TABLE`·`SET DEFAULT`. UTC로 정한 뒤(mysqldump·phpMyAdmin 머리의 `SET TIME_ZONE='+00:00'` 포함)의 값과 `CURRENT_TIMESTAMP`·`NULL`, DATETIME은 받는다. UTC로 정한 뒤 무시하는 문장이 저장 함수를 불렀으면 다시 정할 때까지 UTC로 보지 않는다(함수 안의 `SET time_zone`은 남는다, 위 저장 함수 행). 값을 모르는 변수에서 되돌린 `time_zone`(저장 함수 호출 뒤의 `SET TIME_ZONE=@OLD_TIME_ZONE`)도 그 `SET`은 받고 여기서 거부하며 그 `SET`을 밝힌다(위 모르는 세션 값 행) | MySQL은 TIMESTAMP 리터럴을 쓰는 세션의 시간대에서 UTC로 바꿔 저장하고 SHOW CREATE는 읽는 세션의 시간대로 다시 바꿔 찍는다(8.0/8.4 실측: `+09:00` 세션의 `'2020-01-01 09:00:00'`을 UTC 세션에서 읽으면 `'2020-01-01 00:00:00'`). td-export는 UTC 세션(sqlx 기본값 `time_zone='+00:00'`)에서 읽으므로 기준 버전의 값은 UTC 글자다. UTC로 정한 세션의 값은 쓴 그대로 맞지만, 그 밖에는 스크립트를 실행한 서버의 시간대를 알 수 없어 저장된 값을 정할 수 없다(시나리오 `temporal-defaults`). 스크립트는 이미 서버 시간대로 실행됐으므로 스크립트를 고치라고 안내하지 않는다 |
| 멤버 비교를 재현하지 않는 ENUM·SET 기본값 | 글자까지 같은 멤버가 없는데 언어별 콜레이션(`utf8mb4_turkish_ci`·`utf8mb4_tr_0900_ai_ci`·`utf8mb4_roman_ci`·`big5_chinese_ci` 등 4장 목록 밖)이나 ASCII가 아닌 글자로 견줘야 하는 값(`ENUM('i','ı') COLLATE utf8mb4_turkish_ci DEFAULT 'I'`, `ENUM('café') DEFAULT 'cafe'`) | MySQL은 콜레이션 규칙으로 멤버를 찾는다(8.0/8.4 실측: 터키어 `'I'`→`'ı'`, 로마 `'J'`→`'i'`, `big5_chinese_ci`의 `` '`' ``→`'E'`, `utf8mb4_0900_ai_ci`의 `'cafe'`→`'café'`). 언어별 대소문자·악센트 규칙은 재현하지 않는다. 멤버와 같은 글자로 쓴다 |
| BIT의 문자열 기본값 | `BIT(8) DEFAULT '1'`, BIT 컬럼의 `ALTER COLUMN … SET DEFAULT '0'` | MySQL이 문자열을 수가 아니라 글자의 바이트로 저장한다(8.0/8.4 실측: `BIT(8) DEFAULT '1'`→`b'110001'`, `BIT(1) DEFAULT '0'`→1067). 숫자나 `b'…'`로 쓴다 |
| 함수 식 UNIQUE 키의 순서를 정할 수 없는 문장 | 기준 테이블의 함수 식 UNIQUE 키(`UNIQUE KEY ((ifnull(a,0)))`)와 자리가 그 식의 NULL 허용 여부에 따라 갈리는 키를 더하거나 바꾸는 문장(NULL 허용 UNIQUE 추가, 식이 쓰는 컬럼의 정의 변경 등) | 식의 NULL 허용은 식에 따라 다르다(`IFNULL(a,0)`은 NOT NULL, `NULLIF(a,0)`은 NULL 허용). 짐작하지 않는다(4장 키 순서) |
| YEAR·DECIMAL 기본값의 비표준 꼴 | YEAR 기본값의 한두 자리(`20`, `'0'`, `0001`)와 `'+2020'`·`2020.5`, 가수가 15자리를 넘거나 지수가 70을 넘는 DECIMAL 지수 표기 | MySQL이 세기를 붙이거나(`20`→`'2020'`, `70`→`'1970'`) DOUBLE을 거쳐 값을 다시 쓴다 |
| 다른 스키마 | 다른 스키마를 한정한 이름(`other.t`), 다른 스키마로의 `USE` | 버전은 스키마 하나를 나타낸다. 현재 스키마 이름으로 한정한 경우(`cur.t`, 루틴 `cur.f` 포함)는 허용한다 |
| FLOAT·DOUBLE 기본값의 비표준 꼴 | MySQL이 반올림하거나 지수 표기로 다시 쓰는 값: (M,D)가 없을 때 유효숫자가 FLOAT 6·DOUBLE 15자리를 넘는 값, 지수 표기로 찍히는 값(`1e15`, `0.0000000000000001`), `-0`. (M,D)가 있을 때 소수 D자리 밖에 숫자가 있는 값, FLOAT 정밀도로 바뀌는 값, 찍는 자릿수가 DOUBLE 15자리를 넘는 값 | MySQL이 이진 부동소수점 값을 다시 찍는다(4장) |
| 따옴표 없는 숫자 시작 이름·지수 표기 기본값 | `ALTER TABLE 2024_sales …`, `ADD COLUMN 4x INT`, `CREATE TABLE … (1st INT)`, `CREATE FUNCTION 1fn()`, FK 컬럼 목록의 `FOREIGN KEY (6ref)`·`REFERENCES t (1st)`(리뷰 10회차 — 덤프 파서와 함께 쓰는 FK 목록 파서는 그대로 두고 적용 쪽에서 같은 안내로 바꾼다), `DEFAULT 1e3`·`DEFAULT -1.5E3`·`SET DEFAULT 1e-3` | 렉서가 숫자와 단어로 나눠 이름·값으로 읽지 못한다(MySQL은 숫자로만 되지 않은 이름을 식별자로, `1e3`을 실수 리터럴로 읽는다). 렉서는 바꾸지 않고, 이름은 백틱으로 감싸고 기본값은 지수 없는 숫자(`1000`)나 FLOAT·DOUBLE·DECIMAL 컬럼이면 따옴표로 감싼 값(`'1e3'`)으로 쓰라고 안내한다. 문자열 컬럼의 따옴표 값은 쓴 글자 그대로라 숫자로 읽은 값(`'1000'`)과 다르고, 정수 컬럼은 1067이다. MySQL이 받는 이름이라 루틴에도 MySQL 오류 번호를 붙이지 않는다(리뷰 9회차) |
| 테이블 문장을 다르게 읽게 하는 SQL_MODE | `REAL_AS_FLOAT`·`ANSI_QUOTES`(묶음 모드 `ANSI`·`TRADITIONAL`과 같이), 문장 나누기와 다르게 읽은 `NO_BACKSLASH_ESCAPES`(`SET @@sql_mode`·`:=`·`@변수`·큰따옴표·`SET GLOBAL` 꼴, 기준 버전 루틴에서 짐작한 서버 SQL_MODE — 4장 루틴) 뒤의 백슬래시가 든 문장, `NO_BACKSLASH_ESCAPES` 세션의 ENUM·SET 값 백슬래시, 세션 SQL_MODE를 모를 때의 백슬래시·큰따옴표·`REAL`(위 모르는 세션 값 행) | `REAL`을 FLOAT로, `"…"`를 식별자로 읽는 규칙을 모델에 반영하지 않는다. 문장 나누기는 `SET SQL_MODE = '…'` 꼴만 따라가고 처음에는 `NO_BACKSLASH_ESCAPES`가 꺼져 있으므로, 다른 꼴이나 짐작한 서버 SQL_MODE에서는 문자열을 MySQL과 다르게 읽는다. 스크립트 앞에서 `SET SQL_MODE = '…'` 꼴로 정하면 받는다. ENUM·SET 값은 타입 정규화가 보통 이스케이프 규칙으로 다시 읽는다(같은 세션의 COMMENT·DEFAULT 백슬래시는 MySQL과 같다, 8.4.11 실측) |
| 엄격하지 않은 세션의 긴 COMMENT | 엄격 SQL_MODE(`STRICT_TRANS_TABLES`·`STRICT_ALL_TABLES`)가 아니거나 세션 SQL_MODE를 모르는 동안, 1024자를 넘는 컬럼·인덱스(PRIMARY KEY 포함) COMMENT와 2048자를 넘는 테이블 COMMENT를 쓰는 `ADD`·`MODIFY`·`CHANGE`·`CREATE TABLE`·`CREATE INDEX`·`ALTER TABLE … COMMENT` | 한도는 글자 수다(한글 1024자도 받는다). 엄격 SQL_MODE는 1629·1688·1628로 거부하지만(4.1), 엄격하지 않은 세션(`SQL_MODE='NO_AUTO_VALUE_ON_ZERO'` 같은 덤프 머리)은 경고만 남기고 한도까지 잘라 저장한다(8.0/8.4 실측, 시나리오 `comment-length-limits`·`error-long-column-comment`·`error-long-index-comment`·`error-long-table-comment`). 바이트 한도처럼 잘린 값은 재현하지 않고 거부한다(리뷰 11회차 Claude F1) |
| FK가 많은 테이블 | FK가 64개를 넘는 테이블을 만들거나 바꾸는 문장 | MySQL에는 한도가 없지만(테이블 하나에 FK 2,000개면 MySQL도 CREATE TABLE에 16초가 걸린다, 8.4.11 실측) 문장마다 테이블의 FK를 모두 다시 확인하므로, 요청 하나의 계산량을 묶으려고 받지 않는다 |
| 바이트 한도를 넘는 정의 | 키 파트 하나가 3072바이트(`ROW_FORMAT=COMPACT`·`REDUNDANT`는 767바이트)를 넘는 키(FULLTEXT·SPATIAL 제외), 65535바이트를 넘는 `VARCHAR`·`VARBINARY`. 바이트는 글자 수(prefix가 있으면 prefix 길이) × 컬럼 문자셋의 글자당 최대 바이트(utf8mb4 4, utf8mb3 3, latin1 1, 이진 타입 1)다. `ROW_FORMAT`을 쓰지 않은 테이블은 DYNAMIC이다. 키·키에 든 컬럼의 정의(`MODIFY`·`CHANGE`, 지우고 다시 더한 컬럼)·`ROW_FORMAT`을 건드린 문장은 문장 끝 테이블의 키를 모두 보므로, 같은 문장의 `ROW_FORMAT` 변경과 `MODIFY`·`CHANGE`로 늘어난 컬럼도 걸린다 | 엄격 SQL_MODE는 1071·1074로 거부하지만, 엄격하지 않은 세션(`SQL_MODE='NO_AUTO_VALUE_ON_ZERO'` 같은 덤프 머리, 5.6 기본값을 둔 서버)은 일반 인덱스의 키 파트를 한도까지의 prefix로 줄이고(utf8mb4 `VARCHAR(769)`의 `KEY (c)`→`c(768)`, COMPACT의 `VARCHAR(192)`→`c(191)`) 긴 `VARCHAR`를 TEXT·BLOB 계열로 바꿔(utf8mb4 `VARCHAR(16384)`→`mediumtext`) 받는다(8.0/8.4 실측, 시나리오 `byte-limits`·`error-key-part-bytes`·`error-key-part-compact`·`error-varchar-bytes`). 쓴 그대로 저장하면 틀린 모델이 되므로 SQL_MODE와 상관없이 거부한다 |

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
  - `sqlMode`는 스크립트에서 그 문장 앞의 마지막 `SET [SESSION] SQL_MODE` 값을 쓴다. 없으면 스크립트를 실행한 서버의 sql_mode다(MySQL은 루틴을 만든 세션의 값을 저장하고, 클라이언트가 바꾸지 않은 세션 값은 서버 값이다).
    - 스크립트만으로는 서버 값을 알 수 없어, 서버가 기준 버전 루틴의 `sqlMode` 최빈값으로 짐작해 `applyScript`의 처음 세션 SQL_MODE(`ApplyOptions.sqlMode`)로 준다. td-export 0.1.52+는 루틴마다 SQL_MODE를 남기고, 기준 버전의 루틴은 대개 같은 서버에서 만들었다. 개수가 같으면 종류·이름순으로 먼저 나온 루틴의 값이다. 모드 이름을 아래 규칙으로 맞춰 센다.
    - SQL_MODE 기록이 없는 루틴(td-export 0.1.52 전)과 아래에서 거부하는 값의 루틴은 세지 않는다. 셀 루틴이 없으면 MySQL 8.0/8.4 기본 모드(`ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION`)를 쓴다(리뷰 5회차 M-1).
    - `SET [SESSION] SQL_MODE = DEFAULT`(`@@SESSION.`·`@@`·`LOCAL` 꼴 포함)는 MySQL처럼 세션 값을 전역 값, 곧 서버 sql_mode로 되돌린다. 이 도구에서는 처음 세션 SQL_MODE(짐작한 서버 값, 짐작할 루틴이 없으면 MySQL 기본 모드)다. `SET` 없이 만든 루틴과 같은 값이 된다(리뷰 6회차 M-2). `SET GLOBAL SQL_MODE = DEFAULT`는 세션을 바꾸지 않아 무시한다.
    - 스크립트가 앞에서 서버 sql_mode를 바꿨으면(`SET GLOBAL|PERSIST|PERSIST_ONLY SQL_MODE = …`, `@@GLOBAL.`·`@@PERSIST.` 꼴과 `SET GLOBAL SQL_MODE = DEFAULT` 포함) 그 뒤의 `SET [SESSION] SQL_MODE = DEFAULT`는 받되 세션 SQL_MODE를 모르는 값으로 두고, 그 뒤에 만드는 루틴은 받지 않고 다시 추출하도록 안내한다(3.2 모르는 세션 값, 리뷰 10회차). DEFAULT가 읽는 전역 값이 스크립트가 바꾼 값이라 처음 세션 SQL_MODE와 달라지는데 그 값을 알 수 없다. 바꾸기 전의 DEFAULT와 `SET SQL_MODE = '…'`로 직접 정하는 대입은 그 값을 안다(리뷰 7회차 R7-1).
    - 무시하는 문장이 저장 함수를 부르면(3.2) 함수가 전역 sql_mode와 사용자 변수를 바꿨을 수 있다. 그 뒤의 `SET [SESSION] SQL_MODE = DEFAULT`와, 호출 뒤 다시 정하지 않은 사용자 변수에서 되돌리는 `SET SQL_MODE = @m`이 정한 세션 SQL_MODE는 모르는 값이라, 그 뒤에 만드는 루틴은 받지 않고 다시 추출하도록 안내한다(그 `SET`은 받는다, 리뷰 10회차). 한 `SET` 문 안에서 MySQL은 모든 대입의 값을 먼저 계산한 뒤(이때 함수가 돈다) 차례로 대입하고, DEFAULT는 대입할 때 전역 값을 읽는다. 그래서 뒤 대입이 부르는 함수도 앞의 DEFAULT에 걸린다. 사용자 변수는 값을 계산할 때 읽으므로 호출 앞의 대입은 옛 값을 읽고, 호출 뒤에 계산하는 값은 함수가 바꿨을 수 있어 모른다. 대입은 호출 뒤에 반영하므로 호출 앞에 쓴 대입(`SET @a = '…', time_zone = '+00:00', GLOBAL x = f()`)의 값은 안다(8.0/8.4 실측, 리뷰 11회차 Claude F2). 세션 sql_mode는 MySQL이 함수에서 돌아올 때 되돌리므로 그대로 쓴다(8.0/8.4 실측, 리뷰 8회차).
    - 한계: 기준 버전의 루틴을 서버 값과 다른 SQL_MODE로 만들었으면(`SET sql_mode` 뒤에 만든 루틴이 많으면) 그 값을 서버 값으로 잘못 짐작한다. 짐작한 값에 `NO_BACKSLASH_ESCAPES`가 있으면 백슬래시가 든 문장은 거부한다(3.2). 짐작한 값에 `IGNORE_SPACE`가 있으면 리터럴로 다시 정하기 전까지 공백을 끼운 `NOW ()` 같은 호출을 저장 함수 호출로 센다(3.2, 보수적). 대화상자에 서버 SQL_MODE 칸은 두지 않는다.
    - 모드 이름은 MySQL 순서로 정렬하고 중복을 지운다(SHOW CREATE 의 `sql_mode` 표기). 묶음 모드(`ANSI`·`TRADITIONAL`)와 테이블 문장을 다르게 읽게 하는 `REAL_AS_FLOAT`·`ANSI_QUOTES`는 거부하고 다시 추출하도록 안내한다(3.2).
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
- **COMMENT 길이:** 엄격 SQL_MODE에서 1024자를 넘는 컬럼 COMMENT(1629)·인덱스 COMMENT(1688), 2048자를 넘는 테이블 COMMENT(1628). 엄격하지 않은 세션은 MySQL이 잘라 저장하므로 3.2에서 거부한다(리뷰 11회차 Claude F1)

MySQL의 모든 검사를 재현하지는 않는다. 화면 안내와 이 문서에 "실제 DB에 적용했을 때 MySQL이 거부할 수 있는 스크립트를 이 도구가 받아들일 수 있다"고 적는다. 예를 들어 키 전체 길이 한도(키 파트 합 3072바이트, 1071)나 행 크기 한도(1118) 검사는 하지 않고, TIMESTAMP의 표현 범위(서버 시간대에 따라 달라진다)도 보지 않는다. 두 한도는 엄격하지 않은 세션에서도 MySQL이 거부하므로 모델이 조용히 틀어지지 않는다. 키 파트 하나와 `VARCHAR`의 바이트 한도는 엄격하지 않은 세션이 정의를 바꿔 받으므로 거부한다(3.2).

## 5. 구조

### 5.1 `@tdm/core` — 새 디렉터리 `src/apply/`

순수 TypeScript이고 런타임 의존성이 없으며 `node:`를 쓰지 않는다. 모델은 바꾸지 않고 새 객체를 돌려준다.

| 파일 | 책임 |
|---|---|
| `index.ts` | `applyScript(model, script, { schemaName, defaults?, sqlMode? }): ApplyResult` — 문장을 나누고(기존 문장 나누기·세션 SQL_MODE 추적 재사용 — `splitForApply`는 `splitDump`에 문장의 원문 자리와 실행 주석 표지·ASCII 밖 공백을 더하는데, 앞의 문장 없는 덩어리·DELIMITER 줄의 것과 마지막 문장 뒤의 것은 따로 둔다) 문장마다 처리기로 보낸다. 실패하면 즉시 `{ ok: false, error }`. `sqlMode`는 처음 세션 SQL_MODE(스크립트를 실행한 서버의 sql_mode)이고, `SET SQL_MODE` 값처럼 검사해(`resolveSqlMode`, 받지 않는 값은 특정 문장이 아닌 실패) MySQL 순서로 맞춘다. 안 주면 MySQL 기본 모드다 |
| `types.ts` | 공용 타입, `ApplyFailure`, `MYSQL_DEFAULTS`, `DEFAULT_SQL_MODE` |
| `normalize-mysql.ts` | 4장의 정규화 규칙(타입·기본값·NULL·문자셋), `finalizeColumn` |
| `options.ts` | 테이블 옵션 값 정규화와 SHOW CREATE 옵션 순서 |
| `def-parser.ts` | 사람이 쓴 컬럼 정의·인덱스 정의·FK 정의를 읽는 관대한 파서. 백틱 없는 이름, 소문자 키워드, 생략 가능한 키워드, 컬럼 안 제약을 받는다. 기존 lexer·cursor·parse-table 의 키 파트·FK 파서 재사용 |
| `state.ts` | 작업용 모델 사본, 세션 값, 기준 이름 추적(rename 매핑용) |
| `session.ts`·`client-charset.ts` | `SET` 문 (FOREIGN_KEY_CHECKS·SQL_MODE·time_zone·세션 문자셋·콜레이션, `@OLD_…` 저장·복원, 값을 모르는 변수에서 정한 모르는 값, 값을 모두 계산한 뒤 차례로 대입). UTF-8이 아닌 세션 문자셋의 ASCII 밖 글자 거부 |
| `unknown-session.ts` | 모르는 세션 값(SQL_MODE·FOREIGN_KEY_CHECKS)에 기대는 문장 거부 (3.2 모르는 세션 값) |
| `version-comment.ts`·`unicode-space.ts` | 실행 주석의 버전 번호: 8.0·8.4가 모두 실행하는 것, 모두 건너뛰는 것, 판에 따라 갈리는 것(거부)을 가르고 이 문장에서 MySQL이 실행하는 글을 만든다 (3.1). 건너뛰는 실행 주석 안의 주석·줄 주석 거부. 따옴표·주석 밖의 ASCII가 아닌 공백 거부 — 문장 앞의 문장 없는 덩어리·DELIMITER 줄 포함 (3.2, 리뷰 11회차·12회차) |
| `stored-call.ts`·`native-functions.ts` | 무시하는 문장 속 저장 함수 호출 찾기, MySQL 8.0/8.4 내장 함수 이름 목록과 공백·주석·`IGNORE_SPACE` 판정 (3.2) |
| `comment-length.ts` | 컬럼·인덱스 1024자, 테이블 2048자를 넘는 COMMENT: 정의 파서가 던지고 세션 SQL_MODE에 맞는 안내(엄격하면 MySQL 오류 번호, 아니면 RE_EXPORT)로 바꾼다 (4.1·3.2, 리뷰 11회차) |
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
- **계산량:** 서버 한도(1,000,000자)를 채운 스크립트도 몇 초 안에 끝나야 한다(서버는 한 프로세스라 적용하는 동안 다른 요청이 멈춘다). 테이블 하나의 계산은 키 64개·컬럼 1017개·FK 64개 한도(4.1, 3.2)로 묶고, 문장마다 드는 시간이 스크립트 길이·테이블 수·FK 수에 비례하지 않게 한다(문장 줄 번호, 자동 인덱스 짝 비교, 이름 찾기). 키·컬럼이 한도까지 많은 테이블(컬럼 1017개, 키 64개 × 16 파트)도 키 순서를 정할 때 키 파트의 컬럼을 이름 표로 찾고, 컬럼 절이 없는 문장은 컬럼 목록을 다시 훑지 않으며, 키 파트 바이트(3.2)는 키·키에 든 컬럼의 정의·`ROW_FORMAT`을 건드린 문장만 다시 본다(리뷰 4회차 M-2). 컬럼 정의를 바꾸는 문장은 컬럼 수에 비례한다. 문장 하나 안의 건너뛰는 실행 주석(3.1)과 ASCII 밖 공백(3.2)도 문장 길이에 비례한다: 둘 다 원문 자리 순서라 공백 검사는 두 목록을 한 번에 훑고, 건너뛴 글을 지운 문장은 조각을 모아 한 번에 잇는다(리뷰 12회차 Claude F2 — 주석마다 문장 전체를 다시 잇고 공백마다 주석을 모두 훑던 때는 `/*!99999*/` 5만 개와 NBSP 50만 개가 든 1,000,000자 문장 하나가 28초였다. 이 꼴은 3초 안을 본다). 패턴마다 1,000,000자 스크립트가 시간 안에 끝나는지 단위 테스트(`test/apply/apply-performance-*.test.ts`)가 본다.

### 5.2 서버

- **마이그레이션 `009_version_derivations.sql`:**
  - `schema_version_derivations(version_id PK → schema_versions ON DELETE CASCADE, base_version_id → schema_versions ON DELETE SET NULL, base_version_no INTEGER NOT NULL, script TEXT NOT NULL, statement_count INTEGER NOT NULL, default_charset TEXT NOT NULL, default_collation TEXT NOT NULL)`. `base_version_no`는 기준 버전이 지워져도 배지에 `기준 vN`을 보여 주려고 남긴다
- **`POST /versions/:id/alter`:**
  - 권한은 admin·dba이다. `onRequest`에서 검사하는 기존 방식을 따르고 CSRF 헤더도 기존대로 요구한다.
  - 본문은 JSON `{ script: string, filename?: string, note?: string, dryRun?: boolean, defaults?: { charset?: string, collation?: string }, expectedBase?: { schemaId: number, versionNo: number, modelHash: string, uploadedAt: string, databaseName: string, schemaName: string, latestVersionNo: number }, allowHistoricalBase?: boolean }`이다. 저장(`dryRun`이 아님)에는 `expectedBase`가 꼭 있어야 한다(없으면 400). `script`는 1,000,000자까지, 요청 본문은 4 MiB까지 받는다(`apps/server/src/limits.ts`의 `MAX_ALTER_SCRIPT`·`ALTER_BODY_LIMIT`). JSON 문자열의 따옴표 이스케이프로 본문이 늘어나는 만큼 본문 한도에 여유를 둔다.
  - `:id` 버전이 SQL 출처가 아니거나 stale이면 400을 돌려준다.
  - 스크립트 적용이 실패해도 400이다. 메시지는 `N번째 문장 (줄 L): 이유`이고(특정 문장이 아닌 실패는 이유만), `details.error`에 `{ index, line, statement, reason }`을 담는다.
  - `dryRun: true`면 저장하지 않고 `{ status: 'preview', applied, changes, renames, base }`를 돌려준다. `base`는 기준 버전 지문 `{ schemaId, versionNo, modelHash, uploadedAt, databaseName, schemaName }`(`uploadedAt`은 버전을 만든 시각이고 바뀌지 않는다)과 미리보기 때 그 스키마의 최신 SQL 버전 번호 `latestVersionNo`다(화면이 미리보기 때 이미 더 새 버전이 있었는지 알린다 — 5.3). 저장할 때 이 값을 그대로 `expectedBase`로 돌려보낸다. 아래 두 경우는 409로 거부하고 아무것도 저장하지 않는다. 지문은 모델을 읽기 전에 대조하고, 최신 버전 검사는 중복 판정 뒤에 한다. `expectedBase`를 보낸 미리보기는 첫 경우(지문)만 대조한다.
    - 기준 버전이 바뀌었다(지문이 다르다). 지운 버전의 ID를 새 업로드가 다시 받은 경우, 스키마를 통째로 지우고 다시 올려 스키마 ID·버전 번호가 처음부터 다시 쓰인 경우(같은 구조를 올리면 모델 해시까지 같다 — 모델 해시는 테이블·뷰·루틴만 본다, 리뷰 5회차 R5-01), 데이터베이스 이름을 바꾼 경우다. 메시지는 미리보기를 다시 하라는 안내다.
    - 저장할 때 기준 버전이 스키마의 최신 SQL 버전이 아니다(다른 사용자의 ALTER 적용·업로드 — 미리보기 앞이든 뒤든). 그대로 저장하면 그 버전의 변경이 빠진 결과가 스키마의 최신 버전이 된다. 메시지는 기준 버전(vN)보다 더 새 버전(vM)이 있으니 최신 버전에서 미리보기를 다시 하라는 안내이고, `details.latestVersion`에 최신 SQL 버전 `{ id, versionNo }`를 담는다. MD 버전은 기준이 될 수 없어 세지 않는다(리뷰 5회차 M-2). 옛 버전을 기준으로 저장하는 것은 요청이 `allowHistoricalBase: true`로 밝힐 때만 받는다(화면은 사용자가 기준 버전 선택에서 최신이 아닌 버전을 직접 고른 경우만 보낸다). 일부러 고른 옛 기준인지를 버전 번호로 짐작하지 않는다: 5회차는 미리보기 때 이미 더 새 버전이 있던 기준을 일부러 고른 것으로 보았는데, 화면이 저절로 고른 기준도 그렇게 보여 그 사이 저장된 변경이 빠졌다(리뷰 6회차 — 409 뒤에 또 저장된 버전, 대화상자를 연 뒤·미리보기 전에 저장된 버전). `allowHistoricalBase`는 지문 대조를 건너뛰지 않는다. 중복 판정이 먼저다: 결과가 스키마의 최신 버전과 같으면(같은 저장을 다시 보냄 — 응답을 받지 못해 다시 누름, 같은 미리보기를 연 다른 탭) 빠지는 변경이 없으므로 지금처럼 `duplicate`로 그 버전을 돌려준다. 그래서 이 검사는 저장이 새 버전을 만들 때만 한다.
  - `changes`는 기준과 결과를 기존 비교 엔진으로 비교해 바뀌는 객체를 모은 목록이고 항목은 `{ kind, name, op }`이다(`kind`는 table·view·function·procedure, `op`는 add·drop·modify·rename). `renames`는 `applyScript`가 모은 이름 대응이다. 저장하면 `{ status: 'ok' | 'duplicate', versionId, versionNo, applied, changes }`를 돌려준다.
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
- 저장은 미리보기가 돌려준 `base`를 `expectedBase`로 그대로 보낸다. 409로 거부되면 미리보기를 지우고 서버 메시지를 보인다. 지문이 바뀐 409는 버전 목록을 다시 받아 화면의 기준 버전을 서버의 것에 맞춘다.
- 기준 버전보다 더 새 SQL 버전이 있다고 알면(저장 409의 `details.latestVersion`, 또는 미리보기의 `latestVersionNo`가 기준 버전 번호보다 큼 — 대화상자를 연 뒤 다른 사용자가 저장함) 그 미리보기는 남기지 않는다. 버전 목록을 새로 받아 그 목록의 최신 SQL 버전으로 기준 버전을 옮기고, 그 버전에서 새 미리보기를 내야 저장할 수 있다. 409가 알려 준 버전으로 옮기지 않는다: 목록이 오는 사이 또 다른 버전이 저장되면 그 버전도 옛 버전이다(리뷰 6회차). 목록을 받는 동안은 미리보기·저장을 막고, 옮긴 버전과 이유를 알린다. 목록을 받지 못하면 이유를 알린다. 다시 낸 미리보기가 더 새 버전을 알리면 다시 받는다.
- 사용자가 기준 버전 선택에서 최신 SQL 버전이 아닌 버전을 직접 고르면(옛 버전을 일부러 고름) 미리보기가 더 새 버전을 알려도 그대로 두고, 저장에 `allowHistoricalBase: true`를 보낸다. 대화상자가 저절로 고른 기준(열 때의 최신, 저장 뒤나 더 새 버전을 안 뒤에 옮긴 버전)에는 보내지 않는다. 최신 버전을 찾는 중에 기준 버전을 직접 고르면 늦게 온 목록으로 옮기지 않는다.
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
