import { diffSchemas, generateDdl, parseSqlDump } from '@tdm/core';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useSchemaContext } from '../src/hooks/useSchemaContext';
import { DiffTab } from '../src/features/diff/DiffTab';
import { SqlDiff } from '../src/features/diff/SqlDiff';
import { mockApi, renderWithProviders } from './render';

const lines = (n: number, change?: number) => Array.from({ length: n }, (_, i) => `  \`c${i}\` int${i === change ? ' NOT NULL' : ''},`).join('\n');
const base = parseSqlDump(`CREATE TABLE \`orders\` (\n  \`status\` varchar(20) NOT NULL,\n  \`memo\` varchar(100) DEFAULT NULL,\n  KEY \`ix_user\` (\`status\`)\n);\nCREATE TABLE \`users\` (\n  \`id\` int\n);`).model;
const target = parseSqlDump(`CREATE TABLE \`orders\` (\n  \`status\` varchar(32) NOT NULL,\n  \`discount\` int NOT NULL,\n  KEY \`ix_user\` (\`status\`)\n);\nCREATE TABLE \`users\` (\n  \`id\` int\n);`).model;
const diff = diffSchemas(base, target);
const DATA = {
  base: { id: 11, versionNo: 1 }, target: { id: 12, versionNo: 2 }, baseModel: base, targetModel: target, diff,
  statements: generateDdl(diff), ddl: '', renames: [],
} as never;
const ROUTE = '/db/1/schema/7?base=11&target=12';
const PATH = '/db/:dbId/schema/:schemaId';

describe('SqlDiff', () => {
  it('Split: 양쪽 줄 번호, 바뀐 단어 강조, 기호 −/+', () => {
    renderWithProviders(<SqlDiff base={'a\nstatus varchar(20)\nc'} target={'a\nstatus varchar(32)\nc'} layout="split" />);
    const table = screen.getByRole('table', { name: 'SQL diff' });
    expect(within(table).getByText('varchar(20)')).toHaveClass('wordDel');
    expect(within(table).getByText('varchar(32)')).toHaveClass('wordAdd');
    expect(within(table).getAllByText('−')).toHaveLength(1);
    expect(within(table).getAllByText('+')).toHaveLength(1);
  });

  it('긴 동일 구간은 접히고 ↕ 버튼으로 펼친다', async () => {
    renderWithProviders(<SqlDiff base={lines(20)} target={lines(20, 10)} layout="unified" />);
    const fold = screen.getAllByRole('button', { name: /줄 동일 · 펼치기/ });
    expect(fold).toHaveLength(2);
    expect(screen.queryByText('`c0` int,', { exact: false })).not.toBeInTheDocument();
    await userEvent.setup().click(fold[0]);
    expect(screen.getAllByText(/`c0` int,/).length).toBeGreaterThan(0);
  });
});

describe('DiffTab', () => {
  it('변경 객체 카드에 +n −m, hunk 헤더를 보여 주고, Unified·표 모드로 바꿀 수 있다', async () => {
    mockApi({ '/api/versions/12': { version: {}, model: target, objects: [{ objectId: 5, kind: 'table', name: 'orders', revisionNo: 2 }] } });
    renderWithProviders(<DiffTab data={DATA} />, { route: ROUTE, path: PATH });
    const card = screen.getByRole('region', { name: 'table orders' });
    expect(within(card).getByText('+2')).toBeInTheDocument();
    expect(within(card).getByText('−2')).toBeInTheDocument();
    expect(within(card).getByText(/^@@ -1,/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Unified' }));
    expect(screen.getByTestId('location')).toHaveTextContent('layout=unified');
    await user.click(screen.getByRole('radio', { name: '표' }));
    expect(screen.getByTestId('location')).toHaveTextContent('mode=grid');
    const grid = within(screen.getByRole('region', { name: 'table orders' }));
    // 섹션마다 표 하나에 BASE | TARGET 두 절반이 있다
    const columns = grid.getByRole('table', { name: 'Columns' });
    expect(within(columns).getByRole('columnheader', { name: 'BASE' })).toHaveAttribute('scope', 'colgroup');
    expect(within(columns).getByRole('columnheader', { name: 'TARGET' })).toHaveAttribute('scope', 'colgroup');
    expect(grid.getByText('discount')).toBeInTheDocument();
    expect(grid.getByText('varchar(32)').closest('td')).toHaveClass('cellAdd');
    expect(await grid.findByRole('link', { name: '이력' })).toHaveAttribute('href', '/objects/5');
  });

  it('카드의 DDL 복사는 그 객체 문장만 복사한다', async () => {
    // user-event 의 setup() 이 navigator.clipboard 스텁을 덮어쓰므로 먼저 만든 뒤 spy 를 심는다
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    mockApi({ '/api/versions/12': { version: {}, model: target, objects: [] } });
    renderWithProviders(<DiffTab data={DATA} />, { route: ROUTE, path: PATH });
    await user.click(within(screen.getByRole('region', { name: 'table orders' })).getByRole('button', { name: 'DDL 복사' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('ALTER TABLE `orders`'));
  });

  it('변경 없는 객체를 선택하면 단일 정의를 보여 준다', async () => {
    mockApi({ '/api/versions/12': { version: {}, model: target, objects: [] } });
    renderWithProviders(<DiffTab data={DATA} />, { route: `${ROUTE}&obj=users&kind=table`, path: PATH });
    const card = screen.getByRole('region', { name: 'table users' });
    expect(within(card).getByText('변경 없음')).toBeInTheDocument();
    expect(within(card).getByText(/CREATE TABLE `users`/)).toBeInTheDocument();
  });
});

const dataFor = (baseSql: string, targetSql: string) => {
  const b = parseSqlDump(baseSql).model;
  const t = parseSqlDump(targetSql).model;
  const d = diffSchemas(b, t);
  return { base: { id: 11, versionNo: 1 }, target: { id: 12, versionNo: 2 }, baseModel: b, targetModel: t, diff: d, statements: generateDdl(d), ddl: '', renames: [] } as never;
};
const emptyVersion = () => mockApi({ '/api/versions/12': { version: {}, model: target, objects: [] } });

describe('DiffTab 표 모드 보완', () => {
  it('charset 만 바뀐 컬럼도 mod 행으로 표시하고 해당 셀을 강조한다', () => {
    emptyVersion();
    const data = dataFor(
      'CREATE TABLE `t` (\n  `a` varchar(10) CHARACTER SET latin1\n);',
      'CREATE TABLE `t` (\n  `a` varchar(10) CHARACTER SET utf8mb4\n);',
    );
    renderWithProviders(<DiffTab data={data} />, { route: `${ROUTE}&mode=grid`, path: PATH });
    const cell = screen.getByText('utf8mb4', { exact: false }).closest('td');
    expect(cell).toHaveClass('cellAdd');
    expect(cell?.closest('tr')).toHaveClass('mod');
    expect(cell).toHaveAttribute('title', expect.stringContaining('utf8mb4'));
  });

  it('위치만 바뀐 컬럼에 위치 변경 표시를 붙인다', () => {
    emptyVersion();
    const data = dataFor(
      'CREATE TABLE `t` (\n  `a` int,\n  `b` int,\n  `c` int\n);',
      'CREATE TABLE `t` (\n  `c` int,\n  `a` int,\n  `b` int\n);',
    );
    renderWithProviders(<DiffTab data={data} />, { route: `${ROUTE}&mode=grid`, path: PATH });
    expect(screen.getByText('위치 변경').closest('tr')).toHaveClass('mod');
  });
});

describe('ObjectCard 동작 보완', () => {
  const many = (suffix: string) => Array.from({ length: 55 }, (_, i) => `CREATE TABLE \`t${i}\` (\n  \`a\` int${suffix}\n);`).join('\n');
  function Pick() {
    const { set } = useSchemaContext();
    return <button type="button" onClick={() => set({ obj: 't54', kind: 'table' })}>t54 선택</button>;
  }

  it('처음 렌더 뒤 선택된 접힌 카드가 펼쳐진다', async () => {
    emptyVersion();
    renderWithProviders(<><DiffTab data={dataFor(many(''), many(' NOT NULL'))} /><Pick /></>, { route: ROUTE, path: PATH });
    const card = screen.getByRole('region', { name: 'table t54' });
    expect(within(card).queryByRole('table', { name: 'SQL diff' })).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'table t54 본문' })).toHaveAttribute('aria-expanded', 'false');
    await userEvent.setup().click(screen.getByRole('button', { name: 't54 선택' }));
    expect(within(screen.getByRole('region', { name: 'table t54' })).getByRole('table', { name: 'SQL diff' })).toBeInTheDocument();
  });

  it('복사 실패를 표시한다', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    emptyVersion();
    renderWithProviders(<DiffTab data={DATA} />, { route: ROUTE, path: PATH });
    await user.click(within(screen.getByRole('region', { name: 'table orders' })).getByRole('button', { name: 'DDL 복사' }));
    expect(await screen.findByRole('button', { name: '복사 실패' })).toBeInTheDocument();
  });
});
