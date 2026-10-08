import { describe, expect, it } from 'vitest';
import { compileSelection, DmsParseError, likeMatch, MAX_DMS_RULES, parseDmsMapping } from '../src/dms-mapping';
import { fixture } from './helpers';

// 룰 하나를 DMS 형식으로 만든다 (object-locator 의 schema-name 기본값 legacy)
const rule = (id: number, body: Record<string, unknown>) => ({ 'rule-id': String(id), 'rule-name': String(id), ...body });
const sel = (id: number, table: string, action = 'include') =>
  rule(id, { 'rule-type': 'selection', 'object-locator': { 'schema-name': 'legacy', 'table-name': table }, 'rule-action': action });
const tableRename = (id: number, table: string, value: string) =>
  rule(id, { 'rule-type': 'transformation', 'rule-target': 'table', 'object-locator': { 'schema-name': 'legacy', 'table-name': table }, 'rule-action': 'rename', value });
const parse = (rules: unknown[]) => parseDmsMapping(JSON.stringify({ rules }));

describe('parseDmsMapping: 픽스처', () => {
  const { mapping, warnings } = parseDmsMapping(fixture('dms/mapping.json'));

  it('action 별로 나눈다', () => {
    expect(mapping.fromSchema).toBe('legacy');
    expect(mapping.toSchema).toBe('newapp');
    expect(mapping.ruleCount).toBe(19);
    expect(mapping.selection).toEqual({ include: ['tb_prm', 'tb_prm_cnd', 'tb_cust'], exclude: [] });
    expect(mapping.tables.map((t) => [t.from, t.to])).toEqual([['tb_prm', 'promotion'], ['tb_prm_cnd', 'promotion_condition'], ['tb_cust', 'customer']]);
    expect(mapping.columns).toHaveLength(9);
    expect(mapping.columns[0]).toEqual({ ruleId: '20', table: 'tb_prm', from: 'PRM_ID', to: 'promotion_id' });
    expect(mapping.removedColumns.map((r) => `${r.table}.${r.column}`)).toEqual(['tb_prm.MAX_DC_CNT', 'tb_cust.OLD_ADDR']);
  });

  it('미지원 action 은 경고로 남긴다', () => {
    expect(warnings).toEqual([{ ruleId: '50', code: 'unsupported', message: 'column / convert-lowercase 룰은 반영하지 않습니다' }]);
  });
});

describe('parseDmsMapping: 규칙', () => {
  it('JSON 이 아니거나 rules 가 없거나 너무 많으면 DmsParseError', () => {
    expect(() => parseDmsMapping('{')).toThrow(new DmsParseError('JSON 형식이 아닙니다'));
    expect(() => parseDmsMapping('{"rule":[]}')).toThrow('rules 배열이 없습니다');
    expect(() => parseDmsMapping('[]')).toThrow('rules 배열이 없습니다');
    const many = JSON.stringify({ rules: Array.from({ length: MAX_DMS_RULES + 1 }, (_, i) => sel(i, 't')) });
    expect(() => parseDmsMapping(many)).toThrow('룰은 최대 20,000개까지 올릴 수 있습니다 (현재 20,001개)');
  });

  it('BOM 을 무시하고, 숫자 rule-id 도 받는다', () => {
    const { mapping } = parseDmsMapping(`\uFEFF${JSON.stringify({ rules: [{ ...tableRename(1, 'a', 'b'), 'rule-id': 7 }] })}`);
    expect(mapping.tables).toEqual([{ ruleId: '7', from: 'a', to: 'b' }]);
  });

  it('같은 대상의 rename 이 겹치면 rule-id 가 큰 쪽을 쓰고 경고 (대소문자 무시)', () => {
    const { mapping, warnings } = parse([tableRename(9, 'tb_a', 'new_a'), tableRename(3, 'TB_A', 'old_a')]);
    expect(mapping.tables).toEqual([{ ruleId: '9', from: 'tb_a', to: 'new_a' }]);
    expect(warnings).toEqual([{ ruleId: '3', code: 'duplicate', message: '같은 대상의 룰이 겹쳐 rule 9 를 사용합니다' }]);
  });

  it('transformation 의 와일드카드, 필수 값 누락, 다른 스키마는 경고', () => {
    const { mapping, warnings } = parse([
      tableRename(1, 'tb_%', 'x'),
      tableRename(2, 'tb_a', ''),
      { 'rule-id': '3', 'rule-type': 'transformation' },
      rule(4, { 'rule-type': 'transformation', 'rule-target': 'table', 'object-locator': { 'schema-name': 'other', 'table-name': 't' }, 'rule-action': 'rename', value: 'u' }),
      rule(5, { 'rule-type': 'table-settings', 'object-locator': { 'schema-name': 'legacy', 'table-name': 't' }, 'rule-action': 'parallel-load' }),
    ]);
    expect(mapping.tables).toEqual([]);
    expect(warnings.map((w) => [w.ruleId, w.code])).toEqual([
      ['3', 'invalid'], ['1', 'unsupported'], ['2', 'invalid'], ['4', 'invalid'], ['5', 'unsupported'],
    ]);
  });
});

describe('selection', () => {
  it('% 는 LIKE 처럼 아무 문자열, _ 는 글자 그대로, 대소문자 무시', () => {
    expect(likeMatch('tb_%', 'TB_PRM')).toBe(true);
    expect(likeMatch('tb_prm', 'tbxprm')).toBe(false);
    expect(likeMatch('%', 'anything')).toBe(true);
  });

  it('룰이 없으면 전부 대상, exclude 가 include 보다 우선', () => {
    expect(compileSelection(parse([]).mapping)('any')).toBe(true);
    const { mapping } = parse([sel(1, 'tb_%'), sel(2, 'tb_tmp%', 'exclude')]);
    expect(['tb_prm', 'tb_tmp_bak', 'audit'].map((t) => compileSelection(mapping)(t))).toEqual([true, false, false]);
  });

  it('exclude 만 있으면 나머지는 전부 대상', () => {
    const { mapping } = parse([sel(1, 'tb_tmp%', 'exclude')]);
    expect(['tb_prm', 'TB_TMP_BAK'].map((t) => compileSelection(mapping)(t))).toEqual([true, false]);
  });

  it('table-name 이 없는 selection 은 % 로 본다', () => {
    const { mapping } = parse([rule(1, { 'rule-type': 'selection', 'object-locator': { 'schema-name': 'legacy' }, 'rule-action': 'include' })]);
    expect(mapping.selection.include).toEqual(['%']);
    expect(compileSelection(mapping)('x')).toBe(true);
  });

  it('% 가 많은 패턴도 긴 이름에서 바로 끝난다', () => {
    const pattern = Array.from({ length: 60 }, () => 'a').join('%') + '%b';
    expect(likeMatch(pattern, 'a'.repeat(5000))).toBe(false);
    expect(likeMatch('a%%%b', 'aXb')).toBe(true);
  });

  it('너무 긴 패턴의 룰은 invalid 경고로 무시한다', () => {
    const { mapping, warnings } = parse([sel(1, 'a'.repeat(257))]);
    expect(mapping.selection.include).toEqual([]);
    expect(warnings.map((w) => [w.ruleId, w.code])).toEqual([['1', 'invalid']]);
  });
});

describe('parseDmsMapping: 중복', () => {
  const col = (id: number, name: string, value: string) =>
    rule(id, { 'rule-type': 'transformation', 'rule-target': 'column', 'object-locator': { 'schema-name': 'legacy', 'table-name': 't', 'column-name': name }, 'rule-action': 'rename', value });
  const rm = (id: number, name: string) =>
    rule(id, { 'rule-type': 'transformation', 'rule-target': 'column', 'object-locator': { 'schema-name': 'legacy', 'table-name': 't', 'column-name': name }, 'rule-action': 'remove-column' });
  const schema = (id: number, value: string) =>
    rule(id, { 'rule-type': 'transformation', 'rule-target': 'schema', 'object-locator': { 'schema-name': 'legacy' }, 'rule-action': 'rename', value });
  const dup = (loser: string, winner: string) => [{ ruleId: loser, code: 'duplicate', message: `같은 대상의 룰이 겹쳐 rule ${winner} 를 사용합니다` }];

  it('column rename', () => {
    const { mapping, warnings } = parse([col(2, 'A', 'x'), col(8, 'a', 'y')]);
    expect(mapping.columns).toEqual([{ ruleId: '8', table: 't', from: 'a', to: 'y' }]);
    expect(warnings).toEqual(dup('2', '8'));
  });

  it('remove-column', () => {
    const { mapping, warnings } = parse([rm(5, 'c'), rm(4, 'C')]);
    expect(mapping.removedColumns).toEqual([{ ruleId: '5', table: 't', column: 'c' }]);
    expect(warnings).toEqual(dup('4', '5'));
  });

  it('schema rename', () => {
    const { mapping, warnings } = parse([schema(1, 'old'), schema(2, 'new')]);
    expect(mapping.toSchema).toBe('new');
    expect(warnings).toEqual(dup('1', '2'));
  });
});
