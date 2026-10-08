import { diffSchemas } from '@tdm/core';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DiffResponse } from '../src/api/types';
import { MigrationTab } from '../src/features/migration/MigrationTab';
import { asIsModel, fixtureFlow, toBeModel } from './dms-fixture';
import { mockApi, renderWithProviders } from './render';

const meta = (id: number, schemaId: number, schemaName: string) => ({
  id, schemaId, schemaName, databaseId: 1, databaseName: 'db', versionNo: 1, sourceFormat: 'sql' as const,
  sourceFilename: `${schemaName}.sql`, note: null, uploadedBy: 'admin', uploadedAt: '2026-10-08T00:00:00.000Z',
});
const data = (baseSchema = 1): DiffResponse => ({
  base: meta(11, baseSchema, 'legacy'), target: meta(12, 2, 'newapp'), baseModel: asIsModel, targetModel: toBeModel,
  diff: diffSchemas(asIsModel, toBeModel), statements: [], ddl: '', renames: [],
});
const MAPPING = { id: 5, fromSchemaId: 1, toSchemaId: 2, revision: 2, filename: 'mapping.json', ruleCount: 19, note: null, uploadedBy: 'admin', uploadedAt: '2026-10-08T00:00:00.000Z' };
const WARNING = { ruleId: '50', code: 'unsupported', message: 'column / convert-lowercase 룰은 반영하지 않습니다' };
const FLOW_URL = '/api/migration-flow?base=11&target=12';
const me = (role: 'admin' | 'viewer') => ({ '/api/auth/me': { id: 1, username: role, role } });
const rowButtons = () => screen.getAllByRole('button', { name: /컬럼 (펼치기|접기)$/ });
// 전환 표의 테이블 행 첫 칸 (As-Is 이름, 없으면 —)
const firstCells = () => within(screen.getByRole('table', { name: '전환 표' })).getAllByRole('row').slice(1).map((r) => r.querySelector('td')!.textContent);

describe('MigrationTab: 매핑 없음', () => {
  it('안내 문구와 admin 에게 [매핑 올리기], 누르면 대화상자', async () => {
    mockApi({ ...me('admin'), [FLOW_URL]: { mapping: null } });
    renderWithProviders(<MigrationTab data={data()} />);
    expect(await screen.findByText(/전환 매핑이 없습니다/)).toBeInTheDocument();
    expect(screen.getByText(/역방향 비교에는 매핑을 뒤집어 rename 으로 반영합니다/)).toBeInTheDocument();
    await userEvent.setup().click(await screen.findByRole('button', { name: '매핑 올리기' }));
    expect(screen.getByRole('dialog', { name: '전환 매핑 올리기' })).toBeInTheDocument();
  });

  it('viewer 에게는 올리기 버튼이 없다', async () => {
    mockApi({ ...me('viewer'), [FLOW_URL]: { mapping: null } });
    renderWithProviders(<MigrationTab data={data()} />);
    expect(await screen.findByText(/전환 매핑이 없습니다/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: '매핑 올리기' })).not.toBeInTheDocument());
  });

  it('같은 Schema 의 버전끼리는 안내만 한다', async () => {
    const calls = mockApi({ ...me('admin'), '/api/migration-flow?base=11&target=12': { mapping: null } });
    renderWithProviders(<MigrationTab data={data(2)} />);
    expect(await screen.findByText(/같은 Schema 의 버전끼리는/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '매핑 올리기' })).not.toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.url === '/api/auth/me')).toBe(true));
    expect(calls.some((c) => c.url.startsWith('/api/migration-flow'))).toBe(false);
  });
});

describe('MigrationTab: 매핑 있음', () => {
  const routes = (role: 'admin' | 'viewer') => ({ ...me(role), [FLOW_URL]: { mapping: MAPPING, flow: fixtureFlow, warnings: [WARNING] } });

  it('헤더(파일·리비전·룰 수·검증 수)와 경고', async () => {
    mockApi(routes('viewer'));
    renderWithProviders(<MigrationTab data={data()} />);
    const head = await screen.findByRole('group', { name: '적용 중인 전환 매핑' });
    expect(head).toHaveTextContent('mapping.json');
    expect(head).toHaveTextContent('r2 · 룰 19개 · 검증 2/3');
    expect(screen.getByRole('region', { name: '전환 매핑 경고' })).toHaveTextContent('경고 1건');
    expect(within(head).queryByRole('button', { name: '새 리비전 올리기' })).not.toBeInTheDocument();
  });

  it('필터·검색이 표의 테이블 행을 거른다', async () => {
    mockApi(routes('viewer'));
    renderWithProviders(<MigrationTab data={data()} />);
    await screen.findByRole('table', { name: '전환 표' });
    expect(firstCells()).toHaveLength(5);
    const user = userEvent.setup();
    const filters = screen.getByRole('radiogroup', { name: '전환 표 필터' });
    await user.click(within(filters).getByRole('radio', { name: '문제' }));
    expect(rowButtons().map((b) => b.textContent)).toEqual(['tb_cust']);
    await user.click(within(filters).getByRole('radio', { name: '신규' }));
    expect(firstCells()).toHaveLength(2);
    await user.click(within(filters).getByRole('radio', { name: '전체' }));
    await user.type(screen.getByRole('searchbox', { name: '전환 표 검색' }), 'cnd_val');
    expect(rowButtons().map((b) => b.textContent)).toEqual(['tb_prm_cnd']);
    await user.clear(screen.getByRole('searchbox', { name: '전환 표 검색' }));
    await user.type(screen.getByRole('searchbox', { name: '전환 표 검색' }), 'zzz');
    expect(screen.getByText('조건에 맞는 테이블이 없습니다')).toBeInTheDocument();
  });

  it('행을 펼치면 컬럼 매핑과 상태 배지', async () => {
    mockApi(routes('viewer'));
    renderWithProviders(<MigrationTab data={data()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'tb_prm 컬럼 펼치기' }));
    const inner = screen.getByRole('table', { name: 'tb_prm 컬럼 매핑' });
    expect(within(inner).getByText('max_dc_cnt').closest('tr')).toHaveTextContent('컬럼삭제');
    expect(within(inner).getByText('reg_dt').closest('tr')).toHaveTextContent('created_at');
    expect(screen.getByRole('button', { name: 'tb_prm 컬럼 접기' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('컬럼 행이 없는 테이블(제외·To-Be 전용)은 펼치기 버튼 없이 이름만', async () => {
    mockApi(routes('viewer'));
    renderWithProviders(<MigrationTab data={data()} />);
    await screen.findByRole('table', { name: '전환 표' });
    expect(rowButtons().map((b) => b.textContent)).toEqual(['tb_cust', 'tb_prm', 'tb_prm_cnd']);
    expect(firstCells()).toEqual(['tb_cust', 'tb_prm', 'tb_prm_cnd', 'tb_tmp_bak', '—']);
    expect(screen.queryByRole('button', { name: /tb_tmp_bak|audit_log/ })).not.toBeInTheDocument();
  });

  it('리비전 목록: 원본 링크, admin 은 삭제', async () => {
    const calls = mockApi({
      ...routes('admin'),
      '/api/migrations?from=1&to=2': [MAPPING, { ...MAPPING, id: 4, revision: 1, filename: 'old.json' }],
      'DELETE /api/migrations/5': { ok: true },
    });
    renderWithProviders(<MigrationTab data={data()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '리비전 목록' }));
    const list = await screen.findByRole('table', { name: '전환 매핑 리비전' });
    expect(within(list).getAllByRole('link', { name: '원본' })[1]).toHaveAttribute('href', '/api/migrations/4/source');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(within(list).getByRole('button', { name: 'r2 삭제' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/migrations/5' && c.init.method === 'DELETE')).toBe(true));
    confirm.mockRestore();
  });
});
