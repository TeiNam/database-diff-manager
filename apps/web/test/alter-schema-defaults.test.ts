import { describe, expect, it } from 'vitest';
import { collationAfterCharset } from '../src/features/alter/schema-defaults';

// 문자셋 칸을 고쳤을 때 콜레이션 칸의 새 값. 인자: 새 문자셋, 지금 콜레이션
describe('collationAfterCharset', () => {
  it.each([
    ['latin1', 'utf8mb4_0900_ai_ci', 'latin1_swedish_ci'],
    ['utf8mb4', 'latin1_swedish_ci', 'utf8mb4_0900_ai_ci'],
    ['utf8mb3', 'utf8mb4_0900_ai_ci', 'utf8mb3_general_ci'],
    ['utf8', 'utf8mb4_0900_ai_ci', 'utf8mb3_general_ci'], // utf8 은 utf8mb3 의 별칭이다
    ['ascii', 'utf8mb4_0900_ai_ci', 'ascii_general_ci'],
    ['euckr', 'utf8mb4_0900_ai_ci', 'euckr_korean_ci'],
    ['  LATIN1 ', 'utf8mb4_0900_ai_ci', 'latin1_swedish_ci'], // 대소문자·앞뒤 공백
  ])('문자셋 %j 로 바꾸면 콜레이션 %j 은 %j 이 된다', (charset, collation, expected) => {
    expect(collationAfterCharset(charset, collation)).toBe(expected);
  });

  it.each([
    ['utf8mb4', 'utf8mb4_general_ci'],
    ['UTF8MB4', 'utf8mb4_unicode_ci'],
    ['utf8', 'utf8mb3_bin'],
    ['latin1', 'latin1_swedish_ci'],
  ])('콜레이션이 이미 그 문자셋의 것이면(%j, %j) 그대로 둔다 — 쓴 모양까지', (charset, collation) => {
    expect(collationAfterCharset(charset, collation)).toBe(collation);
  });

  it.each([
    ['klingon', '알 수 없는 문자셋'],
    ['utf8m', '입력 도중의 이름'],
    ['', '빈 칸'],
    ['binary', 'binary 는 스키마 기본값으로 쓰지 않는다'],
  ])('문자셋 %j (%s) 은 콜레이션을 건드리지 않는다', (charset) => {
    expect(collationAfterCharset(charset, 'utf8mb4_general_ci')).toBe('utf8mb4_general_ci');
  });

  it('지금 콜레이션이 알 수 없는 이름이면 새 문자셋의 기본 콜레이션으로 바꾼다', () => {
    expect(collationAfterCharset('latin1', 'not a collation')).toBe('latin1_swedish_ci');
    expect(collationAfterCharset('latin1', '')).toBe('latin1_swedish_ci');
  });
});
