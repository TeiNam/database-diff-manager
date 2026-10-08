import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { useSchemaContext } from '../src/hooks/useSchemaContext';
import { json, LocationProbe, mockApi } from './render';

const VERSIONS = [
  { id: 12, versionNo: 2, uploadedAt: '2026-10-02T00:00:00Z', uploadedBy: 'admin', note: '컬럼 추가', sourceFormat: 'sql', changedObjects: 1 },
  { id: 11, versionNo: 1, uploadedAt: '2026-10-01T00:00:00Z', uploadedBy: 'admin', note: null, sourceFormat: 'sql', changedObjects: 33 },
];

function renderApp(route: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <App />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('인증 흐름', () => {
  it('로그인하지 않았으면 /login으로 보낸다', async () => {
    mockApi({ '/api/auth/me': json({ error: '로그인이 필요합니다' }, 401) });
    renderApp('/');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/login'));
    expect(screen.getByRole('heading', { name: 'Database Diff' })).toBeInTheDocument();
    expect(screen.getByText('MySQL ver.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', 'https://github.com/TeiNam');
    expect(screen.getByText(/Database Diff v\d+\.\d+\.\d+/)).toBeInTheDocument();
  });

  it('로그인 성공 → 홈, 실패 → 서버 메시지 표시', async () => {
    let loggedIn = false;
    const calls = mockApi({
      '/api/auth/me': () => (loggedIn ? { id: 1, username: 'admin', role: 'admin' } : json({ error: 'x' }, 401)),
      'POST /api/auth/login': (init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (body.password !== 'right-password') return json({ error: '사용자명 또는 비밀번호가 올바르지 않습니다' }, 401);
        loggedIn = true;
        return { id: 1, username: 'admin', role: 'admin' };
      },
      '/api/tree': [],
    });
    renderApp('/login');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('사용자명'), 'admin');
    await user.type(screen.getByLabelText('비밀번호'), 'wrong');
    await user.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('사용자명 또는 비밀번호가 올바르지 않습니다');
    await user.clear(screen.getByLabelText('비밀번호'));
    await user.type(screen.getByLabelText('비밀번호'), 'right-password');
    await user.click(screen.getByRole('button', { name: '로그인' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/));
    expect(calls.find((c) => c.url === '/api/auth/login')!.init.headers).toMatchObject({ 'X-Requested-With': 'tdm' });
  });
});

describe('세션 만료', () => {
  it('보호된 요청이 401이면 로그인 화면에 머문다', async () => {
    mockApi({
      '/api/auth/me': { id: 1, username: 'kim', role: 'viewer' },
      '/api/tree': json({ error: '로그인이 필요합니다' }, 401),
    });
    renderApp('/');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/login'));
    expect(await screen.findByRole('heading', { name: 'Database Diff' })).toBeInTheDocument();
    // 이전에는 남은 me 캐시 때문에 곧바로 홈으로 되돌아가 루프가 생겼다
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.getByTestId('location')).toHaveTextContent('/login');
  });
});

describe('상단바', () => {
  const ME = { '/api/auth/me': { id: 1, username: 'kim', role: 'viewer' }, '/api/tree': [] };

  it('스키마 경로에서 Database › Schema 이동 경로와 버전 선택기를 보여 주고, ⇄로 방향을 바꾼다', async () => {
    mockApi({
      ...ME,
      '/api/schemas/7': { id: 7, name: 'shop', databaseId: 3, databaseName: 'prod-db-01' },
      '/api/schemas/7/versions': VERSIONS,
      '/api/diff?base=11&target=12': json({ error: '생략' }, 500),
      '/api/diff?base=12&target=11': json({ error: '생략' }, 500),
    });
    renderApp('/db/3/schema/7?base=11&target=12');
    expect(await screen.findByText('prod-db-01')).toBeInTheDocument();
    expect(screen.getByText('shop')).toBeInTheDocument();
    expect(await screen.findByLabelText('BASE 버전')).toHaveValue('11');
    expect(screen.getByLabelText('TARGET 버전')).toHaveValue('12');
    await userEvent.setup().click(screen.getByRole('button', { name: 'BASE와 TARGET 바꾸기' }));
    expect(screen.getByTestId('location')).toHaveTextContent('base=12&target=11');
  });

  it('viewer에게는 업로드·계정 관리 버튼이 없고, 테마 토글이 동작한다', async () => {
    mockApi(ME);
    renderApp('/');
    expect(await screen.findByText('kim')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '업로드' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '계정 관리' })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /테마/ }));
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('dba 에게는 업로드 버튼만 있고 계정 관리 링크는 없다', async () => {
    mockApi({ ...ME, '/api/auth/me': { id: 3, username: 'park', role: 'dba' } });
    renderApp('/');
    expect(await screen.findByText('park')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '업로드' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '계정 관리' })).not.toBeInTheDocument();
  });

  it('admin 에게는 업로드 버튼과 계정 관리 링크가 있다', async () => {
    mockApi({ ...ME, '/api/auth/me': { id: 1, username: 'boss', role: 'admin' } });
    renderApp('/');
    expect(await screen.findByText('boss')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '업로드' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '계정 관리' })).toBeInTheDocument();
  });
});

describe('useSchemaContext.set', () => {
  function Probe() {
    const ctx = useSchemaContext();
    return <button type="button" onClick={() => { ctx.set({ base: 1 }); ctx.set({ target: 2 }); }}>둘다</button>;
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={['/db/1/schema/2?tab=ddl']}>{children}</MemoryRouter>
  );

  it('같은 틱의 연속 set 호출이 서로의 패치를 잃지 않는다', async () => {
    render(<MemoryRouter initialEntries={['/db/1/schema/2?tab=ddl']}><Probe /><LocationProbe /></MemoryRouter>);
    await userEvent.setup().click(screen.getByRole('button', { name: '둘다' }));
    const text = screen.getByTestId('location').textContent!;
    expect(text).toContain('/db/1/schema/2');
    expect(text).toContain('tab=ddl');
    expect(text).toContain('base=1');
    expect(text).toContain('target=2');
  });

  it('set 의 참조는 리렌더·URL 변경에도 바뀌지 않는다', () => {
    const { result, rerender } = renderHook(() => useSchemaContext(), { wrapper });
    const first = result.current.set;
    rerender();
    act(() => first({ base: 5 }));
    expect(result.current.base).toBe(5);
    expect(result.current.set).toBe(first);
  });
});

describe('VersionPicker 보강', () => {
  const API = {
    '/api/auth/me': { id: 1, username: 'kim', role: 'viewer' },
    '/api/tree': [{ id: 3, name: 'prod-db-01', schemas: [{ id: 7, name: 'shop' }] }],
    '/api/schemas/7': { id: 7, name: 'shop', databaseId: 3, databaseName: 'prod-db-01' },
    '/api/schemas/7/versions': VERSIONS,
  };

  it('다른 스키마 비교 대화상자: 열면 첫 필드 포커스, Esc로 닫으면 BASE로 포커스 복귀', async () => {
    mockApi(API);
    renderApp('/db/3/schema/7?base=11&target=12');
    const user = userEvent.setup();
    const base = await screen.findByLabelText('BASE 버전');
    await user.selectOptions(base, 'other');
    const dialog = await screen.findByRole('dialog', { name: '다른 스키마의 버전 선택' });
    expect(within(dialog).getByLabelText('Schema')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('BASE 버전')).toHaveFocus();
  });

  it('TARGET 이 목록에 없는 id 면 다른 스키마의 버전으로 표시한다', async () => {
    mockApi(API);
    renderApp('/db/3/schema/7?base=11&target=99');
    const target = await screen.findByLabelText('TARGET 버전');
    expect(within(target).getByRole('option', { name: '다른 스키마의 버전 #99' })).toBeInTheDocument();
    expect(target).toHaveValue('99');
  });

  it('목록에 없는 BASE 는 diff 응답의 메타로 "Schema 이름 v버전 · 날짜" 를 보여 준다', async () => {
    const meta = (id: number, schemaId: number, schemaName: string, versionNo: number, uploadedAt: string) => ({
      id, schemaId, schemaName, versionNo, uploadedAt, databaseId: 3, databaseName: 'prod-db-01', sourceFormat: 'sql', sourceFilename: 'x.sql', note: null, uploadedBy: 'admin',
    });
    const empty = { tables: [], views: [] };
    mockApi({
      ...API,
      '/api/diff?base=50&target=12': {
        base: meta(50, 9, 'legacy', 3, '2026-09-30T00:00:00Z'), target: meta(12, 7, 'shop', 2, '2026-10-02T00:00:00Z'),
        baseModel: empty, targetModel: empty, diff: { partial: false, tables: [], views: [], ignoredRenames: [], renameCandidates: [] }, statements: [], ddl: '', renames: [],
      },
    });
    renderApp('/db/3/schema/7?base=50&target=12');
    const base = await screen.findByLabelText('BASE 버전');
    expect(await within(base).findByRole('option', { name: 'legacy v3 · 2026-09-30' })).toBeInTheDocument();
    expect(base).toHaveValue('50');
  });

  it('base/target이 없으면 비활성 안내 옵션을 보여 준다', async () => {
    // 비교 화면은 버전이 오면 base/target 을 자동으로 채운다(그 전후 타이밍에 따라 결과가 달라짐).
    // 자동 선택이 없는 버전 이력 화면에서 확인한다
    mockApi(API);
    renderApp('/db/3/schema/7/history');
    const base = await screen.findByLabelText('BASE 버전');
    expect(base).toHaveValue('');
    expect(within(base).getByRole('option', { name: '버전 선택…' })).toBeDisabled();
    expect(screen.getByLabelText('TARGET 버전')).toHaveValue('');
  });
});
