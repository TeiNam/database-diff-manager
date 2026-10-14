// 모르는 세션 값에 기대는 문장 (리뷰 10회차 Claude 참고 5). 값을 모르는 변수에서 정한 세션 SQL_MODE·FOREIGN_KEY_CHECKS·time_zone 은 그 SET 에서 거부하지 않고 모르는 값으로
// 둔다 (session.ts) — mysqldump·Workbench 꼬리의 복원처럼 뒤에 그 값에 기대는 문장이 없으면 모델이 틀어지지 않는다. 여기서는 그 값에 기대는 뒤 문장을 거부한다.
// 안내에는 그 값을 모르게 만든 앞 문장을 밝힌다 (state.ts 의 sqlModeUnknown·fkChecksUnknown). time_zone 에 기대는 TIMESTAMP 리터럴 기본값은 session.ts assertUtcTimestampDefault 가 본다
import type { Token } from '../lexer';
import type { State } from './state';
import { fail, RE_EXPORT } from './types';

// 루틴이 기억할 세션 SQL_MODE (루틴은 만들 때의 SQL_MODE 를 기억한다 — 리뷰 7회차 R7-2). 모르면 거부한다. routine: 안내에 쓰는 루틴 ('PROCEDURE `p`')
export function routineSqlMode(st: State, routine: string): string {
  if (st.sqlModeUnknown !== undefined) fail(`${routine} 은(는) 만들 때의 세션 SQL_MODE 를 기억하는데 그 값을 알 수 없습니다 — ${st.sqlModeUnknown} — ${RE_EXPORT}`);
  return st.sqlMode;
}

const isDoubleQuoted = (t: Token, statement: string): boolean => t.t === 'string' && statement[t.s] === '"';

// 세션 SQL_MODE 를 모르면 MySQL 이 모드에 따라 다르게 읽는 글이 든 문장(무시하는 문장도)을 받지 않는다: 백슬래시(NO_BACKSLASH_ESCAPES — 문자열의 값과 끝이 달라져 문장 나누기도
// 어긋날 수 있다. 아는 모드가 문장 나누기와 다를 때와 같은 규칙이다 — index.ts assertSameBackslashMode), 큰따옴표로 감싼 글(ANSI_QUOTES — 문자열인지 식별자인지가 달라진다.
// 식별자면 "f"(…) 는 저장 함수 호출이다). 작은따옴표 문자열·주석 속 큰따옴표는 두 모드에서 같게 읽힌다. statement: 문장 원문, toks: 그 토큰
export function assertModeIndependentText(st: State, statement: string, toks: readonly Token[]): void {
  const reason = st.sqlModeUnknown;
  if (reason === undefined) return;
  if (statement.includes('\\')) fail(`세션 SQL_MODE 를 알 수 없어 NO_BACKSLASH_ESCAPES 가 켜졌는지 모르므로 백슬래시가 든 이 문장을 MySQL 과 같게 읽을 수 없습니다 — ${reason} — ${RE_EXPORT}`);
  if (toks.some((t) => isDoubleQuoted(t, statement))) {
    fail(`세션 SQL_MODE 를 알 수 없어 ANSI_QUOTES 가 켜졌는지 모르므로 큰따옴표(")로 감싼 글을 문자열로 읽을지 식별자로 읽을지 정할 수 없습니다 — ${reason} — ${RE_EXPORT}`);
  }
}

// DDL 의 REAL 타입은 REAL_AS_FLOAT 면 FLOAT, 아니면 DOUBLE 이다 — 세션 SQL_MODE 를 모르면 받지 않는다. REAL 은 예약어라 따옴표 없는 단어 REAL 은 타입이다 (식이 든 정의는 1차 범위 밖)
export function assertKnownRealType(st: State, toks: readonly Token[]): void {
  const reason = st.sqlModeUnknown;
  if (reason === undefined || !toks.some((t) => t.t === 'word' && t.v.toUpperCase() === 'REAL')) return;
  fail(`세션 SQL_MODE 를 알 수 없어 REAL_AS_FLOAT 가 켜졌는지 모르므로 REAL 타입을 FLOAT 로 읽을지 DOUBLE 로 읽을지 정할 수 없습니다 — ${reason} — ${RE_EXPORT}`);
}

// FK 검사(FOREIGN_KEY_CHECKS=1)를 해야 하는가 — 켜져 있거나 모른다 (모르면 검사에 걸리는 문장을 failFkCheck 가 거부한다)
export const checksForeignKeys = (st: State): boolean => st.fkChecks || st.fkChecksUnknown !== undefined;

// FK 검사에 걸리는 문장 (부모 없는 FK 1824, 다른 테이블이 참조하는 테이블 삭제 3730): 검사가 켜져 있으면 refusal(MySQL 오류 번호를 단 안내)로 거부하고, 꺼져 있으면 받는다. 모르면
// 켜져 있었는지 알 수 없어 MySQL 오류 번호 대신 RE_EXPORT 로 거부한다. topic: 걸린 문장을 가리키는 주어 ('참조하는 테이블 `x` 이 없는 FK 는')
export function failFkCheck(st: State, topic: string, refusal: string): void {
  if (st.fkChecksUnknown !== undefined) {
    fail(`${topic} FOREIGN_KEY_CHECKS 가 켜져 있으면 MySQL 이 거부하고 꺼져 있으면 받는데, 세션 FOREIGN_KEY_CHECKS 를 알 수 없습니다 — ${st.fkChecksUnknown} — ${RE_EXPORT}`);
  }
  if (st.fkChecks) fail(refusal);
}
