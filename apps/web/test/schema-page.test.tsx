import { diffSchemas, parseMdDump, parseSqlDump } from '@tdm/core';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SchemaPage } from '../src/pages/SchemaPage';
import { mockApi, renderWithProviders } from './render';

const V = (id: number, versionNo: number) => ({ id, versionNo, uploadedAt: '2026-10-0' + versionNo, uploadedBy: 'admin', note: null, sourceFormat: 'sql', changedObjects: 1 });
const base = parseSqlDump('CREATE TABLE `members` (\n  `id` int NOT NULL\n);\nCREATE TABLE `orders` (\n  `x` int\n);').model;
const target = parseSqlDump('CREATE TABLE `member` (\n  `id` int NOT NULL\n);\nCREATE TABLE `orders` (\n  `x` bigint\n);\nCREATE TABLE `coupon` (\n  `z` int\n);').model;
const response = (renames: unknown[] = []) => {
  const diff = diffSchemas(base, target, renames as never);
  return { base: V(11, 1), target: V(12, 2), baseModel: base, targetModel: target, diff, statements: [], ddl: '', renames };
};
const ROUTE = '/db/1/schema/7';
const DBA = { '/api/auth/me': { id: 3, username: 'park', role: 'dba' } };
const VIEWER = { '/api/auth/me': { id: 2, username: 'kim', role: 'viewer' } };

describe('SchemaPage', () => {
  it('base/target이 없으면 직전 → 최신 버전으로 URL을 채운다', async () => {
    mockApi({ '/api/schemas/7/versions': [V(12, 2), V(11, 1)], '/api/diff?base=11&target=12': response() });
    renderWithProviders(<SchemaPage />, { route: ROUTE, path: '/db/:dbId/schema/:schemaId' });
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('base=11&target=12'));
  });

  it('버전이 없으면 안내 문구', async () => {
    mockApi({ '/api/schemas/7/versions': [] });
    renderWithProviders(<SchemaPage />, { route: ROUTE, path: '/db/:dbId/schema/:schemaId' });
    expect(await screen.findByText('아직 업로드된 버전이 없습니다')).toBeInTheDocument();
  });

  it('요약 탭: 통계와 변경 객체 표, 행을 누르면 객체 diff 탭으로', async () => {
    mockApi({ '/api/schemas/7/versions': [V(12, 2), V(11, 1)], '/api/diff?base=11&target=12': response() });
    renderWithProviders(<SchemaPage />, { route: `${ROUTE}?base=11&target=12&tab=summary`, path: '/db/:dbId/schema/:schemaId' });
    const stats = await screen.findByRole('list', { name: '변경 통계' });
    expect(within(stats).getByText('테이블 추가').previousSibling).toHaveTextContent('+2');
    expect(within(stats).getByText('테이블 삭제').previousSibling).toHaveTextContent('−1');
    await userEvent.setup().click(screen.getByRole('button', { name: /orders/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('tab=diff');
    expect(screen.getByTestId('location')).toHaveTextContent('obj=orders');
  });

  it('rename 후보 배너: [이름 변경으로 처리]가 매핑을 저장한다 (dba)', async () => {
    const calls = mockApi({
      ...DBA,
      '/api/schemas/7/versions': [V(12, 2), V(11, 1)],
      '/api/diff?base=11&target=12': response(),
      'PUT /api/diff/renames': () => response([{ kind: 'table', from: 'members', to: 'member' }]),
    });
    renderWithProviders(<SchemaPage />, { route: `${ROUTE}?base=11&target=12&tab=summary`, path: '/db/:dbId/schema/:schemaId' });
    const banner = await screen.findByRole('region', { name: '이름 변경 후보' });
    await within(banner).findByRole('button', { name: '이름 변경으로 처리' });
    await userEvent.setup().click(within(banner).getByRole('button', { name: '이름 변경으로 처리' }));
    await waitFor(() => expect(screen.getByRole('region', { name: '적용된 이름 변경' })).toHaveTextContent('members → member'));
    expect(JSON.parse(String(calls.find((c) => c.url === '/api/diff/renames')!.init.body))).toEqual({
      base: 11, target: 12, renames: [{ kind: 'table', from: 'members', to: 'member' }],
    });
  });

  it('MD 출처가 섞이면 안내 배너', async () => {
    const md = parseMdDump('shop\n=====\n\n## Table List\n- [orders ()](#orders)\n\n## orders\n**Information**\n|Table type|Engine|Row format|Collate|Comment|\n|---|---|---|---|---|\n|BASE TABLE|InnoDB|Dynamic|utf8mb4_0900_ai_ci||\n\n**Columns**\n|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|\n|---|---|---|---|---|---|---|---|---|\n|x|bigint|YES|NULL||||||\n').model;
    const diff = diffSchemas(base, md);
    mockApi({ '/api/schemas/7/versions': [V(12, 2), V(11, 1)], '/api/diff?base=11&target=12': { ...response(), targetModel: md, diff } });
    renderWithProviders(<SchemaPage />, { route: `${ROUTE}?base=11&target=12&tab=summary`, path: '/db/:dbId/schema/:schemaId' });
    expect(await screen.findByText(/일부 속성.*비교되지 않았습니다/)).toBeInTheDocument();
  });

  it('전환 탭: 누르면 tab=migration 이 되고 전환 탭 본문을 그린다', async () => {
    mockApi({
      '/api/schemas/7/versions': [V(12, 2), V(11, 1)],
      '/api/diff?base=11&target=12': response(),
      '/api/migration-flow?base=11&target=12': { mapping: null },
      '/api/auth/me': { id: 1, username: 'viewer', role: 'viewer' },
    });
    renderWithProviders(<SchemaPage />, { route: `${ROUTE}?base=11&target=12&tab=summary`, path: '/db/:dbId/schema/:schemaId' });
    await userEvent.setup().click(await screen.findByRole('tab', { name: '전환' }));
    expect(screen.getByTestId('location')).toHaveTextContent('tab=migration');
    expect(await screen.findByText(/같은 Schema 의 버전끼리는/)).toBeInTheDocument();
  });

  it('viewer 에게 rename 배너는 읽기 전용이다 (처리·해제 버튼 없음)', async () => {
    const manual = { kind: 'column', table: 'orders', from: 'x', to: 'y', source: 'manual' };
    const calls = mockApi({ ...VIEWER, '/api/schemas/7/versions': [V(12, 2), V(11, 1)], '/api/diff?base=11&target=12': { ...response(), renames: [manual] } });
    renderWithProviders(<SchemaPage />, { route: `${ROUTE}?base=11&target=12&tab=summary`, path: '/db/:dbId/schema/:schemaId' });
    const candidates = await screen.findByRole('region', { name: '이름 변경 후보' });
    await waitFor(() => expect(calls.some((c) => c.url === '/api/auth/me')).toBe(true));
    expect(candidates).toHaveTextContent('members');
    expect(within(candidates).queryByRole('button')).not.toBeInTheDocument();
    expect(candidates).toHaveTextContent('DBA·관리자가 처리할 수 있습니다');
    const applied = screen.getByRole('region', { name: '적용된 이름 변경' });
    expect(applied).toHaveTextContent('orders.x → y');
    expect(within(applied).queryByRole('button', { name: '해제' })).not.toBeInTheDocument();
  });

  it('적용된 rename 에 출처를 표시하고, 해제는 수동 매핑만 다시 저장한다 (dba)', async () => {
    const dms = { kind: 'table', from: 'members', to: 'member', source: 'dms' };
    const manual = { kind: 'column', table: 'orders', from: 'x', to: 'y', source: 'manual' };
    const calls = mockApi({
      ...DBA,
      '/api/schemas/7/versions': [V(12, 2), V(11, 1)],
      '/api/diff?base=11&target=12': { ...response(), renames: [dms, manual] },
      'PUT /api/diff/renames': () => response(),
    });
    renderWithProviders(<SchemaPage />, { route: `${ROUTE}?base=11&target=12&tab=summary`, path: '/db/:dbId/schema/:schemaId' });
    const manualBanner = await screen.findByRole('region', { name: '적용된 이름 변경' });
    await within(manualBanner).findByRole('button', { name: '해제' });
    expect(manualBanner).toHaveTextContent(/수동\s*orders\.x → y/);
    const dmsBanner = screen.getByRole('region', { name: 'DMS 매핑에서 적용된 이름 변경' });
    expect(dmsBanner).toHaveTextContent('이름 변경 1건');
    expect(within(dmsBanner).queryByRole('button', { name: '해제' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '이름 변경 후보' })).not.toBeInTheDocument(); // DMS 로 이미 적용된 후보는 다시 묻지 않는다
    await userEvent.setup().click(within(manualBanner).getByRole('button', { name: '해제' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/diff/renames')).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url === '/api/diff/renames')!.init.body)).renames).toEqual([]);
  });
});
