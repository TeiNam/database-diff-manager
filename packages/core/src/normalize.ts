import { tokenize, type LexMode } from './lexer';
// diff 노이즈를 없애는 정규화 규칙은 이 파일에만 둔다

const INT_WIDTH = /^(tinyint|smallint|mediumint|int|bigint)\((\d+)\)/i;

// 정수 표시 폭 제거 (8.0.19+ 출력과 맞춤). tinyint(1)과 zerofill은 유지
export function normalizeType(raw: string): string {
  const type = raw.trim();
  if (/\bzerofill\b/i.test(type)) return type;
  return type.replace(INT_WIDTH, (m, base: string, width: string) =>
    base.toLowerCase() === 'tinyint' && width === '1' ? m : base,
  );
}

// 컬럼 줄의 정수 표시 폭: "  `col` int(11)" (zerofill 제외)
const COLUMN_INT_WIDTH = /^( {2}`(?:[^`]|``)+` )(tinyint|smallint|mediumint|int|bigint)\((\d+)\)(?!(?: unsigned)? zerofill)/gm;

// 왕복 비교와 diff 노이즈 제거를 위한 DDL 원문 정규화
export function normalizeDdl(ddl: string): string {
  return ddl
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
    .replace(/;$/, '')
    .replace(/ \*\/ ,$/gm, ' */,') // FULLTEXT … WITH PARSER 뒤 공백
    .replace(/^(\).*?) AUTO_INCREMENT=\d+/m, '$1')
    .replace(/^(CREATE (?:OR REPLACE )?(?:ALGORITHM=\w+ )?)DEFINER=\S+ /, '$1')
    .replace(COLUMN_INT_WIDTH, (m, head: string, base: string, width: string) =>
      base === 'tinyint' && width === '1' ? m : head + base,
    );
}

// 루틴 본문 비교·저장용: 문자열·백틱 밖의 줄바꿈(CRLF)과 줄 끝 공백 차이만 없앤다 (문자열 안의 공백은 값이므로 보존)
export function normalizeBody(body: string, mode: LexMode = {}): string {
  let toks;
  try {
    toks = tokenize(body, mode);
  } catch {
    return body.trim(); // 토큰화할 수 없으면(닫히지 않은 따옴표 등) 원문을 그대로 둔다
  }
  let out = '';
  let pos = 0;
  for (const t of toks) {
    if (t.t !== 'string' && t.t !== 'ident') continue;
    out += trimLineEnds(body.slice(pos, t.s)) + body.slice(t.s, t.e);
    pos = t.e;
  }
  return (out + trimLineEnds(body.slice(pos))).trim();
}

const trimLineEnds = (text: string): string => text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n');

// 루틴 DDL 원문의 왕복 비교 기준: DEFINER 와 끝 ';' 를 빼고 normalizeBody 규칙을 적용한다
export function normalizeRoutineDdl(ddl: string, mode: LexMode = {}): string {
  const body = normalizeBody(ddl.replace(/^\uFEFF/, ''), mode).replace(/;$/, '');
  return body.replace(/^CREATE DEFINER=\S+ /, 'CREATE ');
}

// 루틴을 만든 SQL_MODE 의 문자열 규칙
export const routineLexMode = (sqlMode: string | undefined): LexMode => ({ noBackslashEscapes: /(^|,)NO_BACKSLASH_ESCAPES(,|$)/i.test(sqlMode ?? '') });
