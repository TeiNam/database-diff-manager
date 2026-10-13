// 쉼표 목록. splitTopLevel(덤프 파서와 공용)은 끝 쉼표를 조용히 버리고 빈 항목을 남긴다 — 사람이 쓴 스크립트에서는 MySQL 처럼 1064 로 거부한다
import { splitTopLevel } from '../cursor';
import type { Token } from '../lexer';
import { fail } from './types';

export function splitList(toks: readonly Token[], what: string): Token[][] {
  if (!toks.length) fail(`${what} 목록이 비었습니다 (MySQL 1064)`);
  const last = toks[toks.length - 1];
  if (last.t === 'op' && last.v === ',') fail(`${what} 목록이 쉼표로 끝납니다 (MySQL 1064)`);
  const items = splitTopLevel([...toks]);
  if (items.some((i) => !i.length)) fail(`${what} 목록에 빈 항목이 있습니다 (MySQL 1064)`);
  return items;
}
