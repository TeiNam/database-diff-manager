import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

// 리뷰 1회차: 파일 끌어다 놓기·읽기 실패, 스키마 기본값 대체값, 열린 스크립트 패널
describe('AlterDialog — 파일 끌어다 놓기·읽기 실패', () => {
  const dropBox = () => screen.getByLabelText('스크립트 파일').closest('label')!;
  const sqlFile = (name: string) => new File(['ALTER TABLE a ADD b INT;'], name, { type: 'text/plain' });

  it('.sql 파일을 점선 상자에 끌어다 놓으면 스크립트로 읽고 파일명을 보낸다 — 브라우저가 파일을 열어 버리지 않게 막는다', async () => {
    const calls = mockApi({ 'POST /api/versions/1/alter': PREVIEW });
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    const box = dropBox();
    const dragged = { dataTransfer: { files: [sqlFile('dropped.sql')] } };
    // fireEvent 는 기본 동작이 막히지 않았을 때만 true 를 돌려준다
    expect(fireEvent.dragOver(box, dragged)).toBe(false);
    expect(box).toHaveClass('dragging');
    expect(fireEvent.drop(box, dragged)).toBe(false);
    await waitFor(() => expect(screen.getByLabelText('ALTER 스크립트')).toHaveValue('ALTER TABLE a ADD b INT;'));
    expect(box).not.toHaveClass('dragging');
    await userEvent.setup().click(screen.getByRole('button', { name: '미리보기' }));
    await screen.findByRole('list', { name: '미리보기 결과' });
    expect(alterBodies(calls, 1)).toHaveLength(1);
    expect(alterBodies(calls, 1)[0]).toMatchObject({ script: 'ALTER TABLE a ADD b INT;', filename: 'dropped.sql', dryRun: true });
  });

  it('끌어다 놓은 파일이 .sql 이 아니면 읽지 않고 이유를 알린다 (끌어다 놓기는 파일 선택창의 accept 필터를 거치지 않는다)', async () => {
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    expect(fireEvent.drop(dropBox(), { dataTransfer: { files: [sqlFile('notes.txt')] } })).toBe(false);
    expect(await screen.findByRole('alert')).toHaveTextContent('notes.txt: .sql 파일만 받습니다');
    expect(screen.getByLabelText('ALTER 스크립트')).toHaveValue('');
  });

  it('파일을 읽지 못하면 이유를 알리고 기존 스크립트는 그대로 두며, 스크립트를 고치면 안내를 지운다', async () => {
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('ALTER 스크립트'), 'ALTER TABLE keep ADD x INT;');
    const unreadable = sqlFile('bad.sql');
    vi.spyOn(unreadable, 'text').mockRejectedValue(new Error('NotReadableError'));
    await user.upload(screen.getByLabelText('스크립트 파일'), unreadable);
    expect(await screen.findByRole('alert')).toHaveTextContent('bad.sql: 파일을 읽지 못했습니다 (NotReadableError)');
    expect(screen.getByLabelText('ALTER 스크립트')).toHaveValue('ALTER TABLE keep ADD x INT;');
    await user.type(screen.getByLabelText('ALTER 스크립트'), ' ');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('AlterDialog — 스키마 기본값 대체값', () => {
  it('ALTER 로 만든 버전이 없으면 MySQL 8 기본값(utf8mb4 / utf8mb4_0900_ai_ci)을 채워 보낸다', async () => {
    const calls = mockApi({ 'POST /api/versions/1/alter': PREVIEW });
    renderWithProviders(<AlterDialog versions={[version(3, 3, 'md'), version(1, 1, 'sql')]} onClose={() => undefined} />);
    expect(screen.getByLabelText('스키마 기본 문자셋')).toHaveValue('utf8mb4');
    expect(screen.getByLabelText('스키마 기본 콜레이션')).toHaveValue('utf8mb4_0900_ai_ci');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('ALTER 스크립트'), 'ALTER TABLE a ADD b INT;');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await screen.findByRole('list', { name: '미리보기 결과' });
    expect(alterBodies(calls, 1)[0].defaults).toEqual({ charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' });
  });
});

describe('HistoryPage — viewer 와 열린 스크립트 패널', () => {
  const route = { route: '/db/1/schema/7/history', path: '/db/:dbId/schema/:schemaId/history' };
  const SCRIPT = 'ALTER TABLE member ADD age INT;';
  const mockHistory = (me: { id: number; username: string; role: string }, versions: unknown) => mockApi({
    '/api/auth/me': me,
    '/api/schemas/7': { id: 7, name: 'shop', databaseId: 1, databaseName: 'db' },
    '/api/schemas/7/versions': versions,
    '/api/versions/12/derivation': { baseVersionId: 11, baseVersionNo: 1, script: SCRIPT, statementCount: 1, defaults: DERIVED.defaults },
    'DELETE /api/versions/12': { ok: true },
    'DELETE /api/versions/11': { ok: true },
  });
  afterEach(() => vi.restoreAllMocks());

  it('viewer 에게는 ALTER 적용 버튼이 없지만, 파생 버전의 기준 배지와 스크립트 보기는 열린다', async () => {
    mockHistory({ id: 4, username: 'kim', role: 'viewer' }, [version(12, 2, 'sql', { derivedFrom: DERIVED }), version(11, 1, 'sql')]);
    renderWithProviders(<HistoryPage />, route);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'ALTER 적용 (기준 v1)' }));
    expect(await screen.findByText(SCRIPT)).toBeInTheDocument();
    // 스크립트가 보일 즈음에는 먼저 요청한 me 응답도 반영되어 있다 (editor 판정을 느슨하게 바꾸면 아래 확인이 실패한다)
    expect(screen.queryByRole('button', { name: 'ALTER 적용' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Schema 삭제' })).not.toBeInTheDocument();
  });

  // 첫 목록 조회는 지우기 전, 이후 조회는 `after`. 패널을 연 채로 지운 뒤 `after` 목록의 tbody 행 수를 돌려준다
  async function deleteWithPanelOpen(after: VersionSummary[], deleteButton: string, settled: () => Promise<unknown>) {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let listed = 0;
    const before = [version(12, 2, 'sql', { derivedFrom: DERIVED }), version(11, 1, 'sql')];
    mockHistory({ id: 3, username: 'park', role: 'dba' }, () => (listed++ === 0 ? before : after));
    renderWithProviders(<HistoryPage />, route);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'ALTER 적용 (기준 v1)' }));
    expect(await screen.findByText(SCRIPT)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: deleteButton }));
    await settled();
    return screen.getByRole('table').querySelectorAll('tbody tr').length;
  }

  it('열려 있던 버전을 지우면 패널을 닫아, 같은 id 를 다시 쓴 SQL 버전에서 저절로 열리지 않는다', async () => {
    const rows = await deleteWithPanelOpen([version(12, 3, 'sql'), version(11, 1, 'sql')], 'v2 삭제', () => screen.findByText('v3'));
    expect(rows).toBe(2);
  });

  it('열려 있던 버전을 지우면 패널을 닫아, 같은 id 를 다시 쓴 파생 버전에서도 저절로 열리지 않는다', async () => {
    const reused = version(12, 3, 'sql', { derivedFrom: { ...DERIVED, baseVersionNo: 2 } });
    const rows = await deleteWithPanelOpen([reused, version(11, 1, 'sql')], 'v2 삭제', () => screen.findByText('v3'));
    expect(rows).toBe(2);
    expect(screen.getByRole('button', { name: 'ALTER 적용 (기준 v2)' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('다른 버전을 지운 뒤 열린 패널의 버전이 더 이상 파생 버전이 아니면 패널을 닫는다', async () => {
    const rows = await deleteWithPanelOpen([version(12, 2, 'sql')], 'v1 삭제', () => waitFor(() => expect(screen.queryByText('v1')).not.toBeInTheDocument()));
    expect(rows).toBe(1);
  });
});
