import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DdlTab } from '../src/features/diff/DdlTab';
import { renderWithProviders } from './render';

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
  it('문장 블록마다 머리 주석·notes·SQL을 보여 주고, 블록 복사·전체 복사를 한다', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderWithProviders(<DdlTab data={DATA} />, { route: ROUTE, path: '/db/:dbId/schema/:schemaId' });
    const block = screen.getByRole('region', { name: '~ TABLE orders' });
    expect(within(block).getByText('-- MD 기반: default 미확인')).toBeInTheDocument();
    expect(within(block).getByText(/MODIFY COLUMN `status` varchar\(32\) NOT NULL;/)).toBeInTheDocument();
    await user.click(within(block).getByRole('button', { name: '복사' }));
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('ALTER TABLE `orders`'));
    expect(writeText).toHaveBeenLastCalledWith(expect.not.stringContaining('DROP TABLE'));
    await user.click(screen.getByRole('button', { name: '전체 복사' }));
    expect(writeText).toHaveBeenLastCalledWith('-- 전체 DDL\n');
  });

  it('방향 전환은 base·target을 바꾸고, 다운로드 파일명은 스키마와 버전으로 만든다', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    // URL 생성자는 유지한 채 객체 URL 함수만 대체한다
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }));
    renderWithProviders(<DdlTab data={DATA} />, { route: ROUTE, path: '/db/:dbId/schema/:schemaId' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '.sql 다운로드' }));
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('shop_v1_to_v2.sql');
    await user.click(screen.getByRole('radio', { name: 'v2 → v1' }));
    expect(screen.getByTestId('location')).toHaveTextContent('base=12&target=11');
  });

  it('문장이 없으면 안내', () => {
    renderWithProviders(<DdlTab data={{ ...(DATA as object), statements: [], ddl: '' } as never} />, { route: ROUTE, path: '/db/:dbId/schema/:schemaId' });
    expect(screen.getByText('적용할 DDL이 없습니다')).toBeInTheDocument();
  });

  it('다운로드 파일명에서 경로·공백 문자를 치환한다', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }));
    const data = { ...(DATA as object), target: { id: 12, versionNo: 2, schemaName: 'a/b c:d' } } as never;
    renderWithProviders(<DdlTab data={data} />, { route: ROUTE, path: '/db/:dbId/schema/:schemaId' });
    await userEvent.setup().click(screen.getByRole('button', { name: '.sql 다운로드' }));
    expect((click.mock.contexts.at(-1) as HTMLAnchorElement).download).toBe('a_b_c_d_v1_to_v2.sql');
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
});
