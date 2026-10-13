// 사람이 쓴 컬럼·인덱스·FK 정의를 읽는다 (ALTER TABLE ADD·MODIFY·CHANGE, CREATE TABLE, CREATE INDEX).
// 백틱 없는 이름·소문자 키워드·컬럼 안 제약(PRIMARY KEY·UNIQUE·REFERENCES)을 받는다. 덤프용 parse-table 은 SHOW CREATE 형식만
// 읽으므로 따로 두고, 키 파트·인덱스 옵션·FK 본문은 그 파서를 그대로 쓴다
import type { Cursor } from '../cursor';
import type { Token } from '../lexer';
import type { ColumnFormat, ColumnStorage, Index, IndexKind } from '../model';
import { indexKind, parseForeignKey, parseIndex, refAction } from '../parse-table';
import { ER_INVALID_DEFAULT, ER_INVALID_ON_UPDATE, normalizeUserType } from './normalize-mysql';
import { fail, RE_EXPORT, type ColumnSpec, type ConstraintItem, type DefaultSpec, type NowSpec, type Position, type TableItem } from './types';

const OUT_OF_SCOPE = `은(는) 1차 지원 범위가 아닙니다 (MySQL 이 식을 다시 써서 저장합니다) — ${RE_EXPORT}`;
const TYPE_MODIFIERS: ReadonlySet<string> = new Set(['UNSIGNED', 'SIGNED', 'ZEROFILL', 'PRECISION', 'VARYING']);
const CONSTRAINT_START: ReadonlySet<string> = new Set(['PRIMARY', 'KEY', 'INDEX', 'UNIQUE', 'FULLTEXT', 'SPATIAL', 'CONSTRAINT', 'FOREIGN', 'CHECK']);
const NOW_WORDS: ReadonlySet<string> = new Set(['CURRENT_TIMESTAMP', 'NOW', 'LOCALTIME', 'LOCALTIMESTAMP']);
const INDEX_TYPES: ReadonlySet<string> = new Set(['BTREE', 'HASH', 'RTREE']);
const REFERENCES_LIST = 'REFERENCES 컬럼';
const FK_LISTS = ['FOREIGN KEY 컬럼', REFERENCES_LIST] as const;
const ER_UNKNOWN_CHARACTER_SET = 1115;
const ER_UNKNOWN_COLLATION = 1273;

// 컬럼 정의: 이름 타입 [속성…]. FIRST·AFTER 앞에서 멈춘다 (위치는 parsePosition)
export function parseColumnSpec(c: Cursor): ColumnSpec {
  const name = c.ident();
  const typeStart = c.next();
  let typeEnd = typeStart;
  for (;;) {
    if (c.isOp('(')) {
      c.next();
      typeEnd = c.closeParen();
      continue;
    }
    const t = c.peek();
    if (t?.t === 'word' && TYPE_MODIFIERS.has(t.v.toUpperCase())) {
      typeEnd = c.next();
      continue;
    }
    break;
  }
  const spec: ColumnSpec = { name, type: normalizeUserType(c.src.slice(typeStart.s, typeEnd.e)), autoIncrement: false, invisible: false, primaryKey: false, unique: false };
  while (!c.done && !c.isWord('FIRST') && !c.isWord('AFTER')) columnAttr(c, spec);
  return spec;
}

function columnAttr(c: Cursor, s: ColumnSpec): void {
  if (c.acceptWord('NOT', 'NULL')) s.nullable = false;
  else if (c.acceptWord('NULL')) s.nullable = true;
  else if (c.acceptWord('DEFAULT')) s.default = parseDefault(c);
  else if (c.acceptWord('ON', 'UPDATE')) s.onUpdate = nowSpec(c, ER_INVALID_ON_UPDATE) ?? fail('ON UPDATE 에는 CURRENT_TIMESTAMP 만 쓸 수 있습니다');
  else if (c.acceptWord('AUTO_INCREMENT')) s.autoIncrement = true;
  else if (c.acceptWord('PRIMARY', 'KEY') || c.acceptWord('KEY')) s.primaryKey = true;
  else if (c.acceptWord('UNIQUE')) {
    c.acceptWord('KEY');
    s.unique = true;
  } else if (c.acceptWord('COMMENT')) s.comment = c.string();
  else if (c.acceptWord('CHARACTER', 'SET') || c.acceptWord('CHARSET')) s.charset = wordName(c, '문자셋', ER_UNKNOWN_CHARACTER_SET);
  else if (c.acceptWord('COLLATE')) s.collation = wordName(c, '콜레이션', ER_UNKNOWN_COLLATION);
  else if (c.acceptWord('VISIBLE')) s.invisible = false;
  else if (c.acceptWord('INVISIBLE')) s.invisible = true;
  else if (c.acceptWord('SRID')) s.srid = sridValue(c);
  else if (c.acceptWord('STORAGE')) s.storage = oneOf(c, ['DISK', 'MEMORY']) as ColumnStorage;
  else if (c.acceptWord('COLUMN_FORMAT')) s.columnFormat = oneOf(c, ['FIXED', 'DYNAMIC', 'DEFAULT']) as ColumnFormat;
  else if (c.acceptWord('REFERENCES')) skipReferences(c); // MySQL 은 컬럼 안 REFERENCES 를 읽고 무시한다
  else if (c.isWord('CHECK')) fail(`CHECK 제약${OUT_OF_SCOPE}`);
  else if (c.isWord('GENERATED') || c.isWord('AS')) fail(`생성 컬럼${OUT_OF_SCOPE}`);
  else if (c.isWord('SERIAL')) fail(`SERIAL DEFAULT VALUE 는 1차 지원 범위가 아닙니다 — ${RE_EXPORT}`);
  else if (c.isWord('BINARY')) fail(`컬럼 속성 BINARY 는 1차 지원 범위가 아닙니다 (COLLATE …_bin 으로 쓰면 됩니다) — ${RE_EXPORT}`);
  else fail(`알 수 없는 컬럼 속성 '${c.peek()!.v}'`);
}

// 문자셋·콜레이션 이름: 식별자 외에 문자열('latin1')로 써도 MySQL 이 받는다 (MySQL Workbench 가 이렇게 쓴다).
// SHOW CREATE 에 따옴표 없이 찍는 값이라 \w+ 만 받는다 — 아니면 'utf8mb4_bin, DROP COLUMN b' 가 DDL 로 새어 나간다
function wordName(c: Cursor, what: string, errno: number): string {
  const name = c.peek()?.t === 'string' ? c.next().v : c.ident();
  return /^\w+$/.test(name) ? name : fail(`알 수 없는 ${what}입니다: ${name} (MySQL ${errno})`);
}

function sridValue(c: Cursor): number {
  const t = c.next();
  return t.t === 'number' && /^\d+$/.test(t.v) ? Number(t.v) : fail(`SRID 는 0 이상의 정수여야 합니다: ${t.v}`);
}

function oneOf(c: Cursor, values: readonly string[]): string {
  const v = c.next().v.toUpperCase();
  return values.includes(v) ? v : fail(`${values.join('|')} 가 필요합니다`);
}

function skipReferences(c: Cursor): void {
  c.ident();
  if (c.acceptOp('.')) c.ident();
  if (c.isOp('(')) checkList(c.parenTokens(), REFERENCES_LIST);
  for (;;) {
    if (c.acceptWord('MATCH')) c.next();
    else if (c.acceptWord('ON', 'DELETE') || c.acceptWord('ON', 'UPDATE')) refAction(c);
    else return;
  }
}

// 렉서는 '1.2.3' 처럼 숫자와 점이 이어진 것도 숫자 토큰 하나로 읽는다. MySQL 이 받는 10진 리터럴(12, 1.5, 1.)만 통과시킨다
const isDecimalLiteral = (v: string): boolean => /^\d+(?:\.\d*)?$/.test(v);

// DEFAULT 뒤의 값 (ALTER COLUMN … SET DEFAULT 도 쓴다)
export function parseDefault(c: Cursor): DefaultSpec {
  const t = c.next();
  if (t.t === 'op' && (t.v === '-' || t.v === '+')) {
    const n = c.next();
    if (n.t !== 'number' || !isDecimalLiteral(n.v)) return fail(`기본값으로 쓸 수 없는 값입니다: ${t.v}${n.v}`);
    return { kind: 'number', value: (t.v === '-' ? '-' : '') + n.v };
  }
  if (t.t === 'op' && t.v === '(') return fail(`식 기본값 DEFAULT (…)${OUT_OF_SCOPE}`);
  if (t.t === 'string') return { kind: 'string', value: t.v };
  if (t.t === 'number') {
    if (/^[bB]'/.test(t.v)) return { kind: 'bit', value: `b'${t.v.slice(2, -1)}'` };
    if (/^(0[xb]|[xX]')/.test(t.v)) return fail(`16진수 기본값은 1차 지원 범위가 아닙니다 — ${RE_EXPORT}`);
    if (!isDecimalLiteral(t.v)) return fail(`기본값으로 쓸 수 없는 값입니다: ${t.v}`);
    return { kind: 'number', value: t.v };
  }
  if (t.t === 'word') {
    const w = t.v.toUpperCase();
    if (w === 'NULL') return { kind: 'null' };
    if (w === 'TRUE' || w === 'FALSE') return { kind: 'number', value: w === 'TRUE' ? '1' : '0' };
    c.i--;
    const now = nowSpec(c, ER_INVALID_DEFAULT);
    if (now) return { kind: 'now', ...now };
  }
  return fail(`기본값으로 쓸 수 없는 값입니다: ${t.v} (1차 지원 범위: 리터럴, NULL, CURRENT_TIMESTAMP)`);
}

// CURRENT_TIMESTAMP[()|(n)], NOW([n]), LOCALTIME[()], LOCALTIMESTAMP[()]. 해당하지 않으면 소비하지 않고 undefined.
// errno: 자릿수가 6 을 넘을 때 MySQL 이 내는 번호 (DEFAULT 는 1067, ON UPDATE 는 1294 — 8.0.46 실측)
function nowSpec(c: Cursor, errno: number): NowSpec | undefined {
  const t = c.peek();
  if (t?.t !== 'word' || !NOW_WORDS.has(t.v.toUpperCase())) return undefined;
  c.next();
  if (!c.isOp('(')) return t.v.toUpperCase() === 'NOW' ? fail('NOW 뒤에 () 가 필요합니다') : {};
  const raw = c.parenRaw();
  if (raw === '' || raw === '0') return {};
  if (/^[1-6]$/.test(raw)) return { fsp: Number(raw) };
  return fail(`소수 초 자릿수는 0~6 이어야 합니다: ${raw}${/^\d+$/.test(raw) && Number(raw) > 6 ? ` (MySQL ${errno})` : ''}`);
}

export function parsePosition(c: Cursor): Position {
  if (c.acceptWord('FIRST')) return { first: true };
  if (c.acceptWord('AFTER')) return { after: c.ident() };
  return undefined;
}

export const startsConstraint = (c: Cursor): boolean => {
  const t = c.peek();
  return t?.t === 'word' && CONSTRAINT_START.has(t.v.toUpperCase());
};

// CREATE TABLE 괄호 안 항목 하나 (끝까지 소비한다)
export function parseTableItem(c: Cursor): TableItem {
  const item: TableItem = startsConstraint(c) ? parseConstraint(c) : { kind: 'column', spec: parseColumnSpec(c) };
  if (!c.done) fail(`정의 뒤에 알 수 없는 내용이 있습니다: ${c.peek()!.v}`);
  return item;
}

// 인덱스·제약 정의 (CREATE TABLE 항목, ALTER TABLE ADD 뒤)
export function parseConstraint(c: Cursor): ConstraintItem {
  let symbol: string | undefined;
  if (c.acceptWord('CONSTRAINT') && !['PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK'].some((w) => c.isWord(w))) symbol = c.ident();
  if (c.isWord('CHECK')) return fail(`CHECK 제약 추가${OUT_OF_SCOPE}`);
  if (c.acceptWord('PRIMARY', 'KEY')) return { kind: 'index', index: { ...parseIndexBody(c, 'PRIMARY'), name: 'PRIMARY' }, named: true };
  if (c.acceptWord('FOREIGN', 'KEY')) {
    const indexName = c.isOp('(') ? undefined : c.ident();
    topLevelLists(c).slice(0, FK_LISTS.length).forEach((inner, k) => checkList(inner, FK_LISTS[k]));
    return { kind: 'fk', fk: parseForeignKey(c, symbol ?? ''), ...(indexName !== undefined ? { indexName } : {}), named: symbol !== undefined };
  }
  const kind = indexKind(c) ?? fail(`알 수 없는 정의입니다: ${c.peek()?.v ?? '(끝)'}`);
  if (symbol !== undefined && kind !== 'UNIQUE') fail('CONSTRAINT 이름은 PRIMARY KEY·UNIQUE·FOREIGN KEY 에만 붙일 수 있습니다');
  const name = c.isOp('(') || c.isWord('USING') ? symbol : c.ident();
  return { kind: 'index', index: parseIndexBody(c, kind, name ?? ''), named: name !== undefined };
}

// [USING x] (키 파트) [옵션…]. PRIMARY KEY 뒤의 이름은 MySQL 이 무시한다. 함수 인덱스는 1차 범위 밖.
// 그대로 찍는 값(USING 의 인덱스 타입)은 화이트리스트로, 빈 목록·끝 쉼표·정수가 아닌 KEY_BLOCK_SIZE 는 MySQL 처럼 1064 로 거부한다
export function parseIndexBody(c: Cursor, kind: IndexKind, name = ''): Index {
  if (kind === 'PRIMARY' && !c.isOp('(') && !c.isWord('USING')) c.ident();
  const using = parseUsing(c);
  const keyParts = c.isOp('(') ? topLevelLists(c)[0] : undefined; // 닫히지 않았으면 undefined — parseIndex 가 ParseError 를 낸다
  if (keyParts) checkList(keyParts, '키 파트');
  const index = parseIndex(c, kind, name);
  if (index.using !== undefined && !INDEX_TYPES.has(index.using)) badIndexType(index.using); // 키 파트 뒤에 쓴 USING (parse-table 은 \w+ 만 본다)
  if (index.keyBlockSize !== undefined && !Number.isSafeInteger(index.keyBlockSize)) fail('KEY_BLOCK_SIZE 는 정수여야 합니다 (MySQL 1064)');
  if (index.parts.some((p) => p.expr !== undefined)) fail(`함수 인덱스${OUT_OF_SCOPE}`);
  return using && !index.using ? { ...index, using } : index;
}

const badIndexType = (value: string): never => fail(`인덱스 타입은 BTREE·HASH·RTREE 만 쓸 수 있습니다: ${value} (MySQL 1064)`);

// [USING x]: 있으면 소비해 인덱스 타입(대문자)을 돌려준다. 그대로 찍는 값이라 따옴표 없는 키워드만 받는다
// (MySQL 은 `BTREE`·'BTREE' 도 1064). CREATE INDEX 의 이름 뒤 USING 도 이 함수로 읽는다
export function parseUsing(c: Cursor): string | undefined {
  if (!c.acceptWord('USING')) return undefined;
  const t = c.next();
  return t.t === 'word' && INDEX_TYPES.has(t.v.toUpperCase()) ? t.v.toUpperCase() : badIndexType(t.v);
}

// c.i 부터 깊이 0 인 `( … )` 목록들의 안쪽 토큰 (소비하지 않는다)
function topLevelLists(c: Cursor): Token[][] {
  const lists: Token[][] = [];
  let depth = 0;
  let start = 0;
  for (let i = c.i; i < c.toks.length; i++) {
    const t = c.toks[i];
    if (t.t !== 'op') continue;
    if (t.v === '(') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (t.v === ')' && depth > 0 && --depth === 0) lists.push(c.toks.slice(start, i));
  }
  return lists;
}

// 키 파트·FK 컬럼 목록은 비어 있거나 쉼표로 끝나면 안 된다. splitTopLevel 이 끝 쉼표를 조용히 버려 `(a,)` 가 `(a)` 가 되고
// 빈 괄호는 항목 0개가 된다 — MySQL 은 둘 다 1064
function checkList(inner: readonly Token[], what: string): void {
  if (!inner.length) fail(`${what} 목록이 비었습니다 (MySQL 1064)`);
  const last = inner[inner.length - 1];
  if (last.t === 'op' && last.v === ',') fail(`${what} 목록이 쉼표로 끝납니다 (MySQL 1064)`);
}
