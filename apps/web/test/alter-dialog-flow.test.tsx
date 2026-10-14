import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { VersionSummary } from '../src/api/types';
import { AlterDialog } from '../src/features/alter/AlterDialog';
import { HistoryPage } from '../src/pages/HistoryPage';
import { alterBodies, DERIVED, fingerprint, mockAlterApi, NO_SUGGESTION, PREVIEW, previewOf, SAVED, version } from './alter-fixtures';
import { json, mockApi, renderWithProviders } from './render';

// 2way 리뷰 2회차 (web): 저장 중 입력 잠금(R2-04·M-3), 기본값이 바뀌면 미리보기 무효화(R2-03),
// 문자셋 칸을 고치는 동안 콜레이션(M-2), 저장한 뒤 기준 버전(M-4)
// 2way 리뷰 3회차 (web): 중복 응답이 받아 둔 목록에 없는 버전을 가리킬 때의 기준 버전(R3-01)
// 2way 리뷰 4회차 (web): 기준 버전 지문 — 행 ID 가 지운 뒤 다시 쓰여도 미리보기가 다른 버전에 저장되지 않는다(R4-01)
type User = ReturnType<typeof userEvent.setup>;

const SCRIPT = 'ALTER TABLE a ADD b INT;';
const editor = () => screen.getByLabelText('ALTER 스크립트');
const previewButton = () => screen.getByRole('button', { name: '미리보기' });
const saveButton = () => screen.getByRole('button', { name: '저장' });
const charsetField = () => screen.getByLabelText('스키마 기본 문자셋');
const collationField = () => screen.getByLabelText('스키마 기본 콜레이션');
const baseSelect = () => screen.getByLabelText('기준 버전');
const previewList = () => screen.queryByRole('list', { name: '미리보기 결과' });
const runPreview = async (user: User, script = SCRIPT) => {
  await user.clear(editor());
  await user.type(editor(), script);
  await user.click(previewButton());
  await screen.findByRole('list', { name: '미리보기 결과' });
};
const sqlFile = (name: string) => new File([SCRIPT], name, { type: 'text/plain' });
const isSaveRequest = (init: RequestInit) => !JSON.parse(String(init.body)).dryRun;

describe('AlterDialog — 저장하는 동안 스크립트·파일 입력 잠금', () => {
  const dropBox = () => screen.getByLabelText('스크립트 파일').closest('label')!;

  // 미리보기를 마친 대화상자. 저장 응답은 releaseSave() 를 부를 때까지 붙잡아 둔다
  async function previewed() {
    let releaseSave!: () => void;
    const held = new Promise<void>((resolve) => { releaseSave = resolve; });
    const calls = mockAlterApi({
      'POST /api/versions/1/alter': async (init: RequestInit) => {
        if (!isSaveRequest(init)) return PREVIEW;
        await held;
        return SAVED;
      },
    });
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await runPreview(user);
    return { user, calls, releaseSave };
  }
  // 저장을 눌러 요청이 나간(칸이 잠긴) 상태까지
  async function saving() {
    const state = await previewed();
    await state.user.click(saveButton());
    await waitFor(() => expect(screen.getByLabelText('메모')).toBeDisabled());
    return state;
  }

  it('저장 요청이 가는 동안에는 스크립트 칸과 파일 입력도 잠기고, 끝나면 풀린다', async () => {
    const { releaseSave } = await saving();
    expect(editor()).toBeDisabled();
    expect(screen.getByLabelText('스크립트 파일')).toBeDisabled();
    expect(dropBox()).toHaveClass('dropDisabled'); // label 은 disabled 가 없어 모양으로 잠긴 것을 보인다
    releaseSave();
    expect(await screen.findByText('v2 생성')).toBeInTheDocument();
    expect(editor()).toBeEnabled();
    expect(screen.getByLabelText('스크립트 파일')).toBeEnabled();
    expect(dropBox()).not.toHaveClass('dropDisabled');
  });

  it('잠긴 동안 스크립트를 바꾸는 이벤트가 와도 반영하지 않아, 저장 결과가 그대로 나오고 저장 요청은 한 번뿐이다', async () => {
    const { calls, releaseSave } = await saving();
    fireEvent.change(editor(), { target: { value: 'ALTER TABLE a ADD c INT;' } });
    expect(editor()).toHaveValue(SCRIPT);
    // 진행 중인 요청의 잠금이 풀리지 않는다
    expect(previewButton()).toBeDisabled();
    expect(screen.getByLabelText('메모')).toBeDisabled();
    releaseSave();
    expect(await screen.findByText('v2 생성')).toBeInTheDocument();
    expect(alterBodies(calls, 1).filter((body) => body.dryRun === false)).toHaveLength(1);
  });

  it('잠긴 동안 끌어다 놓은 파일은 스크립트를 바꾸지 않고 이유를 알린다', async () => {
    const { releaseSave } = await saving();
    fireEvent.drop(dropBox(), { dataTransfer: { files: [sqlFile('late.sql')] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('late.sql');
    expect(editor()).toHaveValue(SCRIPT);
    releaseSave();
    expect(await screen.findByText('v2 생성')).toBeInTheDocument();
  });

  it('저장하기 전에 읽기 시작한 파일이 저장 중에 다 읽혀도 스크립트를 바꾸지 않는다', async () => {
    const { user, releaseSave } = await previewed();
    const slow = sqlFile('slow.sql');
    let finishRead!: (bytes: ArrayBuffer) => void;
    vi.spyOn(slow, 'arrayBuffer').mockReturnValue(new Promise<ArrayBuffer>((resolve) => { finishRead = resolve; }));
    fireEvent.drop(dropBox(), { dataTransfer: { files: [slow] } }); // 읽기를 시작한다 (아직 끝나지 않는다)
    await user.click(saveButton());
    await waitFor(() => expect(screen.getByLabelText('메모')).toBeDisabled());
    finishRead(new TextEncoder().encode('ALTER TABLE a ADD z INT;').buffer as ArrayBuffer);
    expect(await screen.findByRole('alert')).toHaveTextContent('slow.sql');
    expect(editor()).toHaveValue(SCRIPT);
    releaseSave();
    expect(await screen.findByText('v2 생성')).toBeInTheDocument();
  });
});

// 목록(versions)을 바꿔 보이는 틀. 버튼으로 다른 사용자가 저장·삭제해 목록을 다시 받은 상황을 만든다
function ListHarness({ initial, next }: { initial: VersionSummary[]; next: VersionSummary[] }) {
  const [versions, setVersions] = useState(initial);
  return (
    <>
      <AlterDialog versions={versions} onClose={() => undefined} />
      <button type="button" onClick={() => setVersions(next)}>목록 바꾸기</button>
      <button type="button" onClick={() => setVersions(initial)}>목록 되돌리기</button>
    </>
  );
}

describe('AlterDialog — 기본값이 바뀌면 미리보기를 지운다', () => {
  const GENERAL = { defaults: { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' } };
  const LATIN1 = { baseVersionNo: 1, statementCount: 1, defaults: { charset: 'latin1', collation: 'latin1_swedish_ci' } };

  it('목록을 다시 받아 제안 기본값이 바뀌면 미리보기를 지우고 저장을 막는다 — 새 미리보기를 내야 저장할 수 있다', async () => {
    const calls = mockApi({ 'GET /api/versions/1/alter-defaults': GENERAL, 'POST /api/versions/1/alter': PREVIEW });
    renderWithProviders(<ListHarness initial={[version(1, 1, 'sql')]} next={[version(2, 2, 'sql', { derivedFrom: LATIN1 }), version(1, 1, 'sql')]} />);
    const user = userEvent.setup();
    await waitFor(() => expect(collationField()).toHaveValue('utf8mb4_general_ci'));
    await runPreview(user);
    expect(saveButton()).toBeEnabled();

    // 다른 사용자가 latin1 로 파생 버전을 저장해, 목록을 다시 받으면 제안 기본값이 바뀐다
    await user.click(screen.getByRole('button', { name: '목록 바꾸기' }));
    expect(charsetField()).toHaveValue('latin1');
    expect(previewList()).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    // 그 버전이 지워져 기본값이 원래대로 돌아와도, 지운 미리보기는 되살아나지 않는다
    await user.click(screen.getByRole('button', { name: '목록 되돌리기' }));
    await waitFor(() => expect(charsetField()).toHaveValue('utf8mb4'));
    expect(previewList()).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    await user.click(previewButton());
    await screen.findByRole('list', { name: '미리보기 결과' });
    expect(saveButton()).toBeEnabled();
    expect(alterBodies(calls, 1).map((body) => body.defaults)).toEqual([GENERAL.defaults, GENERAL.defaults]);
  });

  it('기본값 칸을 직접 고쳐도 미리보기를 지운다', async () => {
    mockApi({ 'GET /api/versions/1/alter-defaults': GENERAL, 'POST /api/versions/1/alter': PREVIEW });
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await waitFor(() => expect(collationField()).toHaveValue('utf8mb4_general_ci'));
    await runPreview(user);
    fireEvent.change(collationField(), { target: { value: 'utf8mb4_bin' } });
    expect(previewList()).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });
});

describe('AlterDialog — 문자셋 칸을 고치는 동안 콜레이션이 흘러가지 않는다', () => {
  const UNICODE = { defaults: { charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' } };
  async function renderUnicode() {
    const calls = mockApi({ 'GET /api/versions/1/alter-defaults': UNICODE, 'POST /api/versions/1/alter': PREVIEW });
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    await waitFor(() => expect(collationField()).toHaveValue('utf8mb4_unicode_ci'));
    return calls;
  }

  it('utf8(utf8mb3 의 별칭)을 지나 원래 문자셋을 다시 쓰면 콜레이션이 원래 값으로 돌아온다', async () => {
    await renderUnicode();
    const trail: string[] = [];
    for (const typed of ['utf8mb', 'utf8m', 'utf8', 'utf8m', 'utf8mb', 'utf8mb4']) {
      fireEvent.change(charsetField(), { target: { value: typed } });
      trail.push(`${typed} → ${(collationField() as HTMLInputElement).value}`);
    }
    expect(trail).toEqual([
      'utf8mb → utf8mb4_unicode_ci',
      'utf8m → utf8mb4_unicode_ci',
      'utf8 → utf8mb3_general_ci', // 입력 도중에는 별칭이 가리키는 문자셋의 기본 콜레이션이 보인다
      'utf8m → utf8mb4_unicode_ci',
      'utf8mb → utf8mb4_unicode_ci',
      'utf8mb4 → utf8mb4_unicode_ci',
    ]);
  });

  it('칸을 지우고 처음부터 다시 쓰고(글자마다 입력) 미리보기를 내면 원래 콜레이션으로 보낸다', async () => {
    const calls = await renderUnicode();
    const user = userEvent.setup();
    await user.clear(charsetField());
    await user.type(charsetField(), 'utf8mb4');
    expect(collationField()).toHaveValue('utf8mb4_unicode_ci');
    await runPreview(user);
    expect(alterBodies(calls, 1)[0].defaults).toEqual({ charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' });
  });

  it('다른 문자셋으로 바꾸면 그 문자셋의 기본 콜레이션을 쓰고, 다시 원래 문자셋으로 돌아오면 원래 콜레이션이다', async () => {
    await renderUnicode();
    fireEvent.change(charsetField(), { target: { value: 'latin1' } });
    expect(collationField()).toHaveValue('latin1_swedish_ci');
    fireEvent.change(charsetField(), { target: { value: 'utf8mb4' } });
    expect(collationField()).toHaveValue('utf8mb4_unicode_ci');
  });

  it('콜레이션 칸은 쓰는 그대로 두고, 사용자가 정한 콜레이션이 다음 문자셋 변경의 기준이 된다', async () => {
    await renderUnicode();
    const user = userEvent.setup();
    fireEvent.change(charsetField(), { target: { value: 'latin1' } });
    await user.clear(collationField());
    await user.type(collationField(), 'lat');
    expect(collationField()).toHaveValue('lat'); // 알 수 없는 이름이어도 쓰는 도중에 바뀌지 않는다
    await user.type(collationField(), 'in1_bin');
    expect(collationField()).toHaveValue('latin1_bin');
    fireEvent.change(charsetField(), { target: { value: 'utf8mb4' } });
    expect(collationField()).toHaveValue('utf8mb4_0900_ai_ci'); // latin1_bin 은 utf8mb4 의 것이 아니다
    fireEvent.change(charsetField(), { target: { value: 'latin1' } });
    expect(collationField()).toHaveValue('latin1_bin');
  });
});

describe('AlterDialog — 저장한 뒤 기준 버전', () => {
  // 저장하면 id 10(v2) 가 생긴다 (SAVED). 목록이 다시 오면 그 버전이 맨 앞에 있다. 파생 버전의 기본값은 제안(MySQL 8)과 같게 둔다
  const CREATED = version(10, 2, 'sql', { derivedFrom: { ...DERIVED, defaults: { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' } } });
  const saveFrom = (baseOfSave: number, extra: Record<string, unknown> = {}) => mockAlterApi({
    [`POST /api/versions/${baseOfSave}/alter`]: (init: RequestInit) => (isSaveRequest(init) ? SAVED : PREVIEW),
    'POST /api/versions/10/alter': previewOf(2),
    ...extra,
  });

  it('저장하면 새 버전이 목록에 오는 대로 기준 버전이 그 버전으로 옮겨져, 이어 쓴 스크립트가 그 위에 적용된다', async () => {
    const calls = saveFrom(1);
    renderWithProviders(<ListHarness initial={[version(1, 1, 'sql')]} next={[CREATED, version(1, 1, 'sql')]} />);
    const user = userEvent.setup();
    await waitFor(() => expect(charsetField()).toBeEnabled());
    await runPreview(user);
    await user.click(saveButton());
    expect(await screen.findByText('v2 생성')).toBeInTheDocument();
    // 목록이 새 버전을 알기 전에는 이어서 미리보기를 낼 수 없다 — 옛 기준 버전 위에 적용하면 새 버전의 변경을 건너뛴다
    expect(previewButton()).toBeDisabled();
    expect(screen.getByText(/새 기준 버전을 목록에 불러오는 중/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '목록 바꾸기' }));
    expect(baseSelect()).toHaveValue('10');
    expect(screen.queryByText(/새 기준 버전을 목록에 불러오는 중/)).not.toBeInTheDocument();
    expect(screen.getByText('v2 생성')).toBeInTheDocument(); // 저장 결과 문구는 남는다
    await runPreview(user, 'ALTER TABLE a ADD c INT;');
    expect(alterBodies(calls, 10)).toHaveLength(1);
    expect(alterBodies(calls, 1)).toHaveLength(2); // 첫 미리보기와 저장
  });

  it('새 버전이 목록에 오기 전에 기준 버전을 직접 고르면 기다림을 접고, 목록이 와도 고른 버전을 그대로 둔다', async () => {
    saveFrom(1, { 'POST /api/versions/3/alter': previewOf(3) });
    renderWithProviders(<ListHarness initial={[version(3, 3, 'sql'), version(1, 1, 'sql')]} next={[CREATED, version(3, 3, 'sql'), version(1, 1, 'sql')]} />);
    const user = userEvent.setup();
    await user.selectOptions(baseSelect(), '1');
    await waitFor(() => expect(charsetField()).toBeEnabled());
    await runPreview(user);
    await user.click(saveButton());
    expect(await screen.findByText('v2 생성')).toBeInTheDocument();
    expect(previewButton()).toBeDisabled();
    await user.selectOptions(baseSelect(), '3');
    expect(screen.queryByText(/새 기준 버전을 목록에 불러오는 중/)).not.toBeInTheDocument();
    await waitFor(() => expect(previewButton()).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '목록 바꾸기' }));
    expect(baseSelect()).toHaveValue('3');
  });

  it('저장한 내용이 이미 있는 SQL 버전과 같으면 기준 버전을 그 버전으로 옮긴다', async () => {
    const calls = mockAlterApi({
      'POST /api/versions/1/alter': (init: RequestInit) => (isSaveRequest(init) ? { status: 'duplicate', versionId: 5, versionNo: 3, applied: 1, changes: [] } : PREVIEW),
      'POST /api/versions/5/alter': previewOf(3),
      'GET /api/versions/5/alter-defaults': { defaults: null },
    });
    renderWithProviders(<AlterDialog versions={[version(5, 3, 'sql'), version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await user.selectOptions(baseSelect(), '1');
    await waitFor(() => expect(charsetField()).toBeEnabled());
    await runPreview(user);
    await user.click(saveButton());
    expect(await screen.findByText('v3와 내용이 같습니다')).toBeInTheDocument();
    expect(baseSelect()).toHaveValue('5');
    await runPreview(user, 'ALTER TABLE a ADD c INT;');
    expect(alterBodies(calls, 5)).toHaveLength(1);
  });

  // R3-01: 같은 내용의 버전을 다른 사용자·탭이 방금 만들었다면, 중복 응답이 가리키는 버전은 이 대화상자가 받아 둔 목록에 아직 없다
  it('같은 내용의 버전이 목록에 아직 없으면 기다렸다가, 목록이 갱신되는 대로 기준 버전을 그 버전으로 옮긴다 — 그 전에는 옛 기준 버전으로 미리보기를 낼 수 없다', async () => {
    const calls = mockAlterApi({
      'POST /api/versions/1/alter': (init: RequestInit) => (isSaveRequest(init) ? { status: 'duplicate', versionId: 5, versionNo: 3, applied: 1, changes: [] } : PREVIEW),
      'POST /api/versions/5/alter': previewOf(3),
      'GET /api/versions/5/alter-defaults': NO_SUGGESTION,
    });
    renderWithProviders(<ListHarness initial={[version(1, 1, 'sql')]} next={[version(5, 3, 'sql'), version(1, 1, 'sql')]} />);
    const user = userEvent.setup();
    await waitFor(() => expect(charsetField()).toBeEnabled());
    await runPreview(user);
    await user.click(saveButton());
    expect(await screen.findByText('v3와 내용이 같습니다')).toBeInTheDocument();
    // 목록이 그 버전을 알기 전에 옛 기준 버전으로 미리보기를 내면, 그 버전의 변경을 건너뛴 결과가 나온다
    expect(baseSelect()).toHaveValue('1');
    expect(previewButton()).toBeDisabled();
    expect(screen.getByText(/새 기준 버전을 목록에 불러오는 중/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '목록 바꾸기' }));
    expect(baseSelect()).toHaveValue('5');
    expect(screen.queryByText(/새 기준 버전을 목록에 불러오는 중/)).not.toBeInTheDocument();
    expect(screen.getByText('v3와 내용이 같습니다')).toBeInTheDocument(); // 저장 결과 문구는 남는다
    await waitFor(() => expect(previewButton()).toBeEnabled()); // 새 기준 버전의 기본 문자셋 제안을 받은 뒤
    await runPreview(user, 'ALTER TABLE a ADD c INT;');
    expect(alterBodies(calls, 5)).toHaveLength(1);
    expect(alterBodies(calls, 1)).toHaveLength(2); // 첫 미리보기와 저장
  });
});

describe('HistoryPage — 저장 뒤 기준 버전', () => {
  const route = { route: '/db/1/schema/7/history', path: '/db/:dbId/schema/:schemaId/history' };

  it('저장으로 목록이 갱신되면 대화상자의 기준 버전이 새 버전으로 옮겨져, 이어서 낸 미리보기가 새 버전으로 간다', async () => {
    let created = false;
    const created12 = version(12, 2, 'sql', { derivedFrom: { ...DERIVED, defaults: { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' } } });
    const calls = mockApi({
      '/api/auth/me': { id: 3, username: 'park', role: 'dba' },
      '/api/schemas/7': { id: 7, name: 'shop', databaseId: 1, databaseName: 'db' },
      '/api/schemas/7/versions': () => (created ? [created12, version(11, 1, 'sql')] : [version(11, 1, 'sql')]),
      'GET /api/versions/11/alter-defaults': { defaults: null },
      'POST /api/versions/11/alter': (init: RequestInit) => {
        if (!isSaveRequest(init)) return PREVIEW;
        created = true;
        return { ...SAVED, versionId: 12 };
      },
      'POST /api/versions/12/alter': previewOf(2),
    });
    renderWithProviders(<HistoryPage />, route);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'ALTER 적용' }));
    await waitFor(() => expect(charsetField()).toBeEnabled());
    await runPreview(user);
    await user.click(saveButton());
    expect(await screen.findByText('v2 생성')).toBeInTheDocument();
    await waitFor(() => expect(baseSelect()).toHaveValue('12'));
    await runPreview(user, 'ALTER TABLE a ADD c INT;');
    expect(alterBodies(calls, 12)).toHaveLength(1);
    expect(alterBodies(calls, 11)).toHaveLength(2);
  });

  // R3-01: 실제 목록 쿼리(useVersions)와 저장 뒤 목록 무효화를 그대로 쓰는 경로 — 대화상자가 받아 둔 목록에는 중복 응답의 버전이 없다
  const pageRoutes = {
    '/api/auth/me': { id: 3, username: 'park', role: 'dba' },
    '/api/schemas/7': { id: 7, name: 'shop', databaseId: 1, databaseName: 'db' },
  };
  const duplicateOf = (versionId: number) => ({ status: 'duplicate', versionId, versionNo: 2, applied: 1, changes: PREVIEW.changes });
  const loadingHint = () => screen.queryByText(/새 기준 버전을 목록에 불러오는 중/);

  it('다른 사용자가 같은 내용의 버전을 먼저 만들어 중복 응답이 받아 둔 목록에 없는 버전을 가리켜도, 목록이 갱신되면 기준 버전이 그 버전으로 옮겨진다', async () => {
    let isCreatedElsewhere = false;
    const created12 = version(12, 2, 'sql', { derivedFrom: { ...DERIVED, defaults: { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' } } });
    const calls = mockApi({
      ...pageRoutes,
      '/api/schemas/7/versions': () => (isCreatedElsewhere ? [created12, version(11, 1, 'sql')] : [version(11, 1, 'sql')]),
      'GET /api/versions/11/alter-defaults': NO_SUGGESTION,
      'POST /api/versions/11/alter': (init: RequestInit) => {
        if (!isSaveRequest(init)) return PREVIEW;
        isCreatedElsewhere = true; // 이 요청이 닿기 직전에 다른 사용자가 같은 내용을 저장했다
        return duplicateOf(12);
      },
      'POST /api/versions/12/alter': previewOf(2),
    });
    renderWithProviders(<HistoryPage />, route);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'ALTER 적용' }));
    await waitFor(() => expect(charsetField()).toBeEnabled());
    await runPreview(user);
    await user.click(saveButton());
    expect(await screen.findByText('v2와 내용이 같습니다')).toBeInTheDocument();
    await waitFor(() => expect(baseSelect()).toHaveValue('12'));
    expect(loadingHint()).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await runPreview(user, 'ALTER TABLE a ADD c INT;');
    expect(alterBodies(calls, 12)).toHaveLength(1); // 방금 저장한 변경을 건너뛰지 않는다
    expect(alterBodies(calls, 11)).toHaveLength(2);
  });

  it('목록을 다시 받는 동안은 기다리고, 다 받았는데도 저장한 버전이 없으면 이유와 할 일을 알린다 — 옛 기준 버전으로 이어 쓰지 못하게 막고, 기준 버전을 직접 고르면 풀린다', async () => {
    let listFetches = 0;
    let releaseRefetch!: () => void;
    const held = new Promise<void>((resolve) => { releaseRefetch = resolve; });
    const calls = mockApi({
      ...pageRoutes,
      // 저장 뒤 다시 받는 목록은 받는 동안 붙잡아 두고, 풀어도 내용이 처음과 같다 (그 사이 지워졌거나 받지 못해 옛 목록이 남은 경우)
      '/api/schemas/7/versions': async () => {
        listFetches += 1;
        if (listFetches > 1) await held;
        return [version(13, 3, 'sql'), version(11, 1, 'sql')];
      },
      'GET /api/versions/13/alter-defaults': NO_SUGGESTION,
      'GET /api/versions/11/alter-defaults': NO_SUGGESTION,
      'POST /api/versions/13/alter': (init: RequestInit) => (isSaveRequest(init) ? duplicateOf(12) : previewOf(3)),
      'POST /api/versions/11/alter': PREVIEW,
    });
    renderWithProviders(<HistoryPage />, route);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'ALTER 적용' }));
    await waitFor(() => expect(charsetField()).toBeEnabled());
    await runPreview(user);
    await user.click(saveButton());
    expect(await screen.findByText('v2와 내용이 같습니다')).toBeInTheDocument();

    // 목록을 다시 받는 중에는 아직 없다고 단정하지 않는다
    expect(loadingHint()).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(previewButton()).toBeDisabled();

    releaseRefetch();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('v2 버전을 새로 받은 목록에서 찾지 못했습니다');
    expect(alert).toHaveTextContent('대화상자를 닫았다 다시 열거나');
    expect(loadingHint()).not.toBeInTheDocument();
    // 조용히 옛 기준 버전을 쥔 채 이어 쓰게 하지 않는다
    expect(baseSelect()).toHaveValue('13');
    expect(previewButton()).toBeDisabled();
    expect(saveButton()).toBeDisabled();

    await user.selectOptions(baseSelect(), '11');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(previewButton()).toBeEnabled());
    await runPreview(user, 'ALTER TABLE a ADD c INT;');
    expect(alterBodies(calls, 11)).toHaveLength(1);
    expect(listFetches).toBe(2);
  });
});

// R4-01: 행 ID 는 가장 큰 ID 의 버전을 지우면 다른 업로드가 다시 쓴다. 미리보기는 서버가 돌려준 기준 버전 지문이 지금 고른 기준 버전과 같을 때만 남기고,
// 저장은 그 지문을 expectedBase 로 보낸다. 서버가 409 로 거절하면(미리보기 뒤에 기준 버전이 바뀜) 미리보기를 지우고 목록을 다시 받는다
describe('AlterDialog — 기준 버전 지문', () => {
  const route = { route: '/db/1/schema/7/history', path: '/db/:dbId/schema/:schemaId/history' };
  const pageRoutes = {
    '/api/auth/me': { id: 3, username: 'park', role: 'dba' },
    '/api/schemas/7': { id: 7, name: 'shop', databaseId: 1, databaseName: 'db' },
  };
  const STALE = '기준 버전이 바뀌었습니다 — 미리보기 뒤에 다른 곳에서 지우고 다시 올렸을 수 있습니다. 미리보기를 다시 실행하세요';
  const staleResponse = () => json({ error: STALE }, 409);
  const baseOptions = () => [...baseSelect().querySelectorAll('option')].map((o) => o.textContent);

  it('저장은 미리보기가 돌려준 기준 버전 지문을 expectedBase 로 보낸다 — 미리보기 요청에는 보내지 않는다', async () => {
    const base = fingerprint(1, { modelHash: 'f'.repeat(64) });
    const calls = mockAlterApi({ 'POST /api/versions/1/alter': (init: RequestInit) => (isSaveRequest(init) ? SAVED : { ...PREVIEW, base }) });
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await waitFor(() => expect(charsetField()).toBeEnabled());
    await runPreview(user);
    await user.click(saveButton());
    expect(await screen.findByText('v2 생성')).toBeInTheDocument();
    const [previewBody, saveBody] = alterBodies(calls, 1);
    expect(previewBody).not.toHaveProperty('expectedBase');
    expect(saveBody).toMatchObject({ dryRun: false, expectedBase: base });
  });

  it('저장이 409 로 거절되면 미리보기를 지우고 메시지를 보이며, 새 미리보기를 낼 때까지 저장할 수 없다', async () => {
    mockAlterApi({ 'POST /api/versions/1/alter': (init: RequestInit) => (isSaveRequest(init) ? staleResponse() : PREVIEW) });
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await waitFor(() => expect(charsetField()).toBeEnabled());
    await runPreview(user);
    await user.click(saveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('기준 버전이 바뀌었습니다');
    expect(screen.getByRole('alert')).toHaveTextContent('미리보기를 다시 실행하세요');
    expect(previewList()).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    // 입력은 그대로 남아, 바로 다시 미리보기를 내고 저장할 수 있다
    expect(editor()).toHaveValue(SCRIPT);
    await user.click(previewButton());
    await screen.findByRole('list', { name: '미리보기 결과' });
    expect(saveButton()).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('409 로 거절되면 버전 목록을 다시 받아, 화면의 기준 버전이 서버의 버전으로 바뀐다 — 그 버전으로 다시 낸 미리보기로 저장된다', async () => {
    let isReplaced = false; // 미리보기 뒤에 다른 곳에서 v1(id 11)을 지우고 같은 id 로 v2 를 올렸다
    let listFetches = 0;
    const calls = mockApi({
      ...pageRoutes,
      '/api/schemas/7/versions': () => {
        listFetches += 1;
        return [version(11, isReplaced ? 2 : 1, 'sql')];
      },
      'GET /api/versions/11/alter-defaults': NO_SUGGESTION,
      'POST /api/versions/11/alter': (init: RequestInit) => {
        if (!isSaveRequest(init)) return previewOf(isReplaced ? 2 : 1);
        if (isReplaced) return { ...SAVED, versionId: 12 };
        isReplaced = true;
        return staleResponse();
      },
    });
    renderWithProviders(<HistoryPage />, route);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'ALTER 적용' }));
    await waitFor(() => expect(charsetField()).toBeEnabled());
    expect(baseOptions()).toEqual(['v1 · shop-v1.sql']);
    await runPreview(user);
    await user.click(saveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('기준 버전이 바뀌었습니다');
    await waitFor(() => expect(baseOptions()).toEqual(['v2 · shop-v2.sql']));
    expect(listFetches).toBe(2);
    expect(previewList()).not.toBeInTheDocument();
    await user.click(previewButton());
    await screen.findByRole('list', { name: '미리보기 결과' });
    await user.click(saveButton());
    expect(await screen.findByText('v2 생성')).toBeInTheDocument();
    expect(alterBodies(calls, 11).at(-1)).toMatchObject({ dryRun: false, expectedBase: fingerprint(2) });
  });

  it('미리보기를 낸 뒤 목록이 다시 와 같은 ID 가 다른 버전(버전 번호가 다름)을 가리키면 미리보기를 지우고 저장을 막는다', async () => {
    let serverVersionNo = 1;
    const calls = mockAlterApi({ 'POST /api/versions/1/alter': (init: RequestInit) => (isSaveRequest(init) ? SAVED : previewOf(serverVersionNo)) });
    renderWithProviders(<ListHarness initial={[version(1, 1, 'sql')]} next={[version(1, 2, 'sql')]} />);
    const user = userEvent.setup();
    await waitFor(() => expect(charsetField()).toBeEnabled());
    await runPreview(user);
    expect(saveButton()).toBeEnabled();

    // 다른 곳에서 v1 을 지우고 같은 ID 로 v2 를 올린 뒤 목록을 다시 받았다
    await user.click(screen.getByRole('button', { name: '목록 바꾸기' }));
    expect(baseSelect()).toHaveValue('1');
    expect(baseOptions()).toEqual(['v2 · shop-v2.sql']);
    expect(previewList()).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('기준 버전이 바뀌었습니다');

    // 새 기준 버전으로 낸 미리보기만 저장할 수 있다
    serverVersionNo = 2;
    await user.click(previewButton());
    await screen.findByRole('list', { name: '미리보기 결과' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(saveButton());
    expect(await screen.findByText('v2 생성')).toBeInTheDocument();
    expect(alterBodies(calls, 1).at(-1)).toMatchObject({ dryRun: false, expectedBase: fingerprint(2) });
  });

  it('미리보기가 가져온 지문이 화면의 기준 버전과 다르면(목록이 낡음) 그 미리보기는 남기지 않고 알린 뒤 목록을 다시 받는다', async () => {
    let listFetches = 0;
    mockApi({
      ...pageRoutes,
      // 처음 받은 목록은 낡았다: 서버에서는 이미 v1 이 지워지고 같은 id 로 v2 가 올라와 있다
      '/api/schemas/7/versions': () => [version(11, listFetches++ === 0 ? 1 : 2, 'sql')],
      'GET /api/versions/11/alter-defaults': NO_SUGGESTION,
      'POST /api/versions/11/alter': previewOf(2),
    });
    renderWithProviders(<HistoryPage />, route);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'ALTER 적용' }));
    await waitFor(() => expect(charsetField()).toBeEnabled());
    expect(baseOptions()).toEqual(['v1 · shop-v1.sql']);
    await user.type(editor(), SCRIPT);
    await user.click(previewButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('기준 버전');
    expect(previewList()).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    await waitFor(() => expect(baseOptions()).toEqual(['v2 · shop-v2.sql']));
    expect(listFetches).toBe(2);

    // 목록이 맞춰진 뒤에는 같은 미리보기가 남는다
    await user.click(previewButton());
    await screen.findByRole('list', { name: '미리보기 결과' });
    expect(saveButton()).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('스키마가 다른 지문의 미리보기도 남기지 않는다 — 같은 버전 번호여도 다른 스키마의 버전이다', async () => {
    mockAlterApi({ 'POST /api/versions/1/alter': previewOf(1, { schemaId: 8 }) });
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await waitFor(() => expect(charsetField()).toBeEnabled());
    await user.type(editor(), SCRIPT);
    await user.click(previewButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('기준 버전');
    expect(previewList()).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it('지문이 없는 미리보기 응답은 남기지 않는다 — 어느 버전에 낸 것인지 알 수 없어 저장할 수 없다', async () => {
    const { base: omitted, ...withoutBase } = PREVIEW;
    expect(omitted).toBeDefined();
    mockAlterApi({ 'POST /api/versions/1/alter': withoutBase });
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await waitFor(() => expect(charsetField()).toBeEnabled());
    await user.type(editor(), SCRIPT);
    await user.click(previewButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('기준 버전');
    expect(previewList()).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it('입력을 고치면 지문 안내를 지운다', async () => {
    mockAlterApi({ 'POST /api/versions/1/alter': previewOf(2) });
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await waitFor(() => expect(charsetField()).toBeEnabled());
    await user.type(editor(), SCRIPT);
    await user.click(previewButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('기준 버전');
    await user.type(editor(), ' ');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // 저장하고 나서 기다리는 버전도 ID 만으로 찾지 않는다: 저장 응답의 버전 번호까지 같아야 그 버전이다
  it('저장한 버전의 ID 를 다른 버전(버전 번호가 다름)이 물려받으면 기준 버전을 그 버전으로 옮기지 않는다', async () => {
    const calls = mockAlterApi({
      'POST /api/versions/1/alter': (init: RequestInit) => (isSaveRequest(init) ? { ...SAVED, versionId: 12 } : PREVIEW),
      'POST /api/versions/12/alter': previewOf(3),
    });
    // 저장으로 id 12(v2)가 생겼지만 목록을 다시 받기 전에 지워지고, 같은 id 로 v3 가 올라왔다
    renderWithProviders(<ListHarness initial={[version(1, 1, 'sql')]} next={[version(12, 3, 'sql'), version(1, 1, 'sql')]} />);
    const user = userEvent.setup();
    await waitFor(() => expect(charsetField()).toBeEnabled());
    await runPreview(user);
    await user.click(saveButton());
    expect(await screen.findByText('v2 생성')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '목록 바꾸기' }));
    expect(baseSelect()).toHaveValue('1');
    expect(previewButton()).toBeDisabled();
    expect(alterBodies(calls, 12)).toHaveLength(0);
  });

  it('(HistoryPage) 다 받은 목록에 저장한 버전의 ID 만 있고 버전 번호가 다르면 찾지 못했다고 알린다', async () => {
    let isSaved = false;
    mockApi({
      ...pageRoutes,
      '/api/schemas/7/versions': () => (isSaved ? [version(12, 3, 'sql'), version(11, 1, 'sql')] : [version(11, 1, 'sql')]),
      'GET /api/versions/11/alter-defaults': NO_SUGGESTION,
      'POST /api/versions/11/alter': (init: RequestInit) => {
        if (!isSaveRequest(init)) return PREVIEW;
        isSaved = true; // 저장한 v2(id 12)는 목록을 다시 받기 전에 지워지고, 같은 id 로 v3 가 올라왔다
        return { ...SAVED, versionId: 12 };
      },
    });
    renderWithProviders(<HistoryPage />, route);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'ALTER 적용' }));
    await waitFor(() => expect(charsetField()).toBeEnabled());
    await runPreview(user);
    await user.click(saveButton());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('v2 버전을 새로 받은 목록에서 찾지 못했습니다');
    expect(baseSelect()).toHaveValue('11');
    expect(previewButton()).toBeDisabled();
  });
});
