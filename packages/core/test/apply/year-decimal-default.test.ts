import { describe, expect, it } from 'vitest';
import { normalizeDefault } from '../../src/apply/normalize-mysql';
import { ApplyFailure, MYSQL_DEFAULTS, RE_EXPORT, type DefaultSpec } from '../../src/apply/types';

// 기대값은 MySQL 8.0.46·8.4.11 에 CREATE TABLE … DEFAULT 로 만든 뒤 SHOW CREATE TABLE 이 찍은 값이다 (두 버전이 같다)
const col = (type: string) => ({ name: 'c', type, nullable: true });
const num = (value: string): DefaultSpec => ({ kind: 'number', value });
const str = (value: string): DefaultSpec => ({ kind: 'string', value });
const messageOf = (spec: DefaultSpec, type: string): string => {
  try {
    normalizeDefault(spec, col(type), MYSQL_DEFAULTS);
  } catch (e) {
    expect(e).toBeInstanceOf(ApplyFailure);
    return (e as Error).message;
  }
  throw new Error(`거부해야 한다: ${JSON.stringify(spec)} on ${type}`);
};

// YEAR: 네 자리(1901~2155, 0000)만 그대로 저장한다. 한두 자리는 MySQL 이 세기를 붙여 바꾸므로 (20 → '2020', 69 → '2069', 70 → '1970', 숫자 0 → '0000' 이지만 문자열 '0' → '2000')
// 재현하지 않고 RE_EXPORT 로 거부한다. 범위 밖 숫자는 MySQL 도 1067 이다
describe('YEAR 기본값', () => {
  it.each([[num('2020'), "'2020'"], [str('2020'), "'2020'"], [num('1901'), "'1901'"], [num('2155'), "'2155'"], [num('0000'), "'0000'"], [str('0000'), "'0000'"]] as const)(
    '%j → %s', (spec, out) => expect(normalizeDefault(spec as DefaultSpec, col('year'), MYSQL_DEFAULTS)).toBe(out));

  it.each(['0', '1', '20', '69', '70', '99', '00', '01', '0001', '0070', '0099'])('한두 자리 %s (0 으로 채운 꼴 포함)은 RE_EXPORT 로 거부한다 (숫자·문자열 모두)', (v) => {
    for (const spec of [num(v), str(v)]) {
      const message = messageOf(spec, 'year');
      expect(message.endsWith(RE_EXPORT), message).toBe(true);
      expect(message).toContain('YEAR');
    }
  });

  it.each(['1900', '2156', '9999', '100', '123', '0100', '12345'])('범위 밖 %s 은 MySQL 이 1067 로 거부한다', (v) => {
    expect(messageOf(num(v), 'year')).toContain('(MySQL 1067)');
    expect(messageOf(str(v), 'year')).toContain('(MySQL 1067)');
  });

  it.each(['+2020', ' 2020', '2020.5', '-1'])('숫자 꼴이지만 MySQL 이 값을 다시 쓰는 %j 은 RE_EXPORT 로 거부한다', (v) => {
    const message = messageOf(str(v), 'year');
    expect(message.endsWith(RE_EXPORT), message).toBe(true);
  });

  it.each(['abc', '', '2020x'])('숫자가 아닌 %j 은 MySQL 이 1067 로 거부한다', (v) => {
    expect(messageOf(str(v), 'year')).toContain('(MySQL 1067)');
  });

  it('ALTER COLUMN SET DEFAULT 도 같은 규칙이다 (normalizeDefault 를 쓴다): TRUE 는 한 자리 숫자 1', () => {
    expect(messageOf(num('1'), 'year').endsWith(RE_EXPORT)).toBe(true);
  });
});

// DECIMAL: 정확한 십진수로 scale 자리에 맞춘다. Number 를 거치면 15자리가 넘는 값(12345678901234567.89 → ...00)과 소수 17자리 이상(0.1.toFixed(20) = 0.10000000000000000555)이,
// 반올림이 필요한 값(1.005.toFixed(2) = 1.00, MySQL 은 1.01)이 틀린다. 반올림은 0 에서 먼 쪽이고 (2.5 → 3, -2.5 → -3, -0.005 → -0.01, -0.001 → 0.00),
// 정밀도를 넘으면 반올림한 뒤에 1067 이다
describe('DECIMAL 기본값 — 정확한 십진수', () => {
  it.each([
    [num('0'), 'decimal(12,4)', "'0.0000'"],
    [num('1.5'), 'decimal(10,2)', "'1.50'"],
    [num('12345678901234567.89'), 'decimal(20,2)', "'12345678901234567.89'"],
    [num('12345678901234567890.1234567890'), 'decimal(30,10)', "'12345678901234567890.1234567890'"],
    [num('12345678901234567890123456789012345.123456789012345678901234567890'), 'decimal(65,30)', "'12345678901234567890123456789012345.123456789012345678901234567890'"],
    [num('99999999999999999999'), 'decimal(20,0)', "'99999999999999999999'"],
    [num('0'), 'decimal(38,18)', "'0.000000000000000000'"],
    [num('0.1'), 'decimal(38,18)', "'0.100000000000000000'"],
    [num('.5'), 'decimal(10,2)', "'0.50'"],
    [num('1.'), 'decimal(10,2)', "'1.00'"],
    [num('007.50'), 'decimal(10,2)', "'7.50'"],
    [num('+5'), 'decimal(10,2)', "'5.00'"],
    [num('-3.5'), 'decimal(10,1)', "'-3.5'"],
    [str('12'), 'decimal(10,2)', "'12.00'"],
    [str(' 7 '), 'decimal(10,2)', "'7.00'"],
    [num('5'), 'decimal(10,2) unsigned', "'5.00'"],
    [num('0.000'), 'decimal(10,2)', "'0.00'"],
  ] as const)('%j on %s → %s', (spec, type, out) => expect(normalizeDefault(spec as DefaultSpec, col(type), MYSQL_DEFAULTS)).toBe(out));

  it.each([
    [num('1.236'), 'decimal(10,2)', "'1.24'"],
    [num('1.234'), 'decimal(10,2)', "'1.23'"],
    [num('1.005'), 'decimal(10,2)', "'1.01'"],
    [num('-0.005'), 'decimal(10,2)', "'-0.01'"],
    [num('-0.001'), 'decimal(10,2)', "'0.00'"], // 음수 0 은 없다
    [num('2.5'), 'decimal(10,0)', "'3'"],
    [num('-2.5'), 'decimal(10,0)', "'-3'"],
    [num('999.4'), 'decimal(3,0)', "'999'"],
    [str('1.236'), 'decimal(10,2)', "'1.24'"],
  ] as const)('반올림 %j on %s → %s', (spec, type, out) => expect(normalizeDefault(spec as DefaultSpec, col(type), MYSQL_DEFAULTS)).toBe(out));

  it.each([
    [num('1e2'), 'decimal(10,2)', "'100.00'"],
    [num('1.5e0'), 'decimal(10,2)', "'1.50'"],
    [num('0e0'), 'decimal(10,2)', "'0.00'"],
    [num('1e21'), 'decimal(25,2)', "'1000000000000000000000.00'"],
    [str('1e2'), 'decimal(10,2)', "'100.00'"],
    [num('25e-1'), 'decimal(10,1)', "'2.5'"],
  ] as const)('지수 표기 %j on %s → %s', (spec, type, out) => expect(normalizeDefault(spec as DefaultSpec, col(type), MYSQL_DEFAULTS)).toBe(out));

  it.each([
    [num('1234.5'), 'decimal(5,2)'], [num('1000'), 'decimal(3,0)'], [num('999.5'), 'decimal(3,0)'], [num('99999999.995'), 'decimal(10,2)'], [num('1e18'), 'decimal(20,2)'],
  ] as const)('정밀도를 넘는 %j on %s 은 MySQL 이 1067 로 거부한다', (spec, type) => {
    expect(messageOf(spec as DefaultSpec, type)).toContain('(MySQL 1067)');
  });

  it('가수가 15자리를 넘는 지수 표기는 MySQL 이 DOUBLE 을 거쳐 바꾸므로 재현하지 않고 RE_EXPORT 로 거부한다', () => {
    const message = messageOf(num('1.23456789012345678e5'), 'decimal(20,2)');
    expect(message.endsWith(RE_EXPORT), message).toBe(true);
    expect(messageOf(num('1e200'), 'decimal(20,2)').endsWith(RE_EXPORT)).toBe(true); // 지수가 너무 크다
    expect(messageOf(num('1e-200'), 'decimal(20,2)').endsWith(RE_EXPORT)).toBe(true);
  });

  it('MySQL 이 받지 않는 정밀도는 거부한다 (기본값이 없으면 보지 않는다)', () => {
    expect(messageOf(num('1'), 'decimal(70,2)')).toContain('(MySQL 1426)');
    expect(messageOf(num('1'), 'decimal(10,31)')).toContain('(MySQL 1425)');
    expect(messageOf(num('1'), 'decimal(5,10)')).toContain('(MySQL 1427)');
  });

  it('긴 숫자 문자열은 정밀도를 넘으면 BigInt 로 읽기 전에 거부하고, 소수가 길어도 scale 자리까지만 본다', () => {
    const started = performance.now();
    expect(messageOf(num('9'.repeat(200000)), 'decimal(10,2)')).toContain('(MySQL 1067)');
    expect(normalizeDefault(num(`0.${'1'.repeat(200000)}`), col('decimal(10,2)'), MYSQL_DEFAULTS)).toBe("'0.11'");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('FLOAT·DOUBLE 은 그대로다', () => {
    expect(normalizeDefault(num('1.5'), col('double'), MYSQL_DEFAULTS)).toBe("'1.5'");
    expect(normalizeDefault(str('1e2'), col('double'), MYSQL_DEFAULTS)).toBe("'100'");
  });
});
