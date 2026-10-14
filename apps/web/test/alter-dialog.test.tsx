import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VersionSummary } from '../src/api/types';
import { AlterDialog } from '../src/features/alter/AlterDialog';
import { HistoryPage } from '../src/pages/HistoryPage';
import { alterBodies, DERIVED, fingerprint, mockAlterApi, NO_SUGGESTION, PREVIEW, previewOf, SAVED, version } from './alter-fixtures';
import { json, mockApi, renderWithProviders } from './render';

describe('AlterDialog', () => {
  it('SQL 버전만 기준으로 고르고(기본: 최신), 미리보기 뒤에만 저장한다 — 스키마 기본값은 마지막 ALTER 적용 값', async () => {
    const calls = mockApi({
      'POST /api/versions/3/alter': (init: RequestInit) => (JSON.parse(String(init.body)).dryRun
        ? { ...previewOf(3), changes: [{ kind: 'table', name: 'member', op: 'modify' }] }
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
      // 저장은 미리보기가 돌려준 기준 버전 지문을 함께 보낸다
      { script: 'ALTER TABLE member ADD COLUMN nick VARCHAR(20);', dryRun: false, defaults: { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' }, expectedBase: fingerprint(3) },
    ]);
  });

  it('실패하면 서버 메시지(문장 번호·줄)를 보여 주고, 스크립트를 고치면 미리보기를 지운다', async () => {
    const fail = () => new Response(JSON.stringify({ error: '1번째 문장 (줄 1): 컬럼 `id` 이 두 번 있습니다 (MySQL 1060)' }), { status: 400, headers: { 'content-type': 'application/json' } });
    mockAlterApi({ 'POST /api/versions/1/alter': fail });
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('ALTER 스크립트'), 'ALTER TABLE member ADD id INT;');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('1번째 문장 (줄 1)');
    await user.type(screen.getByLabelText('ALTER 스크립트'), ' ');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('입력 검증 실패(zod)는 첫 번째 이유도 함께 보여 준다', async () => {
    const details = [{ path: 'defaults.charset', message: '문자셋·콜레이션 이름은 영문·숫자·_ 만 쓸 수 있습니다' }, { path: 'script', message: '두 번째' }];
    mockAlterApi({ 'POST /api/versions/1/alter': () => new Response(JSON.stringify({ error: '입력값이 올바르지 않습니다', details }), { status: 400, headers: { 'content-type': 'application/json' } }) });
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('ALTER 스크립트'), 'ALTER TABLE member ADD x INT;');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('입력값이 올바르지 않습니다: 문자셋·콜레이션 이름은 영문·숫자·_ 만 쓸 수 있습니다');
    expect(alert).not.toHaveTextContent('두 번째');
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

describe('AlterDialog — 입력과 결과 처리', () => {
  it('.sql 파일을 고르면 스크립트·파일명·메모를 함께 보내고, 스크립트를 직접 고치면 파일명은 뺀다', async () => {
    const calls = mockAlterApi({ 'POST /api/versions/1/alter': PREVIEW });
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
    const calls = mockAlterApi({ 'POST /api/versions/3/alter': previewOf(3), 'POST /api/versions/1/alter': PREVIEW });
    renderWithProviders(<AlterDialog versions={[version(3, 3, 'sql'), version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('ALTER 스크립트'), 'ALTER TABLE a ADD b INT;');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await screen.findByRole('list', { name: '미리보기 결과' });
    await user.selectOptions(screen.getByLabelText('기준 버전'), '1');
    expect(screen.queryByRole('list', { name: '미리보기 결과' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
    // 새 기준 버전의 기본 문자셋 제안이 올 때까지 미리보기는 잠겨 있다
    await waitFor(() => expect(screen.getByRole('button', { name: '미리보기' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await screen.findByRole('list', { name: '미리보기 결과' });
    expect(calls.filter((c) => c.init.method === 'POST').map((c) => c.url)).toEqual(['/api/versions/3/alter', '/api/versions/1/alter']);
  });

  it('같은 내용의 버전이 이미 있으면 새로 만들지 않고 그 버전을 알려 준다', async () => {
    const duplicate = { status: 'duplicate', versionId: 5, versionNo: 3, applied: 1, changes: [] };
    mockAlterApi({ 'POST /api/versions/1/alter': (init: RequestInit) => (JSON.parse(String(init.body)).dryRun ? PREVIEW : duplicate) });
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
    const calls = mockAlterApi({ 'POST /api/versions/1/alter': PREVIEW });
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
    mockAlterApi({});
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    expect(fireEvent.drop(dropBox(), { dataTransfer: { files: [sqlFile('notes.txt')] } })).toBe(false);
    expect(await screen.findByRole('alert')).toHaveTextContent('notes.txt: .sql 파일만 받습니다');
    expect(screen.getByLabelText('ALTER 스크립트')).toHaveValue('');
  });

  it('파일을 읽지 못하면 이유를 알리고 기존 스크립트는 그대로 두며, 스크립트를 고치면 안내를 지운다', async () => {
    mockAlterApi({});
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('ALTER 스크립트'), 'ALTER TABLE keep ADD x INT;');
    const unreadable = sqlFile('bad.sql');
    // 파일 바이트를 읽는 단계(arrayBuffer)에서 실패한다
    vi.spyOn(unreadable, 'arrayBuffer').mockRejectedValue(new Error('NotReadableError'));
    await user.upload(screen.getByLabelText('스크립트 파일'), unreadable);
    expect(await screen.findByRole('alert')).toHaveTextContent('bad.sql: 파일을 읽지 못했습니다 (NotReadableError)');
    expect(screen.getByLabelText('ALTER 스크립트')).toHaveValue('ALTER TABLE keep ADD x INT;');
    await user.type(screen.getByLabelText('ALTER 스크립트'), ' ');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('입력 검증 실패(zod)는 첫 번째 이유도 함께 보여 준다', async () => {
    const details = [{ path: 'defaults.charset', message: '문자셋·콜레이션 이름은 영문·숫자·_ 만 쓸 수 있습니다' }, { path: 'script', message: '두 번째' }];
    mockAlterApi({ 'POST /api/versions/1/alter': () => new Response(JSON.stringify({ error: '입력값이 올바르지 않습니다', details }), { status: 400, headers: { 'content-type': 'application/json' } }) });
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('ALTER 스크립트'), 'ALTER TABLE member ADD x INT;');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('입력값이 올바르지 않습니다: 문자셋·콜레이션 이름은 영문·숫자·_ 만 쓸 수 있습니다');
    expect(alert).not.toHaveTextContent('두 번째');
  });
});

describe('AlterDialog — 스키마 기본값 대체값', () => {
  it('ALTER 로 만든 버전이 없으면 MySQL 8 기본값(utf8mb4 / utf8mb4_0900_ai_ci)을 채워 보낸다', async () => {
    const calls = mockAlterApi({ 'POST /api/versions/1/alter': PREVIEW });
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

// 2way 리뷰 1회차 (web)
const asBytes = (text: string) => [...new TextEncoder().encode(text)];
const scriptFile = (name: string, bytes: number[]) => new File([new Uint8Array(bytes)], name, { type: 'text/plain' });

describe('AlterDialog — 파일 인코딩', () => {
  it('UTF-8 이 아닌 파일(CP949)은 깨진 글자로 바꿔 읽지 않고 이유를 알리며, 지금 스크립트는 그대로 둔다', async () => {
    mockAlterApi({});
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('ALTER 스크립트'), 'ALTER TABLE keep ADD x INT;');
    // CP949 로 저장한 '닉네임' = B4D0 B3D7 C0D3 — UTF-8 로는 올바르지 않은 바이트열이다 (file.text() 는 이를 U+FFFD 로 바꿔 읽는다)
    const cp949 = scriptFile('cp949.sql', [...asBytes("ALTER TABLE member ADD nick INT COMMENT '"), 0xb4, 0xd0, 0xb3, 0xd7, 0xc0, 0xd3, ...asBytes("';")]);
    await user.upload(screen.getByLabelText('스크립트 파일'), cp949);
    expect(await screen.findByRole('alert')).toHaveTextContent('cp949.sql: UTF-8로 인코딩된 파일만 받습니다');
    expect(screen.getByLabelText('ALTER 스크립트')).toHaveValue('ALTER TABLE keep ADD x INT;');
    // 스크립트를 고치면 안내를 지운다
    await user.type(screen.getByLabelText('ALTER 스크립트'), ' ');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('UTF-8 로 저장한 한글 주석은 그대로 읽고, 앞의 BOM 은 떼어 낸다', async () => {
    mockAlterApi({});
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    const script = "ALTER TABLE member ADD nick INT COMMENT '닉네임';";
    await userEvent.setup().upload(screen.getByLabelText('스크립트 파일'), scriptFile('utf8.sql', [0xef, 0xbb, 0xbf, ...asBytes(script)]));
    await waitFor(() => expect(screen.getByLabelText('ALTER 스크립트')).toHaveValue(script));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('끌어다 놓은 UTF-8 아닌 파일도 같은 이유로 받지 않는다', async () => {
    mockAlterApi({});
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    const dropped = { dataTransfer: { files: [scriptFile('latin1.sql', [...asBytes('ALTER TABLE a COMMENT \''), 0xe9, ...asBytes("';")])] } };
    fireEvent.drop(screen.getByLabelText('스크립트 파일').closest('label')!, dropped);
    expect(await screen.findByRole('alert')).toHaveTextContent('latin1.sql: UTF-8로 인코딩된 파일만 받습니다');
    expect(screen.getByLabelText('ALTER 스크립트')).toHaveValue('');
  });
});

describe('AlterDialog — 저장하는 동안', () => {
  it('저장 요청이 가는 동안에는 메모를 고칠 수 없어, 보낸 메모와 화면의 메모가 어긋나지 않는다', async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const calls = mockAlterApi({
      'POST /api/versions/1/alter': async (init: RequestInit) => {
        if (JSON.parse(String(init.body)).dryRun) return PREVIEW;
        await held;
        return SAVED;
      },
    });
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('ALTER 스크립트'), 'ALTER TABLE a ADD b INT;');
    await user.type(screen.getByLabelText('메모'), 'first note');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await screen.findByRole('list', { name: '미리보기 결과' });
    await user.click(screen.getByRole('button', { name: '저장' }));
    const memo = screen.getByLabelText('메모');
    await waitFor(() => expect(memo).toBeDisabled());
    finish();
    expect(await screen.findByText('v2 생성')).toBeInTheDocument();
    expect(memo).toBeEnabled();
    expect(memo).toHaveValue('first note');
    expect(alterBodies(calls, 1).at(-1)).toMatchObject({ dryRun: false, note: 'first note' });
  });
});

describe('AlterDialog — 스키마가 바뀌거나 기준 버전이 사라질 때', () => {
  const route = { route: '/db/1/schema/7/history', path: '/db/:dbId/schema/:schemaId/history' };

  function GoTo({ to }: { to: string }) {
    const navigate = useNavigate();
    return <button type="button" onClick={() => navigate(to)}>이동</button>;
  }

  it('대화상자를 연 채 다른 스키마의 이력으로 이동하면 닫는다 — 이전 스키마의 버전에 저장하지 않고, 다시 열면 빈 상태에서 새 스키마로 시작한다', async () => {
    const calls = mockAlterApi({
      '/api/auth/me': { id: 3, username: 'park', role: 'dba' },
      '/api/schemas/7': { id: 7, name: 'shop', databaseId: 1, databaseName: 'db' },
      '/api/schemas/8': { id: 8, name: 'other', databaseId: 1, databaseName: 'db' },
      '/api/schemas/7/versions': [version(1, 1, 'sql')],
      '/api/schemas/8/versions': [version(2, 1, 'sql', { schemaId: 8, schemaName: 'other', sourceFilename: 'other-v1.sql' })],
      'GET /api/versions/2/alter-defaults': NO_SUGGESTION,
      'POST /api/versions/1/alter': PREVIEW,
      'POST /api/versions/2/alter': previewOf(1, { schemaId: 8 }),
    });
    renderWithProviders(<><HistoryPage /><GoTo to="/db/1/schema/8/history" /></>, route);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'ALTER 적용' }));
    await user.type(screen.getByLabelText('ALTER 스크립트'), 'ALTER TABLE member ADD c INT;');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await screen.findByRole('list', { name: '미리보기 결과' });
    await user.click(screen.getByRole('button', { name: '이동' }));
    expect(await screen.findByRole('heading', { name: '버전 이력 · db › other' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'ALTER 적용' }));
    expect(screen.getByLabelText('기준 버전')).toHaveValue('2');
    expect(screen.getByLabelText('ALTER 스크립트')).toHaveValue('');
    expect(screen.queryByRole('list', { name: '미리보기 결과' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
    // 이동한 뒤에는 이전 스키마의 버전으로 가는 요청이 없다
    expect(calls.filter((c) => c.init.method === 'POST').map((c) => c.url)).toEqual(['/api/versions/1/alter']);
  });

  it('고른 기준 버전이 목록에서 사라지면 미리보기를 지우고 미리보기·저장을 막는다 — 화면의 버전과 요청 대상이 어긋나지 않는다', async () => {
    const calls = mockAlterApi({ 'POST /api/versions/3/alter': previewOf(3), 'POST /api/versions/1/alter': PREVIEW });
    function Harness() {
      const [versions, setVersions] = useState([version(3, 3, 'sql'), version(1, 1, 'sql')]);
      return (
        <>
          <AlterDialog versions={versions} onClose={() => undefined} />
          <button type="button" onClick={() => setVersions([version(1, 1, 'sql')])}>v3 지워짐</button>
        </>
      );
    }
    renderWithProviders(<Harness />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('ALTER 스크립트'), 'ALTER TABLE a ADD b INT;');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await screen.findByRole('list', { name: '미리보기 결과' });
    await user.click(screen.getByRole('button', { name: 'v3 지워짐' }));
    expect(screen.queryByRole('list', { name: '미리보기 결과' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '미리보기' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('선택한 기준 버전이 목록에 없습니다');
    // 목록에 없는 버전을 가리킨 채 다른 버전이 골라진 것처럼 보이지 않는다
    expect(screen.getByLabelText('기준 버전')).toHaveValue('');
    await user.selectOptions(screen.getByLabelText('기준 버전'), '1');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: '미리보기' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await screen.findByRole('list', { name: '미리보기 결과' });
    expect(calls.filter((c) => c.init.method === 'POST').map((c) => c.url)).toEqual(['/api/versions/3/alter', '/api/versions/1/alter']);
  });
});

describe('AlterDialog — 스키마 기본값 제안', () => {
  const GENERAL = { defaults: { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' } };
  const LATIN1 = { defaults: { charset: 'latin1', collation: 'latin1_swedish_ci' } };
  const charsetField = () => screen.getByLabelText('스키마 기본 문자셋');
  const collationField = () => screen.getByLabelText('스키마 기본 콜레이션');
  const renderDialog = (versions = [version(1, 1, 'sql')]) => renderWithProviders(<AlterDialog versions={versions} onClose={() => undefined} />);
  const previewScript = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(screen.getByLabelText('ALTER 스크립트'), 'ALTER TABLE a ADD b INT;');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await screen.findByRole('list', { name: '미리보기 결과' });
  };

  it('ALTER 로 만든 버전이 없으면 기준 버전 테이블의 최빈 문자셋·콜레이션을 채워 보낸다', async () => {
    const calls = mockApi({ 'GET /api/versions/1/alter-defaults': GENERAL, 'POST /api/versions/1/alter': PREVIEW });
    renderDialog();
    await waitFor(() => expect(collationField()).toHaveValue('utf8mb4_general_ci'));
    expect(charsetField()).toHaveValue('utf8mb4');
    await previewScript(userEvent.setup());
    expect(alterBodies(calls, 1)[0].defaults).toEqual({ charset: 'utf8mb4', collation: 'utf8mb4_general_ci' });
  });

  it('기준 버전을 바꾸고 칸을 고치지 않았다면 새 기준 버전의 제안을 따른다', async () => {
    const calls = mockApi({ 'GET /api/versions/3/alter-defaults': GENERAL, 'GET /api/versions/1/alter-defaults': LATIN1, 'POST /api/versions/1/alter': PREVIEW });
    renderDialog([version(3, 3, 'sql'), version(1, 1, 'sql')]);
    await waitFor(() => expect(collationField()).toHaveValue('utf8mb4_general_ci'));
    await userEvent.setup().selectOptions(screen.getByLabelText('기준 버전'), '1');
    await waitFor(() => expect(collationField()).toHaveValue('latin1_swedish_ci'));
    expect(charsetField()).toHaveValue('latin1');
    expect(calls.map((c) => c.url)).toContain('/api/versions/1/alter-defaults');
  });

  it('제안을 기다리는 동안에는 두 칸을 잠그고 미리보기를 막는다 — MySQL 기본값으로 먼저 미리보기가 나가지 않는다', async () => {
    let answer!: () => void;
    const held = new Promise<void>((resolve) => { answer = resolve; });
    const calls = mockApi({
      'GET /api/versions/1/alter-defaults': async () => {
        await held;
        return LATIN1;
      },
      'POST /api/versions/1/alter': PREVIEW,
    });
    renderDialog();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('ALTER 스크립트'), 'ALTER TABLE a ADD b INT;');
    expect(screen.getByRole('button', { name: '미리보기' })).toBeDisabled();
    expect(charsetField()).toBeDisabled();
    expect(collationField()).toBeDisabled();
    expect(calls.filter((c) => c.url.endsWith('/alter'))).toHaveLength(0);
    answer();
    await waitFor(() => expect(screen.getByRole('button', { name: '미리보기' })).toBeEnabled());
    expect(charsetField()).toBeEnabled();
    expect(charsetField()).toHaveValue('latin1');
    expect(collationField()).toHaveValue('latin1_swedish_ci');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await screen.findByRole('list', { name: '미리보기 결과' });
    expect(alterBodies(calls, 1)[0].defaults).toEqual({ charset: 'latin1', collation: 'latin1_swedish_ci' });
  });

  it('제안을 읽지 못하면 이유를 알리고, MySQL 8 기본값으로 이어서 할 수 있다 — 칸을 직접 정하면 안내를 지운다', async () => {
    const calls = mockApi({
      'GET /api/versions/1/alter-defaults': () => json({ error: '버전을 찾을 수 없습니다' }, 404),
      'POST /api/versions/1/alter': PREVIEW,
    });
    renderDialog();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('기준 버전의 기본 문자셋을 읽지 못해 MySQL 8 기본값을 채웠습니다');
    expect(alert).toHaveTextContent('버전을 찾을 수 없습니다');
    expect(charsetField()).toHaveValue('utf8mb4');
    expect(collationField()).toHaveValue('utf8mb4_0900_ai_ci');
    const user = userEvent.setup();
    await previewScript(user);
    expect(alterBodies(calls, 1)[0].defaults).toEqual({ charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' });
    fireEvent.change(collationField(), { target: { value: 'utf8mb4_bin' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('ALTER 로 만든 버전이 있으면 그 값을 쓰고 기준 버전에 묻지 않는다', async () => {
    const calls = mockApi({ 'POST /api/versions/3/alter': previewOf(3) });
    renderDialog([version(3, 3, 'sql', { derivedFrom: DERIVED }), version(1, 1, 'sql')]);
    expect(collationField()).toHaveValue('utf8mb4_general_ci');
    await userEvent.setup().type(screen.getByLabelText('ALTER 스크립트'), 'ALTER TABLE a ADD b INT;');
    await userEvent.setup().click(screen.getByRole('button', { name: '미리보기' }));
    await screen.findByRole('list', { name: '미리보기 결과' });
    expect(calls.filter((c) => c.url.endsWith('/alter-defaults'))).toHaveLength(0);
  });

  it('문자셋을 바꾸면 콜레이션을 그 문자셋의 기본으로 맞춘다 — 문자셋만 바꿔도 1253 으로 막히지 않는다', async () => {
    const calls = mockApi({ 'GET /api/versions/1/alter-defaults': GENERAL, 'POST /api/versions/1/alter': PREVIEW });
    renderDialog();
    await waitFor(() => expect(collationField()).toHaveValue('utf8mb4_general_ci'));
    const user = userEvent.setup();
    await user.clear(charsetField());
    await user.type(charsetField(), 'latin1');
    expect(collationField()).toHaveValue('latin1_swedish_ci');
    await previewScript(user);
    expect(alterBodies(calls, 1)[0].defaults).toEqual({ charset: 'latin1', collation: 'latin1_swedish_ci' });
  });

  it('콜레이션이 이미 새 문자셋의 것이면 그대로 두고, 알 수 없는 문자셋·binary 는 콜레이션을 건드리지 않는다', async () => {
    mockApi({ 'GET /api/versions/1/alter-defaults': GENERAL });
    renderDialog();
    await waitFor(() => expect(collationField()).toHaveValue('utf8mb4_general_ci'));
    fireEvent.change(charsetField(), { target: { value: 'UTF8MB4' } });
    expect(collationField()).toHaveValue('utf8mb4_general_ci');
    fireEvent.change(charsetField(), { target: { value: 'klingon' } });
    expect(collationField()).toHaveValue('utf8mb4_general_ci');
    fireEvent.change(charsetField(), { target: { value: 'binary' } });
    expect(collationField()).toHaveValue('utf8mb4_general_ci');
    fireEvent.change(charsetField(), { target: { value: 'euckr' } });
    expect(collationField()).toHaveValue('euckr_korean_ci');
  });
});
