import type { ParsedDump, SchemaModel, Table } from '@tdm/core';
import { describe, expect, it } from 'vitest';
import { roundTripMismatches } from '../src/services/alter-round-trip';

// 안전망 비교는 객체·경고 수에 비례해야 한다: 파싱하지 못한 테이블이 수천 개인 기준도 미리보기·저장마다 오래 멈추지 않는다
// (경고마다 기준의 경고를 모두 훑으면 8,000개에 5.8 초, 16,000개면 그 네 배가 걸렸다. 지금은 16,000개에 0.14 초 — 느린 CI 를 생각해 한도를 넉넉히 둔다)
const UNPARSED_TABLES = 16000;
const TIME_BOUND_MS = 3000;

function unparsedSchema(n: number): ParsedDump {
  const tables: Table[] = Array.from({ length: n }, (_, k) => ({
    kind: 'table', name: `bad${k}`, columns: [], indexes: [], foreignKeys: [], checks: [], options: [], fidelity: 'full',
    parseError: "알 수 없는 컬럼 속성 'FOO' (줄 2)", rawDdl: `CREATE TABLE \`bad${k}\` (\n  \`x\` int NOT NULL FOO\n)`,
  }));
  const model: SchemaModel = { name: 'shop', tables, views: [], routines: [] };
  return { model, warnings: tables.map((t, k) => ({ code: 'parse-error', kind: 'table', object: t.name, line: k + 2, message: t.parseError! })) };
}

describe('roundTripMismatches — 계산량', () => {
  it(`파싱하지 못한 테이블 ${UNPARSED_TABLES}개를 건드리지 않은 결과는 짧은 시간에 통과한다`, () => {
    const dump = unparsedSchema(UNPARSED_TABLES);
    const started = performance.now();
    expect(roundTripMismatches({ base: dump.model, baseAgain: () => dump, applied: dump.model, reparsed: dump })).toEqual([]);
    expect(performance.now() - started).toBeLessThan(TIME_BOUND_MS);
  }, 60000);

  it('기준을 다시 읽을 때 없던 경고는 여전히 막는다', () => {
    const dump = unparsedSchema(3);
    const extra = { ...dump.warnings[0], message: '다른 경고' };
    expect(roundTripMismatches({ base: dump.model, baseAgain: () => dump, applied: dump.model, reparsed: { ...dump, warnings: [...dump.warnings, extra] } })).toEqual(['table `bad0`']);
  });
});
