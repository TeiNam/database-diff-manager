import type { RenameMapping } from '../src/diff';
import { parseSqlDump } from '../src/parse-dump';
import { parseMdDump } from '../src/parse-md';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export const fixture = (rel: string): string => readFileSync(path(`./fixtures/${rel}`), 'utf8');
export const hasFixture = (rel: string): boolean => existsSync(path(`./fixtures/${rel}`));

// 실데이터 샘플 (td-export 0.1.15, sample-app 스키마 33개 테이블)
export const sample = (kind: 'sql' | 'md'): string => fixture(`td-export-0115/sample-app.${kind}`);

// 같은 DB를 td-export 0.1.30으로 다시 뽑은 샘플 (SET FOREIGN_KEY_CHECKS, 따옴표 기본값, DESC·Fulltext 인덱스)
export const sampleV2 = (kind: 'sql' | 'md'): string => fixture(`td-export-0130/sample-app.${kind}`);

export const SCENARIOS = ['columns', 'tables', 'rename-table', 'rename-column', 'partitions', 'order-view', 'mysql8', 'drop-fk-tables', 'partition-bound', 'charset', 'charset-narrow', 'charset-text',
  'remove-rename-column', 'remove-rename-column-reverse'];

// 값 보존 확인 (선택): base 에 seed 를 넣고 DDL 적용 뒤 query 결과가 rows 와 같아야 한다
export interface ScenarioValues {
  seed: string;
  query: string;
  rows: Record<string, unknown>[];
}

export function scenarioValues(name: string): ScenarioValues | undefined {
  const rel = `scenarios/${name}/values.json`;
  return hasFixture(rel) ? (JSON.parse(fixture(rel)) as ScenarioValues) : undefined;
}

export function scenario(name: string) {
  const dir = `scenarios/${name}`;
  return {
    base: parseSqlDump(fixture(`${dir}/base.sql`)).model,
    target: parseSqlDump(fixture(`${dir}/target.sql`)).model,
    renames: (hasFixture(`${dir}/renames.json`) ? JSON.parse(fixture(`${dir}/renames.json`)) : []) as RenameMapping[],
  };
}

// MD(partial) TARGET 시나리오: 실행 가능한 왕복이 아니므로 실 MySQL 테스트(SCENARIOS)에는 넣지 않는다
export const MD_SCENARIOS = ['partial-target'];

export function mdScenario(name: string) {
  const dir = `scenarios-md/${name}`;
  return { base: parseSqlDump(fixture(`${dir}/base.sql`)).model, target: parseMdDump(fixture(`${dir}/target.md`)).model };
}
