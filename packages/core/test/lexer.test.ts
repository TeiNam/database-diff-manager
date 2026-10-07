import { describe, expect, it } from 'vitest';
import { quoteIdent, quoteString, tokenize } from '../src/lexer';

describe('tokenize', () => {
  it('식별자·문자열·단어·숫자·기호를 구분한다', () => {
    const toks = tokenize("`a``b` 'it''s' DEFAULT 10 (");
    expect(toks.map((t) => [t.t, t.v])).toEqual([
      ['ident', 'a`b'],
      ['string', "it's"],
      ['word', 'DEFAULT'],
      ['number', '10'],
      ['op', '('],
    ]);
  });

  it('버전 주석 표식은 버리고 내용은 토큰으로 남긴다', () => {
    const toks = tokenize('KEY `k` (`c`) /*!80000 INVISIBLE */');
    expect(toks.map((t) => t.v)).toEqual(['KEY', 'k', '(', 'c', ')', 'INVISIBLE']);
  });

  it('일반 주석은 건너뛴다', () => {
    expect(tokenize('/* Table : x */ CREATE -- 끝\n').map((t) => t.v)).toEqual(['CREATE']);
  });

  it('백슬래시 이스케이프를 디코딩한다', () => {
    expect(tokenize("'a\\nb\\\\c'")[0].v).toBe('a\nb\\c');
  });

  it('토큰 오프셋으로 원문을 복원할 수 있다', () => {
    const src = "COMMENT '한글, 쉼표'";
    const str = tokenize(src)[1];
    expect(src.slice(str.s, str.e)).toBe("'한글, 쉼표'");
  });

  it('닫히지 않은 문자열은 오류', () => {
    expect(() => tokenize("'abc")).toThrow(/닫히지 않은 따옴표/);
  });
});

describe('quote', () => {
  it('MySQL SHOW CREATE 규칙으로 인용한다', () => {
    expect(quoteIdent('a`b')).toBe('`a``b`');
    expect(quoteString("it's\n\\")).toBe("'it''s\\n\\\\'");
  });
});
