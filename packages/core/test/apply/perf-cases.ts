// applyScript 계산량 테스트 공용: 서버 한도(1,000,000자)를 꽉 채운 스크립트를 만들고, 정해진 시간 안에 정해진 결과로 끝나는지 본다.
// 서버는 한 프로세스라 적용하는 동안 다른 요청이 모두 멈춘다. 키 64개(1069)·컬럼 1017개(1117)·테이블당 FK 64개 한도로 테이블 하나의 계산량을 묶고,
// 문장마다 드는 시간이 스크립트 길이·테이블 수·FK 수에 비례하지 않게 한다. 실측(M-series 노트북)은 패턴마다 2 초 안쪽이고, 고치기 전에는 6 초~몇 시간이었다.
// 느린 CI 를 생각해 한도를 넉넉히 둔다. 패턴이 많아 파일 셋으로 나눠 함께 돈다 (apply-performance-*.test.ts)
import { expect } from 'vitest';
import { applyScript } from '../../src/apply';
import { RE_EXPORT } from '../../src/apply/types';
import type { SchemaModel } from '../../src/model';
import { parseSqlDump } from '../../src/parse-dump';
import { fixture } from '../helpers';

export const MAX_SCRIPT = 1_000_000;
export const TEST_TIMEOUT_MS = 60000;
const TIME_BOUND_MS = 6000;
const base = parseSqlDump(fixture('alter-scenarios/_base.sql').replaceAll('__DB__', 'shop')).model;
export const FK_HEAD = 'CREATE TABLE p (id INT PRIMARY KEY);\nCREATE TABLE c (id INT, x INT, y INT, KEY kx (x));';
export const FK_64 = Array.from({ length: 64 }, (_, i) => `CONSTRAINT f${i} FOREIGN KEY (x) REFERENCES p (id)`);
export const RE_EXPORT_ERRNO = 'RE_EXPORT';

// make(i) 를 이어 붙여 MAX_SCRIPT 자를 넘지 않는 가장 긴 스크립트를 만든다
export function fill(make: (i: number) => string, sep: string, head = '', tail = ''): string {
  const parts: string[] = [];
  let size = head.length + tail.length;
  for (let i = 1; ; i++) {
    const part = make(i);
    if (size + part.length + sep.length > MAX_SCRIPT) break;
    parts.push(part);
    size += part.length + sep.length;
  }
  return head + parts.join(sep) + tail;
}

export const lines = (make: (i: number) => string, head = '') => fill(make, '\n', head);
export const clauses = (make: (i: number) => string, head: string) => fill(make, ', ', head, ';');
export const tableNames = (n: number) => Array.from({ length: n }, (_, i) => `a${i}`);

// 결과: 성공이면 { ok: true }, 실패면 실패한 문장 번호와 MySQL 오류 번호 (RE_EXPORT_ERRNO 면 1차 범위 밖 안내, '' 면 번호 없음)
export type Expected = { ok: true } | { index: number; errno: string };
export type Case = [string, () => string, Expected];

// on: 기준 모델 (없으면 _base.sql), boundMs: 시간 한도 (없으면 TIME_BOUND_MS)
export function checkCase(make: () => string, expected: Expected, on: SchemaModel = base, boundMs = TIME_BOUND_MS): void {
  const script = make();
  expect(script.length).toBeLessThanOrEqual(MAX_SCRIPT);
  expect(script.length).toBeGreaterThan(MAX_SCRIPT * 0.6);
  const started = performance.now();
  const r = applyScript(on, script, { schemaName: 'shop' });
  expect(performance.now() - started).toBeLessThan(boundMs);
  const outcome = r.ok ? 'ok' : `${r.error.index} ${r.error.reason}`;
  if ('ok' in expected) expect(outcome).toBe('ok');
  else if (expected.errno === RE_EXPORT_ERRNO) expect(outcome).toMatch(new RegExp(`^${expected.index} .*${RE_EXPORT}$`));
  else expect(outcome).toMatch(new RegExp(`^${expected.index} .*${expected.errno ? `\\(MySQL ${expected.errno}\\)` : ''}`));
}
