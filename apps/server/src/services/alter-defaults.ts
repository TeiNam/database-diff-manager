// ALTER 적용 대화상자의 스키마 기본 문자셋·콜레이션 제안.
// td-export 덤프에는 DB 기본값이 없지만, 테이블을 문자셋 없이 만들었다면 대부분 DB 기본값을 물려받았을 것이므로
// 기준 버전 테이블의 DEFAULT CHARSET·COLLATE 최빈값을 가장 그럴듯한 값으로 돌려준다
import { ApplyFailure, resolveDefaults, type ApplyDefaults, type Table } from '@tdm/core';

// 테이블 옵션 키 (core apply/normalize-mysql.ts 의 tableCharset 과 같다)
const CHARSET_KEYS = ['DEFAULT CHARSET', 'CHARSET', 'DEFAULT CHARACTER SET', 'CHARACTER SET'];
const COLLATE_KEYS = ['COLLATE', 'DEFAULT COLLATE'];

const optionValue = (table: Table, keys: string[]): string | undefined => table.options.find((o) => keys.includes(o.key))?.value;

// 테이블 하나의 기본 문자셋·콜레이션을 MySQL 표기로 맞춘다. 옵션이 없거나, 알 수 없는 이름·맞지 않는 쌍이거나,
// 스키마 기본값으로 쓸 수 없는 binary 이면 undefined
function tableDefaults(table: Table): ApplyDefaults | undefined {
  const charset = optionValue(table, CHARSET_KEYS);
  const collation = optionValue(table, COLLATE_KEYS);
  if (charset === undefined && collation === undefined) return undefined;
  try {
    const resolved = resolveDefaults({ charset, collation });
    return resolved.charset === 'binary' ? undefined : resolved;
  } catch (error) {
    if (error instanceof ApplyFailure) return undefined;
    throw error;
  }
}

// 가장 많은 테이블이 쓰는 문자셋·콜레이션 쌍. 개수가 같으면 먼저 나온 쌍(tables 는 이름순)이고, 알 수 있는 테이블이 없으면 null
export function suggestAlterDefaults(tables: readonly Table[]): ApplyDefaults | null {
  const counts = new Map<string, { defaults: ApplyDefaults; count: number }>();
  for (const table of tables) {
    const defaults = tableDefaults(table);
    if (!defaults) continue;
    const key = `${defaults.charset}/${defaults.collation}`; // 이름은 \w+ 만 쓰므로 '/' 가 섞이지 않는다
    counts.set(key, { defaults, count: (counts.get(key)?.count ?? 0) + 1 });
  }
  let best: { defaults: ApplyDefaults; count: number } | undefined;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best?.defaults ?? null;
}
