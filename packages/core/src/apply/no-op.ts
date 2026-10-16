// 스키마(SHOW CREATE 결과)를 바꾸지 않아 무시하는 문장 — 이미 MySQL 에서 돈 스크립트에 흔하다 (적용한 문장 수에 세지 않는다).
// applyStatement 가 덩어리에 문장이 하나만 있는지(assertOneStatement) 먼저 본 뒤 처리기를 부른다 — 뒤 DDL 이 함께 버려지지 않게
import { Cursor } from '../cursor';
import type { Token } from '../lexer';
import { splitList } from './lists';
import { canonicalCharset, canonicalCollation, charsetOfCollation, primaryCollation } from './normalize-mysql';
import { optionValue } from './options';
import { findTable, objectName, type State } from './state';
import { forgetStateChangedBy, storedFunctionCall } from './stored-call';
import { fail, RE_EXPORT } from './types';

type NoOp = (st: State, c: Cursor) => void;

// 트랜잭션 제어, 데이터 문장, 권한. DDL 은 MySQL 이 암묵적으로 커밋하므로 ROLLBACK 이 되돌리지 않고, TRUNCATE 가 바꾸는 AUTO_INCREMENT 값은 비교하지 않는다
const NO_OP_WORDS: ReadonlySet<string> = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'TRUNCATE', 'GRANT', 'REVOKE']);
// 두 단어로 여는 무시 문장. 계정 삭제·이름 변경(DROP·RENAME USER, 리뷰 4회차 M-3)은 비밀번호를 담지 않는다 — CREATE·ALTER USER 는 index.ts 가 지우라고 안내한다
const NO_OP_PAIRS: readonly (readonly string[])[] = [['START', 'TRANSACTION'], ['LOCK', 'TABLES'], ['LOCK', 'TABLE'], ['UNLOCK', 'TABLES'], ['UNLOCK', 'TABLE'], ['DROP', 'USER'], ['RENAME', 'USER']];
// 조회 (리뷰 3회차 M-5): 함수는 DDL 을 실행할 수 없어 (암묵적으로 커밋하는 문장은 함수 안에서 MySQL 1422) 스키마가 그대로다. 다만 저장 함수는 사용자 변수 등을 바꿀 수 있어
// 부르면 그 값을 모르는 값으로 둔다 (forgetStateChangedBy). CALL·PREPARE·EXECUTE 는 DDL 을 실행할 수 있어 무시하지 않는다 (지원하지 않는 문장)
const QUERY_WORDS: ReadonlySet<string> = new Set(['SELECT', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN', 'DO']);
// 테이블 점검 문장 (리뷰 4회차 M-3, 8.0.46·8.4.11 실측): ANALYZE·OPTIMIZE·CHECK·CHECKSUM TABLE 은 통계를 모으거나 검사하거나 (OPTIMIZE 는 InnoDB 테이블을) 다시 만들 뿐
// SHOW CREATE 는 그대로다. 값: 이름 목록 뒤에 쓸 수 있는 검사 방식
const MAINTENANCE_OPTIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ['ANALYZE', []], ['OPTIMIZE', []], ['CHECK', ['FOR', 'UPGRADE', 'QUICK', 'FAST', 'MEDIUM', 'EXTENDED', 'CHANGED']], ['CHECKSUM', ['QUICK', 'EXTENDED']],
]);

// 무시하는 문장의 처리기 (아니면 undefined). 처리기는 MySQL 이 거부하거나 1차에서 받지 않는 꼴만 거부한다
export function noOpHandler(c: Cursor): NoOp | undefined {
  const first = c.peek();
  if (first?.t !== 'word') return undefined;
  const word = first.v.toUpperCase();
  if (QUERY_WORDS.has(word)) return ignoreQuery;
  if (NO_OP_WORDS.has(word) || NO_OP_PAIRS.some((pair) => c.isWord(...pair)) || isFlush(c)) return ignoreStatement;
  if (isMaintenance(c)) return checkMaintainedTables;
  if (isKeysToggle(c)) return checkKeysToggle;
  if (c.isWord('ALTER', 'SCHEMA') || c.isWord('ALTER', 'DATABASE')) return alterSchemaDefaults;
  if (c.isWord('DROP', 'SCHEMA') || c.isWord('DROP', 'DATABASE')) return dropSchema;
  return c.isWord('CREATE', 'SCHEMA') || c.isWord('CREATE', 'DATABASE') ? createSchema : undefined;
}

const isOp = (t: Token | undefined, v: string): boolean => t?.t === 'op' && t.v === v;
const isWordToken = (t: Token | undefined, ...words: string[]): boolean => t?.t === 'word' && words.includes(t.v.toUpperCase());
// k 자리에서 사용자 변수 대입 ':=' 가 시작하는가 (문자열·주석 속 ':=' 는 토큰이 아니다)
const isAssignmentAt = (toks: readonly Token[], k: number): boolean => isOp(toks[k], ':') && isOp(toks[k + 1], '=');

// 조회 문장의 사용자 변수 대입(@v := …, … INTO @v)은 뒤 SET 이 읽는 저장 값(SET @OLD_X = @@X 의 @OLD_X 등)과 어긋날 수 있어 받지 않는다
function ignoreQuery(st: State, c: Cursor): void {
  const assigns = c.toks.some((t, k) => isWordToken(t, 'INTO') || isAssignmentAt(c.toks, k));
  if (assigns) fail(`사용자 변수에 대입하는 조회 문장(:=·INTO)은 뒤 SET 이 읽는 값을 바꿀 수 있어 받지 않습니다 — ${RE_EXPORT}`);
  forgetStateChangedBy(st, storedFunctionCall(st, c.toks, c.src));
}

// 그 밖의 무시하는 문장도 같다 (리뷰 6회차 Codex #2): 데이터 문장은 INSERT … VALUES ((@v := 'x')) 처럼 사용자 변수에 대입할 수 있는데, 문장을 실행하지 않으니
// 대입한 값을 몰라 뒤 SET 이 그 변수를 읽으면(SET SQL_MODE = @v) 옛 값을 쓴다. INSERT·REPLACE 의 INTO 는 테이블을 가리켜 대입이 아니므로 ':=' 만 본다.
// 저장 함수를 부르는 문장은 받고, 함수가 바꿨을 수 있는 값을 모르는 값으로 둔다 (UPDATE t SET v = fn(v) — 도우미 함수로 데이터를 고치는 마이그레이션)
function ignoreStatement(st: State, c: Cursor): void {
  if (c.toks.some((_t, k) => isAssignmentAt(c.toks, k))) fail(`사용자 변수에 대입하는 데이터 문장(:=)은 뒤 SET 이 읽는 값을 바꿀 수 있어 받지 않습니다 — ${RE_EXPORT}`);
  forgetStateChangedBy(st, storedFunctionCall(st, c.toks, c.src));
}

// FLUSH PRIVILEGES·FLUSH TABLES (리뷰 4회차 M-3): 권한 표를 다시 읽거나 열린 테이블을 닫을 뿐이다. 뒤에 더 쓴 꼴(FLUSH TABLES WITH READ LOCK, 테이블 이름)과
// 그 밖의 FLUSH 는 드물어 받지 않는다
const isFlush = (c: Cursor): boolean => c.toks.length === 2 && c.isWord('FLUSH') && isWordToken(c.toks[1], 'PRIVILEGES', 'TABLES');

// {ANALYZE|OPTIMIZE} [NO_WRITE_TO_BINLOG|LOCAL] {TABLE|TABLES} …, {CHECK|CHECKSUM} {TABLE|TABLES} …
function isMaintenance(c: Cursor): boolean {
  const verb = c.peek()!.v.toUpperCase();
  if (!MAINTENANCE_OPTIONS.has(verb)) return false;
  const skipsBinlog = (verb === 'ANALYZE' || verb === 'OPTIMIZE') && isWordToken(c.peek(1), 'NO_WRITE_TO_BINLOG', 'LOCAL');
  return isWordToken(c.peek(skipsBinlog ? 2 : 1), 'TABLE', 'TABLES');
}

// 이름 목록[, …] 과 끝의 검사 방식(CHECK TABLE t FOR UPGRADE·QUICK …)만 받는다 — ANALYZE 의 히스토그램 절 같은 그 밖의 꼴은 드물어 받지 않는다.
// 이름을 쓴 테이블이 있어야 한다: MySQL 은 없는 테이블을 결과 행의 오류(Table '…' doesn't exist)로만 알리지만, 기준 버전과 스크립트가 맞지 않으니 DISABLE KEYS 처럼 거부한다
function checkMaintainedTables(st: State, c: Cursor): void {
  const verb = c.next().v.toUpperCase();
  if (!c.acceptWord('NO_WRITE_TO_BINLOG')) c.acceptWord('LOCAL');
  if (!c.acceptWord('TABLE')) c.expectWord('TABLES');
  const options = MAINTENANCE_OPTIONS.get(verb)!;
  const rest = c.toks.slice(c.i);
  let end = rest.length;
  while (end > 1 && isWordToken(rest[end - 1], ...options)) end--;
  for (const item of splitList(rest.slice(0, end), `${verb} TABLE`)) {
    const one = new Cursor(item, c.src);
    const name = objectName(one, st); // 다른 스키마의 테이블은 거부한다
    if (!one.done) fail(`${verb} TABLE 은 테이블 이름과 검사 방식만 쓴 꼴만 무시합니다: ${one.peek()!.v} … — ${RE_EXPORT}`);
    if (!findTable(st, name)) fail(`테이블 \`${name}\` 이 없습니다 (MySQL 1146)`);
  }
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

// CREATE {SCHEMA|DATABASE} [IF NOT EXISTS] 이름 [옵션]: 다른 스키마는 이 버전의 정의와 상관없어 무시한다. 현재 스키마는 이미 있어(Workbench 정방향 스크립트의 첫 줄,
// mysqldump --databases 의 머리) MySQL 은 IF NOT EXISTS 면 note 1007 만 남기고 문자셋·콜레이션·ENCRYPTION 옵션도 무시한다 — 스키마 기본값은 그대로다 (8.0.46·8.4.11 실측,
// 리뷰 4회차 M-3). IF NOT EXISTS 가 없으면 MySQL 은 1007 로 거부하지만 정의는 그대로라 같이 무시한다
function createSchema(st: State, c: Cursor): void {
  c.next();
  c.next();
  c.acceptWord('IF', 'NOT', 'EXISTS');
  if (c.ident() !== st.schemaName) return;
  checkSchemaOptions(c, 'CREATE');
}

// DROP {SCHEMA|DATABASE} [IF EXISTS] 이름: 다른 스키마는 무시한다. 현재 스키마를 지우면 MySQL 은 모든 테이블·뷰·루틴을 지우는데, 그 뒤 다시 만드는 스크립트는 기준 버전에
// 이어 적용할 수 없어 받지 않는다
function dropSchema(st: State, c: Cursor): void {
  c.next();
  c.next();
  c.acceptWord('IF', 'EXISTS');
  const name = c.ident();
  if (name === st.schemaName) fail(`현재 스키마 \`${name}\` 를 지우는 DROP SCHEMA·DATABASE 는 받지 않습니다 (모든 객체를 지웁니다) — 스키마를 새로 만든 덤프라면 ${RE_EXPORT}`);
}

const SCHEMA_OPTION_WORDS: ReadonlySet<string> = new Set(['DEFAULT', 'CHARACTER', 'CHARSET', 'COLLATE', 'ENCRYPTION', 'READ']);

// 현재 스키마의 ALTER {DATABASE|SCHEMA} [이름] 문자셋·콜레이션: 스키마 기본값만 바꾼다. 있는 테이블·루틴의 SHOW CREATE 는 그대로이고, 뒤에 문자셋 없이 만드는
// 테이블·루틴과 CONVERT TO CHARACTER SET DEFAULT 가 새 기본값을 쓴다 — 기본 DB 를 바꾸면 MySQL 은 세션의 character_set_database·collation_database 도 고친다
// (sql_db.cc mysql_alter_db). 문자셋만 쓰면 그 기본 콜레이션, 콜레이션만 쓰면 그 문자셋이다. READ ONLY 는 정의를 바꾸지 않아 무시하고, ENCRYPTION 은 뒤에 만드는
// 테이블 옵션을 바꿔 받지 않는다. 다른 스키마의 ALTER 는 무시한다
function alterSchemaDefaults(st: State, c: Cursor): void {
  c.next();
  c.next();
  const head = c.peek();
  const named = head !== undefined && (head.t === 'ident' || (head.t === 'word' && !SCHEMA_OPTION_WORDS.has(head.v.toUpperCase())));
  const name = named ? c.ident() : st.schemaName;
  if (name !== st.schemaName) return; // 다른 스키마는 이 버전의 정의와 상관없다
  if (c.done) fail('ALTER SCHEMA·DATABASE 에 바꿀 옵션이 없습니다 (MySQL 1064)');
  const { charset, collation } = checkSchemaOptions(c, 'ALTER');
  if (charset === undefined && collation === undefined) return; // READ ONLY 만 바꿨다
  st.defaults = charset === undefined ? { charset: charsetOfCollation(collation!), collation: collation! } : { charset, collation: collation ?? primaryCollation(charset) };
}

// [DEFAULT] {CHARACTER SET|CHARSET} [=] 이름, [DEFAULT] COLLATE [=] 이름, [DEFAULT] ENCRYPTION [=] 'Y'|'N' (쉼표 없이 이어 쓴다). 있는 스키마여도 MySQL 은 이름을 먼저 본다
// (모르는 문자셋 1115, 콜레이션 1273, 서로 맞지 않으면 1253). ALTER 는 스키마 기본값을 바꾸므로 문자셋·콜레이션만 받는다
function checkSchemaOptions(c: Cursor, verb: 'CREATE' | 'ALTER'): { charset?: string; collation?: string } {
  let charset: string | undefined;
  let collation: string | undefined;
  while (!c.done) {
    c.acceptWord('DEFAULT');
    if (c.acceptWord('CHARACTER', 'SET') || c.acceptWord('CHARSET')) charset = canonicalCharset(optionValue(c));
    else if (c.acceptWord('COLLATE')) collation = canonicalCollation(optionValue(c));
    else if (verb === 'CREATE' && c.acceptWord('ENCRYPTION')) optionValue(c);
    else if (verb === 'ALTER' && c.acceptWord('READ', 'ONLY')) optionValue(c);
    else if (verb === 'ALTER') fail(`ALTER SCHEMA·DATABASE 는 문자셋·콜레이션·READ ONLY 만 받습니다: ${c.peek()?.v ?? '(끝)'} — ${RE_EXPORT}`);
    else fail(`CREATE SCHEMA·DATABASE 의 옵션은 문자셋·콜레이션·ENCRYPTION 만 받습니다: ${c.peek()?.v ?? '(끝)'} — ${RE_EXPORT}`);
  }
  if (charset !== undefined && collation !== undefined && charsetOfCollation(collation) !== charset) fail(`COLLATE ${collation} 은 문자셋 ${charset} 의 콜레이션이 아닙니다 (MySQL 1253)`);
  return { charset, collation };
}
