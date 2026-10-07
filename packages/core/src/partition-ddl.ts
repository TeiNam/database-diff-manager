// 파티션 변경 → 최소 DDL. 월별 RANGE 파티션 운영(앞쪽 DROP, MAXVALUE 앞 추가)을 우선 처리한다
import type { TableDiff } from './diff';
import { quoteIdent as q } from './lexer';
import type { PartitionDef, Partitioning } from './model';

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

export function partitionStatements(d: TableDiff): string[] {
  const p = d.partition;
  if (!p) return [];
  const table = q(d.name);
  if (!p.to) return [`ALTER TABLE ${table} REMOVE PARTITIONING`];
  if (!p.from || p.from.method !== p.to.method || p.from.expr !== p.to.expr || subpartitionKey(p.from) !== subpartitionKey(p.to)) {
    return [`ALTER TABLE ${table} ${p.to.clause}`];
  }
  if (!p.from.partitions.length && !p.to.partitions.length) {
    const delta = (p.to.count ?? 1) - (p.from.count ?? 1);
    if (delta > 0) return [`ALTER TABLE ${table} ADD PARTITION PARTITIONS ${delta}`];
    if (delta < 0) return [`ALTER TABLE ${table} COALESCE PARTITION ${-delta}`];
    return [];
  }
  return listPartitionStatements(table, p.from.partitions, p.to.partitions, p.to.method.startsWith('RANGE'));
}

export function listPartitionStatements(table: string, a: PartitionDef[], b: PartitionDef[], range = true): string[] {
  const out: string[] = [];
  const bNames = new Set(b.map((p) => p.name));
  // 1) 보관 기간 정리: TARGET이 기존 파티션으로 시작할 때만 앞쪽의 사라진 파티션을 DROP
  let lead = 0;
  if (b.length && a.some((p) => p.name === b[0].name)) while (lead < a.length && !bNames.has(a[lead].name)) lead++;
  if (lead) out.push(`ALTER TABLE ${table} DROP PARTITION ${names(a.slice(0, lead))}`);
  // 2) 공통 앞·뒤를 제외한 가운데 구간만 재구성
  const rest = a.slice(lead);
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
  if (!from.length && to.length && suf === 0) out.push(`ALTER TABLE ${table} ADD PARTITION (\n${to.map(printPart).join(',\n')})`);
  else if (from.length && !to.length) out.push(`ALTER TABLE ${table} DROP PARTITION ${names(from)}`);
  else if (to.length) {
    if (!from.length) {
      // MAXVALUE 같은 뒤쪽 파티션 앞에 끼워 넣기: 뒤쪽 첫 파티션을 쪼갠다
      from = [rest[rest.length - suf]];
      to = [...to, b[b.length - suf]];
    }
    out.push(`ALTER TABLE ${table} REORGANIZE PARTITION ${names(from)} INTO (\n${to.map(printPart).join(',\n')})`);
  }
  // 3) COMMENT만 바뀐 파티션
  const commentOnly = b.filter((y) => {
    const x = a.find((p) => p.name === y.name);
    return x !== undefined && x.def !== y.def && stripComment(x.def) === stripComment(y.def);
  });
  if (commentOnly.length) {
    out.push(`-- 파티션 COMMENT 변경(${commentOnly.map((p) => p.name).join(', ')}): MySQL은 COMMENT만 바꾸는 DDL이 없습니다. 필요하면 REORGANIZE PARTITION으로 재정의하세요`);
  }
  return out;
}
