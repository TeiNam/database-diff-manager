// 실행 주석의 버전 번호 (리뷰 11회차 R11-2·Claude F3, 8.0.46·8.4.11 실측). MySQL 은 '/*!' 뒤의 다섯 자리 번호가 서버 버전 이하일 때만 안의 글을 실행하고, 높으면
// 표지부터 첫 '*/' 까지를 주석으로 건너뛴다 (sql_lex.cc — 서버는 그 안의 따옴표를 보지 않는다. 8.0.46 은 80046 까지, 8.4.11 은 80411 까지 실행한다). 이 도구는 8.0/8.4 를
// 함께 따르므로 번호에 따라 셋으로 가른다:
// - 번호가 없거나 80046 이하: 실행한다 (mysqldump 머리·꼬리의 /*!40101 …*/, 덤프의 /*!80023 INVISIBLE */)
// - 80047~80499: 서버의 판에 따라 실행 여부가 갈려 거부한다 (8.0.46 은 건너뛰고 8.4.11 은 80411 까지 실행한다)
// - 80500 이상: 8.0·8.4 의 어느 판도 실행하지 않는 주석이다. 문장을 통째로 감쌌으면 주석뿐인 문장이라 MySQL 도 오류 없이 지나간다
// 번호가 다섯 자리가 아니면 거부한다: 다섯 자리보다 짧은 숫자는 MySQL 이 실행할 글로 읽고(/*!1 …), 여섯 자리는 8.0 이 앞 다섯 자리만 번호로 읽는데 8.4 는 뒤에 공백이
// 오면 여섯 자리를 번호로 읽는다(/*!100000 … 은 8.0 1064, 8.4 는 건너뛴다). 렉서는 '/*!' 뒤의 숫자를 모두 표지로 떼고 내용은 번호와 상관없이 토큰으로 읽는다 —
// 덤프 파서와 함께 쓰므로 그대로 두고, 문장 나누기가 알려 준 표지(ApplyStatement.marks)로 이 문장에서 MySQL 이 실행하는 글을 만든다. 문장 앞의 문장 없는 덩어리
// (ApplyStatement.leading)와 마지막 문장 뒤(ApplySplit.trailing)의 표지도 본다 (리뷰 12·13회차). DELIMITER 줄의 인자 뒤는 mysql 클라이언트처럼 읽지 않는다 (리뷰 14회차 F3)
import { lineOf } from '../cursor';
import type { Token } from '../lexer';
import type { ApplyStatement, LexNotes, NestedComment, VersionMark } from '../parse-dump';
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

// 거부 안내가 가리키는 자리 (리뷰 14회차 F2): 문장 안의 것은 서버·웹이 문장 번호와 그 줄을 붙여 앞말이 없고, 문장 앞 덩어리의 것은 뒤 문장의 번호로 안내되므로 표지가 있는
// 줄을 앞말로 밝힌다 (unicode-space.ts 의 assertLeadingSpaces 와 같다 — 13회차까지는 뒤 문장의 줄만 보였다). until: 표지가 닫혀야 하는 곳 (안내 글)
interface Place {
  readonly where: (at: number) => string;
  readonly until: string;
}

const IN_STATEMENT: Place = { where: () => '', until: '문장 안에서' };
const beforeStatement = (script: string, until: string): Place => ({ where: (at) => `앞 문장 뒤(줄 ${lineOf(script, at)})의 `, until });

// 이 문장의 덩어리에서 MySQL 이 건너뛰는 실행 주석의 자리. 실행 여부가 버전에 따라 갈리면 거부하고, 실행하는 주석이 문장 끝까지 닫히지 않았으면 1064 다 (assertRunsClosed).
// 실행하는 주석 안의 일반 주석도 거부한다 (assertNoNestedComment). script: 문장을 나눈 원문
export function skippedComments(script: string, s: ApplyStatement): Region[] {
  const regions = s.marks.filter((m) => !runs(m)).map((m) => skippedRegion(script, m, s.offset + s.ddl.length, IN_STATEMENT));
  assertRunsClosed(s.marks, s.closes, IN_STATEMENT);
  assertNoNestedComment(s.nested, IN_STATEMENT);
  return regions;
}

// 문장 앞 덩어리(s.leading — 앞 문장 뒤의 문장 없이 끝난 덩어리·DELIMITER 줄)의 건너뛰는 실행 주석 자리 (리뷰 12회차 Claude F5). 그 덩어리에는 토큰이 없어 판에 따라 갈리는
// 번호도 8.0·8.4 가 실행하든 건너뛰든 같아 받는다 ('/*!80400 */;' 뒤의 문장도 받는다 — 그 전제가 깨지는 것은 assertSameEitherWay 가 거부한다). 번호를 다르게 읽는 것과,
// 건너뛰는 것 안의 주석·줄 주석은 문장 안의 것처럼 거부한다. 표지마다 그 덩어리를 끝낸 구분자 안에서 닫혀야 한다 — mysql 클라이언트는 그 구분자에서 끊어 보낸다 (리뷰 13회차:
// 뒤 덩어리에서 닫힌 '/*!99999 ;' 줄바꿈 '*/;' 도 받았다). 마지막 덩어리(DELIMITER 줄 앞)는 이 문장 앞까지 보고, 거기 표지나 힌트가 있으면 거부한다 (assertNothingKeptBeforeCommand)
// — DELIMITER 줄의 인자 뒤는 mysql 클라이언트처럼 문장 나누기가 읽지 않아 표지가 없다 (리뷰 14회차 F3). 거부 안내는 표지가 있는 줄을 밝힌다 (Place)
export function leadingSkippedComments(script: string, s: ApplyStatement): Region[] {
  const { marks, closes, nested, hints, ends } = s.leading;
  const closesOf = byChunk(closes, (at) => at, ends);
  const chunks = byChunk(marks, (m) => m.at, ends);
  const delimited = beforeStatement(script, '구분자까지');
  const beforeCommand = beforeStatement(script, 'DELIMITER 줄 앞에서');
  const regions = chunks.flatMap((chunk, i) => {
    const bound = ends[i] ?? s.offset;
    const place = i < ends.length ? delimited : beforeCommand;
    const found = chunk.flatMap((m) => {
      const gate = gateOf(m, place);
      if (gate === 'either') assertSameEitherWay(script, m, bound, place);
      return gate === 'skip' ? [skippedRegion(script, m, bound, place)] : [];
    });
    assertRunsClosed(chunk, closesOf[i], place);
    return found;
  });
  assertNoNestedComment(nested, delimited);
  const lastEnd = ends[ends.length - 1] ?? -1;
  assertNothingKeptBeforeCommand(chunks[ends.length], hints.filter((at) => at > lastEnd), beforeCommand);
  return regions;
}

// 구분자 없이 DELIMITER 줄 앞에 둔 실행 주석·힌트 (리뷰 14회차, 8.0.46·8.4.11 에서 mysql 클라이언트로 실측): 마지막 덩어리(모든 끝 뒤)의 것은 DELIMITER 줄 앞의 토큰 없는 자리에
// 있다. mysql 클라이언트는 버퍼가 비었을 때만(8.4 는 공백·블록 주석뿐일 때도 — 실행 주석·힌트도 블록 주석으로 보고 버린다) 그 줄을 명령으로 읽는데, 8.0 은 둘 다 지우지 않고 버퍼에
// 남겨 DELIMITER 줄을 문장의 글로 보내 1064 다 ('/*!40101 */'·'/*+ x */' 줄바꿈 'DELIMITER ;;' — 8.4 는 뒤 루틴·ALTER 를 실행한다. 뒤에 줄 주석을 두면 8.4 도 1064). 13회차까지는
// 받았다. marks·hints: 마지막 덩어리의 표지와 힌트 '/*+' 의 자리 (자리 순서)
function assertNothingKeptBeforeCommand(marks: readonly VersionMark[], hints: readonly number[], place: Place): void {
  const mark = marks[0];
  const hint = hints[0];
  if (mark && (hint === undefined || mark.at < hint)) fail(keptBeforeCommand(place.where(mark.at), `실행 주석 /*!${mark.digits}`));
  if (hint !== undefined) fail(keptBeforeCommand(place.where(hint), '힌트 /*+'));
}

const keptBeforeCommand = (where: string, name: string): string => `${where}${name} 뒤에 구분자 없이 둔 DELIMITER 줄은 mysql 클라이언트의 판에 따라 명령으로 읽지 `
  + `않습니다 — 8.0 클라이언트는 그 주석과 함께 DELIMITER 줄을 문장으로 보내 1064 이고, 8.4 클라이언트는 그 앞이 공백·블록 주석뿐이면 주석을 버리고 명령으로 읽습니다 `
  + `(주석 뒤에 ';' 를 두어 주세요) — ${RE_EXPORT}`;

// items(자리 순서)를 덩어리 끝(ends, 자리 순서)으로 나눈다: i 번째는 ends[i] 앞의 것, 마지막은 모든 끝 뒤의 것
function byChunk<T>(items: readonly T[], at: (item: T) => number, ends: readonly number[]): T[][] {
  const chunks: T[][] = Array.from({ length: ends.length + 1 }, () => []);
  let k = 0;
  for (const item of items) {
    while (k < ends.length && ends[k] < at(item)) k++;
    chunks[k].push(item);
  }
  return chunks;
}

// 실행하는 실행 주석(번호 없음, 80046 이하)이 덩어리 끝까지 닫혔는가 (리뷰 13회차, 8.0.46·8.4.11 에서 mysql 클라이언트로 실측): mysql 클라이언트는 '/*!' 안의 구분자에서도 문장을
// 끊어, 닫히지 않은 채 보낸 주석을 MySQL 은 1064 로 거부한다 ('/*!40101 ALTER … ;' 줄바꿈 '*/;' — 13회차 전에는 그 문장과 뒤 문장을 적용했다). 서버는 안의 글을 실행하다 처음
// 만난 '*/' 에서 주석을 닫고(안에서 연 실행하는 주석도 함께 닫힌다), 건너뛰는 주석의 '*/' 는 그 주석만 닫는다 — 건너뛰는 주석 안에는 표지가 없다 (opensComment). 렉서는 표지마다
// 하나씩 닫아, 함께 닫힌 뒤의 '*/' 도 닫힘으로 읽는다 — 서버는 닫을 주석이 없어 '*' '/' 로 읽고 1064 다 (리뷰 14회차, 8.0.46·8.4.11 실측: '/*!40101 ALTER … /*!40101 , ADD b */ */;'
// — 13회차까지는 a·b 를 더했다). marks·closes: 한 덩어리의 표지와 렉서가 실행 주석을 닫은 '*/' 의 자리 (자리 순서 — 따옴표·주석 안의 '*/' 는 빠진다)
function assertRunsClosed(marks: readonly VersionMark[], closes: readonly number[], place: Place): void {
  let open: VersionMark | undefined; // 서버가 안의 글을 실행하는 주석을 연 표지 (닫혔으면 undefined)
  let skipping = false; // 건너뛰는 주석을 열고 아직 닫지 않았다 — 다음 '*/' 는 그 주석만 닫는다
  let k = 0;
  const closeBefore = (at: number): void => {
    for (; k < closes.length && closes[k] < at; k++) {
      if (skipping) skipping = false;
      else if (open) open = undefined;
      else fail(`${place.where(closes[k])}${STRAY_CLOSE} — 실행 주석은 처음 만난 '*/' 에서 안에서 연 실행 주석과 함께 닫힙니다 (MySQL 1064)`);
    }
  };
  for (const m of marks) {
    closeBefore(m.at);
    if (gateOf(m) === 'run') open = m;
    else skipping = true;
  }
  closeBefore(Infinity);
  if (open) fail(`${place.where(open.at)}실행 주석 /*!${open.digits} 가 ${place.until} 닫히지 않았습니다 (MySQL 1064)`);
}

// 짝 없는 '*/' 의 안내 앞부분: MySQL 은 닫을 실행 주석이 없는 '*/' 를 '*' '/' 로 읽는다
const STRAY_CLOSE = "짝 없는 '*/' 가 있습니다 — MySQL 은 닫을 실행 주석이 없는 '*/' 를 '*' '/' 로 읽습니다";

// 렉서가 실행 주석의 닫힘으로 읽지 않은 '*/' (리뷰 14회차, 8.0.46·8.4.11 에서 mysql 클라이언트로 실측 — 'ALTER TABLE t ADD c INT */;' 는 1064): written(ddl 을 따로 나눈 토큰)의 붙은
// '*' '/' 는 문장 앞에서 연 실행 주석의 닫힘이거나('/*!40101 ALTER … */;' — 렉서가 그 자리를 알렸다, s.closes) 짝이 없는 것이다. 짝 없는 것은 MySQL 도 '*' '/' 로 읽어 1064 다 —
// 13회차까지는 문장 끝의 것을 문장을 감싼 주석의 닫힘처럼 떼고(applyTokens 의 withoutCommentEnd) 받았다 (ALTER 는 c 를, 루틴은 p 를 더했다)
export function assertNoStrayClose(s: ApplyStatement, written: readonly Token[]): void {
  const pairs = written.filter((t, k) => isOp(t, '*') && isOp(written[k + 1], '/') && t.e === written[k + 1].s);
  if (!pairs.length) return;
  const closes = new Set(s.closes);
  if (pairs.some((t) => !closes.has(s.offset + t.s))) fail(`${STRAY_CLOSE} (MySQL 1064)`);
}

const isOp = (t: Token | undefined, v: string): boolean => t?.t === 'op' && t.v === v;

// MySQL 이 이 문장에서 실행하는 글: 건너뛰는 실행 주석(skipped)을 공백으로 지운 ddl (없으면 ddl 그대로, 주석뿐이면 ''). 루틴 정의 안의 것은 지우지 않는다 —
// createRoutine 이 루틴 정의 안의 실행 주석을 받지 않는다 (MySQL 은 본문에서 그 글을 지워 저장한다)
export function executedText(s: ApplyStatement, skipped: readonly Region[]): string {
  if (!skipped.length) return s.ddl;
  const lead = blank(s, skipped.filter((r) => r.start < s.offset)).trimStart(); // 문장이 그 안에서 시작한 주석 (ddl 앞에서 열었다)
  return isCreateRoutine(lead) ? lead : blank(s, skipped).trim();
}

// 표지의 번호를 8.0·8.4 가 어떻게 읽는가: run 은 모두 실행, skip 은 모두 건너뜀, either 는 판에 따라 갈림 (80047~80499). 번호를 다르게 읽으면 거부한다
type Gate = 'run' | 'skip' | 'either';

function gateOf(m: VersionMark, place = IN_STATEMENT): Gate {
  if (m.digits === '') return 'run';
  if (m.digits.length !== VERSION_DIGITS) {
    fail(`${place.where(m.at)}실행 주석 /*!${m.digits} 의 버전 번호가 다섯 자리가 아닙니다 — MySQL 은 다섯 자리보다 짧은 숫자를 실행할 글로 읽고, 여섯 자리는 8.0 과 8.4 가 `
      + `다르게 읽습니다 — ${RE_EXPORT}`);
  }
  const version = Number(m.digits);
  if (version <= LAST_RUN_BY_BOTH) return 'run';
  return version >= FIRST_SKIPPED_BY_BOTH ? 'skip' : 'either';
}

// 표지의 번호를 8.0·8.4 가 모두 실행하는가 (모두 건너뛰면 false). 판에 따라 갈리거나 번호를 다르게 읽으면 거부한다
function runs(m: VersionMark): boolean {
  const gate = gateOf(m);
  if (gate !== 'either') return gate === 'run';
  return fail(`실행 주석 /*!${m.digits} 는 서버 버전에 따라 실행 여부가 갈립니다 — MySQL 은 서버 버전이 그 번호 이상일 때만 안의 글을 실행하는데 8.0.46 은 건너뛰고 `
    + `8.4 는 판에 따라 실행합니다 (8.4.11 은 80411 까지) — ${RE_EXPORT}`);
}

// 8.0·8.4 가 모두 건너뛰는 표지인가 (다섯 자리 80500 이상) — 거부하지 않고 가른다
const skippedByBoth = (m: VersionMark): boolean => m.digits.length === VERSION_DIGITS && Number(m.digits) >= FIRST_SKIPPED_BY_BOTH;

// 어느 판이든 건너뛸 수 있는 표지인가 (마지막 문장 뒤 — 거부하지 않고 가른다): 다섯 자리 80047 이상과 여섯 자리 이상. 8.4 는 공백이 뒤따르는 여섯 자리를 번호로 읽어
// 건너뛰고(/*!100000), 일곱 자리 이상은 두 판 모두 앞 다섯 자리를 번호로 읽는다 (함께 본다 — 보수적)
const skippable = (m: VersionMark): boolean => m.digits.length > VERSION_DIGITS || (m.digits.length === VERSION_DIGITS && Number(m.digits) > LAST_RUN_BY_BOTH);

// 표지 뒤 내용이 시작하는 원문 자리 ('/*!' 와 번호 다음)
const contentStart = (m: VersionMark): number => m.at + '/*!'.length + m.digits.length;

// 안내에 쓰는 실행 주석의 이름: 8.0·8.4 가 모두 건너뛰는 것과, 서버 버전에 따라 건너뛰는 것(80047~80499, 여섯 자리 이상)
const commentName = (m: VersionMark): string => `${skippedByBoth(m) ? '' : '서버 버전에 따라 '}건너뛰는 실행 주석 /*!${m.digits}`;

// 표지가 연 실행 주석 안의 글: 내용부터 첫 '*/' 앞까지 (MySQL 은 건너뛸 때 그 안의 따옴표를 보지 않는다). bound(문장·덩어리의 끝) 안에서 닫히지 않으면 — 구분자가 주석 안에
// 있어 mysql 클라이언트가 주석 가운데서 문장을 끊었다 — MySQL 은 닫히지 않은 주석으로 1064 다. 그 안의 주석은 받지 않는다 (opensComment). place: 거부 안내의 자리
function skippedText(script: string, m: VersionMark, bound: number, place: Place): string {
  const content = contentStart(m);
  const close = script.indexOf('*/', content);
  if (close < 0 || close + '*/'.length > bound) fail(`${place.where(m.at)}${commentName(m)} 가 ${place.until} 닫히지 않았습니다 (MySQL 1064)`);
  if (opensComment(script, content, close)) fail(place.where(m.at) + innerCommentReason(m));
  return script.slice(content, close);
}

// 건너뛰는 실행 주석의 자리: 표지부터 첫 '*/' 까지. 그 안의 줄 주석은 mysql 클라이언트가 떼고 보내는지에 따라 건너뛰는 글이 갈려 받지 않는다 (lineCommentReason)
function skippedRegion(script: string, m: VersionMark, bound: number, place: Place): Region {
  const inner = skippedText(script, m, bound, place);
  if (LINE_COMMENT.test(inner)) fail(place.where(m.at) + lineCommentReason(m));
  return { start: m.at, end: contentStart(m) + inner.length + '*/'.length };
}

// 판에 따라 갈리는 번호(80047~80499)의 문장 없는 덩어리 (리뷰 13회차 F2·R13-2, 8.0.46·8.4.11 에서 mysql 클라이언트로 실측): 받는 전제(8.0.46 이 건너뛰든 8.4 가 실행하든 같다)가
// 깨지는 것은 거부한다 — 덩어리 안에서 닫히지 않은 것(1064), 안의 주석(8.0 클라이언트는 1064 이고 8.4 클라이언트는 받는다), 첫 '*/' 를 가린 줄 주석(8.4 클라이언트로 8.0.46 에
// 실행하면 그 '*/' 뒤의 글을 실행하는데, 8.4.11 과 렉서는 줄 주석으로 읽는다). 줄 주석이 '*/' 앞 줄에서 끝나면 받는다 ('/*!80499 -- 메모\n*/;')
function assertSameEitherWay(script: string, m: VersionMark, bound: number, place: Place): void {
  if (hidesClose(skippedText(script, m, bound, place))) fail(place.where(m.at) + lineCommentReason(m));
}

// 줄 주석의 시작: '#', 또는 공백·제어 문자가 뒤따르는 '--' (렉서·mysql 클라이언트와 같다). 건너뛰는 주석 안에서는 따옴표 안의 것도 함께 본다 (보수적)
const LINE_COMMENT = /#|--[\x00-\x20\x7f]/;

// 실행 주석 안의 글(inner — 첫 '*/' 앞까지)에서 줄 주석이 그 '*/' 를 가리는가: 마지막 줄에서 줄 주석이 열렸다 (줄 주석은 줄 끝에서 끝난다 — 렉서·mysql 클라이언트와 같다)
const hidesClose = (inner: string): boolean => LINE_COMMENT.test(inner.slice(inner.lastIndexOf('\n') + 1));

// 실행 주석 안에서 주석이 열렸는가: 내용 자리(content)부터 첫 '*/'(close, 닫히지 않았으면 -1) 앞에 '/*' 가 있다. 서버는 건너뛸 때 그 '/*' 를 한 겹 주석으로 읽어 닫는 '*/' 가
// 뒤로 밀리고, 렉서는 끝을 다르게 읽을 수 있다. 첫 '*/' 와 겹친 '/*/' 도 주석이다 (서버는 '/*' 로 먼저 읽는다). 다음 '/*' 까지만 훑는다 — 다음 표지가 그 뒤에 있다
function opensComment(script: string, content: number, close: number): boolean {
  const open = script.indexOf('/*', content);
  return open >= 0 && (close < 0 || open < close);
}

const innerCommentReason = (m: VersionMark): string => `${commentName(m)} 안의 주석은 받지 않습니다 — ${RE_EXPORT}`;

// 실행하는 실행 주석(어느 판이든 건너뛸 수 있는 번호가 아닌 것) 안에서 연 일반 주석 (리뷰 14회차 F1, 8.0.46·8.4.11 에서 mysql 클라이언트로 실측): mysql 클라이언트는 '/*!' 를 연 줄에서
// 그 뒤에 연 '/*' 를 둘째 '*/' 까지 주석으로 보고(첫 '*/' 는 '/*!' 만 닫는다 — add_line 의 ss_comment) 그동안 구분자·줄 주석을 보지 않으며, 8.0 기본(--skip-comments)은 그 글을
// 지우고 보낸다. 서버와 렉서는 첫 '*/' 에서 닫아, 'ADD a INT /*!40101 , ADD b INT /* x */ , ADD c INT */ , ADD d INT' 은 8.0 클라이언트가 a·b·d, 8.4 클라이언트가 a·b·c·d 를
// 더한다. 다음 줄에서 연 것은 두 클라이언트가 같지만 함께 거부한다 (보수적 — 서버도 실행 주석 안의 주석에 경고 1681 'Nested comment syntax is deprecated' 를 낸다).
// 건너뛰는 실행 주석 안의 것은 원문으로 보는 opensComment 가 거부한다
function assertNoNestedComment(nested: readonly NestedComment[], place: Place): void {
  const found = nested.find((n) => !skippable(n.mark));
  if (found) fail(place.where(found.mark.at) + nestedReason(found.mark));
}

const nestedReason = (m: VersionMark): string => `실행 주석 /*!${m.digits} 안의 주석('/* … */')은 받지 않습니다 — mysql 클라이언트가 판과 설정(--comments)에 따라 `
  + `실행 주석과 같은 줄에서 연 주석을 둘째 '*/' 까지 지우고 보내거나 그대로 보내 MySQL 이 실행하는 글이 달라집니다 — ${RE_EXPORT}`;

// 건너뛰는 실행 주석 안의 줄 주석 (리뷰 12회차 R12-3·Claude F3, 8.0.46·8.4.11 에서 mysql 클라이언트로 실측): 서버는 첫 '*/' 까지 건너뛰지만 mysql 클라이언트는 '/*!' 안에서도
// 줄 주석을 줄 끝까지 떼고 보내거나(8.0 기본) 그대로 보내(8.4 기본·--comments), 같은 스크립트가 판에 따라 1064 이거나 다른 DDL 을 실행한다. 렉서는 줄 주석으로 읽어 닫는
// '*/' 와 뒤 DDL 을 삼킬 수 있다
const lineCommentReason = (m: VersionMark): string => `${commentName(m)} 안의 줄 주석('#'·'-- ')은 받지 않습니다 — mysql 클라이언트가 판과 설정(--comments)에 `
  + `따라 줄 주석을 떼고 보내거나 그대로 보내 MySQL 이 건너뛰는 글이 달라집니다 (줄 주석이 닫는 '*/' 와 뒤 문장을 가릴 수 있습니다) — ${RE_EXPORT}`;

// 마지막 문장 뒤에서 렉서가 뒤 DDL 을 삼켰을 수 있는 실행 주석: 표지의 원문 자리와 거부하는 까닭
export interface HiddenComment {
  readonly at: number;
  readonly reason: string;
}

// 마지막 문장 뒤(trailing)의 실행 주석 가운데 렉서가 뒤 DDL 을 삼켰을 수 있는 것 (없으면 undefined, 리뷰 12회차 R12-3·13회차 F2·R13-2). 어느 판이든 건너뛸 수 있는 번호
// (skippable)만 본다 — 서버는 첫 '*/' 까지 건너뛰고 뒤의 글을 실행하는데, 렉서는 그 안의 줄 주석에서 닫는 '*/' 와 뒤 DDL 을 삼켜 문장으로 내지 않았을 수 있다. 줄 주석은
// 8.0·8.4 가 모두 건너뛰는 것이면 어디에 있든(닫히지 않았으면 원문 끝까지), 판에 따라 갈리는 것이면 첫 '*/' 를 가릴 때만 거부한다 (문장 없는 덩어리와 같다). 안의 주석은 서버가
// 닫는 '*/' 를 뒤로 밀어 그 '*/' 를 가린 줄 주석을 놓치므로 거부한다. 그 밖의 것은 MySQL 이 오류를 내도 앞 DDL 을 모두 적용한 뒤라 모델이 같아 받는다.
// 번호를 먼저 보고 표지마다 첫 '*/' 까지만 훑는다 — 받은 것 안에는 '/*' 가 없어 다음 표지는 그 뒤에 있으므로 원문을 한 번만 훑는다 (리뷰 13회차 F1·R13-1 — 번호를 보기 전에
// 표지마다 원문 끝까지 다시 훑어, 닫지 않은 표지가 가득한 1,000,000자 스크립트 하나가 50 초였다). 실행하는 실행 주석 안의 일반 주석도 거부한다 (리뷰 14회차 F1 — 렉서는 그 뒤의
// 줄 주석에서 뒤 DDL 을 삼키는데, 8.0 클라이언트는 그 DDL 을 실행한다). 둘 다 있으면 앞의 표지의 것이다
export function hiddenAfterLast(script: string, trailing: LexNotes): HiddenComment | undefined {
  const hidden = hiddenSkipped(script, trailing.marks);
  const nested = trailing.nested.find((n) => !skippable(n.mark));
  if (nested && (!hidden || nested.mark.at < hidden.at)) return { at: nested.mark.at, reason: nestedReason(nested.mark) };
  return hidden;
}

// 마지막 문장 뒤의 어느 판이든 건너뛸 수 있는 표지 가운데 렉서가 뒤 DDL 을 삼켰을 수 있는 첫 것 (hiddenAfterLast)
function hiddenSkipped(script: string, marks: readonly VersionMark[]): HiddenComment | undefined {
  for (const m of marks) {
    if (!skippable(m)) continue;
    const content = contentStart(m);
    const close = script.indexOf('*/', content);
    if (opensComment(script, content, close)) return { at: m.at, reason: innerCommentReason(m) };
    const inner = script.slice(content, close < 0 ? script.length : close);
    if (skippedByBoth(m) ? LINE_COMMENT.test(inner) : close >= 0 && hidesClose(inner)) return { at: m.at, reason: lineCommentReason(m) };
  }
  return undefined;
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
