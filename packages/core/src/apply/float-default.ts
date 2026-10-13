// FLOAT·DOUBLE 기본값을 SHOW CREATE 표기로 다시 쓴다 (MySQL 8.0.46·8.4.11 실측, 두 버전이 같다 — test/apply/float-default.test.ts).
// MySQL 은 값을 이진 부동소수점으로 저장했다가 다시 찍는다 (sql/field.cc val_str, strings/dtoa.cc my_gcvt·my_fcvt):
// - (M,D) 없음: FLOAT 는 유효숫자 6자리로 반올림하고 DOUBLE 은 가장 짧은 표기로 찍는다. 'f' 표기('0.000123')가 FLOAT 12자·DOUBLE 24자(음수는 한 자 적게)를 넘거나
//   DOUBLE 의 소수점 위치가 범위 밖이면(1e15 이상, 1e-15 미만) 지수 표기('1e15', '1.2345678912e-13')로 찍는다
// - (M,D): 소수 D 자리로 0 을 채워 찍는다 ('1.5' → '1.500'). 정수부가 M-D 자리를 넘으면 1067 이다. D 자리 밖 숫자는 이진 값의 소수부를 rint 로 반올림해
//   십진 반올림과 다르다 (DOUBLE(10,2) 의 1.005 → '1.00', DOUBLE(10,0) 의 1.5 → '1')
// 그대로 다시 쓸 수 있는 꼴(유효숫자가 FLOAT 6·DOUBLE 15 자리 이하인 'f' 표기, D 자리 안에서 끝나는 (M,D) 값)만 받고, 나머지는 RE_EXPORT 로 거부한다
const DECIMAL_TEXT = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i;

// 값 = 0.digits × 10^point. digits 는 앞뒤 0 이 없다 ('' 이면 0)
interface Decimal {
  negative: boolean;
  digits: string;
  point: number;
}

interface FloatKind {
  digits: number; // 그대로 찍히는 유효숫자 자릿수 (FLT_DIG·DBL_DIG)
  width: number; // 'f' 표기로 찍는 최대 길이 (my_gcvt 의 폭)
}

const FLOAT: FloatKind = { digits: 6, width: 12 };
const DOUBLE: FloatKind = { digits: 15, width: 24 };
// DOUBLE 은 소수점 위치(0.digits × 10^point 의 point)가 이 범위 밖이면 폭이 남아도 지수 표기다 (my_gcvt 의 MAX_DECPT_FOR_F_FORMAT)
const MIN_POINT = -14;
const MAX_POINT = 15;

// 0 의 개수 (앞·뒤). 정규식 /0+$/ 는 긴 0 줄 뒤에 다른 숫자가 오면 시작 위치마다 끝까지 훑어 O(n^2) 이라 직접 센다
function leadingZeros(s: string): number {
  let k = 0;
  while (k < s.length && s.charCodeAt(k) === 0x30) k++;
  return k;
}

function trailingZeros(s: string): number {
  let k = 0;
  while (k < s.length && s.charCodeAt(s.length - 1 - k) === 0x30) k++;
  return k;
}

// 숫자 모양은 부른 쪽(numericDefault)이 이미 확인했다
function readDecimal(text: string): Decimal {
  const [, sign, intDigits, fracDigits = '', expText] = DECIMAL_TEXT.exec(text)!;
  const raw = intDigits + fracDigits;
  const lead = leadingZeros(raw);
  const digits = raw.slice(lead, raw.length - trailingZeros(raw.slice(lead)));
  return { negative: sign === '-', digits, point: digits ? intDigits.length + Number(expText ?? 0) - lead : 0 };
}

// 'f' 표기 (my_gcvt): '0.000ddd', 'ddd.ddd', 'ddd000'. scale: 소수 자리를 이만큼 0 으로 채운다
function plainText(x: Decimal, scale = 0): string {
  const whole = x.point <= 0 ? '0' : x.digits.slice(0, x.point).padEnd(x.point, '0');
  const frac = (x.point < 0 ? '0'.repeat(-x.point) + x.digits : x.digits.slice(Math.max(x.point, 0))).padEnd(scale, '0');
  return `${x.negative && x.digits ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

// 'f' 표기의 길이 (부호 제외)
const plainLength = ({ digits, point }: Decimal): number => (point <= 0 ? digits.length - point + 2 : point < digits.length ? digits.length + 1 : point);

export function floatDefault(text: string, type: string, bad: (why: string) => never, reExport: (why: string) => never): string {
  const kind = type.startsWith('float') ? FLOAT : DOUBLE;
  const x = readDecimal(text);
  const fixed = /^(?:float|double)\((\d+),(\d+)\)/.exec(type);
  return fixed ? fixedDefault(x, text, kind, Number(fixed[1]), Number(fixed[2]), bad, reExport) : plainDefault(x, text, kind, reExport);
}

function plainDefault(x: Decimal, text: string, kind: FloatKind, reExport: (why: string) => never): string {
  const name = kind === FLOAT ? 'FLOAT' : 'DOUBLE';
  if (!x.digits && x.negative) return reExport(`${text} 은(는) MySQL 이 쓴 꼴에 따라 '-0' 이나 '0' 으로 저장합니다`);
  if (x.digits.length > kind.digits) return reExport(`${text} 은(는) 유효숫자가 ${kind.digits}자리를 넘어 MySQL 이 ${name} 정밀도로 반올림해 저장합니다`);
  const width = kind.width - (x.negative ? 1 : 0);
  const exponent = plainLength(x) > width || (kind === DOUBLE && (x.point < MIN_POINT || (x.point > MAX_POINT && x.digits.length <= x.point)));
  if (exponent) return reExport(`${text} 은(는) MySQL 이 지수 표기(1e15 꼴)로 다시 써서 저장합니다`);
  return plainText(x);
}

function fixedDefault(x: Decimal, text: string, kind: FloatKind, precision: number, scale: number, bad: (why: string) => never, reExport: (why: string) => never): string {
  const name = `${kind === FLOAT ? 'FLOAT' : 'DOUBLE'}(${precision},${scale})`;
  if (!x.digits) return plainText(x, scale);
  if (Math.max(x.point, 0) > precision - scale) return bad(`${name} 의 범위를 넘습니다`);
  if (x.digits.length - x.point > scale) return reExport(`${text} 은(는) 소수 ${scale}자리 밖 숫자를 MySQL 이 이진 값으로 반올림해 저장합니다`);
  // FLOAT 는 float 로 바꾼 값의 오차가 마지막 자리 단위의 1/4 이하일 때만 소수 D 자리로 찍은 값이 그대로다. DOUBLE 은 찍는 자릿수가 15 이하면 된다
  const value = Number(text);
  const exact = kind === FLOAT ? Math.abs(Math.fround(value) - value) <= 0.25 * 10 ** -scale : x.point + scale <= DOUBLE.digits;
  return exact ? plainText(x, scale) : reExport(`${text} 은(는) MySQL 이 ${name} 정밀도로 반올림해 저장합니다`);
}
