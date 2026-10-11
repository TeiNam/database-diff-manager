// '-- ' 주석 줄 만들기. 주석 줄에 들어가는 모든 문자열(객체·컬럼 이름, 사유, notes, 주석 처리한 SQL)은 여기를 거친다.
// 백틱 식별자는 줄바꿈을 담을 수 있어(`a\nDROP TABLE x;`) 그대로 넣으면 주석이 끝나고 다음 줄이 실행문이 된다 (주입).
// 줄바꿈·CR·그 밖의 제어 문자를 '\n'·'\r'·'\xHH' 표기로 바꿔 한 줄 안에 가둔다 (탭은 줄을 끝내지 않으므로 둔다)

const CONTROL = /[\x00-\x08\x0a-\x1f\x7f]/g;
const NAMED: Record<string, string> = { '\n': '\\n', '\r': '\\r' };

export function escapeCommentText(text: string): string {
  return text.replace(CONTROL, (c) => NAMED[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

// 한 줄 안내: '-- ' + 이스케이프한 text
export const commentLine = (text: string): string => `-- ${escapeCommentText(text)}`;

// 여러 줄 SQL 을 줄마다 주석 처리한다 (SQL 의 줄바꿈은 줄을 나누고, 줄 안의 다른 제어 문자는 이스케이프한다)
export const commentLines = (sql: string): string => sql.split('\n').map(commentLine).join('\n');
