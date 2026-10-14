// 스키마(SHOW CREATE 결과)를 바꾸지 않아 무시하는 문장 — 이미 MySQL 에서 돈 스크립트에 흔하다 (적용한 문장 수에 세지 않는다).
// applyStatement 가 덩어리에 문장이 하나만 있는지(assertOneStatement) 먼저 본 뒤 처리기를 부른다 — 뒤 DDL 이 함께 버려지지 않게
import type { Cursor } from '../cursor';
import type { Token } from '../lexer';
import { findTable, objectName, type State } from './state';
import { fail, RE_EXPORT } from './types';

type NoOp = (st: State, c: Cursor) => void;

// 트랜잭션 제어, 데이터 문장, 권한. DDL 은 MySQL 이 암묵적으로 커밋하므로 ROLLBACK 이 되돌리지 않고, TRUNCATE 가 바꾸는 AUTO_INCREMENT 값은 비교하지 않는다
const NO_OP_WORDS: ReadonlySet<string> = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'TRUNCATE', 'GRANT', 'REVOKE']);
// 조회 (리뷰 3회차 M-5): 함수는 DDL 을 실행할 수 없어 (암묵적으로 커밋하는 문장은 함수 안에서 MySQL 1422) 스키마가 그대로다.
// CALL·PREPARE·EXECUTE 는 DDL 을 실행할 수 있어 무시하지 않는다 (지원하지 않는 문장)
const QUERY_WORDS: ReadonlySet<string> = new Set(['SELECT', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN', 'DO']);

const ignore: NoOp = () => {};

// 무시하는 문장의 처리기 (아니면 undefined). 처리기는 MySQL 이 거부하거나 1차에서 받지 않는 꼴만 거부한다
export function noOpHandler(c: Cursor): NoOp | undefined {
  const first = c.peek();
  if (first?.t !== 'word') return undefined;
  const word = first.v.toUpperCase();
  if (QUERY_WORDS.has(word)) return assertNoVariableAssignment;
  if (NO_OP_WORDS.has(word) || c.isWord('START', 'TRANSACTION') || ['LOCK', 'UNLOCK'].some((w) => c.isWord(w, 'TABLES') || c.isWord(w, 'TABLE'))) return ignore;
  if (isKeysToggle(c)) return checkKeysToggle;
  return c.isWord('CREATE', 'SCHEMA', 'IF', 'NOT', 'EXISTS') || c.isWord('CREATE', 'DATABASE', 'IF', 'NOT', 'EXISTS') ? checkCurrentSchema : undefined;
}

const isOp = (t: Token | undefined, v: string): boolean => t?.t === 'op' && t.v === v;
const isWordToken = (t: Token | undefined, ...words: string[]): boolean => t?.t === 'word' && words.includes(t.v.toUpperCase());

// 조회 문장의 사용자 변수 대입(@v := …, … INTO @v)은 뒤 SET 이 읽는 저장 값(SET @OLD_X = @@X 의 @OLD_X 등)과 어긋날 수 있어 받지 않는다
function assertNoVariableAssignment(_st: State, c: Cursor): void {
  const assigns = c.toks.some((t, k) => isWordToken(t, 'INTO') || (isOp(t, ':') && isOp(c.toks[k + 1], '=')));
  if (assigns) fail(`사용자 변수에 대입하는 조회 문장(:=·INTO)은 뒤 SET 이 읽는 값을 바꿀 수 있어 받지 않습니다 — ${RE_EXPORT}`);
}

// ALTER TABLE t DISABLE KEYS·ENABLE KEYS 만 쓴 문장 (mysqldump 데이터 덤프의 '/*!40000 ALTER TABLE `t` DISABLE KEYS */;'): InnoDB 는 note 1031 만 남기고 아무것도 하지 않는다
// (8.0.46·8.4.11 실측). 다른 절과 함께 쓴 꼴은 드물어 무시하지 않고 ALTER TABLE 이 지원하지 않는 절로 거부한다. 이름은 t 나 db.t 다
function isKeysToggle(c: Cursor): boolean {
  const n = c.toks.length;
  const nameLength = n - 4; // ALTER TABLE <이름> DISABLE|ENABLE KEYS
  const isName = nameLength === 1 || (nameLength === 3 && isOp(c.toks[3], '.'));
  return c.isWord('ALTER', 'TABLE') && isName && isWordToken(c.toks[n - 2], 'DISABLE', 'ENABLE') && isWordToken(c.toks[n - 1], 'KEYS');
}

function checkKeysToggle(st: State, c: Cursor): void {
  c.expectWord('ALTER', 'TABLE');
  const name = objectName(c, st); // 다른 스키마의 테이블은 거부한다
  if (!findTable(st, name)) fail(`테이블 \`${name}\` 이 없습니다 (MySQL 1146)`);
}

// 현재 스키마의 CREATE {SCHEMA|DATABASE} IF NOT EXISTS (Workbench 정방향 스크립트의 첫 줄): 이미 있어 MySQL 은 note 1007 만 남긴다 (8.0.46·8.4.11 실측).
// 문자셋 옵션을 쓰면 MySQL 은 그 옵션도 무시하지만, 스키마 기본값은 적용 화면에서 정하므로 옵션을 지우도록 거부한다. 다른 스키마는 이 버전과 상관없어 받지 않는다
function checkCurrentSchema(st: State, c: Cursor): void {
  c.next();
  c.next();
  c.expectWord('IF', 'NOT', 'EXISTS');
  const name = c.ident();
  if (name !== st.schemaName) fail(`다른 스키마 \`${name}\` 의 CREATE SCHEMA·DATABASE 는 받지 않습니다 — 이 버전은 스키마 \`${st.schemaName}\` 하나를 나타냅니다 — ${RE_EXPORT}`);
  if (!c.done) fail(`CREATE SCHEMA·DATABASE 의 옵션(${c.peek()!.v} …)은 받지 않습니다 — 스키마 기본 문자셋·콜레이션은 적용 화면에서 정하고, 옵션이 없는 현재 스키마의 CREATE SCHEMA IF NOT EXISTS 는 무시합니다 — ${RE_EXPORT}`);
}
