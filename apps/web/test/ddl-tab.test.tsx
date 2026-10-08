import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DdlTab } from '../src/features/diff/DdlTab';
import { mockApi, renderWithProviders } from './render';

const statements = [
  { object: 'orders', kind: 'table', op: 'modify', sql: 'ALTER TABLE `orders`\n  MODIFY COLUMN `status` varchar(32) NOT NULL', comment: false, notes: ['MD 기반: default 미확인'] },
  { object: 'gone', kind: 'table', op: 'drop', sql: 'DROP TABLE `gone`', comment: false },
];
const DATA = {
  base: { id: 11, versionNo: 1, schemaName: 'shop' }, target: { id: 12, versionNo: 2, schemaName: 'shop' },
  statements, ddl: '-- 전체 DDL\n', diff: { partial: false, tables: [], views: [] },
} as never;
const ROUTE = '/db/1/schema/7?base=11&target=12&tab=ddl';

describe('DdlTab', () => {
  // 복사·다운로드 직전 재조회 응답 (기본은 화면과 같은 내용)
  beforeEach(() => {
    mockApi({ '/api/diff?base=11&target=12': DATA });
  });
  it('문장 블록마다 머리 주석·notes·SQL을 보여 주고, 블록 복사·전체 복사를 한다', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderWithProviders(<DdlTab data={DATA} />, { route: ROUTE, path: '/db/:dbId/schema/:schemaId' });
    const block = screen.getByRole('region', { name: '~ TABLE orders' });
    expect(within(block).getByText('-- MD 기반: default 미확인')).toBeInTheDocument();
    expect(within(block).getByText(/MODIFY COLUMN `status` varchar\(32\) NOT NULL;/)).toBeInTheDocument();
    await user.click(within(block).getByRole('button', { name: '복사' }));
    await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('ALTER TABLE `orders`')));
    expect(writeText).toHaveBeenLastCalledWith(expect.not.stringContaining('DROP TABLE'));
    await user.click(screen.getByRole('button', { name: '전체 복사' }));
    await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith('-- 전체 DDL\n'));
  });

  it('방향 전환은 base·target을 바꾸고, 다운로드 파일명은 스키마와 버전으로 만든다', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    // URL 생성자는 유지한 채 객체 URL 함수만 대체한다
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }));
    renderWithProviders(<DdlTab data={DATA} />, { route: ROUTE, path: '/db/:dbId/schema/:schemaId' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '.sql 다운로드' }));
    await vi.waitFor(() => expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('shop_v1_to_v2.sql'));
    await user.click(screen.getByRole('radio', { name: 'v2 → v1' }));
    expect(screen.getByTestId('location')).toHaveTextContent('base=12&target=11');
  });

  it('방향 radiogroup 은 ←/→ 로도 방향을 바꾸고, 선택된 방향만 Tab 순서에 있다', async () => {
    renderWithProviders(<DdlTab data={DATA} />, { route: ROUTE, path: '/db/:dbId/schema/:schemaId' });
    const group = screen.getByRole('radiogroup', { name: 'DDL 방향' });
    expect(within(group).getAllByRole('radio').map((r) => r.tabIndex)).toEqual([0, -1]);
    within(group).getByRole('radio', { name: 'v1 → v2' }).focus();
    await userEvent.setup().keyboard('{ArrowRight}');
    expect(screen.getByTestId('location')).toHaveTextContent('base=12&target=11');
  });

  it('BASE·TARGET 의 Schema 가 다르면 방향 버튼에 Schema 이름을 붙인다', () => {
    const data = { ...(DATA as object), base: { id: 11, schemaId: 1, versionNo: 1, schemaName: 'legacy' }, target: { id: 12, schemaId: 2, versionNo: 1, schemaName: 'newapp' } } as never;
    renderWithProviders(<DdlTab data={data} />, { route: ROUTE, path: '/db/:dbId/schema/:schemaId' });
    const group = screen.getByRole('radiogroup', { name: 'DDL 방향' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['legacy v1 → newapp v1', 'newapp v1 → legacy v1']);
  });

  it('문장이 없으면 안내', () => {
    renderWithProviders(<DdlTab data={{ ...(DATA as object), statements: [], ddl: '' } as never} />, { route: ROUTE, path: '/db/:dbId/schema/:schemaId' });
    expect(screen.getByText('적용할 DDL이 없습니다')).toBeInTheDocument();
  });

  it('다운로드 파일명에서 경로·공백 문자를 치환한다', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }));
    const data = { ...(DATA as object), target: { id: 12, versionNo: 2, schemaName: 'a/b c:d' } } as never;
    mockApi({ '/api/diff?base=11&target=12': data });
    renderWithProviders(<DdlTab data={data} />, { route: ROUTE, path: '/db/:dbId/schema/:schemaId' });
    await userEvent.setup().click(screen.getByRole('button', { name: '.sql 다운로드' }));
    await vi.waitFor(() => expect((click.mock.contexts.at(-1) as HTMLAnchorElement).download).toBe('a_b_c_d_v1_to_v2.sql'));
  });

  it('복사 결과를 live region으로 알리고, DDL이 비면 전체 복사를 비활성화한다', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    renderWithProviders(<DdlTab data={DATA} />, { route: ROUTE, path: '/db/:dbId/schema/:schemaId' });
    await user.click(screen.getByRole('button', { name: '전체 복사' }));
    expect((await screen.findAllByRole('status')).some((e) => e.textContent === '복사됨')).toBe(true);
  });

  it('DDL이 비면 전체 복사가 비활성', () => {
    renderWithProviders(<DdlTab data={{ ...(DATA as object), statements: [], ddl: '' } as never} />, { route: ROUTE, path: '/db/:dbId/schema/:schemaId' });
    expect(screen.getByRole('button', { name: '전체 복사' })).toBeDisabled();
  });

  // 다른 사용자가 매핑·rename 을 바꿨을 수 있어 복사·다운로드 직전에 최신 diff 를 다시 받는다
  describe('복사·다운로드 직전 최신화', () => {
    const FRESH = { ...(DATA as object), statements: [statements[1]], ddl: '-- 최신 DDL\n' };

    it('전체 복사는 다시 받은 최신 DDL 을 복사한다', async () => {
      const calls = mockApi({ '/api/diff?base=11&target=12': FRESH });
      // userEvent.setup() 이 clipboard 를 바꿔 끼우므로 그 뒤에 stub 한다
      const user = userEvent.setup();
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      renderWithProviders(<DdlTab data={DATA} />, { route: ROUTE, path: '/db/:dbId/schema/:schemaId' });
      await user.click(screen.getByRole('button', { name: '전체 복사' }));
      await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith('-- 최신 DDL\n'));
      expect(calls.map((c) => c.url)).toEqual(['/api/diff?base=11&target=12']);
    });

    it('최신 DDL 을 받지 못하면 다운로드하지 않고 알린다', async () => {
      mockApi({});
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
      renderWithProviders(<DdlTab data={DATA} />, { route: ROUTE, path: '/db/:dbId/schema/:schemaId' });
      await userEvent.setup().click(screen.getByRole('button', { name: '.sql 다운로드' }));
      expect(await screen.findByText('다운로드 실패: 최신 DDL을 받지 못했습니다')).toBeInTheDocument();
      expect(click).not.toHaveBeenCalled();
    });

    it('다운로드도 다시 받은 최신 DDL 로 만든다', async () => {
      mockApi({ '/api/diff?base=11&target=12': FRESH });
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
      const blobs: Blob[] = [];
      vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: (b: Blob) => { blobs.push(b); return 'blob:x'; }, revokeObjectURL: () => undefined }));
      renderWithProviders(<DdlTab data={DATA} />, { route: ROUTE, path: '/db/:dbId/schema/:schemaId' });
      await userEvent.setup().click(screen.getByRole('button', { name: '.sql 다운로드' }));
      await vi.waitFor(() => expect(blobs).toHaveLength(1));
      expect(await blobs[0].text()).toBe('-- 최신 DDL\n');
    });

    it('문장 복사는 그 문장이 최신 DDL 에서 사라졌으면 복사하지 않고 알린다', async () => {
      mockApi({ '/api/diff?base=11&target=12': FRESH });
      const user = userEvent.setup();
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      renderWithProviders(<DdlTab data={DATA} />, { route: ROUTE, path: '/db/:dbId/schema/:schemaId' });
      const block = screen.getByRole('region', { name: '~ TABLE orders' });
      await user.click(within(block).getByRole('button', { name: '복사' }));
      expect(await within(block).findByRole('status')).toHaveTextContent('DDL이 바뀌었습니다');
      expect(writeText).not.toHaveBeenCalled();
    });
  });
});
