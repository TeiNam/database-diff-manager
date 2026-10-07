import { diffSchemas, parseSqlDump } from '@tdm/core';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Sidebar } from '../src/layout/Sidebar';
import { mockApi, renderWithProviders } from './render';

const TREE = [
  { id: 1, name: 'prod-db-01', description: null, createdAt: '', schemas: [{ id: 7, name: 'shop', latestVersion: { id: 12, versionNo: 2, uploadedAt: '' } }] },
  { id: 2, name: 'stg-db-01', description: null, createdAt: '', schemas: [] },
];
const base = parseSqlDump('CREATE TABLE `orders` (\n  `x` int\n);\nCREATE TABLE `users` (\n  `id` int\n);\nCREATE TABLE `legacy` (\n  `y` int\n);').model;
const target = parseSqlDump('CREATE TABLE `orders` (\n  `x` bigint\n);\nCREATE TABLE `users` (\n  `id` int\n);\nCREATE TABLE `coupon` (\n  `z` int\n);').model;
const DIFF = { baseModel: base, targetModel: target, diff: diffSchemas(base, target), statements: [], ddl: '', renames: [] };

describe('Sidebar', () => {
  it('Database·Schema를 보여 주고, 스키마를 고르면 그 경로로 이동한다', async () => {
    mockApi({ '/api/tree': TREE });
    renderWithProviders(<Sidebar />);
    const tree = await screen.findByRole('tree', { name: '스키마 트리' });
    expect(within(tree).getByText('prod-db-01')).toBeInTheDocument();
    await userEvent.setup().click(within(tree).getByText('shop'));
    expect(screen.getByTestId('location')).toHaveTextContent('/db/1/schema/7');
  });

  it('선택된 스키마의 객체를 변경 표시와 함께 보여 주고, [변경] 필터·검색이 동작한다', async () => {
    mockApi({ '/api/tree': TREE, '/api/diff?base=11&target=12': DIFF });
    renderWithProviders(<Sidebar />, { route: '/db/1/schema/7?base=11&target=12' });
    const tree = await screen.findByRole('tree');
    expect(await within(tree).findByText('coupon')).toBeInTheDocument();
    expect(within(tree).getByText('legacy')).toHaveClass('struck');
    expect(within(tree).getByText('users')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: /변경/ }));
    expect(within(tree).queryByText('users')).not.toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: '객체 검색' }), 'ord');
    expect(within(tree).queryByText('coupon')).not.toBeInTheDocument();
    expect(within(tree).getByText('orders')).toBeInTheDocument();
    await user.click(within(tree).getByText('orders'));
    expect(screen.getByTestId('location')).toHaveTextContent('obj=orders');
  });

  it('화살표 키로 항목 사이를 이동하고 Enter로 선택한다', async () => {
    mockApi({ '/api/tree': TREE });
    renderWithProviders(<Sidebar />);
    const items = await screen.findAllByRole('treeitem');
    items[0].focus();
    const user = userEvent.setup();
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('treeitem')[1]).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('location')).toHaveTextContent('/db/1/schema/7');
  });

  it('현재 스키마 노드를 누르면 base/target 을 유지하고 obj 만 해제한다', async () => {
    mockApi({ '/api/tree': TREE, '/api/diff?base=11&target=12': DIFF });
    renderWithProviders(<Sidebar />, { route: '/db/1/schema/7?base=11&target=12&tab=diff&obj=orders' });
    const tree = await screen.findByRole('tree');
    await within(tree).findByText('coupon');
    await userEvent.setup().click(within(tree).getByText('shop'));
    const loc = screen.getByTestId('location');
    expect(loc).toHaveTextContent('base=11');
    expect(loc).toHaveTextContent('target=12');
    expect(loc).not.toHaveTextContent('obj=');
    // 선택 해제만 하고 접지 않는다
    expect(within(tree).getByText('shop').closest('[role="treeitem"]')).toHaveAttribute('aria-expanded', 'true');
    expect(within(tree).getByText('coupon')).toBeInTheDocument();
  });

  it('트리 조회가 실패하면 오류 메시지를 보여 준다', async () => {
    mockApi({ '/api/tree': new Response(JSON.stringify({ error: '트리 오류' }), { status: 500, headers: { 'content-type': 'application/json' } }) });
    renderWithProviders(<Sidebar />);
    expect(await screen.findByRole('alert')).toHaveTextContent('트리 오류');
  });

  it('Enter/Space 와 ArrowRight 로 Database·그룹을 접고 편다', async () => {
    mockApi({ '/api/tree': TREE, '/api/diff?base=11&target=12': DIFF });
    renderWithProviders(<Sidebar />, { route: '/db/1/schema/7?base=11&target=12' });
    const tree = await screen.findByRole('tree');
    await within(tree).findByText('coupon');
    const user = userEvent.setup();
    const item = (name: string) => within(tree).getByText(name).closest('[role="treeitem"]') as HTMLElement;
    item('Tables').focus();
    await user.keyboard('{Enter}');
    expect(within(tree).queryByText('coupon')).not.toBeInTheDocument();
    await user.keyboard('{ArrowRight}');
    expect(within(tree).getByText('coupon')).toBeInTheDocument();
    item('prod-db-01').focus();
    await user.keyboard(' ');
    expect(within(tree).queryByText('shop')).not.toBeInTheDocument();
    await user.keyboard('{ArrowRight}');
    expect(within(tree).getByText('shop')).toBeInTheDocument();
  });

  it('현재 스키마도 클릭·ArrowLeft/Right 로 접고 편다', async () => {
    mockApi({ '/api/tree': TREE, '/api/diff?base=11&target=12': DIFF });
    renderWithProviders(<Sidebar />, { route: '/db/1/schema/7?base=11&target=12' });
    const tree = await screen.findByRole('tree');
    await within(tree).findByText('coupon');
    const user = userEvent.setup();
    const shop = () => within(tree).getByText('shop').closest('[role="treeitem"]') as HTMLElement;
    await user.click(within(tree).getByText('shop'));
    expect(shop()).toHaveAttribute('aria-expanded', 'false');
    expect(within(tree).queryByText('Tables')).not.toBeInTheDocument();
    await user.click(within(tree).getByText('shop'));
    expect(within(tree).getByText('Tables')).toBeInTheDocument();
    shop().focus();
    await user.keyboard('{ArrowLeft}');
    expect(within(tree).queryByText('Tables')).not.toBeInTheDocument();
    await user.keyboard('{ArrowRight}');
    expect(within(tree).getByText('Tables')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/db/1/schema/7');
  });

  it('현재가 아닌 스키마에서 ArrowRight 는 그 스키마로 이동한다', async () => {
    mockApi({ '/api/tree': TREE });
    renderWithProviders(<Sidebar />);
    const items = await screen.findAllByRole('treeitem');
    items[1].focus();
    await userEvent.setup().keyboard('{ArrowRight}');
    expect(screen.getByTestId('location')).toHaveTextContent('/db/1/schema/7');
  });
});
