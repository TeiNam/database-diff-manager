import type { VersionSummary } from '../src/api/types';
import { mockApi } from './render';

// ALTER 적용 대화상자 테스트가 함께 쓰는 픽스처

export const version = (id: number, versionNo: number, sourceFormat: 'sql' | 'md', extra: Partial<VersionSummary> = {}): VersionSummary => ({
  id, schemaId: 7, databaseId: 1, databaseName: 'db', schemaName: 'shop', versionNo, sourceFormat, sourceFilename: `shop-v${versionNo}.${sourceFormat}`,
  note: null, uploadedBy: 'admin', uploadedAt: '2026-10-13T00:00:00.000Z', changedObjects: 1, ...extra,
});
export const DERIVED = { baseVersionNo: 1, statementCount: 1, defaults: { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' } };

// ALTER 로 만든 버전이 없는 스키마에서는 대화상자가 기준 버전 테이블의 기본 문자셋을 한 번 묻는다.
// 그 답을 따로 정하지 않은 테스트는 '알 수 없음' 으로 답해, 기본값은 MySQL 8 기본값 그대로다
export const NO_SUGGESTION = { defaults: null };
export const mockAlterApi = (routes: Record<string, unknown>) => mockApi({
  'GET /api/versions/1/alter-defaults': NO_SUGGESTION,
  'GET /api/versions/3/alter-defaults': NO_SUGGESTION,
  ...routes,
});

export const PREVIEW = { status: 'preview', applied: 1, changes: [{ kind: 'table', name: 'member', op: 'add' }], renames: [] };
export const SAVED = { status: 'ok', versionId: 10, versionNo: 2, applied: 1, changes: [{ kind: 'table', name: 'member', op: 'add' }] };

// 기준 버전 id 로 간 ALTER 요청의 본문들 (보낸 순서)
export const alterBodies = (calls: ReturnType<typeof mockApi>, id: number) =>
  calls.filter((c) => c.url === `/api/versions/${id}/alter`).map((c) => JSON.parse(String(c.init.body)));
