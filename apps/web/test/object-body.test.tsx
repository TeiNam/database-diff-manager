import { diffSchemas, parseSqlDump } from '@tdm/core';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ObjectBody } from '../src/features/diff/ObjectBody';
import { changedObjects } from '../src/lib/object-diff';

// td-export 0.1.52 형식의 루틴 구간
const routine = (ddl: string) =>
  `SET @OLD_ROUTINE_SQL_MODE = @@SQL_MODE, SQL_MODE = 'STRICT_TRANS_TABLES';\nDELIMITER ;;\n${ddl};;\nDELIMITER ;\nSET SQL_MODE = @OLD_ROUTINE_SQL_MODE;\n`;
const TAX = (rate: string) => routine(`CREATE DEFINER=\`root\`@\`%\` FUNCTION \`tax\`(a int) RETURNS int\n    DETERMINISTIC\nRETURN a * ${rate}`);
// 20줄 테이블의 가운데 한 줄만 바뀌어 앞뒤에 접히는 동일 구간이 생긴다
const columns = (change?: number) => Array.from({ length: 20 }, (_, i) => `  \`c${i}\` int${i === change ? ' NOT NULL' : ''},`).join('\n');
const table = (change?: number) => `CREATE TABLE \`orders\` (\n${columns(change)}\n  \`id\` int\n);\n`;
const diff = diffSchemas(parseSqlDump(table() + TAX('1')).model, parseSqlDump(table(10) + TAX('2')).model);
const [orders, tax] = changedObjects(diff);
const cols = (container: HTMLElement) => container.querySelectorAll('table[aria-label="SQL diff"] col').length;

describe('ObjectBody', () => {
  it('SQL 보기: 동일 구간을 접고, Split 은 6열이다', () => {
    const { container } = render(<ObjectBody entry={orders} mode="sql" layout="split" expanded={false} />);
    expect(screen.getAllByRole('button', { name: /줄 동일 · 펼치기/ }).length).toBeGreaterThan(0);
    expect(cols(container)).toBe(6);
  });

  it('expanded 면 동일 구간을 모두 펼친다 (Unified 4열)', () => {
    const { container } = render(<ObjectBody entry={orders} mode="sql" layout="unified" expanded />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'SQL diff' })).getAllByText(/`c0` int/).length).toBeGreaterThan(0);
    expect(cols(container)).toBe(4);
  });

  it('표 보기: 테이블은 컬럼 표, 루틴은 루틴 표', () => {
    render(<ObjectBody entry={orders} mode="grid" layout="split" expanded />);
    expect(screen.getByRole('table', { name: 'Columns' })).toBeInTheDocument();
    render(<ObjectBody entry={tax} mode="grid" layout="split" expanded />);
    expect(screen.getByRole('table', { name: '루틴 정의' })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'SQL diff' })).not.toBeInTheDocument();
  });
});
