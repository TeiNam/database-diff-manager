// 파티션 정의의 값 목록 읽기와 RANGE 상한 비교 (VALUES IN (…) / VALUES LESS THAN (…))

// opener 로 시작하는 괄호 안 값 목록 (따옴표 밖 공백 제거, 안쪽 괄호 유지). 읽을 수 없으면 undefined
export function parenValues(def: string, opener: RegExp): string[] | undefined {
  const m = opener.exec(def);
  if (!m) return undefined;
  const out: string[] = [];
  let depth = 1;
  let cur = '';
  let quote: string | undefined;
  for (let i = m[0].length; i < def.length; i++) {
    const ch = def[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') cur += def[++i] ?? '';
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return [...out, cur];
    else if (ch === ',' && depth === 1) {
      out.push(cur);
      cur = '';
      continue;
    }
    if (!/\s/.test(ch)) cur += ch;
  }
  return undefined;
}

// 상한 원소: MAXVALUE, 정수, 따옴표 문자열, 단조 함수('리터럴')
export type BoundValue = { kind: 'max' } | { kind: 'int'; v: bigint } | { kind: string; s: string };

const LESS_THAN_RE = /^\s*VALUES\s+LESS\s+THAN\s*\(/i;
// 날짜를 단조 증가하는 정수로 바꾸는 함수. 같은 함수끼리는 인자(날짜 문자열)로 비교한다
const MONOTONIC_FN_RE = /^(TO_DAYS|TO_SECONDS|UNIX_TIMESTAMP)\('((?:[^'\\]|'')*)'\)$/i;
const QUOTED_RE = /^'((?:[^'\\]|'')*)'$/;
// 바이트 순서와 콜레이션 순서가 같다고 볼 수 있는 문자열: 같은 꼴의 날짜·시각, 소문자+숫자, 대문자+숫자
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2}(?:\.\d+)?)?$/;
const STRING_SHAPES = [DATE_RE, /^[0-9a-z]*$/, /^[0-9A-Z]*$/];

function parseValue(raw: string): BoundValue | undefined {
  if (/^MAXVALUE$/i.test(raw)) return { kind: 'max' };
  if (/^-?\d+$/.test(raw)) return { kind: 'int', v: BigInt(raw) };
  const fn = MONOTONIC_FN_RE.exec(raw);
  if (fn) return { kind: `fn:${fn[1].toUpperCase()}`, s: fn[2].replace(/''/g, "'") };
  const str = QUOTED_RE.exec(raw);
  return str ? { kind: 'str', s: str[1].replace(/''/g, "'") } : undefined;
}

// RANGE 상한 튜플 ('VALUES LESS THAN MAXVALUE' 는 [max]). 원소 하나라도 읽을 수 없으면 undefined
export function upperBound(def: string): BoundValue[] | undefined {
  if (/^\s*VALUES\s+LESS\s+THAN\s+MAXVALUE\b/i.test(def)) return [{ kind: 'max' }];
  const values = parenValues(def, LESS_THAN_RE)?.map(parseValue);
  return values && values.every((v) => v !== undefined) ? (values as BoundValue[]) : undefined;
}

export const isAllMax = (b: BoundValue[]): boolean => b.every((v) => v.kind === 'max');

function compareValue(a: BoundValue, b: BoundValue): number | undefined {
  if (a.kind === 'max' || b.kind === 'max') return a.kind === b.kind ? 0 : a.kind === 'max' ? 1 : -1;
  if (a.kind !== b.kind) return undefined;
  if ('v' in a && 'v' in b) return a.v === b.v ? 0 : a.v < b.v ? -1 : 1;
  if (!('s' in a) || !('s' in b)) return undefined;
  const shape = STRING_SHAPES.find((re) => re.test(a.s) && re.test(b.s));
  if (!shape) return undefined;
  return a.s === b.s ? 0 : a.s < b.s ? -1 : 1;
}

// 튜플 사전식 비교 (-1·0·1). 길이·종류가 달라 비교할 수 없으면 undefined
export function compareBounds(a: BoundValue[], b: BoundValue[]): number | undefined {
  if (a.length !== b.length) return undefined;
  for (let i = 0; i < a.length; i++) {
    const c = compareValue(a[i], b[i]);
    if (c !== 0) return c;
  }
  return 0;
}
