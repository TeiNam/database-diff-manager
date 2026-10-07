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
