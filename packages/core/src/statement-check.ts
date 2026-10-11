// 최종 단일 문장 검사 (주입 심층 방어, 스펙 4.6): 출처(MD·SQL 덤프·앱이 넘긴 모델)와 무관하게 실행 문장이 mysql 클라이언트에서
// 정확히 한 문장(루틴은 DELIMITER 래핑 그대로)으로 읽히는지 본다. 아니면 생성 단계에서 수동 확인(주석)으로 돌린다
import type { StatementBody } from './ddl-alter';
import { scanGaps } from './comment-scan';
import { LexError, tokenize, type LexMode, type Token } from './lexer';
import { splitStatements } from './parse-dump';
import { routineHeader } from './parse-routine';
import { isSingleRoutineBody } from './routine-body';

// MySQL 8.0·8.4 가 받는 sql_mode 이름 (조합 이름 포함)
const SQL_MODE_NAMES = new Set(['ALLOW_INVALID_DATES', 'ANSI_QUOTES', 'ERROR_FOR_DIVISION_BY_ZERO', 'HIGH_NOT_PRECEDENCE', 'IGNORE_SPACE',
  'NO_AUTO_VALUE_ON_ZERO', 'NO_BACKSLASH_ESCAPES', 'NO_DIR_IN_CREATE', 'NO_ENGINE_SUBSTITUTION', 'NO_UNSIGNED_SUBTRACTION', 'NO_ZERO_DATE',
  'NO_ZERO_IN_DATE', 'ONLY_FULL_GROUP_BY', 'PAD_CHAR_TO_FULL_LENGTH', 'PIPES_AS_CONCAT', 'REAL_AS_FLOAT', 'STRICT_ALL_TABLES',
  'STRICT_TRANS_TABLES', 'TIME_TRUNCATE_FRACTIONAL', 'ANSI', 'TRADITIONAL']);

export const UNSAFE_STATEMENT_REASON = '생성 문장이 한 문장이 아님(입력 값 확인 필요)';
export const UNSAFE_IDENTIFIER_REASON = '이름에 실행 문장으로 내보내지 않는 글자(제어 문자·세미콜론·백슬래시·주석 표식)가 있음 — 이름을 확인한 뒤 직접 실행하세요';

// 보수적 이름 규칙 (심층 방어, 12회차): 백틱 안의 이름이라도 제어 문자(줄바꿈 포함 — 줄 맨 앞 delimiter 도 여기서 막힌다)·';'(래핑
// 구분자 ';;' 포함)·백슬래시·주석 표식이 있으면 실행 문장으로 내보내지 않는다. mysql 클라이언트가 인용 안에서도 해석하는 것
// ('\\G' 같은 백슬래시 명령)이 있어 경우를 나눠 판단하지 않고 한 규칙으로 닫는다
const UNSAFE_IDENTIFIER = /[\x00-\x1f\x7f;\\#]|\/\*|\*\/|--/;

// 토큰 밖의 제어 문자(탭·개행·CR·VT·FF 제외): 서버와 mysql 클라이언트가 '--' 주석의 끝을 다르게 본다 (lexer isDashComment)
const GAP_CONTROL = /[\x00-\x08\x0e-\x1f\x7f]/;

// 실행 문장을 읽는 모드 조합: 대상 세션의 NO_BACKSLASH_ESCAPES 유무(서버 sql_mode 를 모른다)와 버전 주석을 실행하는 서버·
// 건너뛰는 서버(/*!NNNNN 이 서버 버전보다 높으면 주석). 실행 문장은 모든 조합에서 한 문장이어야 한다 (12회차)
const MODES: readonly LexMode[] = [false, true].flatMap((noBackslashEscapes) =>
  [false, true].map((discardVersioned) => ({ noBackslashEscapes, discardVersioned })));
const modesOf = (noBackslashEscapes: boolean | undefined): readonly LexMode[] =>
  (noBackslashEscapes === undefined ? MODES : MODES.filter((m) => m.noBackslashEscapes === noBackslashEscapes));

const lex = (src: string, mode: LexMode): Token[] | undefined => {
  try {
    return tokenize(src, mode);
  } catch (e) {
    if (e instanceof LexError) return undefined;
    throw e;
  }
};

// 토큰 사이 글자가 공백·평평한 주석뿐이고(allowComments 가 아니면 줄 주석(-- , #)은 안 된다 — 뒤에 붙는 ';' 나 다음 줄을
// 가릴 수 있다), 백슬래시 명령('\\g' 등)·줄 맨 앞 DELIMITER 가 없다. 주석 규칙은 comment-scan
function isPlain(src: string, toks: Token[], allowComments: boolean, mode: LexMode): boolean {
  const gaps = scanGaps(src, toks, mode);
  if (!gaps.safe || gaps.other || (!allowComments && gaps.lineComment)) return false;
  let pos = 0;
  for (const t of [...toks, { t: 'op', v: '', s: src.length, e: src.length } as Token]) {
    if (GAP_CONTROL.test(src.slice(pos, t.s))) return false;
    if (t.t === 'op' && t.v === '\\') return false;
    if (t.t === 'word' && /^DELIMITER$/i.test(t.v) && src.slice(src.lastIndexOf('\n', t.s - 1) + 1, t.s).trim() === '') return false;
    pos = t.e;
  }
  return true;
}

// 일반 문장: 모든 모드에서 sql 뒤에 붙일 ';' 가 유일한 ';' 이고 마지막 토큰이어야 한다 (주석이 가리면 안 된다)
function isSinglePlain(sql: string): boolean {
  const text = `${sql};`;
  return MODES.every((mode) => {
    const toks = lex(text, mode);
    if (!toks || !isPlain(text, toks, false, mode)) return false;
    const semis = toks.filter((t) => t.t === 'op' && t.v === ';');
    return semis.length === 1 && semis[0].s === sql.length && toks.at(-1) === semis[0];
  });
}

const ROUTINE_OPEN = 'DELIMITER ;;\n';
const ROUTINE_CLOSE = ';;\nDELIMITER ;';

// 루틴: [SET SQL_MODE] DELIMITER ;; / CREATE …;; / DELIMITER ; [SET 복원]. mysql 클라이언트처럼 DELIMITER·SQL_MODE 를 따라 나눴을 때
// CREATE 가 정확히 래핑한 본문 하나로 읽히고, 앞뒤 SET 말고 다른 문장이 없어야 한다. 본문은 서버 기준으로도 문장 하나여야 한다
// (routine-body — `END; DROP …` 금지). 본문 안의 주석은 허용한다
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
  return modesOf(routineSessionMode(head)).every((mode) => isSingleRoutineCreate(body, mode));
}

// 본문을 읽는 NO_BACKSLASH_ESCAPES: 머리 SET 의 SQL_MODE 가 서버가 받는 이름뿐일 때만 그 모드다. SET 이 없거나, 모르는 이름이 섞여
// SET 이 실패할 수 있으면(--force 로 이어 실행하면 세션 모드로 읽는다) 두 모드 모두로 본다
function routineSessionMode(head: string): boolean | undefined {
  const value = /SQL_MODE = '([^'\\]*)';$/.exec(head)?.[1];
  if (value === undefined) return undefined;
  const names = value.split(',').filter((n) => n !== '');
  if (!names.every((n) => SQL_MODE_NAMES.has(n.toUpperCase()))) return undefined;
  return names.some((n) => n.toUpperCase() === 'NO_BACKSLASH_ESCAPES');
}

function isSingleRoutineCreate(body: string, mode: LexMode): boolean {
  const toks = lex(body, mode);
  if (!toks || !isPlain(body, toks, true, mode)) return false;
  let start: number;
  try {
    start = routineHeader(body, mode).bodyStart;
  } catch {
    return false;
  }
  const rest = toks.filter((t) => t.s >= start);
  // 래핑 구분자 ';;' 가 본문 토큰으로 나오면 클라이언트가 거기서 끊는다
  if (rest.some((t, i) => t.t === 'op' && t.v === ';' && rest[i + 1]?.t === 'op' && rest[i + 1].v === ';' && rest[i + 1].s === t.e)) return false;
  return isSingleRoutineBody(rest);
}

// 문장 안의 모든 인용 식별자가 보수적 이름 규칙을 지키는가. 모드마다 읽어(문자열 경계가 모드마다 다르다) 읽히는 모든 모드에서 본다
export function hasSafeIdentifiers(st: StatementBody): boolean {
  if (st.comment) return true;
  return MODES.every((mode) => (lex(st.sql, mode) ?? []).every((t) => t.t !== 'ident' || !UNSAFE_IDENTIFIER.test(t.v)));
}

export function isSingleStatement(st: StatementBody): boolean {
  if (st.comment) return true;
  return st.delimited ? isSingleRoutine(st.sql) : isSinglePlain(st.sql);
}
