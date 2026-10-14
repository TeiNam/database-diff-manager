import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { VersionSummary } from '../src/api/types';
import { AlterDialog } from '../src/features/alter/AlterDialog';
import { HistoryPage } from '../src/pages/HistoryPage';
import { alterBodies, DERIVED, mockAlterApi, PREVIEW, SAVED, version } from './alter-fixtures';
import { mockApi, renderWithProviders } from './render';

// 2way 리뷰 2회차 (web): 저장 중 입력 잠금(R2-04·M-3), 기본값이 바뀌면 미리보기 무효화(R2-03),
// 문자셋 칸을 고치는 동안 콜레이션(M-2), 저장한 뒤 기준 버전(M-4)
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
    'POST /api/versions/10/alter': PREVIEW,
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
    saveFrom(1, { 'POST /api/versions/3/alter': PREVIEW });
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
      'POST /api/versions/5/alter': PREVIEW,
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

  it('같은 내용의 버전이 목록에 없으면 기다리지 않고 기준 버전을 그대로 둔다 — 미리보기를 막은 채 남지 않는다', async () => {
    mockAlterApi({
      'POST /api/versions/1/alter': (init: RequestInit) => (isSaveRequest(init) ? { status: 'duplicate', versionId: 5, versionNo: 3, applied: 1, changes: [] } : PREVIEW),
    });
    renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await waitFor(() => expect(charsetField()).toBeEnabled());
    await runPreview(user);
    await user.click(saveButton());
    expect(await screen.findByText('v3와 내용이 같습니다')).toBeInTheDocument();
    expect(baseSelect()).toHaveValue('1');
    expect(previewButton()).toBeEnabled();
    expect(screen.queryByText(/새 기준 버전을 목록에 불러오는 중/)).not.toBeInTheDocument();
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
      'POST /api/versions/12/alter': PREVIEW,
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
});
