import { diffSchemas, generateDdl, holdAllStatements, parseSqlDump, type SchemaModel } from '@tdm/core';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SummaryTab } from '../src/features/diff/SummaryTab';
import { renderWithProviders } from './render';

// TARGET 완전성 증거 안내 (14회차 1 → 15회차 4): 요약 탭에 TARGET 증거(완전/불완전/확인 불가)와, 그 때문에 수동 확인으로 돌린
// 삭제 문장 수를 보인다. BASE 가 불완전하면 CREATE 가 실패할 수 있다고 알린다
const HEADER = '/* Database : s */\nSET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;\n';
const TRAILER = 'SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;\n';
const TABLES = 'CREATE TABLE `a` (\n  `x` int\n);\nCREATE TABLE `b` (\n  `y` int\n);\n';
const full = parseSqlDump(HEADER + TABLES + TRAILER).model;
const withC = parseSqlDump(`${HEADER}${TABLES}CREATE TABLE \`c\` (\n  \`z\` int\n);\n${TRAILER}`).model;
const onlyA = parseSqlDump(`${HEADER}CREATE TABLE \`a\` (\n  \`x\` int\n);\n${TRAILER}`).model;
const legacyOnlyA = parseSqlDump('/* Database : s */\nCREATE TABLE `a` (\n  `x` int\n);\n').model; // td-export 0.1.15 형식
const cut = parseSqlDump(`${HEADER}CREATE TABLE \`a\` (\n  \`x\` int\n);\nCREATE TABLE \`b\` (\n  \`y\` int`).model;
const response = (b: SchemaModel, t: SchemaModel) => {
  const d = diffSchemas(b, t);
  return { base: { id: 1, versionNo: 1 }, target: { id: 2, versionNo: 2 }, baseModel: b, targetModel: t, diff: d, statements: generateDdl(d), ddl: '', renames: [] };
};
const stat = (label: string) => within(screen.getByRole('list', { name: '변경 통계' })).getByText(label).previousElementSibling;

describe('SummaryTab: TARGET 완전성 증거', () => {
  it('TARGET 이 불완전하면 사유와 수동 확인으로 돌린 삭제 문장 수를 안내한다', () => {
    // c 는 TARGET 에 없어 DROP TABLE 이 나오지만 증거가 없어 수동 확인 (끊긴 b 는 파싱 실패로 이미 수동 확인이라 세지 않는다)
    renderWithProviders(<SummaryTab data={response(withC, cut) as never} onOpen={() => undefined} />);
    expect(stat('TARGET 완전성')).toHaveTextContent('불완전');
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('TARGET 이 완전한 덤프인지 확인할 수 없음');
    expect(note).toHaveTextContent('구분자 없이 끊겼습니다');
    expect(note).toHaveTextContent('삭제 문장 1개');
  });

  it('0.1.15 형식 TARGET 은 확인 불가 — DROP TABLE 을 수동 확인으로 돌렸다고 센다', () => {
    renderWithProviders(<SummaryTab data={response(full, legacyOnlyA) as never} onOpen={() => undefined} />);
    expect(stat('TARGET 완전성')).toHaveTextContent('확인 불가');
    expect(screen.getByRole('note')).toHaveTextContent('삭제 문장 1개');
  });

  it('완전한 TARGET 은 완전으로 표시하고 안내가 없다 (DROP 은 실행 문장)', () => {
    renderWithProviders(<SummaryTab data={response(full, onlyA) as never} onOpen={() => undefined} />);
    expect(stat('TARGET 완전성')).toHaveTextContent('완전');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('BASE 가 불완전하면 CREATE 가 이미 존재 오류로 실패할 수 있다고 안내한다', () => {
    renderWithProviders(<SummaryTab data={response(cut, full) as never} onOpen={() => undefined} />);
    expect(screen.getByRole('note')).toHaveTextContent('BASE 가 불완전');
  });
});

// 예전 파서로 저장된 모델 (16회차 2): stale 버전이 낀 diff 는 실행 문장을 모두 수동 확인으로 돌리고 요약 탭이 경고한다
describe('SummaryTab: 예전 파서로 저장된 버전', () => {
  it('stale 버전과 수동 확인으로 돌린 문장 수, 다시 올리라는 안내를 보인다', () => {
    const data = response(full, onlyA);
    const held = holdAllStatements(data.statements, '예전 파서로 저장된 모델입니다', '안내');
    const reason = '예전 파서로 저장된 모델입니다 — 같은 원문을 다시 올려 새 버전으로 비교하세요';
    renderWithProviders(<SummaryTab data={{ ...data, statements: held, staleModels: [{ side: 'target', versionId: 2, versionNo: 2, reason }] } as never} onOpen={() => undefined} />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('TARGET v2');
    expect(note).toHaveTextContent('문장 1개');
    expect(note).toHaveTextContent('같은 원문을 다시 올려');
    expect(stat('저장 모델')).toHaveTextContent('예전 파서');
  });

  it('stale 버전이 없으면 안내가 없다 (옛 응답처럼 staleModels 가 없어도)', () => {
    renderWithProviders(<SummaryTab data={response(full, onlyA) as never} onOpen={() => undefined} />);
    expect(screen.queryByText('저장 모델')).not.toBeInTheDocument();
  });
});
