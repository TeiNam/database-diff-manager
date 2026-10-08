# DMS 전환 매핑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AWS DMS table-mapping JSON 을 As-Is Schema → To-Be Schema 쌍에 올려, 전환 탭에 테이블·컬럼 대응과 상태를 보여 주고, 같은 매핑을 rename 으로 해석해 기존 객체 diff·DDL 에도 반영한다.

**Architecture:** 해석은 `@tdm/core` 의 순수 함수 두 개가 맡는다 — `parseDmsMapping`(JSON → `DmsMapping` + 경고)과 `buildMigrationFlow`/`toRenameMappings`(모델 두 개 + 매핑 → 전환 표 / diff 용 rename). 서버는 원문 JSON 을 `migration_mappings` 에 리비전으로 저장하고, `computeDiff` 가 BASE 버전 Schema → TARGET 버전 Schema 쌍의 최신 리비전을 찾아 DMS rename 과 수동 rename(수동 우선)을 합쳐 `diffSchemas` 에 넘긴다. 웹은 같은 core 파서로 업로드 전에 브라우저에서 미리보기를 하고, 전환 탭은 `GET /migration-flow` 결과를 표로 그린다.

**Tech Stack:** TypeScript, vitest, Fastify 5 + zod 4 + node:sqlite(`@tdm/server`), React 19 + TanStack Query 5 + react-router 8 + CSS Modules(`@tdm/web`).

**Spec:** `docs/superpowers/specs/2026-10-08-dms-migration-mapping-design.md`

**검증 상태:** Task 1–4 의 코드·픽스처·테스트는 계획 작성 중 임시 작업본에서 실제로 돌려 통과를 확인했다(core 신규 17개, server 전체 193개, 두 패키지 typecheck). Task 3·4 로 나눈 테스트 파일은 그 작업본에서 기계적으로 분리한 것이다. Task 5–6 의 웹 코드는 실행해 보지 않았으므로 각 Step 의 실패·통과 확인을 건너뛰지 않는다.

## Global Constraints

- 대상 DB 는 MySQL 8.0 / 8.4 만. DDL 은 화면에 보여 주고 복사·다운로드만 한다. 절대 실행하지 않는다
- `packages/core`: 런타임 의존성 0, `src` 에서 `node:` import 금지 (`npm run typecheck -w @tdm/core` 가 `tsconfig.src.json` 으로 확인한다). 테스트 파일은 `node:` 를 써도 된다
- UI 문구·코드 주석은 한국어, 식별자는 영어. 스타일은 CSS Modules 와 기존 토큰(`--bg --surface --card --muted --border --border-strong --fg --fg-muted --fg-dim --accent --accent-bg --add --add-bg --del --del-bg --mod --mod-bg --radius --space-* --text-* --mono`)만 쓴다. 색 리터럴 금지. 상태 표시는 색만 쓰지 않고 항상 글자(배지 문구)를 함께 쓴다
- 상태를 바꾸는 모든 요청에는 `X-Requested-With: tdm` 헤더가 있어야 한다(웹은 `api()` 가 붙인다). 매핑 올리기·삭제는 admin 만. 4xx 오류 메시지는 한국어
- DMS 이름 비교는 대소문자를 무시한다(테이블은 정확히 같은 이름을 먼저 고른다). 모든 `object-locator` 는 As-Is 이름이다. 컬럼 룰의 테이블은 테이블 rename 을 거쳐 To-Be 테이블을 찾는다
- 룰은 최대 20,000개. 업로드 원문 상한은 기존 업로드 상한과 같은 20MB. 수동 rename 한도(500)는 그대로이고 DMS 에서 나온 rename 에는 적용하지 않는다
- 매핑은 BASE 버전의 Schema 가 From, TARGET 버전의 Schema 가 To 일 때만 최신 리비전을 자동 적용한다. 역방향(To → From) 비교에는 적용하지 않는다
- 테스트는 vitest. 웹 테스트 주의: `userEvent.setup()` 을 클립보드 스텁보다 먼저 부른다, `mockApi` 는 응답을 매번 복제해서 돌려준다(같은 객체를 여러 번 써도 된다), 다른 경로로 이동하면 라우트 컴포넌트가 언마운트된다
- 코드: 파일 800줄 미만, 함수 50줄 미만, 불변 갱신(배열·Set 은 새로 만들어 교체)
- 커밋: Conventional Commits `type:` 접두어 + 한국어 설명. `samples/`, `bin/`, `mysql.txt`, `.playwright-mcp/`, `.code-review-graph/` 는 절대 스테이징하지 않는다(`git add -A`·`git add .` 금지, 경로를 지정한다)
- 브랜치: `feat/dms-migration` (이미 체크아웃됨)

## File Structure

```
packages/core/
  src/dms-mapping.ts              DMS JSON → DmsMapping + DmsWarning, selection LIKE 매칭        (Task 1)
  src/migration-flow.ts           buildMigrationFlow, toRenameMappings, findByName                 (Task 2)
  src/index.ts                    두 모듈 export                                                   (Task 1, 2)
  test/fixtures/dms/mapping.json  익명화한 DMS 매핑 (테이블 3개, 룰 19개)                          (Task 1)
  test/fixtures/dms/as-is.sql     As-Is 스키마 legacy (selection 밖 테이블 1개 포함)               (Task 1)
  test/fixtures/dms/to-be.sql     To-Be 스키마 newapp (매핑되지 않은 테이블 1개 포함)              (Task 1)
  test/dms-mapping.test.ts                                                                         (Task 1)
  test/migration-flow.test.ts     + 로컬 전용 samples/dms 전체 샘플 테스트                         (Task 2)
apps/server/
  src/db/migrations/002_migration_mappings.sql                                                     (Task 3)
  src/repos/migrations.ts         추가(리비전 계산)·목록·최신·원문·삭제                            (Task 3)
  src/services/migration-service.ts  파싱→400 변환, schema 이름 경고, 업로드, 전환 표 계산        (Task 3, 4)
  src/routes/migrations.ts        /migrations, /migrations/:id/source, /migration-flow             (Task 3, 4)
  src/http.ts                     Content-Disposition 헬퍼 (versions.ts 에서 추출)                 (Task 3)
  src/schemas.ts                  SafeFilename·NoteSchema 공용화 (uploads.ts 에서 이동)            (Task 3)
  src/limits.ts                   MIGRATION_BODY_LIMIT                                             (Task 3)
  src/app.ts                      라우트 등록                                                      (Task 3)
  src/services/diff-service.ts    DMS rename 병합(수동 우선), source 태그, 캐시 키                 (Task 4)
  test/migrations.test.ts  test/migration-diff.test.ts  (+ authz·db·diff·helpers 수정)            (Task 3, 4)
apps/web/
  src/api/types.ts  src/api/hooks.ts                     타입·훅·캐시 규칙                         (Task 5)
  src/hooks/useSchemaContext.ts                          tab=migration                             (Task 5)
  src/pages/SchemaPage.tsx                               전환 탭                                   (Task 5)
  src/lib/migration-filter.ts                            필터·검색 (순수 함수)                     (Task 5)
  src/features/migration/MigrationTab.tsx                탭 본문(헤더·안내·경고)                   (Task 5)
  src/features/migration/MigrationTable.tsx              표(검색·필터·펼치기)                      (Task 5)
  src/features/migration/MigrationRevisions.tsx          리비전 목록·원본·삭제                     (Task 5)
  src/features/migration/StatusBadge.tsx  migration.module.css                                    (Task 5)
  src/hooks/useDialog.ts                                 포커스 이동·Escape·Tab 순환 (UploadDialog 에서 추출) (Task 6)
  src/features/migration/MigrationUploadDialog.tsx       올리기 대화상자(브라우저 미리보기)        (Task 6)
  src/features/upload/UploadDialog.tsx                   useDialog 사용으로 교체                   (Task 6)
  src/features/diff/RenameBanner.tsx  diff.module.css    출처(DMS/수동) 표시, 수동만 저장          (Task 6)
  test/dms-fixture.ts  test/migration-filter.test.ts  test/migration-tab.test.tsx
  test/migration-upload.test.tsx  (+ hooks·schema-page 테스트 수정)                               (Task 5, 6)
README.md  README.ko.md  apps/server/README.md  apps/server/README.ko.md  spec 상태                (Task 7)
```

### 설계 결정 (spec 보다 구체화한 부분)

- `DmsMapping.tables / columns / removedColumns` 는 객체 맵 대신 `ruleId` 를 담은 **배열**이다. 키가 사용자 입력(테이블명)이라 `__proto__` 같은 이름에도 안전하고, 룰 순서를 유지한다
- selection 의 와일드카드는 `%` 만이다(DMS 와 같음). `_` 는 테이블명에 흔해서 글자 그대로 비교한다
- `missing-target`(To-Be 에 없는 테이블)·`missing-source`·`excluded`·`unmapped-target` 행은 컬럼 행을 만들지 않는다. 컬럼 비교는 `ok` 행에서만 한다
- `MigrationFlow.totals.inScope` = `ok + missing-target + missing-source`. 헤더의 "검증 통과/전체" 는 `verified / inScope`
- 웹의 rename 저장(`PUT /diff/renames`)은 **수동 매핑만** 보낸다. DMS 에서 온 rename 을 함께 보내면 수동 한도(500)를 넘고, 매핑을 지워도 수동으로 남기 때문이다. DMS rename 은 배너에서 해제할 수 없고(같은 대상의 수동 매핑으로만 덮어쓴다) 접힌 목록으로 보여 준다
- 업로드 본문은 원문을 JSON 문자열로 담으므로 따옴표 이스케이프만큼 커진다. 라우트 `bodyLimit` 은 40MB 로 두고, 원문 길이는 zod 로 20MB 이하를 확인한다
- 같은 Schema 의 버전끼리 비교할 때는 매핑이 걸릴 수 없으므로(CHECK) 전환 탭은 안내 문구만 보여 준다

---

### Task 1: core — `parseDmsMapping` + 익명화 픽스처

**Files:**
- Create: `packages/core/src/dms-mapping.ts`
- Create: `packages/core/test/fixtures/dms/mapping.json`, `packages/core/test/fixtures/dms/as-is.sql`, `packages/core/test/fixtures/dms/to-be.sql`
- Modify: `packages/core/src/index.ts` (끝에 export 추가)
- Test: `packages/core/test/dms-mapping.test.ts`

**Interfaces:**
- Consumes: 없음 (기존 `test/helpers.ts` 의 `fixture(rel)` 만 쓴다)
- Produces:
  - `MAX_DMS_RULES = 20_000`
  - `type DmsWarningCode = 'unsupported' | 'duplicate' | 'invalid'`
  - `interface DmsWarning { ruleId: string; code: DmsWarningCode; message: string }`
  - `interface DmsTableRename { ruleId: string; from: string; to: string }`
  - `interface DmsColumnRename { ruleId: string; table: string; from: string; to: string }` (`table`·`from` 은 As-Is)
  - `interface DmsRemovedColumn { ruleId: string; table: string; column: string }`
  - `interface DmsMapping { fromSchema: string; toSchema?: string; selection: { include: string[]; exclude: string[] }; tables: DmsTableRename[]; columns: DmsColumnRename[]; removedColumns: DmsRemovedColumn[]; ruleCount: number }`
  - `class DmsParseError extends Error` — JSON 아님 / `rules` 없음 / 룰 수 초과. 메시지는 그대로 사용자에게 보여 줄 한국어
  - `parseDmsMapping(text: string): { mapping: DmsMapping; warnings: DmsWarning[] }`
  - `likePattern(pattern: string): RegExp`, `likeMatch(pattern: string, name: string): boolean`, `isSelected(mapping: DmsMapping, table: string): boolean`

픽스처 설명: 실제 샘플(`samples/dms/…`, astore → openapi)을 테이블 3개로 줄이고 이름을 가렸다. As-Is 스키마 `legacy`, To-Be 스키마 `newapp`. 룰 19개 = selection include 3, table rename 3, column rename 9(샘플처럼 컬럼명은 대문자, 그중 `CUST_GRD` 는 모델에 없는 컬럼), remove-column 2, schema rename 1, 미지원 `convert-lowercase` 1(와일드카드 locator). SQL 은 As-Is 에 selection 밖 테이블 `tb_tmp_bak`, To-Be 에 어느 As-Is 와도 이어지지 않는 `audit_log` 를 하나씩 더 넣었다. As-Is SQL 의 컬럼명은 소문자라 대소문자 무시 매칭을 검증한다.

- [ ] **Step 1: 픽스처 작성**

`packages/core/test/fixtures/dms/mapping.json`:
```json
{
  "rules": [
    { "rule-type": "selection", "rule-id": "1", "rule-name": "1", "object-locator": { "schema-name": "legacy", "table-name": "tb_prm" }, "rule-action": "include" },
    { "rule-type": "selection", "rule-id": "2", "rule-name": "2", "object-locator": { "schema-name": "legacy", "table-name": "tb_prm_cnd" }, "rule-action": "include" },
    { "rule-type": "selection", "rule-id": "3", "rule-name": "3", "object-locator": { "schema-name": "legacy", "table-name": "tb_cust" }, "rule-action": "include" },
    { "rule-type": "transformation", "rule-id": "10", "rule-name": "10", "rule-target": "table", "object-locator": { "schema-name": "legacy", "table-name": "tb_prm" }, "rule-action": "rename", "value": "promotion" },
    { "rule-type": "transformation", "rule-id": "11", "rule-name": "11", "rule-target": "table", "object-locator": { "schema-name": "legacy", "table-name": "tb_prm_cnd" }, "rule-action": "rename", "value": "promotion_condition" },
    { "rule-type": "transformation", "rule-id": "12", "rule-name": "12", "rule-target": "table", "object-locator": { "schema-name": "legacy", "table-name": "tb_cust" }, "rule-action": "rename", "value": "customer" },
    { "rule-type": "transformation", "rule-id": "20", "rule-name": "20", "rule-target": "column", "object-locator": { "schema-name": "legacy", "table-name": "tb_prm", "column-name": "PRM_ID" }, "rule-action": "rename", "value": "promotion_id" },
    { "rule-type": "transformation", "rule-id": "21", "rule-name": "21", "rule-target": "column", "object-locator": { "schema-name": "legacy", "table-name": "tb_prm", "column-name": "PRM_NM" }, "rule-action": "rename", "value": "promotion_name" },
    { "rule-type": "transformation", "rule-id": "22", "rule-name": "22", "rule-target": "column", "object-locator": { "schema-name": "legacy", "table-name": "tb_prm", "column-name": "REG_DT" }, "rule-action": "rename", "value": "created_at" },
    { "rule-type": "transformation", "rule-id": "23", "rule-name": "23", "rule-target": "column", "object-locator": { "schema-name": "legacy", "table-name": "tb_prm_cnd", "column-name": "CND_SEQ" }, "rule-action": "rename", "value": "condition_seq" },
    { "rule-type": "transformation", "rule-id": "24", "rule-name": "24", "rule-target": "column", "object-locator": { "schema-name": "legacy", "table-name": "tb_prm_cnd", "column-name": "PRM_ID" }, "rule-action": "rename", "value": "promotion_id" },
    { "rule-type": "transformation", "rule-id": "25", "rule-name": "25", "rule-target": "column", "object-locator": { "schema-name": "legacy", "table-name": "tb_prm_cnd", "column-name": "CND_VAL" }, "rule-action": "rename", "value": "condition_value" },
    { "rule-type": "transformation", "rule-id": "26", "rule-name": "26", "rule-target": "column", "object-locator": { "schema-name": "legacy", "table-name": "tb_cust", "column-name": "CUST_ID" }, "rule-action": "rename", "value": "customer_id" },
    { "rule-type": "transformation", "rule-id": "27", "rule-name": "27", "rule-target": "column", "object-locator": { "schema-name": "legacy", "table-name": "tb_cust", "column-name": "CUST_NM" }, "rule-action": "rename", "value": "customer_name" },
    { "rule-type": "transformation", "rule-id": "28", "rule-name": "28", "rule-target": "column", "object-locator": { "schema-name": "legacy", "table-name": "tb_cust", "column-name": "CUST_GRD" }, "rule-action": "rename", "value": "customer_grade" },
    { "rule-type": "transformation", "rule-id": "30", "rule-name": "30", "rule-target": "column", "object-locator": { "schema-name": "legacy", "table-name": "tb_prm", "column-name": "MAX_DC_CNT" }, "rule-action": "remove-column" },
    { "rule-type": "transformation", "rule-id": "31", "rule-name": "31", "rule-target": "column", "object-locator": { "schema-name": "legacy", "table-name": "tb_cust", "column-name": "OLD_ADDR" }, "rule-action": "remove-column" },
    { "rule-type": "transformation", "rule-id": "40", "rule-name": "40", "rule-target": "schema", "object-locator": { "schema-name": "legacy" }, "rule-action": "rename", "value": "newapp" },
    { "rule-type": "transformation", "rule-id": "50", "rule-name": "50", "rule-target": "column", "object-locator": { "schema-name": "legacy", "table-name": "%", "column-name": "%" }, "rule-action": "convert-lowercase" }
  ]
}
```

`packages/core/test/fixtures/dms/as-is.sql`:
```sql
/* Database : legacy */
/* Table : tb_cust */
CREATE TABLE `tb_cust` (
  `cust_id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `cust_nm` varchar(50) NOT NULL,
  `old_addr` varchar(200) DEFAULT NULL,
  `tmp_flag` char(1) DEFAULT NULL,
  PRIMARY KEY (`cust_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='고객';
/* Table : tb_prm */
CREATE TABLE `tb_prm` (
  `prm_id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `prm_nm` varchar(100) NOT NULL,
  `max_dc_cnt` int DEFAULT NULL,
  `reg_dt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`prm_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='프로모션';
/* Table : tb_prm_cnd */
CREATE TABLE `tb_prm_cnd` (
  `cnd_seq` int unsigned NOT NULL AUTO_INCREMENT,
  `prm_id` bigint unsigned NOT NULL,
  `cnd_val` varchar(500) DEFAULT NULL,
  `use_yn` char(1) NOT NULL DEFAULT 'Y',
  PRIMARY KEY (`cnd_seq`),
  KEY `ix_cnd_prm` (`prm_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='프로모션 조건';
/* Table : tb_tmp_bak */
CREATE TABLE `tb_tmp_bak` (
  `id` int NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

`packages/core/test/fixtures/dms/to-be.sql`:
```sql
/* Database : newapp */
/* Table : audit_log */
CREATE TABLE `audit_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `message` varchar(255) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/* Table : customer */
CREATE TABLE `customer` (
  `customer_id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `customer_name` varchar(50) NOT NULL,
  `email` varchar(100) DEFAULT NULL,
  PRIMARY KEY (`customer_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='고객';
/* Table : promotion */
CREATE TABLE `promotion` (
  `promotion_id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `promotion_name` varchar(100) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`promotion_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='프로모션';
/* Table : promotion_condition */
CREATE TABLE `promotion_condition` (
  `condition_seq` int unsigned NOT NULL AUTO_INCREMENT,
  `promotion_id` bigint unsigned NOT NULL,
  `condition_value` varchar(1000) DEFAULT NULL,
  `use_yn` char(1) NOT NULL DEFAULT 'Y',
  PRIMARY KEY (`condition_seq`),
  KEY `ix_cnd_prm` (`promotion_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='프로모션 조건';
```

- [ ] **Step 2: 실패하는 테스트 작성**

`packages/core/test/dms-mapping.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DmsParseError, isSelected, likeMatch, MAX_DMS_RULES, parseDmsMapping } from '../src/dms-mapping';
import { fixture } from './helpers';

// 룰 하나를 DMS 형식으로 만든다 (object-locator 의 schema-name 기본값 legacy)
const rule = (id: number, body: Record<string, unknown>) => ({ 'rule-id': String(id), 'rule-name': String(id), ...body });
const sel = (id: number, table: string, action = 'include') =>
  rule(id, { 'rule-type': 'selection', 'object-locator': { 'schema-name': 'legacy', 'table-name': table }, 'rule-action': action });
const tableRename = (id: number, table: string, value: string) =>
  rule(id, { 'rule-type': 'transformation', 'rule-target': 'table', 'object-locator': { 'schema-name': 'legacy', 'table-name': table }, 'rule-action': 'rename', value });
const parse = (rules: unknown[]) => parseDmsMapping(JSON.stringify({ rules }));

describe('parseDmsMapping: 픽스처', () => {
  const { mapping, warnings } = parseDmsMapping(fixture('dms/mapping.json'));

  it('action 별로 나눈다', () => {
    expect(mapping.fromSchema).toBe('legacy');
    expect(mapping.toSchema).toBe('newapp');
    expect(mapping.ruleCount).toBe(19);
    expect(mapping.selection).toEqual({ include: ['tb_prm', 'tb_prm_cnd', 'tb_cust'], exclude: [] });
    expect(mapping.tables.map((t) => [t.from, t.to])).toEqual([['tb_prm', 'promotion'], ['tb_prm_cnd', 'promotion_condition'], ['tb_cust', 'customer']]);
    expect(mapping.columns).toHaveLength(9);
    expect(mapping.columns[0]).toEqual({ ruleId: '20', table: 'tb_prm', from: 'PRM_ID', to: 'promotion_id' });
    expect(mapping.removedColumns.map((r) => `${r.table}.${r.column}`)).toEqual(['tb_prm.MAX_DC_CNT', 'tb_cust.OLD_ADDR']);
  });

  it('미지원 action 은 경고로 남긴다', () => {
    expect(warnings).toEqual([{ ruleId: '50', code: 'unsupported', message: 'column / convert-lowercase 룰은 반영하지 않습니다' }]);
  });
});

describe('parseDmsMapping: 규칙', () => {
  it('JSON 이 아니거나 rules 가 없거나 너무 많으면 DmsParseError', () => {
    expect(() => parseDmsMapping('{')).toThrow(new DmsParseError('JSON 형식이 아닙니다'));
    expect(() => parseDmsMapping('{"rule":[]}')).toThrow('rules 배열이 없습니다');
    expect(() => parseDmsMapping('[]')).toThrow('rules 배열이 없습니다');
    const many = JSON.stringify({ rules: Array.from({ length: MAX_DMS_RULES + 1 }, (_, i) => sel(i, 't')) });
    expect(() => parseDmsMapping(many)).toThrow('룰은 최대 20,000개까지 올릴 수 있습니다 (현재 20,001개)');
  });

  it('BOM 을 무시하고, 숫자 rule-id 도 받는다', () => {
    const { mapping } = parseDmsMapping(`\uFEFF${JSON.stringify({ rules: [{ ...tableRename(1, 'a', 'b'), 'rule-id': 7 }] })}`);
    expect(mapping.tables).toEqual([{ ruleId: '7', from: 'a', to: 'b' }]);
  });

  it('같은 대상의 rename 이 겹치면 rule-id 가 큰 쪽을 쓰고 경고 (대소문자 무시)', () => {
    const { mapping, warnings } = parse([tableRename(9, 'tb_a', 'new_a'), tableRename(3, 'TB_A', 'old_a')]);
    expect(mapping.tables).toEqual([{ ruleId: '9', from: 'tb_a', to: 'new_a' }]);
    expect(warnings).toEqual([{ ruleId: '3', code: 'duplicate', message: '같은 대상의 룰이 겹쳐 rule 9 를 사용합니다' }]);
  });

  it('transformation 의 와일드카드, 필수 값 누락, 다른 스키마는 경고', () => {
    const { mapping, warnings } = parse([
      tableRename(1, 'tb_%', 'x'),
      tableRename(2, 'tb_a', ''),
      { 'rule-id': '3', 'rule-type': 'transformation' },
      rule(4, { 'rule-type': 'transformation', 'rule-target': 'table', 'object-locator': { 'schema-name': 'other', 'table-name': 't' }, 'rule-action': 'rename', value: 'u' }),
      rule(5, { 'rule-type': 'table-settings', 'object-locator': { 'schema-name': 'legacy', 'table-name': 't' }, 'rule-action': 'parallel-load' }),
    ]);
    expect(mapping.tables).toEqual([]);
    expect(warnings.map((w) => [w.ruleId, w.code])).toEqual([
      ['3', 'invalid'], ['1', 'unsupported'], ['2', 'invalid'], ['4', 'invalid'], ['5', 'unsupported'],
    ]);
  });
});

describe('selection', () => {
  it('% 는 LIKE 처럼 아무 문자열, _ 는 글자 그대로, 대소문자 무시', () => {
    expect(likeMatch('tb_%', 'TB_PRM')).toBe(true);
    expect(likeMatch('tb_prm', 'tbxprm')).toBe(false);
    expect(likeMatch('%', 'anything')).toBe(true);
  });

  it('룰이 없으면 전부 대상, exclude 가 include 보다 우선', () => {
    expect(isSelected(parse([]).mapping, 'any')).toBe(true);
    const { mapping } = parse([sel(1, 'tb_%'), sel(2, 'tb_tmp%', 'exclude')]);
    expect(['tb_prm', 'tb_tmp_bak', 'audit'].map((t) => isSelected(mapping, t))).toEqual([true, false, false]);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npm test -w @tdm/core -- test/dms-mapping.test.ts`
Expected: FAIL — `Failed to resolve import "../src/dms-mapping"`

- [ ] **Step 4: 구현**

`packages/core/src/dms-mapping.ts`:
```ts
// AWS DMS table-mapping JSON → 전환 매핑. 모든 object-locator 는 As-Is 이름 기준이고, 이름 비교는 대소문자를 무시한다
export const MAX_DMS_RULES = 20_000;

export type DmsWarningCode = 'unsupported' | 'duplicate' | 'invalid';

export interface DmsWarning {
  ruleId: string;
  code: DmsWarningCode;
  message: string;
}

export interface DmsTableRename {
  ruleId: string;
  from: string; // As-Is 테이블 (locator 원문)
  to: string; // To-Be 테이블
}

export interface DmsColumnRename {
  ruleId: string;
  table: string; // As-Is 테이블
  from: string; // As-Is 컬럼
  to: string; // To-Be 컬럼
}

export interface DmsRemovedColumn {
  ruleId: string;
  table: string; // As-Is 테이블
  column: string; // As-Is 컬럼
}

export interface DmsMapping {
  fromSchema: string;
  toSchema?: string;
  selection: { include: string[]; exclude: string[] }; // table-name 패턴 (% 와일드카드)
  tables: DmsTableRename[];
  columns: DmsColumnRename[];
  removedColumns: DmsRemovedColumn[];
  ruleCount: number;
}

// 업로드 자체를 거부해야 하는 오류 (JSON 아님, rules 없음, 룰 수 초과)
export class DmsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DmsParseError';
  }
}

interface Rule {
  id: string;
  type: string;
  target?: string;
  action: string;
  schema: string;
  table?: string;
  column?: string;
  value?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const lower = (v: string) => v.toLowerCase();
const hasWildcard = (v: string | undefined) => v !== undefined && v.includes('%');

// '%' 만 와일드카드로 본다 (DMS 와 같다). '_' 는 테이블명에 흔해서 글자 그대로 비교한다
export function likePattern(pattern: string): RegExp {
  const body = pattern.split('%').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`, 'i');
}

export const likeMatch = (pattern: string, name: string): boolean => likePattern(pattern).test(name);

// selection 룰이 없으면 전부 대상, exclude 가 include 보다 우선
export function isSelected(mapping: DmsMapping, table: string): boolean {
  const { include, exclude } = mapping.selection;
  const included = include.length === 0 || include.some((p) => likeMatch(p, table));
  return included && !exclude.some((p) => likeMatch(p, table));
}

export function parseDmsMapping(text: string): { mapping: DmsMapping; warnings: DmsWarning[] } {
  const rules = readRules(text);
  const warnings: DmsWarning[] = [];
  const parsed = rules.map((raw, i) => toRule(raw, i, warnings)).filter((r): r is Rule => r !== undefined);
  const fromSchema = parsed.find((r) => !hasWildcard(r.schema))?.schema ?? '%';
  const builder = new MappingBuilder(fromSchema, warnings);
  for (const rule of parsed) {
    if (!likeMatch(rule.schema, fromSchema)) {
      warnings.push({ ruleId: rule.id, code: 'invalid', message: `다른 스키마(${rule.schema})의 룰은 반영하지 않습니다` });
      continue;
    }
    builder.add(rule);
  }
  return { mapping: builder.build(rules.length), warnings };
}

function readRules(text: string): unknown[] {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new DmsParseError('JSON 형식이 아닙니다');
  }
  const rules = isObject(json) ? json.rules : undefined;
  if (!Array.isArray(rules)) throw new DmsParseError('rules 배열이 없습니다');
  if (rules.length > MAX_DMS_RULES) throw new DmsParseError(`룰은 최대 ${MAX_DMS_RULES.toLocaleString('en-US')}개까지 올릴 수 있습니다 (현재 ${rules.length.toLocaleString('en-US')}개)`);
  return rules;
}

function toRule(raw: unknown, index: number, warnings: DmsWarning[]): Rule | undefined {
  const r = isObject(raw) ? raw : {};
  const rawId = r['rule-id'];
  const id = typeof rawId === 'number' ? String(rawId) : str(rawId) ?? `#${index + 1}`;
  const locator = isObject(r['object-locator']) ? r['object-locator'] : undefined;
  const type = str(r['rule-type']);
  const action = str(r['rule-action']);
  const schema = str(locator?.['schema-name']);
  if (!type || !action || !schema) {
    warnings.push({ ruleId: id, code: 'invalid', message: 'rule-type·rule-action·object-locator.schema-name 이 필요합니다' });
    return undefined;
  }
  return {
    id, type, action, schema,
    target: str(r['rule-target']),
    table: str(locator?.['table-name']),
    column: str(locator?.['column-name']),
    value: str(r.value),
  };
}

// rule-id 가 큰 쪽이 이긴다 (숫자로 비교할 수 없으면 문자열 비교)
function isNewer(a: string, b: string): boolean {
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) ? x > y : a > b;
}

class MappingBuilder {
  private readonly include: string[] = [];
  private readonly exclude: string[] = [];
  private readonly schema = new Map<string, { ruleId: string; value: string }>();
  private readonly tables = new Map<string, DmsTableRename>();
  private readonly columns = new Map<string, DmsColumnRename>();
  private readonly removed = new Map<string, DmsRemovedColumn>();

  constructor(private readonly fromSchema: string, private readonly warnings: DmsWarning[]) {}

  add(rule: Rule): void {
    if (rule.type === 'selection') return this.addSelection(rule);
    if (rule.type !== 'transformation') return this.unsupported(rule, `rule-type '${rule.type}'`);
    const kind = `${rule.target ?? ''}/${rule.action}`;
    if (kind === 'schema/rename') return this.addSchemaRename(rule);
    if (kind === 'table/rename') return this.addTableRename(rule);
    if (kind === 'column/rename') return this.addColumnRename(rule);
    if (kind === 'column/remove-column') return this.addRemovedColumn(rule);
    this.unsupported(rule, `${rule.target ?? '(target 없음)'} / ${rule.action}`);
  }

  build(ruleCount: number): DmsMapping {
    return {
      fromSchema: this.fromSchema,
      ...(this.schema.has('') ? { toSchema: this.schema.get('')!.value } : {}),
      selection: { include: [...this.include], exclude: [...this.exclude] },
      tables: [...this.tables.values()],
      columns: [...this.columns.values()],
      removedColumns: [...this.removed.values()],
      ruleCount,
    };
  }

  private addSelection(rule: Rule): void {
    const pattern = rule.table ?? '%';
    if (rule.action === 'include') this.include.push(pattern);
    else if (rule.action === 'exclude') this.exclude.push(pattern);
    else this.unsupported(rule, `selection / ${rule.action}`);
  }

  private addSchemaRename(rule: Rule): void {
    if (!rule.value) return this.invalid(rule, 'value(새 이름)가 없습니다');
    this.keep(this.schema, '', { ruleId: rule.id, value: rule.value });
  }

  private addTableRename(rule: Rule): void {
    if (!rule.table || hasWildcard(rule.table)) return this.wildcard(rule);
    if (!rule.value) return this.invalid(rule, 'value(새 이름)가 없습니다');
    this.keep(this.tables, lower(rule.table), { ruleId: rule.id, from: rule.table, to: rule.value });
  }

  private addColumnRename(rule: Rule): void {
    if (!rule.table || !rule.column || hasWildcard(rule.table) || hasWildcard(rule.column)) return this.wildcard(rule);
    if (!rule.value) return this.invalid(rule, 'value(새 이름)가 없습니다');
    const key = `${lower(rule.table)}.${lower(rule.column)}`;
    this.keep(this.columns, key, { ruleId: rule.id, table: rule.table, from: rule.column, to: rule.value });
  }

  private addRemovedColumn(rule: Rule): void {
    if (!rule.table || !rule.column || hasWildcard(rule.table) || hasWildcard(rule.column)) return this.wildcard(rule);
    const key = `${lower(rule.table)}.${lower(rule.column)}`;
    this.keep(this.removed, key, { ruleId: rule.id, table: rule.table, column: rule.column });
  }

  // 같은 대상의 룰이 또 나오면 rule-id 가 큰 쪽을 남기고, 진 쪽을 경고로 남긴다
  private keep<T extends { ruleId: string }>(map: Map<string, T>, key: string, next: T): void {
    const prev = map.get(key);
    if (!prev) {
      map.set(key, next);
      return;
    }
    const [winner, loser] = isNewer(next.ruleId, prev.ruleId) ? [next, prev] : [prev, next];
    map.set(key, winner);
    this.warnings.push({ ruleId: loser.ruleId, code: 'duplicate', message: `같은 대상의 룰이 겹쳐 rule ${winner.ruleId} 를 사용합니다` });
  }

  private unsupported(rule: Rule, what: string): void {
    this.warnings.push({ ruleId: rule.id, code: 'unsupported', message: `${what} 룰은 반영하지 않습니다` });
  }

  private wildcard(rule: Rule): void {
    this.warnings.push({ ruleId: rule.id, code: 'unsupported', message: 'transformation 의 와일드카드(%)나 빈 이름은 반영하지 않습니다' });
  }

  private invalid(rule: Rule, message: string): void {
    this.warnings.push({ ruleId: rule.id, code: 'invalid', message });
  }
}
```

`packages/core/src/index.ts` 맨 끝에 한 줄 추가:
```ts
export * from './dms-mapping';
```

- [ ] **Step 5: 통과 확인**

Run: `npm test -w @tdm/core -- test/dms-mapping.test.ts && npm run typecheck -w @tdm/core`
Expected: PASS (8 tests), typecheck 오류 없음 (`tsconfig.src.json` 으로 `node:` import 가 없는지도 확인된다)

- [ ] **Step 6: 커밋**

```bash
git add packages/core/src/dms-mapping.ts packages/core/src/index.ts packages/core/test/dms-mapping.test.ts packages/core/test/fixtures/dms
git commit -m "feat: DMS table-mapping JSON 파서 추가" -m "selection include/exclude(% 와일드카드), schema·table·column rename, remove-column 을 해석하고 그 밖의 룰은 경고로 남긴다. 익명화한 3개 테이블 픽스처를 추가한다."
```

---

### Task 2: core — `buildMigrationFlow` + `toRenameMappings`

**Files:**
- Create: `packages/core/src/migration-flow.ts`
- Modify: `packages/core/src/index.ts` (끝에 export 추가)
- Test: `packages/core/test/migration-flow.test.ts`

**Interfaces:**
- Consumes: `DmsMapping`, `isSelected`, `parseDmsMapping` (Task 1), 기존 `RenameMapping`·`diffSchemas`(`src/diff.ts`), `parseSqlDump`, `SchemaModel`·`Table`·`Column`(`src/model.ts`)
- Produces:
  - `type TableFlowStatus = 'ok' | 'missing-target' | 'missing-source' | 'excluded' | 'unmapped-target'`
  - `type ColumnFlowStatus = 'renamed' | 'same' | 'removed' | 'added' | 'dropped' | 'missing'`
  - `interface ColumnFlow { asIs?: string; toBe?: string; asIsType?: string; toBeType?: string; status: ColumnFlowStatus }`
  - `interface TableFlow { asIs?: string; toBe?: string; status: TableFlowStatus; renamed: boolean; columns: ColumnFlow[] }` (`renamed` = 테이블 rename 룰이 적용됨)
  - `interface MigrationFlowTotals { tables: Record<TableFlowStatus, number>; columns: Record<ColumnFlowStatus, number>; inScope: number; verified: number }`
  - `interface MigrationFlow { fromSchema: string; toSchema?: string; tables: TableFlow[]; totals: MigrationFlowTotals }`
  - `buildMigrationFlow(base: SchemaModel, target: SchemaModel, mapping: DmsMapping): MigrationFlow` — 행 순서: As-Is 모델 순서 → missing-source → unmapped-target. 컬럼 행 순서: As-Is 컬럼 순서 → 모델에 없는 룰(missing) → To-Be 에만 있는 컬럼(added)
  - `toRenameMappings(mapping: DmsMapping, base: SchemaModel, target: SchemaModel): RenameMapping[]` — `ok` 행에서만 만든다. 테이블 rename 다음에 그 테이블의 컬럼 rename(`table` 은 To-Be 테이블명). 이름은 모델의 실제 표기
  - `findByName<T extends { name: string }>(items: readonly T[], name: string): T | undefined` — 정확히 같은 이름 우선, 없으면 대소문자 무시

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/core/test/migration-flow.test.ts` (마지막 describe 는 `samples/dms/*.json` 이 있을 때만 돈다. 샘플은 추적하지 않는다):
```ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { diffSchemas } from '../src/diff';
import { parseDmsMapping } from '../src/dms-mapping';
import { buildMigrationFlow, toRenameMappings } from '../src/migration-flow';
import { parseSqlDump } from '../src/parse-dump';
import { fixture } from './helpers';

const asIs = parseSqlDump(fixture('dms/as-is.sql')).model;
const toBe = parseSqlDump(fixture('dms/to-be.sql')).model;
const { mapping } = parseDmsMapping(fixture('dms/mapping.json'));
const flow = buildMigrationFlow(asIs, toBe, mapping);
const row = (name: string) => flow.tables.find((t) => (t.asIs ?? t.toBe) === name)!;
const cols = (name: string) => row(name).columns.map((c) => [c.asIs, c.toBe, c.status]);

describe('픽스처', () => {
  it('SQL 픽스처는 경고 없이 파싱된다', () => {
    expect(parseSqlDump(fixture('dms/as-is.sql')).warnings).toEqual([]);
    expect(parseSqlDump(fixture('dms/to-be.sql')).warnings).toEqual([]);
  });
});

describe('buildMigrationFlow', () => {
  it('테이블 상태: 대응·selection 밖·어느 As-Is 와도 이어지지 않은 To-Be', () => {
    expect(flow.tables.map((t) => [t.asIs, t.toBe, t.status, t.renamed])).toEqual([
      ['tb_cust', 'customer', 'ok', true],
      ['tb_prm', 'promotion', 'ok', true],
      ['tb_prm_cnd', 'promotion_condition', 'ok', true],
      ['tb_tmp_bak', undefined, 'excluded', false],
      [undefined, 'audit_log', 'unmapped-target', false],
    ]);
    expect(flow.fromSchema).toBe('legacy');
    expect(flow.toSchema).toBe('newapp');
  });

  it('컬럼 상태: 대문자 룰도 모델의 실제 이름으로 맞춘다', () => {
    expect(cols('tb_cust')).toEqual([
      ['cust_id', 'customer_id', 'renamed'],
      ['cust_nm', 'customer_name', 'renamed'],
      ['old_addr', undefined, 'removed'],
      ['tmp_flag', undefined, 'dropped'],
      ['CUST_GRD', 'customer_grade', 'missing'],
      [undefined, 'email', 'added'],
    ]);
    expect(cols('tb_prm_cnd')).toEqual([
      ['cnd_seq', 'condition_seq', 'renamed'],
      ['prm_id', 'promotion_id', 'renamed'],
      ['cnd_val', 'condition_value', 'renamed'],
      ['use_yn', 'use_yn', 'same'],
    ]);
    expect(row('tb_prm_cnd').columns[2]).toMatchObject({ asIsType: 'varchar(500)', toBeType: 'varchar(1000)' });
  });

  it('합계와 검증 통과 수 (ok 이면서 missing 컬럼이 없는 테이블)', () => {
    expect(flow.totals).toEqual({
      tables: { ok: 3, 'missing-target': 0, 'missing-source': 0, excluded: 1, 'unmapped-target': 1 },
      columns: { renamed: 8, same: 1, removed: 2, added: 1, dropped: 1, missing: 1 },
      inScope: 3,
      verified: 2,
    });
  });

  it('To-Be 에 없는 테이블은 missing-target, 모델에 없는 As-Is 테이블은 missing-source', () => {
    const extra = parseDmsMapping(JSON.stringify({ rules: [
      { 'rule-type': 'transformation', 'rule-id': '1', 'rule-target': 'table', 'object-locator': { 'schema-name': 'legacy', 'table-name': 'tb_prm' }, 'rule-action': 'rename', value: 'promo_v2' },
      { 'rule-type': 'transformation', 'rule-id': '2', 'rule-target': 'table', 'object-locator': { 'schema-name': 'legacy', 'table-name': 'tb_gone' }, 'rule-action': 'rename', value: 'audit_log' },
    ] })).mapping;
    const f = buildMigrationFlow(asIs, toBe, extra);
    expect(f.tables.find((t) => t.asIs === 'tb_prm')).toMatchObject({ toBe: 'promo_v2', status: 'missing-target', columns: [] });
    expect(f.tables.find((t) => t.asIs === 'tb_gone')).toMatchObject({ toBe: 'audit_log', status: 'missing-source' });
    expect(f.tables.some((t) => t.status === 'unmapped-target' && t.toBe === 'audit_log')).toBe(false);
  });

  it('테이블명은 정확히 같은 이름을 먼저 고른다', () => {
    const two = parseSqlDump('CREATE TABLE `T1` (\n  `a` int\n);\nCREATE TABLE `t1` (\n  `a` int\n);').model;
    const target = parseSqlDump('CREATE TABLE `x` (\n  `a` int\n);\nCREATE TABLE `T1` (\n  `a` int\n);').model;
    const m = parseDmsMapping(JSON.stringify({ rules: [
      { 'rule-type': 'transformation', 'rule-id': '1', 'rule-target': 'table', 'object-locator': { 'schema-name': 's', 'table-name': 't1' }, 'rule-action': 'rename', value: 'x' },
    ] })).mapping;
    expect(buildMigrationFlow(two, target, m).tables.slice(0, 2).map((t) => [t.asIs, t.toBe])).toEqual([['T1', 'T1'], ['t1', 'x']]);
  });
});

describe('toRenameMappings', () => {
  const renames = toRenameMappings(mapping, asIs, toBe);

  it('테이블 rename 과, To-Be 테이블명을 쓴 컬럼 rename (양쪽 모델에 있는 것만)', () => {
    expect(renames).toEqual([
      { kind: 'table', from: 'tb_cust', to: 'customer' },
      { kind: 'column', table: 'customer', from: 'cust_id', to: 'customer_id' },
      { kind: 'column', table: 'customer', from: 'cust_nm', to: 'customer_name' },
      { kind: 'table', from: 'tb_prm', to: 'promotion' },
      { kind: 'column', table: 'promotion', from: 'prm_id', to: 'promotion_id' },
      { kind: 'column', table: 'promotion', from: 'prm_nm', to: 'promotion_name' },
      { kind: 'column', table: 'promotion', from: 'reg_dt', to: 'created_at' },
      { kind: 'table', from: 'tb_prm_cnd', to: 'promotion_condition' },
      { kind: 'column', table: 'promotion_condition', from: 'cnd_seq', to: 'condition_seq' },
      { kind: 'column', table: 'promotion_condition', from: 'prm_id', to: 'promotion_id' },
      { kind: 'column', table: 'promotion_condition', from: 'cnd_val', to: 'condition_value' },
    ]);
  });

  it('적용하면 diffSchemas 가 drop+add 대신 rename 을 낸다', () => {
    const ops = (d: ReturnType<typeof diffSchemas>) => d.tables.map((t) => `${t.op}:${t.oldName ?? ''}>${t.name}`).sort();
    expect(ops(diffSchemas(asIs, toBe))).toEqual([
      'add:>audit_log', 'add:>customer', 'add:>promotion', 'add:>promotion_condition',
      'drop:>tb_cust', 'drop:>tb_prm', 'drop:>tb_prm_cnd', 'drop:>tb_tmp_bak',
    ]);
    const d = diffSchemas(asIs, toBe, renames);
    expect(ops(d)).toEqual([
      'add:>audit_log', 'drop:>tb_tmp_bak',
      'rename:tb_cust>customer', 'rename:tb_prm>promotion', 'rename:tb_prm_cnd>promotion_condition',
    ]);
    expect(d.ignoredRenames).toEqual([]);
    const promotion = d.tables.find((t) => t.name === 'promotion')!;
    expect(promotion.columns.map((c) => [c.op, c.oldName, c.name])).toEqual([
      ['rename', 'prm_id', 'promotion_id'], ['rename', 'prm_nm', 'promotion_name'], ['drop', undefined, 'max_dc_cnt'], ['rename', 'reg_dt', 'created_at'],
    ]);
  });
});

// 실제 DMS 샘플은 저장소에 넣지 않는다. 로컬에 있을 때만 확인한다
const SAMPLE_DIR = fileURLToPath(new URL('../../../samples/dms/', import.meta.url));
const samples = existsSync(SAMPLE_DIR) ? readdirSync(SAMPLE_DIR).filter((f) => f.endsWith('.json')) : [];

describe.skipIf(samples.length === 0)('로컬 DMS 샘플', () => {
  it.each(samples)('%s: 룰을 모두 읽고 경고 0', (file) => {
    const text = readFileSync(`${SAMPLE_DIR}${file}`, 'utf8');
    const { mapping: m, warnings } = parseDmsMapping(text);
    expect(m.ruleCount).toBe((JSON.parse(text) as { rules: unknown[] }).rules.length);
    expect(m.selection.include.length + m.tables.length + m.columns.length + m.removedColumns.length + (m.toSchema ? 1 : 0)).toBe(m.ruleCount);
    expect(warnings).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @tdm/core -- test/migration-flow.test.ts`
Expected: FAIL — `Failed to resolve import "../src/migration-flow"`

- [ ] **Step 3: 구현**

`packages/core/src/migration-flow.ts`:
```ts
// DMS 전환 매핑 + As-Is/To-Be 모델 → 전환 표(테이블·컬럼 대응과 상태)와 diff 용 rename 매핑
import type { RenameMapping } from './diff';
import { isSelected, type DmsMapping } from './dms-mapping';
import type { Column, SchemaModel, Table } from './model';

export type TableFlowStatus = 'ok' | 'missing-target' | 'missing-source' | 'excluded' | 'unmapped-target';
export type ColumnFlowStatus = 'renamed' | 'same' | 'removed' | 'added' | 'dropped' | 'missing';

export interface ColumnFlow {
  asIs?: string;
  toBe?: string;
  asIsType?: string;
  toBeType?: string;
  status: ColumnFlowStatus;
}

export interface TableFlow {
  asIs?: string;
  toBe?: string;
  status: TableFlowStatus;
  renamed: boolean; // 테이블 rename 룰이 적용됨
  columns: ColumnFlow[];
}

export interface MigrationFlowTotals {
  tables: Record<TableFlowStatus, number>;
  columns: Record<ColumnFlowStatus, number>;
  inScope: number; // 전환 대상 테이블 (ok + missing-target + missing-source)
  verified: number; // ok 이면서 컬럼 missing 이 없는 테이블
}

export interface MigrationFlow {
  fromSchema: string;
  toSchema?: string;
  tables: TableFlow[];
  totals: MigrationFlowTotals;
}

const TABLE_STATUSES: TableFlowStatus[] = ['ok', 'missing-target', 'missing-source', 'excluded', 'unmapped-target'];
const COLUMN_STATUSES: ColumnFlowStatus[] = ['renamed', 'same', 'removed', 'added', 'dropped', 'missing'];
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// 정확히 같은 이름을 먼저, 없으면 대소문자를 무시하고 찾는다
export function findByName<T extends { name: string }>(items: readonly T[], name: string): T | undefined {
  return items.find((x) => x.name === name) ?? items.find((x) => eq(x.name, name));
}

export function buildMigrationFlow(base: SchemaModel, target: SchemaModel, mapping: DmsMapping): MigrationFlow {
  const consumed = new Set<Table>();
  const rows: TableFlow[] = base.tables.map((asIs) => tableRow(asIs, base, target, mapping, consumed));
  rows.push(...missingSourceRows(base, target, mapping, consumed));
  for (const t of target.tables) {
    if (!consumed.has(t)) rows.push({ toBe: t.name, status: 'unmapped-target', renamed: false, columns: [] });
  }
  return { fromSchema: mapping.fromSchema, ...(mapping.toSchema ? { toSchema: mapping.toSchema } : {}), tables: rows, totals: totalsOf(rows) };
}

// diff 에 넘길 rename 매핑. 이름은 모델의 실제 표기로 맞추고, 컬럼 매핑의 table 은 To-Be 테이블명이다
export function toRenameMappings(mapping: DmsMapping, base: SchemaModel, target: SchemaModel): RenameMapping[] {
  const out: RenameMapping[] = [];
  for (const row of buildMigrationFlow(base, target, mapping).tables) {
    if (row.status !== 'ok') continue;
    if (row.renamed && row.asIs !== row.toBe) out.push({ kind: 'table', from: row.asIs!, to: row.toBe! });
    for (const c of row.columns) {
      if (c.status === 'renamed') out.push({ kind: 'column', table: row.toBe!, from: c.asIs!, to: c.toBe! });
    }
  }
  return out;
}

// 룰의 As-Is 이름이 이 객체를 가리키는지 (정확히 같은 이름 우선)
const pointsTo = <T extends { name: string }>(items: readonly T[], ruleName: string, item: T) => findByName(items, ruleName) === item;

function tableRow(asIs: Table, base: SchemaModel, target: SchemaModel, mapping: DmsMapping, consumed: Set<Table>): TableFlow {
  if (!isSelected(mapping, asIs.name)) return { asIs: asIs.name, status: 'excluded', renamed: false, columns: [] };
  const rule = mapping.tables.find((r) => pointsTo(base.tables, r.from, asIs));
  const toBe = findByName(target.tables, rule?.to ?? asIs.name);
  if (!toBe) return { asIs: asIs.name, toBe: rule?.to, status: 'missing-target', renamed: false, columns: [] };
  consumed.add(toBe);
  return { asIs: asIs.name, toBe: toBe.name, status: 'ok', renamed: rule !== undefined, columns: columnRows(asIs, toBe, base, mapping) };
}

// 룰이 가리키는 As-Is 테이블이 모델에 없으면 missing-source 로 드러낸다 (와일드카드 selection 은 제외)
function missingSourceRows(base: SchemaModel, target: SchemaModel, mapping: DmsMapping, consumed: Set<Table>): TableFlow[] {
  const names = [
    ...mapping.selection.include.filter((p) => !p.includes('%')),
    ...mapping.tables.map((r) => r.from),
    ...mapping.columns.map((r) => r.table),
    ...mapping.removedColumns.map((r) => r.table),
  ];
  const seen = new Set<string>();
  const rows: TableFlow[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key) || findByName(base.tables, name)) continue;
    seen.add(key);
    const toBeName = mapping.tables.find((r) => eq(r.from, name))?.to ?? name;
    const toBe = findByName(target.tables, toBeName);
    if (toBe) consumed.add(toBe);
    rows.push({ asIs: name, toBe: toBe?.name ?? toBeName, status: 'missing-source', renamed: false, columns: [] });
  }
  return rows;
}

function columnRows(asIs: Table, toBe: Table, base: SchemaModel, mapping: DmsMapping): ColumnFlow[] {
  const renames = mapping.columns.filter((r) => pointsTo(base.tables, r.table, asIs));
  const removed = mapping.removedColumns.filter((r) => pointsTo(base.tables, r.table, asIs));
  const used = new Set<Column>();
  const rows: ColumnFlow[] = asIs.columns.map((c) => {
    if (removed.some((r) => pointsTo(asIs.columns, r.column, c))) return { asIs: c.name, asIsType: c.type, status: 'removed' };
    const rule = renames.find((r) => pointsTo(asIs.columns, r.from, c));
    const match = findByName(toBe.columns, rule?.to ?? c.name);
    if (!match) return rule ? { asIs: c.name, toBe: rule.to, asIsType: c.type, status: 'missing' } : { asIs: c.name, asIsType: c.type, status: 'dropped' };
    used.add(match);
    const status = rule && match.name !== c.name ? 'renamed' : 'same';
    return { asIs: c.name, toBe: match.name, asIsType: c.type, toBeType: match.type, status };
  });
  for (const r of renames) if (!findByName(asIs.columns, r.from)) rows.push({ asIs: r.from, toBe: r.to, status: 'missing' });
  for (const r of removed) if (!findByName(asIs.columns, r.column)) rows.push({ asIs: r.column, status: 'missing' });
  for (const c of toBe.columns) if (!used.has(c)) rows.push({ toBe: c.name, toBeType: c.type, status: 'added' });
  return rows;
}

function totalsOf(rows: TableFlow[]): MigrationFlowTotals {
  const tables = Object.fromEntries(TABLE_STATUSES.map((s) => [s, 0])) as Record<TableFlowStatus, number>;
  const columns = Object.fromEntries(COLUMN_STATUSES.map((s) => [s, 0])) as Record<ColumnFlowStatus, number>;
  let verified = 0;
  for (const row of rows) {
    tables[row.status] += 1;
    for (const c of row.columns) columns[c.status] += 1;
    if (row.status === 'ok' && !row.columns.some((c) => c.status === 'missing')) verified += 1;
  }
  return { tables, columns, inScope: tables.ok + tables['missing-target'] + tables['missing-source'], verified };
}
```

`packages/core/src/index.ts` 맨 끝에 한 줄 추가:
```ts
export * from './migration-flow';
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @tdm/core && npm run typecheck -w @tdm/core`
Expected: PASS. 로컬에 `samples/dms` 가 있으면 "로컬 DMS 샘플" 테스트도 통과(룰 1,967개 모두 해석, 경고 0), 없으면 skipped

- [ ] **Step 5: 커밋**

```bash
git add packages/core/src/migration-flow.ts packages/core/src/index.ts packages/core/test/migration-flow.test.ts
git commit -m "feat: DMS 매핑으로 전환 표와 rename 매핑을 만드는 core 함수 추가" -m "As-Is·To-Be 모델에 매핑을 대어 테이블·컬럼 상태를 계산하고, 양쪽에 있는 대상만 diff 용 rename 으로 바꾼다. 적용 후 drop+add 대신 rename 이 나오는지 검증한다."
```

---

### Task 3: server — `migration_mappings` 저장소와 `/migrations` 라우트

**Files:**
- Create: `apps/server/src/db/migrations/002_migration_mappings.sql`
- Create: `apps/server/src/repos/migrations.ts`, `apps/server/src/services/migration-service.ts`, `apps/server/src/routes/migrations.ts`, `apps/server/src/http.ts`
- Modify: `apps/server/src/schemas.ts` (`SafeFilename`·`NoteSchema` 추가), `apps/server/src/routes/uploads.ts:8,20-25` (공용 스키마 사용), `apps/server/src/routes/versions.ts:7-9,20` (`attachment()` 사용), `apps/server/src/limits.ts` (끝에 상수), `apps/server/src/app.ts` (import·`ROUTES`)
- Modify (테스트): `apps/server/test/helpers.ts` (끝에 `dmsFixture`), `apps/server/test/db.test.ts:12-15,23` (테이블 목록·user_version 2), `apps/server/test/authz.test.ts` (`CASES` 에 7줄)
- Test: `apps/server/test/migrations.test.ts`

**Interfaces:**
- Consumes: `parseDmsMapping`, `DmsParseError`, `DmsMapping`, `DmsWarning` (Task 1). 기존 `getSchema`(repos/catalog), `one/all/run/tx`(db/connection), `AppError`, `requireAdmin/requireLogin`, `IdParams`, `ingest`, `getVersionMeta`, `loggedInApp`
- Produces:
  - `interface MigrationMeta { id; fromSchemaId; toSchemaId; revision; filename; ruleCount; note: string | null; uploadedBy: string; uploadedAt: string }` (숫자 필드는 `number`)
  - `addMigration(db, input: MigrationInput): MigrationMeta`, `getMigration(db, id)`, `listMigrations(db, fromSchemaId, toSchemaId): MigrationMeta[]` (리비전 내림차순), `latestMigration(db, fromSchemaId, toSchemaId): (MigrationMeta & { source: string }) | undefined`, `getMigrationSource(db, id): { filename; text }`, `deleteMigration(db, id): void` (없으면 404)
  - `parseOrReject(source): { mapping; warnings }` (`DmsParseError` → `AppError(400)`), `schemaNameWarnings(mapping, fromName, toName): DmsWarning[]` (`ruleId: ''`, `code: 'invalid'`), `uploadMigration(db, input: MigrationUpload): { migration: MigrationMeta; warnings: DmsWarning[] }`
  - HTTP: `POST /api/migrations` → 201 `{ migration, warnings }` · `GET /api/migrations?from=&to=` → `MigrationMeta[]` · `GET /api/migrations/:id/source` → 원문(`application/json`, attachment) · `DELETE /api/migrations/:id` → `{ ok: true }`. 추가·삭제 시 `ctx.cache.clear()`
  - `attachment(filename: string): string` (`src/http.ts`), `SafeFilename`, `NoteSchema` (`src/schemas.ts`), `MIGRATION_BODY_LIMIT` (`src/limits.ts`)
  - 테스트 도우미 `dmsFixture(name: 'mapping.json' | 'as-is.sql' | 'to-be.sql'): string`

- [ ] **Step 1: 테스트 도우미와 실패하는 테스트 작성**

`apps/server/test/helpers.ts` 맨 끝에 추가 (`readFileSync`·`fileURLToPath` 는 이미 import 되어 있다):
```ts

// DMS 전환 매핑 픽스처 (core 테스트와 공유): mapping.json, as-is.sql, to-be.sql
export function dmsFixture(name: 'mapping.json' | 'as-is.sql' | 'to-be.sql'): string {
  return readFileSync(fileURLToPath(new URL(`../../../packages/core/test/fixtures/dms/${name}`, import.meta.url)), 'utf8');
}
```

`apps/server/test/migrations.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { one } from '../src/db/connection';
import { getVersionMeta } from '../src/repos/versions';
import { ingest } from '../src/services/ingest';
import { dmsFixture, loggedInApp } from './helpers';

type App = Awaited<ReturnType<typeof loggedInApp>>;

// As-Is(legacy)·To-Be(newapp) 버전을 하나씩 올리고 버전·Schema id 를 돌려준다
async function setup() {
  const ctx = await loggedInApp();
  const put = (schemaName: string, file: 'as-is.sql' | 'to-be.sql') => {
    const r = ingest(ctx.db, { databaseName: 'db', schemaName, filename: file, text: dmsFixture(file), userId: 1 });
    return { versionId: r.versionId, schemaId: getVersionMeta(ctx.db, r.versionId).schemaId };
  };
  return { ...ctx, asIs: put('legacy', 'as-is.sql'), toBe: put('newapp', 'to-be.sql') };
}

const post = (ctx: App, headers: Record<string, string>, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/api/migrations', headers, payload });
const body = (s: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown> = {}) =>
  ({ fromSchemaId: s.asIs.schemaId, toSchemaId: s.toBe.schemaId, filename: 'mapping.json', source: dmsFixture('mapping.json'), ...extra });

describe('POST /api/migrations', () => {
  it('admin 만 올리고, 같은 쌍에 다시 올리면 리비전이 늘며, 경고를 돌려준다', async () => {
    const s = await setup();
    expect((await post(s, s.viewer, body(s))).statusCode).toBe(403);
    const first = await post(s, s.admin, body(s, { note: '1차' }));
    expect(first.statusCode).toBe(201);
    expect(first.json().migration).toMatchObject({ revision: 1, ruleCount: 19, filename: 'mapping.json', note: '1차', uploadedBy: 'admin' });
    expect(first.json().warnings).toEqual([{ ruleId: '50', code: 'unsupported', message: 'column / convert-lowercase 룰은 반영하지 않습니다' }]);
    expect((await post(s, s.admin, body(s))).json().migration.revision).toBe(2);

    const list = await s.app.inject({ method: 'GET', url: `/api/migrations?from=${s.asIs.schemaId}&to=${s.toBe.schemaId}`, headers: s.viewer });
    expect(list.json().map((m: { revision: number }) => m.revision)).toEqual([2, 1]);
    expect(list.json()[0]).not.toHaveProperty('source');
  });

  it('파싱 불가·rules 없음은 400, 같은 Schema 는 400, 없는 Schema 는 404', async () => {
    const s = await setup();
    const bad = await post(s, s.admin, body(s, { source: '{ not json' }));
    expect([bad.statusCode, bad.json().error]).toEqual([400, 'JSON 형식이 아닙니다']);
    expect((await post(s, s.admin, body(s, { source: '{"x":1}' }))).json().error).toBe('rules 배열이 없습니다');
    expect((await post(s, s.admin, body(s, { toSchemaId: s.asIs.schemaId }))).statusCode).toBe(400);
    expect((await post(s, s.admin, body(s, { toSchemaId: 9999 }))).statusCode).toBe(404);
    expect((await post(s, s.admin, body(s, { filename: '../x.json' }))).statusCode).toBe(400);
  });

  it('파일의 schema 이름이 Schema 이름과 달라도 올리고 경고한다', async () => {
    const s = await setup();
    const res = await post(s, s.admin, body(s, { source: dmsFixture('mapping.json').replaceAll('"legacy"', '"astore"') }));
    expect(res.statusCode).toBe(201);
    expect(res.json().warnings[0]).toEqual({ ruleId: '', code: 'invalid', message: "파일의 As-Is schema-name 'astore' 이 BASE Schema 'legacy' 과 다릅니다" });
  });
});

describe('원문·삭제·연쇄 삭제', () => {
  it('원문을 그대로 내려받고, 삭제하면 그 리비전만 빠진다', async () => {
    const s = await setup();
    const r1 = (await post(s, s.admin, body(s))).json().migration.id;
    const r2 = (await post(s, s.admin, body(s, { filename: 'v2.json' }))).json().migration.id;
    const src = await s.app.inject({ method: 'GET', url: `/api/migrations/${r2}/source`, headers: s.viewer });
    expect(src.body).toBe(dmsFixture('mapping.json'));
    expect(src.headers['content-disposition']).toContain('filename="v2.json"');
    expect((await s.app.inject({ method: 'DELETE', url: `/api/migrations/${r2}`, headers: s.viewer })).statusCode).toBe(403);
    expect((await s.app.inject({ method: 'DELETE', url: `/api/migrations/${r2}`, headers: s.admin })).statusCode).toBe(200);
    expect((await s.app.inject({ method: 'DELETE', url: `/api/migrations/${r2}`, headers: s.admin })).statusCode).toBe(404);
    const list = await s.app.inject({ method: 'GET', url: `/api/migrations?from=${s.asIs.schemaId}&to=${s.toBe.schemaId}`, headers: s.viewer });
    expect(list.json().map((m: { id: number; revision: number }) => [m.id, m.revision])).toEqual([[r1, 1]]);
  });

  it('Schema 를 지우면 매핑도 연쇄 삭제된다', async () => {
    const s = await setup();
    await post(s, s.admin, body(s));
    const count = () => one<{ n: number }>(s.db, 'SELECT COUNT(*) AS n FROM migration_mappings')!.n;
    expect(count()).toBe(1);
    const del = await s.app.inject({ method: 'DELETE', url: `/api/schemas/${s.toBe.schemaId}`, headers: s.admin, payload: { confirmName: 'newapp' } });
    expect(del.statusCode).toBe(200);
    expect(count()).toBe(0);
  });
});
```

`apps/server/test/authz.test.ts` — `CASES` 의 `GET /api/objects/abc/history` 줄 바로 아래(로그아웃 케이스보다 위)에 추가:
```ts

  { method: 'POST', url: '/api/migrations', payload: {}, anon: 401, viewer: 403, admin: 400 },
  { method: 'GET', url: '/api/migrations?from=1&to=1', anon: 401, viewer: 200, admin: 200 },
  { method: 'GET', url: '/api/migrations?from=abc&to=1', anon: 401, viewer: 400, admin: 400 },
  { method: 'GET', url: '/api/migrations/99999/source', anon: 401, viewer: 404, admin: 404 },
  { method: 'GET', url: '/api/migrations/abc/source', anon: 401, viewer: 400, admin: 400 },
  { method: 'DELETE', url: '/api/migrations/abc', anon: 401, viewer: 403, admin: 400 },
  { method: 'DELETE', url: '/api/migrations/99999', anon: 401, viewer: 403, admin: 404 },
```

`apps/server/test/db.test.ts` — 첫 테스트의 테이블 목록과 두 테스트의 user_version 기대값을 바꾼다:
```ts
    expect(tables).toEqual([
      'databases', 'migration_mappings', 'object_revisions', 'objects', 'rename_mappings', 'schema_versions', 'schemas', 'sessions', 'users', 'version_objects',
    ]);
    expect(one<{ user_version: number }>(db, 'PRAGMA user_version')?.user_version).toBe(2);
```
그리고 "다시 열어도 마이그레이션을 반복하지 않는다" 테스트의 `.toBe(1)` 도 `.toBe(2)` 로 바꾼다.

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @tdm/server -- test/migrations.test.ts test/authz.test.ts test/db.test.ts`
Expected: FAIL — migrations 404(라우트 없음), db 테이블 목록 불일치

- [ ] **Step 3: 마이그레이션·저장소 작성**

`apps/server/src/db/migrations/002_migration_mappings.sql` (`migrate()` 가 `user_version` 1 인 기존 DB 에도 자동 적용한다):
```sql
-- DMS 전환 매핑: As-Is Schema → To-Be Schema 쌍에 리비전으로 쌓는다
CREATE TABLE migration_mappings (
  id INTEGER PRIMARY KEY,
  from_schema_id INTEGER NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  to_schema_id INTEGER NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  filename TEXT NOT NULL,
  source TEXT NOT NULL,
  rule_count INTEGER NOT NULL,
  note TEXT,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL,
  UNIQUE (from_schema_id, to_schema_id, revision),
  CHECK (from_schema_id <> to_schema_id)
);
CREATE INDEX ix_migration_mappings_to ON migration_mappings (to_schema_id);
```

`apps/server/src/repos/migrations.ts`:
```ts
import { all, one, run, tx, type Db } from '../db/connection';
import { AppError } from '../errors';

export interface MigrationMeta {
  id: number;
  fromSchemaId: number;
  toSchemaId: number;
  revision: number;
  filename: string;
  ruleCount: number;
  note: string | null;
  uploadedBy: string;
  uploadedAt: string;
}

export interface MigrationInput {
  fromSchemaId: number;
  toSchemaId: number;
  filename: string;
  source: string;
  ruleCount: number;
  note?: string;
  userId: number;
}

interface MetaRecord {
  id: number; from_schema_id: number; to_schema_id: number; revision: number; filename: string;
  rule_count: number; note: string | null; uploaded_by: string; uploaded_at: string;
}

const META_COLUMNS = `m.id, m.from_schema_id, m.to_schema_id, m.revision, m.filename, m.rule_count, m.note,
  u.username AS uploaded_by, m.uploaded_at`;
const FROM = 'FROM migration_mappings m JOIN users u ON u.id = m.uploaded_by';
const META_SQL = `SELECT ${META_COLUMNS} ${FROM}`;

const toMeta = (r: MetaRecord): MigrationMeta => ({
  id: Number(r.id), fromSchemaId: Number(r.from_schema_id), toSchemaId: Number(r.to_schema_id), revision: Number(r.revision),
  filename: r.filename, ruleCount: Number(r.rule_count), note: r.note, uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at,
});

const NOT_FOUND = () => new AppError(404, '전환 매핑을 찾을 수 없습니다');

export function getMigration(db: Db, id: number): MigrationMeta {
  const r = one<MetaRecord>(db, `${META_SQL} WHERE m.id = ?`, id);
  if (!r) throw NOT_FOUND();
  return toMeta(r);
}

// 같은 쌍의 다음 리비전 번호로 저장한다
export function addMigration(db: Db, input: MigrationInput): MigrationMeta {
  const id = tx(db, () => {
    const last = one<{ revision: number | null }>(db,
      'SELECT MAX(revision) AS revision FROM migration_mappings WHERE from_schema_id = ? AND to_schema_id = ?', input.fromSchemaId, input.toSchemaId);
    return run(db, `INSERT INTO migration_mappings (from_schema_id, to_schema_id, revision, filename, source, rule_count, note, uploaded_by, uploaded_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.fromSchemaId, input.toSchemaId, Number(last?.revision ?? 0) + 1, input.filename, input.source, input.ruleCount,
      input.note ?? null, input.userId, new Date().toISOString()).lastInsertRowid;
  });
  return getMigration(db, id);
}

// 최신 리비전이 먼저 온다
export function listMigrations(db: Db, fromSchemaId: number, toSchemaId: number): MigrationMeta[] {
  return all<MetaRecord>(db, `${META_SQL} WHERE m.from_schema_id = ? AND m.to_schema_id = ? ORDER BY m.revision DESC`, fromSchemaId, toSchemaId).map(toMeta);
}

export function latestMigration(db: Db, fromSchemaId: number, toSchemaId: number): (MigrationMeta & { source: string }) | undefined {
  const r = one<MetaRecord & { source: string }>(db,
    `SELECT ${META_COLUMNS}, m.source ${FROM} WHERE m.from_schema_id = ? AND m.to_schema_id = ? ORDER BY m.revision DESC LIMIT 1`,
    fromSchemaId, toSchemaId);
  return r ? { ...toMeta(r), source: r.source } : undefined;
}

export function getMigrationSource(db: Db, id: number): { filename: string; text: string } {
  const r = one<{ filename: string; source: string }>(db, 'SELECT filename, source FROM migration_mappings WHERE id = ?', id);
  if (!r) throw NOT_FOUND();
  return { filename: r.filename, text: r.source };
}

export function deleteMigration(db: Db, id: number): void {
  if (run(db, 'DELETE FROM migration_mappings WHERE id = ?', id).changes === 0) throw NOT_FOUND();
}
```

- [ ] **Step 4: 공용 스키마·헤더 헬퍼 추출**

`apps/server/src/schemas.ts` — `PasswordSchema` 줄 아래에 추가:
```ts
export const SafeFilename = z
  .string()
  .min(1)
  .max(255)
  .refine((v) => !/[/\\]/.test(v), '파일명에 경로 구분자를 쓸 수 없습니다');
export const NoteSchema = z.string().trim().max(500);
```

`apps/server/src/routes/uploads.ts` — import 를 바꾸고 파일 안의 `SafeFilename` 정의(5줄)를 지운다:
```ts
import { NameSchema, NoteSchema, SafeFilename } from '../schemas';
```
```ts
const FileMetaSchema = z.object({ filename: SafeFilename, databaseName: NameSchema, schemaName: NameSchema, note: NoteSchema.optional() });
```

`apps/server/src/http.ts`:
```ts
// 다운로드 응답 헤더. RFC 5987 filename*: encodeURIComponent가 남기는 '()*도 인코딩한다
const encodeRfc5987 = (v: string) => encodeURIComponent(v).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const asciiFallback = (v: string) => v.replace(/[^\x20-\x7e]|["\\%]/g, '_');

export const attachment = (filename: string): string =>
  `attachment; filename="${asciiFallback(filename)}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
```

`apps/server/src/routes/versions.ts` — `encodeRfc5987`·`asciiFallback` 정의와 그 위 주석을 지우고, import 와 헤더를 바꾼다:
```ts
import { attachment } from '../http';
```
```ts
      .header('content-disposition', attachment(filename))
```

`apps/server/src/limits.ts` 맨 끝에 추가:
```ts
// 전환 매핑은 JSON 본문에 원문을 문자열로 담는다. 따옴표 이스케이프로 늘어나는 만큼 여유를 둔다
export const MIGRATION_BODY_LIMIT = MAX_UPLOAD_BYTES * 2;
```

- [ ] **Step 5: 서비스·라우트 작성과 등록**

`apps/server/src/services/migration-service.ts`:
```ts
import { DmsParseError, parseDmsMapping, type DmsMapping, type DmsWarning } from '@tdm/core';
import type { Db } from '../db/connection';
import { AppError } from '../errors';
import { getSchema } from '../repos/catalog';
import { addMigration, type MigrationMeta } from '../repos/migrations';

export interface MigrationUpload {
  fromSchemaId: number;
  toSchemaId: number;
  filename: string;
  source: string;
  note?: string;
  userId: number;
}

// 파싱 불가는 400. 업로드 자체를 거부한다
export function parseOrReject(source: string): { mapping: DmsMapping; warnings: DmsWarning[] } {
  try {
    return parseDmsMapping(source);
  } catch (e) {
    if (e instanceof DmsParseError) throw new AppError(400, e.message);
    throw e;
  }
}

// 파일의 schema 이름이 Schema 이름과 다르면 경고만 한다 (Schema 이름을 바꿔 올리는 경우가 있다)
export function schemaNameWarnings(mapping: DmsMapping, fromName: string, toName: string): DmsWarning[] {
  const out: DmsWarning[] = [];
  const differs = (a: string, b: string) => a.toLowerCase() !== b.toLowerCase();
  if (!mapping.fromSchema.includes('%') && differs(mapping.fromSchema, fromName)) {
    out.push({ ruleId: '', code: 'invalid', message: `파일의 As-Is schema-name '${mapping.fromSchema}' 이 BASE Schema '${fromName}' 과 다릅니다` });
  }
  if (mapping.toSchema !== undefined && differs(mapping.toSchema, toName)) {
    out.push({ ruleId: '', code: 'invalid', message: `파일의 To-Be schema 이름 '${mapping.toSchema}' 이 TARGET Schema '${toName}' 과 다릅니다` });
  }
  return out;
}

export function uploadMigration(db: Db, input: MigrationUpload): { migration: MigrationMeta; warnings: DmsWarning[] } {
  if (input.fromSchemaId === input.toSchemaId) throw new AppError(400, 'As-Is 와 To-Be Schema 가 같습니다');
  const from = getSchema(db, input.fromSchemaId);
  const to = getSchema(db, input.toSchemaId);
  const { mapping, warnings } = parseOrReject(input.source);
  const migration = addMigration(db, { ...input, ruleCount: mapping.ruleCount });
  return { migration, warnings: [...schemaNameWarnings(mapping, from.name, to.name), ...warnings] };
}
```

`apps/server/src/routes/migrations.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app';
import { requireAdmin, requireLogin } from '../auth/plugin';
import { attachment } from '../http';
import { MAX_UPLOAD_BYTES, MIGRATION_BODY_LIMIT } from '../limits';
import { getSchema } from '../repos/catalog';
import { deleteMigration, getMigrationSource, listMigrations } from '../repos/migrations';
import { IdParams, NoteSchema, SafeFilename } from '../schemas';
import { uploadMigration } from '../services/migration-service';

const Id = z.coerce.number().int().positive();
const UploadBody = z.object({
  fromSchemaId: Id,
  toSchemaId: Id,
  filename: SafeFilename,
  source: z.string().min(1, '파일이 비어 있습니다').max(MAX_UPLOAD_BYTES, `파일이 너무 큽니다 (최대 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)`),
  note: NoteSchema.optional(),
});
const PairQuery = z.object({ from: Id, to: Id });

export function migrationRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/migrations', { preHandler: requireAdmin, bodyLimit: MIGRATION_BODY_LIMIT }, async (req, reply) => {
    const body = UploadBody.parse(req.body);
    const result = uploadMigration(ctx.db, { ...body, note: body.note || undefined, userId: req.user!.id });
    ctx.cache.clear(); // 쌍의 최신 매핑이 바뀌어 diff 결과가 달라진다
    return reply.status(201).send(result);
  });

  app.get('/migrations', { preHandler: requireLogin }, async (req) => {
    const { from, to } = PairQuery.parse(req.query);
    getSchema(ctx.db, from);
    getSchema(ctx.db, to);
    return listMigrations(ctx.db, from, to);
  });

  app.get('/migrations/:id/source', { preHandler: requireLogin }, async (req, reply) => {
    const { filename, text } = getMigrationSource(ctx.db, IdParams.parse(req.params).id);
    return reply.header('content-type', 'application/json; charset=utf-8').header('content-disposition', attachment(filename)).send(text);
  });

  app.delete('/migrations/:id', { preHandler: requireAdmin }, async (req) => {
    deleteMigration(ctx.db, IdParams.parse(req.params).id);
    ctx.cache.clear();
    return { ok: true };
  });
}
```

`apps/server/src/app.ts` — import 추가와 `ROUTES` 끝에 등록:
```ts
import { migrationRoutes } from './routes/migrations';
```
```ts
  ['/api/objects', objectRoutes],
  ['/api', migrationRoutes],
];
```

- [ ] **Step 6: 통과 확인**

Run: `npm test -w @tdm/server && npm run typecheck -w @tdm/server`
Expected: PASS (기존 업로드·버전 원문 다운로드 테스트도 그대로 통과해야 한다 — 추출한 헬퍼가 같은 헤더를 만든다)

- [ ] **Step 7: 커밋**

```bash
git add apps/server/src/db/migrations/002_migration_mappings.sql apps/server/src/repos/migrations.ts apps/server/src/services/migration-service.ts apps/server/src/routes/migrations.ts apps/server/src/http.ts apps/server/src/schemas.ts apps/server/src/routes/uploads.ts apps/server/src/routes/versions.ts apps/server/src/limits.ts apps/server/src/app.ts apps/server/test/helpers.ts apps/server/test/migrations.test.ts apps/server/test/authz.test.ts apps/server/test/db.test.ts
git commit -m "feat: DMS 전환 매핑 저장과 /migrations API 추가" -m "Schema 쌍마다 리비전으로 원문을 저장하고(admin), 목록·원문 다운로드·삭제를 제공한다. Schema 삭제 시 연쇄 삭제되고, 추가·삭제 시 diff 캐시를 비운다."
```

---

### Task 4: server — diff 에 DMS rename 반영 + `GET /migration-flow`

**Files:**
- Modify: `apps/server/src/services/diff-service.ts` (전체 교체)
- Modify: `apps/server/src/services/migration-service.ts` (전체 교체 — `computeMigrationFlow` 추가)
- Modify: `apps/server/src/routes/migrations.ts` (전체 교체 — `/migration-flow` 추가)
- Modify (테스트): `apps/server/test/diff.test.ts:60` (`source: 'manual'`), `apps/server/test/authz.test.ts` (`CASES` 에 2줄)
- Test: `apps/server/test/migration-diff.test.ts`

**Interfaces:**
- Consumes: `toRenameMappings`, `buildMigrationFlow`, `MigrationFlow` (Task 2), `parseDmsMapping` (Task 1), `latestMigration`, `MigrationMeta` (Task 3), 기존 `getVersionMeta`, `loadVersion`, `listRenames`
- Produces:
  - `type RenameSource = 'dms' | 'manual'`, `type SourcedRename = RenameMapping & { source: RenameSource }`
  - `DiffResponse.renames: SourcedRename[]` — DMS 먼저, 수동 나중. 같은 `(kind, table, from)` 이면 수동만 남는다
  - `mergeRenames(dms: RenameMapping[], manual: RenameMapping[]): SourcedRename[]`
  - 캐시 키 `${baseId}:${targetId}:${migrationId ?? 0}:${canonicalJson(manual)}`
  - `type MigrationFlowResponse = { mapping: null } | { mapping: MigrationMeta; flow: MigrationFlow; warnings: DmsWarning[] }` — `warnings` 는 schema 이름 경고 + 파싱 경고
  - `computeMigrationFlow(db, baseId, targetId): MigrationFlowResponse`
  - HTTP: `GET /api/migration-flow?base=&target=` (로그인)

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/server/test/migration-diff.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { getVersionMeta } from '../src/repos/versions';
import { ingest } from '../src/services/ingest';
import { dmsFixture, loggedInApp } from './helpers';

async function setup() {
  const ctx = await loggedInApp();
  const put = (schemaName: string, file: 'as-is.sql' | 'to-be.sql') => {
    const r = ingest(ctx.db, { databaseName: 'db', schemaName, filename: file, text: dmsFixture(file), userId: 1 });
    return { versionId: r.versionId, schemaId: getVersionMeta(ctx.db, r.versionId).schemaId };
  };
  const asIs = put('legacy', 'as-is.sql');
  const toBe = put('newapp', 'to-be.sql');
  const getDiff = async (base = asIs.versionId, target = toBe.versionId) =>
    (await ctx.app.inject({ method: 'GET', url: `/api/diff?base=${base}&target=${target}`, headers: ctx.viewer })).json();
  const upload = async () => (await ctx.app.inject({ method: 'POST', url: '/api/migrations', headers: ctx.admin, payload: {
    fromSchemaId: asIs.schemaId, toSchemaId: toBe.schemaId, filename: 'mapping.json', source: dmsFixture('mapping.json'),
  } })).json().migration.id as number;
  return { ...ctx, asIs, toBe, getDiff, upload };
}

const tableOps = (body: { diff: { tables: { op: string; name: string }[] } }) => body.diff.tables.map((t) => `${t.op}:${t.name}`).sort();

describe('diff 에 DMS 매핑 반영', () => {
  it('매핑을 올리면 drop+add 가 rename 이 되고, 지우면 되돌아간다 (캐시 무효화)', async () => {
    const s = await setup();
    const before = await s.getDiff();
    expect(tableOps(before)).toContain('drop:tb_prm');
    expect(before.renames).toEqual([]);

    const id = await s.upload();
    const after = await s.getDiff();
    expect(tableOps(after)).toEqual(['add:audit_log', 'drop:tb_tmp_bak', 'rename:customer', 'rename:promotion', 'rename:promotion_condition']);
    expect(after.renames).toHaveLength(11);
    expect(after.renames[0]).toEqual({ kind: 'table', from: 'tb_cust', to: 'customer', source: 'dms' });
    expect(after.ddl).toContain('RENAME TABLE `tb_prm` TO `promotion`');

    await s.app.inject({ method: 'DELETE', url: `/api/migrations/${id}`, headers: s.admin });
    expect((await s.getDiff()).renames).toEqual([]);
  });

  it('같은 대상이면 수동 매핑이 이기고, 출처를 붙인다', async () => {
    const s = await setup();
    await s.upload();
    const manual = { kind: 'column', table: 'promotion', from: 'reg_dt', to: 'created_at' };
    const saved = await s.app.inject({ method: 'PUT', url: '/api/diff/renames', headers: s.viewer, payload: { base: s.asIs.versionId, target: s.toBe.versionId, renames: [manual] } });
    const renames = saved.json().renames as { from: string; source: string }[];
    expect(renames).toHaveLength(11);
    expect(renames.filter((r) => r.from === 'reg_dt')).toEqual([{ ...manual, source: 'manual' }]);
    expect(renames.filter((r) => r.source === 'dms')).toHaveLength(10);
  });

  it('역방향 비교에는 적용하지 않는다', async () => {
    const s = await setup();
    await s.upload();
    const reverse = await s.getDiff(s.toBe.versionId, s.asIs.versionId);
    expect(reverse.renames).toEqual([]);
    expect(tableOps(reverse)).toContain('drop:promotion');
  });
});

describe('GET /api/migration-flow', () => {
  it('매핑이 없으면 mapping: null, 있으면 메타·전환 표·경고', async () => {
    const s = await setup();
    const url = `/api/migration-flow?base=${s.asIs.versionId}&target=${s.toBe.versionId}`;
    expect((await s.app.inject({ method: 'GET', url, headers: s.viewer })).json()).toEqual({ mapping: null });
    await s.upload();
    const res = (await s.app.inject({ method: 'GET', url, headers: s.viewer })).json();
    expect(res.mapping).toMatchObject({ revision: 1, ruleCount: 19 });
    expect(res.mapping).not.toHaveProperty('source');
    expect(res.flow.totals).toMatchObject({ inScope: 3, verified: 2 });
    expect(res.warnings.map((w: { ruleId: string }) => w.ruleId)).toEqual(['50']);
  });

  it('역방향(To-Be → As-Is) 비교에는 적용하지 않는다', async () => {
    const s = await setup();
    await s.upload();
    const res = await s.app.inject({ method: 'GET', url: `/api/migration-flow?base=${s.toBe.versionId}&target=${s.asIs.versionId}`, headers: s.viewer });
    expect(res.json()).toEqual({ mapping: null });
  });
});
```

`apps/server/test/diff.test.ts` — `PUT /api/diff/renames` 테스트의 `reloaded.renames` 기대값에 출처를 붙인다:
```ts
    expect(reloaded.renames).toEqual([{ kind: 'table', from: 'members', to: 'member', source: 'manual' }]);
```

`apps/server/test/authz.test.ts` — Task 3 에서 넣은 migrations 케이스 아래에 추가:
```ts
  { method: 'GET', url: '/api/migration-flow?base=1&target=1', anon: 401, viewer: 200, admin: 200 },
  { method: 'GET', url: '/api/migration-flow?base=abc&target=1', anon: 401, viewer: 400, admin: 400 },
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @tdm/server -- test/migration-diff.test.ts test/diff.test.ts test/authz.test.ts`
Expected: FAIL — rename 이 적용되지 않음(`drop:tb_prm`), `source` 없음, `/api/migration-flow` 404

- [ ] **Step 3: diff 서비스 교체**

`apps/server/src/services/diff-service.ts`:
```ts
import { canonicalJson, diffSchemas, generateDdl, parseDmsMapping, renderDdl, toRenameMappings, type RenameMapping, type SchemaDiff, type SchemaModel, type Statement } from '@tdm/core';
import type { Db } from '../db/connection';
import { latestMigration } from '../repos/migrations';
import { listRenames } from '../repos/renames';
import { getVersionMeta, loadVersion, type VersionMeta } from '../repos/versions';

export type RenameSource = 'dms' | 'manual';
export type SourcedRename = RenameMapping & { source: RenameSource };

export interface DiffResponse {
  base: VersionMeta;
  target: VersionMeta;
  baseModel: SchemaModel;
  targetModel: SchemaModel;
  diff: SchemaDiff;
  statements: Statement[];
  ddl: string;
  renames: SourcedRename[];
}

// 버전 내용은 불변이라 키는 (base, target, 전환 매핑 id, 수동 rename 매핑)뿐이다. 버전·매핑 삭제 시 clear()로 비운다(id 재사용 대비)
export class DiffCache {
  private readonly entries = new Map<string, DiffResponse>();

  constructor(private readonly max: number) {}

  get(key: string): DiffResponse | undefined {
    const value = this.entries.get(key);
    if (value) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: DiffResponse): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }

  clear(): void {
    this.entries.clear();
  }
}

const renameKey = (r: RenameMapping) => `${r.kind}:${r.table ?? ''}:${r.from}`;

// 같은 대상(kind, table, from)이면 수동 매핑이 DMS 매핑을 이긴다
export function mergeRenames(dms: RenameMapping[], manual: RenameMapping[]): SourcedRename[] {
  const manualKeys = new Set(manual.map(renameKey));
  return [
    ...dms.filter((r) => !manualKeys.has(renameKey(r))).map((r) => ({ ...r, source: 'dms' as const })),
    ...manual.map((r) => ({ ...r, source: 'manual' as const })),
  ];
}

export function computeDiff(db: Db, cache: DiffCache, baseId: number, targetId: number): DiffResponse {
  const manual = listRenames(db, baseId, targetId);
  const migration = latestMigration(db, getVersionMeta(db, baseId).schemaId, getVersionMeta(db, targetId).schemaId);
  const key = `${baseId}:${targetId}:${migration?.id ?? 0}:${canonicalJson(manual)}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const base = loadVersion(db, baseId);
  const target = loadVersion(db, targetId);
  const dms = migration ? toRenameMappings(parseDmsMapping(migration.source).mapping, base.model, target.model) : [];
  const renames = mergeRenames(dms, manual);
  const diff = diffSchemas(base.model, target.model, renames);
  const statements = generateDdl(diff);
  const result: DiffResponse = {
    base: base.version, target: target.version, baseModel: base.model, targetModel: target.model,
    diff, statements, ddl: renderDdl(statements, diff.partial), renames,
  };
  cache.set(key, result);
  return result;
}
```

- [ ] **Step 4: 전환 표 서비스·라우트 교체**

`apps/server/src/services/migration-service.ts`:
```ts
import { buildMigrationFlow, DmsParseError, parseDmsMapping, type DmsMapping, type DmsWarning, type MigrationFlow } from '@tdm/core';
import type { Db } from '../db/connection';
import { AppError } from '../errors';
import { getSchema } from '../repos/catalog';
import { addMigration, latestMigration, type MigrationMeta } from '../repos/migrations';
import { getVersionMeta, loadVersion } from '../repos/versions';

export type MigrationFlowResponse =
  | { mapping: null }
  | { mapping: MigrationMeta; flow: MigrationFlow; warnings: DmsWarning[] };

export interface MigrationUpload {
  fromSchemaId: number;
  toSchemaId: number;
  filename: string;
  source: string;
  note?: string;
  userId: number;
}

// 파싱 불가는 400. 업로드 자체를 거부한다
export function parseOrReject(source: string): { mapping: DmsMapping; warnings: DmsWarning[] } {
  try {
    return parseDmsMapping(source);
  } catch (e) {
    if (e instanceof DmsParseError) throw new AppError(400, e.message);
    throw e;
  }
}

// 파일의 schema 이름이 Schema 이름과 다르면 경고만 한다 (Schema 이름을 바꿔 올리는 경우가 있다)
export function schemaNameWarnings(mapping: DmsMapping, fromName: string, toName: string): DmsWarning[] {
  const out: DmsWarning[] = [];
  const differs = (a: string, b: string) => a.toLowerCase() !== b.toLowerCase();
  if (!mapping.fromSchema.includes('%') && differs(mapping.fromSchema, fromName)) {
    out.push({ ruleId: '', code: 'invalid', message: `파일의 As-Is schema-name '${mapping.fromSchema}' 이 BASE Schema '${fromName}' 과 다릅니다` });
  }
  if (mapping.toSchema !== undefined && differs(mapping.toSchema, toName)) {
    out.push({ ruleId: '', code: 'invalid', message: `파일의 To-Be schema 이름 '${mapping.toSchema}' 이 TARGET Schema '${toName}' 과 다릅니다` });
  }
  return out;
}

export function uploadMigration(db: Db, input: MigrationUpload): { migration: MigrationMeta; warnings: DmsWarning[] } {
  if (input.fromSchemaId === input.toSchemaId) throw new AppError(400, 'As-Is 와 To-Be Schema 가 같습니다');
  const from = getSchema(db, input.fromSchemaId);
  const to = getSchema(db, input.toSchemaId);
  const { mapping, warnings } = parseOrReject(input.source);
  const migration = addMigration(db, { ...input, ruleCount: mapping.ruleCount });
  return { migration, warnings: [...schemaNameWarnings(mapping, from.name, to.name), ...warnings] };
}

// BASE 버전의 Schema → TARGET 버전의 Schema 쌍에 걸린 최신 리비전만 쓴다 (역방향에는 적용하지 않는다)
export function computeMigrationFlow(db: Db, baseId: number, targetId: number): MigrationFlowResponse {
  const base = getVersionMeta(db, baseId);
  const target = getVersionMeta(db, targetId);
  const latest = latestMigration(db, base.schemaId, target.schemaId);
  if (!latest) return { mapping: null };
  const { source, ...meta } = latest;
  const { mapping, warnings } = parseDmsMapping(source);
  const flow = buildMigrationFlow(loadVersion(db, baseId).model, loadVersion(db, targetId).model, mapping);
  return { mapping: meta, flow, warnings: [...schemaNameWarnings(mapping, base.schemaName, target.schemaName), ...warnings] };
}
```

`apps/server/src/routes/migrations.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app';
import { requireAdmin, requireLogin } from '../auth/plugin';
import { attachment } from '../http';
import { MAX_UPLOAD_BYTES, MIGRATION_BODY_LIMIT } from '../limits';
import { getSchema } from '../repos/catalog';
import { deleteMigration, getMigrationSource, listMigrations } from '../repos/migrations';
import { IdParams, NoteSchema, SafeFilename } from '../schemas';
import { computeMigrationFlow, uploadMigration } from '../services/migration-service';

const Id = z.coerce.number().int().positive();
const UploadBody = z.object({
  fromSchemaId: Id,
  toSchemaId: Id,
  filename: SafeFilename,
  source: z.string().min(1, '파일이 비어 있습니다').max(MAX_UPLOAD_BYTES, `파일이 너무 큽니다 (최대 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)`),
  note: NoteSchema.optional(),
});
const PairQuery = z.object({ from: Id, to: Id });
const FlowQuery = z.object({ base: Id, target: Id });

export function migrationRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/migrations', { preHandler: requireAdmin, bodyLimit: MIGRATION_BODY_LIMIT }, async (req, reply) => {
    const body = UploadBody.parse(req.body);
    const result = uploadMigration(ctx.db, { ...body, note: body.note || undefined, userId: req.user!.id });
    ctx.cache.clear(); // 쌍의 최신 매핑이 바뀌어 diff 결과가 달라진다
    return reply.status(201).send(result);
  });

  app.get('/migrations', { preHandler: requireLogin }, async (req) => {
    const { from, to } = PairQuery.parse(req.query);
    getSchema(ctx.db, from);
    getSchema(ctx.db, to);
    return listMigrations(ctx.db, from, to);
  });

  app.get('/migrations/:id/source', { preHandler: requireLogin }, async (req, reply) => {
    const { filename, text } = getMigrationSource(ctx.db, IdParams.parse(req.params).id);
    return reply.header('content-type', 'application/json; charset=utf-8').header('content-disposition', attachment(filename)).send(text);
  });

  app.delete('/migrations/:id', { preHandler: requireAdmin }, async (req) => {
    deleteMigration(ctx.db, IdParams.parse(req.params).id);
    ctx.cache.clear();
    return { ok: true };
  });

  app.get('/migration-flow', { preHandler: requireLogin }, async (req) => {
    const { base, target } = FlowQuery.parse(req.query);
    return computeMigrationFlow(ctx.db, base, target);
  });
}
```

- [ ] **Step 5: 통과 확인**

Run: `npm test -w @tdm/server && npm run typecheck -w @tdm/server`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add apps/server/src/services/diff-service.ts apps/server/src/services/migration-service.ts apps/server/src/routes/migrations.ts apps/server/test/migration-diff.test.ts apps/server/test/diff.test.ts apps/server/test/authz.test.ts
git commit -m "feat: diff 에 DMS 전환 매핑 rename 을 반영하고 전환 표 API 추가" -m "BASE Schema → TARGET Schema 쌍의 최신 매핑을 rename 으로 바꿔 수동 매핑과 합친다(수동 우선, 출처 표시). 캐시 키에 매핑 id 를 넣고, 역방향 비교에는 적용하지 않는다."
```

---

### Task 5: web — 타입·훅·전환 탭(표·검색·필터·펼치기·리비전)

**Files:**
- Modify: `apps/web/src/api/types.ts` (import·`DiffResponse.renames`·끝에 타입 추가)
- Modify: `apps/web/src/api/hooks.ts` (import·`queryKeys`·삭제 캐시 규칙·끝에 훅 추가)
- Modify: `apps/web/src/hooks/useSchemaContext.ts:4,41` (`Tab` 에 `migration`)
- Modify: `apps/web/src/pages/SchemaPage.tsx` (탭 항목·본문)
- Create: `apps/web/src/lib/migration-filter.ts`
- Create: `apps/web/src/features/migration/StatusBadge.tsx`, `MigrationTable.tsx`, `MigrationRevisions.tsx`, `MigrationTab.tsx`, `migration.module.css`
- Create: `apps/web/src/features/migration/MigrationUploadDialog.tsx` (자리 — Task 6 에서 교체)
- Test: `apps/web/test/dms-fixture.ts`, `apps/web/test/migration-filter.test.ts`, `apps/web/test/migration-tab.test.tsx`, `apps/web/test/hooks.test.tsx` (describe 추가), `apps/web/test/schema-page.test.tsx` (it 추가)

**Interfaces:**
- Consumes: `MigrationFlow`, `TableFlow`, `ColumnFlowStatus`, `TableFlowStatus`, `DmsWarning`, `buildMigrationFlow`, `parseDmsMapping`, `parseSqlDump`, `diffSchemas` (`@tdm/core`, Task 1·2). 서버 응답 모양 `MigrationMeta`·`MigrationFlowResponse`·`MigrationUploadResult` (Task 3·4). 기존 `api`, `useMe`, `Banner`, `Icon`, `formatDateTime`, `mockApi`, `json`, `renderWithProviders`
- Produces:
  - 타입: `RenameSource`, `SourcedRename = RenameMapping & { source?: RenameSource }` (출처가 없으면 수동으로 본다), `MigrationMeta`, `MigrationFlowResponse`, `MigrationUploadInput { fromSchemaId; toSchemaId; filename; source; note? }`, `MigrationUploadResult { migration; warnings }`
  - `queryKeys.migrationFlow(base?, target?) = ['migration-flow', base, target]`, `queryKeys.migrations(from?, to?) = ['migrations', from, to]`
  - 훅: `useMigrationFlow(base?, target?)`, `useMigrations(from: number, to: number, enabled: boolean)`, `useUploadMigration()` (mutate(input: MigrationUploadInput)), `useDeleteMigration()` (mutate(id: number)) — 두 변경 훅은 성공 시 `['diff']`·`['migration-flow']`·`['migrations']` 를 무효화한다. `useDeleteVersion` 은 `['migration-flow']` 도 지우고, Schema·Database 삭제는 `['migration-flow']`·`['migrations']` 도 지운다(id 재사용 대비)
  - `type FlowFilter = 'all' | 'renamed' | 'removed' | 'problem' | 'new'`, `FLOW_FILTERS: [FlowFilter, string][]`, `filterFlowTables(tables, filter, query): TableFlow[]`
  - `StatusBadge({ status })`, `statusLabel(status): string`, `MigrationTable({ flow })`, `MigrationRevisions({ from, to, isAdmin })`, `MigrationTab({ data: DiffResponse })`
  - `interface SchemaRef { id: number; name: string }`, `MigrationUploadDialog({ from: SchemaRef; to: SchemaRef; onClose(): void })` (Task 6 가 본문을 채운다)
  - 테스트 도우미 `test/dms-fixture.ts`: `DMS_JSON`, `asIsModel`, `toBeModel`, `fixtureFlow`

필터 의미: 이름변경 = 테이블 rename 룰 적용 또는 컬럼 `renamed` 가 있음 · 컬럼삭제 = 컬럼 `removed` 가 있음 · 문제 = 테이블 `missing-target`/`missing-source` 또는 컬럼 `missing`/`dropped` 가 있음 · 신규 = 테이블 `unmapped-target` 또는 컬럼 `added` 가 있음. 검색은 As-Is·To-Be 테이블명과 컬럼명의 부분 일치(대소문자 무시)이고 필터와 함께 걸린다.

- [ ] **Step 1: 테스트 픽스처 도우미와 실패하는 테스트 작성**

`apps/web/test/dms-fixture.ts` (core 픽스처를 Vite `?raw` 로 읽는다 — `vite/client` 타입에 선언되어 있다):
```ts
import { buildMigrationFlow, parseDmsMapping, parseSqlDump } from '@tdm/core';
import asIsSql from '../../../packages/core/test/fixtures/dms/as-is.sql?raw';
import mappingJson from '../../../packages/core/test/fixtures/dms/mapping.json?raw';
import toBeSql from '../../../packages/core/test/fixtures/dms/to-be.sql?raw';

// core 테스트와 같은 익명화 픽스처 (As-Is legacy → To-Be newapp)
export const DMS_JSON: string = mappingJson;
export const asIsModel = parseSqlDump(asIsSql).model;
export const toBeModel = parseSqlDump(toBeSql).model;
export const fixtureFlow = buildMigrationFlow(asIsModel, toBeModel, parseDmsMapping(DMS_JSON).mapping);
```

`apps/web/test/migration-filter.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { filterFlowTables, type FlowFilter } from '../src/lib/migration-filter';
import { fixtureFlow } from './dms-fixture';

const names = (filter: FlowFilter, query = '') => filterFlowTables(fixtureFlow.tables, filter, query).map((t) => t.asIs ?? t.toBe);

describe('filterFlowTables', () => {
  it('필터별 테이블', () => {
    expect(names('all')).toEqual(['tb_cust', 'tb_prm', 'tb_prm_cnd', 'tb_tmp_bak', 'audit_log']);
    expect(names('renamed')).toEqual(['tb_cust', 'tb_prm', 'tb_prm_cnd']);
    expect(names('removed')).toEqual(['tb_cust', 'tb_prm']);
    expect(names('problem')).toEqual(['tb_cust']); // 룰 대상 없는 컬럼 CUST_GRD, 대응 없는 컬럼 tmp_flag
    expect(names('new')).toEqual(['tb_cust', 'audit_log']); // To-Be 에만 있는 컬럼 email, 매핑되지 않은 테이블
  });

  it('검색은 테이블·컬럼명 부분 일치(대소문자 무시)이고 필터와 함께 걸린다', () => {
    expect(names('all', 'CND_VAL')).toEqual(['tb_prm_cnd']);
    expect(names('all', ' promotion ')).toEqual(['tb_prm', 'tb_prm_cnd']);
    expect(names('removed', 'promotion')).toEqual(['tb_prm']);
    expect(names('all', 'nothing')).toEqual([]);
  });
});
```

`apps/web/test/migration-tab.test.tsx`:
```tsx
import { diffSchemas } from '@tdm/core';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DiffResponse } from '../src/api/types';
import { MigrationTab } from '../src/features/migration/MigrationTab';
import { asIsModel, fixtureFlow, toBeModel } from './dms-fixture';
import { mockApi, renderWithProviders } from './render';

const meta = (id: number, schemaId: number, schemaName: string) => ({
  id, schemaId, schemaName, databaseId: 1, databaseName: 'db', versionNo: 1, sourceFormat: 'sql' as const,
  sourceFilename: `${schemaName}.sql`, note: null, uploadedBy: 'admin', uploadedAt: '2026-10-08T00:00:00.000Z',
});
const data = (baseSchema = 1): DiffResponse => ({
  base: meta(11, baseSchema, 'legacy'), target: meta(12, 2, 'newapp'), baseModel: asIsModel, targetModel: toBeModel,
  diff: diffSchemas(asIsModel, toBeModel), statements: [], ddl: '', renames: [],
});
const MAPPING = { id: 5, fromSchemaId: 1, toSchemaId: 2, revision: 2, filename: 'mapping.json', ruleCount: 19, note: null, uploadedBy: 'admin', uploadedAt: '2026-10-08T00:00:00.000Z' };
const WARNING = { ruleId: '50', code: 'unsupported', message: 'column / convert-lowercase 룰은 반영하지 않습니다' };
const FLOW_URL = '/api/migration-flow?base=11&target=12';
const me = (role: 'admin' | 'viewer') => ({ '/api/auth/me': { id: 1, username: role, role } });
const rowButtons = () => screen.getAllByRole('button', { name: /컬럼 (펼치기|접기)$/ });

describe('MigrationTab: 매핑 없음', () => {
  it('안내 문구와 admin 에게 [매핑 올리기], 누르면 대화상자', async () => {
    mockApi({ ...me('admin'), [FLOW_URL]: { mapping: null } });
    renderWithProviders(<MigrationTab data={data()} />);
    expect(await screen.findByText(/전환 매핑이 없습니다/)).toBeInTheDocument();
    await userEvent.setup().click(await screen.findByRole('button', { name: '매핑 올리기' }));
    expect(screen.getByRole('dialog', { name: '전환 매핑 올리기' })).toBeInTheDocument();
  });

  it('viewer 에게는 올리기 버튼이 없다', async () => {
    mockApi({ ...me('viewer'), [FLOW_URL]: { mapping: null } });
    renderWithProviders(<MigrationTab data={data()} />);
    expect(await screen.findByText(/전환 매핑이 없습니다/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: '매핑 올리기' })).not.toBeInTheDocument());
  });

  it('같은 Schema 의 버전끼리는 안내만 한다', async () => {
    mockApi({ ...me('admin'), '/api/migration-flow?base=11&target=12': { mapping: null } });
    renderWithProviders(<MigrationTab data={data(2)} />);
    expect(await screen.findByText(/같은 Schema 의 버전끼리는/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '매핑 올리기' })).not.toBeInTheDocument();
  });
});

describe('MigrationTab: 매핑 있음', () => {
  const routes = (role: 'admin' | 'viewer') => ({ ...me(role), [FLOW_URL]: { mapping: MAPPING, flow: fixtureFlow, warnings: [WARNING] } });

  it('헤더(파일·리비전·룰 수·검증 수)와 경고', async () => {
    mockApi(routes('viewer'));
    renderWithProviders(<MigrationTab data={data()} />);
    const head = await screen.findByRole('group', { name: '적용 중인 전환 매핑' });
    expect(head).toHaveTextContent('mapping.json');
    expect(head).toHaveTextContent('r2 · 룰 19개 · 검증 2/3');
    expect(screen.getByRole('region', { name: '전환 매핑 경고' })).toHaveTextContent('경고 1건');
    expect(within(head).queryByRole('button', { name: '새 리비전 올리기' })).not.toBeInTheDocument();
  });

  it('필터·검색이 표의 테이블 행을 거른다', async () => {
    mockApi(routes('viewer'));
    renderWithProviders(<MigrationTab data={data()} />);
    await screen.findByRole('table', { name: '전환 표' });
    expect(rowButtons()).toHaveLength(5);
    const user = userEvent.setup();
    const filters = screen.getByRole('radiogroup', { name: '전환 표 필터' });
    await user.click(within(filters).getByRole('radio', { name: '문제' }));
    expect(rowButtons().map((b) => b.textContent)).toEqual(['tb_cust']);
    await user.click(within(filters).getByRole('radio', { name: '신규' }));
    expect(rowButtons()).toHaveLength(2);
    await user.click(within(filters).getByRole('radio', { name: '전체' }));
    await user.type(screen.getByRole('searchbox', { name: '전환 표 검색' }), 'cnd_val');
    expect(rowButtons().map((b) => b.textContent)).toEqual(['tb_prm_cnd']);
    await user.clear(screen.getByRole('searchbox', { name: '전환 표 검색' }));
    await user.type(screen.getByRole('searchbox', { name: '전환 표 검색' }), 'zzz');
    expect(screen.getByText('조건에 맞는 테이블이 없습니다')).toBeInTheDocument();
  });

  it('행을 펼치면 컬럼 매핑과 상태 배지', async () => {
    mockApi(routes('viewer'));
    renderWithProviders(<MigrationTab data={data()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'tb_prm 컬럼 펼치기' }));
    const inner = screen.getByRole('table', { name: 'tb_prm 컬럼 매핑' });
    expect(within(inner).getByText('max_dc_cnt').closest('tr')).toHaveTextContent('컬럼삭제');
    expect(within(inner).getByText('reg_dt').closest('tr')).toHaveTextContent('created_at');
    expect(screen.getByRole('button', { name: 'tb_prm 컬럼 접기' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('리비전 목록: 원본 링크, admin 은 삭제', async () => {
    const calls = mockApi({
      ...routes('admin'),
      '/api/migrations?from=1&to=2': [MAPPING, { ...MAPPING, id: 4, revision: 1, filename: 'old.json' }],
      'DELETE /api/migrations/5': { ok: true },
    });
    renderWithProviders(<MigrationTab data={data()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '리비전 목록' }));
    const list = await screen.findByRole('table', { name: '전환 매핑 리비전' });
    expect(within(list).getAllByRole('link', { name: '원본' })[1]).toHaveAttribute('href', '/api/migrations/4/source');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(within(list).getByRole('button', { name: 'r2 삭제' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/migrations/5' && c.init.method === 'DELETE')).toBe(true));
    confirm.mockRestore();
  });
});
```

`apps/web/test/hooks.test.tsx` — import 줄을 바꾸고 파일 끝에 describe 를 추가한다:
```tsx
import { queryKeys, useDeleteDatabase, useDeleteMigration, useDeleteSchema, useDeleteVersion, useUploadMigration } from '../src/api/hooks';
```
```tsx

// 쌍의 최신 매핑이 바뀌면 rename 이 반영된 diff·전환 표·리비전 목록이 모두 달라진다
describe('전환 매핑 훅의 캐시 정리', () => {
  const KEYS = [queryKeys.diff(11, 12), queryKeys.migrationFlow(11, 12), queryKeys.migrations(1, 2)];
  const setup = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    for (const key of KEYS) client.setQueryData(key, { cached: true });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    return { client, wrapper };
  };

  it.each([
    ['올리기', () => { const m = useUploadMigration(); return { isSuccess: m.isSuccess, run: () => m.mutate({ fromSchemaId: 1, toSchemaId: 2, filename: 'm.json', source: '{"rules":[]}' }) }; }],
    ['삭제', () => { const m = useDeleteMigration(); return { isSuccess: m.isSuccess, run: () => m.mutate(5) }; }],
  ] as const)('%s 후 diff·전환 표·리비전 목록을 무효화한다', async (_label, useHook) => {
    mockApi({ 'POST /api/migrations': { migration: { id: 5 }, warnings: [] }, 'DELETE /api/migrations/5': { ok: true } });
    const { client, wrapper } = setup();
    const { result } = renderHook(useHook, { wrapper });
    result.current.run();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(KEYS.map((k) => client.getQueryState(k)?.isInvalidated)).toEqual([true, true, true]);
  });

  it('Schema 삭제는 전환 표·리비전 캐시도 지운다', async () => {
    mockApi({ 'DELETE /api/schemas/7': { ok: true } });
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useDeleteSchema(), { wrapper });
    result.current.mutate({ id: 7, confirmName: 'shop' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(KEYS.map((k) => client.getQueryData(k))).toEqual([undefined, undefined, undefined]);
  });
});
```

`apps/web/test/schema-page.test.tsx` — `describe('SchemaPage')` 안 마지막에 추가 (`V()` 에 `schemaId` 가 없어 같은 Schema 로 취급된다):
```tsx

  it('전환 탭: 누르면 tab=migration 이 되고 전환 탭 본문을 그린다', async () => {
    mockApi({
      '/api/schemas/7/versions': [V(12, 2), V(11, 1)],
      '/api/diff?base=11&target=12': response(),
      '/api/migration-flow?base=11&target=12': { mapping: null },
      '/api/auth/me': { id: 1, username: 'viewer', role: 'viewer' },
    });
    renderWithProviders(<SchemaPage />, { route: `${ROUTE}?base=11&target=12&tab=summary`, path: '/db/:dbId/schema/:schemaId' });
    await userEvent.setup().click(await screen.findByRole('tab', { name: '전환' }));
    expect(screen.getByTestId('location')).toHaveTextContent('tab=migration');
    expect(await screen.findByText(/같은 Schema 의 버전끼리는/)).toBeInTheDocument();
  });
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @tdm/web -- test/migration-filter.test.ts test/migration-tab.test.tsx test/hooks.test.tsx test/schema-page.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/lib/migration-filter"` 등

- [ ] **Step 3: 타입·훅·URL 상태**

`apps/web/src/api/types.ts` — 첫 import 를 바꾼다:
```ts
import type { DmsWarning, MigrationFlow, ParseWarning, RenameMapping, SchemaDiff, SchemaModel, SourceFormat, Statement } from '@tdm/core';
```
`DiffResponse` 의 `renames` 줄과 그 바로 뒤를 다음으로 바꾼다:
```ts
  renames: SourcedRename[];
}

// diff 에 적용된 rename 의 출처: DMS 전환 매핑 또는 화면에서 넣은 수동 매핑. 출처가 없으면 수동으로 본다
export type RenameSource = 'dms' | 'manual';
export type SourcedRename = RenameMapping & { source?: RenameSource };
```
파일 끝에 추가:
```ts

export interface MigrationMeta {
  id: number;
  fromSchemaId: number;
  toSchemaId: number;
  revision: number;
  filename: string;
  ruleCount: number;
  note: string | null;
  uploadedBy: string;
  uploadedAt: string;
}

export type MigrationFlowResponse =
  | { mapping: null }
  | { mapping: MigrationMeta; flow: MigrationFlow; warnings: DmsWarning[] };

export interface MigrationUploadInput {
  fromSchemaId: number;
  toSchemaId: number;
  filename: string;
  source: string;
  note?: string;
}

export interface MigrationUploadResult {
  migration: MigrationMeta;
  warnings: DmsWarning[];
}
```

`apps/web/src/api/hooks.ts` — 타입 import 를 바꾼다:
```ts
import type { DiffResponse, Me, MigrationFlowResponse, MigrationMeta, MigrationUploadInput, MigrationUploadResult, ObjectHistory, Role, SchemaInfo, TreeDatabase, UploadMeta, UploadResult, User, VersionDetail, VersionSummary } from './types';
```
`queryKeys` 의 `objectHistory` 아래에 두 줄 추가:
```ts
  migrationFlow: (base?: number, target?: number) => ['migration-flow', base, target] as const,
  migrations: (from?: number, to?: number) => ['migrations', from, to] as const,
```
`CATALOG_CACHE_KEYS` 를 바꾼다:
```ts
const CATALOG_CACHE_KEYS = [['versions'], ['version'], ['schema'], ['object-history'], ['diff'], ['migration-flow'], ['migrations']] as const;
```
`useDeleteVersion` 의 `onSuccess` 에서 `client.removeQueries({ queryKey: ['diff'] });` 아래에 추가:
```ts
      client.removeQueries({ queryKey: ['migration-flow'] });
```
파일 끝에 추가:
```ts

// 전환 매핑은 바뀔 수 있지만, 바꾸는 쪽(올리기·삭제)이 캐시를 무효화하므로 그 전까지 다시 받을 필요가 없다
export const useMigrationFlow = (base?: number, target?: number) =>
  useQuery({
    queryKey: queryKeys.migrationFlow(base, target),
    queryFn: () => api<MigrationFlowResponse>(`/migration-flow?base=${base}&target=${target}`),
    enabled: base !== undefined && target !== undefined,
    staleTime: Infinity,
  });

export const useMigrations = (from: number, to: number, enabled: boolean) =>
  useQuery({ queryKey: queryKeys.migrations(from, to), queryFn: () => api<MigrationMeta[]>(`/migrations?from=${from}&to=${to}`), enabled });

// 쌍의 최신 매핑이 바뀌면 diff(rename 반영)·전환 표·리비전 목록이 모두 달라진다
const MIGRATION_DEPENDENT_KEYS = [['diff'], ['migration-flow'], ['migrations']] as const;

function useMigrationMutation<T, R>(fn: (input: T) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const queryKey of MIGRATION_DEPENDENT_KEYS) client.invalidateQueries({ queryKey });
    },
  });
}

export const useUploadMigration = () =>
  useMigrationMutation((input: MigrationUploadInput) => api<MigrationUploadResult>('/migrations', { method: 'POST', json: input }));

export const useDeleteMigration = () =>
  useMigrationMutation((id: number) => api<{ ok: true }>(`/migrations/${id}`, { method: 'DELETE' }));
```

`apps/web/src/hooks/useSchemaContext.ts` — `Tab` 정의를 바꾸고:
```ts
export type Tab = 'summary' | 'diff' | 'ddl' | 'migration';

const TABS: readonly string[] = ['summary', 'diff', 'ddl', 'migration'];
```
반환 객체의 `tab:` 줄을 바꾼다:
```ts
    tab: (tab !== null && TABS.includes(tab) ? tab : 'diff') as Tab,
```

- [ ] **Step 4: 필터·배지·표·리비전 목록**

`apps/web/src/lib/migration-filter.ts`:
```ts
// 전환 표의 필터·검색 (순수 함수)
import type { ColumnFlowStatus, TableFlow } from '@tdm/core';

export type FlowFilter = 'all' | 'renamed' | 'removed' | 'problem' | 'new';

export const FLOW_FILTERS: [FlowFilter, string][] = [
  ['all', '전체'], ['renamed', '이름변경'], ['removed', '컬럼삭제'], ['problem', '문제'], ['new', '신규'],
];

const hasColumn = (t: TableFlow, statuses: ColumnFlowStatus[]) => t.columns.some((c) => statuses.includes(c.status));

function matchesFilter(t: TableFlow, filter: FlowFilter): boolean {
  if (filter === 'renamed') return t.renamed || hasColumn(t, ['renamed']);
  if (filter === 'removed') return hasColumn(t, ['removed']);
  if (filter === 'problem') return t.status === 'missing-target' || t.status === 'missing-source' || hasColumn(t, ['missing', 'dropped']);
  if (filter === 'new') return t.status === 'unmapped-target' || hasColumn(t, ['added']);
  return true;
}

function matchesQuery(t: TableFlow, query: string): boolean {
  if (!query) return true;
  const names = [t.asIs, t.toBe, ...t.columns.flatMap((c) => [c.asIs, c.toBe])];
  return names.some((n) => n !== undefined && n.toLowerCase().includes(query));
}

export function filterFlowTables(tables: readonly TableFlow[], filter: FlowFilter, query: string): TableFlow[] {
  const q = query.trim().toLowerCase();
  return tables.filter((t) => matchesFilter(t, filter) && matchesQuery(t, q));
}
```

`apps/web/src/features/migration/migration.module.css`:
```css
.wrap { display: grid; gap: var(--space-3); padding: var(--space-4); align-content: start; }
.head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); font-size: var(--text-sm); }
.headTitle { font: 600 var(--text-sm) var(--mono); }
.meta { color: var(--fg-muted); font-size: var(--text-sm); }
.spacer { flex: 1; }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.search { height: 28px; min-width: 240px; padding: 0 var(--space-2); border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--bg); color: var(--fg); font: var(--text-sm) var(--mono); }
.seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: var(--radius); overflow: hidden; }
.seg button { height: 28px; padding: 0 var(--space-3); border: 0; border-left: 1px solid var(--border); background: var(--card); color: var(--fg-muted); font-size: var(--text-sm); }
.seg button:first-child { border-left: 0; }
.seg .on { background: var(--accent-bg); color: var(--fg); }
.btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: var(--radius); border: 1px solid var(--border-strong); background: var(--card); color: var(--fg); font-size: var(--text-sm); text-decoration: none; }
.btn:hover { background: var(--muted); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.danger { color: var(--del); }
.error { color: var(--del); font-size: var(--text-sm); margin: 0; }
.table { width: 100%; border-collapse: separate; border-spacing: 0; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; background: var(--card); font-size: var(--text-sm); }
.table th { text-align: left; font-weight: 500; color: var(--fg-muted); background: var(--muted); padding: 6px 10px; border-bottom: 1px solid var(--border); }
.table td { padding: 6px 10px; border-top: 1px solid var(--border); vertical-align: middle; }
.table tbody tr:first-child td { border-top: 0; }
.name { font-family: var(--mono); }
.dim { color: var(--fg-dim); }
.expand { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: transparent; color: var(--fg); font: var(--text-sm) var(--mono); cursor: pointer; }
.columns > td { background: var(--surface); }
.inner { width: 100%; border-collapse: collapse; font-size: var(--text-xs); }
.inner th, .inner td { padding: 4px 8px; text-align: left; border-top: 1px solid var(--border); }
.inner th { color: var(--fg-muted); font-weight: 500; }
.badge { display: inline-block; padding: 0 6px; border-radius: 9px; font-size: var(--text-xs); line-height: 18px; white-space: nowrap; }
.ok { color: var(--add); background: var(--add-bg); }
.rename { color: var(--accent); background: var(--accent-bg); }
.del { color: var(--del); background: var(--del-bg); }
.warn { color: var(--mod); background: var(--mod-bg); }
.muted { color: var(--fg-muted); background: var(--muted); }
.empty { display: grid; gap: var(--space-3); justify-items: center; padding: var(--space-6); border: 1px dashed var(--border-strong); border-radius: var(--radius); color: var(--fg-muted); text-align: center; }
.emptyText { margin: 0; padding: var(--space-6); color: var(--fg-muted); }
.warnings { margin: var(--space-2) 0 0; padding-left: var(--space-4); max-height: 200px; overflow: auto; font: var(--text-xs) var(--mono); }
.preview { display: grid; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); font-size: var(--text-sm); }
.counts { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 4px var(--space-3); margin: 0; padding: 0; list-style: none; }
.counts b { font-family: var(--mono); }
.checks { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.noteLabel { display: grid; gap: 2px; font-size: var(--text-xs); color: var(--fg-muted); }
```

`apps/web/src/features/migration/StatusBadge.tsx`:
```tsx
import type { ColumnFlowStatus, TableFlowStatus } from '@tdm/core';
import s from './migration.module.css';

type Status = TableFlowStatus | ColumnFlowStatus;
type Tone = 'ok' | 'rename' | 'del' | 'warn' | 'muted';

const LABEL: Record<Status, string> = {
  ok: '대응', 'missing-target': 'To-Be 없음', 'missing-source': 'As-Is 없음', excluded: '제외', 'unmapped-target': '신규',
  renamed: '이름변경', same: '동일', removed: '컬럼삭제', added: '신규', dropped: '대응 없음', missing: '룰 대상 없음',
};

// 정상(add)·이름변경(accent)·삭제(del)·확인 필요(mod)·중립(muted). 색만으로 구분하지 않도록 문구를 항상 함께 쓴다
const TONE: Record<Status, Tone> = {
  ok: 'ok', 'missing-target': 'warn', 'missing-source': 'warn', excluded: 'muted', 'unmapped-target': 'ok',
  renamed: 'rename', same: 'muted', removed: 'del', added: 'ok', dropped: 'warn', missing: 'warn',
};

export const statusLabel = (status: Status): string => LABEL[status];

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`${s.badge} ${s[TONE[status]]}`}>{LABEL[status]}</span>;
}
```

`apps/web/src/features/migration/MigrationTable.tsx`:
```tsx
import type { ColumnFlowStatus, MigrationFlow, TableFlow } from '@tdm/core';
import { Fragment, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { FLOW_FILTERS, filterFlowTables, type FlowFilter } from '../../lib/migration-filter';
import { StatusBadge, statusLabel } from './StatusBadge';
import s from './migration.module.css';

const SUMMARY_ORDER: ColumnFlowStatus[] = ['renamed', 'removed', 'added', 'dropped', 'missing'];
const rowKey = (t: TableFlow) => `${t.status}:${t.asIs ?? ''}>${t.toBe ?? ''}`;
const tableName = (t: TableFlow) => t.asIs ?? t.toBe ?? '';

function Name({ value }: { value?: string }) {
  return value ? <span className={s.name}>{value}</span> : <span className={s.dim}>—</span>;
}

// "이름변경 3 · 컬럼삭제 1" (동일 컬럼은 세지 않는다)
function columnSummary(t: TableFlow): string {
  if (t.columns.length === 0) return '';
  const parts = SUMMARY_ORDER
    .map((status) => [status, t.columns.filter((c) => c.status === status).length] as const)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${statusLabel(status)} ${n}`);
  return parts.join(' · ') || '변경 없음';
}

function ColumnTable({ table }: { table: TableFlow }) {
  if (table.columns.length === 0) return <p className={s.meta}>비교할 컬럼이 없습니다</p>;
  return (
    <table className={s.inner} aria-label={`${tableName(table)} 컬럼 매핑`}>
      <thead><tr><th>As-Is 컬럼</th><th>타입</th><th>To-Be 컬럼</th><th>타입</th><th>상태</th></tr></thead>
      <tbody>
        {table.columns.map((c, i) => (
          <tr key={`${c.asIs ?? ''}>${c.toBe ?? ''}:${i}`}>
            <td><Name value={c.asIs} /></td>
            <td><Name value={c.asIsType} /></td>
            <td><Name value={c.toBe} /></td>
            <td><Name value={c.toBeType} /></td>
            <td><StatusBadge status={c.status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Toolbar({ filter, query, shown, total, onFilter, onQuery }: {
  filter: FlowFilter; query: string; shown: number; total: number; onFilter: (f: FlowFilter) => void; onQuery: (q: string) => void;
}) {
  return (
    <div className={s.toolbar}>
      <input type="search" className={s.search} placeholder="As-Is·To-Be 테이블·컬럼 검색" aria-label="전환 표 검색"
        value={query} onChange={(e) => onQuery(e.target.value)} />
      <div className={s.seg} role="radiogroup" aria-label="전환 표 필터">
        {FLOW_FILTERS.map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={filter === id} className={filter === id ? s.on : undefined} onClick={() => onFilter(id)}>{label}</button>
        ))}
      </div>
      <span className={s.meta} role="status">{shown} / {total} 테이블</span>
    </div>
  );
}

export function MigrationTable({ flow }: { flow: MigrationFlow }) {
  const [filter, setFilter] = useState<FlowFilter>('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => filterFlowTables(flow.tables, filter, query), [flow.tables, filter, query]);
  const toggle = (key: string) => setOpen((prev) => new Set(prev.has(key) ? [...prev].filter((k) => k !== key) : [...prev, key]));
  return (
    <>
      <Toolbar filter={filter} query={query} shown={rows.length} total={flow.tables.length} onFilter={setFilter} onQuery={setQuery} />
      {rows.length === 0 ? <p className={s.emptyText}>조건에 맞는 테이블이 없습니다</p> : (
        <table className={s.table} aria-label="전환 표">
          <thead><tr><th>As-Is 테이블</th><th>To-Be 테이블</th><th>상태</th><th>컬럼</th></tr></thead>
          <tbody>
            {rows.map((t) => {
              const key = rowKey(t);
              const isOpen = open.has(key);
              return (
                <Fragment key={key}>
                  <tr>
                    <td>
                      <button type="button" className={s.expand} aria-expanded={isOpen} aria-label={`${tableName(t)} 컬럼 ${isOpen ? '접기' : '펼치기'}`} onClick={() => toggle(key)}>
                        <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} />{t.asIs ?? '—'}
                      </button>
                    </td>
                    <td><Name value={t.toBe} /></td>
                    <td><StatusBadge status={t.status} /></td>
                    <td className={s.meta}>{columnSummary(t)}</td>
                  </tr>
                  {isOpen && <tr className={s.columns}><td colSpan={4}><ColumnTable table={t} /></td></tr>}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
```

주의: 펼치기 버튼의 보이는 글자는 As-Is 이름(없으면 `—`)이고, 테스트의 `rowButtons().map((b) => b.textContent)` 는 이 글자를 본다(아이콘 SVG 는 글자가 없다). 행이 To-Be 전용(`unmapped-target`)이면 접근 가능한 이름은 To-Be 이름이다(`audit_log 컬럼 펼치기`).

`apps/web/src/features/migration/MigrationRevisions.tsx`:
```tsx
import { useDeleteMigration, useMigrations } from '../../api/hooks';
import { formatDateTime } from '../../lib/format';
import s from './migration.module.css';

// 쌍의 리비전 목록. 최신만 적용되므로 선택은 없고, 원본 다운로드와(admin) 삭제만 한다
export function MigrationRevisions({ from, to, isAdmin }: { from: number; to: number; isAdmin: boolean }) {
  const list = useMigrations(from, to, true);
  const remove = useDeleteMigration();
  if (list.error) return <p role="alert" className={s.error}>{list.error.message}</p>;
  if (!list.data) return <p role="status" className={s.meta}>리비전 목록을 불러오는 중…</p>;
  const confirmDelete = (revision: number) =>
    window.confirm(`전환 매핑 r${revision}을(를) 삭제할까요? 최신 리비전을 지우면 바로 이전 리비전이 적용됩니다.`);
  return (
    <>
      <table className={s.table} aria-label="전환 매핑 리비전">
        <thead><tr><th>리비전</th><th>파일</th><th>룰</th><th>업로드</th><th>메모</th><th /></tr></thead>
        <tbody>
          {list.data.map((m) => (
            <tr key={m.id}>
              <td className={s.name}>r{m.revision}</td>
              <td className={s.name}>{m.filename}</td>
              <td>{m.ruleCount.toLocaleString('en-US')}</td>
              <td>{m.uploadedBy} · {formatDateTime(m.uploadedAt)}</td>
              <td>{m.note ?? ''}</td>
              <td>
                <div className={s.toolbar}>
                  <a className={s.btn} href={`/api/migrations/${m.id}/source`} download>원본</a>
                  {isAdmin && (
                    <button type="button" className={`${s.btn} ${s.danger}`} aria-label={`r${m.revision} 삭제`} disabled={remove.isPending}
                      onClick={() => confirmDelete(m.revision) && remove.mutate(m.id)}>삭제</button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {remove.error && <p role="alert" className={s.error}>{remove.error.message}</p>}
    </>
  );
}
```

- [ ] **Step 5: 업로드 대화상자 자리와 탭 본문**

`apps/web/src/features/migration/MigrationUploadDialog.tsx` (자리 — Task 6 에서 전체 교체한다):
```tsx
export interface SchemaRef {
  id: number;
  name: string;
}

// Task 6 에서 미리보기·업로드를 채운다
export function MigrationUploadDialog({ onClose }: { from: SchemaRef; to: SchemaRef; onClose: () => void }) {
  return (
    <div role="dialog" aria-modal="true" aria-label="전환 매핑 올리기">
      <button type="button" onClick={onClose}>닫기</button>
    </div>
  );
}
```

`apps/web/src/features/migration/MigrationTab.tsx`:
```tsx
import type { DmsWarning } from '@tdm/core';
import { useState } from 'react';
import { useMe, useMigrationFlow } from '../../api/hooks';
import type { DiffResponse } from '../../api/types';
import { Banner } from '../../components/Banner';
import { formatDateTime } from '../../lib/format';
import { MigrationRevisions } from './MigrationRevisions';
import { MigrationTable } from './MigrationTable';
import { MigrationUploadDialog, type SchemaRef } from './MigrationUploadDialog';
import s from './migration.module.css';

function Warnings({ warnings }: { warnings: DmsWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <Banner tone="warn" label="전환 매핑 경고">
      <details>
        <summary>경고 {warnings.length}건 — 반영하지 않은 룰과 이름 불일치</summary>
        <ul className={s.warnings}>
          {warnings.map((w, i) => <li key={`${w.ruleId}-${i}`}>{w.ruleId ? `rule ${w.ruleId} · ` : ''}{w.message}</li>)}
        </ul>
      </details>
    </Banner>
  );
}

// 전환 탭: BASE 버전 Schema(As-Is) → TARGET 버전 Schema(To-Be) 쌍의 최신 매핑을 표로 보여 준다
export function MigrationTab({ data }: { data: DiffResponse }) {
  const me = useMe();
  const flow = useMigrationFlow(data.base.id, data.target.id);
  const [uploading, setUploading] = useState(false);
  const [showRevisions, setShowRevisions] = useState(false);
  const isAdmin = me.data?.role === 'admin';
  const from: SchemaRef = { id: data.base.schemaId, name: data.base.schemaName };
  const to: SchemaRef = { id: data.target.schemaId, name: data.target.schemaName };
  const dialog = uploading && <MigrationUploadDialog from={from} to={to} onClose={() => setUploading(false)} />;

  if (from.id === to.id) return <p className={s.emptyText}>같은 Schema 의 버전끼리는 전환 매핑을 쓰지 않습니다. BASE 를 As-Is Schema 의 버전으로 고르세요 (BASE → 다른 Database/Schema와 비교…).</p>;
  if (flow.error) return <p role="alert" className={s.emptyText}>{flow.error.message}</p>;
  if (!flow.data) return <p role="status" className={s.emptyText}>전환 표를 불러오는 중…</p>;
  const result = flow.data;
  if (result.mapping === null) {
    return (
      <div className={s.wrap}>
        <div className={s.empty}>
          <p>{from.name} → {to.name} 쌍에는 전환 매핑이 없습니다. AWS DMS table-mapping JSON 을 올리면 테이블·컬럼 대응을 보여 주고 rename 을 diff 에 반영합니다.</p>
          {isAdmin && <button type="button" className={s.btn} onClick={() => setUploading(true)}>매핑 올리기</button>}
        </div>
        {dialog}
      </div>
    );
  }
  const { mapping, flow: table, warnings } = result;
  return (
    <div className={s.wrap}>
      <div className={s.head} role="group" aria-label="적용 중인 전환 매핑">
        <span className={s.headTitle}>{mapping.filename}</span>
        <span className={s.meta}>r{mapping.revision} · 룰 {mapping.ruleCount.toLocaleString('en-US')}개 · 검증 {table.totals.verified}/{table.totals.inScope}</span>
        <span className={s.meta}>{mapping.uploadedBy} · {formatDateTime(mapping.uploadedAt)}</span>
        <span className={s.spacer} />
        <button type="button" className={s.btn} aria-expanded={showRevisions} onClick={() => setShowRevisions((v) => !v)}>리비전 목록</button>
        {isAdmin && <button type="button" className={s.btn} onClick={() => setUploading(true)}>새 리비전 올리기</button>}
      </div>
      {showRevisions && <MigrationRevisions from={from.id} to={to.id} isAdmin={isAdmin} />}
      <Warnings warnings={warnings} />
      <MigrationTable flow={table} />
      {dialog}
    </div>
  );
}
```

`apps/web/src/pages/SchemaPage.tsx` — import 추가:
```tsx
import { MigrationTab } from '../features/migration/MigrationTab';
```
`Tabs` 의 `items` 에 전환 탭을 더한다:
```tsx
        items={[{ id: 'summary', label: '요약', badge: changed }, { id: 'diff', label: '객체 diff' }, { id: 'ddl', label: 'DDL' }, { id: 'migration', label: '전환' }]} />
```
`DdlTab` 줄 아래에 추가:
```tsx
      {ctx.tab === 'migration' && <MigrationTab data={diff.data} />}
```

- [ ] **Step 6: 통과 확인**

Run: `npm test -w @tdm/web && npm run typecheck -w @tdm/web`
Expected: PASS (기존 schema-page 의 rename 배너 테스트도 그대로 통과 — `source` 가 없는 rename 은 수동으로 본다)

- [ ] **Step 7: 커밋**

```bash
git add apps/web/src/api/types.ts apps/web/src/api/hooks.ts apps/web/src/hooks/useSchemaContext.ts apps/web/src/pages/SchemaPage.tsx apps/web/src/lib/migration-filter.ts apps/web/src/features/migration apps/web/test/dms-fixture.ts apps/web/test/migration-filter.test.ts apps/web/test/migration-tab.test.tsx apps/web/test/hooks.test.tsx apps/web/test/schema-page.test.tsx
git commit -m "feat: 전환 탭 추가 (테이블·컬럼 대응 표, 검색·필터·펼치기, 리비전 목록)" -m "GET /migration-flow 결과를 표로 보여 주고, 매핑이 없으면 안내와 admin 용 올리기 버튼을 둔다. 매핑 변경 시 diff·전환 표·리비전 캐시를 무효화한다."
```

---

### Task 6: web — 매핑 올리기 대화상자(브라우저 미리보기) + rename 배너 출처 표시

**Files:**
- Create: `apps/web/src/hooks/useDialog.ts`
- Modify: `apps/web/src/features/upload/UploadDialog.tsx` (포커스·Escape·Tab 순환을 `useDialog` 로 교체)
- Modify: `apps/web/src/features/migration/MigrationUploadDialog.tsx` (Task 5 의 자리를 전체 교체)
- Modify: `apps/web/src/features/diff/RenameBanner.tsx` (전체 교체), `apps/web/src/features/diff/diff.module.css` (끝에 `.source`)
- Test: `apps/web/test/migration-upload.test.tsx`, `apps/web/test/schema-page.test.tsx` (it 추가)

**Interfaces:**
- Consumes: `parseDmsMapping`, `DmsMapping`, `DmsWarning` (`@tdm/core`, Task 1), `useUploadMigration`, `SchemaRef`, `SourcedRename`, `useSaveRenames` (Task 5·기존), `DMS_JSON` (Task 5 `test/dms-fixture.ts`)
- Produces:
  - `useDialogFocus(dialogRef: RefObject<HTMLElement | null>, onClose: () => void): void` — 열릴 때 첫 포커스 가능 요소로 이동, 닫히면 연 요소로 복귀, Escape 로 닫기
  - `trapTab(e: KeyboardEvent<HTMLElement>): void` — Tab 순환
  - `MigrationUploadDialog({ from, to, onClose })` — 파일 1개(`.json`), 미리보기(룰 수, 종류별 개수, 경고, 파일 schema 이름 vs BASE/TARGET Schema 이름), 메모, `매핑 올리기`. 성공하면 `onClose()`
  - `RenameBanner({ data })` — 수동 rename 은 `적용된 이름 변경`(해제 가능, `수동` 표시), DMS rename 은 `DMS 매핑에서 적용된 이름 변경`(접힌 목록, `DMS` 표시, 해제 없음). 저장 요청에는 수동 rename 만 보낸다

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/web/test/migration-upload.test.tsx`:
```tsx
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MigrationUploadDialog } from '../src/features/migration/MigrationUploadDialog';
import { DMS_JSON } from './dms-fixture';
import { json, mockApi, renderWithProviders } from './render';

const FROM = { id: 1, name: 'legacy' };
const TO = { id: 2, name: 'newapp' };
const RESULT = { migration: { id: 5, fromSchemaId: 1, toSchemaId: 2, revision: 1, filename: 'mapping.json', ruleCount: 19, note: '1차 매핑', uploadedBy: 'admin', uploadedAt: '2026-10-08T00:00:00.000Z' }, warnings: [] };
const jsonFile = (text: string, name = 'mapping.json') => new File([text], name, { type: 'application/json' });

describe('MigrationUploadDialog', () => {
  it('미리보기(룰 수·종류별 개수·Schema 이름·경고) 후 올리면 본문을 보내고 닫힌다', async () => {
    const calls = mockApi({ 'POST /api/migrations': RESULT });
    const onClose = vi.fn();
    renderWithProviders(<MigrationUploadDialog from={FROM} to={TO} onClose={onClose} />);
    const user = userEvent.setup();
    expect(screen.getByRole('button', { name: '매핑 올리기' })).toBeDisabled();
    await user.upload(screen.getByLabelText('매핑 파일 선택'), jsonFile(DMS_JSON));
    const preview = await screen.findByRole('region', { name: '미리보기' });
    expect(within(preview).getByText(/룰 19개/)).toBeInTheDocument();
    const counts = within(preview).getByRole('list', { name: '룰 종류별 개수' });
    expect(within(counts).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'selection include 3', 'selection exclude 0', '테이블 이름변경 3', '컬럼 이름변경 9', '컬럼삭제 2', '스키마 이름변경 1', '반영하지 않는 룰 1',
    ]);
    const checks = within(preview).getByRole('list', { name: 'Schema 이름 확인' });
    expect(checks).toHaveTextContent('As-Is: 파일 legacy · Schema legacy — 일치');
    expect(checks).toHaveTextContent('To-Be: 파일 newapp · Schema newapp — 일치');
    expect(within(preview).getByText('경고 1건')).toBeInTheDocument();
    await user.type(screen.getByLabelText('메모'), '1차 매핑');
    await user.click(screen.getByRole('button', { name: '매핑 올리기' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const body = JSON.parse(String(calls.find((c) => c.url === '/api/migrations')!.init.body));
    expect(body).toEqual({ fromSchemaId: 1, toSchemaId: 2, filename: 'mapping.json', source: DMS_JSON, note: '1차 매핑' });
  });

  it('JSON 이 아니면 오류를 보여 주고 올리기 버튼은 비활성', async () => {
    mockApi({});
    renderWithProviders(<MigrationUploadDialog from={FROM} to={TO} onClose={() => undefined} />);
    await userEvent.setup().upload(screen.getByLabelText('매핑 파일 선택'), jsonFile('{ nope', 'bad.json'));
    expect(await screen.findByRole('alert')).toHaveTextContent('bad.json: JSON 형식이 아닙니다');
    expect(screen.queryByRole('region', { name: '미리보기' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '매핑 올리기' })).toBeDisabled();
  });

  it('파일의 schema 이름이 Schema 이름과 다르면 "다름" 으로 알려 주되 올릴 수 있다', async () => {
    mockApi({});
    renderWithProviders(<MigrationUploadDialog from={{ id: 1, name: 'astore' }} to={TO} onClose={() => undefined} />);
    await userEvent.setup().upload(screen.getByLabelText('매핑 파일 선택'), jsonFile(DMS_JSON));
    const checks = await screen.findByRole('list', { name: 'Schema 이름 확인' });
    expect(checks).toHaveTextContent('As-Is: 파일 legacy · Schema astore — 다름 (그대로 올릴 수 있습니다)');
    expect(screen.getByRole('button', { name: '매핑 올리기' })).toBeEnabled();
  });

  it('서버 오류는 대화상자 안에 보여 주고 닫지 않는다', async () => {
    mockApi({ 'POST /api/migrations': json({ error: '관리자 권한이 필요합니다' }, 403) });
    const onClose = vi.fn();
    renderWithProviders(<MigrationUploadDialog from={FROM} to={TO} onClose={onClose} />);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText('매핑 파일 선택'), jsonFile(DMS_JSON));
    await user.click(await screen.findByRole('button', { name: '매핑 올리기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('관리자 권한이 필요합니다');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('열리면 포커스가 대화상자 안으로 가고, Escape 로 닫힌다', async () => {
    mockApi({});
    const onClose = vi.fn();
    renderWithProviders(<MigrationUploadDialog from={FROM} to={TO} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: '전환 매핑 올리기' });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await userEvent.setup().keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
```

`apps/web/test/schema-page.test.tsx` — `describe('SchemaPage')` 안 마지막에 추가:
```tsx

  it('적용된 rename 에 출처를 표시하고, 해제는 수동 매핑만 다시 저장한다', async () => {
    const dms = { kind: 'table', from: 'members', to: 'member', source: 'dms' };
    const manual = { kind: 'column', table: 'orders', from: 'x', to: 'y', source: 'manual' };
    const calls = mockApi({
      '/api/schemas/7/versions': [V(12, 2), V(11, 1)],
      '/api/diff?base=11&target=12': { ...response(), renames: [dms, manual] },
      'PUT /api/diff/renames': () => response(),
    });
    renderWithProviders(<SchemaPage />, { route: `${ROUTE}?base=11&target=12&tab=summary`, path: '/db/:dbId/schema/:schemaId' });
    const manualBanner = await screen.findByRole('region', { name: '적용된 이름 변경' });
    expect(manualBanner).toHaveTextContent(/수동\s*orders\.x → y/);
    const dmsBanner = screen.getByRole('region', { name: 'DMS 매핑에서 적용된 이름 변경' });
    expect(dmsBanner).toHaveTextContent('이름 변경 1건');
    expect(within(dmsBanner).queryByRole('button', { name: '해제' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '이름 변경 후보' })).not.toBeInTheDocument(); // DMS 로 이미 적용된 후보는 다시 묻지 않는다
    await userEvent.setup().click(within(manualBanner).getByRole('button', { name: '해제' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/diff/renames')).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url === '/api/diff/renames')!.init.body)).renames).toEqual([]);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @tdm/web -- test/migration-upload.test.tsx test/schema-page.test.tsx`
Expected: FAIL — `매핑 파일 선택` 레이블 없음(자리 대화상자), `DMS 매핑에서 적용된 이름 변경` region 없음

- [ ] **Step 3: 대화상자 공용 훅 추출**

`apps/web/src/hooks/useDialog.ts`:
```ts
import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

// 열릴 때 첫 포커스 가능 요소로 포커스를 옮기고, 닫히면 열었던 요소로 되돌린다. Escape 로 닫는다
export function useDialogFocus(dialogRef: RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => opener?.focus();
  }, [dialogRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

// Tab 이동을 대화상자 안에서 순환시킨다
export function trapTab(e: ReactKeyboardEvent<HTMLElement>): void {
  if (e.key !== 'Tab') return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return;
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
```

`apps/web/src/features/upload/UploadDialog.tsx`:
- react import 를 `import { useRef, useState, type DragEvent } from 'react';` 로 바꾸고, `import { trapTab, useDialogFocus } from '../../hooks/useDialog';` 를 추가한다
- `const dialogRef = useRef<HTMLDivElement>(null);` 바로 아래의 두 `useEffect`(포커스 이동 주석이 붙은 것과 Escape 키 처리)를 지우고 한 줄로 바꾼다:
```tsx
  useDialogFocus(dialogRef, onClose);
```
- 파일 아래쪽의 `// Tab 이동을 대화상자 안에서 순환시킨다` 주석과 `const trapTab = …` 블록(10줄)을 지운다. JSX 의 `onKeyDown={trapTab}` 는 그대로 둔다(이제 import 한 함수를 가리킨다)

Run: `npm test -w @tdm/web -- test/upload.test.tsx`
Expected: PASS (포커스 이동·복귀 테스트 포함, 동작이 바뀌지 않았다)

- [ ] **Step 4: 올리기 대화상자 구현**

`apps/web/src/features/migration/MigrationUploadDialog.tsx` (전체 교체):
```tsx
import { parseDmsMapping, type DmsMapping, type DmsWarning } from '@tdm/core';
import { useRef, useState } from 'react';
import { useUploadMigration } from '../../api/hooks';
import { Icon } from '../../components/Icon';
import { trapTab, useDialogFocus } from '../../hooks/useDialog';
import u from '../upload/UploadDialog.module.css';
import s from './migration.module.css';

// 서버 규칙과 동일: 파일명 255자 이하·경로 구분자 금지, 원문 20MB 이하
const MAX_FILENAME = 255;
const MAX_BYTES = 20 * 1024 * 1024;

export interface SchemaRef {
  id: number;
  name: string;
}

interface Preview {
  filename: string;
  source: string;
  mapping: DmsMapping;
  warnings: DmsWarning[];
}

// 서버와 같은 core 파서로 미리 해석한다 (최종 판정은 서버가 다시 파싱해서 한다)
async function readPreview(file: File): Promise<Preview | string> {
  if (file.name.length > MAX_FILENAME || /[/\\]/.test(file.name)) return `파일명이 ${MAX_FILENAME}자를 넘거나 / \\ 문자를 포함합니다`;
  if (file.size > MAX_BYTES) return '파일이 너무 큽니다 (최대 20MB)';
  const source = await file.text();
  try {
    return { filename: file.name, source, ...parseDmsMapping(source) };
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function ruleCounts(m: DmsMapping, warnings: DmsWarning[]): [string, number][] {
  return [
    ['selection include', m.selection.include.length],
    ['selection exclude', m.selection.exclude.length],
    ['테이블 이름변경', m.tables.length],
    ['컬럼 이름변경', m.columns.length],
    ['컬럼삭제', m.removedColumns.length],
    ['스키마 이름변경', m.toSchema === undefined ? 0 : 1],
    ['반영하지 않는 룰', warnings.filter((w) => w.code === 'unsupported').length],
  ];
}

function SchemaCheck({ label, fileName, schema }: { label: string; fileName?: string; schema: SchemaRef }) {
  const isSame = fileName !== undefined && fileName.toLowerCase() === schema.name.toLowerCase();
  return (
    <li className={isSame ? u.ok : u.warn}>
      {label}: 파일 <code>{fileName ?? '(없음)'}</code> · Schema <code>{schema.name}</code> — {isSame ? '일치' : '다름 (그대로 올릴 수 있습니다)'}
    </li>
  );
}

function PreviewPanel({ preview, from, to }: { preview: Preview; from: SchemaRef; to: SchemaRef }) {
  const { mapping, warnings } = preview;
  return (
    <section className={s.preview} aria-label="미리보기">
      <p className={s.headTitle}>{preview.filename} · 룰 {mapping.ruleCount.toLocaleString('en-US')}개</p>
      <ul className={s.counts} aria-label="룰 종류별 개수">
        {ruleCounts(mapping, warnings).map(([label, n]) => <li key={label}><span>{label}</span> <b>{n.toLocaleString('en-US')}</b></li>)}
      </ul>
      <ul className={s.checks} aria-label="Schema 이름 확인">
        <SchemaCheck label="As-Is" fileName={mapping.fromSchema} schema={from} />
        <SchemaCheck label="To-Be" fileName={mapping.toSchema} schema={to} />
      </ul>
      {warnings.length === 0 ? <p className={u.ok}>경고 없음</p> : (
        <details>
          <summary className={u.warn}>경고 {warnings.length}건</summary>
          <ul className={s.warnings}>{warnings.map((w, i) => <li key={`${w.ruleId}-${i}`}>rule {w.ruleId} · {w.message}</li>)}</ul>
        </details>
      )}
    </section>
  );
}

// As-Is → To-Be Schema 쌍에 DMS 매핑을 새 리비전으로 올린다 (admin 만 연다. 서버도 다시 확인한다)
export function MigrationUploadDialog({ from, to, onClose }: { from: SchemaRef; to: SchemaRef; onClose: () => void }) {
  const upload = useUploadMigration();
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, onClose);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    const result = await readPreview(file);
    upload.reset();
    setPreview(typeof result === 'string' ? undefined : result);
    setError(typeof result === 'string' ? `${file.name.slice(0, 40)}: ${result}` : '');
  };
  const submit = () => {
    if (!preview) return;
    const trimmed = note.trim();
    upload.mutate(
      { fromSchemaId: from.id, toSchemaId: to.id, filename: preview.filename, source: preview.source, ...(trimmed ? { note: trimmed } : {}) },
      { onSuccess: () => onClose() },
    );
  };

  return (
    <div className={u.backdrop} role="presentation" onClick={onClose}>
      <div ref={dialogRef} className={u.dialog} role="dialog" aria-modal="true" aria-labelledby="migration-upload-title" onClick={(e) => e.stopPropagation()} onKeyDown={trapTab}>
        <header className={u.head}>
          <h2 id="migration-upload-title">전환 매핑 올리기</h2>
          <button type="button" className={u.iconBtn} aria-label="닫기" onClick={onClose}><Icon name="x" /></button>
        </header>
        <p className={s.meta}>As-Is <code>{from.name}</code> → To-Be <code>{to.name}</code> 쌍에 새 리비전으로 저장합니다. 최신 리비전이 diff 에 자동으로 반영됩니다.</p>
        <label className={u.drop}>
          <Icon name="upload" size={20} />
          <span>AWS DMS table-mapping JSON 파일 1개를 고르세요</span>
          <input type="file" accept=".json,application/json" aria-label="매핑 파일 선택" className="visually-hidden"
            onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {error && <p role="alert" className={u.warn}>{error}</p>}
        {preview && <PreviewPanel preview={preview} from={from} to={to} />}
        <label className={s.noteLabel}>메모
          <input className={s.search} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} aria-label="메모" />
        </label>
        {upload.error && <p role="alert" className={u.warn}>{upload.error.message}</p>}
        <footer className={u.foot}>
          <button type="button" className={u.btn} onClick={onClose}>닫기</button>
          <button type="button" className={`${u.btn} ${u.primary}`} disabled={!preview || upload.isPending} onClick={submit}>매핑 올리기</button>
        </footer>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: rename 배너에 출처 표시**

`apps/web/src/features/diff/diff.module.css` 맨 끝에 추가:
```css
.source { font-size: var(--text-xs); padding: 0 6px; border-radius: 9px; background: var(--muted); color: var(--fg-muted); }
```

`apps/web/src/features/diff/RenameBanner.tsx` (전체 교체):
```tsx
import type { RenameMapping } from '@tdm/core';
import { useSaveRenames } from '../../api/hooks';
import type { DiffResponse, SourcedRename } from '../../api/types';
import { Banner } from '../../components/Banner';
import s from './diff.module.css';

const describe = (r: RenameMapping) => (r.kind === 'table' ? `${r.from} → ${r.to}` : `${r.table}.${r.from} → ${r.to}`);
const same = (a: RenameMapping, b: RenameMapping) => a.kind === b.kind && a.table === b.table && a.from === b.from && a.to === b.to;
const isDms = (r: SourcedRename) => r.source === 'dms';

// 저장은 수동 매핑만 한다. DMS 에서 온 rename 은 전환 매핑을 바꿔야 달라지고, 함께 저장하면 수동 한도(500)를 넘는다
const manualOnly = (renames: SourcedRename[]): RenameMapping[] =>
  renames.filter((r) => !isDms(r)).map(({ source: _source, ...r }) => r);

// rename 후보를 보여 주고, 사용자가 확정하면 (base, target) 쌍에 수동 매핑을 저장한다. 적용된 rename 은 출처(수동/DMS)를 함께 보여 준다
export function RenameBanner({ data }: { data: DiffResponse }) {
  const save = useSaveRenames();
  const manual = manualOnly(data.renames);
  const dms = data.renames.filter(isDms);
  const apply = (renames: RenameMapping[]) => save.mutate({ base: data.base.id, target: data.target.id, renames });
  const candidates = data.diff.renameCandidates.filter((c) => !data.renames.some((r) => same(r, c)));
  return (
    <>
      {candidates.length > 0 && (
        <Banner tone="info" label="이름 변경 후보">
          {candidates.map((c) => (
            <div key={describe(c)} className={s.renameRow}>
              <span><code>{c.kind === 'table' ? c.from : `${c.table}.${c.from}`}</code> 삭제 + <code>{c.to}</code> 추가 → 이름 변경일 수 있습니다</span>
              <button type="button" className={s.linkBtn} disabled={save.isPending} onClick={() => apply([...manual, c])}>이름 변경으로 처리</button>
            </div>
          ))}
        </Banner>
      )}
      {manual.length > 0 && (
        <Banner tone="info" label="적용된 이름 변경">
          {manual.map((r) => (
            <div key={describe(r)} className={s.renameRow}>
              <span className={s.source}>수동</span>
              <span>{describe(r)}</span>
              <button type="button" className={s.linkBtn} disabled={save.isPending} onClick={() => apply(manual.filter((x) => !same(x, r)))}>해제</button>
            </div>
          ))}
        </Banner>
      )}
      {dms.length > 0 && (
        <Banner tone="info" label="DMS 매핑에서 적용된 이름 변경">
          <details>
            <summary><span className={s.source}>DMS</span> 전환 매핑에서 이름 변경 {dms.length}건을 적용했습니다 (전환 탭에서 확인, 같은 대상에 수동 매핑을 넣으면 수동이 우선)</summary>
            {dms.map((r) => <div key={describe(r)} className={s.renameRow}><span>{describe(r)}</span></div>)}
          </details>
        </Banner>
      )}
      {data.diff.ignoredRenames.length > 0 && (
        <Banner tone="warn" label="적용하지 못한 이름 변경">
          {data.diff.ignoredRenames.map((i) => <div key={describe(i.mapping)}>{describe(i.mapping)}: {i.reason}</div>)}
        </Banner>
      )}
      {save.error && <Banner tone="warn" role="alert">{save.error.message}</Banner>}
    </>
  );
}
```

- [ ] **Step 6: 통과 확인**

Run: `npm test -w @tdm/web && npm run typecheck -w @tdm/web && npm run build -w @tdm/web`
Expected: PASS, 빌드 성공 (core 가 브라우저 번들에 들어가므로 `node:` import 가 없어야 한다)

- [ ] **Step 7: 커밋**

```bash
git add apps/web/src/hooks/useDialog.ts apps/web/src/features/upload/UploadDialog.tsx apps/web/src/features/migration/MigrationUploadDialog.tsx apps/web/src/features/diff/RenameBanner.tsx apps/web/src/features/diff/diff.module.css apps/web/test/migration-upload.test.tsx apps/web/test/schema-page.test.tsx
git commit -m "feat: 전환 매핑 올리기 대화상자와 rename 배너 출처 표시 추가" -m "브라우저에서 core 파서로 룰 수·종류별 개수·경고·Schema 이름 일치를 미리 보여 주고 올린다. 적용된 rename 에 DMS/수동 출처를 표시하고, 저장은 수동 매핑만 보낸다. 대화상자 포커스 처리를 useDialog 로 공용화한다."
```

---

### Task 7: 문서 + 브라우저 확인

**Files:**
- Modify: `README.md` (Features, Input files, Permissions), `README.ko.md` (주요 기능, 입력 파일, 권한)
- Modify: `apps/server/README.md`, `apps/server/README.ko.md` (API 요약 표)
- Modify: `docs/superpowers/specs/2026-10-08-dms-migration-mapping-design.md` (1행 아래 상태)

**Interfaces:**
- Consumes: Task 1–6 의 동작과 API 경로
- Produces: 문서만

- [ ] **Step 1: README.md (영어)**

`## Features` 목록의 `- **History**` 줄 위에 추가:
```markdown
- **DB migration mapping**: upload an AWS DMS table-mapping JSON for an As-Is → To-Be Schema pair. The Migration (전환) tab shows table and column correspondence with a status for each, and the same mapping is applied as renames to the object diff and DDL. Manual rename mappings still win for the same object.
```
`## Input files` 표 마지막 행 아래에 추가:
```markdown
| DMS mapping | AWS DMS table-mapping JSON: `selection` include/exclude (`%` wildcard), `transformation` rename of schema/table/column, and `remove-column`. Other actions are listed as warnings and not applied. Up to 20,000 rules, 20MB |
```
`## Permissions` 표의 `| Upload; delete versions, Schemas, Databases |` 행 아래에 추가:
```markdown
| Upload or delete DMS migration mappings | ✓ | — |
```

- [ ] **Step 2: README.ko.md (한국어)**

`## 주요 기능` 목록의 `- **이력**` 줄 위에 추가:
```markdown
- **DB 전환 매핑**: As-Is → To-Be Schema 쌍에 AWS DMS table-mapping JSON 을 올리면, 전환 탭에 테이블·컬럼 대응과 상태를 보여 주고 같은 매핑을 rename 으로 객체 diff·DDL 에 반영합니다. 같은 대상에 대한 수동 rename 매핑이 우선합니다.
```
`## 입력 파일` 표 마지막 행 아래에 추가:
```markdown
| DMS 매핑 | AWS DMS table-mapping JSON: `selection` include/exclude(`%` 와일드카드), `transformation` 의 schema·table·column rename, `remove-column`. 그 밖의 action 은 경고로만 보여 주고 반영하지 않습니다. 룰 20,000개·20MB 까지 |
```
`## 권한` 표의 `| 업로드, 버전·Schema·Database 삭제 |` 행 아래에 추가:
```markdown
| DMS 전환 매핑 올리기·삭제 | O | — |
```

- [ ] **Step 3: 서버 README API 표**

`apps/server/README.md` — API 표의 `| GET | `/objects/:id/history` | logged in |` 행 아래에 추가:
```markdown
| POST | `/migrations` (JSON: `fromSchemaId`, `toSchemaId`, `filename`, `source`, `note?`; returns parse warnings) · DELETE `/migrations/:id` | admin |
| GET | `/migrations?from=&to=`, `/migrations/:id/source`, `/migration-flow?base=&target=` | logged in |
```
표 아래 `PUT /diff/renames` 문단 다음에 추가:
```markdown
A migration mapping belongs to a Schema pair (As-Is → To-Be). Uploading again for the same pair adds a revision, and the latest revision is applied automatically whenever the BASE version belongs to the From Schema and the TARGET version to the To Schema (never in the reverse direction). Renames in `GET /diff` carry `source: 'dms' | 'manual'`.
```

`apps/server/README.ko.md` — API 표의 `| GET | `/objects/:id/history` | 로그인 |` 행 아래에 추가:
```markdown
| POST | `/migrations` (JSON: `fromSchemaId`, `toSchemaId`, `filename`, `source`, `note?`, 파싱 경고를 함께 돌려줌) · DELETE `/migrations/:id` | admin |
| GET | `/migrations?from=&to=`, `/migrations/:id/source`, `/migration-flow?base=&target=` | 로그인 |
```
표 아래 `PUT /diff/renames` 문단 다음에 추가:
```markdown
전환 매핑은 Schema 쌍(As-Is → To-Be)에 붙습니다. 같은 쌍에 다시 올리면 리비전이 늘고, BASE 버전이 From Schema, TARGET 버전이 To Schema 에 속하면 최신 리비전이 자동 적용됩니다(역방향에는 적용하지 않음). `GET /diff` 의 `renames` 항목에는 `source: 'dms' | 'manual'` 이 붙습니다.
```

- [ ] **Step 4: spec 상태**

`docs/superpowers/specs/2026-10-08-dms-migration-mapping-design.md` 의 3행(`작성일: 2026-10-08 · 상위 설계: …`) 끝에 이어 붙인다:
```markdown
 · 상태: 구현 완료 ([구현 계획](../plans/2026-10-08-dms-migration.md))
```

- [ ] **Step 5: 전체 검사**

Run: `npm test && npm run typecheck && npm run build`
Expected: 모든 워크스페이스 PASS, 웹 빌드 성공

- [ ] **Step 6: 브라우저 확인 (수동)**

```bash
npm run build && npm run dev:server     # http://127.0.0.1:3000 (COOKIE_SECURE=false)
```
admin 으로 로그인한 뒤 다음을 확인하고, 결과를 PR 본문의 Test plan 에 체크한다.
1. 같은 Database 에 `packages/core/test/fixtures/dms/as-is.sql`(Schema `legacy`)과 `to-be.sql`(Schema `newapp`)을 올린다
2. `newapp` 화면에서 BASE → "다른 Database/Schema와 비교…" 로 `legacy` 의 버전을 고른다. 요약 탭에 테이블 drop 4 + add 4 가 보인다
3. 전환 탭: 매핑 없음 안내와 [매핑 올리기] → `mapping.json` 선택 → 미리보기에 룰 19개, 테이블 이름변경 3, 컬럼 이름변경 9, 컬럼삭제 2, 경고 1건, Schema 이름 일치 → 메모 입력 후 올리기
4. 헤더 `r1 · 룰 19개 · 검증 2/3`, 필터 문제(1)·컬럼삭제(2)·신규(2)·이름변경(3), 검색 `cnd_val`, `tb_prm` 행 펼치기에서 `max_dc_cnt` 컬럼삭제 배지
5. 요약·객체 diff·DDL 탭: rename 3건, DDL 에 `RENAME TABLE \`tb_prm\` TO \`promotion\``, 배너 `DMS 매핑에서 적용된 이름 변경` 11건
6. 방향 바꾸기(⇄) 하면 매핑이 적용되지 않는다(drop/add 로 돌아감, 전환 탭은 매핑 없음)
7. 리비전 목록: 같은 파일을 다시 올리면 r2, 원본 다운로드, r2 삭제 시 r1 적용
8. viewer 로 로그인하면 올리기·삭제 버튼이 없다
9. 다크/라이트 두 테마에서 배지 대비, 키보드만으로 대화상자 열기·Tab 순환·Escape, 필터 radiogroup 이동

- [ ] **Step 7: 커밋**

```bash
git add README.md README.ko.md apps/server/README.md apps/server/README.ko.md docs/superpowers/specs/2026-10-08-dms-migration-mapping-design.md
git commit -m "docs: DMS 전환 매핑 기능 문서화" -m "README(영어·한국어)에 기능·입력 형식·권한을, 서버 README 에 /migrations·/migration-flow API 를 추가하고 spec 상태를 갱신한다."
```

---

## Self-Review

**Spec coverage**

| Spec | Task |
|---|---|
| 2절 해석 규칙(selection `%`·exclude 우선·selection 없으면 전부, schema/table/column rename, remove-column, 미지원 경고, transformation 와일드카드 경고, 중복은 큰 rule-id, 대소문자 무시·정확 일치 우선, 400 조건, 20,000개) | 1, 2 |
| 3절 데이터 모델 `002_migration_mappings.sql`, 리비전, 연쇄 삭제, 역방향 미적용 | 3, 4 |
| 3절 수동 매핑 우선, `source` 태그, 수동 한도 500 미적용 | 4, 6 |
| 4절 core `parseDmsMapping`·`toRenameMappings`·`buildMigrationFlow`(상태·합계·검증 통과 수) | 1, 2 |
| 4절 server repos·라우트 5개·20MB·캐시 키·캐시 비우기 | 3, 4 |
| 4절 web 전환 탭(URL `tab=migration`, 안내·admin 올리기, 헤더·리비전 메뉴, 검색·필터·펼치기·상태 배지), 올리기 대화상자(미리보기·메모·포커스 트랩), rename 배너 출처 | 5, 6 |
| 5절 오류 처리(400/404, schema 이름 불일치는 경고) | 3 |
| 6절 테스트(픽스처, 로컬 샘플, core·server·web 사례) | 1–6 |
| README·API 표·spec 상태 | 7 |

**Placeholder scan:** Task 5 의 `MigrationUploadDialog` 는 의도적인 자리(빌드·테스트가 통과하는 최소 구현)이고 Task 6 Step 4 에서 전체 코드로 교체한다. 그 밖에 TBD·"적절히 처리" 류 문구 없음.

**Type consistency:** `DmsMapping`/`DmsWarning`(Task 1) → `buildMigrationFlow`·`toRenameMappings`(Task 2) → `MigrationFlowResponse`(서버 Task 4, 웹 Task 5 에서 같은 모양) · `MigrationMeta` 필드명 서버·웹 동일 · `SourcedRename` 은 서버에서 `source` 필수, 웹에서는 예전 응답을 받아도 되도록 선택(`source?`) · `queryKeys.migrationFlow/migrations` 키 접두어 `'migration-flow'`/`'migrations'` 가 캐시 규칙과 일치 · `SchemaRef` 는 `MigrationUploadDialog.tsx` 에서 export 하고 `MigrationTab` 이 import.

## 완료 기준

- `npm test && npm run typecheck && npm run build` 통과
- Task 7 Step 6 브라우저 확인 1–9 통과
- `git status` 에 `samples/`·`bin/`·`mysql.txt`·`.playwright-mcp/`·`.code-review-graph/` 가 스테이징되지 않음
