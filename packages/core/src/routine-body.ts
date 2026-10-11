// 루틴 본문(특성 뒤 첫 토큰부터)이 서버 기준으로 문장 하나인지 본다 (스펙 4.6, 12회차).
// mysql 클라이언트는 DELIMITER ;; 로 감싼 본문을 한 번에 보내고, 서버는 다중 문장으로 실행한다: `BEGIN … END; DROP TABLE x`
// 나 `RETURN 1; DROP TABLE x` 는 CREATE 뒤에 DROP 을 실행한다 (8.4 실측). 그래서 본문은 다음 둘 중 하나여야 한다
//  - BEGIN … END 복합문 하나(앞 라벨, 뒤 라벨 허용) — 안쪽 ';' 는 복합문 깊이 안에서만
//  - ';' 없는 단일 문장 (RETURN 식, SELECT …)
// 깊이는 BEGIN·CASE 로 열고 END 로 닫는다. BEGIN 은 서버가 복합문으로 읽는 자리(문장 맨 앞, 라벨 뒤, THEN·ELSE 뒤, WHILE … DO
// 뒤, LOOP·REPEAT 뒤, 핸들러 조건 뒤)에서만 열고, 그 밖의 begin(식별자로 쓸 수 있다)은 거부한다 — 식별자 begin 을 복합문으로 세면
// 우리 깊이가 서버보다 깊어져 서버의 바깥 ';' 를 안쪽으로 오판한다. 반대로 얕게 세는 쪽(END 를 일찍 닫음)은 뒤 토큰을 거부하므로
// 안전하다. 판단할 수 없는 모양(단일 문장 IF·LOOP 본문, 식별자 begin/end 등)은 거부해 수동 확인으로 돌린다
import type { Token } from './lexer';

type Frame = 'begin' | 'case-stmt' | 'case-expr';

const CONSTRUCT_END = new Set(['IF', 'LOOP', 'WHILE', 'REPEAT']);
// 핸들러 조건 값 자리 (이 뒤의 begin 은 조건 이름이다)
const HANDLER_CONDITION = new Set(['FOR', ',', 'SQLSTATE', 'VALUE', 'NOT']);

const upper = (t: Token | undefined): string | undefined => (t?.t === 'word' ? t.v.toUpperCase() : t?.t === 'op' ? t.v : undefined);
const isName = (t: Token | undefined): boolean => t?.t === 'word' || t?.t === 'ident';

export function isSingleRoutineBody(toks: readonly Token[]): boolean {
  const stack: Frame[] = [];
  let paren = 0;
  let stmtStart = 0;
  for (let i = 0; i < toks.length; i++) {
    const w = upper(toks[i]);
    const top = stack.at(-1);
    // 라벨: 문장 맨 앞 이름 + ':' (':=' 대입 제외)
    if (i === stmtStart && paren === 0 && isName(toks[i]) && upper(toks[i + 1]) === ':' && upper(toks[i + 2]) !== '=') {
      i++;
      stmtStart = i + 1;
      continue;
    }
    if (w === '(') paren++;
    else if (w === ')' && --paren < 0) return false;
    else if (w === ';') {
      if (paren > 0 || top === undefined || top === 'case-expr') return false;
      stmtStart = i + 1;
    } else if (w === 'BEGIN') {
      if (paren > 0 || top === 'case-expr' || !(i === stmtStart || isHandlerBody(toks, stmtStart, i))) return false;
      stack.push('begin');
      stmtStart = i + 1;
    } else if (w === 'CASE') {
      stack.push(i === stmtStart && paren === 0 && top !== 'case-expr' ? 'case-stmt' : 'case-expr');
    } else if (w === 'END') {
      const next = upper(toks[i + 1]);
      if (next !== undefined && CONSTRUCT_END.has(next)) {
        if (top === 'case-expr') return false;
        i++;
        continue;
      }
      if (next === 'CASE') {
        if (top !== 'case-stmt') return false;
        stack.pop();
        i++;
        continue;
      }
      if (top === 'case-expr') {
        stack.pop();
        continue;
      }
      // 복합문 END 는 ';' 나 빈 BEGIN 바로 뒤에만 온다
      if (top !== 'begin' || !['BEGIN', ';'].includes(upper(toks[i - 1]) ?? '')) return false;
      stack.pop();
      // 뒤 라벨
      if (isName(toks[i + 1]) && (i + 2 === toks.length || upper(toks[i + 2]) === ';')) i++;
      // 바깥 복합문을 닫았으면 본문이 끝나야 한다
      if (stack.length === 0) return i === toks.length - 1;
    } else if (paren === 0 && top !== 'case-expr' && isStatementLead(toks, stmtStart, i, w)) {
      stmtStart = i + 1;
    }
  }
  return stack.length === 0 && paren === 0;
}

// 다음 토큰부터 새 문장이 시작되는 자리: THEN·ELSE, 문장 맨 앞 LOOP·REPEAT, WHILE 문의 DO (문장 맨 앞 DO 는 DO 식 문장이다)
function isStatementLead(toks: readonly Token[], stmtStart: number, i: number, w: string | undefined): boolean {
  if (w === 'THEN' || w === 'ELSE') return true;
  if (w === 'LOOP' || w === 'REPEAT') return i === stmtStart;
  return w === 'DO' && i !== stmtStart && upper(toks[stmtStart]) === 'WHILE';
}

// DECLARE … HANDLER FOR 조건[, 조건] 뒤의 핸들러 문장 자리
function isHandlerBody(toks: readonly Token[], stmtStart: number, i: number): boolean {
  if (upper(toks[stmtStart]) !== 'DECLARE') return false;
  const handler = toks.slice(stmtStart, i).findIndex((t) => upper(t) === 'HANDLER');
  return handler >= 0 && upper(toks[stmtStart + handler + 1]) === 'FOR' && !HANDLER_CONDITION.has(upper(toks[i - 1]) ?? '');
}
