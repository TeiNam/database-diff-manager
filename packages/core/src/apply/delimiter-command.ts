// DELIMITER 줄 앞의 mysql 클라이언트 버퍼 (리뷰 14회차·15회차 F1·F2, 8.0.46·8.4.11 에서 mysql 클라이언트로 실측). 클라이언트는 DELIMITER 줄을 버퍼가 빌 때만 명령으로 읽고,
// 아니면 그 줄을 문장의 글로 보내 MySQL 이 1064 로 멈춘다. 문장 나누기는 줄 맨 앞의 DELIMITER 를 늘 명령으로 읽으므로, 앞 경계(앞 구분자·DELIMITER 줄·스크립트 처음) 뒤에서
// 그 줄 앞까지 클라이언트가 버퍼에 남기는 것을 본다 — 그 사이에는 토큰이 없어 공백과 주석뿐이다:
// - 8.0 (--skip-comments 가 기본): 일반 블록 주석·줄 주석을 지우고 실행 주석('/*!')·힌트('/*+')는 버퍼에 남긴다
// - 8.4 (--comments 가 기본): 주석을 남기되, 버퍼가 공백과 블록 주석(실행 주석·힌트도)뿐이면 버리고 명령으로 읽는다. 다만 블록 주석 안에 '*'·'/' 가 있으면(첫 글자의 '/' 는
//   빼고) 건너뛰지 못하고, 버퍼가 비었을 때의 줄 주석만 따로 보내 공백·블록 주석 뒤의 줄 주석은 버퍼에 남는다 (앞 구분자와 같은 줄에서 그 뒤의 공백·줄 주석은 앞 문장과 함께 보낸다)
// 판에 따라 갈리거나 둘 다 읽지 않으면 RE_EXPORT 로 거부한다. 14회차는 그 앞의 마지막 문장 없는 덩어리의 실행 주석·힌트만 보아, DELIMITER 줄 뒤에 문장 없는 덩어리(';;')가 오면
// 놓쳤고(F1), 8.4 가 공백·블록 주석을 모두 버린다고 보아 날짜·작성자 주석('/* 2024/01/15 … */', 블록 주석 뒤의 '-- 작성자') 뒤의 DELIMITER 줄을 받았다 (F2 — 8.4 는 1064)
import type { CommandLine } from '../parse-dump';
import { fail, RE_EXPORT } from './types';
import { afterPrevious } from './version-comment';

// 클라이언트가 DELIMITER 줄을 명령으로 읽지 않게 하는 것: mark·hint 는 8.0 이 남기는 실행 주석·힌트, block 은 8.4 가 건너뛰지 못하는 블록 주석, line 은 8.4 가 남기는 줄 주석,
// other 는 그 밖의 글 (토큰이 없는 자리라 앞 검사가 먼저 거부한다 — 보수적)
type Kind = 'mark' | 'hint' | 'block' | 'line' | 'other';

interface Blocker {
  readonly at: number;
  readonly kind: Kind;
}

// 문장 앞의 DELIMITER 줄마다 두 클라이언트가 모두 명령으로 읽는지 본다. 마지막 문장 뒤의 것은 앞 DDL 을 모두 적용한 뒤라 보지 않는다
export function assertCommandsReadByBoth(script: string, commands: readonly CommandLine[]): void {
  for (const line of commands) {
    const found = firstBlocker(script, line);
    if (found) fail(blockedReason(script, found));
  }
}

// line 앞(from 부터)에서 어느 클라이언트든 그 줄을 명령으로 읽지 않게 하는 첫 것 (없으면 undefined). 원문을 한 번만 훑는다 — 줄마다 앞 경계 뒤부터 보므로 서로 겹치지 않는다
function firstBlocker(script: string, { from, at }: CommandLine): Blocker | undefined {
  let filled = false; // 8.4 클라이언트의 버퍼에 공백·블록 주석이 있다 — 그 뒤의 줄 주석도 버퍼에 남는다
  let trailing = from > 0; // 앞 구분자와 같은 줄: 8.4 클라이언트는 그 뒤의 공백·줄 주석을 앞 문장과 함께 보낸다
  for (let i = from; i < at; ) {
    const c = script[i];
    if (/\s/.test(c)) {
      if (c === '\n') trailing = false;
      else if (!trailing) filled = true;
      i++;
    } else if (script.startsWith('/*', i)) {
      const end = script.indexOf('*/', i + 2);
      const kind = blockKind(script, i, end);
      if (kind) return { at: i, kind };
      filled = true;
      trailing = false;
      i = end + '*/'.length;
    } else {
      if (!CLIENT_LINE_COMMENT.test(script.slice(i, i + 3))) return { at: i, kind: 'other' };
      if (filled) return { at: i, kind: 'line' };
      const end = script.indexOf('\n', i);
      i = end < 0 ? at : end;
    }
  }
  return undefined;
}

// mysql 클라이언트가 줄 주석으로 읽는 것: '#', 또는 공백이 뒤따르거나 줄이 끝나는 '--' (렉서는 제어 문자가 뒤따르는 '--' 도 줄 주석으로 읽는다 — 그것은 other 로 거부한다)
const CLIENT_LINE_COMMENT = /^(?:#|--(?:[\t-\r ]|$))/;

// i 자리에서 end(첫 '*/', 없으면 -1)까지의 블록 주석을 클라이언트가 버퍼에 남겨 DELIMITER 줄을 명령으로 읽지 않게 하는가 (아니면 undefined): 실행 주석·힌트는 8.0 이 남기고,
// 안에 '*'·'/' 가 든 것은 8.4 가 건너뛰지 못한다 — 첫 글자의 '/' 는 8.4 가 건너뛰지만 '/*/*/' 는 8.0 이 닫지 않아 함께 거부한다 (보수적)
function blockKind(script: string, i: number, end: number): Kind | undefined {
  if (script[i + 2] === '!') return 'mark';
  if (script[i + 2] === '+') return 'hint';
  if (end < 0) return 'other';
  return /[*/]/.test(script.slice(i + 2, end)) ? 'block' : undefined;
}

// 거부 안내: 그 줄을 밝히고, 판마다 무엇을 하는지와 고치는 법을 적는다
function blockedReason(script: string, { at, kind }: Blocker): string {
  const [name, why, fix] = REASONS[kind];
  const label = kind === 'mark' ? `${name}${/^\d*/.exec(script.slice(at + 3, at + 3 + MAX_DIGITS))![0]}` : name;
  return `${afterPrevious(script, at)}${label} 뒤에 구분자 없이 둔 DELIMITER 줄은 mysql 클라이언트의 판에 따라 명령으로 읽지 않습니다 — ${why} (${fix}) — ${RE_EXPORT}`;
}

const MAX_DIGITS = 32; // 안내에 보이는 실행 주석 번호의 최대 길이
const KEPT_BY_80 = "8.0 클라이언트는 실행 주석·힌트를 지우지 않고 버퍼에 남겨 DELIMITER 줄을 문장으로 보내 1064 이고, 8.4 클라이언트는 그 앞이 공백과 블록 주석('*'·'/' 가 "
  + '없는 것)뿐이면 주석을 버리고 명령으로 읽습니다';
const SEMICOLON = "주석 뒤에 ';' 를 두어 주세요";
const MOVE = "주석 뒤에 ';' 를 두거나 주석을 DELIMITER 줄 뒤로 옮겨 주세요";

// 종류마다 [이름, 판마다 하는 것, 고치는 법]
const REASONS: Record<Kind, readonly [string, string, string]> = {
  mark: ['실행 주석 /*!', KEPT_BY_80, SEMICOLON],
  hint: ['힌트 /*+', KEPT_BY_80, SEMICOLON],
  block: ["'*'·'/' 가 든 블록 주석", "8.0 클라이언트는 주석을 지우고 명령으로 읽는데, 8.4 클라이언트는 주석을 남겨 두고 그 앞이 공백과 '*'·'/' 가 없는 블록 주석뿐일 때만 "
    + '명령으로 읽어 DELIMITER 줄을 그 주석과 함께 문장으로 보내 1064 입니다', MOVE],
  line: ['공백·블록 주석 다음의 줄 주석', '8.0 클라이언트는 주석을 지우고 명령으로 읽는데, 8.4 클라이언트는 버퍼가 비었을 때의 줄 주석만 따로 보내고 공백·블록 주석 뒤의 것은 '
    + '버퍼에 남겨 DELIMITER 줄을 문장으로 보내 1064 입니다', '줄 주석 앞의 공백·블록 주석을 지우거나 주석을 DELIMITER 줄 뒤로 옮겨 주세요'],
  other: ['글', 'mysql 클라이언트는 그 글을 버퍼에 남겨 DELIMITER 줄을 문장으로 보냅니다', SEMICOLON],
};

// DELIMITER 의 인자 (리뷰 15회차 후속, 8.0.46·8.4.11 에서 mysql 클라이언트로 실측): 클라이언트는 첫 낱말(공백·탭 앞까지)이 DELIMITER 인 줄만 명령으로 읽고 '\g' 가 든 줄은 문장의
// 글로 보낸다 (find_command). 인자는 그 줄의 앞 255바이트에서 읽는다 (com_delimiter·get_arg): 앞 공백을 건너뛰고, 따옴표로 시작하면 짝 따옴표 앞까지, 아니면 첫 공백(' ') 앞까지다.
// 따옴표 밖의 백슬래시는 지우고, 남은 백슬래시와 빈 인자는 오류로 거부해 구분자를 바꾸지 않으며, 구분자는 앞 15바이트만 쓴다 (delimiter[16]). 문장 나누기가 읽은 구분자와 다르면
// RE_EXPORT 로 거부한다 — 클라이언트는 긴 구분자를 글자 가운데서도 자른다. 구분자가 ';' 일 때의 빈 DELIMITER 줄처럼 결과가 같으면 받는다
export function assertClientDelimiters(script: string, commands: readonly CommandLine[]): void {
  for (const c of commands) {
    const line = script.slice(script.lastIndexOf('\n', c.at - 1) + 1, c.end);
    const read = clientDelimiter(line, c.previous);
    const problem = 'problem' in read ? read.problem : read.delimiter === c.delimiter ? undefined : read.kept ? 'missing' : 'differ';
    if (problem) fail(`${afterPrevious(script, c.at)}DELIMITER 줄은 mysql 클라이언트가 다르게 읽습니다 — ${ARG_REASONS[problem]} — ${RE_EXPORT}`);
  }
}

type ArgProblem = 'g' | 'word' | 'cut' | 'backslash' | 'long' | 'missing' | 'differ';
type ClientRead = { readonly delimiter: string; readonly kept: boolean } | { readonly problem: ArgProblem };

const LINE_BYTES = 255; // com_delimiter 가 읽는 줄의 앞부분 (char buff[256])
const DELIMITER_BYTES = 15; // 클라이언트가 쓰는 구분자의 앞부분 (char delimiter[16])
const CLIENT_SPACES = /^[\t\n\v\f\r ]*/; // my_isspace

// mysql 클라이언트가 DELIMITER 줄(line — 줄바꿈은 빼고)에서 정하는 구분자. kept: 인자가 없어 오류를 내고 앞 구분자(previous)를 그대로 쓴다
function clientDelimiter(line: string, previous: string): ClientRead {
  if (line.includes('\\g')) return { problem: 'g' };
  const start = CLIENT_SPACES.exec(line)![0].length;
  const word = /^[^ \t]*/.exec(line.slice(start))![0];
  if (!/^delimiter$/i.test(word)) return { problem: 'word' }; // ASCII 만 대소문자를 가린다 — 렉서의 toUpperCase 는 'ı' 를 'I' 로 읽는다
  const from = start + word.length + CLIENT_SPACES.exec(line.slice(start + word.length))![0].length;
  const quote = /^['"`]/.exec(line.slice(from))?.[0];
  const begin = quote ? from + 1 : from;
  const close = line.indexOf(quote ?? ' ', begin);
  const end = close < 0 ? line.length : close;
  if (utf8Bytes(line.slice(0, end)) > LINE_BYTES) return { problem: 'cut' };
  const arg = line.slice(begin, end);
  if (arg.includes('\\')) return { problem: 'backslash' };
  if (arg === '') return { delimiter: previous, kept: true };
  return utf8Bytes(arg) > DELIMITER_BYTES ? { problem: 'long' } : { delimiter: arg, kept: false };
}

// UTF-8 바이트 수 — 클라이언트는 바이트로 센다
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

const ARG_REASONS: Record<ArgProblem, string> = {
  g: "'\\g' 가 든 줄은 DELIMITER 명령으로 읽지 않고 문장의 글로 보냅니다",
  word: "첫 낱말(공백·탭 앞까지)이 DELIMITER 인 줄만 명령으로 읽어, 'DELIMITER;;' 처럼 구분자를 붙여 쓰거나 공백·탭이 아닌 글자로 띄운 줄은 문장의 글로 보냅니다 "
    + '(DELIMITER 와 구분자 사이에 공백을 두어 주세요)',
  cut: '줄의 앞 255바이트만 읽어, 줄 처음부터 255바이트 뒤까지 이어지는 구분자를 자릅니다',
  backslash: '구분자의 따옴표 밖 백슬래시는 지우고, 남은 백슬래시는 오류로 거부해 구분자를 바꾸지 않습니다',
  long: '구분자의 앞 15바이트만 써, 15바이트를 넘는 구분자를 (글자 가운데서도) 자릅니다',
  missing: '구분자가 없는 DELIMITER 줄은 오류를 내고 앞 구분자를 그대로 씁니다',
  differ: '구분자를 문장 나누기와 다르게 읽습니다 (따옴표 밖 인자는 첫 공백 앞까지이고 줄 끝의 글자도 구분자에 듭니다)',
};
