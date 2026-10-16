# 비교 결과 HTML 리포트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 스키마 비교 화면의 요약과 객체 diff 를, 도구에 접속하지 않고 열어 보고 공유·보관·인쇄할 수 있는 HTML 파일 하나로 내려받는다.

**Architecture:**
- 서버는 바꾸지 않는다. 웹이 이미 불러온 `DiffResponse` 로 브라우저에서 문서를 만든다.
- 화면과 리포트가 같은 문구·계산을 쓰도록 표시용 컴포넌트를 먼저 뽑는다.
  - `SummaryView`: 통계·안내·변경 객체 목록. 항목은 화면에서 버튼, 리포트에서 링크로 그린다.
  - `AppliedRenames`: 적용된 rename 과 출처, 적용하지 못한 rename.
  - `ObjectBody`: 보기 방식별 객체 본문(SQL diff·표·루틴 표).
- 새 폴더 `apps/web/src/features/report/`
  - `buildReportHtml`: `renderToStaticMarkup` 으로 `ReportDocument` 를 렌더하고 `<!doctype html>` 문서로 감싼다.
  - `ExportReportButton`: 누를 때 `import('./build-report')` 로 리포트 모듈을 불러 Blob 으로 내려받는다.
- CSS: `tokens.css`, 재사용 컴포넌트의 CSS 모듈, `report.css` 를 Vite `?inline` 으로 읽어 이어 붙이고 `<style>` 하나에 넣는다.

**Tech Stack:** TypeScript 7, React 19.3(`react-dom/server` 의 `renderToStaticMarkup`), TanStack Query 5, Vite 8.3.3(CSS 모듈 `?inline`), vitest 5 + jsdom + Testing Library

**Spec:** `docs/superpowers/specs/2026-10-16-html-report-design.md`

**설계 전에 확인한 것** (2026-10-16, 이 레포의 lockfile 버전으로 `/tmp` 사본에서 확인했고, 사본은 지웠다)
- **`?inline` 클래스 이름:** Vite 8.3.3 프로덕션 빌드에서 `x.module.css?inline` 문자열의 클래스 이름은 같은 파일을 보통 import 해서 받은 이름과 같다(예: `_diff_1pklr_1`).
  - 같은 모듈을 첫 화면 청크에서는 보통 import 하고, 지연 청크에서는 보통 import 와 `?inline` 을 함께 해도 그렇다.
  - 그래서 설계대로 `?inline` 을 쓴다. 대안(`:global` 전용 스타일시트 등)은 필요 없다.
  - 이 계획 전체를 사본에 구현하고 프로덕션 빌드에서 리포트를 내려받아 열어 보았다. 화면과 같은 스타일이 붙었다(`table-layout: fixed`, Mark 16px, 통계 grid, 밝은 배경).
- **vitest 의 `?inline`:** vitest 는 CSS 를 처리하지 않는다(`css.include` 기본값 `[]`). 그래서 `?inline` 은 모두 빈 문자열이다. 단위 테스트는 `<style>` 이 있는지만 보고, 스타일은 Task 6 의 브라우저 확인에서 본다(설계 §8).
- **`react-dom/server`:** React 19.3 의 브라우저 빌드(`server.browser`)에도 `renderToStaticMarkup` 이 있다.
  - 동적 `import()` 로 불러 쓸 수 있다.
  - Vite 는 이를 별도 청크 `build-report-<hash>.js`(약 216 kB, gzip 66 kB)로 나눈다. 첫 화면 `index-<hash>.js` 에는 들어가지 않는다.
- **React 렌더 결과:** `renderToStaticMarkup` 은 `<meta charSet="utf-8"/>` 를 쓰고 CSP 값의 작은따옴표를 `&#x27;` 로 바꾼다. 그래서 고정된 문서 머리는 문자열로 쓰고, 값이 들어가는 제목과 본문만 React 로 렌더한다.
  - `<style>` 자식 텍스트는 이스케이프하지 않는다(`a > b` 그대로).
  - `<details open>` 은 `<details open="">` 로 나온다.

## Global Constraints

- **브랜치:** `feat/html-report` (워크트리 `/Users/teinam/dev/tdm-report`). main 에 직접 커밋하지 않는다.
- **준비:** 의존성이 없으면 Task 1 전에 워크트리 루트에서 `npm ci --prefer-offline --no-audit --no-fund` 를 한 번 실행한다.
- **언어:** 화면 문구와 주석은 한국어, 식별자는 영어로 쓴다.
- **커밋:** Conventional Commits(`feat:`, `refactor:`, `docs:`)로 쓰고 본문은 한국어로 쓴다.
- **스테이징:** 경로를 지정해 스테이징한다(`git add <path>`). `samples/`, `bin/`, `mysql.txt`, `.playwright-mcp/`, `.code-review-graph/` 는 스테이징하지 않는다.
- **제어 문자:** 변경한 파일에 제어 문자(탭·개행 제외)를 넣지 않는다. 테스트 문자열에서는 `\u0001` 같은 이스케이프를 쓴다.
- **의존성:** 런타임 의존성을 새로 넣지 않는다(`react-dom` 은 이미 있다).
- **기존 테스트:** 기존 테스트는 고치지 않고 그대로 통과해야 한다. `schema-page.test.tsx` 에는 테스트 하나만 더한다.
- **함수 길이:** 함수는 50줄 아래로 쓴다.
- **완료 확인:**
  - 각 Task 끝: `npm test -w @tdm/web` 와 `npm run typecheck`
  - 마지막 Task: 루트 `npm test && npm run typecheck && npm run build`
- **사용자 흐름:**
  - 버튼은 스키마 비교 화면(`/db/:dbId/schema/:schemaId`) 탭 줄 오른쪽에 둔다. admin·dba·viewer 모두 쓴다.
  - 문구: 버튼 `리포트 내보내기`, 진행 중 `리포트 만드는 중…`, 실패 `리포트를 만들지 못했습니다: {이유}` (`role="alert"`)
  - 비교 결과를 불러오기 전이나 만드는 동안에는 버튼이 꺼진다.
- **`ReportOptions`:** `{ mode: 'sql' | 'grid'; layout: 'split' | 'unified'; generatedAt: Date; generatedBy: string; appVersion: string }`
- **`buildReportHtml`:** 시그니처는 `buildReportHtml(data: DiffResponse, opts: ReportOptions): string` 이고, 같은 입력이면 같은 결과를 내는 순수 함수다.
- **문서 머리:**
  - `<!doctype html>`, `<html lang="ko" data-theme="light">`
  - `<meta charset="utf-8">`, `<meta name="viewport" content="width=device-width, initial-scale=1">`
  - `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`
- **안전:** `<script>` 가 없다. 모든 값은 React 텍스트 노드·속성으로 넣어 이스케이프한다. `dangerouslySetInnerHTML` 은 쓰지 않는다.
- **제목:** `{DB} › {스키마} 비교 리포트` (DB·스키마는 TARGET 버전의 `databaseName`·`schemaName`)
- **보기 방식 표기:** `SQL Split` · `SQL Unified` · `표`
- **파일 이름:** `{DB}_{스키마}_v{BASE}-v{TARGET}_{YYYYMMDD-HHmm}.html` (로컬 시간). DB·스키마의 `/\:*?"<>|` 와 제어 문자는 `_` 로 바꾼다.
- **접기:** 객체마다 `<details open>` 으로 감싼다. 동일 구간은 모두 펼친다. 객체 수와 상관없이 모든 변경 객체를 넣는다.
- **인쇄:** `@media print` 에서 밝은 배경을 쓰고, 객체 머리(`summary`)에 `break-after: avoid` 를 준다.
- **넣지 않는 것:** DDL·전환 탭, 복사 버튼, 이력 링크, rename 후보와 처리·해제 버튼 같은 화면 조작 요소

---

## File Structure

**새 파일 (`apps/web/src/features/diff/`)**

| 파일 | 책임 |
|---|---|
| `messages.ts` | 화면과 리포트가 함께 쓰는 안내 문구 `PARTIAL_MESSAGE` (SchemaPage 에서 옮김) |
| `SummaryView.tsx` | 요약 통계·안내·변경 객체 목록 계산과 문구. 항목은 `renderItem` 으로 그린다 (SummaryTab 에서 옮김) |
| `AppliedRenames.tsx` | 적용된 rename(수동·역방향·DMS)과 적용하지 못한 rename 배너, `describeRename`·`sameRename`·`manualRenames` (RenameBanner 에서 옮김) |
| `ObjectBody.tsx` | 보기 방식별 객체 본문: 표(테이블)·루틴 표·SQL diff (ObjectCard 에서 옮김) |

**새 파일 (`apps/web/src/features/report/`)**

| 파일 | 책임 |
|---|---|
| `report-meta.ts` | `ReportOptions`, `reportTitle`, `viewLabel`, `reportFileName`, `formatGeneratedAt` |
| `ReportObject.tsx` | 객체 하나: `<details open>` 머리(표지·종류·이름·+/−)와 펼친 본문 |
| `ReportDocument.tsx` | 머리말·화면 안내·요약(링크 목록)·객체 diff |
| `styles.ts` | `REPORT_CSS`: 토큰 + 재사용 CSS 모듈(`?inline`) + `report.css` |
| `report.css` | 리포트 전용 기본 글꼴·배경, 머리말, 링크 행, 접기 표지, `@media print` |
| `build-report.tsx` | `buildReportHtml`, `REPORT_CSP`, `reportFileName` 다시 내보내기. 지연 로딩 대상 모듈 |
| `ExportReportButton.tsx` | 버튼, 진행 표시, 오류 안내, 지연 `import()`, Blob 다운로드 |
| `ExportReportButton.module.css` | 버튼·오류 문구 스타일 |

**수정**

| 파일 | 변경 |
|---|---|
| `apps/web/src/features/diff/SummaryTab.tsx` | `SummaryView` 에 버튼 항목 렌더러를 넘기는 얇은 래퍼 |
| `apps/web/src/features/diff/RenameBanner.tsx` | 후보·저장 오류만 남기고 적용된 rename 은 `AppliedRenames` 로 그린다 |
| `apps/web/src/features/diff/ObjectCard.tsx` | 본문을 `ObjectBody` 로 그린다 |
| `apps/web/src/components/Tabs.tsx`, `Tabs.module.css` | 탭 줄 오른쪽 `actions` 자리(tablist 밖) |
| `apps/web/src/lib/download.ts` | `downloadText` 에 MIME `type` 인자(기본값은 지금과 같다) |
| `apps/web/src/pages/SchemaPage.tsx` | `PARTIAL_MESSAGE` import, 탭 줄에 `ExportReportButton` |
| `README.md`, `README.ko.md` | 기능 목록·권한 표에 HTML 리포트 |

**테스트 (`apps/web/test/`)**

| 파일 | 내용 |
|---|---|
| `summary-view.test.tsx` (신규) | 링크 렌더러, 통계, 변경 없음 |
| `applied-renames.test.tsx` (신규) | 읽기 전용, 출처, DMS 펼침, 해제 렌더러, 적용 못 한 rename |
| `object-body.test.tsx` (신규) | SQL Split/Unified, 접기·펼치기, 표, 루틴 표 |
| `report.test.tsx` (신규) | 설계 §8 단위 테스트 전부 |
| `export-report.test.tsx` (신규) | 다운로드 파일 이름·Blob, 진행 중 꺼짐, 오류 alert·재시도, 결과 없음 |
| `schema-page.test.tsx` (수정) | 탭 줄 버튼 테스트 1개 추가 |

---

## Task 1: 요약 표시용 컴포넌트 `SummaryView`

**Files:**
- Create: `apps/web/src/features/diff/messages.ts`, `apps/web/src/features/diff/SummaryView.tsx`
- Modify: `apps/web/src/features/diff/SummaryTab.tsx`, `apps/web/src/pages/SchemaPage.tsx`
- Test: `apps/web/test/summary-view.test.tsx` (신규). 기존 `incomplete.test.tsx`·`routines.test.tsx`·`schema-page.test.tsx` 의 요약 탭 테스트는 고치지 않고 통과해야 한다.

**Interfaces:**
- Consumes:
  - `DiffResponse` (`api/types`)
  - `changedObjects(diff: SchemaDiff): ObjectEntry[]`, `ObjectEntry` (`lib/object-diff`)
  - `Mark({ op })`, `diff.module.css`
- Produces:
  - `export const PARTIAL_MESSAGE: string`
  - `export interface SummaryItemProps { entry: ObjectEntry; className: string; children: ReactNode }`
  - `export type SummaryItemRenderer = (props: SummaryItemProps) => ReactNode`
  - `export function SummaryView({ data, renderItem }: { data: DiffResponse; renderItem: SummaryItemRenderer }): JSX.Element`
  - `SummaryTab` 의 시그니처는 그대로다: `({ data, onOpen }: { data: DiffResponse; onOpen: (kind: ObjectKind, name: string) => void })`

- [ ] **Step 1: 실패하는 테스트 작성** — `apps/web/test/summary-view.test.tsx`

```tsx
import { diffSchemas, parseSqlDump } from '@tdm/core';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SummaryView, type SummaryItemRenderer } from '../src/features/diff/SummaryView';
import { objectAnchor } from '../src/lib/object-diff';

const base = parseSqlDump('CREATE TABLE `orders` (\n  `x` int\n);').model;
const target = parseSqlDump('CREATE TABLE `orders` (\n  `x` bigint\n);\nCREATE TABLE `coupon` (\n  `z` int\n);').model;
const response = (b: typeof base, t: typeof base) =>
  ({ base: { id: 1, versionNo: 1 }, target: { id: 2, versionNo: 2 }, baseModel: b, targetModel: t, diff: diffSchemas(b, t), statements: [], ddl: '', renames: [] }) as never;
const asLink: SummaryItemRenderer = ({ entry, className, children }) => <a href={`#${objectAnchor(entry.kind, entry.name)}`} className={className}>{children}</a>;

describe('SummaryView', () => {
  it('항목 렌더러가 준 요소(링크)로 변경 객체 목록을 그리고, 통계는 요약 탭과 같다', () => {
    render(<SummaryView data={response(base, target)} renderItem={asLink} />);
    const stats = screen.getByRole('list', { name: '변경 통계' });
    expect(within(stats).getByText('테이블 추가').previousSibling).toHaveTextContent('+1');
    expect(within(stats).getByText('테이블/뷰 변경').previousSibling).toHaveTextContent('~1');
    const links = within(screen.getByRole('group', { name: '변경 객체' })).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href')).sort()).toEqual(['#obj-table-coupon', '#obj-table-orders']);
    expect(links[0]).toHaveClass('summaryRow');
    expect(screen.getByRole('link', { name: /orders/ })).toHaveTextContent('col 1');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('변경이 없으면 목록 대신 안내 문구를 보이고 렌더러를 부르지 않는다', () => {
    const calls: string[] = [];
    render(<SummaryView data={response(base, base)} renderItem={({ entry }) => { calls.push(entry.name); return null; }} />);
    expect(screen.getByText('두 버전 사이에 변경 사항이 없습니다')).toBeInTheDocument();
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @tdm/web -- summary-view`
Expected: FAIL — `Failed to resolve import "../src/features/diff/SummaryView" from "test/summary-view.test.tsx"`

- [ ] **Step 3: 구현**

`apps/web/src/features/diff/messages.ts`:

```ts
// 화면과 리포트가 같은 문구를 쓰는 안내
export const PARTIAL_MESSAGE = 'MD 정의서가 포함된 비교입니다. 일부 속성(인덱스 종류·순서, 파티션, CHECK, 문자셋 등)은 비교되지 않았습니다.';
```

`apps/web/src/features/diff/SummaryView.tsx`. 계산과 문구는 기존 `SummaryTab` 에서 그대로 옮기고, 함수 길이 때문에 통계·안내·목록으로 나눈다.

```tsx
import { UNVERIFIED_PREFIX, type EvidenceLevel, type RoutineDiff, type TableDiff } from '@tdm/core';
import { Fragment, type ReactNode } from 'react';
import type { DiffResponse } from '../../api/types';
import { Mark } from '../../components/Mark';
import { changedObjects, type ObjectEntry } from '../../lib/object-diff';
import s from './diff.module.css';

function detail(t?: TableDiff): string {
  if (!t) return '정의 변경';
  if (t.op === 'add') return '신규';
  if (t.op === 'drop') return '삭제';
  const parts = [
    t.op === 'rename' ? `이름 ${t.oldName} → ${t.name}` : '',
    t.columns.length ? `col ${t.columns.length}` : '',
    t.moved.length ? `순서 ${t.moved.length}` : '',
    t.indexes.length ? `idx ${t.indexes.length}` : '',
    t.foreignKeys.length ? `fk ${t.foreignKeys.length}` : '',
    t.checks.length ? `check ${t.checks.length}` : '',
    t.options.length ? '옵션' : '',
    t.partition ? '파티션' : '',
    t.unparsed ? '원문' : '',
  ].filter(Boolean);
  return parts.join(' · ') || '변경';
}

// 루틴 변경 필드 → 화면 이름 (characteristics.* 는 '특성' 하나로 묶는다)
const ROUTINE_FIELD: Record<string, string> = { params: '파라미터', returns: 'RETURNS', body: '본문', sqlMode: 'SQL_MODE' };

function routineDetail(r: RoutineDiff): string {
  if (r.op === 'add') return '신규';
  if (r.op === 'drop') return '삭제';
  const labels = r.fields.map((f) => (f.startsWith('characteristics.') ? '특성' : ROUTINE_FIELD[f] ?? f));
  return [...new Set(labels)].join(' · ') || '변경';
}

// TARGET 완전성 증거 (15회차 4). 판정이 없는 diff(옛 응답)는 확인 불가로 본다
const EVIDENCE_LABEL: Record<EvidenceLevel, string> = { complete: '완전', incomplete: '불완전', unknown: '확인 불가' };

const targetEvidence = (data: DiffResponse) => data.diff.targetEvidence ?? { level: 'unknown' as const, objects: [] };

function entryDetail(e: ObjectEntry): string {
  if (e.kind === 'table') return detail(e.table);
  if (e.routine) return routineDetail(e.routine);
  return e.op === 'modify' ? '정의 변경' : e.op === 'add' ? '신규' : '삭제';
}

interface Stat {
  value: string;
  label: string;
  tone: string;
}

function summaryStats(data: DiffResponse): Stat[] {
  const { tables, views } = data.diff;
  const routines = data.diff.routines ?? [];
  const hasRoutines = routines.length > 0 || (data.baseModel.routines ?? []).length > 0 || (data.targetModel.routines ?? []).length > 0;
  const routineCount = (op: RoutineDiff['op']) => routines.filter((r) => r.op === op).length;
  const count = (op: string) => tables.filter((t) => t.op === op).length;
  const fieldChanges = tables.reduce((n, t) => n + t.columns.length + t.indexes.length + t.foreignKeys.length + t.checks.length, 0);
  const evidence = targetEvidence(data);
  return [
    { value: `+${count('add')}`, label: '테이블 추가', tone: s.add },
    { value: `−${count('drop')}`, label: '테이블 삭제', tone: s.del },
    { value: `~${count('modify') + count('rename') + views.length}`, label: '테이블/뷰 변경', tone: s.mod },
    { value: String(fieldChanges), label: '컬럼·인덱스·제약 변경', tone: '' },
    ...(hasRoutines && !data.diff.routinesUnknown
      ? [{ value: `+${routineCount('add')} −${routineCount('drop')} ~${routineCount('modify')}`, label: '루틴 추가/삭제/변경', tone: '' }]
      : []),
    { value: EVIDENCE_LABEL[evidence.level], label: 'TARGET 완전성', tone: evidence.level === 'complete' ? '' : s.del },
    ...((data.staleModels ?? []).length ? [{ value: '예전 파서', label: '저장 모델', tone: s.del }] : []),
  ];
}

// 루틴 미비교·예전 파서·TARGET 완전성·BASE 불완전 안내
function SummaryNotices({ data }: { data: DiffResponse }) {
  const evidence = targetEvidence(data);
  const held = data.statements.filter((st) => st.evidenceHold).length;
  const stale = data.staleModels ?? [];
  const staleHeld = data.statements.filter((st) => st.staleHold).length;
  const staleNames = stale.map((m) => `${m.side === 'base' ? 'BASE' : 'TARGET'} v${m.versionNo}`).join(', ');
  return (
    <>
      {data.diff.routinesUnknown && <p className={s.notice} role="note">MD 출처라 루틴은 비교하지 않음 — td-export MD 에는 함수·프로시저가 없습니다</p>}
      {stale.length > 0 && (
        <p className={s.notice} role="note">
          예전 파서로 저장됐거나 원문과 대조할 수 없는 버전({staleNames})이 낀 비교입니다 — 문장 {staleHeld}개를
          실행하지 않고 수동 확인으로 돌렸습니다. {stale[0].reason}. 같은 원문을 다시 올리면 기존 버전({staleNames})을 고치지 않고 새 버전 번호로
          추가됩니다 — 새 버전끼리 비교하세요
        </p>
      )}
      {evidence.level !== 'complete' && (
        <p className={s.notice} role="note">
          {UNVERIFIED_PREFIX}: {EVIDENCE_LABEL[evidence.level]} ({evidence.reason ?? '판정 정보가 없습니다'}) — 삭제 문장 {held}개(객체·컬럼·파티션 삭제와
          끊긴 객체의 문장)를 실행하지 않고 수동 확인으로 돌렸습니다
        </p>
      )}
      {data.baseModel.evidence?.level === 'incomplete' && (
        <p className={s.notice} role="note">
          BASE 가 불완전합니다 ({data.baseModel.evidence.reason}) — BASE 에 빠진 객체의 CREATE 가 실제 DB 에서 '이미 존재' 오류로 실패할 수 있습니다
        </p>
      )}
    </>
  );
}

// 변경 객체 목록의 한 항목. 화면은 버튼(객체 diff 탭으로), 리포트는 같은 파일 안의 링크로 감싼다
export interface SummaryItemProps {
  entry: ObjectEntry;
  className: string;
  children: ReactNode;
}

export type SummaryItemRenderer = (props: SummaryItemProps) => ReactNode;

function SummaryCells({ entry }: { entry: ObjectEntry }) {
  return (
    <>
      <Mark op={entry.op} />
      <span className={s.code}>{entry.oldName && entry.op === 'rename' ? `${entry.oldName} → ${entry.name}` : entry.name}</span>
      <span>{entry.kind}</span>
      <span>{entryDetail(entry)}</span>
    </>
  );
}

function SummaryList({ entries, renderItem }: { entries: ObjectEntry[]; renderItem: SummaryItemRenderer }) {
  if (entries.length === 0) return <p className={s.empty}>두 버전 사이에 변경 사항이 없습니다</p>;
  return (
    <div className={s.summary} role="group" aria-label="변경 객체">
      <div className={`${s.summaryRow} ${s.summaryHead}`} aria-hidden="true"><span /><span>객체</span><span>종류</span><span>세부 변경</span></div>
      {entries.map((e) => (
        <Fragment key={e.key}>{renderItem({ entry: e, className: s.summaryRow, children: <SummaryCells entry={e} /> })}</Fragment>
      ))}
    </div>
  );
}

// 요약: 통계·안내·변경 객체 목록. 화면 요약 탭과 HTML 리포트가 같은 계산과 문구를 쓴다
export function SummaryView({ data, renderItem }: { data: DiffResponse; renderItem: SummaryItemRenderer }) {
  return (
    <>
      <ul className={s.stats} aria-label="변경 통계">
        {summaryStats(data).map((st) => (
          <li key={st.label} className={s.stat}>
            <div className={`${s.statValue} ${st.tone}`}>{st.value}</div>
            <div className={s.statLabel}>{st.label}</div>
          </li>
        ))}
      </ul>
      <SummaryNotices data={data} />
      <SummaryList entries={changedObjects(data.diff)} renderItem={renderItem} />
    </>
  );
}
```

`apps/web/src/features/diff/SummaryTab.tsx` 를 아래 내용으로 바꾼다.

```tsx
import type { DiffResponse } from '../../api/types';
import type { ObjectKind } from '../../hooks/useSchemaContext';
import { SummaryView } from './SummaryView';

// 화면 요약 탭: 변경 객체 항목을 누르면 객체 diff 탭의 그 객체로 간다
export function SummaryTab({ data, onOpen }: { data: DiffResponse; onOpen: (kind: ObjectKind, name: string) => void }) {
  return (
    <SummaryView
      data={data}
      renderItem={({ entry, className, children }) => (
        <button type="button" className={className} onClick={() => onOpen(entry.kind, entry.name)}>{children}</button>
      )}
    />
  );
}
```

`apps/web/src/pages/SchemaPage.tsx`:
- import 추가: `import { RenameBanner } from '../features/diff/RenameBanner';` 바로 위에 `import { PARTIAL_MESSAGE } from '../features/diff/messages';` 를 넣는다.
- 상수 삭제: 파일 안의 `const PARTIAL_MESSAGE = 'MD 정의서가 포함된 비교입니다. 일부 속성(인덱스 종류·순서, 파티션, CHECK, 문자셋 등)은 비교되지 않았습니다.';` 줄과 그 뒤 빈 줄을 지운다.

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @tdm/web -- summary-view incomplete routines schema-page`
Expected: PASS. 새 테스트 2개와 기존 요약 탭·SchemaPage 테스트가 고치지 않은 채 모두 통과한다.

Run: `npm test -w @tdm/web && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/features/diff/messages.ts apps/web/src/features/diff/SummaryView.tsx apps/web/src/features/diff/SummaryTab.tsx apps/web/src/pages/SchemaPage.tsx apps/web/test/summary-view.test.tsx
git commit -m "refactor: 요약 탭을 표시용 SummaryView 로 분리" -m "통계·안내·변경 객체 목록의 계산과 문구를 SummaryView 로 옮겨 HTML 리포트와 함께 쓴다. 목록 항목은 renderItem 으로 그려 화면은 버튼, 리포트는 링크를 넘긴다. MD 부분 비교 안내 문구는 messages.ts 로 옮긴다."
```

---

## Task 2: 적용된 rename 표시용 컴포넌트 `AppliedRenames`

**Files:**
- Create: `apps/web/src/features/diff/AppliedRenames.tsx`
- Modify: `apps/web/src/features/diff/RenameBanner.tsx`
- Test: `apps/web/test/applied-renames.test.tsx` (신규). 기존 `schema-page.test.tsx` 의 rename 배너 테스트는 고치지 않고 통과해야 한다.

**Interfaces:**
- Consumes: `DiffResponse`, `SourcedRename` (`api/types`), `RenameMapping` (`@tdm/core`), `Banner`, `diff.module.css`
- Produces:
  - `export const describeRename: (r: RenameMapping) => string`
  - `export const sameRename: (a: RenameMapping, b: RenameMapping) => boolean`
  - `export const manualRenames: (renames: SourcedRename[]) => RenameMapping[]`
  - `export function AppliedRenames({ data, renderRelease, dmsOpen }: { data: DiffResponse; renderRelease?: (mapping: RenameMapping) => ReactNode; dmsOpen?: boolean }): JSX.Element`
  - `RenameBanner({ data })` 시그니처는 그대로다.

- [ ] **Step 1: 실패하는 테스트 작성** — `apps/web/test/applied-renames.test.tsx`

```tsx
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppliedRenames } from '../src/features/diff/AppliedRenames';

const MANUAL = { kind: 'column', table: 'orders', from: 'x', to: 'y', source: 'manual' };
const REVERSED = { kind: 'column', table: 'orders', from: 'a', to: 'b', source: 'manual', reversed: true };
const DMS = { kind: 'table', from: 'members', to: 'member', source: 'dms' };
const data = (renames: unknown[], ignoredRenames: unknown[] = []) => ({ diff: { ignoredRenames }, renames }) as never;
const dmsDetails = () => screen.getByRole('region', { name: 'DMS 매핑에서 적용된 이름 변경' }).querySelector('details');

describe('AppliedRenames', () => {
  it('해제 렌더러가 없으면 읽기 전용으로 출처와 함께 보이고, DMS 목록은 접혀 있다', () => {
    render(<AppliedRenames data={data([MANUAL, REVERSED, DMS])} />);
    const applied = screen.getByRole('region', { name: '적용된 이름 변경' });
    expect(applied).toHaveTextContent(/수동\s*orders\.x → y/);
    expect(applied).toHaveTextContent(/수동 · 역방향\s*orders\.a → b/);
    expect(within(applied).queryByRole('button')).not.toBeInTheDocument();
    expect(dmsDetails()).not.toHaveAttribute('open');
    expect(dmsDetails()).toHaveTextContent('이름 변경 1건');
  });

  it('dmsOpen 이면 DMS 목록을 펼치고, 해제 렌더러는 이 쌍에 저장된 수동 매핑에만 붙는다', () => {
    render(<AppliedRenames data={data([MANUAL, REVERSED, DMS])} dmsOpen renderRelease={(r) => <button type="button">해제 {r.from}</button>} />);
    expect(dmsDetails()).toHaveAttribute('open');
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['해제 x']);
  });

  it('적용하지 못한 rename 을 이유와 함께 보인다', () => {
    render(<AppliedRenames data={data([], [{ mapping: { kind: 'table', from: 'a', to: 'b' }, reason: 'BASE 에 a 가 없습니다' }])} />);
    expect(screen.getByRole('region', { name: '적용하지 못한 이름 변경' })).toHaveTextContent('a → b: BASE 에 a 가 없습니다');
    expect(screen.queryByRole('region', { name: '적용된 이름 변경' })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @tdm/web -- applied-renames`
Expected: FAIL — `Failed to resolve import "../src/features/diff/AppliedRenames" from "test/applied-renames.test.tsx"`

- [ ] **Step 3: 구현**

`apps/web/src/features/diff/AppliedRenames.tsx`. 수동·DMS·적용하지 못한 rename 배너의 마크업과 문구는 기존 `RenameBanner` 에서 그대로 옮긴다.

```tsx
import type { RenameMapping } from '@tdm/core';
import type { ReactNode } from 'react';
import type { DiffResponse, SourcedRename } from '../../api/types';
import { Banner } from '../../components/Banner';
import s from './diff.module.css';

export const describeRename = (r: RenameMapping) => (r.kind === 'table' ? `${r.from} → ${r.to}` : `${r.table}.${r.from} → ${r.to}`);
export const sameRename = (a: RenameMapping, b: RenameMapping) => a.kind === b.kind && a.table === b.table && a.from === b.from && a.to === b.to;
const isDms = (r: SourcedRename) => r.source === 'dms';

// 저장은 수동 매핑만 한다. DMS 에서 온 rename 은 전환 매핑을 바꿔야 달라지고, 함께 저장하면 수동 한도(500)를 넘는다
// 역쌍에서 뒤집어 온 매핑도 함께 저장한다 (이 쌍에 매핑이 생기면 역쌍 매핑은 더 쓰지 않으므로 빠뜨리면 사라진다)
export const manualRenames = (renames: SourcedRename[]): RenameMapping[] =>
  renames.filter((r) => !isDms(r)).map(({ source: _source, reversed: _reversed, ...r }) => r);

// 적용된 rename(수동·DMS)을 출처와 함께, 적용하지 못한 rename 을 이유와 함께 보여 준다. 화면 배너와 HTML 리포트가 함께 쓴다
// renderRelease: 이 쌍에 저장된 수동 매핑 옆에 둘 해제 버튼 (없으면 읽기 전용). dmsOpen: DMS 목록을 펼친 채로 둔다 (리포트)
export function AppliedRenames({ data, renderRelease, dmsOpen = false }: { data: DiffResponse; renderRelease?: (mapping: RenameMapping) => ReactNode; dmsOpen?: boolean }) {
  const manual = manualRenames(data.renames);
  const reversed = new Set(data.renames.filter((r) => r.reversed).map(describeRename));
  const dms = data.renames.filter(isDms);
  return (
    <>
      {manual.length > 0 && (
        <Banner tone="info" label="적용된 이름 변경">
          {manual.map((r) => {
            const isReversed = reversed.has(describeRename(r));
            return (
              <div key={describeRename(r)} className={s.renameRow}>
                <span className={s.source}>{isReversed ? '수동 · 역방향' : '수동'}</span>
                <span>{describeRename(r)}</span>
                {/* 역방향 매핑은 역쌍(target → base) 비교에 저장되어 있어 거기서 해제한다 */}
                {isReversed ? <span>(반대 방향 비교에 저장된 매핑을 뒤집어 적용 — 해제는 그 비교에서)</span> : renderRelease?.(r)}
              </div>
            );
          })}
        </Banner>
      )}
      {dms.length > 0 && (
        <Banner tone="info" label="DMS 매핑에서 적용된 이름 변경">
          <details open={dmsOpen}>
            <summary><span className={s.source}>DMS</span> 전환 매핑에서 이름 변경 {dms.length}건을 적용했습니다 (전환 탭에서 확인, 같은 대상에 수동 매핑을 넣으면 수동이 우선)</summary>
            {dms.map((r) => <div key={describeRename(r)} className={s.renameRow}><span>{describeRename(r)}</span></div>)}
          </details>
        </Banner>
      )}
      {data.diff.ignoredRenames.length > 0 && (
        <Banner tone="warn" label="적용하지 못한 이름 변경">
          {data.diff.ignoredRenames.map((i) => <div key={describeRename(i.mapping)}>{describeRename(i.mapping)}: {i.reason}</div>)}
        </Banner>
      )}
    </>
  );
}
```

`apps/web/src/features/diff/RenameBanner.tsx` 를 아래 내용으로 바꾼다. 후보 배너와 저장 오류는 그대로 둔다.

```tsx
import type { RenameMapping } from '@tdm/core';
import { useMe, useSaveRenames } from '../../api/hooks';
import type { DiffResponse } from '../../api/types';
import { Banner } from '../../components/Banner';
import { canEdit } from '../../lib/roles';
import { AppliedRenames, describeRename, manualRenames, sameRename } from './AppliedRenames';
import s from './diff.module.css';

// rename 후보를 보여 주고, 사용자가 확정하면 (base, target) 쌍에 수동 매핑을 저장한다. 적용된 rename 은 출처(수동/DMS)를 함께 보여 준다
// 저장·해제는 admin·dba 만 한다. viewer 에게는 읽기 전용으로 보여 준다
export function RenameBanner({ data }: { data: DiffResponse }) {
  const me = useMe();
  const isEditor = canEdit(me.data);
  const save = useSaveRenames();
  const manual = manualRenames(data.renames);
  const apply = (renames: RenameMapping[]) => save.mutate({ base: data.base.id, target: data.target.id, renames });
  const candidates = data.diff.renameCandidates.filter((c) => !data.renames.some((r) => sameRename(r, c)));
  const release = (r: RenameMapping) => (
    <button type="button" className={s.linkBtn} disabled={save.isPending} onClick={() => apply(manual.filter((x) => !sameRename(x, r)))}>해제</button>
  );
  return (
    <>
      {candidates.length > 0 && (
        <Banner tone="info" label="이름 변경 후보">
          {candidates.map((c) => (
            <div key={describeRename(c)} className={s.renameRow}>
              <span><code>{c.kind === 'table' ? c.from : `${c.table}.${c.from}`}</code> 삭제 + <code>{c.to}</code> 추가 → 이름 변경일 수 있습니다</span>
              {isEditor && <button type="button" className={s.linkBtn} disabled={save.isPending} onClick={() => apply([...manual, c])}>이름 변경으로 처리</button>}
            </div>
          ))}
          {!isEditor && <div className={s.renameRow}>읽기 전용: 이름 변경은 DBA·관리자가 처리할 수 있습니다</div>}
        </Banner>
      )}
      <AppliedRenames data={data} renderRelease={isEditor ? release : undefined} />
      {save.error && <Banner tone="warn" role="alert">{save.error.message}</Banner>}
    </>
  );
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @tdm/web -- applied-renames schema-page`
Expected: PASS. 새 테스트 3개와 기존 rename 배너 테스트(후보 처리, viewer 읽기 전용, 출처·해제, 역방향)가 모두 통과한다.

Run: `npm test -w @tdm/web && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/features/diff/AppliedRenames.tsx apps/web/src/features/diff/RenameBanner.tsx apps/web/test/applied-renames.test.tsx
git commit -m "refactor: 적용된 rename 배너를 AppliedRenames 로 분리" -m "적용된 rename(수동·역방향·DMS)과 적용하지 못한 rename 배너를 표시용 컴포넌트로 뽑아 HTML 리포트와 함께 쓴다. 해제 버튼은 renderRelease 로 넘겨 화면만 붙이고, 리포트는 dmsOpen 으로 DMS 목록을 펼친다."
```

---

## Task 3: 객체 본문 컴포넌트 `ObjectBody`

**Files:**
- Create: `apps/web/src/features/diff/ObjectBody.tsx`
- Modify: `apps/web/src/features/diff/ObjectCard.tsx`
- Test: `apps/web/test/object-body.test.tsx` (신규). 기존 `diff-tab.test.tsx`·`routines.test.tsx` 의 카드 테스트는 고치지 않고 통과해야 한다.

**Interfaces:**
- Consumes:
  - `GridDiff({ entry })`, `RoutineGrid({ entry })`
  - `SqlDiff({ base, target, layout, expanded, rows })`
  - `SplitRow` (`lib/hunks`), `isRoutineKind`, `ObjectEntry` (`lib/object-diff`)
- Produces: `export function ObjectBody({ entry, mode, layout, rows, expanded }: { entry: ObjectEntry; mode: 'sql' | 'grid'; layout: 'split' | 'unified'; rows?: SplitRow[]; expanded: boolean }): JSX.Element`

- [ ] **Step 1: 실패하는 테스트 작성** — `apps/web/test/object-body.test.tsx`

```tsx
import { diffSchemas, parseSqlDump } from '@tdm/core';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ObjectBody } from '../src/features/diff/ObjectBody';
import { changedObjects } from '../src/lib/object-diff';

// td-export 0.1.52 형식의 루틴 구간
const routine = (ddl: string) =>
  `SET @OLD_ROUTINE_SQL_MODE = @@SQL_MODE, SQL_MODE = 'STRICT_TRANS_TABLES';\nDELIMITER ;;\n${ddl};;\nDELIMITER ;\nSET SQL_MODE = @OLD_ROUTINE_SQL_MODE;\n`;
const TAX = (rate: string) => routine(`CREATE DEFINER=\`root\`@\`%\` FUNCTION \`tax\`(a int) RETURNS int\n    DETERMINISTIC\nRETURN a * ${rate}`);
// 20줄 테이블의 가운데 한 줄만 바뀌어 앞뒤에 접히는 동일 구간이 생긴다
const columns = (change?: number) => Array.from({ length: 20 }, (_, i) => `  \`c${i}\` int${i === change ? ' NOT NULL' : ''},`).join('\n');
const table = (change?: number) => `CREATE TABLE \`orders\` (\n${columns(change)}\n  \`id\` int\n);\n`;
const diff = diffSchemas(parseSqlDump(table() + TAX('1')).model, parseSqlDump(table(10) + TAX('2')).model);
const [orders, tax] = changedObjects(diff);
const cols = (container: HTMLElement) => container.querySelectorAll('table[aria-label="SQL diff"] col').length;

describe('ObjectBody', () => {
  it('SQL 보기: 동일 구간을 접고, Split 은 6열이다', () => {
    const { container } = render(<ObjectBody entry={orders} mode="sql" layout="split" expanded={false} />);
    expect(screen.getAllByRole('button', { name: /줄 동일 · 펼치기/ }).length).toBeGreaterThan(0);
    expect(cols(container)).toBe(6);
  });

  it('expanded 면 동일 구간을 모두 펼친다 (Unified 4열)', () => {
    const { container } = render(<ObjectBody entry={orders} mode="sql" layout="unified" expanded />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'SQL diff' })).getAllByText(/`c0` int/).length).toBeGreaterThan(0);
    expect(cols(container)).toBe(4);
  });

  it('표 보기: 테이블은 컬럼 표, 루틴은 루틴 표', () => {
    render(<ObjectBody entry={orders} mode="grid" layout="split" expanded />);
    expect(screen.getByRole('table', { name: 'Columns' })).toBeInTheDocument();
    render(<ObjectBody entry={tax} mode="grid" layout="split" expanded />);
    expect(screen.getByRole('table', { name: '루틴 정의' })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'SQL diff' })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @tdm/web -- object-body`
Expected: FAIL — `Failed to resolve import "../src/features/diff/ObjectBody" from "test/object-body.test.tsx"`

- [ ] **Step 3: 구현**

`apps/web/src/features/diff/ObjectBody.tsx`:

```tsx
import type { SplitRow } from '../../lib/hunks';
import { isRoutineKind, type ObjectEntry } from '../../lib/object-diff';
import { GridDiff } from './GridDiff';
import { RoutineGrid } from './RoutineGrid';
import { SqlDiff } from './SqlDiff';

// 객체 본문: 표 보기면 테이블은 표, 루틴은 루틴 표, 그 밖(뷰·SQL 보기)은 SQL diff. 화면 카드와 HTML 리포트가 함께 쓴다
// rows: 카드가 이미 계산한 줄 (없으면 SqlDiff 가 계산한다). expanded: 동일 구간을 접지 않는다
export function ObjectBody({ entry, mode, layout, rows, expanded }: {
  entry: ObjectEntry; mode: 'sql' | 'grid'; layout: 'split' | 'unified'; rows?: SplitRow[]; expanded: boolean;
}) {
  if (mode === 'grid' && entry.kind === 'table') return <GridDiff entry={entry} />;
  if (mode === 'grid' && isRoutineKind(entry.kind)) return <RoutineGrid entry={entry} />;
  return <SqlDiff rows={rows} base={entry.baseText} target={entry.targetText} layout={entry.op === 'same' ? 'unified' : layout} expanded={expanded} />;
}
```

`apps/web/src/features/diff/ObjectCard.tsx` — import 블록에서 아래 부분을

```tsx
import { isRoutineKind, objectAnchor, type ObjectEntry } from '../../lib/object-diff';
import { GridDiff } from './GridDiff';
import { RoutineGrid } from './RoutineGrid';
import s from './ObjectCard.module.css';
import { SqlDiff } from './SqlDiff';
```

다음으로 바꾼다.

```tsx
import { objectAnchor, type ObjectEntry } from '../../lib/object-diff';
import { ObjectBody } from './ObjectBody';
import s from './ObjectCard.module.css';
```

본문 렌더 부분은

```tsx
      {open && (mode === 'grid' && entry.kind === 'table' ? <GridDiff entry={entry} />
        : mode === 'grid' && isRoutineKind(entry.kind) ? <RoutineGrid entry={entry} />
        : <SqlDiff key={resetKey} rows={rows} base={entry.baseText} target={entry.targetText} layout={entry.op === 'same' ? 'unified' : layout} expanded={entry.op === 'same'} />)}
```

다음으로 바꾼다. `key={resetKey}` 는 지금처럼 비교가 바뀌면 펼친 접기 상태를 초기화한다.

```tsx
      {open && <ObjectBody key={resetKey} entry={entry} mode={mode} layout={layout} rows={rows} expanded={entry.op === 'same'} />}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @tdm/web -- object-body diff-tab routines`
Expected: PASS. 새 테스트 3개와 기존 카드·보기 방식 테스트가 모두 통과한다.

Run: `npm test -w @tdm/web && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/features/diff/ObjectBody.tsx apps/web/src/features/diff/ObjectCard.tsx apps/web/test/object-body.test.tsx
git commit -m "refactor: 객체 카드 본문을 ObjectBody 로 분리" -m "보기 방식에 따라 표·루틴 표·SQL diff 를 고르는 본문을 ObjectBody 로 뽑아 HTML 리포트와 함께 쓴다. expanded 로 동일 구간을 모두 펼칠 수 있다."
```

---

## Task 4: 리포트 문서 `buildReportHtml`

**Files:**
- Create (`apps/web/src/features/report/`):
  - `report-meta.ts`, `ReportObject.tsx`, `ReportDocument.tsx`
  - `styles.ts`, `report.css`, `build-report.tsx`
- Test: `apps/web/test/report.test.tsx` (신규)

**Interfaces:**
- Consumes:
  - Task 1–3 결과
    - `SummaryView`, `SummaryItemRenderer`, `PARTIAL_MESSAGE`
    - `AppliedRenames({ data, dmsOpen })`
    - `ObjectBody({ entry, mode, layout, rows, expanded })`
  - 기존 코드
    - `changedObjects`, `objectAnchor(kind, name): string` (`lib/object-diff`)
    - `buildRows(base, target): SplitRow[]`, `countChanges(rows): { added: number; removed: number }` (`lib/hunks`)
    - `formatDateTime(iso: string): string` (`lib/format`)
    - `APP_NAME` (`meta`), `Banner`, `Mark`, `Icon`, `ObjectCard.module.css`
- Produces:
  - `report-meta.ts`
    - `export interface ReportOptions { mode: 'sql' | 'grid'; layout: 'split' | 'unified'; generatedAt: Date; generatedBy: string; appVersion: string }`
    - `export const reportTitle: (data: DiffResponse) => string`
    - `export function viewLabel(mode: ReportOptions['mode'], layout: ReportOptions['layout']): string`
    - `export function reportFileName(data: DiffResponse, at: Date): string`
    - `export function formatGeneratedAt(at: Date): string`
  - 컴포넌트
    - `export function ReportObject({ entry, mode, layout }: { entry: ObjectEntry; mode: 'sql' | 'grid'; layout: 'split' | 'unified' }): JSX.Element`
    - `export function ReportDocument({ data, options }: { data: DiffResponse; options: ReportOptions }): JSX.Element`
  - `export const REPORT_CSS: string` (`styles.ts`)
  - `build-report.tsx`
    - `export const REPORT_CSP: string`
    - `export function buildReportHtml(data: DiffResponse, opts: ReportOptions): string`
    - `export { reportFileName }`

- [ ] **Step 1: 실패하는 테스트 작성** — `apps/web/test/report.test.tsx` (설계 §8 의 단위 테스트 전부)

```tsx
import { diffSchemas, parseMdDump, parseSqlDump, type SchemaModel } from '@tdm/core';
import { describe, expect, it } from 'vitest';
import type { DiffResponse, VersionMeta } from '../src/api/types';
import { PARTIAL_MESSAGE } from '../src/features/diff/messages';
import { buildReportHtml, REPORT_CSP } from '../src/features/report/build-report';
import { formatGeneratedAt, reportFileName, reportTitle, viewLabel, type ReportOptions } from '../src/features/report/report-meta';

// td-export 0.1.52 형식의 루틴 구간
const routine = (ddl: string) =>
  `SET @OLD_ROUTINE_SQL_MODE = @@SQL_MODE, SQL_MODE = 'STRICT_TRANS_TABLES';\nDELIMITER ;;\n${ddl};;\nDELIMITER ;\nSET SQL_MODE = @OLD_ROUTINE_SQL_MODE;\n`;
const TAX = (rate: string) => routine(`CREATE DEFINER=\`root\`@\`%\` FUNCTION \`tax\`(a int) RETURNS int\n    DETERMINISTIC\nRETURN a * ${rate}`);
// 이스케이프 확인용: 객체 이름과 COMMENT 에 <script>·"·& 를 넣는다
const EVIL_TABLE = '<script>x"&';
const EVIL_COMMENT = 'a "q" & <script>alert(1)</script>';
const base = parseSqlDump('CREATE TABLE `orders` (\n  `x` int\n);\n' + TAX('1')).model;
const target = parseSqlDump(`CREATE TABLE \`orders\` (\n  \`x\` bigint COMMENT '${EVIL_COMMENT}'\n);\nCREATE TABLE \`${EVIL_TABLE}\` (\n  \`y\` int\n);\n${TAX('2')}`).model;
const MD = 'shop\n=====\n\n## Table List\n- [orders ()](#orders)\n\n## orders\n**Information**\n|Table type|Engine|Row format|Collate|Comment|\n|---|---|---|---|---|\n|BASE TABLE|InnoDB|Dynamic|utf8mb4_0900_ai_ci||\n\n**Columns**\n|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|\n|---|---|---|---|---|---|---|---|---|\n|x|bigint|YES|NULL||||||\n';
// 20줄 테이블의 가운데 한 줄만 바뀌어 화면이라면 접히는 동일 구간이 생긴다
const columns = (change?: number) => Array.from({ length: 20 }, (_, i) => `  \`c${i}\` int${i === change ? ' NOT NULL' : ''},`).join('\n');
const longTable = (change?: number) => parseSqlDump(`CREATE TABLE \`wide\` (\n${columns(change)}\n  \`id\` int\n);\n`).model;

const meta = (id: number, versionNo: number): VersionMeta => ({
  id, schemaId: 7, databaseId: 1, databaseName: 'prod-db', schemaName: 'shop', versionNo, sourceFormat: 'sql',
  sourceFilename: `shop_v${versionNo}.sql`, note: null, uploadedBy: 'kim', uploadedAt: '2026-10-15T01:02:00.000Z',
});
const response = (b: SchemaModel, t: SchemaModel, extra: Partial<DiffResponse> = {}): DiffResponse => ({
  base: meta(11, 1), target: meta(12, 2), baseModel: b, targetModel: t, diff: diffSchemas(b, t), statements: [], ddl: '', renames: [], ...extra,
});
const DATA = response(base, target);
const OPTIONS: ReportOptions = { mode: 'sql', layout: 'split', generatedAt: new Date(2026, 9, 16, 14, 5), generatedBy: 'park', appVersion: '9.9.9-test' };
const render = (data: DiffResponse, opts: Partial<ReportOptions> = {}) => buildReportHtml(data, { ...OPTIONS, ...opts });
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const objectOf = (doc: Document, label: string) => [...doc.querySelectorAll('details')].find((d) => d.getAttribute('aria-label') === label);
const colCount = (el: Element | undefined) => el?.querySelectorAll('table[aria-label="SQL diff"] col').length;

describe('리포트 메타', () => {
  it('파일 이름: {DB}_{스키마}_v{BASE}-v{TARGET}_{YYYYMMDD-HHmm}.html, 쓸 수 없는 글자는 _', () => {
    const data = { ...DATA, target: { ...DATA.target, databaseName: 'db/1:2', schemaName: 'a*b?"<>|\\c\u0001d', versionNo: 10 }, base: { ...DATA.base, versionNo: 3 } };
    expect(reportFileName(data, new Date(2026, 0, 5, 9, 7))).toBe('db_1_2_a_b______c_d_v3-v10_20260105-0907.html');
    expect(reportFileName(DATA, OPTIONS.generatedAt)).toBe('prod-db_shop_v1-v2_20261016-1405.html');
  });

  it('제목·보기 방식·만든 시각', () => {
    expect(reportTitle(DATA)).toBe('prod-db › shop 비교 리포트');
    expect([viewLabel('sql', 'split'), viewLabel('sql', 'unified'), viewLabel('grid', 'split')]).toEqual(['SQL Split', 'SQL Unified', '표']);
    expect(formatGeneratedAt(OPTIONS.generatedAt)).toMatch(/^2026-10-16 14:05 \(.+, UTC[+-]\d{2}:\d{2}\)$/);
  });
});

describe('buildReportHtml', () => {
  it('문서 머리: doctype·lang·밝은 테마·charset·viewport·CSP meta 와 style 이 있고 script·버튼이 없다', () => {
    const html = render(DATA);
    expect(html.startsWith('<!doctype html>\n<html lang="ko" data-theme="light">\n<head><meta charset="utf-8">')).toBe(true);
    expect(REPORT_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    expect(html).toContain(`<meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`);
    expect(html).toContain('<style>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('<button');
    expect(parse(html).title).toBe('prod-db › shop 비교 리포트');
  });

  it('머리말: DB·스키마·버전·원본 파일·올린 사람·만든 사람·만든 시각·보기 방식·도구 버전', () => {
    const doc = parse(render(DATA));
    expect(doc.querySelector('h1')?.textContent).toBe('prod-db › shop 비교 리포트');
    const header = doc.querySelector('header.report-header')?.textContent ?? '';
    for (const text of ['BASE', 'v1 · shop_v1.sql · kim', 'TARGET', 'v2 · shop_v2.sql · kim', 'SQL Split', formatGeneratedAt(OPTIONS.generatedAt), 'park', '9.9.9-test']) {
      expect(header).toContain(text);
    }
  });

  it('요약 목록 링크의 href 가 객체 섹션 id 와 같고, 객체는 모두 펼친 <details open> 이다', () => {
    const doc = parse(render(DATA));
    const hrefs = [...doc.querySelectorAll('[aria-label="변경 객체"] a')].map((a) => a.getAttribute('href'));
    const sections = [...doc.querySelectorAll('section[aria-label="객체 diff"] details')];
    expect(hrefs).toHaveLength(3);
    expect(hrefs).toEqual(sections.map((d) => `#${d.id}`));
    expect(sections.every((d) => d.hasAttribute('open'))).toBe(true);
    expect(doc.querySelector('[aria-label="변경 통계"]')?.textContent).toContain('TARGET 완전성');
  });

  it('보기 방식별 본문: SQL Split 6열, SQL Unified 4열, 표는 컬럼 표와 루틴 표', () => {
    expect(colCount(objectOf(parse(render(DATA)), 'table orders'))).toBe(6);
    expect(colCount(objectOf(parse(render(DATA, { layout: 'unified' })), 'table orders'))).toBe(4);
    const grid = parse(render(DATA, { mode: 'grid' }));
    expect(objectOf(grid, 'table orders')?.querySelector('table[aria-label="Columns"]')).not.toBeNull();
    expect(objectOf(grid, 'table orders')?.querySelector('table[aria-label="SQL diff"]')).toBeNull();
    expect(objectOf(grid, 'function tax')?.querySelector('table[aria-label="루틴 정의"]')).not.toBeNull();
    expect(grid.querySelector('header.report-header')?.textContent).toContain('표');
  });

  it('화면이라면 접히는 동일 구간도 모두 펼쳐 넣는다', () => {
    const html = render(response(longTable(), longTable(10)));
    expect(html).not.toContain('펼치기');
    expect(objectOf(parse(html), 'table wide')?.textContent).toContain('`c0` int');
  });

  it('객체 이름·COMMENT 의 <script>·"·& 는 텍스트로 이스케이프된다', () => {
    const html = render(DATA);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('aria-label="table &lt;script&gt;x&quot;&amp;"');
    const doc = parse(html);
    expect(objectOf(doc, `table ${EVIL_TABLE}`)?.querySelector('summary')?.textContent).toContain(EVIL_TABLE);
    expect(objectOf(doc, 'table orders')?.textContent).toContain(EVIL_COMMENT);
    expect(objectOf(parse(render(DATA, { mode: 'grid' })), 'table orders')?.textContent).toContain(EVIL_COMMENT);
  });

  it('변경 없는 비교: 안내 문구만 있고 객체 diff 구역이 없다', () => {
    const doc = parse(render(response(base, base)));
    expect(doc.body.textContent).toContain('두 버전 사이에 변경 사항이 없습니다');
    expect(doc.querySelector('details')).toBeNull();
    expect(doc.querySelector('section[aria-label="객체 diff"]')).toBeNull();
  });

  it('MD 부분 비교 안내와 루틴 미비교 안내를 화면과 같은 문구로 넣는다', () => {
    const doc = parse(render(response(base, parseMdDump(MD).model)));
    expect(doc.body.textContent).toContain(PARTIAL_MESSAGE);
    expect(doc.body.textContent).toContain('MD 출처라 루틴은 비교하지 않음');
  });

  it('적용된 rename 을 출처와 함께 읽기 전용으로 넣고, DMS 목록은 펼친다', () => {
    const renames = [{ kind: 'column', table: 'orders', from: 'x', to: 'y', source: 'manual' }, { kind: 'table', from: 'a', to: 'b', source: 'dms' }] as DiffResponse['renames'];
    const doc = parse(render({ ...DATA, renames }));
    expect(doc.querySelector('section[aria-label="적용된 이름 변경"]')?.textContent).toMatch(/수동\s*orders\.x → y/);
    expect(doc.querySelector('section[aria-label="DMS 매핑에서 적용된 이름 변경"] details')?.hasAttribute('open')).toBe(true);
    expect(doc.querySelector('button')).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @tdm/web -- report.test`
Expected: FAIL — `Failed to resolve import "../src/features/report/build-report" from "test/report.test.tsx"`

- [ ] **Step 3: 구현**

`apps/web/src/features/report/report-meta.ts`:

```ts
import type { DiffResponse } from '../../api/types';

// 리포트를 만드는 데 쓰는 화면 밖 정보 (설계 §4)
export interface ReportOptions {
  mode: 'sql' | 'grid';
  layout: 'split' | 'unified';
  generatedAt: Date;
  generatedBy: string;
  appVersion: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
// 파일 이름에 쓸 수 없는 글자: / \ : * ? " < > | 와 제어 문자 (설계 §5)
const UNSAFE_FILE_CHARS = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;
const safePart = (value: string) => value.replace(UNSAFE_FILE_CHARS, '_');
const localDate = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
const localTime = (at: Date) => `${pad(at.getHours())}:${pad(at.getMinutes())}`;

export const reportTitle = (data: DiffResponse): string => `${data.target.databaseName} › ${data.target.schemaName} 비교 리포트`;

export function viewLabel(mode: ReportOptions['mode'], layout: ReportOptions['layout']): string {
  if (mode === 'grid') return '표';
  return layout === 'split' ? 'SQL Split' : 'SQL Unified';
}

// {DB}_{스키마}_v{BASE}-v{TARGET}_{YYYYMMDD-HHmm}.html (로컬 시간)
export function reportFileName(data: DiffResponse, at: Date): string {
  const stamp = `${localDate(at).replaceAll('-', '')}-${localTime(at).replace(':', '')}`;
  return `${safePart(data.target.databaseName)}_${safePart(data.target.schemaName)}_v${data.base.versionNo}-v${data.target.versionNo}_${stamp}.html`;
}

// 만든 시각: 로컬 시간과 시간대 — 예: 2026-10-16 14:05 (Asia/Seoul, UTC+09:00)
export function formatGeneratedAt(at: Date): string {
  const offset = -at.getTimezoneOffset();
  const abs = Math.abs(offset);
  const utc = `UTC${offset >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${localDate(at)} ${localTime(at)} (${zone}, ${utc})`;
}
```

`apps/web/src/features/report/ReportObject.tsx`. 화면 카드의 `.card`·`.head`·`.path`·`.numAdd`·`.numDel` 클래스를 그대로 쓴다.

```tsx
import { Icon } from '../../components/Icon';
import { Mark } from '../../components/Mark';
import { buildRows, countChanges } from '../../lib/hunks';
import { objectAnchor, type ObjectEntry } from '../../lib/object-diff';
import { ObjectBody } from '../diff/ObjectBody';
import card from '../diff/ObjectCard.module.css';

// 리포트의 객체 하나: JS 없이 접고 펼 수 있게 <details open> 으로 감싸고, 동일 구간은 모두 펼친다 (설계 §3.4)
export function ReportObject({ entry, mode, layout }: { entry: ObjectEntry; mode: 'sql' | 'grid'; layout: 'split' | 'unified' }) {
  const rows = buildRows(entry.baseText, entry.targetText);
  const counts = countChanges(rows);
  const name = entry.oldName && entry.op === 'rename' ? `${entry.oldName} → ${entry.name}` : entry.name;
  return (
    <details open className={`${card.card} report-object`} id={objectAnchor(entry.kind, entry.name)} aria-label={`${entry.kind} ${entry.name}`}>
      <summary className={card.head}>
        <Mark op={entry.op} />
        <Icon name={entry.kind} />
        <span className="report-kind">{entry.kind}</span>
        <span className={`${card.path} ${entry.op === 'drop' ? 'struck' : ''}`}>{name}</span>
        <span className={card.numAdd}>+{counts.added}</span>
        <span className={card.numDel}>−{counts.removed}</span>
      </summary>
      <ObjectBody entry={entry} mode={mode} layout={layout} rows={rows} expanded />
    </details>
  );
}
```

`apps/web/src/features/report/ReportDocument.tsx`:

```tsx
import type { DiffResponse, VersionMeta } from '../../api/types';
import { Banner } from '../../components/Banner';
import { formatDateTime } from '../../lib/format';
import { changedObjects, objectAnchor } from '../../lib/object-diff';
import { APP_NAME } from '../../meta';
import { AppliedRenames } from '../diff/AppliedRenames';
import { PARTIAL_MESSAGE } from '../diff/messages';
import { SummaryView, type SummaryItemRenderer } from '../diff/SummaryView';
import { ReportObject } from './ReportObject';
import { formatGeneratedAt, reportTitle, viewLabel, type ReportOptions } from './report-meta';

const versionLine = (v: VersionMeta) => `v${v.versionNo} · ${v.sourceFilename} · ${v.uploadedBy} · ${formatDateTime(v.uploadedAt)}`;

// 요약 목록 항목은 같은 파일 안의 객체 diff 로 가는 링크다
const linkItem: SummaryItemRenderer = ({ entry, className, children }) => (
  <a href={`#${objectAnchor(entry.kind, entry.name)}`} className={`${className} report-link`}>{children}</a>
);

function ReportHeader({ data, options }: { data: DiffResponse; options: ReportOptions }) {
  const rows: [string, string][] = [
    ['BASE', versionLine(data.base)],
    ['TARGET', versionLine(data.target)],
    ['보기 방식', viewLabel(options.mode, options.layout)],
    ['만든 시각', formatGeneratedAt(options.generatedAt)],
    ['만든 사람', options.generatedBy],
    ['도구 버전', `${APP_NAME} ${options.appVersion}`],
  ];
  return (
    <header className="report-header">
      <h1>{reportTitle(data)}</h1>
      <dl className="report-meta">
        {rows.map(([term, value]) => (
          <div key={term}><dt>{term}</dt><dd>{value}</dd></div>
        ))}
      </dl>
    </header>
  );
}

// 리포트 본문: 머리말 → 화면 안내 → 요약 → 객체 diff (설계 §3). 화면 조작 요소(탭·복사·이력 링크)는 넣지 않는다
export function ReportDocument({ data, options }: { data: DiffResponse; options: ReportOptions }) {
  const entries = changedObjects(data.diff);
  return (
    <main className="report">
      <ReportHeader data={data} options={options} />
      {data.diff.partial && <Banner tone="warn">{PARTIAL_MESSAGE}</Banner>}
      <AppliedRenames data={data} dmsOpen />
      <h2 className="report-section-title">요약</h2>
      <SummaryView data={data} renderItem={linkItem} />
      {entries.length > 0 && (
        <section aria-label="객체 diff">
          <h2 className="report-section-title">객체 diff</h2>
          {entries.map((e) => <ReportObject key={e.key} entry={e} mode={options.mode} layout={options.layout} />)}
        </section>
      )}
    </main>
  );
}
```

`apps/web/src/features/report/report.css`. 화면의 `global.css` 대신 리포트에 필요한 기본 규칙만 둔다. 클래스 이름은 CSS 모듈이 아니므로 그대로 남는다.

```css
/* HTML 리포트 전용 스타일. ?inline 으로만 읽어 리포트 파일에 넣는다 (화면에는 붙지 않는다) */
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: var(--text)/1.5 var(--sans); -webkit-font-smoothing: antialiased; }
code { font-family: var(--mono); }
a { color: var(--accent); }
/* 화면에서는 Sidebar.module.css 의 전역 클래스다 */
.struck { text-decoration: line-through; text-decoration-color: var(--del); }

.report { max-width: 1440px; margin: 0 auto; padding: var(--space-4) 0 var(--space-6); }
.report-header { margin: 0 var(--space-4) var(--space-3); padding-bottom: var(--space-3); border-bottom: 1px solid var(--border); }
.report-header h1 { margin: 0 0 var(--space-2); font-size: 18px; font-weight: 600; }
.report-meta { display: grid; grid-template-columns: max-content 1fr; gap: 2px var(--space-3); margin: 0; font-size: var(--text-sm); }
.report-meta > div { display: contents; }
.report-meta dt { color: var(--fg-muted); }
.report-meta dd { margin: 0; overflow-wrap: anywhere; }
.report-section-title { margin: var(--space-6) var(--space-4) var(--space-2); font-size: 14px; font-weight: 600; break-after: avoid; }

/* 요약 목록 항목: 화면의 버튼 행과 같은 모양의 링크 */
a.report-link { color: inherit; text-decoration: none; }
a.report-link:hover { background: var(--muted); }

/* 객체: <details open> 머리에 접기 표지를 직접 그린다 */
.report-object > summary { cursor: pointer; list-style: none; }
.report-object > summary::-webkit-details-marker { display: none; }
.report-object > summary::before { content: '▾'; color: var(--fg-dim); }
.report-object:not([open]) > summary::before { content: '▸'; }
.report-object:not([open]) > summary { border-bottom: 0; }
.report-kind { color: var(--fg-muted); font-size: var(--text-xs); }

@media print {
  body { background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .report { max-width: none; padding: 0; }
  /* 객체 머리가 페이지 끝에 홀로 남지 않게 한다 */
  .report-object > summary { break-after: avoid; }
  tr { break-inside: avoid; }
}
```

`apps/web/src/features/report/styles.ts`. 리포트가 렌더하는 컴포넌트의 CSS 모듈을 빠짐없이 넣는다(Banner·Mark·diff·ObjectCard·SqlDiff·GridDiff. GridDiff 의 CSS 는 RoutineGrid 도 쓴다). `Icon` 은 CSS 가 없다.

```ts
// 리포트 <style> 에 넣을 CSS: 밝은 테마 토큰 + 재사용 컴포넌트의 CSS 모듈 원문 + 리포트 전용 스타일 (설계 §4)
// ?inline 은 같은 빌드에서 화면 import 와 같은 클래스 이름으로 바꾼 CSS 를 문자열로 준다 (Vite 8.3.3 프로덕션 빌드로 확인).
// vitest 는 CSS 를 처리하지 않아(css.include 기본값 []) 테스트에서는 모두 빈 문자열이다 — 스타일은 프로덕션 빌드에서 확인한다
import bannerCss from '../../components/Banner.module.css?inline';
import markCss from '../../components/Mark.module.css?inline';
import tokensCss from '../../styles/tokens.css?inline';
import diffCss from '../diff/diff.module.css?inline';
import gridCss from '../diff/GridDiff.module.css?inline';
import cardCss from '../diff/ObjectCard.module.css?inline';
import sqlCss from '../diff/SqlDiff.module.css?inline';
import reportCss from './report.css?inline';

export const REPORT_CSS = [tokensCss, bannerCss, markCss, diffCss, cardCss, sqlCss, gridCss, reportCss].join('\n');
```

`apps/web/src/features/report/build-report.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import type { DiffResponse } from '../../api/types';
import { ReportDocument } from './ReportDocument';
import { reportTitle, type ReportOptions } from './report-meta';
import { REPORT_CSS } from './styles';

export { reportFileName } from './report-meta';

// 파일이 외부 자원을 읽거나 스크립트를 실행하지 못하게 한다 (설계 §5)
export const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
// React 는 charset 을 charSet 으로, 작은따옴표를 &#x27; 로 쓰므로 고정된 문서 머리는 문자열로 쓴다. 값이 들어가는 제목·본문만 React 로 렌더해 이스케이프한다
const HEAD_META = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`;

// 순수 함수: 불러온 비교 결과로 스크립트 없는 HTML 문서 하나를 만든다
export function buildReportHtml(data: DiffResponse, opts: ReportOptions): string {
  const title = renderToStaticMarkup(<title>{reportTitle(data)}</title>);
  const body = renderToStaticMarkup(<ReportDocument data={data} options={opts} />);
  return `<!doctype html>\n<html lang="ko" data-theme="light">\n<head>${HEAD_META}${title}<style>${REPORT_CSS}</style></head>\n<body>${body}</body>\n</html>\n`;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @tdm/web -- report.test`
Expected: PASS (11 tests)

Run: `npm test -w @tdm/web && npm run typecheck`
Expected: PASS. `?inline` 타입은 `tsconfig` 의 `vite/client` 에 있는 `declare module '*?inline'` 이 준다.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/features/report/report-meta.ts apps/web/src/features/report/ReportObject.tsx apps/web/src/features/report/ReportDocument.tsx apps/web/src/features/report/styles.ts apps/web/src/features/report/report.css apps/web/src/features/report/build-report.tsx apps/web/test/report.test.tsx
git commit -m "feat: 비교 결과 HTML 리포트 문서 생성" -m "buildReportHtml 이 renderToStaticMarkup 으로 머리말·화면 안내·요약·객체 diff 를 렌더하고, CSP meta 와 <style> 을 넣은 스크립트 없는 문서로 감싼다. 객체는 <details open> 으로 감싸고 동일 구간은 모두 펼친다. CSS 는 토큰과 재사용 컴포넌트의 CSS 모듈을 ?inline 으로 이어 붙이고 report.css 를 더한다."
```

---

## Task 5: 내보내기 버튼 `ExportReportButton`

**Files:**
- Create: `apps/web/src/features/report/ExportReportButton.tsx`, `apps/web/src/features/report/ExportReportButton.module.css`
- Modify:
  - `apps/web/src/lib/download.ts`
  - `apps/web/src/components/Tabs.tsx`, `apps/web/src/components/Tabs.module.css`
  - `apps/web/src/pages/SchemaPage.tsx`
- Test: `apps/web/test/export-report.test.tsx` (신규), `apps/web/test/schema-page.test.tsx` (테스트 1개 추가)

**Interfaces:**
- Consumes:
  - `build-report.tsx` 의 `buildReportHtml`·`reportFileName` (지연 `import()`)
  - `APP_VERSION` (`meta`)
  - `useMe()` (`api/hooks`), `useSchemaContext()` 의 `mode`·`layout`
- Produces:
  - `export function downloadText(filename: string, text: string, type?: string): void` (기본 `type` 은 `'text/plain;charset=utf-8'`. 기존 호출부는 바꾸지 않는다)
  - `export type ReportModule = typeof import('./build-report')`
  - `export function ExportReportButton({ data, mode, layout, generatedBy, load }: { data?: DiffResponse; mode: 'sql' | 'grid'; layout: 'split' | 'unified'; generatedBy?: string; load?: () => Promise<ReportModule> }): JSX.Element`
  - `Tabs<T>({ value, items, onChange, actions }: { …; actions?: ReactNode })`: `actions` 는 `role="tablist"` 밖, 탭 줄 오른쪽에 둔다.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/web/test/export-report.test.tsx`:

```tsx
import { diffSchemas, parseSqlDump } from '@tdm/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiffResponse, VersionMeta } from '../src/api/types';
import { ExportReportButton, type ReportModule } from '../src/features/report/ExportReportButton';

const meta = (id: number, versionNo: number): VersionMeta => ({
  id, schemaId: 7, databaseId: 1, databaseName: 'db', schemaName: 'shop', versionNo, sourceFormat: 'sql',
  sourceFilename: `shop_v${versionNo}.sql`, note: null, uploadedBy: 'kim', uploadedAt: '2026-10-15T01:02:00.000Z',
});
const base = parseSqlDump('CREATE TABLE `orders` (\n  `x` int\n);').model;
const target = parseSqlDump('CREATE TABLE `orders` (\n  `x` bigint\n);').model;
const DATA: DiffResponse = { base: meta(11, 1), target: meta(12, 2), baseModel: base, targetModel: target, diff: diffSchemas(base, target), statements: [], ddl: '', renames: [] };
const realModule = () => import('../src/features/report/build-report');

// 객체 URL 함수만 대체하고(URL 생성자는 유지), 만든 Blob 과 누른 링크를 모은다
function captureDownloads() {
  const blobs: Blob[] = [];
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: (b: Blob) => { blobs.push(b); return 'blob:report'; }, revokeObjectURL: () => undefined }));
  return { blobs, click };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExportReportButton', () => {
  it('누르면 리포트 모듈을 불러 HTML Blob 을 만들고 정한 파일 이름으로 내려받는다', async () => {
    const { blobs, click } = captureDownloads();
    render(<ExportReportButton data={DATA} mode="sql" layout="unified" generatedBy="park" />);
    await userEvent.setup().click(screen.getByRole('button', { name: '리포트 내보내기' }));
    await vi.waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toMatch(/^db_shop_v1-v2_\d{8}-\d{4}\.html$/);
    expect(blobs[0].type).toBe('text/html;charset=utf-8');
    const html = await blobs[0].text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('park');
    expect(html).toContain('SQL Unified');
    expect(screen.getByRole('button', { name: '리포트 내보내기' })).toBeEnabled();
  });

  it('만드는 동안 버튼이 꺼지고 진행 문구를 보인다', async () => {
    const { click } = captureDownloads();
    const gate = deferred<ReportModule>();
    render(<ExportReportButton data={DATA} mode="sql" layout="split" generatedBy="park" load={() => gate.promise} />);
    await userEvent.setup().click(screen.getByRole('button', { name: '리포트 내보내기' }));
    expect(screen.getByRole('button', { name: '리포트 만드는 중…' })).toBeDisabled();
    gate.resolve(await realModule());
    expect(await screen.findByRole('button', { name: '리포트 내보내기' })).toBeEnabled();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('실패하면 이유를 alert 로 보이고, 다시 누르면 다시 시도한다', async () => {
    const { click } = captureDownloads();
    const load = vi.fn<() => Promise<ReportModule>>().mockRejectedValueOnce(new Error('네트워크 오류')).mockImplementation(realModule);
    render(<ExportReportButton data={DATA} mode="grid" layout="split" generatedBy="park" load={load} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '리포트 내보내기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('리포트를 만들지 못했습니다: 네트워크 오류');
    expect(click).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '리포트 내보내기' }));
    await vi.waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('비교 결과가 없으면 꺼져 있다', () => {
    render(<ExportReportButton mode="sql" layout="split" />);
    expect(screen.getByRole('button', { name: '리포트 내보내기' })).toBeDisabled();
  });
});
```

`apps/web/test/schema-page.test.tsx` — `  it('요약 탭: 통계와 변경 객체 표, 행을 누르면 객체 diff 탭으로', async () => {` 줄 바로 위에 아래 테스트를 넣는다(기존 테스트는 그대로 둔다).

```tsx
  it('탭 줄 오른쪽(tablist 밖)에 리포트 내보내기 버튼이 있다', async () => {
    mockApi({ '/api/schemas/7/versions': [V(12, 2), V(11, 1)], '/api/diff?base=11&target=12': response() });
    renderWithProviders(<SchemaPage />, { route: `${ROUTE}?base=11&target=12&tab=summary`, path: '/db/:dbId/schema/:schemaId' });
    const button = await screen.findByRole('button', { name: '리포트 내보내기' });
    expect(button).toBeEnabled();
    expect(screen.getByRole('tablist')).not.toContainElement(button);
  });

```

- [ ] **Step 2: 실패 확인**

Run: `npm test -w @tdm/web -- export-report schema-page`
Expected: FAIL
- `export-report.test.tsx`: `Failed to resolve import "../src/features/report/ExportReportButton"`
- `schema-page.test.tsx`: 새 테스트가 `Unable to find role="button" and name "리포트 내보내기"` 로 실패한다. 나머지는 통과한다.

- [ ] **Step 3: 구현**

`apps/web/src/lib/download.ts` 를 아래 내용으로 바꾼다.

```ts
// 텍스트를 파일로 내려받는다. type: Blob MIME (기본은 일반 텍스트)
export function downloadText(filename: string, text: string, type = 'text/plain;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // 클릭 직후 해제하면 일부 브라우저에서 다운로드가 시작되기 전에 URL 이 사라진다
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
```

`apps/web/src/features/report/ExportReportButton.module.css`:

```css
.wrap { display: flex; align-items: center; gap: var(--space-2); }
.btn { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: var(--radius); border: 1px solid var(--border-strong); background: var(--card); color: var(--fg); font-size: var(--text-xs); }
.btn:hover:not(:disabled) { background: var(--bg); }
.btn:disabled { opacity: 0.6; cursor: default; }
.error { max-width: 420px; color: var(--del); font-size: var(--text-xs); }
```

`apps/web/src/features/report/ExportReportButton.tsx`. `ReportModule` 은 타입 위치의 `typeof import()` 라서 런타임 import 가 생기지 않는다. 그래서 `react-dom/server` 는 누를 때만 불러온다.

```tsx
import { useState } from 'react';
import type { DiffResponse } from '../../api/types';
import { Icon } from '../../components/Icon';
import { downloadText } from '../../lib/download';
import { APP_VERSION } from '../../meta';
import s from './ExportReportButton.module.css';

export type ReportModule = typeof import('./build-report');

// 리포트 모듈(react-dom/server 포함)은 누를 때 불러 첫 화면 번들을 늘리지 않는다 (설계 §4)
const loadReportModule = (): Promise<ReportModule> => import('./build-report');
// 객체가 수천 개면 만드는 데 몇 초 걸린다 — 진행 표시가 먼저 그려지도록 한 번 양보한다
const yieldToPaint = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const HTML_TYPE = 'text/html;charset=utf-8';
const UNKNOWN_USER = '알 수 없음';

type ExportState = { status: 'idle' } | { status: 'pending' } | { status: 'failed'; reason: string };

// 지금 고른 BASE·TARGET 비교와 보기 방식으로 HTML 리포트를 만들어 내려받는다. load 는 테스트에서 바꿔 끼운다
export function ExportReportButton({ data, mode, layout, generatedBy, load = loadReportModule }: {
  data?: DiffResponse; mode: 'sql' | 'grid'; layout: 'split' | 'unified'; generatedBy?: string; load?: () => Promise<ReportModule>;
}) {
  const [state, setState] = useState<ExportState>({ status: 'idle' });
  const pending = state.status === 'pending';
  const run = async (diff: DiffResponse) => {
    setState({ status: 'pending' });
    try {
      const report = await load();
      await yieldToPaint();
      const generatedAt = new Date();
      const html = report.buildReportHtml(diff, { mode, layout, generatedAt, generatedBy: generatedBy ?? UNKNOWN_USER, appVersion: APP_VERSION });
      downloadText(report.reportFileName(diff, generatedAt), html, HTML_TYPE);
      setState({ status: 'idle' });
    } catch (e) {
      setState({ status: 'failed', reason: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div className={s.wrap}>
      <button type="button" className={s.btn} disabled={!data || pending} onClick={() => data && void run(data)}>
        <Icon name="download" />
        {pending ? '리포트 만드는 중…' : '리포트 내보내기'}
      </button>
      {state.status === 'failed' && <span className={s.error} role="alert">리포트를 만들지 못했습니다: {state.reason}</span>}
    </div>
  );
}
```

`apps/web/src/components/Tabs.tsx` 를 아래 내용으로 바꾼다. 탭 버튼은 안쪽 `role="tablist"` 에 두고, `actions` 는 그 밖에 둔다.

```tsx
import type { ReactNode } from 'react';
import s from './Tabs.module.css';

export interface TabItem<T extends string> {
  id: T;
  label: string;
  badge?: number;
}

// actions: 탭 줄 오른쪽에 두는 조작 (tablist 밖에 둔다)
export function Tabs<T extends string>({ value, items, onChange, actions }: { value: T; items: TabItem<T>[]; onChange: (id: T) => void; actions?: ReactNode }) {
  return (
    <div className={s.tabs}>
      <div className={s.list} role="tablist">
        {items.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={value === t.id} className={value === t.id ? s.on : undefined} onClick={() => onChange(t.id)}>
            {t.label}
            {t.badge !== undefined && <span className={s.pill}>{t.badge}</span>}
          </button>
        ))}
      </div>
      {actions && <div className={s.actions}>{actions}</div>}
    </div>
  );
}
```

`apps/web/src/components/Tabs.module.css` 를 아래 내용으로 바꾼다. 탭 버튼 선택자를 `.tabs button` 에서 `.list button` 으로 좁혀 내보내기 버튼에 탭 스타일이 붙지 않게 한다.

```css
.tabs { display: flex; align-items: flex-end; padding: 0 var(--space-4); height: 40px; border-bottom: 1px solid var(--border); background: var(--bg); position: sticky; top: 0; z-index: 5; }
.list { display: flex; gap: 2px; align-items: flex-end; height: 100%; }
.list button { display: flex; align-items: center; gap: 6px; padding: 0 var(--space-3) 10px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--fg-muted); font-weight: 500; }
.list .on { color: var(--fg); border-color: var(--accent); }
.pill { font-size: var(--text-xs); padding: 0 6px; border-radius: 9px; background: var(--muted); color: var(--fg-muted); }
.actions { margin-left: auto; align-self: center; display: flex; align-items: center; gap: var(--space-2); }
```

`apps/web/src/pages/SchemaPage.tsx`:
- import 수정: `import { useDiff, useVersions } from '../api/hooks';` 를 `import { useDiff, useMe, useVersions } from '../api/hooks';` 로 바꾼다.
- import 추가: `import { MigrationTab } from '../features/migration/MigrationTab';` 다음 줄에 `import { ExportReportButton } from '../features/report/ExportReportButton';` 를 넣는다.
- 훅 추가: `  const diff = useDiff(ctx.base, ctx.target);` 다음 줄에 `  const me = useMe();` 를 넣는다. 조기 반환보다 앞이라 훅 순서가 바뀌지 않는다. `me` 는 `RenameBanner` 가 이미 쓰는 같은 캐시다.
- 탭 줄 수정: `<Tabs<Tab>` 의 `items={[…]} />` 줄을 아래로 바꾼다.

```tsx
        items={[{ id: 'summary', label: '요약', badge: changed }, { id: 'diff', label: '객체 diff' }, { id: 'ddl', label: 'DDL' }, { id: 'migration', label: '전환' }]}
        actions={<ExportReportButton data={diff.data} mode={ctx.mode} layout={ctx.layout} generatedBy={me.data?.username} />} />
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -w @tdm/web -- export-report schema-page ddl-tab`
Expected: PASS. 버튼 테스트 4개, SchemaPage 새 테스트, 기존 DDL 다운로드 테스트(`downloadText` 기본 type)가 모두 통과한다.

Run: `npm test -w @tdm/web && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/features/report/ExportReportButton.tsx apps/web/src/features/report/ExportReportButton.module.css apps/web/src/lib/download.ts apps/web/src/components/Tabs.tsx apps/web/src/components/Tabs.module.css apps/web/src/pages/SchemaPage.tsx apps/web/test/export-report.test.tsx apps/web/test/schema-page.test.tsx
git commit -m "feat: 스키마 비교 화면에 리포트 내보내기 버튼" -m "탭 줄 오른쪽(tablist 밖)에 버튼을 두고, 누르면 리포트 모듈을 import() 로 불러 지금 고른 비교와 보기 방식으로 HTML 파일을 내려받는다. 만드는 동안 버튼을 끄고 진행 문구를 보이며, 실패하면 role=alert 로 이유를 보인다. downloadText 에 MIME type 인자를 더한다."
```

---

## Task 6: README 와 최종 확인(프로덕션 빌드 브라우저 확인 포함)

**Files:**
- Modify: `README.md`, `README.ko.md`
- Test: 루트 전체 테스트·타입 검사·빌드, 프로덕션 빌드 브라우저 확인(커밋하지 않는 `/tmp` 파일만 쓴다)

**Interfaces:**
- Consumes: Task 1–5 의 결과 전체, `apps/web/dist` (프로덕션 빌드)
- Produces: README 기능·권한 문구. 코드 인터페이스는 새로 만들지 않는다.

- [ ] **Step 1: 실패하는 확인 작성** — README 에 문구가 없음을 확인한다.

Run: `grep -c "HTML report" README.md; grep -c "HTML 리포트" README.ko.md`
Expected: 두 줄 모두 `0` (아직 없다)

- [ ] **Step 2: 프로덕션 빌드 브라우저 확인 준비**

이 확인이 필요한 이유: 단위 테스트는 CSS 모듈 이름을 바꾸지 않고(`non-scoped`) `?inline` 이 빈 문자열이라, 빌드한 이름과 넣은 CSS 가 맞는지 잡지 못한다.

Run (워크트리 루트):

```bash
npm run build
ls apps/web/dist/assets | grep -E '^build-report-.*\.js$'
grep -l renderToStaticMarkup apps/web/dist/assets/*.js
```

Expected:
- 빌드가 성공한다.
- `build-report-<hash>.js` 가 하나 있다.
- `grep -l` 은 그 파일만 출력한다. `index-<hash>.js` 에는 `react-dom/server` 가 없다.

API 응답 파일을 만든다. 스크립트는 레포 밖 `/tmp/tdm-report-check` 에 두고 커밋하지 않는다.

```bash
mkdir -p /tmp/tdm-report-check
cat > /tmp/tdm-report-check/fixture.ts <<'EOF'
// 프로덕션 빌드 확인용 API 응답 파일을 만든다 (커밋하지 않는다)
import { writeFileSync } from 'node:fs';
import { diffSchemas, generateDdl, parseSqlDump } from '/Users/teinam/dev/tdm-report/packages/core/src/index.ts';

const OUT = '/tmp/tdm-report-check';
const v = (id: number, versionNo: number) => ({
  id, schemaId: 7, databaseId: 1, databaseName: 'db', schemaName: 'shop', versionNo, sourceFormat: 'sql',
  sourceFilename: `shop_v${versionNo}.sql`, note: null, uploadedBy: 'admin', uploadedAt: `2026-10-1${versionNo}T01:00:00.000Z`,
});
const base = parseSqlDump('CREATE TABLE `orders` (\n  `id` int NOT NULL,\n  `memo` varchar(100) DEFAULT NULL\n);\nCREATE TABLE `old_t` (\n  `x` int\n);\n').model;
const target = parseSqlDump("CREATE TABLE `orders` (\n  `id` bigint NOT NULL,\n  `memo` varchar(100) DEFAULT NULL COMMENT '메모'\n);\nCREATE TABLE `coupon` (\n  `z` int\n);\n").model;
const diff = diffSchemas(base, target);
const files: Record<string, unknown> = {
  'me.json': { id: 1, username: 'admin', role: 'admin' },
  'tree.json': [{ id: 1, name: 'db', description: null, createdAt: '2026-10-10T00:00:00.000Z', schemas: [{ id: 7, name: 'shop', latestVersion: { id: 12, versionNo: 2, uploadedAt: '2026-10-12T01:00:00.000Z' } }] }],
  'schema.json': { id: 7, name: 'shop', databaseId: 1, databaseName: 'db' },
  'versions.json': [{ ...v(12, 2), changedObjects: 3 }, { ...v(11, 1), changedObjects: 0 }],
  'diff.json': { base: v(11, 1), target: v(12, 2), baseModel: base, targetModel: target, diff, statements: generateDdl(diff), ddl: '', renames: [] },
};
for (const [name, body] of Object.entries(files)) writeFileSync(`${OUT}/${name}`, JSON.stringify(body));
EOF
/Users/teinam/dev/tdm-report/node_modules/.bin/tsx /tmp/tdm-report-check/fixture.ts
ls /tmp/tdm-report-check
```

Expected: `diff.json  fixture.ts  me.json  schema.json  tree.json  versions.json`

빌드한 앱과 리포트를 열 정적 서버를 띄운다(둘 다 백그라운드).

```bash
cd /Users/teinam/dev/tdm-report/apps/web && npx vite preview --port 4173 --strictPort > /tmp/tdm-report-check/preview.log 2>&1 &
python3 -m http.server 4174 --bind 127.0.0.1 --directory /tmp/tdm-report-check > /tmp/tdm-report-check/http.log 2>&1 &
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4173/db/1/schema/7
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4174/me.json
```

Expected: `200` 두 줄

- [ ] **Step 3: 브라우저에서 내려받아 열기**

Playwright MCP 의 `browser_run_code_unsafe` 에 아래 코드를 `code` 로 넘긴다. `filename` 인자는 MCP 허용 경로 밖(`/tmp`)이라 거부되므로 쓰지 않는다. 코드가 하는 일:
- `/api/**` 를 위 응답 파일로 가로챈다.
- 프로덕션 빌드 화면에서 버튼을 눌러 파일을 내려받는다.
- 정적 서버로 연 리포트에서 화면 클래스의 스타일이 실제로 붙었는지 본다.

```js
async (page) => {
  const DIR = '/tmp/tdm-report-check';
  const FILES = { '/api/auth/me': 'me.json', '/api/tree': 'tree.json', '/api/schemas/7': 'schema.json', '/api/schemas/7/versions': 'versions.json', '/api/diff?base=11&target=12': 'diff.json' };
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    const file = FILES[url.pathname + url.search];
    return file
      ? route.fulfill({ path: `${DIR}/${file}`, contentType: 'application/json' })
      : route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: '없는 경로' }) });
  });
  await page.goto('http://localhost:4173/db/1/schema/7?base=11&target=12&tab=summary');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '리포트 내보내기' }).click()]);
  await download.saveAs(`${DIR}/report.html`);
  const suggested = download.suggestedFilename();
  await page.unroute('**/api/**');
  await page.goto('http://127.0.0.1:4174/report.html');
  const read = () => page.evaluate(() => {
    const css = (sel, prop) => { const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : 'missing'; };
    return {
      title: document.title,
      scripts: document.querySelectorAll('script').length,
      sqlClass: document.querySelector('table[aria-label="SQL diff"]')?.className,
      tableLayout: css('table[aria-label="SQL diff"]', 'tableLayout'),
      markWidth: css('[role="img"][aria-label="변경"]', 'width'),
      statsDisplay: css('ul[aria-label="변경 통계"]', 'display'),
      bodyBg: css('body', 'backgroundColor'),
      cardBorder: css('details.report-object', 'borderTopStyle'),
      delCellBg: css('table[aria-label="SQL diff"] td[class*="_del_"]', 'backgroundColor'),
      linkDisplay: css('a.report-link', 'display'),
    };
  });
  const screen = await read();
  await page.emulateMedia({ media: 'print' });
  const print = await read();
  await page.emulateMedia({ media: 'screen' });
  return { suggested, screen, printBodyBg: print.bodyBg };
}
```

Expected:
- `suggested`: `/^db_shop_v1-v2_\d{8}-\d{4}\.html$/`
- `screen`
  - `title`: `db › shop 비교 리포트`
  - `scripts`: `0`
  - `sqlClass`: `_diff_` 로 시작한다. 프로덕션 빌드의 해시 이름이라는 뜻이다.
  - `tableLayout`: `fixed`, `markWidth`: `16px`, `statsDisplay`: `grid`
  - `bodyBg`: `rgb(248, 250, 252)` (밝은 테마 `--bg`)
  - `cardBorder`: `solid`
  - `delCellBg`: `rgba(0, 0, 0, 0)` 가 아니다.
  - `linkDisplay`: `grid`
- `printBodyBg`: `rgb(255, 255, 255)`

어긋나는 값이 있으면 `styles.ts` 의 import 목록과 해당 컴포넌트의 CSS 모듈을 대조해 고친다. 고친 뒤 Step 2–3 을 다시 실행한다.

`browser_take_screenshot` (`fullPage: true`) 으로 리포트를 한 번 보고, 화면 객체 diff 탭과 같은 모양(카드 머리, +/− 색, 단어 강조)인지 눈으로 확인한다.

- [ ] **Step 4: README 수정과 정리**

`README.md`:
- 기능 목록: `- **Comparison**: …` 줄 바로 아래에 다음 줄을 넣는다.

```markdown
- **HTML report**: export the current comparison (summary and object diff, in the selected view) as one self-contained HTML file. It opens without access to this tool and can be shared, archived, or printed (print to PDF from the browser).
```

- 권한 표: `| Browse, compare, copy/download DDL | ✓ | ✓ | ✓ |` 를 `| Browse, compare, copy/download DDL, export HTML report | ✓ | ✓ | ✓ |` 로 바꾼다.

`README.ko.md`:
- 기능 목록: `- **비교**: …` 줄 바로 아래에 다음 줄을 넣는다.

```markdown
- **HTML 리포트**: 지금 보는 비교(요약과 객체 diff, 고른 보기 방식)를 HTML 파일 하나로 내려받습니다. 이 도구에 접속하지 않고 열 수 있고, 공유·보관·인쇄(브라우저 인쇄로 PDF)할 수 있습니다.
```

- 권한 표: `| 조회·비교·DDL 복사/다운로드 | O | O | O |` 를 `| 조회·비교·DDL 복사/다운로드·HTML 리포트 내보내기 | O | O | O |` 로 바꾼다.

확인용 서버와 임시 파일을 정리한다.

```bash
pkill -f "vite preview --port 4173"
pkill -f "http.server 4174"
rm -rf /tmp/tdm-report-check
git status --short
```

Expected: `git status --short` 에 `README.md`, `README.ko.md` 만 보인다(`.playwright-mcp/` 는 무시 목록에 있고 스테이징하지 않는다).

- [ ] **Step 5: 최종 확인과 커밋**

Run: `grep -c "HTML report" README.md; grep -c "HTML 리포트" README.ko.md`
Expected: 두 줄 모두 `1` 이상

Run (워크트리 루트): `npm test && npm run typecheck && npm run build`
Expected: 모든 워크스페이스 테스트, 타입 검사, 웹 빌드가 통과한다.

Run (제어 문자 검사): `git diff main --name-only | xargs perl -ne 'print "$ARGV:$.\n" if /[\x00-\x08\x0B-\x1F\x7F]/; close ARGV if eof'`
Expected: 출력 없음

```bash
git add README.md README.ko.md
git commit -m "docs: README 에 HTML 리포트 내보내기" -m "기능 목록과 권한 표에 비교 결과 HTML 리포트 내보내기를 더한다."
```

---

## Spec coverage

| 설계 절 | Task |
|---|---|
| §1 목적 | Task 4(문서), Task 5(내려받기) |
| §2 사용자 흐름: 탭 줄 버튼·모든 역할·보기 방식·진행 표시·`role="alert"`·결과 없으면 꺼짐 | Task 5 |
| §3.1 머리말 | Task 4 (`ReportHeader`, `report-meta.ts`) |
| §3.2 화면 안내: MD 부분 비교, rename 과 출처, TARGET 완전성·BASE 불완전·예전 파서 | Task 1(`SummaryView` 안내·`PARTIAL_MESSAGE`), Task 2(`AppliedRenames`), Task 4(조립) |
| §3.3 요약: 통계·링크 목록 | Task 1, Task 4 (`linkItem`) |
| §3.4 객체 diff: 머리·보기 방식별 본문·`<details open>`·동일 구간 펼침 | Task 3(`ObjectBody`), Task 4(`ReportObject`) |
| §3 넣지 않는 것 | Task 4 (버튼·스크립트 없음 테스트) |
| §4 구조: 순수 함수·컴포넌트·`report.css`·재사용·`?inline` CSS·`import()` | Task 1–5 |
| §5 문서 머리·CSP·이스케이프·인쇄·파일 이름 | Task 4, Task 6(인쇄 매체 확인) |
| §6 큰 비교: 모든 객체·모두 펼침·진행 표시 | Task 4(`EAGER_CARDS` 없이 전부), Task 5(`yieldToPaint`) |
| §7 오류 처리·재시도 | Task 5 |
| §8 단위 테스트·버튼 테스트·요약 탭 회귀·빌드 확인 | Task 4, Task 5, Task 1, Task 6 |
| §9 범위 밖 | 다루지 않는다 |

## 설계에서 정한 해석

- **rename 후보:** "이름 변경 후보" 배너는 처리 버튼을 위한 화면 조작 요소로 보고 리포트에 넣지 않는다.
  - 적용된 rename(수동·역방향·DMS)과 "적용하지 못한 이름 변경"은 안내로 넣는다.
  - DMS 목록은 파일에서도 보이도록 펼친다.
- **DB·스키마 이름:** 제목과 파일 이름의 DB·스키마는 TARGET 버전 메타(`databaseName`·`schemaName`)에서 가져온다. 이 화면은 한 스키마의 버전끼리 비교한다.
- **도구 버전:** `Database Diff {APP_VERSION}` 으로 쓴다.
- **글꼴:** CSP `default-src 'none'` 때문에 리포트는 웹 글꼴을 읽지 않는다. 설치된 IBM Plex Sans·JetBrains Mono 가 있으면 그것을, 없으면 `system-ui`·`ui-monospace` 를 쓴다.
- **객체 머리의 종류:** 아이콘(장식용) 옆에 종류 글자(`table` 등)를 작게 넣어 인쇄본에서도 읽힌다.
