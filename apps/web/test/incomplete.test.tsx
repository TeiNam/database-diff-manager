import { diffSchemas, generateDdl, parseSqlDump, type SchemaModel } from '@tdm/core';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SummaryTab } from '../src/features/diff/SummaryTab';
import { renderWithProviders } from './render';

// 불완전한 버전 안내 (14회차 1): TARGET 이 불완전하면 파괴적 문장을 막았다고, BASE 가 불완전하면 CREATE 가 실패할 수 있다고 알린다
const full = parseSqlDump('CREATE TABLE `a` (\n  `x` int\n);\nCREATE TABLE `b` (\n  `y` int\n);\n').model;
const cut = parseSqlDump('CREATE TABLE `a` (\n  `x` int\n);\nCREATE TABLE `b` (\n  `y` int').model;
const response = (b: SchemaModel, t: SchemaModel) => {
  const d = diffSchemas(b, t);
  return { base: { id: 1, versionNo: 1 }, target: { id: 2, versionNo: 2 }, baseModel: b, targetModel: t, diff: d, statements: generateDdl(d), ddl: '', renames: [] };
};

describe('SummaryTab: 불완전한 버전', () => {
  it('TARGET 이 불완전하면 사유와 함께 삭제를 막았다고 안내한다', () => {
    renderWithProviders(<SummaryTab data={response(full, cut) as never} onOpen={() => undefined} />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('TARGET 이 불완전');
    expect(note).toHaveTextContent('구분자 없이 끊겼습니다');
  });

  it('BASE 가 불완전하면 CREATE 가 이미 존재 오류로 실패할 수 있다고 안내한다', () => {
    renderWithProviders(<SummaryTab data={response(cut, full) as never} onOpen={() => undefined} />);
    expect(screen.getByRole('note')).toHaveTextContent('BASE 가 불완전');
  });

  it('완전한 두 버전은 안내가 없다', () => {
    renderWithProviders(<SummaryTab data={response(full, full) as never} onOpen={() => undefined} />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});
