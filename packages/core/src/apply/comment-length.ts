// 한도를 넘는 COMMENT (리뷰 11회차 Claude F1, 8.0.46·8.4.11 실측). MySQL 은 컬럼·인덱스(PRIMARY KEY 포함) COMMENT 를 1024자, 테이블 COMMENT 를 2048자까지 받는다 — 글자
// 수다 (한글 1024자도 받는다, include/mysql_com.h). 엄격 SQL_MODE(STRICT_TRANS_TABLES·STRICT_ALL_TABLES) 세션은 넘으면 1629·1688·1628 로 거부하고, 엄격하지 않은 세션은
// 경고만 남기고 한도까지 잘라 저장한다 (CREATE·ALTER TABLE, CREATE INDEX 모두 — sql_table.cc validate_comment_length). 3회차의 바이트 한도처럼 잘린 값은 재현하지 않고
// 거부한다: 엄격한 세션이면 MySQL 오류 번호로, 엄격하지 않거나 세션 SQL_MODE 를 모르면 RE_EXPORT 로. 정의 파서는 세션을 모르므로 LongComment 를 던지고, 문장을 적용하는
// 쪽(index.ts)이 세션 SQL_MODE 에 맞는 안내로 바꾼다
import type { State } from './state';
import { ApplyFailure, RE_EXPORT } from './types';

export type CommentOf = 'column' | 'index' | 'table';

interface Limit {
  readonly chars: number;
  readonly errno: number;
}

const LIMITS: Readonly<Record<CommentOf, Limit>> = {
  column: { chars: 1024, errno: 1629 }, // ER_TOO_LONG_FIELD_COMMENT
  index: { chars: 1024, errno: 1688 }, // ER_TOO_LONG_INDEX_COMMENT
  table: { chars: 2048, errno: 1628 }, // ER_TOO_LONG_TABLE_COMMENT
};
const STRICT = /(^|,)STRICT_(TRANS|ALL)_TABLES(,|$)/;

// 정의 파서가 던지는 긴 COMMENT. 메시지는 세션을 모를 때의 안내다 — applyStatement 가 longCommentReason 으로 바꾼다
export class LongComment extends ApplyFailure {
  constructor(readonly of: CommentOf, readonly subject: string) {
    super(`${subject} 가 ${LIMITS[of].chars}자를 넘습니다 — ${RE_EXPORT}`);
  }
}

// 이름 있는 대상의 안내 주어 ('컬럼 `c` 의 COMMENT', 이름 없는 인덱스는 '인덱스의 COMMENT', 테이블은 '테이블 COMMENT')
function subjectOf(of: CommentOf, name: string): string {
  if (of === 'table') return '테이블 COMMENT';
  const what = of === 'column' ? '컬럼' : '인덱스';
  return name === '' ? `${what}의 COMMENT` : `${what} \`${name}\` 의 COMMENT`;
}

// COMMENT 가 한도 안인가 (글자 수 — 4바이트 글자는 이미 거부했지만 코드 포인트로 센다). 넘으면 LongComment. name: 컬럼·인덱스 이름 (모르면 '')
export function assertCommentLength(of: CommentOf, name: string, text: string): void {
  const { chars } = LIMITS[of];
  if (text.length > chars && [...text].length > chars) throw new LongComment(of, subjectOf(of, name));
}

// 긴 COMMENT 의 안내: 엄격한 세션이면 MySQL 오류 번호, 엄격하지 않으면 MySQL 이 잘라 저장한다고 밝히고, 세션 SQL_MODE 를 모르면 그 까닭을 밝힌다
export function longCommentReason(st: State, e: LongComment): string {
  const { chars, errno } = LIMITS[e.of];
  const over = `${e.subject} 가 ${chars}자를 넘습니다`;
  if (st.sqlModeUnknown !== undefined) {
    return `${over} — MySQL 은 엄격한 SQL_MODE 면 ${errno} 로 거부하고 아니면 ${chars}자로 잘라 저장하는데, 세션 SQL_MODE 를 알 수 없습니다 — ${st.sqlModeUnknown} — ${RE_EXPORT}`;
  }
  if (STRICT.test(st.sqlMode)) return `${over} (MySQL ${errno})`;
  return `${over} — 엄격하지 않은 SQL_MODE 세션에서 MySQL 은 경고만 남기고 ${chars}자로 잘라 저장하는데, 잘린 값은 재현하지 않습니다 — ${RE_EXPORT}`;
}
