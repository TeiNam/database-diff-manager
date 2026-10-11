// 파티션 변경 → 최소 DDL. 월별 RANGE 파티션 운영(앞쪽 DROP, MAXVALUE 앞 추가)을 우선 처리한다
import type { TableDiff } from './diff';
import { commentLine, commentLines } from './comment-text';
import { quoteIdent as q } from './lexer';
import type { PartitionDef, Partitioning } from './model';
import { compareBounds, isAllMax, parenValues, upperBound } from './partition-values';

const COMMENT_RE = /\s*COMMENT\s*=?\s*'(?:[^']|'')*'/i;
const stripComment = (def: string) => def.replace(COMMENT_RE, '');
const sameStructure = (a: PartitionDef, b: PartitionDef) => a.name === b.name && stripComment(a.def) === stripComment(b.def);
const printPart = (p: PartitionDef) => ` PARTITION ${q(p.name)} ${p.def}`;
const names = (ps: PartitionDef[]) => ps.map((p) => q(p.name)).join(', ');
const SUBPARTITION_RE = /\bSUBPARTITION\s+BY\b[\s\S]*?(?=\(\s*PARTITION\b|$)/i;

// 'SUBPARTITION BY … [SUBPARTITIONS n]' 부분(공백 정규화). 서브파티션이 없으면 undefined
export function subpartitionKey(p: Partitioning): string | undefined {
  return SUBPARTITION_RE.exec(p.clause)?.[0].replace(/\s+/g, ' ').trim();
}

// sql 이 '--' 로 시작하면 실행할 SQL 이 없는 안내 문장이다 (commentLine 으로 만든다). notes 는 문장 위에 붙는 안내
export interface PartitionStatement {
  sql: string;
  notes?: string[];
}

const lossNote = (ps: PartitionDef[]) => `[데이터 확인] ${ps.map((p) => p.name).join(', ')}: 파티션을 삭제하면 그 안의 행도 함께 삭제됩니다`;
const retentionNote = (ps: PartitionDef[]) => `[데이터 확인] ${ps.map((p) => p.name).join(', ')}: 보관 기간 정리로 앞쪽 파티션을 삭제하면 그 안의 행도 함께 삭제됩니다`;
// MySQL 은 LIST REORGANIZE 에서 새 파티션에 없는 값의 행을 오류 없이 지운다
const vanishNote = (values: string[]) => `[데이터 확인] 값 ${values.join(', ')}: TARGET 파티션에 없어 REORGANIZE 하면 그 값의 행이 삭제됩니다`;
const HASH_METHOD_RE = /^(LINEAR\s+)?(HASH|KEY)\b/;

// 'VALUES IN (…)' 의 값 목록 (따옴표 밖 공백 제거). 읽을 수 없으면 undefined
export const listValues = (def: string): string[] | undefined => parenValues(def, /^\s*VALUES\s+IN\s*\(/i);

export const partitionStatements = (d: TableDiff): string[] => partitionBodies(d).map((s) => s.sql);
export const listPartitionStatements = (table: string, a: PartitionDef[], b: PartitionDef[], range = true): string[] =>
  listPartitionBodies(table, a, b, range).map((s) => s.sql);

// 파티션을 통째로 없애거나 다시 정하는 절 (REMOVE PARTITIONING · PARTITION BY …). 파티션 단위 변경이면 undefined
export function partitionRedefinition(d: TableDiff): string | undefined {
  const p = d.partition;
  if (!p) return undefined;
  if (!p.to) return 'REMOVE PARTITIONING';
  const isSame = p.from && p.from.method === p.to.method && p.from.expr === p.to.expr && subpartitionKey(p.from) === subpartitionKey(p.to);
  return isSame ? undefined : p.to.clause;
}

export function partitionBodies(d: TableDiff): PartitionStatement[] {
  const p = d.partition;
  if (!p) return [];
  const table = q(d.name);
  const redefinition = partitionRedefinition(d);
  if (redefinition !== undefined || !p.from || !p.to) return [{ sql: `ALTER TABLE ${table} ${redefinition}` }];
  if (HASH_METHOD_RE.test(p.to.method)) return hashBodies(table, p.from, p.to);
  return listPartitionBodies(table, p.from.partitions, p.to.partitions, p.to.method.startsWith('RANGE'));
}

// HASH/KEY 는 DROP PARTITION 이 없다. 뒤쪽 감소는 COALESCE, 뒤쪽 증가는 ADD, 그 밖(이름·정의 변경)은 전체 재정의
function hashBodies(table: string, from: Partitioning, to: Partitioning): PartitionStatement[] {
  const a = from.partitions;
  const b = to.partitions;
  if (!a.length && !b.length) {
    const delta = (to.count ?? 1) - (from.count ?? 1);
    if (delta > 0) return [{ sql: `ALTER TABLE ${table} ADD PARTITION PARTITIONS ${delta}` }];
    if (delta < 0) return [{ sql: `ALTER TABLE ${table} COALESCE PARTITION ${-delta}` }];
    return [];
  }
  const isPrefix = (short: PartitionDef[], long: PartitionDef[]) => short.length > 0 && short.every((x, i) => sameStructure(x, long[i]));
  const note = commentNote(a, b);
  const notes = note ? [{ sql: note }] : [];
  if (a.length === b.length && isPrefix(a, b)) return notes;
  if (b.length < a.length && isPrefix(b, a)) return [{ sql: `ALTER TABLE ${table} COALESCE PARTITION ${a.length - b.length}` }, ...notes];
  if (a.length < b.length && isPrefix(a, b)) return [{ sql: `ALTER TABLE ${table} ADD PARTITION (\n${b.slice(a.length).map(printPart).join(',\n')})` }, ...notes];
  return [{ sql: `ALTER TABLE ${table} ${to.clause}` }];
}

// COMMENT 만 바뀐 파티션 안내 (없으면 undefined)
function commentNote(a: PartitionDef[], b: PartitionDef[]): string | undefined {
  const commentOnly = b.filter((y) => {
    const x = a.find((p) => p.name === y.name);
    return x !== undefined && x.def !== y.def && stripComment(x.def) === stripComment(y.def);
  });
  if (!commentOnly.length) return undefined;
  return commentLine(`파티션 COMMENT 변경(${commentOnly.map((p) => p.name).join(', ')}): MySQL은 COMMENT만 바꾸는 DDL이 없습니다. 필요하면 REORGANIZE PARTITION으로 재정의하세요`);
}

export function listPartitionBodies(table: string, a: PartitionDef[], b: PartitionDef[], range = true): PartitionStatement[] {
  const out: PartitionStatement[] = [];
  const push = (sql: string, notes?: string[]) => out.push(notes ? { sql, notes } : { sql });
  const bNames = new Set(b.map((p) => p.name));
  const targetValues = range ? undefined : allValues(b);
  // LIST 는 값이 TARGET 어딘가에 남는 파티션을 DROP 하면 그 행이 사라지므로 REORGANIZE 로 넘긴다
  const isGone = (p: PartitionDef) => {
    const values = listValues(p.def);
    return values !== undefined && targetValues !== undefined && values.every((v) => !targetValues.has(v));
  };
  // 1) RANGE 보관 기간 정리: TARGET이 기존 파티션으로 시작할 때만 앞쪽의 사라진 파티션을 DROP.
  //    LIST 는 위치와 상관없이 값이 TARGET 어디에도 없는 사라진 파티션만 DROP 한다
  const gone = range ? leadingGone(a, b, bNames) : a.filter((p) => !bNames.has(p.name) && isGone(p));
  if (gone.length) push(`ALTER TABLE ${table} DROP PARTITION ${names(gone)}`, [range ? retentionNote(gone) : lossNote(gone)]);
  // 2) 공통 앞·뒤를 제외한 가운데 구간만 재구성
  const rest = a.filter((p) => !gone.includes(p));
  let pre = 0;
  while (pre < rest.length && pre < b.length && sameStructure(rest[pre], b[pre])) pre++;
  let suf = 0;
  while (suf < rest.length - pre && suf < b.length - pre && sameStructure(rest[rest.length - 1 - suf], b[b.length - 1 - suf])) suf++;
  let from = rest.slice(pre, rest.length - suf);
  let to = b.slice(pre, b.length - suf);
  // RANGE는 재구성 그룹의 전체 범위가 같아야 하므로, 끝 경계가 다르면 뒤쪽 파티션을 함께 묶는다
  if (range && from.length && to.length) {
    const last = (ps: PartitionDef[]) => stripComment(ps[ps.length - 1].def);
    while (suf > 0 && last(from) !== last(to)) {
      from = [...from, rest[rest.length - suf]];
      to = [...to, b[b.length - suf]];
      suf--;
    }
  }
  if (!from.length && to.length && suf === 0) push(`ALTER TABLE ${table} ADD PARTITION (\n${to.map(printPart).join(',\n')})`);
  else if (from.length && !to.length && range && suf > 0) {
    // RANGE 중간 삭제: 다음 파티션과 합쳐 다음 파티션 정의로 재구성하면 지운 구간의 행이 다음 파티션으로 옮겨진다
    const next = b[b.length - suf];
    push(`ALTER TABLE ${table} REORGANIZE PARTITION ${names([...from, rest[rest.length - suf]])} INTO (\n${printPart(next)})`);
  } else if (from.length && !to.length) push(`ALTER TABLE ${table} DROP PARTITION ${names(from)}`, [lossNote(from)]);
  else if (to.length) {
    if (!from.length) {
      // MAXVALUE 같은 뒤쪽 파티션 앞에 끼워 넣기: 뒤쪽 첫 파티션을 쪼갠다
      from = [rest[rest.length - suf]];
      to = [...to, b[b.length - suf]];
    }
    const vanished = range ? [] : vanishedValues(from, to);
    const sql = `ALTER TABLE ${table} REORGANIZE PARTITION ${names(from)} INTO (\n${to.map(printPart).join(',\n')})`;
    // 마지막 파티션 재구성은 범위를 늘릴 수만 있다 (줄이면 error 1520 ER_REORG_OUTSIDE_RANGE)
    if (range && suf === 0 && shrinksUpperBound(from[from.length - 1], to[to.length - 1])) push(shrinkManual(table, sql));
    else push(sql, vanished.length ? [vanishNote(vanished)] : undefined);
  }
  // 3) COMMENT만 바뀐 파티션
  const note = commentNote(a, b);
  if (note) push(note);
  return out;
}

// 마지막 파티션 상한이 줄거나, 줄지 않는다고 확신할 수 없으면 true. 새 상한이 MAXVALUE 면 줄지 않고, 같은 종류(정수·날짜·
// 문자열·단조 함수('리터럴')·튜플)로 비교할 수 있으면 비교한다. 비교할 수 없으면 정의가 그대로일 때만 false
function shrinksUpperBound(from: PartitionDef, to: PartitionDef): boolean {
  const a = upperBound(stripComment(from.def));
  const b = upperBound(stripComment(to.def));
  if (b && isAllMax(b)) return false;
  const order = a && b ? compareBounds(b, a) : undefined;
  return order === undefined ? stripComment(from.def) !== stripComment(to.def) : order < 0;
}

const shrinkManual = (table: string, sql: string): string => [
  commentLine(`[수동 확인 필요] ${table}: RANGE 마지막 파티션 상한이 줄거나 비교할 수 없어 REORGANIZE 할 수 없습니다 (error 1520). 새 상한을 넘는 행을 옮기거나 지운 뒤 직접 작성하세요`),
  commentLines(sql),
].join('\n');

function leadingGone(a: PartitionDef[], b: PartitionDef[], bNames: ReadonlySet<string>): PartitionDef[] {
  if (!b.length || !a.some((p) => p.name === b[0].name)) return [];
  let lead = 0;
  while (lead < a.length && !bNames.has(a[lead].name)) lead++;
  return a.slice(0, lead);
}

// 파티션들의 LIST 값 전체. 하나라도 읽을 수 없으면 undefined
function allValues(ps: PartitionDef[]): Set<string> | undefined {
  const out = new Set<string>();
  for (const p of ps) {
    const values = listValues(p.def);
    if (!values) return undefined;
    for (const v of values) out.add(v);
  }
  return out;
}

// 재구성 전 파티션에 있었지만 새 파티션에는 없는 LIST 값
function vanishedValues(from: PartitionDef[], to: PartitionDef[]): string[] {
  const before = allValues(from);
  const after = allValues(to);
  return before && after ? [...before].filter((v) => !after.has(v)) : [];
}
