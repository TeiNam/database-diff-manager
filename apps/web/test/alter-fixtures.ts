import { screen } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import type { PreviewBase, VersionSummary } from '../src/api/types';
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

// 서버가 미리보기에 실어 주는 기준 버전 지문. version() 이 만드는 목록의 버전과 같은 스키마(7)·버전 번호를 가리켜야 미리보기가 남는다.
// 따로 정하지 않으면 미리보기 때 이 버전이 최신 SQL 버전이었다
export const fingerprint = (versionNo: number, extra: Partial<PreviewBase> = {}): PreviewBase => ({
  schemaId: 7, versionNo, modelHash: `model-hash-v${versionNo}`, uploadedAt: '2026-10-13T00:00:00.000Z', databaseName: 'db', schemaName: 'shop', latestVersionNo: versionNo, ...extra,
});
export const previewOf = (versionNo: number, extra: Partial<PreviewBase> = {}) =>
  ({ status: 'preview', applied: 1, changes: [{ kind: 'table', name: 'member', op: 'add' }], renames: [], base: fingerprint(versionNo, extra) });
// 기준 버전이 v1 인 미리보기. 다른 버전을 기준으로 하는 테스트는 previewOf(그 버전 번호)를 쓴다
export const PREVIEW = previewOf(1);
export const SAVED = { status: 'ok', versionId: 10, versionNo: 2, applied: 1, changes: [{ kind: 'table', name: 'member', op: 'add' }] };

// 기준 버전 id 로 간 ALTER 요청의 본문들 (보낸 순서)
export const alterBodies = (calls: ReturnType<typeof mockApi>, id: number) =>
  calls.filter((c) => c.url === `/api/versions/${id}/alter`).map((c) => JSON.parse(String(c.init.body)));

// 대화상자의 칸·단추와 미리보기 한 번 (스크립트를 지우고 다시 써서 미리보기 결과가 나올 때까지)
export type User = ReturnType<typeof userEvent.setup>;
export const SCRIPT = 'ALTER TABLE a ADD b INT;';
export const editor = () => screen.getByLabelText('ALTER 스크립트');
export const previewButton = () => screen.getByRole('button', { name: '미리보기' });
export const saveButton = () => screen.getByRole('button', { name: '저장' });
export const charsetField = () => screen.getByLabelText('스키마 기본 문자셋');
export const baseSelect = () => screen.getByLabelText('기준 버전');
export const previewList = () => screen.queryByRole('list', { name: '미리보기 결과' });
export const runPreview = async (user: User, script = SCRIPT) => {
  await user.clear(editor());
  await user.type(editor(), script);
  await user.click(previewButton());
  await screen.findByRole('list', { name: '미리보기 결과' });
};
export const isSaveRequest = (init: RequestInit) => !JSON.parse(String(init.body)).dryRun;

// 실제 목록 쿼리(useVersions)를 쓰는 버전 이력 화면 (스키마 7)
export const route = { route: '/db/1/schema/7/history', path: '/db/:dbId/schema/:schemaId/history' };
export const pageRoutes = {
  '/api/auth/me': { id: 3, username: 'park', role: 'dba' },
  '/api/schemas/7': { id: 7, name: 'shop', databaseId: 1, databaseName: 'db' },
};
