// ALTER 적용의 기본값 짐작 — 기준 버전에서 가장 많이 쓴 값을 가장 그럴듯한 값으로 본다.
// - 스키마 기본 문자셋·콜레이션 (대화상자 제안): td-export 덤프에는 DB 기본값이 없지만, 테이블을 문자셋 없이 만들었다면 대부분 DB 기본값을
//   물려받았을 것이므로 기준 버전 테이블의 DEFAULT CHARSET·COLLATE 최빈값
// - 처음 세션 SQL_MODE (서버가 applyScript 에 바로 준다): SET SQL_MODE 없이 만든 루틴은 스크립트를 실행한 서버의 sql_mode 를 기억하는데 스크립트만 봐서는
//   알 수 없으므로, 같은 서버에서 만들었을 기준 버전 루틴의 SQL_MODE 최빈값 (리뷰 5회차 M-1)
import { ApplyFailure, resolveDefaults, resolveSqlMode, type ApplyDefaults, type Routine, type Table } from '@tdm/core';

// 테이블 옵션 키 (core apply/normalize-mysql.ts 의 tableCharset 과 같다)
const CHARSET_KEYS = ['DEFAULT CHARSET', 'CHARSET', 'DEFAULT CHARACTER SET', 'CHARACTER SET'];
const COLLATE_KEYS = ['COLLATE', 'DEFAULT COLLATE'];

const optionValue = (table: Table, keys: string[]): string | undefined => table.options.find((o) => keys.includes(o.key))?.value;
const isDefined = <T>(value: T | undefined): value is T => value !== undefined;

// core 가 받지 않는 값(ApplyFailure)이면 undefined
function unlessRejected<T>(resolve: () => T): T | undefined {
  try {
    return resolve();
  } catch (error) {
    if (error instanceof ApplyFailure) return undefined;
    throw error;
  }
}

// 가장 많이 나온 값 (같은 키는 같은 값이다). 개수가 같으면 먼저 나온 값이고, 값이 없으면 undefined
function mostCommon<T>(values: readonly T[], keyOf: (value: T) => string): T | undefined {
  const counts = new Map<string, { value: T; count: number }>();
  for (const value of values) {
    const key = keyOf(value);
    counts.set(key, { value: counts.get(key)?.value ?? value, count: (counts.get(key)?.count ?? 0) + 1 });
  }
  let best: { value: T; count: number } | undefined;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best?.value;
}

// 테이블 하나의 기본 문자셋·콜레이션을 MySQL 표기로 맞춘다. 옵션이 없거나, 알 수 없는 이름·맞지 않는 쌍이거나,
// 스키마 기본값으로 쓸 수 없는 binary 이면 undefined
function tableDefaults(table: Table): ApplyDefaults | undefined {
  const charset = optionValue(table, CHARSET_KEYS);
  const collation = optionValue(table, COLLATE_KEYS);
  if (charset === undefined && collation === undefined) return undefined;
  const resolved = unlessRejected(() => resolveDefaults({ charset, collation }));
  return resolved?.charset === 'binary' ? undefined : resolved;
}

// 가장 많은 테이블이 쓰는 문자셋·콜레이션 쌍. 개수가 같으면 먼저 나온 쌍(tables 는 이름순)이고, 알 수 있는 테이블이 없으면 null
export function suggestAlterDefaults(tables: readonly Table[]): ApplyDefaults | null {
  // 이름은 \w+ 만 쓰므로 '/' 가 섞이지 않는다
  return mostCommon(tables.map(tableDefaults).filter(isDefined), (d) => `${d.charset}/${d.collation}`) ?? null;
}

// 루틴 하나의 SQL_MODE 를 MySQL 표기로 맞춘다. 기록이 없거나(td-export 0.1.52 전), 처음 세션 SQL_MODE 로 쓸 수 없는 값
// (묶음 모드·ANSI_QUOTES·REAL_AS_FLOAT·알 수 없는 이름 — SET SQL_MODE 처럼 거부한다)이면 undefined
function routineSqlMode({ sqlMode }: Routine): string | undefined {
  return sqlMode === undefined ? undefined : unlessRejected(() => resolveSqlMode(sqlMode));
}

// 가장 많은 루틴이 쓰는 SQL_MODE. 개수가 같으면 먼저 나온 값(routines 는 종류·이름순)이고, 셀 수 있는 루틴이 없으면 undefined (applyScript 가 MySQL 기본 모드를 쓴다)
export function suggestSqlMode(routines: readonly Routine[]): string | undefined {
  return mostCommon(routines.map(routineSqlMode).filter(isDefined), (mode) => mode);
}
