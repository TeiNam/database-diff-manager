// SHOW CREATE TABLE 출력 → Table 모델
import { Cursor, splitTopLevel } from './cursor';
import { quoteIdent, quoteString, tokenize, type Token } from './lexer';
import type { Check, Column, ColumnFormat, ColumnStorage, ForeignKey, Index, IndexKind, IndexPart, PartitionDef, Partitioning, Table } from './model';
import { normalizeType } from './normalize';
import { assertDataType, assertExpression, assertOnUpdate, assertWord, UnsafeValueError } from './sql-safety';

// 컬럼 타입이 끝나고 속성이 시작됨을 알리는 단어
const COLUMN_ATTRS = new Set([
  'CHARACTER', 'CHARSET', 'COLLATE', 'GENERATED', 'AS', 'NOT', 'NULL', 'DEFAULT', 'ON', 'AUTO_INCREMENT',
  'COMMENT', 'INVISIBLE', 'VISIBLE', 'SRID', 'COLUMN_FORMAT', 'STORAGE', 'VIRTUAL', 'STORED',
  'PRIMARY', 'UNIQUE', 'KEY', 'CHECK', 'REFERENCES',
]);

export const REF_ACTIONS = [['SET', 'NULL'], ['SET', 'DEFAULT'], ['NO', 'ACTION'], ['CASCADE'], ['RESTRICT']];
// 따옴표 없이 찍는 식별자형 테이블 옵션 값 (\w+ 만 허용). 그 밖의 문자열 값은 문자열로 다시 인용한다
const WORD_OPTIONS = new Set(['ENGINE', 'DEFAULT CHARSET', 'CHARSET', 'DEFAULT CHARACTER SET', 'CHARACTER SET', 'COLLATE', 'DEFAULT COLLATE', 'ROW_FORMAT', 'INSERT_METHOD', 'SECONDARY_ENGINE']);

export function parseCreateTable(ddl: string): Table {
  const toks = tokenize(ddl);
  const last = toks.at(-1);
  if (last?.t === 'op' && last.v === ';') toks.pop();
  const c = new Cursor(toks, ddl);
  c.expectWord('CREATE');
  c.acceptWord('TEMPORARY');
  c.expectWord('TABLE');
  c.acceptWord('IF', 'NOT', 'EXISTS');
  const table: Table = {
    kind: 'table', name: c.ident(), columns: [], indexes: [], foreignKeys: [], checks: [], options: [], fidelity: 'full',
  };
  try {
    for (const item of splitTopLevel(c.parenTokens())) parseItem(new Cursor(item, ddl), table);
    parseTail(c, table);
  } catch (e) {
    if (e instanceof UnsafeValueError) throw c.error(e.message);
    throw e;
  }
  return table;
}

function parseItem(c: Cursor, t: Table): void {
  if (c.peek()?.t === 'ident') { t.columns.push(parseColumn(c)); return; }
  if (c.acceptWord('PRIMARY', 'KEY')) { t.indexes.push(parseIndex(c, 'PRIMARY', 'PRIMARY')); return; }
  const kind = indexKind(c);
  if (kind) { t.indexes.push(parseIndex(c, kind, c.ident())); return; }
  if (c.acceptWord('CONSTRAINT')) {
    const name = c.ident();
    if (c.acceptWord('FOREIGN', 'KEY')) { t.foreignKeys.push(parseForeignKey(c, name)); return; }
    if (c.acceptWord('CHECK')) { t.checks.push(parseCheck(c, name)); return; }
  }
  throw c.error('알 수 없는 테이블 요소');
}

function parseColumn(c: Cursor): Column {
  const name = c.ident();
  const typeStart = c.peek();
  if (!typeStart) throw c.error('컬럼 타입 필요');
  let typeEnd = typeStart;
  while (!c.done) {
    const t = c.peek()!;
    if (t.t === 'word' && COLUMN_ATTRS.has(t.v.toUpperCase())) break;
    if (t.t === 'op' && t.v === '(') { c.next(); typeEnd = c.closeParen(); continue; }
    typeEnd = c.next();
  }
  const col: Column = {
    name, type: normalizeType(assertDataType(c.src.slice(typeStart.s, typeEnd.e))), nullable: true, invisible: false, autoIncrement: false,
  };
  while (!c.done) parseColumnAttr(c, col);
  return col;
}

function parseColumnAttr(c: Cursor, col: Column): void {
  if (c.acceptWord('CHARACTER', 'SET') || c.acceptWord('CHARSET')) col.charset = assertWord(c.next().v, 'CHARACTER SET');
  else if (c.acceptWord('COLLATE')) col.collation = assertWord(c.next().v, 'COLLATE');
  else if (c.acceptWord('GENERATED', 'ALWAYS', 'AS') || c.acceptWord('AS')) {
    const expr = assertExpression(c.parenRaw(), '생성 컬럼 식');
    const stored = c.acceptWord('STORED');
    if (!stored) c.acceptWord('VIRTUAL');
    col.generated = { expr, stored };
  } else if (c.acceptWord('NOT', 'NULL')) col.nullable = false;
  else if (c.acceptWord('NULL')) col.nullable = true;
  else if (c.acceptWord('SRID')) col.srid = Number(c.next().v);
  else if (c.acceptWord('STORAGE')) col.storage = oneOf(c, STORAGES);
  else if (c.acceptWord('COLUMN_FORMAT')) col.columnFormat = oneOf(c, COLUMN_FORMATS);
  else if (c.acceptWord('INVISIBLE')) col.invisible = true;
  else if (c.acceptWord('VISIBLE')) col.invisible = false;
  else if (c.acceptWord('DEFAULT')) col.default = assertExpression(c.valueRaw(), 'DEFAULT');
  else if (c.acceptWord('ON', 'UPDATE')) col.onUpdate = assertOnUpdate(c.valueRaw());
  else if (c.acceptWord('AUTO_INCREMENT')) col.autoIncrement = true;
  else if (c.acceptWord('COMMENT')) col.comment = c.string();
  else throw c.error(`알 수 없는 컬럼 속성 '${c.peek()!.v}'`);
}

const STORAGES: readonly ColumnStorage[] = ['DISK', 'MEMORY'];
const COLUMN_FORMATS: readonly ColumnFormat[] = ['FIXED', 'DYNAMIC', 'DEFAULT'];

function oneOf<T extends string>(c: Cursor, values: readonly T[]): T {
  const t = c.next();
  const v = t.v.toUpperCase() as T;
  if (t.t !== 'word' || !values.includes(v)) throw c.error(`${values.join('|')} 필요`, t);
  return v;
}

export function indexKind(c: Cursor): IndexKind | undefined {
  if (c.acceptWord('KEY') || c.acceptWord('INDEX')) return 'INDEX';
  for (const kind of ['UNIQUE', 'FULLTEXT', 'SPATIAL'] as const) {
    if (c.acceptWord(kind)) {
      if (!c.acceptWord('KEY')) c.acceptWord('INDEX');
      return kind;
    }
  }
  return undefined;
}

export function parseIndex(c: Cursor, kind: IndexKind, name: string): Index {
  const index: Index = { name, kind, parts: parseIndexParts(c), invisible: false };
  while (!c.done) {
    if (c.acceptWord('USING')) index.using = assertWord(c.next().v, 'USING').toUpperCase();
    else if (c.acceptWord('KEY_BLOCK_SIZE')) {
      c.acceptOp('=');
      index.keyBlockSize = Number(c.next().v);
    }
    else if (c.acceptWord('WITH', 'PARSER')) index.parser = c.ident();
    else if (c.acceptWord('COMMENT')) index.comment = c.string();
    else if (c.acceptWord('INVISIBLE')) index.invisible = true;
    else if (c.acceptWord('VISIBLE')) index.invisible = false;
    else throw c.error(`알 수 없는 인덱스 옵션 '${c.peek()!.v}'`);
  }
  return index;
}

function parseIndexParts(c: Cursor): IndexPart[] {
  return splitTopLevel(c.parenTokens()).map((toks) => {
    const p = new Cursor(toks, c.src);
    const part: IndexPart = { desc: false };
    if (p.isOp('(')) part.expr = assertExpression(p.parenRaw(), '인덱스 식');
    else {
      part.column = p.ident();
      if (p.isOp('(')) part.length = prefixLength(p);
    }
    if (p.acceptWord('DESC')) part.desc = true;
    else p.acceptWord('ASC');
    if (!p.done) throw p.error('알 수 없는 키 파트');
    return part;
  });
}

function prefixLength(c: Cursor): number {
  const raw = c.parenRaw();
  if (!/^\d+$/.test(raw)) throw c.error(`키 파트 길이가 정수가 아닙니다: ${raw}`);
  return Number(raw);
}

function identList(c: Cursor): string[] {
  return splitTopLevel(c.parenTokens()).map((toks) => {
    if (toks.length !== 1) throw c.error('식별자 목록 필요', toks[0]);
    return toks[0].v;
  });
}

export function parseForeignKey(c: Cursor, name: string): ForeignKey {
  const columns = identList(c);
  c.expectWord('REFERENCES');
  let refTable = c.ident();
  let refSchema: string | undefined;
  if (c.acceptOp('.')) { refSchema = refTable; refTable = c.ident(); }
  const fk: ForeignKey = { name, columns, refTable, refColumns: identList(c) };
  if (refSchema) fk.refSchema = refSchema;
  while (!c.done) {
    if (c.acceptWord('ON', 'DELETE')) fk.onDelete = refAction(c);
    else if (c.acceptWord('ON', 'UPDATE')) fk.onUpdate = refAction(c);
    else throw c.error('알 수 없는 FK 옵션');
  }
  return fk;
}

export function refAction(c: Cursor): string {
  for (const words of REF_ACTIONS) if (c.acceptWord(...words)) return words.join(' ');
  throw c.error('참조 동작 필요');
}

function parseCheck(c: Cursor, name: string): Check {
  const expr = assertExpression(c.parenRaw(), 'CHECK 식');
  const enforced = !c.acceptWord('NOT', 'ENFORCED');
  c.acceptWord('ENFORCED');
  if (!c.done) throw c.error('알 수 없는 CHECK 옵션');
  return { name, expr, enforced };
}

// ')' 뒤: 테이블 옵션과 파티션 절
function parseTail(c: Cursor, t: Table): void {
  while (!c.done && !c.isWord('PARTITION', 'BY')) {
    const key: string[] = [];
    while (c.peek()?.t === 'word' && !c.isWord('PARTITION', 'BY')) key.push(c.next().v.toUpperCase());
    if (!key.length) throw c.error('테이블 옵션 필요');
    c.acceptOp('='); // TABLESPACE `x` 처럼 '=' 없는 형식 허용
    const value = optionValue(c, key.join(' '));
    if (key.join(' ') !== 'AUTO_INCREMENT') t.options.push({ key: key.join(' '), value });
  }
  if (!c.done) t.partition = parsePartition(c);
}

// 테이블 옵션 값: 식별자형(엔진·문자셋·콜레이션·행 형식)은 \w+ 만, 문자열은 다시 인용, 백틱 이름은 다시 인용, 단어·숫자는 그대로,
// 그 밖(괄호 목록 등)은 식 규칙으로 검사한다
function optionValue(c: Cursor, key: string): string {
  const first: Token = c.peek()!;
  const raw = c.valueRaw();
  const isSingle = raw.length === first.e - first.s;
  if (WORD_OPTIONS.has(key)) return assertWord(isSingle && (first.t === 'string' || first.t === 'ident') ? first.v : raw, key);
  if (!isSingle) return assertExpression(raw, key);
  if (first.t === 'string') return quoteString(first.v);
  if (first.t === 'ident') return quoteIdent(first.v);
  if (first.t === 'word') return assertWord(raw, key);
  if (first.t === 'number') return raw;
  throw c.error(`알 수 없는 테이블 옵션 값 '${raw}'`, first);
}

function parsePartition(c: Cursor): Partitioning {
  const first = c.peek()!;
  const last = c.toks[c.toks.length - 1];
  const version = /\/\*!(\d+)\s*$/.exec(c.src.slice(0, first.s))?.[1] ?? '50100';
  c.expectWord('PARTITION', 'BY');
  const method: string[] = [];
  while (!c.done && !c.isOp('(')) method.push(c.next().v.toUpperCase());
  const p: Partitioning = {
    version, clause: c.src.slice(first.s, last.e), method: method.join(' '), expr: c.parenRaw(), partitions: [],
  };
  if (c.acceptWord('PARTITIONS')) p.count = Number(c.next().v);
  while (!c.done) {
    if (c.isOp('(') && c.peek(1)?.t === 'word' && c.peek(1)!.v.toUpperCase() === 'PARTITION') p.partitions = parsePartitionList(c);
    else if (c.isOp('(')) c.parenTokens(); // SUBPARTITION BY … (expr) 는 clause에만 보존
    else c.next();
  }
  return p;
}

function parsePartitionList(c: Cursor): PartitionDef[] {
  return splitTopLevel(c.parenTokens()).map((toks) => {
    const pc = new Cursor(toks, c.src);
    pc.expectWord('PARTITION');
    const name = pc.ident();
    const rest = pc.peek();
    return { name, def: rest ? c.src.slice(rest.s, toks[toks.length - 1].e) : '' };
  });
}
