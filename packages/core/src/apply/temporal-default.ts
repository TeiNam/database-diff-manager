// DATE·DATETIME·TIMESTAMP·TIME 기본값 문자열을 SHOW CREATE 표기로 다시 쓴다 (MySQL 8.0.46·8.4.11 실측, 두 버전이 같다).
// MySQL 은 값을 다시 써서 저장한다: DATETIME DEFAULT '2020-01-01' → '2020-01-01 00:00:00', DATETIME(3) DEFAULT '2020-01-01 10:20:30' → '2020-01-01 10:20:30.000',
// TIME DEFAULT '12:34' → '12:34:00'. 1차에서는 표준 꼴(0 으로 채운 YYYY-MM-DD[ HH:MM[:SS[.f]]], [-]H:MM[:SS[.f]])만 다시 쓰고,
// 그 밖의 꼴(구분자 생략·0 으로 채우지 않은 달·T 구분·반올림되는 소수 초 …)은 unsupported 로 돌려 다시 추출하게 한다.
// TIMESTAMP 의 표현 범위(UTC 기준 1970-01-01 00:00:01 ~ 2038-01-19 03:14:07)는 서버 시간대에 따라 달라 보지 않는다
export type TemporalType = 'date' | 'datetime' | 'timestamp' | 'time';

export const TEMPORAL_TYPES: ReadonlySet<string> = new Set<TemporalType>(['date', 'datetime', 'timestamp', 'time']);

// value: 다시 쓴 기본값, invalid: MySQL 이 거부하는 값(1067)의 이유, unsupported: 1차에서 다시 쓰지 못하는 꼴
export type TemporalResult = { value: string } | { invalid: string } | { unsupported: true };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?$/;
const TIME_RE = /^(-?)(\d{1,3}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/;
const MAX_TIME_SECONDS = 838 * 3600 + 59 * 60 + 59;
const UNSUPPORTED: TemporalResult = { unsupported: true };

const daysInMonth = (year: number, month: number): number =>
  month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

// 소수 초: 컬럼 정밀도(fsp)만큼 0 으로 채운다. 정밀도를 넘는 자리에 0 이 아닌 숫자가 있으면 MySQL 이 반올림하므로 받지 않는다 (undefined)
function fraction(digits: string | undefined, fsp: number): string | undefined {
  const given = digits ?? '';
  if (given.length > fsp && /[1-9]/.test(given.slice(fsp))) return undefined;
  return fsp === 0 ? '' : `.${given.slice(0, fsp).padEnd(fsp, '0')}`;
}

export function temporalDefault(type: TemporalType, fsp: number, text: string): TemporalResult {
  return type === 'time' ? timeDefault(fsp, text) : dateDefault(type, fsp, text);
}

function dateDefault(type: Exclude<TemporalType, 'time'>, fsp: number, text: string): TemporalResult {
  const m = (type === 'date' ? DATE_RE : DATETIME_RE).exec(text);
  if (!m) return UNSUPPORTED;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month === 0 || day === 0) return { invalid: `'${text}' 은 달이나 일이 0 인 날짜입니다 — 기본 SQL_MODE(NO_ZERO_DATE·NO_ZERO_IN_DATE)는 거부하고, 그 모드를 끈 세션은 1차에서 받지 않습니다` };
  if (month > 12 || day > daysInMonth(year, month)) return { invalid: `'${text}' 은 올바른 날짜가 아닙니다` };
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (type === 'date') return { value: date };
  const [hour, minute, second] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  if (hour > 23 || minute > 59 || second > 59) return { invalid: `'${text}' 은 올바른 시각이 아닙니다` };
  const frac = fraction(m[7], fsp);
  return frac === undefined ? UNSUPPORTED : { value: `${date} ${m[4] ?? '00'}:${m[5] ?? '00'}:${m[6] ?? '00'}${frac}` };
}

function timeDefault(fsp: number, text: string): TemporalResult {
  const m = TIME_RE.exec(text);
  if (!m) return UNSUPPORTED;
  const [hours, minutes, seconds] = [Number(m[2]), Number(m[3]), Number(m[4] ?? 0)];
  if (minutes > 59 || seconds > 59 || hours * 3600 + minutes * 60 + seconds > MAX_TIME_SECONDS) return { invalid: `'${text}' 은 올바른 시간이 아닙니다` };
  const frac = fraction(m[5], fsp);
  if (frac === undefined) return UNSUPPORTED;
  const isZero = hours === 0 && minutes === 0 && seconds === 0 && !/[1-9]/.test(frac); // 소수 초만 0 이 아니어도 부호가 남는다 ('-00:00:00.123', 8.0.46·8.4.11 실측)
  const sign = m[1] === '-' && !isZero ? '-' : '';
  return { value: `${sign}${m[2].padStart(2, '0')}:${m[3]}:${m[4] ?? '00'}${frac}` };
}
