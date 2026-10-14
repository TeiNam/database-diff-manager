import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AlterDialog } from '../src/features/alter/AlterDialog';
import { HistoryPage } from '../src/pages/HistoryPage';
import {
  alterBodies, baseSelect, charsetField, fingerprint, isSaveRequest, mockAlterApi, NO_SUGGESTION, pageRoutes, PREVIEW, previewButton, previewList, previewOf, route,
  runPreview, SAVED, saveButton, version, type User,
} from './alter-fixtures';
import { json, mockApi, renderWithProviders } from './render';

// 2way 리뷰 5회차 (M-2): 미리보기 뒤에 다른 사용자가 더 새 버전을 저장하면 서버가 저장을 409 로 거절하고 그 버전을 details.latestVersion 으로 알려 준다.
// 2way 리뷰 6회차: 화면은 409 가 알려 준 버전이 아니라 목록을 새로 받아 그 목록의 최신 SQL 버전으로 기준 버전을 옮기고 새 미리보기를 요구한다 — 409 뒤에
// 또 저장된 버전이 있을 수 있다(Codex #1). 미리보기가 기준 버전보다 더 새 버전이 있다고 알려도(latestVersionNo > versionNo — 대화상자를 연 뒤 저장됨,
// Claude M-1) 같다. 옛 버전을 기준으로 저장하는 것은 사용자가 기준 버전 선택에서 직접 고른 때뿐이고, 그때만 저장에 allowHistoricalBase 를 보낸다

// 서버의 409 메시지 (기준 버전이 저장할 때의 최신 SQL 버전이 아님)
const newerMessage = (baseNo: number, latestNo: number) =>
  `기준 버전(v${baseNo})보다 더 새 버전(v${latestNo})이 있습니다 — 다른 사용자가 저장했을 수 있습니다. 이대로 저장하면 최신 버전에서 그 변경이 빠지므로, 최신 버전에서 미리보기를 다시 실행하세요`;
const conflict = (baseNo: number, latest: { id: number; versionNo: number }) => json({ error: newerMessage(baseNo, latest.versionNo), details: { latestVersion: latest } }, 409);
const movedTo = (versionNo: number) => `최신 버전(v${versionNo})으로 옮겼습니다`;
const queryNotice = (text: string) => screen.queryByText(text, { exact: false });
const baseOptions = () => [...baseSelect().querySelectorAll('option')].map((o) => o.value);
const NO_SUGGESTIONS = Object.fromEntries([11, 12, 13, 14].map((id) => [`GET /api/versions/${id}/alter-defaults`, NO_SUGGESTION]));

const openDialog = async (user: User) => {
  await user.click(await screen.findByRole('button', { name: 'ALTER 적용' }));
  await waitFor(() => expect(charsetField()).toBeEnabled());
};
// 기준 버전을 옮긴 뒤 새 미리보기를 내고 저장한다
const previewAndSave = async (user: User, created: string) => {
  await waitFor(() => expect(previewButton()).toBeEnabled());
  await user.click(previewButton());
  await screen.findByRole('list', { name: '미리보기 결과' });
  await user.click(saveButton());
  expect(await screen.findByText(created)).toBeInTheDocument();
};

describe('AlterDialog — 저장 409: 기준 버전보다 더 새 버전', () => {
  it('미리보기를 지우고 서버 메시지를 보이며, 목록을 새로 받아 최신 버전으로 기준 버전을 옮긴다 — 그 버전으로 다시 낸 미리보기로 저장된다', async () => {
    let isNewerSaved = false; // 미리보기 뒤에 다른 사용자가 v1(id 11)에서 v2(id 12)를 저장했다
    let listFetches = 0;
    const calls = mockApi({
      ...pageRoutes, ...NO_SUGGESTIONS,
      '/api/schemas/7/versions': () => {
        listFetches += 1;
        return isNewerSaved ? [version(12, 2, 'sql'), version(11, 1, 'sql')] : [version(11, 1, 'sql')];
      },
      'POST /api/versions/11/alter': (init: RequestInit) => {
        if (!isSaveRequest(init)) return previewOf(1);
        isNewerSaved = true;
        return conflict(1, { id: 12, versionNo: 2 });
      },
      'POST /api/versions/12/alter': (init: RequestInit) => (isSaveRequest(init) ? { ...SAVED, versionId: 13, versionNo: 3 } : previewOf(2)),
    });
    renderWithProviders(<HistoryPage />, route);
    const user = userEvent.setup();
    await openDialog(user);
    await runPreview(user);
    await user.click(saveButton());
    expect(await screen.findByText(newerMessage(1, 2))).toBeInTheDocument();
    expect(previewList()).not.toBeInTheDocument();
    await waitFor(() => expect(baseSelect()).toHaveValue('12'));
    expect(listFetches).toBe(2);
    expect(queryNotice(movedTo(2))).toBeInTheDocument();
    expect(screen.getByText(newerMessage(1, 2))).toBeInTheDocument(); // 기준 버전을 옮겨도 서버 안내는 남는다
    expect(saveButton()).toBeDisabled();
    await previewAndSave(user, 'v3 생성');
    expect(queryNotice(movedTo(2))).not.toBeInTheDocument(); // 새 미리보기를 내면 안내를 지운다
    expect(alterBodies(calls, 12).at(-1)).toMatchObject({ dryRun: false, expectedBase: fingerprint(2) });
    expect(alterBodies(calls, 12).at(-1)).not.toHaveProperty('allowHistoricalBase');
    expect(alterBodies(calls, 11)).toHaveLength(2); // 옛 기준 버전으로는 다시 보내지 않았다
  });

  // Codex #1: A 가 409 를 받고 목록을 새로 받기 전에 C 가 v2 에서 v3 을 저장했다. 409 가 알려 준 v2 로 옮기면 그 미리보기는 v3 의 변경(c)을 건너뛴다
  it('편집자 셋: 409 뒤에 또 저장된 버전이 있으면 409 가 알려 준 버전이 아니라 새로 받은 목록의 최신 버전(v3)으로 옮긴다', async () => {
    let isConflicted = false;
    const calls = mockApi({
      ...pageRoutes, ...NO_SUGGESTIONS,
      '/api/schemas/7/versions': () => (isConflicted ? [version(13, 3, 'sql'), version(12, 2, 'sql'), version(11, 1, 'sql')] : [version(11, 1, 'sql')]),
      'POST /api/versions/11/alter': (init: RequestInit) => {
        if (!isSaveRequest(init)) return previewOf(1);
        isConflicted = true;
        return conflict(1, { id: 12, versionNo: 2 });
      },
      'POST /api/versions/12/alter': previewOf(2, { latestVersionNo: 3 }),
      'POST /api/versions/13/alter': (init: RequestInit) => (isSaveRequest(init) ? { ...SAVED, versionId: 14, versionNo: 4 } : previewOf(3)),
    });
    renderWithProviders(<HistoryPage />, route);
    const user = userEvent.setup();
    await openDialog(user);
    await runPreview(user, 'ALTER TABLE t ADD a INT;');
    await user.click(saveButton());
    await waitFor(() => expect(baseSelect()).toHaveValue('13'));
    expect(queryNotice(movedTo(3))).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    await previewAndSave(user, 'v4 생성');
    expect(alterBodies(calls, 12)).toHaveLength(0); // 409 가 알려 준 옛 버전으로는 미리보기도 내지 않았다
    expect(alterBodies(calls, 13)).toMatchObject([{ script: 'ALTER TABLE t ADD a INT;', dryRun: true }, { dryRun: false, expectedBase: fingerprint(3) }]);
    expect(alterBodies(calls, 13).at(-1)).not.toHaveProperty('allowHistoricalBase');
  });

  it('409 의 details 가 버전 모양이 아니면 기준 버전을 옮기지 않는다 — 미리보기만 지우고 다시 낼 수 있다', async () => {
    const malformed: unknown[] = [undefined, null, 'v2', { latestVersion: null }, { latestVersion: { id: '12', versionNo: 2 } }, { latestVersion: { id: 12, versionNo: 0 } }, { latestVersion: { id: 1.5, versionNo: 2 } }];
    for (const details of malformed) {
      mockAlterApi({ 'POST /api/versions/1/alter': (init: RequestInit) => (isSaveRequest(init) ? json({ error: newerMessage(1, 2), details }, 409) : PREVIEW) });
      const view = renderWithProviders(<AlterDialog versions={[version(1, 1, 'sql')]} onClose={() => undefined} />);
      const user = userEvent.setup();
      await waitFor(() => expect(charsetField()).toBeEnabled());
      await runPreview(user);
      await user.click(saveButton());
      expect(await screen.findByRole('alert'), JSON.stringify(details)).toHaveTextContent('더 새 버전(v2)이 있습니다');
      expect(previewList()).not.toBeInTheDocument();
      expect(baseSelect()).toHaveValue('1');
      expect(screen.queryByText(/새 기준 버전을 목록에 불러오는 중/)).not.toBeInTheDocument();
      expect(previewButton(), JSON.stringify(details)).toBeEnabled();
      view.unmount();
    }
  });

  it('목록을 새로 받는 동안 기준 버전을 직접 고르면, 늦게 온 목록으로 기준 버전을 옮기지 않는다', async () => {
    let listFetches = 0;
    let releaseList!: () => void;
    const held = new Promise<void>((resolve) => { releaseList = resolve; });
    const calls = mockApi({
      ...pageRoutes, ...NO_SUGGESTIONS,
      '/api/schemas/7/versions': async () => {
        listFetches += 1;
        if (listFetches === 1) return [version(12, 2, 'sql'), version(11, 1, 'sql')];
        await held;
        return [version(13, 3, 'sql'), version(12, 2, 'sql'), version(11, 1, 'sql')];
      },
      'POST /api/versions/12/alter': (init: RequestInit) => (isSaveRequest(init) ? conflict(2, { id: 13, versionNo: 3 }) : previewOf(2)),
      'POST /api/versions/11/alter': (init: RequestInit) => (isSaveRequest(init) ? { ...SAVED, versionId: 14, versionNo: 4 } : previewOf(1, { latestVersionNo: 3 })),
    });
    renderWithProviders(<HistoryPage />, route);
    const user = userEvent.setup();
    await openDialog(user);
    await runPreview(user);
    await user.click(saveButton());
    expect(await screen.findByText(newerMessage(2, 3))).toBeInTheDocument();
    expect(previewButton()).toBeDisabled(); // 최신 버전을 찾는 동안
    expect(screen.getByText(/새 기준 버전을 목록에 불러오는 중/)).toBeInTheDocument();
    await user.selectOptions(baseSelect(), '11');
    releaseList();
    await waitFor(() => expect(baseOptions()).toEqual(['13', '12', '11']));
    expect(baseSelect()).toHaveValue('11');
    expect(queryNotice('으로 옮겼습니다')).not.toBeInTheDocument();
    await previewAndSave(user, 'v4 생성');
    expect(alterBodies(calls, 11).at(-1)).toMatchObject({ dryRun: false, allowHistoricalBase: true }); // 사용자가 직접 고른 옛 버전이다
  });

  it('목록을 새로 받지 못하면 이유와 할 일을 알리고, 다시 낸 미리보기가 더 새 버전을 알리면 다시 받아 옮긴다', async () => {
    let listFetches = 0;
    let isNewerSaved = false;
    mockApi({
      ...pageRoutes, ...NO_SUGGESTIONS,
      '/api/schemas/7/versions': () => {
        listFetches += 1;
        if (listFetches === 2) return json({ error: '버전 목록을 읽지 못했습니다' }, 500);
        return isNewerSaved ? [version(12, 2, 'sql'), version(11, 1, 'sql')] : [version(11, 1, 'sql')];
      },
      'POST /api/versions/11/alter': (init: RequestInit) => {
        if (!isSaveRequest(init)) return previewOf(1, { latestVersionNo: isNewerSaved ? 2 : 1 });
        isNewerSaved = true;
        return conflict(1, { id: 12, versionNo: 2 });
      },
      'POST /api/versions/12/alter': previewOf(2),
    });
    renderWithProviders(<HistoryPage />, route);
    const user = userEvent.setup();
    await openDialog(user);
    await runPreview(user);
    await user.click(saveButton());
    expect(await screen.findByText('최신 SQL 버전을 찾지 못했습니다', { exact: false })).toBeInTheDocument();
    expect(baseSelect()).toHaveValue('11');
    expect(saveButton()).toBeDisabled();
    await waitFor(() => expect(previewButton()).toBeEnabled()); // 막지 않는다 — 다시 낸 미리보기가 더 새 버전을 알리면 다시 받는다
    await user.click(previewButton());
    await waitFor(() => expect(baseSelect()).toHaveValue('12'));
    expect(listFetches).toBe(3);
    expect(queryNotice(movedTo(2))).toBeInTheDocument();
    expect(previewList()).not.toBeInTheDocument();
  });
});

describe('AlterDialog — 미리보기가 알린 더 새 버전', () => {
  // Claude M-1: 대화상자를 연 뒤·미리보기 전에 다른 사용자가 v2 를 저장했다. 화면이 받아 둔 목록에는 v1 뿐이라 v1 은 대화상자가 고른 기준이지 사용자가 고른 옛 버전이 아니다
  it('사용자가 옛 버전을 고른 것이 아니면 미리보기를 남기지 않고, 목록을 새로 받아 최신 버전으로 옮긴 뒤 새 미리보기를 요구한다', async () => {
    let isNewerSaved = false;
    const calls = mockApi({
      ...pageRoutes, ...NO_SUGGESTIONS,
      '/api/schemas/7/versions': () => (isNewerSaved ? [version(12, 2, 'sql'), version(11, 1, 'sql')] : [version(11, 1, 'sql')]),
      'POST /api/versions/11/alter': previewOf(1, { latestVersionNo: 2 }),
      'POST /api/versions/12/alter': (init: RequestInit) => (isSaveRequest(init) ? { ...SAVED, versionId: 13, versionNo: 3 } : previewOf(2)),
    });
    renderWithProviders(<HistoryPage />, route);
    const user = userEvent.setup();
    await openDialog(user);
    isNewerSaved = true;
    await user.type(screen.getByLabelText('ALTER 스크립트'), 'ALTER TABLE t ADD a INT;');
    await user.click(previewButton());
    expect(await screen.findByText('미리보기한 기준 버전(v1)보다 더 새 버전(v2)이 있어 이 미리보기로는 저장할 수 없습니다', { exact: false })).toBeInTheDocument();
    expect(previewList()).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    await waitFor(() => expect(baseSelect()).toHaveValue('12'));
    expect(queryNotice(movedTo(2))).toBeInTheDocument();
    await previewAndSave(user, 'v3 생성');
    expect(alterBodies(calls, 11)).toHaveLength(1); // 옛 기준 버전으로는 저장하지 않았다
    expect(alterBodies(calls, 12).at(-1)).toMatchObject({ dryRun: false, expectedBase: fingerprint(2) });
    expect(alterBodies(calls, 12).at(-1)).not.toHaveProperty('allowHistoricalBase');
  });

  it('사용자가 최신이 아닌 버전을 직접 고르면 미리보기를 그대로 두고 저장에 allowHistoricalBase 를 보낸다 — 저장 뒤 저절로 옮긴 기준 버전에는 보내지 않는다', async () => {
    let isSaved = false;
    const calls = mockApi({
      ...pageRoutes, ...NO_SUGGESTIONS,
      '/api/schemas/7/versions': () => [...(isSaved ? [version(14, 4, 'sql')] : []), version(13, 3, 'sql'), version(11, 1, 'sql')],
      'POST /api/versions/11/alter': (init: RequestInit) => {
        if (!isSaveRequest(init)) return previewOf(1, { latestVersionNo: 3 });
        isSaved = true;
        return { ...SAVED, versionId: 14, versionNo: 4 };
      },
      'POST /api/versions/14/alter': (init: RequestInit) => (isSaveRequest(init) ? { ...SAVED, versionId: 15, versionNo: 5 } : previewOf(4)),
    });
    renderWithProviders(<HistoryPage />, route);
    const user = userEvent.setup();
    await openDialog(user);
    await user.selectOptions(baseSelect(), '11');
    await waitFor(() => expect(charsetField()).toBeEnabled());
    await runPreview(user);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(saveButton());
    expect(await screen.findByText('v4 생성')).toBeInTheDocument();
    const [previewBody, saveBody] = alterBodies(calls, 11);
    expect(previewBody).not.toHaveProperty('allowHistoricalBase'); // 미리보기에는 보내지 않는다
    expect(saveBody).toMatchObject({ dryRun: false, expectedBase: fingerprint(1, { latestVersionNo: 3 }), allowHistoricalBase: true });
    // 저장한 v4 로 기준 버전이 저절로 옮겨지면 일부러 고른 옛 버전이 아니다
    await waitFor(() => expect(baseSelect()).toHaveValue('14'));
    await runPreview(user, 'ALTER TABLE a ADD c INT;');
    await user.click(saveButton());
    expect(await screen.findByText('v5 생성')).toBeInTheDocument();
    expect(alterBodies(calls, 14).at(-1)).not.toHaveProperty('allowHistoricalBase');
  });

  it('옛 버전을 골랐다가 최신 버전을 다시 고르면 allowHistoricalBase 를 보내지 않는다', async () => {
    const calls = mockAlterApi({ 'POST /api/versions/3/alter': (init: RequestInit) => (isSaveRequest(init) ? { ...SAVED, versionId: 4, versionNo: 4 } : previewOf(3)) });
    renderWithProviders(<AlterDialog versions={[version(3, 3, 'sql'), version(1, 1, 'sql')]} onClose={() => undefined} />);
    const user = userEvent.setup();
    await user.selectOptions(baseSelect(), '1');
    await user.selectOptions(baseSelect(), '3');
    await waitFor(() => expect(charsetField()).toBeEnabled());
    await runPreview(user);
    await user.click(saveButton());
    expect(await screen.findByText('v4 생성')).toBeInTheDocument();
    expect(alterBodies(calls, 3).at(-1)).toMatchObject({ dryRun: false, expectedBase: fingerprint(3) });
    expect(alterBodies(calls, 3).at(-1)).not.toHaveProperty('allowHistoricalBase');
  });
});
