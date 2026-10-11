// 토큰 사이(gap) 주석을 mysql 클라이언트(add_line 상태기계)와 서버가 같은 경계로 읽는지 본다 (스펙 4.6, 12회차).
// 서버·lexer 는 블록 주석을 첫 '*/' 에서 닫지만, 클라이언트는 블록 주석 안의 '/*!' 에서 조건 주석 플래그를 켜고 첫 '*/' 로는 그
// 플래그만 꺼 다음 '*/' 까지 입력을 버린다 (8.4 실측). optimizer hint('/*+ … */') 안은 주석으로 보지 않아 백슬래시 명령('\\!'
// 셸 실행, '\\g' 문장 끊기)과 줄 맨 앞 delimiter 를 실행한다 (8.4 실측). 그래서 주석은 평평해야 한다:
//  - 블록 주석·hint·건너뛰는 버전 주석 안에 '/*' 가 없다
//  - 버전 주석 안에 다른 버전 주석·블록 주석이 없다
//  - hint 안에 백슬래시·delimiter 가 없다
import type { LexMode, Token } from './lexer';

export interface GapReport {
  safe: boolean; // 위 규칙을 지킨다
  lineComment: boolean; // 줄 주석('-- ', '#')이 있다
  other: boolean; // 공백·주석이 아닌 글자가 있다 (lexer 가 토큰으로 내므로 정상 입력에는 없다)
}

const DIGIT = /[0-9]/;
const HINT_UNSAFE = /\\|delimiter/i;
const isDashComment = (s: string, i: number): boolean => s.startsWith('--', i) && (i + 2 >= s.length || /[\x00-\x20\x7f]/.test(s[i + 2]));

// src 의 토큰 사이 글자를 lexer 와 같은 규칙으로 주석 단위로 읽는다. 버전 주석 표식은 여러 gap 에 걸친다
export function scanGaps(src: string, toks: Token[], mode: LexMode = {}): GapReport {
  const report: GapReport = { safe: true, lineComment: false, other: false };
  let versioned = 0;
  let pos = 0;
  for (const t of [...toks, { s: src.length, e: src.length }]) {
    versioned = scanGap(src.slice(pos, t.s), mode, versioned, report);
    pos = t.e;
  }
  return report;
}

function scanGap(gap: string, mode: LexMode, depth: number, report: GapReport): number {
  let versioned = depth;
  let i = 0;
  const block = (start: number, contentStart: number): number => {
    const end = gap.indexOf('*/', contentStart);
    if (end < 0) {
      report.safe = false;
      return gap.length;
    }
    const content = gap.slice(contentStart, end);
    if (content.includes('/*') || versioned > 0) report.safe = false;
    if (gap.startsWith('/*+', start) && HINT_UNSAFE.test(content)) report.safe = false;
    return end + 2;
  };
  while (i < gap.length) {
    if (/\s/.test(gap[i])) {
      i++;
    } else if (gap.startsWith('/*!', i)) {
      if (mode.discardVersioned === true && DIGIT.test(gap[i + 3] ?? '')) {
        i = block(i, i + 3);
        continue;
      }
      if (versioned > 0) report.safe = false;
      i += 3;
      while (i < gap.length && DIGIT.test(gap[i])) i++;
      versioned++;
    } else if (versioned > 0 && gap.startsWith('*/', i)) {
      versioned--;
      i += 2;
    } else if (gap.startsWith('/*', i)) {
      i = block(i, i + 2);
    } else if (isDashComment(gap, i) || gap[i] === '#') {
      report.lineComment = true;
      const end = gap.indexOf('\n', i);
      i = end < 0 ? gap.length : end + 1;
    } else {
      report.other = true;
      i++;
    }
  }
  return versioned;
}
