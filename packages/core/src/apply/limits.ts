// 테이블 한도. 테이블 하나를 다루는 계산(키 짝 비교·이름 짓기·위치 찾기·FK 다시 확인)도 이 한도로 묶인다
// - InnoDB 한도 (MySQL 8.0.46·8.4.11 실측): 키는 PRIMARY·FK 자동 인덱스를 포함해 64개 (65번째는 1069 — 없는 컬럼 1072 보다 먼저), 컬럼은 1017개 (1018번째는 1117)
// - FK 는 MySQL 에 한도가 없지만 (MySQL 도 테이블 하나에 FK 2,000개면 CREATE TABLE 에 16 초가 걸린다 — 8.4.11 실측), 문장마다 그 테이블의 FK 를 모두 다시 확인하므로
//   적용 시간을 묶으려고 64개까지만 받는다. 넘으면 1차 지원 범위 밖으로 거부한다
import type { Table } from '../model';
import { fail, RE_EXPORT } from './types';

export const MAX_KEYS = 64;
export const MAX_COLUMNS = 1017;
export const MAX_FOREIGN_KEYS = 64;

export function assertKeyCount(count: number): void {
  if (count > MAX_KEYS) fail(`키가 너무 많습니다 — 테이블당 ${MAX_KEYS}개까지입니다 (MySQL 1069)`);
}

export function assertColumnCount(count: number): void {
  if (count > MAX_COLUMNS) fail(`컬럼이 너무 많습니다 — InnoDB 테이블당 ${MAX_COLUMNS}개까지입니다 (MySQL 1117)`);
}

export function assertForeignKeyCount(t: Pick<Table, 'name' | 'foreignKeys'>): void {
  if (t.foreignKeys.length <= MAX_FOREIGN_KEYS) return;
  fail(`테이블 \`${t.name}\` 의 FK 가 ${MAX_FOREIGN_KEYS}개를 넘습니다 — 문장마다 테이블의 FK 를 모두 다시 확인하므로 FK 가 이렇게 많은 테이블은 1차 지원 범위가 아닙니다 — ${RE_EXPORT}`);
}
