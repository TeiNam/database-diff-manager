// 여러 줄에 걸친 힌트 (리뷰 15회차 F4, 8.0.46·8.4.11 에서 mysql 클라이언트로 실측). mysql 클라이언트는 '/*+' 를 연 줄에서만 그 안을 힌트로 보고 — add_line 의 ss_comment 는 줄마다
// 새로 시작한다 — 다음 줄부터는 힌트 밖의 글로 읽는다: 지금 구분자에서 문장을 끊고, 따옴표에서 문자열을 열고, '#'·'-- ' 를 줄 주석으로(8.0 은 지우고 8.4 는 남긴다), '/*' 를
// 주석으로(8.0 은 지운다), '\' 를 클라이언트 명령('\g'·'\c' …)으로 읽는다. 서버와 렉서는 첫 '*/' 까지를 한 주석으로 읽어, 둘째 줄부터 닫는 '*/' 앞에 그것이 있으면 MySQL 은
// 1064 로 멈추거나 판에 따라 다른 글을 실행한다 ('/*+ 메모' 줄바꿈 'VIP 등급입니다; 삭제 금지 */' 는 두 클라이언트 모두 1064 다 — 14회차까지는 뒤 DDL 까지 적용했다). 따옴표는
// 서버가 다중 문장으로 같게 실행하는 때도 있지만 뒤의 DELIMITER 줄까지 문자열로 묶을 수 있어 함께 거부한다 (보수적). 마지막 문장 뒤의 것은 앞 DDL 을 모두 적용한 뒤라 보지 않는다
import { containsWithin } from '../delimiter-search';
import type { Hint } from '../parse-dump';
import { fail, RE_EXPORT } from './types';

// 힌트 밖의 글로 읽는 줄에서 mysql 클라이언트가 달리 다루는 것 (구분자는 따로 본다): 따옴표, 줄 주석(렉서처럼 제어 문자가 뒤따르는 '--' 도 — 보수적), 주석, 클라이언트 명령
const CLIENT_SPECIAL = /['"`#\\]|--[\x00-\x20\x7f]|\/\*/;

// hints 가운데 줄을 넘는 것의 둘째 줄부터(닫는 '*/' 앞까지)에 클라이언트가 달리 다루는 글이 있으면 거부한다. where: 거부 안내의 앞말 (문장 안의 것은 없다). 힌트마다 그 안만
// 훑는다 — 힌트는 서로 겹치지 않아 원문 길이에 비례한다
export function assertSingleLineHints(script: string, hints: readonly Hint[], where: (at: number) => string): void {
  for (const h of hints) {
    const close = script.indexOf('*/', h.at + 2);
    const end = close < 0 ? script.length : close;
    const lineBreak = script.slice(h.at, end).indexOf('\n');
    if (lineBreak < 0) continue;
    const rest = h.at + lineBreak + 1;
    if (CLIENT_SPECIAL.test(script.slice(rest, end)) || containsWithin(script, h.delimiter, rest, end)) fail(`${where(h.at)}${HINT_REASON}`);
  }
}

const HINT_REASON = "여러 줄에 걸친 힌트 /*+ 의 둘째 줄부터 구분자·따옴표·주석('#'·'-- '·'/*')·'\\' 가 있습니다 — mysql 클라이언트는 '/*+' 를 연 줄에서만 그 안을 힌트로 보고 "
  + '다음 줄부터는 힌트 밖의 글로 읽어, 그 자리에서 문장을 끊거나 문자열·주석을 열거나 클라이언트 명령을 실행해 MySQL 이 1064 로 멈추거나 판에 따라 다른 글을 실행합니다 '
  + `(힌트는 한 줄에 쓰고, 메모라면 '/*+' 대신 '/*' 로 써 주세요) — ${RE_EXPORT}`;
