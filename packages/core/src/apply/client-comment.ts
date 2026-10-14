// mysql 클라이언트가 주석·힌트 안을 렉서·서버와 다르게 읽는 꼴 (리뷰 15회차 F4·후속, 8.0.46·8.4.11 에서 mysql 클라이언트로 실측). 렉서와 서버는 힌트를 첫 '*/' 까지의 주석으로,
// 건너뛰는 실행 주석은 지울 글로 읽는데, 클라이언트는 줄마다 상태를 새로 시작하고(add_line 의 ss_comment) 따옴표·일반 주석 밖의 '\' 는 어디서나 클라이언트 명령으로 읽는다:
// - 여러 줄 힌트: '/*+' 를 연 줄에서만 그 안을 힌트로 보고 다음 줄부터는 힌트 밖의 글로 읽는다 — 지금 구분자에서 문장을 끊고, 따옴표에서 문자열을 열고, '#'·'-- ' 를 줄 주석으로
//   (8.0 은 지우고 8.4 는 남긴다), '/*' 를 주석으로(8.0 은 지운다) 읽는다 ('/*+ 메모' 줄바꿈 'VIP 등급입니다; 삭제 금지 */' 는 두 클라이언트 모두 1064 다). 따옴표는 서버가 다중
//   문장으로 같게 실행하는 때도 있지만 뒤의 DELIMITER 줄까지 문자열로 묶을 수 있어 함께 거부한다 (보수적)
// - '\': '\g'·'\G' 는 거기서 문장을 끊어 보내고(1064), '\c' 는 버퍼를 비우고, '\.' 은 파일을 읽어 그 안의 DDL 을 실행하고, 모르는 명령('\j'·'\\')은 오류로 멈춘다. '\N' 만 그대로 둔다
// 14회차까지는 모두 받았다. 마지막 문장 뒤의 것은 앞 DDL 을 모두 적용한 뒤라 '\' 만 본다 ('\.' 이 DDL 을 실행한다)
import { containsWithin } from '../delimiter-search';
import type { Token } from '../lexer';
import type { ApplyStatement, Hint } from '../parse-dump';
import { fail, RE_EXPORT } from './types';
import type { HiddenComment, Region } from './version-comment';

// 힌트 밖의 글로 읽는 줄에서 mysql 클라이언트가 달리 다루는 것 (구분자는 따로 본다): 따옴표, 줄 주석(렉서처럼 제어 문자가 뒤따르는 '--' 도 — 보수적), 주석, 클라이언트 명령
const CLIENT_SPECIAL = /['"`#\\]|--[\x00-\x20\x7f]|\/\*/;
// 클라이언트 명령으로 읽는 '\' — '\N' 만 그대로 둔다
const CLIENT_COMMAND = /\\[^N]/;

// hints 를 클라이언트가 렉서와 다르게 읽으면 거부한다. where: 거부 안내의 앞말 (문장 안의 것은 없다). 힌트마다 그 안만 훑는다 — 힌트는 서로 겹치지 않아 원문 길이에 비례한다
export function assertHintsReadAsLexed(script: string, hints: readonly Hint[], where: (at: number) => string): void {
  for (const h of hints) {
    const end = hintEnd(script, h);
    const reason = multilineReason(script, h, end) ?? commandReason(script, h.at, end);
    if (reason) fail(`${where(h.at)}${reason}`);
  }
}

// 마지막 문장 뒤의 힌트 가운데 클라이언트 명령('\')이 든 첫 것 (없으면 undefined)
export function hintCommandAfterLast(script: string, hints: readonly Hint[]): HiddenComment | undefined {
  for (const h of hints) {
    const reason = commandReason(script, h.at, hintEnd(script, h));
    if (reason) return { at: h.at, reason };
  }
  return undefined;
}

// 힌트를 닫는 '*/' 의 자리 (닫지 않았으면 원문 끝 — 렉서가 먼저 거부한다)
const hintEnd = (script: string, h: Hint): number => {
  const close = script.indexOf('*/', h.at + 2);
  return close < 0 ? script.length : close;
};

// 줄을 넘는 힌트의 둘째 줄부터(닫는 '*/' 앞까지) 클라이언트가 달리 다루는 글이 있으면 그 까닭
function multilineReason(script: string, h: Hint, end: number): string | undefined {
  const lineBreak = script.slice(h.at, end).indexOf('\n');
  if (lineBreak < 0) return undefined;
  const rest = h.at + lineBreak + 1;
  return CLIENT_SPECIAL.test(script.slice(rest, end)) || containsWithin(script, h.delimiter, rest, end) ? MULTILINE_REASON : undefined;
}

// 힌트 안(닫는 '*/' 의 '*' 까지)의 클라이언트 명령
const commandReason = (script: string, at: number, end: number): string | undefined => (CLIENT_COMMAND.test(script.slice(at + 3, end + 1)) ? HINT_COMMAND_REASON : undefined);

// 건너뛰는 실행 주석(skipped) 안의 '\' 토큰 (written — ddl 을 나눈 토큰, 따옴표 안의 것은 문자열이다): 클라이언트는 그 '\' 를 명령으로 읽는다. 두 배열은 자리 순서라 한 번에 훑는다.
// 실행하는 글의 '\' 는 assertOneStatement 가 거부한다
export function assertNoCommandInSkipped(script: string, s: ApplyStatement, written: readonly Token[], skipped: readonly Region[]): void {
  let k = 0;
  for (const t of written) {
    if (!isOp(t, '\\')) continue;
    const at = s.offset + t.s;
    while (k < skipped.length && skipped[k].end <= at) k++;
    if (k === skipped.length) return;
    if (at < skipped[k].start || script[at + 1] === 'N') continue;
    const digits = /^\d*/.exec(script.slice(skipped[k].start + 3, skipped[k].start + 3 + MAX_DIGITS))![0];
    fail(`건너뛰는 실행 주석 /*!${digits} 안의 '\\' 는 받지 않습니다 — ${CLIENT_COMMAND_TEXT} — ${RE_EXPORT}`);
  }
}

const isOp = (t: Token, v: string): boolean => t.t === 'op' && t.v === v;
const MAX_DIGITS = 32; // 안내에 보이는 실행 주석 번호의 최대 길이
const CLIENT_COMMAND_TEXT = "mysql 클라이언트는 따옴표·일반 주석 밖의 '\\' 를 클라이언트 명령으로 읽어, '\\g'·'\\G' 는 거기서 문장을 끊어 보내고 '\\c' 는 버퍼를 비우며 '\\.' 은 "
  + "파일을 읽어 실행하고 모르는 명령은 오류로 멈춥니다 ('\\N' 만 그대로 둡니다)";
const HINT_COMMAND_REASON = `힌트 /*+ 안의 '\\' 는 받지 않습니다 — ${CLIENT_COMMAND_TEXT} — ${RE_EXPORT}`;
const MULTILINE_REASON = "여러 줄에 걸친 힌트 /*+ 의 둘째 줄부터 구분자·따옴표·주석('#'·'-- '·'/*')·'\\' 가 있습니다 — mysql 클라이언트는 '/*+' 를 연 줄에서만 그 안을 힌트로 보고 "
  + '다음 줄부터는 힌트 밖의 글로 읽어, 그 자리에서 문장을 끊거나 문자열·주석을 열거나 클라이언트 명령을 실행해 MySQL 이 1064 로 멈추거나 판에 따라 다른 글을 실행합니다 '
  + `(힌트는 한 줄에 쓰고, 메모라면 '/*+' 대신 '/*' 로 써 주세요) — ${RE_EXPORT}`;
