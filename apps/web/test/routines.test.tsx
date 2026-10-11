import { diffSchemas, generateDdl, parseSqlDump, type SchemaModel } from '@tdm/core';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DdlTab } from '../src/features/diff/DdlTab';
import { DiffTab } from '../src/features/diff/DiffTab';
import { SummaryTab } from '../src/features/diff/SummaryTab';
import { Sidebar } from '../src/layout/Sidebar';
import { changedObjects, objectEntry, opOf } from '../src/lib/object-diff';
import { mockApi, renderWithProviders } from './render';

// td-export 0.1.52 형식의 루틴 구간
const routine = (ddl: string) =>
  `SET @OLD_ROUTINE_SQL_MODE = @@SQL_MODE, SQL_MODE = 'STRICT_TRANS_TABLES';\nDELIMITER ;;\n${ddl};;\nDELIMITER ;\nSET SQL_MODE = @OLD_ROUTINE_SQL_MODE;\n`;
const TABLE = 'CREATE TABLE `orders` (\n  `x` int\n);\n';
const TAX = (rate: string, extra = '') => routine(`CREATE DEFINER=\`root\`@\`%\` FUNCTION \`tax\`(a int) RETURNS int\n    DETERMINISTIC${extra}\nRETURN a * ${rate}`);
const PROC = (name: string) => routine(`CREATE DEFINER=\`root\`@\`%\` PROCEDURE \`${name}\`()\n    READS SQL DATA\nSELECT 1`);
const base = parseSqlDump(TABLE + TAX('1') + PROC('old_proc') + PROC('keep_proc')).model;
const target = parseSqlDump(TABLE + TAX('2', "\n    COMMENT '세금'") + PROC('new_proc') + PROC('keep_proc')).model;
const diff = diffSchemas(base, target);
const response = (b: SchemaModel, t: SchemaModel) => {
  const d = diffSchemas(b, t);
  return { base: { id: 11, versionNo: 1, schemaName: 'shop' }, target: { id: 12, versionNo: 2, schemaName: 'shop' }, baseModel: b, targetModel: t, diff: d, statements: generateDdl(d), ddl: '', renames: [] };
};
const DATA = response(base, target);
const md: SchemaModel = { name: 'shop', tables: base.tables, views: [], routines: [], routinesUnknown: true };
const MD_DATA = response(base, md);
const TREE = [{ id: 1, name: 'db', description: null, createdAt: '', schemas: [{ id: 7, name: 'shop', latestVersion: { id: 12, versionNo: 2, uploadedAt: '' } }] }];
const ROUTE = '/db/1/schema/7?base=11&target=12';
const PATH = '/db/:dbId/schema/:schemaId';

describe('object-diff: 루틴', () => {
  it('변경 루틴을 테이블·뷰 뒤에 CREATE 문 텍스트로 넣고, opOf·objectEntry 가 종류별로 찾는다', () => {
    const entries = changedObjects(diff).filter((e) => e.kind === 'function' || e.kind === 'procedure');
    expect(entries.map((e) => [e.op, e.kind, e.name])).toEqual([['modify', 'function', 'tax'], ['drop', 'procedure', 'old_proc'], ['add', 'procedure', 'new_proc']]);
    expect(entries[0].baseText).toContain('RETURN a * 1');
    expect(entries[0].targetText).toContain("COMMENT '세금'");
    expect(entries[0].targetText).not.toContain('DEFINER');
    expect(opOf(diff, 'procedure', 'new_proc')).toBe('add');
    expect(opOf(diff, 'function', 'new_proc')).toBeUndefined();
    expect(objectEntry('procedure', 'keep_proc', base, target, diff)).toMatchObject({ op: 'same', kind: 'procedure' });
  });
});

describe('Sidebar: Routines', () => {
  it('Tables·Views 다음에 Routines 그룹을 두고, 변경 표시·[변경] 필터·검색·선택이 동작한다', async () => {
    mockApi({ '/api/tree': TREE, '/api/diff?base=11&target=12': DATA });
    renderWithProviders(<Sidebar />, { route: ROUTE });
    const tree = await screen.findByRole('tree');
    const group = await within(tree).findByText('Routines');
    expect(group.closest('[role="treeitem"]')).toHaveTextContent('3 / 3');
    expect(within(tree).getByText('old_proc')).toHaveClass('struck');
    expect(within(tree).getByText('keep_proc')).toBeInTheDocument();
    const user = userEvent.setup();
    expect(screen.getByRole('radio', { name: /변경/ })).toHaveTextContent('변경 3');
    await user.click(screen.getByRole('radio', { name: /변경/ }));
    expect(within(tree).queryByText('keep_proc')).not.toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: '객체 검색' }), 'ta');
    expect(within(tree).queryByText('new_proc')).not.toBeInTheDocument();
    await user.click(within(tree).getByText('tax'));
    expect(screen.getByTestId('location')).toHaveTextContent('obj=tax');
    expect(screen.getByTestId('location')).toHaveTextContent('kind=function');
  });

  it('MD 가 끼면 루틴 대신 비교하지 않는다는 안내를 보여 준다', async () => {
    mockApi({ '/api/tree': TREE, '/api/diff?base=11&target=12': MD_DATA });
    renderWithProviders(<Sidebar />, { route: ROUTE });
    const tree = await screen.findByRole('tree');
    expect(await within(tree).findByText('MD 출처라 루틴은 비교하지 않음')).toBeInTheDocument();
    expect(within(tree).queryByText('tax')).not.toBeInTheDocument();
  });

  it('루틴이 없는 스키마에는 Routines 그룹이 없다', async () => {
    const plain = parseSqlDump(TABLE).model;
    mockApi({ '/api/tree': TREE, '/api/diff?base=11&target=12': response(plain, plain) });
    renderWithProviders(<Sidebar />, { route: ROUTE });
    const tree = await screen.findByRole('tree');
    await within(tree).findByText('Tables');
    expect(within(tree).queryByText('Routines')).not.toBeInTheDocument();
  });
});

describe('SummaryTab: 루틴', () => {
  it('루틴 추가·삭제·변경 수와 변경 루틴 행(바뀐 항목)을 보여 주고, 행을 누르면 종류와 함께 연다', async () => {
    const onOpen = vi.fn();
    renderWithProviders(<SummaryTab data={DATA as never} onOpen={onOpen} />);
    const stat = within(screen.getByRole('list', { name: '변경 통계' })).getByText('루틴 추가/삭제/변경').closest('li')!;
    expect(stat).toHaveTextContent('+1 −1 ~1');
    const row = screen.getByRole('button', { name: /tax/ });
    expect(row).toHaveTextContent('function');
    expect(row).toHaveTextContent('특성 · 본문');
    await userEvent.setup().click(row);
    expect(onOpen).toHaveBeenCalledWith('function', 'tax');
  });

  it('MD 가 끼면 루틴을 비교하지 않는다고 안내한다', () => {
    renderWithProviders(<SummaryTab data={MD_DATA as never} onOpen={() => undefined} />);
    expect(screen.getByRole('note')).toHaveTextContent('MD 출처라 루틴은 비교하지 않음');
  });
});

describe('DiffTab: 루틴', () => {
  it('SQL 보기는 CREATE 문 diff, 표 보기는 파라미터·RETURNS·특성 표', async () => {
    mockApi({ '/api/versions/12': { version: {}, model: target, objects: [] } });
    renderWithProviders(<DiffTab data={DATA as never} />, { route: `${ROUTE}&mode=grid`, path: PATH });
    const card = screen.getByRole('region', { name: 'function tax' });
    const grid = within(card).getByRole('table', { name: '루틴 정의' });
    const row = (label: string) => within(grid).getByRole('rowheader', { name: label }).closest('tr')!;
    expect(row('RETURNS')).toHaveTextContent('int');
    expect(row('COMMENT')).toHaveTextContent('세금');
    expect(within(row('COMMENT')).getByText('세금')).toHaveClass('cellAdd');
    expect(row('DETERMINISTIC')).toHaveTextContent('YES');
    expect(within(grid).getByRole('rowheader', { name: '본문' }).closest('tr')).toHaveClass('mod');
  });
});

describe('DdlTab: 루틴', () => {
  it('DELIMITER 로 감싼 루틴 문장에는 ; 를 덧붙이지 않는다', () => {
    mockApi({ '/api/diff?base=11&target=12': DATA });
    renderWithProviders(<DdlTab data={DATA as never} />, { route: `${ROUTE}&tab=ddl`, path: PATH });
    const block = screen.getByRole('region', { name: '+ PROCEDURE new_proc' });
    const text = block.querySelector('pre')!.textContent!;
    expect(text).toContain('DELIMITER ;;\nCREATE PROCEDURE `new_proc`()');
    expect(text.trimEnd().endsWith('SET SQL_MODE = @OLD_SQL_MODE;')).toBe(true);
    expect(text).not.toContain(';;;');
  });
});
