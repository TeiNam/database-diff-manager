import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HistoryPage } from '../src/pages/HistoryPage';
import { HomePage } from '../src/pages/HomePage';
import { ObjectHistoryPage } from '../src/pages/ObjectHistoryPage';
import { UsersPage } from '../src/pages/UsersPage';
import { mockApi, renderWithProviders } from './render';

const VERSIONS = [
  { id: 12, versionNo: 2, uploadedAt: '2026-10-02T09:00:00Z', uploadedBy: 'admin', note: '컬럼 추가', sourceFormat: 'md', sourceFilename: 'shop(db).md', changedObjects: 1 },
  { id: 11, versionNo: 1, uploadedAt: '2026-10-01T09:00:00Z', uploadedBy: 'kim', note: null, sourceFormat: 'sql', sourceFilename: 'shop(db).sql', changedObjects: 33 },
];
const ADMIN = { '/api/auth/me': { id: 1, username: 'admin', role: 'admin' } };
const DBA = { '/api/auth/me': { id: 3, username: 'park', role: 'dba' } };

describe('HistoryPage', () => {
  it('버전 표·비교 링크·원본 다운로드·삭제(admin)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const calls = mockApi({ ...ADMIN, '/api/schemas/7': { id: 7, name: 'shop', databaseId: 1, databaseName: 'db' }, '/api/schemas/7/versions': VERSIONS, 'DELETE /api/versions/12': { ok: true } });
    renderWithProviders(<HistoryPage />, { route: '/db/1/schema/7/history', path: '/db/:dbId/schema/:schemaId/history' });
    const row = (await screen.findByText('v2')).closest('tr')!;
    expect(within(row).getByText('컬럼 추가')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'v1과 비교' })).toHaveAttribute('href', '/db/1/schema/7?base=11&target=12');
    expect(within(row).getByRole('link', { name: '원본' })).toHaveAttribute('href', '/api/versions/12/source');
    await userEvent.setup().click(within(row).getByRole('button', { name: 'v2 삭제' }));
    await waitFor(() => expect(calls.some((c) => c.init.method === 'DELETE' && c.url === '/api/versions/12')).toBe(true));
  });

  it('Schema 삭제는 이름이 맞을 때만 요청하고, 끝나면 홈으로 이동한다', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValueOnce('wrong').mockReturnValueOnce('shop');
    vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const calls = mockApi({ ...ADMIN, '/api/schemas/7': { id: 7, name: 'shop', databaseId: 1, databaseName: 'db' }, '/api/schemas/7/versions': VERSIONS, 'DELETE /api/schemas/7': { ok: true } });
    renderWithProviders(<HistoryPage />, { route: '/db/1/schema/7/history', path: '/db/:dbId/schema/:schemaId/history' });
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: 'Schema 삭제' });
    expect(screen.getByRole('button', { name: 'Database 삭제' })).toBeInTheDocument();
    await user.click(button);
    expect(calls.some((c) => c.init.method === 'DELETE')).toBe(false);
    await user.click(button);
    // 홈('/')으로 이동하면 이 라우트(:schemaId/history)를 벗어나 페이지가 사라진다
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Schema 삭제' })).not.toBeInTheDocument());
    const del = calls.find((c) => c.init.method === 'DELETE')!;
    expect([del.url, del.init.body]).toEqual(['/api/schemas/7', JSON.stringify({ confirmName: 'shop' })]);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('이름 앞뒤 공백은 무시하고, 새 삭제를 시작하면 이전 삭제의 오류를 지운다', async () => {
    vi.spyOn(window, 'prompt').mockReturnValueOnce(' shop ').mockReturnValueOnce('db  ');
    const fail = (error: string) => () => new Response(JSON.stringify({ error }), { status: 409, headers: { 'content-type': 'application/json' } });
    const calls = mockApi({ ...ADMIN, '/api/schemas/7': { id: 7, name: 'shop', databaseId: 1, databaseName: 'db' }, '/api/schemas/7/versions': VERSIONS,
      'DELETE /api/schemas/7': fail('스키마 삭제 실패'), 'DELETE /api/databases/1': fail('DB 삭제 실패') });
    renderWithProviders(<HistoryPage />, { route: '/db/1/schema/7/history', path: '/db/:dbId/schema/:schemaId/history' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Schema 삭제' }));
    expect(await screen.findByText('스키마 삭제 실패')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Database 삭제' }));
    expect(await screen.findByText('DB 삭제 실패')).toBeInTheDocument();
    expect(screen.queryByText('스키마 삭제 실패')).not.toBeInTheDocument();
    expect(calls.filter((c) => c.init.method === 'DELETE').map((c) => c.init.body)).toEqual([JSON.stringify({ confirmName: 'shop' }), JSON.stringify({ confirmName: 'db' })]);
  });

  it('dba 에게는 버전·Schema·Database 삭제 버튼이 있다', async () => {
    mockApi({ ...DBA, '/api/schemas/7': { id: 7, name: 'shop', databaseId: 1, databaseName: 'db' }, '/api/schemas/7/versions': VERSIONS });
    renderWithProviders(<HistoryPage />, { route: '/db/1/schema/7/history', path: '/db/:dbId/schema/:schemaId/history' });
    const row = (await screen.findByText('v2')).closest('tr')!;
    expect(await within(row).findByRole('button', { name: 'v2 삭제' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Schema 삭제' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Database 삭제' })).toBeInTheDocument();
  });

  it('viewer 에게는 Schema·Database 삭제 버튼이 없다', async () => {
    mockApi({ '/api/auth/me': { id: 2, username: 'kim', role: 'viewer' }, '/api/schemas/7': { id: 7, name: 'shop', databaseId: 1, databaseName: 'db' }, '/api/schemas/7/versions': VERSIONS });
    renderWithProviders(<HistoryPage />, { route: '/db/1/schema/7/history', path: '/db/:dbId/schema/:schemaId/history' });
    await screen.findByText('v2');
    expect(screen.queryByRole('button', { name: 'Schema 삭제' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Database 삭제' })).not.toBeInTheDocument();
  });
});

const TREE = [
  { id: 1, name: 'prod-db-01', description: null, createdAt: '', schemas: [{ id: 7, name: 'shop', latestVersion: null }, { id: 8, name: 'blog', latestVersion: null }] },
  { id: 2, name: 'stg-db-01', description: null, createdAt: '', schemas: [] },
];

describe('HomePage', () => {
  it('admin 은 Database 목록에서 Schema 가 없는 Database 도 이름 확인 후 삭제한다', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValueOnce('wrong').mockReturnValueOnce(' stg-db-01 ');
    vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const calls = mockApi({ ...ADMIN, '/api/tree': TREE, 'DELETE /api/databases/2': { ok: true } });
    renderWithProviders(<HomePage />);
    const table = await screen.findByRole('table', { name: 'Database 목록' });
    const row = within(table).getByText('stg-db-01').closest('tr')!;
    expect(within(row).getByText('0')).toBeInTheDocument();
    expect(within(within(table).getByText('prod-db-01').closest('tr')!).getByText('2')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(row).getByRole('button', { name: 'stg-db-01 삭제' }));
    expect(calls.some((c) => c.init.method === 'DELETE')).toBe(false);
    await user.click(within(row).getByRole('button', { name: 'stg-db-01 삭제' }));
    await waitFor(() => expect(calls.some((c) => c.init.method === 'DELETE')).toBe(true));
    const del = calls.find((c) => c.init.method === 'DELETE')!;
    expect([del.url, del.init.body]).toEqual(['/api/databases/2', JSON.stringify({ confirmName: 'stg-db-01' })]);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('dba 도 Database 목록에서 삭제할 수 있다', async () => {
    mockApi({ ...DBA, '/api/tree': TREE });
    renderWithProviders(<HomePage />);
    const table = await screen.findByRole('table', { name: 'Database 목록' });
    expect(within(table).getByRole('button', { name: 'stg-db-01 삭제' })).toBeInTheDocument();
  });

  it('viewer 에게는 Database 목록·삭제 버튼이 없다', async () => {
    const calls = mockApi({ '/api/auth/me': { id: 2, username: 'kim', role: 'viewer' }, '/api/tree': TREE });
    renderWithProviders(<HomePage />);
    expect(await screen.findByText('스키마를 선택하세요')).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.url === '/api/auth/me')).toBe(true));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /삭제/ })).not.toBeInTheDocument();
  });
});

describe('잘못된 주소 파라미터', () => {
  it('schemaId 가 숫자가 아니면 API 를 부르지 않고 안내한다', async () => {
    const calls = mockApi(ADMIN);
    renderWithProviders(<HistoryPage />, { route: '/db/1/schema/abc/history', path: '/db/:dbId/schema/:schemaId/history' });
    expect(await screen.findByRole('alert')).toHaveTextContent('올바르지 않은 스키마 주소');
    expect(calls.some((c) => c.url.includes('/schemas/'))).toBe(false);
  });

  it('objectId 가 숫자가 아니면 API 를 부르지 않고 안내한다', async () => {
    const calls = mockApi(ADMIN);
    renderWithProviders(<ObjectHistoryPage />, { route: '/objects/abc', path: '/objects/:objectId' });
    expect(await screen.findByRole('alert')).toHaveTextContent('올바르지 않은 객체 주소');
    expect(calls.some((c) => c.url.includes('/objects/'))).toBe(false);
  });
});

describe('ObjectHistoryPage', () => {
  it('리비전 목록과 인접 리비전 비교 링크', async () => {
    mockApi({
      '/api/objects/5/history': { object: { id: 5, kind: 'table', name: 'orders', schemaId: 7 }, revisions: [
        { revisionNo: 1, fidelity: 'full', parseError: null, firstVersion: { id: 11, versionNo: 1, uploadedAt: '2026-10-01' } },
        { revisionNo: 2, fidelity: 'full', parseError: null, firstVersion: { id: 12, versionNo: 2, uploadedAt: '2026-10-02' } },
      ] },
      '/api/schemas/7': { id: 7, name: 'shop', databaseId: 1, databaseName: 'db' },
    });
    renderWithProviders(<ObjectHistoryPage />, { route: '/objects/5', path: '/objects/:objectId' });
    expect(await screen.findByRole('heading', { name: /orders/ })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'r1 → r2 비교' })).toHaveAttribute('href', '/db/1/schema/7?base=11&target=12&obj=orders&kind=table');
  });
});

describe('ObjectHistoryPage 스키마 로드 실패', () => {
  it('스키마 정보가 없으면 비교 링크 없이 오류를 보여 준다', async () => {
    mockApi({
      '/api/objects/5/history': { object: { id: 5, kind: 'table', name: 'orders', schemaId: 7 }, revisions: [
        { revisionNo: 1, fidelity: 'full', parseError: null, firstVersion: { id: 11, versionNo: 1, uploadedAt: '2026-10-01' } },
        { revisionNo: 2, fidelity: 'full', parseError: null, firstVersion: { id: 12, versionNo: 2, uploadedAt: '2026-10-02' } },
      ] },
    });
    renderWithProviders(<ObjectHistoryPage />, { route: '/objects/5', path: '/objects/:objectId' });
    expect(await screen.findByRole('heading', { name: /orders/ })).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /비교/ })).toBeNull();
  });
});

describe('UsersPage', () => {
  it('admin이 아니면 권한 안내', async () => {
    mockApi({ '/api/auth/me': { id: 2, username: 'kim', role: 'viewer' } });
    renderWithProviders(<UsersPage />);
    expect(await screen.findByText('관리자만 볼 수 있습니다')).toBeInTheDocument();
  });

  it('dba 도 계정 관리는 볼 수 없다', async () => {
    const calls = mockApi(DBA);
    renderWithProviders(<UsersPage />);
    expect(await screen.findByText('관리자만 볼 수 있습니다')).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/users')).toBe(false);
  });

  it('역할 선택지에 dba 가 있고, dba 로 계정을 만들고 역할을 바꾼다', async () => {
    const calls = mockApi({
      ...ADMIN,
      '/api/users': [{ id: 2, username: 'kim', role: 'viewer', disabled: false, createdAt: '' }],
      'POST /api/users': { id: 3, username: 'park', role: 'dba', disabled: false, createdAt: '' },
      'PATCH /api/users/2': { id: 2, username: 'kim', role: 'dba', disabled: false, createdAt: '' },
    });
    renderWithProviders(<UsersPage />);
    const user = userEvent.setup();
    const roleSelect = await screen.findByLabelText('kim 역할');
    expect(within(roleSelect).getAllByRole('option').map((o) => o.textContent)).toEqual(['viewer', 'dba', 'admin']);
    await user.selectOptions(roleSelect, 'dba');
    await user.type(screen.getByLabelText('새 사용자명'), 'park');
    await user.type(screen.getByLabelText('초기 비밀번호'), 'long-password-1');
    await user.selectOptions(screen.getByLabelText('역할'), 'dba');
    await user.click(screen.getByRole('button', { name: '계정 만들기' }));
    await waitFor(() => expect(calls.some((c) => c.init.method === 'POST' && c.url === '/api/users')).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.init.method === 'PATCH')!.init.body))).toEqual({ role: 'dba' });
    expect(JSON.parse(String(calls.find((c) => c.init.method === 'POST')!.init.body))).toEqual({ username: 'park', password: 'long-password-1', role: 'dba' });
  });

  it('admin이 아니면 사용자 목록을 요청하지 않는다', async () => {
    const calls = mockApi({ '/api/auth/me': { id: 2, username: 'kim', role: 'viewer' } });
    renderWithProviders(<UsersPage />);
    await screen.findByText('관리자만 볼 수 있습니다');
    expect(calls.some((c) => c.url === '/api/users')).toBe(false);
  });

  it('내 정보를 불러오는 동안 로딩 문구', () => {
    mockApi({ '/api/auth/me': () => new Promise(() => {}) });
    renderWithProviders(<UsersPage />);
    expect(screen.getByText('불러오는 중…')).toBeInTheDocument();
  });

  it('10자 미만 비밀번호 재설정은 API를 호출하지 않고 오류를 보여 준다', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('short');
    const calls = mockApi({ ...ADMIN, '/api/users': [{ id: 2, username: 'kim', role: 'viewer', disabled: false, createdAt: '' }] });
    renderWithProviders(<UsersPage />);
    const row = (await screen.findByText('kim')).closest('tr')!;
    await userEvent.setup().click(within(row).getByRole('button', { name: 'kim 비밀번호 재설정' }));
    expect(await screen.findByText('비밀번호는 10자 이상이어야 합니다')).toBeInTheDocument();
    expect(calls.some((c) => c.init.method === 'PATCH')).toBe(false);
  });

  it('목록·생성·비활성 토글', async () => {
    const calls = mockApi({
      ...ADMIN,
      '/api/users': [{ id: 1, username: 'admin', role: 'admin', disabled: false, createdAt: '' }, { id: 2, username: 'kim', role: 'viewer', disabled: false, createdAt: '' }],
      'POST /api/users': { id: 3, username: 'lee', role: 'viewer', disabled: false, createdAt: '' },
      'PATCH /api/users/2': { id: 2, username: 'kim', role: 'viewer', disabled: true, createdAt: '' },
    });
    renderWithProviders(<UsersPage />);
    const user = userEvent.setup();
    const kimRow = (await screen.findByText('kim')).closest('tr')!;
    await user.click(within(kimRow).getByRole('button', { name: 'kim 비활성화' }));
    await user.type(screen.getByLabelText('새 사용자명'), 'lee');
    await user.type(screen.getByLabelText('초기 비밀번호'), 'long-password-1');
    await user.click(screen.getByRole('button', { name: '계정 만들기' }));
    await waitFor(() => expect(calls.some((c) => c.init.method === 'POST' && c.url === '/api/users')).toBe(true));
    const patch = calls.find((c) => c.init.method === 'PATCH')!;
    expect(JSON.parse(String(patch.init.body))).toEqual({ disabled: true });
    expect(JSON.parse(String(calls.find((c) => c.init.method === 'POST')!.init.body))).toEqual({ username: 'lee', password: 'long-password-1', role: 'viewer' });
  });
});
