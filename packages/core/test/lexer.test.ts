import { describe, expect, it } from 'vitest';
import { objectReferences, quotedIdentifiers, quoteIdent, quoteString, tableReferences, tokenize, viewReferences } from '../src/lexer';

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

  it('-- 뒤에 공백·탭·개행·제어 문자가 오거나 입력이 끝나면 주석이다 (MySQL 서버 규칙, 11회차 3)', () => {
    expect(tokenize('a --\tb\nc').map((t) => t.v)).toEqual(['a', 'c']);
    expect(tokenize('a --\nb').map((t) => t.v)).toEqual(['a', 'b']);
    expect(tokenize('a --\r\nb').map((t) => t.v)).toEqual(['a', 'b']);
    expect(tokenize('a --\u0001 b\nc').map((t) => t.v)).toEqual(['a', 'c']);
    expect(tokenize('a --').map((t) => t.v)).toEqual(['a']);
    expect(tokenize('1--1').map((t) => t.v)).toEqual(['1', '-', '-', '1']);
    expect(tokenize('a --b').map((t) => t.v)).toEqual(['a', '-', '-', 'b']);
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

describe('tableReferences · quotedIdentifiers (5회차 6)', () => {
  it('FROM/JOIN 뒤 식별자만 테이블 참조로 본다 (괄호 조인·schema.table·서브쿼리)', () => {
    const body = "select `a`.`id` AS `b`,(select count(0) from `c`) AS `n` from ((`a` join `shop`.`d` `x` on((`x`.`id` = `a`.`id`))) left join `e` on(true)) where (`a`.`k` = 'from `f`')";
    expect(tableReferences(body)).toEqual(['c', 'a', 'd', 'e']);
  });

  it('문자열 안 식별자는 빼고, 닫히지 않은 따옴표면 undefined', () => {
    expect(quotedIdentifiers("concat(_utf8mb4'`x`', `y`)")).toEqual(['y']);
    expect(quotedIdentifiers("'abc")).toBeUndefined();
    expect(tableReferences("from `a` where 'x")).toBeUndefined();
  });
});

describe('viewReferences (8회차 2, 10회차 2)', () => {
  it('FROM/JOIN 테이블(relations)과 함수 호출(routines)을 나눠 내고 별칭·컬럼·문자열은 뺀다', () => {
    const body = "select `shop`.`tax`(`o`.`amt`) AS `chat_log`,'`log`' AS `s` from (`o` join `shop`.`m`) where coalesce(`o`.`x`, 0)";
    expect(viewReferences(body)).toEqual({ relations: ['o', 'm'], routines: ['tax', 'coalesce'] });
    expect(viewReferences("from `a` where 'x")).toBeUndefined();
  });

  it('현재 스키마 목록을 주면 다른 스키마로 한정된 테이블·함수는 로컬 참조가 아니다 (11회차 6)', () => {
    const body = "select `ext`.`fn`(`t`.`a`) AS `x`,`shop`.`g`() AS `y`,`h`() AS `z` from ((`ext`.`t` join `shop`.`m`) join `u`)";
    expect(viewReferences(body, new Set(['shop']))).toEqual({ relations: ['m', 'u'], routines: ['g', 'h'] });
    expect(viewReferences(body, new Set())).toEqual({ relations: ['u'], routines: ['h'] });
    expect(objectReferences(body, ['t', 'fn'], new Set(['shop']))).toEqual({ relations: ['m', 'u'], routines: ['g', 'h'] });
  });

  it('토큰으로 나눌 수 없으면 후보 중 `이름` 이 나오는 것을 양쪽 모두로 본다 (안전 쪽)', () => {
    expect(objectReferences("select `f`() from `t` where 'x", ['f', 't', 'u'])).toEqual({ relations: ['f', 't'], routines: ['f', 't'] });
  });
});

describe('16진수·비트 리터럴 (9회차 7)', () => {
  it('0x…, 0b…, x\'…\', b\'…\' 는 한 토큰이다', () => {
    const toks = tokenize("DEFAULT 0x00FF DEFAULT 0b101 DEFAULT X'0A0B' DEFAULT b'101' 0xZZ");
    expect(toks.map((t) => [t.t, t.v])).toEqual([
      ['word', 'DEFAULT'], ['number', '0x00FF'], ['word', 'DEFAULT'], ['number', '0b101'],
      ['word', 'DEFAULT'], ['number', "X'0A0B'"], ['word', 'DEFAULT'], ['number', "b'101'"],
      ['number', '0'], ['word', 'xZZ'],
    ]);
  });
});
