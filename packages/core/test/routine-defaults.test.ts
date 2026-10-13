import { describe, expect, it } from 'vitest';
import * as core from '../src';
import { applyScript } from '../src/apply';
import { diffSchemas } from '../src/diff';
import type { Routine, RoutineCharacteristics, SchemaModel } from '../src/model';
import { printRoutine } from '../src/print';
import { isDefaultCharacteristic, ROUTINE_DEFAULTS } from '../src/routine-defaults';

const routine = (characteristics: RoutineCharacteristics): Routine => ({ kind: 'procedure', name: 'p', params: '', characteristics, body: 'SELECT 1' });
const model = (characteristics: RoutineCharacteristics): SchemaModel => ({ name: 's', tables: [], views: [], routines: [routine(characteristics)] });
const EMPTY: SchemaModel = { name: 's', tables: [], views: [], routines: [] };

// SHOW CREATE 가 찍지 않는 루틴 특성 값은 routine-defaults.ts 한 곳에서 정한다
describe('루틴 특성 기본값', () => {
  it('기본값 표: NOT DETERMINISTIC · CONTAINS SQL · SQL SECURITY DEFINER · LANGUAGE SQL', () => {
    expect(ROUTINE_DEFAULTS).toEqual({ deterministic: false, dataAccess: 'CONTAINS SQL', security: 'DEFINER', language: 'SQL' });
  });

  it.each([
    ['deterministic', undefined, true], ['deterministic', false, true], ['deterministic', true, false],
    ['dataAccess', undefined, true], ['dataAccess', 'CONTAINS SQL', true], ['dataAccess', 'NO SQL', false], ['dataAccess', 'READS SQL DATA', false], ['dataAccess', 'MODIFIES SQL DATA', false],
    ['security', undefined, true], ['security', 'DEFINER', true], ['security', 'INVOKER', false],
    ['language', undefined, true], ['language', 'SQL', true],
    ['comment', undefined, true], ['comment', '', true], ['comment', 'c', false],
  ])('isDefaultCharacteristic(%s, %j) → %s', (name, value, expected) => {
    expect(isDefaultCharacteristic(name as string, value)).toBe(expected);
  });

  it('내부 모듈이라 공개 API(src/index.ts)로 나오지 않는다', () => {
    expect('ROUTINE_DEFAULTS' in core).toBe(false);
    expect('isDefaultCharacteristic' in core).toBe(false);
  });
});

// 기본값 표를 쓰는 세 곳이 함께 움직인다: 표에 항목이 늘면 아래 SQL 절 표도 채워야 해서 한 곳만 고치는 실수를 테스트가 잡는다
const SQL_CLAUSE: Record<string, string> = { deterministic: 'NOT DETERMINISTIC', dataAccess: 'CONTAINS SQL', security: 'SQL SECURITY DEFINER', language: 'LANGUAGE SQL' };

describe('기본값 특성을 쓰는 세 곳 (printRoutine · diffSchemas · ALTER 적용)', () => {
  it('SQL 절 표가 기본값 표와 같은 항목을 가진다', () => {
    expect(Object.keys(SQL_CLAUSE).sort()).toEqual(Object.keys(ROUTINE_DEFAULTS).sort());
  });

  it.each(Object.entries(ROUTINE_DEFAULTS))('%s = %j 는 print 가 찍지 않고, diff 가 생략과 같게 보고, ALTER 적용이 저장하지 않는다', (name, value) => {
    const explicit = { [name]: value } as RoutineCharacteristics;
    expect(printRoutine(routine(explicit))).toBe(printRoutine(routine({})));
    expect(diffSchemas(model({}), model(explicit)).routines).toEqual([]);
    expect(diffSchemas(model(explicit), model({})).routines).toEqual([]);
    const applied = applyScript(EMPTY, `CREATE PROCEDURE p() ${SQL_CLAUSE[name]} SELECT 1;`, { schemaName: 's' });
    expect(applied.ok && applied.model.routines[0].characteristics).toEqual({});
  });

  it('빈 COMMENT 는 print 가 찍지 않고 ALTER 적용이 저장하지 않는다', () => {
    expect(printRoutine(routine({ comment: '' }))).toBe(printRoutine(routine({})));
    const applied = applyScript(EMPTY, "CREATE PROCEDURE p() COMMENT '' SELECT 1;", { schemaName: 's' });
    expect(applied.ok && applied.model.routines[0].characteristics).toEqual({});
  });

  it('기본값이 아닌 값은 세 곳 모두 남긴다', () => {
    const rich: RoutineCharacteristics = { deterministic: true, dataAccess: 'READS SQL DATA', security: 'INVOKER', comment: 'c' };
    expect(printRoutine(routine(rich))).toBe("CREATE PROCEDURE `p`()\n    READS SQL DATA\n    DETERMINISTIC\n    SQL SECURITY INVOKER\n    COMMENT 'c'\nSELECT 1");
    expect(diffSchemas(model({}), model(rich)).routines[0].fields).toEqual(['characteristics.deterministic', 'characteristics.dataAccess', 'characteristics.security', 'characteristics.comment']);
    const applied = applyScript(EMPTY, "CREATE PROCEDURE p() DETERMINISTIC READS SQL DATA SQL SECURITY INVOKER COMMENT 'c' SELECT 1;", { schemaName: 's' });
    expect(applied.ok && applied.model.routines[0].characteristics).toEqual(rich);
  });
});
