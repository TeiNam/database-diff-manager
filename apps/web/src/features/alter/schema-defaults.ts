import { ApplyFailure, resolveDefaults, type ApplyDefaults } from '@tdm/core';

// 이름을 MySQL 표기로 맞춘 스키마 기본값 (서버가 요청을 받을 때 쓰는 core 의 resolveDefaults 와 같다).
// 알 수 없는 이름이면 undefined — 입력 도중의 'utf8m' 같은 값도 여기에 든다
function resolve(given: Partial<ApplyDefaults>): ApplyDefaults | undefined {
  try {
    return resolveDefaults(given);
  } catch (error) {
    if (error instanceof ApplyFailure) return undefined;
    throw error;
  }
}

// 문자셋 칸을 고쳤을 때 콜레이션 칸의 새 값. 문자셋만 바꾸면 이전 콜레이션이 새 문자셋의 것이 아니어서 서버가 1253 으로 거부한다.
// 콜레이션이 이미 새 문자셋의 것이면 그대로 두고(사용자가 먼저 고른 값을 지우지 않는다), 아니면 새 문자셋의 기본 콜레이션으로 맞춘다.
// 알 수 없는 문자셋과, 스키마 기본값으로 쓸 수 없는 binary 는 콜레이션을 사용자에게 맡긴다
export function collationAfterCharset(charset: string, collation: string): string {
  const next = resolve({ charset: charset.trim() });
  if (!next || next.charset === 'binary') return collation;
  return resolve({ collation: collation.trim() })?.charset === next.charset ? collation : next.collation;
}
