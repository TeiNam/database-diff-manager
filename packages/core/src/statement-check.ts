// 최종 단일 문장 검사 (주입 심층 방어, 스펙 4.6): 출처(MD·SQL 덤프·앱이 넘긴 모델)와 무관하게 실행 문장이 mysql 클라이언트에서
// 정확히 한 문장(루틴은 DELIMITER 래핑 그대로)으로 읽히는지 본다. 아니면 생성 단계에서 수동 확인(주석)으로 돌린다
import type { StatementBody } from './ddl-alter';
import { LexError, tokenize, type LexMode, type Token } from './lexer';
import { splitStatements } from './parse-dump';

export const UNSAFE_STATEMENT_REASON = '생성 문장이 한 문장이 아님(입력 값 확인 필요)';

// 실행 문장 안에서 허용하는 주석: 닫힌 블록 주석과 버전 주석 표식(/*!NNNNN 과 그 끝 */). 줄 주석(-- , #)은 뒤에 붙는 ';' 나
// 다음 줄을 가릴 수 있어 허용하지 않는다
const BLOCK_COMMENT = /\/\*(?!!)[\s\S]*?\*\//g;
const VERSIONED_MARK = /\/\*!\d*|\*\//g;
// 토큰 밖의 제어 문자(탭·개행·CR·VT·FF 제외): 서버와 mysql 클라이언트가 '--' 주석의 끝을 다르게 본다 (lexer isDashComment)
const GAP_CONTROL = /[\x00-\x08\x0e-\x1f\x7f]/;

const lex = (src: string, mode: LexMode = {}): Token[] | undefined => {
  try {
    return tokenize(src, mode);
  } catch (e) {
    if (e instanceof LexError) return undefined;
    throw e;
  }
};

// 토큰 사이 글자가 공백·블록 주석·버전 주석 표식뿐이고 (allowComments 면 줄 주석도 허용), 백슬래시 명령('\\g' 등)·줄 맨 앞 DELIMITER 가 없다
function isPlain(src: string, toks: Token[], allowComments: boolean): boolean {
  let pos = 0;
  for (const t of [...toks, { t: 'op', v: '', s: src.length, e: src.length } as Token]) {
    const gap = src.slice(pos, t.s);
    if (!allowComments && gap.replace(BLOCK_COMMENT, '').replace(VERSIONED_MARK, '').trim() !== '') return false;
    if (GAP_CONTROL.test(gap)) return false;
    if (t.t === 'op' && t.v === '\\') return false;
    if (t.t === 'word' && /^DELIMITER$/i.test(t.v) && src.slice(src.lastIndexOf('\n', t.s - 1) + 1, t.s).trim() === '') return false;
    pos = t.e;
  }
  return true;
}

// 일반 문장: sql 뒤에 붙일 ';' 가 유일한 ';' 이고 마지막 토큰이어야 한다 (주석이 가리면 안 된다)
function isSinglePlain(sql: string): boolean {
  const text = `${sql};`;
  const toks = lex(text);
  if (!toks || !isPlain(text, toks, false)) return false;
  const semis = toks.filter((t) => t.t === 'op' && t.v === ';');
  return semis.length === 1 && semis[0].s === sql.length && toks.at(-1) === semis[0];
}

const ROUTINE_OPEN = 'DELIMITER ;;\n';
const ROUTINE_CLOSE = ';;\nDELIMITER ;';

// 루틴: [SET SQL_MODE] DELIMITER ;; / CREATE …;; / DELIMITER ; [SET 복원]. mysql 클라이언트처럼 DELIMITER·SQL_MODE 를 따라 나눴을 때
// CREATE 가 정확히 래핑한 본문 하나로 읽히고, 앞뒤 SET 말고 다른 문장이 없어야 한다. 루틴 본문 안의 주석은 허용한다
function isSingleRoutine(sql: string): boolean {
  const open = sql.indexOf(ROUTINE_OPEN);
  const close = sql.lastIndexOf(ROUTINE_CLOSE);
  if (open < 0 || close < open) return false;
  const head = sql.slice(0, open).trim();
  const tail = sql.slice(close + ROUTINE_CLOSE.length).trim();
  const body = sql.slice(open + ROUTINE_OPEN.length, close).trim();
  const parts = splitStatements(sql);
  const expected = [head, body, tail].filter((p) => p !== '').map((p) => p.replace(/;$/, ''));
  if (parts.length !== expected.length || parts.some((p, i) => p.ddl !== expected[i])) return false;
  const sets = [head, tail].filter((p) => p !== '');
  if (!sets.every((s) => /^SET /.test(s) && isSinglePlain(s.replace(/;$/, '')))) return false;
  const mode = { noBackslashEscapes: /(^|,)NO_BACKSLASH_ESCAPES(,|$)/i.test(/SQL_MODE = '([^']*)'/.exec(head)?.[1] ?? '') };
  const toks = lex(body, mode);
  return toks !== undefined && isPlain(body, toks, true);
}

export function isSingleStatement(st: StatementBody): boolean {
  if (st.comment) return true;
  return st.delimited ? isSingleRoutine(st.sql) : isSinglePlain(st.sql);
}
