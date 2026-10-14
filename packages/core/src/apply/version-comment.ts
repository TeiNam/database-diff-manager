// 실행 주석의 버전 번호 (리뷰 11회차 R11-2·Claude F3, 8.0.46·8.4.11 실측). MySQL 은 '/*!' 뒤의 다섯 자리 번호가 서버 버전 이하일 때만 안의 글을 실행하고, 높으면
// 표지부터 첫 '*/' 까지를 주석으로 건너뛴다 (sql_lex.cc — 서버는 그 안의 따옴표를 보지 않는다. 8.0.46 은 80046 까지, 8.4.11 은 80411 까지 실행한다). 이 도구는 8.0/8.4 를
// 함께 따르므로 번호에 따라 셋으로 가른다:
// - 번호가 없거나 80046 이하: 실행한다 (mysqldump 머리·꼬리의 /*!40101 …*/, 덤프의 /*!80023 INVISIBLE */)
// - 80047~80499: 서버의 판에 따라 실행 여부가 갈려 거부한다 (8.0.46 은 건너뛰고 8.4.11 은 80411 까지 실행한다)
// - 80500 이상: 8.0·8.4 의 어느 판도 실행하지 않는 주석이다. 문장을 통째로 감쌌으면 주석뿐인 문장이라 MySQL 도 오류 없이 지나간다
// 번호가 다섯 자리가 아니면 거부한다: 다섯 자리보다 짧은 숫자는 MySQL 이 실행할 글로 읽고(/*!1 …), 여섯 자리는 8.0 이 앞 다섯 자리만 번호로 읽는데 8.4 는 뒤에 공백이
// 오면 여섯 자리를 번호로 읽는다(/*!100000 … 은 8.0 1064, 8.4 는 건너뛴다). 렉서는 '/*!' 뒤의 숫자를 모두 표지로 떼고 내용은 번호와 상관없이 토큰으로 읽는다 —
// 덤프 파서와 함께 쓰므로 그대로 두고, 문장 나누기가 알려 준 표지(ApplyStatement.marks)로 이 문장에서 MySQL 이 실행하는 글을 만든다
import type { ApplyStatement, LexNotes, VersionMark } from '../parse-dump';
import { isCreateRoutine } from './object-stmt';
import { fail, RE_EXPORT } from './types';

const VERSION_DIGITS = 5;
const LAST_RUN_BY_BOTH = 80046; // 8.0.46 이 실행하는 가장 높은 번호 (8.4 는 더 높은 번호도 실행한다)
const FIRST_SKIPPED_BY_BOTH = 80500; // 8.0·8.4 의 어느 판도 실행하지 않는 가장 낮은 번호

// 건너뛰는 실행 주석이 차지하는 원문 자리 [start, end)
export interface Region {
  readonly start: number;
  readonly end: number;
}

// 이 문장의 덩어리에서 MySQL 이 건너뛰는 실행 주석의 자리. 실행 여부가 버전에 따라 갈리면 거부한다. script: 문장을 나눈 원문
export const skippedComments = (script: string, s: ApplyStatement): Region[] => s.marks.filter((m) => !runs(m)).map((m) => skippedRegion(script, s, m));

// MySQL 이 이 문장에서 실행하는 글: 건너뛰는 실행 주석(skipped)을 공백으로 지운 ddl (없으면 ddl 그대로, 주석뿐이면 ''). 루틴 정의 안의 것은 지우지 않는다 —
// createRoutine 이 루틴 정의 안의 실행 주석을 받지 않는다 (MySQL 은 본문에서 그 글을 지워 저장한다)
export function executedText(s: ApplyStatement, skipped: readonly Region[]): string {
  if (!skipped.length) return s.ddl;
  const lead = blank(s, skipped.filter((r) => r.start < s.offset)).trimStart(); // 문장이 그 안에서 시작한 주석 (ddl 앞에서 열었다)
  return isCreateRoutine(lead) ? lead : blank(s, skipped).trim();
}

// 표지의 번호를 8.0·8.4 가 모두 실행하는가 (모두 건너뛰면 false). 판에 따라 갈리거나 번호를 다르게 읽으면 거부한다
function runs(m: VersionMark): boolean {
  if (m.digits === '') return true;
  const marker = `/*!${m.digits}`;
  if (m.digits.length !== VERSION_DIGITS) {
    fail(`실행 주석 ${marker} 의 버전 번호가 다섯 자리가 아닙니다 — MySQL 은 다섯 자리보다 짧은 숫자를 실행할 글로 읽고, 여섯 자리는 8.0 과 8.4 가 다르게 읽습니다 — ${RE_EXPORT}`);
  }
  const version = Number(m.digits);
  if (version <= LAST_RUN_BY_BOTH) return true;
  if (version >= FIRST_SKIPPED_BY_BOTH) return false;
  return fail(`실행 주석 ${marker} 는 서버 버전에 따라 실행 여부가 갈립니다 — MySQL 은 서버 버전이 그 번호 이상일 때만 안의 글을 실행하는데 8.0.46 은 건너뛰고 `
    + `8.4 는 판에 따라 실행합니다 (8.4.11 은 80411 까지) — ${RE_EXPORT}`);
}

// 8.0·8.4 가 모두 건너뛰는 표지인가 (다섯 자리 80500 이상) — 거부하지 않고 가른다
const skippedByBoth = (m: VersionMark): boolean => m.digits.length === VERSION_DIGITS && Number(m.digits) >= FIRST_SKIPPED_BY_BOTH;

// 표지 뒤 내용이 시작하는 원문 자리 ('/*!' 와 번호 다음)
const contentStart = (m: VersionMark): number => m.at + '/*!'.length + m.digits.length;

// 건너뛰는 실행 주석의 자리: 표지부터 첫 '*/' 까지 (MySQL 은 그 안의 따옴표를 보지 않는다). 문장 안에서 닫히지 않으면 — 구분자가 주석 안에 있어 mysql 클라이언트가 주석
// 가운데서 문장을 끊었다 — MySQL 은 닫히지 않은 주석으로 1064 다. 그 안의 주석(MySQL 은 한 겹을 받는다)은 렉서와 끝을 다르게 읽을 수 있고, 줄 주석은 mysql 클라이언트가
// 떼고 보내는지에 따라 건너뛰는 글이 갈려 받지 않는다 (lineCommentReason)
function skippedRegion(script: string, s: ApplyStatement, m: VersionMark): Region {
  const content = contentStart(m);
  const close = script.indexOf('*/', content);
  const end = close + 2;
  if (close < 0 || end > s.offset + s.ddl.length) fail(`건너뛰는 실행 주석 /*!${m.digits} 가 문장 안에서 닫히지 않았습니다 (MySQL 1064)`);
  const skipped = script.slice(content, close);
  if (skipped.includes('/*')) fail(`건너뛰는 실행 주석 /*!${m.digits} 안의 주석은 받지 않습니다 — ${RE_EXPORT}`);
  if (LINE_COMMENT.test(skipped)) fail(lineCommentReason(m));
  return { start: m.at, end };
}

// 줄 주석의 시작: '#', 또는 공백·제어 문자가 뒤따르는 '--' (렉서·mysql 클라이언트와 같다). 건너뛰는 주석 안에서는 따옴표 안의 것도 함께 본다 (보수적)
const LINE_COMMENT = /#|--[\x00-\x20\x7f]/;

// 건너뛰는 실행 주석 안의 줄 주석 (리뷰 12회차 R12-3·Claude F3, 8.0.46·8.4.11 에서 mysql 클라이언트로 실측): 서버는 첫 '*/' 까지 건너뛰지만 mysql 클라이언트는 '/*!' 안에서도
// 줄 주석을 줄 끝까지 떼고 보내거나(8.0 기본) 그대로 보내(8.4 기본·--comments), 같은 스크립트가 판에 따라 1064 이거나 다른 DDL 을 실행한다. 렉서는 줄 주석으로 읽어 닫는
// '*/' 와 뒤 DDL 을 삼킬 수 있다
export const lineCommentReason = (m: VersionMark): string => `건너뛰는 실행 주석 /*!${m.digits} 안의 줄 주석('#'·'-- ')은 받지 않습니다 — mysql 클라이언트가 판과 설정(--comments)에 `
  + `따라 줄 주석을 떼고 보내거나 그대로 보내 MySQL 이 건너뛰는 글이 달라집니다 (줄 주석이 닫는 '*/' 와 뒤 문장을 가릴 수 있습니다) — ${RE_EXPORT}`;

// 마지막 문장 뒤(trailing)에서 줄 주석이 든 건너뛰는 실행 주석 (없으면 undefined) — 렉서는 그 줄 주석에서 닫는 '*/' 와 뒤 DDL 을 삼켜 문장으로 내지 않았을 수 있다. 그 밖의
// 것은 MySQL 이 오류를 내도 앞 DDL 을 모두 적용한 뒤라 모델이 같아 받는다. 닫히지 않았으면 원문 끝까지 본다
export function lineCommentAfterLast(script: string, trailing: LexNotes): VersionMark | undefined {
  return trailing.marks.find((m) => {
    const content = contentStart(m);
    const close = script.indexOf('*/', content);
    return skippedByBoth(m) && LINE_COMMENT.test(script.slice(content, close < 0 ? script.length : close));
  });
}

// ddl 에서 regions(원문 자리 — 자리 순서이고 겹치지 않는다)에 든 글자를 공백으로 바꾼다. 줄바꿈은 남기고 길이는 그대로다 — 주석처럼 앞뒤 토큰을 가른다. 조각을 모아 한 번에
// 잇는다 (리뷰 12회차 Claude F2 — 주석마다 문장 전체를 다시 이으면 건너뛰는 주석 10만 개인 1,000,000자 문장 하나가 4 초였다)
function blank(s: ApplyStatement, regions: readonly Region[]): string {
  const pieces: string[] = [];
  let at = 0; // ddl 에서 아직 옮기지 않은 첫 자리
  for (const r of regions) {
    const from = Math.max(r.start - s.offset, at);
    const to = Math.min(r.end - s.offset, s.ddl.length);
    if (to <= from) continue;
    pieces.push(s.ddl.slice(at, from), s.ddl.slice(from, to).replace(/[^\n]/g, ' '));
    at = to;
  }
  pieces.push(s.ddl.slice(at));
  return pieces.join('');
}
