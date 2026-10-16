import { diffSchemas, parseSqlDump } from '@tdm/core';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SummaryView, type SummaryItemRenderer } from '../src/features/diff/SummaryView';
import { objectAnchor } from '../src/lib/object-diff';

const base = parseSqlDump('CREATE TABLE `orders` (\n  `x` int\n);').model;
const target = parseSqlDump('CREATE TABLE `orders` (\n  `x` bigint\n);\nCREATE TABLE `coupon` (\n  `z` int\n);').model;
const response = (b: typeof base, t: typeof base) =>
  ({ base: { id: 1, versionNo: 1 }, target: { id: 2, versionNo: 2 }, baseModel: b, targetModel: t, diff: diffSchemas(b, t), statements: [], ddl: '', renames: [] }) as never;
const asLink: SummaryItemRenderer = ({ entry, className, children }) => <a href={`#${objectAnchor(entry.kind, entry.name)}`} className={className}>{children}</a>;

describe('SummaryView', () => {
  it('항목 렌더러가 준 요소(링크)로 변경 객체 목록을 그리고, 통계는 요약 탭과 같다', () => {
    render(<SummaryView data={response(base, target)} renderItem={asLink} />);
    const stats = screen.getByRole('list', { name: '변경 통계' });
    expect(within(stats).getByText('테이블 추가').previousSibling).toHaveTextContent('+1');
    expect(within(stats).getByText('테이블/뷰 변경').previousSibling).toHaveTextContent('~1');
    const links = within(screen.getByRole('group', { name: '변경 객체' })).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href')).sort()).toEqual(['#obj-table-coupon', '#obj-table-orders']);
    expect(links[0]).toHaveClass('summaryRow');
    expect(screen.getByRole('link', { name: /orders/ })).toHaveTextContent('col 1');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('변경이 없으면 목록 대신 안내 문구를 보이고 렌더러를 부르지 않는다', () => {
    const calls: string[] = [];
    render(<SummaryView data={response(base, base)} renderItem={({ entry }) => { calls.push(entry.name); return null; }} />);
    expect(screen.getByText('두 버전 사이에 변경 사항이 없습니다')).toBeInTheDocument();
    expect(calls).toEqual([]);
  });
});
