import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { VersionSummary } from '../src/api/types';
import { AlterDialog } from '../src/features/alter/AlterDialog';
import { HistoryPage } from '../src/pages/HistoryPage';
import { mockApi, renderWithProviders } from './render';

const version = (id: number, versionNo: number, sourceFormat: 'sql' | 'md', extra: Partial<VersionSummary> = {}): VersionSummary => ({
  id, schemaId: 7, databaseId: 1, databaseName: 'db', schemaName: 'shop', versionNo, sourceFormat, sourceFilename: `shop-v${versionNo}.${sourceFormat}`,
  note: null, uploadedBy: 'admin', uploadedAt: '2026-10-13T00:00:00.000Z', changedObjects: 1, ...extra,
});
const DERIVED = { baseVersionNo: 1, statementCount: 1, defaults: { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' } };

describe('AlterDialog', () => {
  it('SQL 버전만 기준으로 고르고(기본: 최신), 미리보기 뒤에만 저장한다 — 스키마 기본값은 마지막 ALTER 적용 값', async () => {
    const calls = mockApi({
      'POST /api/versions/3/alter': (init: RequestInit) => (JSON.parse(String(init.body)).dryRun
        ? { status: 'preview', applied: 1, changes: [{ kind: 'table', name: 'member', op: 'modify' }], renames: [] }
        : { status: 'ok', versionId: 4, versionNo: 4, applied: 1, changes: [{ kind: 'table', name: 'member', op: 'modify' }] }),
    });
    renderWithProviders(<AlterDialog versions={[version(9, 4, 'md'), version(3, 3, 'sql', { derivedFrom: DERIVED }), version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    expect(within(screen.getByLabelText('기준 버전')).getAllByRole('option').map((o) => o.textContent)).toEqual(['v3 · shop-v3.sql', 'v1 · shop-v1.sql']);
    expect(screen.getByLabelText('스키마 기본 콜레이션')).toHaveValue('utf8mb4_general_ci');
    const save = screen.getByRole('button', { name: '저장' });
    await user.type(screen.getByLabelText('ALTER 스크립트'), 'ALTER TABLE member ADD COLUMN nick VARCHAR(20);');
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    const results = await screen.findByRole('list', { name: '미리보기 결과' });
    expect(within(results).getByText('member')).toBeInTheDocument();
    expect(save).toBeEnabled();
    await user.click(save);
    expect(await screen.findByText('v4 생성')).toBeInTheDocument();
    const bodies = calls.filter((c) => c.url === '/api/versions/3/alter').map((c) => JSON.parse(String(c.init.body)));
    expect(bodies).toEqual([
      { script: 'ALTER TABLE member ADD COLUMN nick VARCHAR(20);', dryRun: true, defaults: { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' } },
      { script: 'ALTER TABLE member ADD COLUMN nick VARCHAR(20);', dryRun: false, defaults: { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' } },
    ]);
  });

  it('실패하면 서버 메시지(문장 번호·줄)를 보여 주고, 스크립트를 고치면 미리보기를 지운다', async () => {
    const fail = () => new Response(JSON.stringify({ error: '1번째 문장 (줄 1): 컬럼 `id` 이 두 번 있습니다 (MySQL 1060)' }), { status: 400, headers: { 'content-type': 'application/json' } });
    mockApi({ 'POST /api/versions/1/alter': fail });
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('ALTER 스크립트'), 'ALTER TABLE member ADD id INT;');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('1번째 문장 (줄 1)');
    await user.type(screen.getByLabelText('ALTER 스크립트'), ' ');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('HistoryPage — ALTER 적용', () => {
  it('editor 에게 ALTER 적용 버튼, 파생 버전에는 기준 배지와 스크립트 보기', async () => {
    mockApi({
      '/api/auth/me': { id: 3, username: 'park', role: 'dba' },
      '/api/schemas/7': { id: 7, name: 'shop', databaseId: 1, databaseName: 'db' },
      '/api/schemas/7/versions': [version(12, 2, 'sql', { derivedFrom: DERIVED }), version(11, 1, 'sql')],
      '/api/versions/12/derivation': { baseVersionId: 11, baseVersionNo: 1, script: 'ALTER TABLE member ADD age INT;', statementCount: 1, defaults: DERIVED.defaults },
    });
    renderWithProviders(<HistoryPage />, { route: '/db/1/schema/7/history', path: '/db/:dbId/schema/:schemaId/history' });
    const user = userEvent.setup();
    expect(await screen.findByRole('button', { name: 'ALTER 적용' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'ALTER 적용 (기준 v1)' }));
    expect(await screen.findByText('ALTER TABLE member ADD age INT;')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'ALTER 적용' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'ALTER 적용' })).toBeInTheDocument());
  });
});

// 아래는 브리프의 필수 테스트 외에 더한 보강 테스트
const PREVIEW = { status: 'preview', applied: 1, changes: [{ kind: 'table', name: 'member', op: 'add' }], renames: [] };
const alterBodies = (calls: ReturnType<typeof mockApi>, id: number) =>
  calls.filter((c) => c.url === `/api/versions/${id}/alter`).map((c) => JSON.parse(String(c.init.body)));

describe('AlterDialog — 입력과 결과 처리', () => {
  it('.sql 파일을 고르면 스크립트·파일명·메모를 함께 보내고, 스크립트를 직접 고치면 파일명은 뺀다', async () => {
    const calls = mockApi({ 'POST /api/versions/1/alter': PREVIEW });
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText('스크립트 파일'), new File(['ALTER TABLE a ADD b INT;'], 'add-b.sql', { type: 'text/plain' }));
    await waitFor(() => expect(screen.getByLabelText('ALTER 스크립트')).toHaveValue('ALTER TABLE a ADD b INT;'));
    await user.type(screen.getByLabelText('메모'), '컬럼 추가');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await screen.findByRole('list', { name: '미리보기 결과' });
    await user.type(screen.getByLabelText('ALTER 스크립트'), ' ');
    expect(screen.queryByRole('list', { name: '미리보기 결과' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await screen.findByRole('list', { name: '미리보기 결과' });
    const [first, second] = alterBodies(calls, 1);
    expect(first).toMatchObject({ script: 'ALTER TABLE a ADD b INT;', filename: 'add-b.sql', note: '컬럼 추가', dryRun: true });
    expect(second).toMatchObject({ script: 'ALTER TABLE a ADD b INT; ', note: '컬럼 추가' });
    expect(second).not.toHaveProperty('filename');
  });

  it('기준 버전을 바꾸면 이전 미리보기를 지우고(저장 잠금), 고른 버전으로 보낸다', async () => {
    const calls = mockApi({ 'POST /api/versions/3/alter': PREVIEW, 'POST /api/versions/1/alter': PREVIEW });
    renderWithProviders(<AlterDialog versions={[version(3, 3, 'sql'), version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('ALTER 스크립트'), 'ALTER TABLE a ADD b INT;');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await screen.findByRole('list', { name: '미리보기 결과' });
    await user.selectOptions(screen.getByLabelText('기준 버전'), '1');
    expect(screen.queryByRole('list', { name: '미리보기 결과' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await screen.findByRole('list', { name: '미리보기 결과' });
    expect(calls.map((c) => c.url)).toEqual(['/api/versions/3/alter', '/api/versions/1/alter']);
  });

  it('같은 내용의 버전이 이미 있으면 새로 만들지 않고 그 버전을 알려 준다', async () => {
    const duplicate = { status: 'duplicate', versionId: 5, versionNo: 3, applied: 1, changes: [] };
    mockApi({ 'POST /api/versions/1/alter': (init: RequestInit) => (JSON.parse(String(init.body)).dryRun ? PREVIEW : duplicate) });
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('ALTER 스크립트'), 'ALTER TABLE a ADD b INT;');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await screen.findByRole('list', { name: '미리보기 결과' });
    await user.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByText('v3와 내용이 같습니다')).toBeInTheDocument();
  });
});

describe('HistoryPage — ALTER 적용 버튼 노출', () => {
  it('SQL 버전이 없는(MD 만 있는) 스키마에는 editor 에게도 ALTER 적용 버튼이 없다', async () => {
    mockApi({
      '/api/auth/me': { id: 3, username: 'park', role: 'dba' },
      '/api/schemas/7': { id: 7, name: 'shop', databaseId: 1, databaseName: 'db' },
      '/api/schemas/7/versions': [version(12, 2, 'md'), version(11, 1, 'md')],
    });
    renderWithProviders(<HistoryPage />, { route: '/db/1/schema/7/history', path: '/db/:dbId/schema/:schemaId/history' });
    // editor 버튼 줄과 목록이 모두 그려진 뒤에 없음을 확인한다
    expect(await screen.findByRole('button', { name: 'Schema 삭제' })).toBeInTheDocument();
    expect(await screen.findByText('v2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ALTER 적용' })).not.toBeInTheDocument();
  });
});
