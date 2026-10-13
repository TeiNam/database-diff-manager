import { describe, expect, it } from 'vitest';
import { normalizeDefault } from '../../src/apply/normalize-mysql';
import { temporalDefault } from '../../src/apply/temporal-default';
import { ApplyFailure, RE_EXPORT, type DefaultSpec } from '../../src/apply/types';

// 기대값은 MySQL 8.0.46·8.4.11 에 CREATE TABLE 로 만든 뒤 SHOW CREATE TABLE 이 찍은 DEFAULT 다 (두 버전이 같다)
describe('temporalDefault — MySQL 이 다시 쓰는 날짜·시간 기본값', () => {
  it.each([
    ['date', 0, '2020-01-01', '2020-01-01'],
    ['date', 0, '9999-12-31', '9999-12-31'],
    ['date', 0, '2020-02-29', '2020-02-29'], // 윤년
    ['datetime', 0, '2020-01-01', '2020-01-01 00:00:00'], // 날짜만 쓰면 시각이 붙는다
    ['datetime', 0, '2020-01-01 10:20:30', '2020-01-01 10:20:30'],
    ['datetime', 0, '2020-01-01 10:20', '2020-01-01 10:20:00'],
    ['datetime', 0, '2020-01-01 10:20:30.0', '2020-01-01 10:20:30'], // 정밀도를 넘는 소수 초가 0 뿐이면 버린다
    ['datetime', 3, '2020-01-01 10:20:30', '2020-01-01 10:20:30.000'], // 정밀도만큼 0 으로 채운다
    ['datetime', 3, '2020-01-01', '2020-01-01 00:00:00.000'],
    ['datetime', 3, '2020-01-01 10:20:30.5', '2020-01-01 10:20:30.500'],
    ['datetime', 6, '2020-01-01 10:20:30.12', '2020-01-01 10:20:30.120000'],
    ['timestamp', 0, '2030-01-01', '2030-01-01 00:00:00'],
    ['timestamp', 6, '2020-01-01 10:20:30', '2020-01-01 10:20:30.000000'],
    ['time', 0, '12:34', '12:34:00'],
    ['time', 0, '12:34:56', '12:34:56'],
    ['time', 0, '1:02:03', '01:02:03'], // 시는 두 자리로
    ['time', 0, '838:59:59', '838:59:59'],
    ['time', 0, '-838:59:59', '-838:59:59'],
    ['time', 3, '12:34:56.7', '12:34:56.700'],
    ['time', 2, '12:00:00', '12:00:00.00'],
    // 음수는 소수 초까지 쳐서 0 이 아니면 부호가 남는다
    ['time', 3, '-00:00:00.123', '-00:00:00.123'],
    ['time', 1, '-0:00:00.1', '-00:00:00.1'],
    ['time', 6, '-00:00:00.000001', '-00:00:00.000001'],
    ['time', 3, '-00:00:00.000', '00:00:00.000'],
    ['time', 0, '-00:00:00', '00:00:00'],
  ] as const)('%s(fsp %i) %j → %j', (type, fsp, text, out) => {
    expect(temporalDefault(type, fsp, text)).toEqual({ value: out });
  });

  it.each([
    ['date', '2020-02-30'], ['date', '2021-02-29'], ['date', '2020-00-01'], ['date', '2020-01-00'], ['date', '0000-00-00'], ['date', '2020-13-01'],
    ['datetime', '2020-01-01 24:00:00'], ['datetime', '2020-01-01 10:60:00'], ['datetime', '2020-01-01 10:20:61'], ['datetime', '0000-00-00 00:00:00'],
    ['time', '839:00:00'], ['time', '00:60:00'], ['time', '00:00:60'],
  ] as const)('%s %j 은 MySQL 이 거부하는 값 (1067)', (type, text) => {
    expect(temporalDefault(type, 0, text)).toEqual({ invalid: expect.stringContaining(text) });
  });

  // 1차에서는 표준 꼴만 다시 쓴다: 구분자 생략·0 으로 채우지 않은 달·일·T 구분·시각이 든 DATE·반올림되는 소수 초
  it.each([
    ['date', '20200101'], ['date', '2020-1-1'], ['date', '2020/01/01'], ['date', '2020-01-01 10:20:30'], ['date', ' 2020-01-01'],
    ['datetime', '2020-01-01T10:20:30'], ['datetime', '20200101102030'], ['datetime', '2020-1-1 1:2:3'], ['datetime', '2020-01-01 10:20:30.5'], ['datetime', ''],
    ['time', '12'], ['time', '120000'], ['time', '1 12:00:00'], ['time', '12:34:56.789'],
  ] as const)('%s %j 은 다시 쓰지 못한다', (type, text) => {
    expect(temporalDefault(type, 0, text)).toEqual({ unsupported: true });
  });
});

describe('normalizeDefault — 날짜·시간 컬럼', () => {
  const col = (type: string, nullable = true) => ({ name: 'c', type, nullable });
  const str = (value: string): DefaultSpec => ({ kind: 'string', value });

  it.each([
    ['date', '2020-01-01', "'2020-01-01'"],
    ['datetime', '2020-01-01', "'2020-01-01 00:00:00'"],
    ['datetime(3)', '2020-01-01 10:20:30', "'2020-01-01 10:20:30.000'"],
    ['timestamp', '2030-01-01', "'2030-01-01 00:00:00'"],
    ['timestamp(6)', '2030-01-01 01:02:03', "'2030-01-01 01:02:03.000000'"],
    ['time', '12:34', "'12:34:00'"],
    ['time(2)', '1:02:03', "'01:02:03.00'"],
  ])('%s DEFAULT %j → %s', (type, value, out) => {
    expect(normalizeDefault(str(value), col(type))).toBe(out);
  });

  it('MySQL 이 거부하는 값은 1067, 다시 쓰지 못하는 꼴은 RE_EXPORT 로 끝나는 안내', () => {
    expect(() => normalizeDefault(str('2020-02-30'), col('date'))).toThrow(/\(MySQL 1067\)/);
    expect(() => normalizeDefault(str('0000-00-00 00:00:00'), col('datetime'))).toThrow(/\(MySQL 1067\)/);
    for (const [spec, type] of [[str('20200101'), 'date'], [str('2020-1-1'), 'datetime'], [{ kind: 'number', value: '0' }, 'date'], [{ kind: 'number', value: '123456' }, 'time']] as const) {
      let message = '';
      try {
        normalizeDefault(spec as DefaultSpec, col(type));
      } catch (e) {
        expect(e).toBeInstanceOf(ApplyFailure);
        message = (e as Error).message;
      }
      expect(message.endsWith(RE_EXPORT), `${type} ${JSON.stringify(spec)}: ${message}`).toBe(true);
    }
  });

  it('NULL·CURRENT_TIMESTAMP 기본값은 그대로다', () => {
    expect(normalizeDefault({ kind: 'null' }, col('datetime'))).toBe('NULL');
    expect(normalizeDefault({ kind: 'now' }, col('datetime'))).toBe('CURRENT_TIMESTAMP');
    expect(normalizeDefault({ kind: 'now', fsp: 3 }, col('timestamp(3)'))).toBe('CURRENT_TIMESTAMP(3)');
  });
});
