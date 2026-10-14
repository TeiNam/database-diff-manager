import { describe, expect, it } from 'vitest';
import { normalizeDefault } from '../../src/apply/normalize-mysql';
import { ApplyFailure, RE_EXPORT, type DefaultSpec } from '../../src/apply/types';

// FLOAT·DOUBLE 기본값. 기대값은 MySQL 8.0.46·8.4.11 에 CREATE TABLE t (c <타입> DEFAULT <값>) 을 만든 뒤 SHOW CREATE TABLE 이 찍은 값이다 (두 버전이 같다).
// MySQL 은 값을 이진 부동소수점으로 저장했다가 다시 찍는다: (M,D) 가 없으면 FLOAT 는 유효숫자 6자리로, DOUBLE 은 가장 짧은 표기로, 너무 크거나 작으면 지수 표기로,
// (M,D) 가 있으면 소수 D 자리로 반올림해 찍는다. 그대로 재현할 수 있는 꼴만 받고 나머지는 RE_EXPORT 로 거부한다
const col = (type: string) => ({ name: 'c', type, nullable: true });
const num = (value: string): DefaultSpec => ({ kind: 'number', value });
const str = (value: string): DefaultSpec => ({ kind: 'string', value });
const messageOf = (spec: DefaultSpec, type: string): string => {
  try {
    normalizeDefault(spec, col(type));
  } catch (e) {
    expect(e).toBeInstanceOf(ApplyFailure);
    return (e as Error).message;
  }
  throw new Error(`거부해야 한다: ${JSON.stringify(spec)} on ${type}`);
};

describe('FLOAT·DOUBLE 기본값 — (M,D) 없음', () => {
  it.each([
    ['float', num('0'), '0'], ['float', num('1.5'), '1.5'], ['float', str('1.50'), '1.5'], ['float', num('1.0'), '1'], ['float', num('123456'), '123456'],
    ['float', num('1000000'), '1000000'], ['float', num('0.000001'), '0.000001'], ['float', num('-2.5'), '-2.5'], ['float', num('99999.9'), '99999.9'],
    ['float', num('100000000000'), '100000000000'], ['float', num('-10000000000'), '-10000000000'], ['float', num('0.0000000001'), '0.0000000001'],
    ['float', num('0.000123456'), '0.000123456'], ['float', num('1234560000'), '1234560000'], ['float', str('1e2'), '100'], ['float unsigned', num('1.5'), '1.5'],
    ['double', num('0'), '0'], ['double', num('3.14159265'), '3.14159265'], ['double', num('1234567'), '1234567'], ['double', num('1e14'), '100000000000000'],
    ['double', num('999999999999999'), '999999999999999'], ['double', num('0.00001'), '0.00001'], ['double', num('1e-15'), '0.000000000000001'],
    ['double', num('0.0000000000001234567891'), '0.0000000000001234567891'], ['double', num('-0.000000000000123456789'), '-0.000000000000123456789'],
    ['double', num('1234567890.12345'), '1234567890.12345'], ['double', num('-123456789012345'), '-123456789012345'], ['double', str('1.50'), '1.5'],
    ['double', num('0.1e1'), '1'],
  ] as const)('%s DEFAULT %j → %s', (type, spec, out) => expect(normalizeDefault(spec as DefaultSpec, col(type))).toBe(`'${out}'`));

  // 괄호 안은 MySQL 이 찍는 값
  it.each([
    ['float', '3.14159265'], // '3.14159' — 유효숫자 6자리
    ['float', '1234567'], // '1234570'
    ['float', '16777217'], // '16777200'
    ['float', '1e15'], ['float', '1e17'], // '1e15'·'1e17'
    ['float', '1000000000000'], // '1e12' — 'f' 표기가 12자를 넘는다
    ['float', '-100000000000'], // '-1e11' — 음수는 11자
    ['float', '-0.0000000001'], // '-1e-10'
    ['float', '0.000000000000001'], // '1e-15'
    ['double', '1e15'], ['double', '1500000000000000'], ['double', '1e17'], ['double', '1e20'], // '1e15'·'1.5e15'·'1e17'·'1e20'
    ['double', '0.0000000000000001'], // '1e-16'
    ['double', '0.00000000000012345678912'], // '1.2345678912e-13' — 'f' 표기가 24자를 넘는다
    ['double', '-0.0000000000001234567891'], // '-1.234567891e-13' — 음수는 23자
    ['double', '0.000000000012345678901234'], // '1.2345678901234e-11'
    ['double', '3.1415926535897932'], // '3.141592653589793' — 유효숫자가 15자리를 넘는다
  ])('%s DEFAULT %s 은 MySQL 이 다시 써서 저장하므로 RE_EXPORT 로 거부한다', (type, value) => {
    const message = messageOf(num(value), type);
    expect(message.endsWith(RE_EXPORT), message).toBe(true);
  });

  it("문자열 '-0' 은 MySQL 이 '-0' 으로, 숫자 -0.0 은 '0' 으로 찍어 꼴이 갈리므로 거부한다", () => {
    for (const spec of [str('-0'), str('-0.0'), num('-0.0')]) for (const type of ['float', 'double']) expect(messageOf(spec, type).endsWith(RE_EXPORT)).toBe(true);
  });
});

describe('FLOAT·DOUBLE 기본값 — (M,D)', () => {
  it.each([
    ['float(7,3)', num('0'), '0.000'], ['float(7,3)', num('1.5'), '1.500'], ['float(7,3)', num('-1.5'), '-1.500'], ['float(7,3)', num('1234.5'), '1234.500'],
    ['float(7,0)', num('12'), '12'], ['float(10,2)', num('10000'), '10000.00'], ['float(10,2)', num('12345.67'), '12345.67'], ['float(10,2)', num('123456.78'), '123456.78'],
    ['float(12,4)', num('0.0001'), '0.0001'], ['float(255,30)', num('1.5'), '1.500000000000000000000000000000'], ['float(7,3) unsigned', num('1.5'), '1.500'],
    ['double(10,2)', num('0'), '0.00'], ['double(10,2)', num('1.5'), '1.50'], ['double(10,2)', num('1234567'), '1234567.00'], ['double(10,2)', num('12345678.9'), '12345678.90'],
    ['double(10,2)', num('99999999.99'), '99999999.99'], ['double(10,2)', num('-99999999.99'), '-99999999.99'], ['double(10,2)', str('0.00'), '0.00'],
    ['double(10,2)', num('-0.0'), '0.00'], ['double(10,2)', str('-0'), '0.00'], ['double(10,2)', num('1e2'), '100.00'], ['double(10,2)', str('1e2'), '100.00'],
    ['double(20,10)', num('0.1'), '0.1000000000'], ['double(20,4)', num('12345678901.2345'), '12345678901.2345'], ['double(5,5)', num('0.5'), '0.50000'],
    ['double(10,0)', num('12'), '12'], ['double(10,2) unsigned', num('1.5'), '1.50'],
  ] as const)('%s DEFAULT %j → %s', (type, spec, out) => expect(normalizeDefault(spec as DefaultSpec, col(type))).toBe(`'${out}'`));

  it.each([
    ['float(7,3)', '1234567'], ['double(10,2)', '123456789'], ['double(10,2)', '100000000'], ['double(10,2)', '-100000000'], ['double(10,2)', '1e15'], ['double(5,5)', '1'],
  ])('%s DEFAULT %s 은 정수부가 M-D 자리를 넘어 MySQL 이 1067 로 거부한다', (type, value) => {
    expect(messageOf(num(value), type)).toContain('(MySQL 1067)');
  });

  // 괄호 안은 MySQL 이 찍는 값. MySQL 은 이진 값의 소수부를 반올림해서(rint) 찍어 십진 반올림과 다르다 (1.005 → '1.00', DOUBLE(10,0) 의 1.5 → '1')
  it.each([
    ['float(7,3)', '3.14159265'], // '3.142'
    ['float(7,3)', '1.2345'], // '1.234'
    ['double(10,2)', '3.14159265'], // '3.14'
    ['double(10,2)', '1.005'], // '1.00'
    ['double(10,2)', '2.675'], // '2.67'
    ['double(10,0)', '1.5'], // '1'
    ['double(10,2)', '-0.001'], // '0.00'
    ['double(10,2)', '99999999.991'], // '99999999.99'
    ['float(10,2)', '1234567.89'], // '1234567.88' — FLOAT 정밀도
    ['float(12,4)', '1234.5678'], // '1234.5677'
    ['double(20,4)', '1234567890123.4567'], // '1234567890123.4568' — 찍는 자릿수가 15를 넘는다
  ])('%s DEFAULT %s 은 MySQL 이 반올림해 다시 쓰므로 RE_EXPORT 로 거부한다', (type, value) => {
    const message = messageOf(num(value), type);
    expect(message.endsWith(RE_EXPORT), message).toBe(true);
  });

  // (M,D) 기본값은 소수 D 자리로 0 을 채우므로, 한도를 보기 전에 찍으면 56자 스크립트가 1,000만 자 기본값을 만든다 (리뷰 1회차 F4).
  // 기준 덤프의 컬럼에 ALTER COLUMN … SET DEFAULT 를 써도 같은 검사를 거친다 (8.0.46·8.4.11 실측 오류 번호: D > 30 은 1425, D > M 은 1427, M 이 0 이나 255 초과면 1439)
  it.each([['double(255,10000000)', '1425'], ['double(10,31)', '1425'], ['float(5,10)', '1427'], ['double(0,0)', '1439'], ['double(256,2)', '1439']])(
    '%s 의 기본값은 찍기 전에 크기 한도로 거부한다 (MySQL %s)', (type, errno) => {
      const started = performance.now();
      expect(messageOf(num('0'), type)).toContain(`(MySQL ${errno})`);
      expect(performance.now() - started).toBeLessThan(50);
    });

  it('긴 숫자 문자열도 선형 시간에 판정한다', () => {
    const started = performance.now();
    const zeros = '0'.repeat(200000);
    expect(messageOf(num(`1${zeros}1${zeros}1`), 'double').endsWith(RE_EXPORT)).toBe(true);
    expect(messageOf(num(`0.${zeros}1${zeros}1`), 'double(10,2)').endsWith(RE_EXPORT)).toBe(true);
    expect(normalizeDefault(num(`1.${zeros}`), col('double(10,2)'))).toBe("'1.00'");
    expect(messageOf(num('1e999999999999'), 'float')).toMatch(RE_EXPORT);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
