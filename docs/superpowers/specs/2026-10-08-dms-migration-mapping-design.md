# DMS 전환 매핑 — 설계

작성일: 2026-10-08 · 상위 설계: [2026-10-07-table-diff-manager-design.md](2026-10-07-table-diff-manager-design.md) · 상태: 구현 완료 ([구현 계획](../plans/2026-10-08-dms-migration.md))

## 1. 목적

버전 관리와 별개로, 기존 DB를 새 시스템으로 옮기면서 테이블·컬럼 이름을 바꾸는 **DB 전환**을 보여 준다. 지금은 테이블 이름이 바뀌면 diff가 drop + add로만 보인다. AWS DMS table-mapping JSON을 올리면:

- 전환 표에 As-Is → To-Be 테이블·컬럼 대응과 상태를 보여 주고,
- 같은 매핑을 rename으로 해석해 기존 객체 diff·DDL에도 반영한다.

BASE(As-Is)·TARGET(To-Be) 스키마는 지금처럼 각각 업로드하고, 매핑은 추가 옵션이다.

## 2. 입력: AWS DMS table-mapping JSON

```json
{ "rules": [
  { "rule-type": "selection", "rule-id": "1", "rule-name": "1",
    "object-locator": { "schema-name": "astore", "table-name": "tacm_prm" }, "rule-action": "include" },
  { "rule-type": "transformation", "rule-id": "94", "rule-name": "94", "rule-target": "table",
    "object-locator": { "schema-name": "astore", "table-name": "tacm_prm" }, "rule-action": "rename", "value": "promotion" },
  { "rule-type": "transformation", "rule-id": "187", "rule-name": "187", "rule-target": "column",
    "object-locator": { "schema-name": "astore", "table-name": "tacm_prm", "column-name": "PRM_ID" },
    "rule-action": "rename", "value": "promotion_id" },
  { "rule-type": "transformation", "rule-id": "1465", "rule-name": "1465", "rule-target": "column",
    "object-locator": { "schema-name": "astore", "table-name": "tacm_prm", "column-name": "MAX_DC_APLY_CNT" },
    "rule-action": "remove-column" },
  { "rule-type": "transformation", "rule-id": "1464", "rule-name": "1464", "rule-target": "schema",
    "object-locator": { "schema-name": "astore" }, "rule-action": "rename", "value": "openapi" }
] }
```

실제 샘플(로컬 `samples/dms/`, 추적 제외): 룰 1,967개 = selection include 93, table rename 93, column rename 1,277, remove-column 503, schema rename 1.

### 해석 규칙

| 룰 | 해석 |
|---|---|
| `selection` / `include` | 전환 대상 테이블. `%` 와일드카드(LIKE 의미)를 지원한다 |
| `selection` / `exclude` | 전환 대상에서 뺀다. include 보다 우선 |
| `transformation` / `schema` / `rename` | To-Be 스키마 이름 (표시·검증용) |
| `transformation` / `table` / `rename` | 테이블 rename |
| `transformation` / `column` / `rename` | 컬럼 rename |
| `transformation` / `column` / `remove-column` | To-Be 에서 빠지는 컬럼 |
| 그 밖의 action·target (`add-column`, `change-data-type`, `convert-lowercase`, `add-prefix`, `index` 등) | 반영하지 않고 경고로 남긴다 |

- selection 룰이 하나도 없으면 As-Is 의 모든 테이블이 전환 대상이다.
- **모든 `object-locator` 는 As-Is 이름 기준이다.** 컬럼 룰의 테이블은 테이블 rename 을 거쳐 To-Be 테이블을 찾는다.
- 이름 비교는 **대소문자를 무시**한다. 샘플의 컬럼명은 전부 대문자(`PRM_ID`)이고 MySQL 컬럼명은 대소문자를 구분하지 않는다. 테이블명도 같은 규칙을 쓰되, 정확히 일치하는 것을 먼저 고른다.
- locator 의 `%` 와일드카드는 selection 에서만 지원한다. transformation 의 와일드카드(예: 모든 테이블 이름 소문자화)는 경고로 남긴다.
- 같은 대상에 대한 rename 룰이 둘 이상이면 rule-id 가 큰 쪽을 쓰고 경고한다.
- JSON 이 아니거나 `rules` 배열이 없으면 업로드를 거부한다(400). 룰은 20,000개까지.

## 3. 데이터 모델과 적용 범위

전환 매핑은 **Schema 쌍**(As-Is Schema → To-Be Schema)에 붙는다. 같은 쌍에 다시 올리면 리비전이 1 늘고, 최신 리비전이 적용된다. 어느 버전 쌍을 비교하든 BASE 버전의 Schema 가 매핑의 From, TARGET 버전의 Schema 가 To 이면 최신 리비전을 자동 적용한다. 역방향(To → From) 비교에는 그 매핑을 뒤집어 rename 으로 반영한다(되돌리기 DDL 이 DROP TABLE/DROP COLUMN 대신 RENAME 을 쓰도록). 같은 버전 쌍에 정방향 매핑이 있으면 그것이 우선한다. 전환 표(`/migration-flow`)는 정방향 쌍에서만 보여 준다.

처음에는 `002_migration_mappings.sql` 이 원문(`source`)을 같은 테이블에 두고 리비전을 `MAX+1` 로 정했다. 스키마 v3(마이그레이션 003)에서 다음처럼 바꿨다(STRICT).

```sql
CREATE TABLE migration_mappings (          -- 메타만
  id INTEGER PRIMARY KEY,
  from_schema_id INTEGER NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  to_schema_id INTEGER NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  filename TEXT NOT NULL,
  rule_count INTEGER NOT NULL,
  note TEXT,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL,
  UNIQUE (from_schema_id, to_schema_id, revision),
  CHECK (from_schema_id <> to_schema_id)
) STRICT;
CREATE TABLE migration_mapping_sources (   -- DMS JSON 원문 (최대 20MB) 분리
  migration_id INTEGER PRIMARY KEY REFERENCES migration_mappings(id) ON DELETE CASCADE,
  source TEXT NOT NULL
) STRICT;
CREATE TABLE migration_pairs (             -- 쌍별 다음 리비전 번호 (지운 리비전 번호를 재사용하지 않는다)
  from_schema_id INTEGER NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  to_schema_id INTEGER NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  next_revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (from_schema_id, to_schema_id)
) STRICT;
```

Schema·Database 를 지우면 연쇄 삭제된다.

### 수동 rename 매핑과의 관계

DMS 매핑이 기본이고, 화면에서 넣는 수동 rename 매핑(`rename_mappings`, 버전 쌍 단위)은 보정이다. 같은 대상(`kind`, `table`, `from`)이면 수동이 이긴다. 결과 rename 에는 출처(`dms` / `manual`)를 붙여 화면에 표시한다. 수동 매핑 한도(500)는 그대로 두고, DMS 에서 나온 rename 에는 적용하지 않는다.

## 4. 구성 요소

### packages/core (런타임 의존성 0 유지)

- `dms-mapping.ts`
  - `parseDmsMapping(text: string, opts?: { fromSchema?: string }): { mapping: DmsMapping; warnings: DmsWarning[] }` — `fromSchema`(BASE Schema 이름)를 지정하면 그 스키마 룰만 쓴다("구현 중 구체화한 사항" 참고)
  - `DmsMapping`: `fromSchema`, `toSchema?`, `selection`(include/exclude 패턴), `tables`(As-Is → To-Be), `columns`(As-Is 테이블별 As-Is → To-Be 컬럼), `removedColumns`(As-Is 테이블별)
  - `DmsWarning`: `{ ruleId, code: 'unsupported' | 'duplicate' | 'invalid', message }`
- `migration-flow.ts`
  - `toRenameMappings(mapping, base: SchemaModel, target: SchemaModel): RenameMapping[]` — 컬럼 rename 의 `table` 을 To-Be 테이블명으로, 이름을 모델의 실제 표기(대소문자)로 맞춘다. 양쪽 모델에 없는 대상은 만들지 않는다.
  - `toReverseRenameMappings(mapping, asIs, toBe)` / `flowRenameMappings(flow, direction)` — 역방향(BASE = To-Be) 비교용. 테이블은 To-Be → As-Is 로 뒤집고, 컬럼 rename 의 `table` 은 역방향 TARGET 인 As-Is 테이블명이다. remove-column 은 역방향에선 ADD COLUMN 이 되므로 diff 에 맡긴다.
  - **삭제와 rename 이 같은 이름에서 겹칠 때** (예: `t(a,b)` 에 remove-column `a` + `b→a`, 또는 `b→c` 와 To-Be 신규 컬럼 `b`): 해당 컬럼 rename 에 `allowOverlap: true` 를 붙인다. `diffSchemas` 는 rename 을 먼저 짝짓고 겹친 같은 이름 컬럼은 DROP·ADD 로 처리한다. 정방향은 `DROP COLUMN a, RENAME COLUMN b TO a`, 역방향은 `ADD COLUMN a …, RENAME COLUMN a TO b` 로 한 ALTER 안에 나와 값 대응이 유지된다(MySQL 8.0/8.4 실증, 골든 `remove-rename-column`·`remove-rename-column-reverse`).
  - 순서로 풀 수 없는 충돌(맞바꾸기·연쇄 rename 처럼 `이름 충돌` 로 적용되지 않은 컬럼 rename)이 있는 테이블은 그 테이블의 모든 문장(FK 삭제·추가, 테이블 rename, ALTER, 파티션)을 실행 SQL 로 내지 않고 `[수동 확인 필요]` 주석 문장(`comment: true`, `notes` 에 겹친 매핑)으로 바꾼다.
  - `buildMigrationFlow(base: SchemaModel, target: SchemaModel, mapping: DmsMapping): MigrationFlow`
    - 테이블 행: `asIs?`, `toBe?`, `status` — `ok`(양쪽 존재) / `missing-target`(To-Be 에 없음) / `missing-source`(As-Is 에 없음) / `excluded`(selection 밖) / `unmapped-target`(어느 As-Is 와도 이어지지 않은 To-Be 테이블)
    - 컬럼 행: `asIs?`, `toBe?`, 양쪽 타입, `status` — `renamed` / `same`(이름 그대로) / `removed`(remove-column) / `added`(To-Be 에만 있음) / `dropped`(As-Is 에 있는데 룰도 To-Be 대응도 없음) / `missing`(룰이 가리키는 컬럼이 모델에 없음)
    - 합계: 상태별 테이블·컬럼 수, 검증 통과 테이블 수(`ok` 이고 컬럼 `missing` 이 없음)

### apps/server

- 마이그레이션 `002_migration_mappings.sql` (3절), 스키마 v3 에서 `003_schema_v3.sql` 로 원문·리비전 카운터 분리
- `repos/migrations.ts`: 추가(`migration_pairs` 카운터로 리비전 발급), 목록, 최신 조회, 원문, 삭제
- 라우트 (`/api`, 상태 변경은 `X-Requested-With: tdm` 필요)

| 메서드 | 경로 | 권한 | 설명 |
|---|---|---|---|
| POST | `/migrations` | admin, dba | JSON 본문 `{ fromSchemaId, toSchemaId, filename, source, note? }`. 파싱 실패·From Schema 룰 없음은 400, 경고는 응답에 포함 |
| GET | `/migrations?from=&to=` | 로그인 | 쌍의 리비전 목록(원문 제외) |
| GET | `/migrations/:id/source` | 로그인 | 원문 다운로드 |
| DELETE | `/migrations/:id` | admin, dba | 리비전 삭제 |
| GET | `/migration-flow?base=&target=` | 로그인 | 적용 매핑 메타 + `MigrationFlow` + 파싱 경고. 매핑이 없으면 `{ mapping: null }` |

- 업로드 본문은 JSON 이고 크기 상한은 기존 업로드 상한(20MB)과 같다.
- `computeDiff`: 쌍의 최신 매핑이 있으면 `toRenameMappings` 결과와 수동 매핑을 합쳐(수동 우선) `diffSchemas` 에 넘긴다. 정방향 매핑이 없고 역쌍(TARGET → BASE) 매핑이 있으면 뒤집은 rename 을 쓴다(`source: 'dms'`). 캐시 키에 매핑 방향·id 를 넣고, 매핑 추가·삭제와 버전·Schema·Database 삭제 시 캐시를 비운다. 응답의 `renames` 항목에 `source: 'dms' | 'manual'` 을 붙인다.
- 매핑 캐시: diff 요청마다 원문(최대 20MB)을 읽지 않도록 캐시 키용으로는 최신 매핑 id 만 조회하고(`latestMigrationId`), 원문은 캐시 miss 때만 읽는다. 파싱 결과(mapping + warnings)는 매핑 id, 전환 표는 매핑 id + As-Is·To-Be 버전 id 를 키로 diff 캐시와 같은 LRU 에 둔다. `GET /diff`·`PUT /diff/renames`·`GET /migration-flow` 가 함께 쓰고, diff 캐시와 같은 시점에 비운다.
- `/diff` 라우트는 로그인을 `onRequest` 에서 확인한다(본문 파싱 전 401). `PUT /diff/renames` 는 admin·dba 만 할 수 있고 이 권한도 `onRequest` 에서 확인한다(viewer 는 본문 파싱 전 403).

### apps/web

- diff 화면에 **전환** 탭 추가 (요약 / 객체 diff / DDL / 전환). URL `tab=migration`.
- 매핑이 없으면 안내 문구와, admin·dba 에게 **매핑 올리기** 버튼.
- 올리기 대화상자: JSON 파일 1개, 브라우저에서 `parseDmsMapping` 으로 미리보기(룰 수, action 별 수, 경고, 파일의 schema 이름과 현재 BASE/TARGET Schema 이름 비교). 메모 입력. 기존 UploadDialog 의 포커스 트랩·검증 패턴을 따른다.
- 전환 표: 헤더에 파일명·리비전·룰 수·검증 수(통과/전체), 리비전 선택은 하지 않고 최신만 표시(목록·삭제는 헤더 메뉴). 검색(As-Is·To-Be 테이블·컬럼명), 필터(전체 / 이름변경 / 컬럼삭제 / 문제 / 신규), 테이블 행 펼치면 컬럼 매핑(As-Is 이름·타입 → To-Be 이름·타입, 상태 배지).
- 객체 diff·DDL 은 rename 반영이 자동이다. 기존 rename 배너에 출처(DMS / 수동)를 표시한다.

## 5. 오류 처리

- 파싱 불가 JSON, `rules` 없음, 룰 수 초과 → 400, 한국어 메시지.
- From/To Schema 가 같거나 없으면 400/404.
- 파일의 `schema-name` 이 From Schema 이름과 다르면, 파일의 스키마가 하나뿐일 때는 업로드를 허용하고 경고로 돌려준다(Schema 이름을 바꿔 올리는 경우가 있어서). 파일에 여러 스키마가 있는데 From Schema 룰이 하나도 없으면 400("매핑에 '<name>' 스키마 룰이 없습니다"), 미리보기에도 같은 오류를 보여 준다.
- 적용 시 모델에 없는 대상을 가리키는 룰은 diff 에 영향을 주지 않고, 전환 표에서 `missing-*` 상태로 드러난다.

## 6. 테스트

- 픽스처: 실제 샘플을 3개 테이블 분량으로 줄이고 이름을 가린 `packages/core/test/fixtures/dms/` (JSON + As-Is/To-Be SQL). 전체 샘플 파일은 로컬에 있을 때만 도는 테스트(`samples/dms` 존재 시)로 룰 수와 경고 0을 확인한다.
- core: action 별 파싱, 미지원 action 경고, 중복 rename, selection 와일드카드·exclude, 대소문자 무시 매칭, `toRenameMappings`(To-Be 테이블명 치환), `buildMigrationFlow` 상태별 사례, 반영 후 `diffSchemas` 에서 drop+add 대신 rename 이 나오는지.
- server: 권한(anon 401 / viewer 403 / dba·admin), 리비전 증가, flow API, diff 에 DMS rename 반영과 수동 우선, 역방향 매핑 반전(RENAME, DROP 없음), Schema 삭제 시 연쇄 삭제, 캐시 무효화.
- web: 전환 탭 렌더, 매핑 없음 안내, 필터·검색·펼치기, 업로드 대화상자 미리보기·권한.

## 7. 범위 밖

- 미지원 DMS action(`add-column`, `change-data-type`, 대소문자·접두사 변환, 인덱스 룰)의 실제 반영
- 전환 표 CSV·엑셀 내보내기
- TARGET 버전 없이 매핑만으로 To-Be 스키마 예측

## 구현 중 구체화한 사항

- rename 배너는 수동 rename 만 저장한다. DMS 에서 온 rename 은 수동 매핑으로 덮어쓸 뿐 제거하지 않는다.
- selection 와일드카드는 `%` 만 지원하며 `_` 는 문자 그대로 취급한다.
- JSON 본문 한도는 40MB, 그 안의 `source` 는 20MB 이하로 제한한다.
- 상태가 ok 가 아닌 테이블에는 컬럼 행을 만들지 않는다.
- 같은 Schema 끼리 비교하면 전환 탭이 안내 문구를 보여 준다.
- `PUT /diff/renames` 는 DMS 로 계산된 rename 과 같은 항목을 수동 한도(500개) 적용 전에 서버에서 버린다.
- `fromSchema`: 서버(업로드·적용)와 웹 미리보기는 BASE(As-Is) Schema 이름을 `parseDmsMapping(text, { fromSchema })` 로 넘기고, 그 스키마(대소문자 무시)의 룰만 쓴다. 지정하지 않으면 룰 순서상 첫 번째로 와일드카드(`%`)가 없는 `schema-name` 이다(모두 와일드카드면 `%`). 이와 맞지 않는 schema 의 룰은 경고로 남기고 반영하지 않는다.
- 길이 상한: 룰마다 schema·table·column·value·rule-id·rule-type·rule-action·rule-target 이 256자를 넘으면 `invalid` 경고로 버리고, 통과한 룰만 `fromSchema` 후보·비교에 쓴다(거대한 schema-name 이 매 룰 비교에 쓰이는 DoS 방지). 경고 메시지에 넣는 사용자 값은 64자로 잘라 표시한다.
- 웹의 diff·전환 표 쿼리는 `staleTime` 30초에 쿼리별로 `refetchOnWindowFocus: true`·`refetchInterval` 60초를 켠다(전역 기본값은 그대로, 백그라운드 탭에선 주기 재조회가 멈춘다). 다른 사용자가 바꾼 매핑·수동 rename 은 창으로 돌아오거나 다음 주기에 반영된다. DDL 탭의 전체 복사·다운로드는 직전에 최신 diff 를 `fetchQuery` 로 다시 받아 그 결과를 쓰고, 문장 복사는 그 문장이 최신 DDL 에 없으면 복사하지 않고 알린다. 객체 diff 카드의 DDL 복사도 최신 diff 에서 그 객체의 문장을 골라 복사한다.
