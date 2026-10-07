// 두 SQL 텍스트를 GitHub 스타일 diff 행으로 바꾼다 (Split 기준, Unified는 여기서 파생)
import { diffArrays, diffLines } from 'diff';

export interface Segment {
  text: string;
  changed: boolean;
}

export interface Side {
  no: number;
  segments: Segment[];
}

export type RowKind = 'same' | 'change' | 'add' | 'del';

export interface SplitRow {
  kind: RowKind;
  left?: Side;
  right?: Side;
}

export interface Block {
  type: 'hunk' | 'fold';
  rows: SplitRow[];
}

export interface UnifiedLine {
  kind: 'same' | 'add' | 'del';
  oldNo?: number;
  newNo?: number;
  segments: Segment[];
}

const WHITESPACE = /(\s+)/;

const plain = (no: number, text: string): Side => ({ no, segments: [{ text, changed: false }] });

function lines(value: string): string[] {
  const out = value.split('\n');
  if (out.at(-1) === '') out.pop();
  return out;
}

function wordSegments(left: string, right: string): [Segment[], Segment[]] {
  const l: Segment[] = [];
  const r: Segment[] = [];
  // 공백 기준 토큰 단위로 비교한다 (jsdiff 단어 토크나이저는 'varchar(20)'을 괄호에서 쪼갠다)
  for (const part of diffArrays(left.split(WHITESPACE), right.split(WHITESPACE))) {
    const text = part.value.join('');
    if (!part.added) l.push({ text, changed: !!part.removed });
    if (!part.removed) r.push({ text, changed: !!part.added });
  }
  return [l, r];
}

export function buildRows(a: string, b: string): SplitRow[] {
  const rows: SplitRow[] = [];
  let ln = 1;
  let rn = 1;
  const parts = diffLines(a.endsWith('\n') || !a ? a : `${a}\n`, b.endsWith('\n') || !b ? b : `${b}\n`);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      for (const t of lines(part.value)) rows.push({ kind: 'same', left: plain(ln++, t), right: plain(rn++, t) });
      continue;
    }
    const removed = part.removed ? lines(part.value) : [];
    const addedPart = part.removed && parts[i + 1]?.added ? parts[++i] : part.added ? part : undefined;
    const added = addedPart ? lines(addedPart.value) : [];
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      const l = removed[k];
      const r = added[k];
      if (l !== undefined && r !== undefined) {
        const [ls, rs] = wordSegments(l, r);
        rows.push({ kind: 'change', left: { no: ln++, segments: ls }, right: { no: rn++, segments: rs } });
      } else if (l !== undefined) rows.push({ kind: 'del', left: plain(ln++, l) });
      else rows.push({ kind: 'add', right: plain(rn++, r!) });
    }
  }
  return rows;
}

// 변경 줄 앞뒤 context 줄은 hunk로 남기고, 나머지 같은 줄은 fold(접기)로 묶는다
export function toBlocks(rows: SplitRow[], context = 3): Block[] {
  const keep = rows.map(() => false);
  rows.forEach((row, i) => {
    if (row.kind === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
  });
  const blocks: Block[] = [];
  rows.forEach((row, i) => {
    const type = keep[i] ? 'hunk' : 'fold';
    const last = blocks.at(-1);
    if (last?.type === type) last.rows.push(row);
    else blocks.push({ type, rows: [row] });
  });
  return blocks;
}

export function hunkHeader(rows: SplitRow[]): string {
  const left = rows.flatMap((r) => (r.left ? [r.left.no] : []));
  const right = rows.flatMap((r) => (r.right ? [r.right.no] : []));
  return `@@ -${left[0] ?? 0},${left.length} +${right[0] ?? 0},${right.length} @@`;
}

export function countChanges(rows: SplitRow[]): { added: number; removed: number } {
  return {
    added: rows.filter((r) => r.kind === 'add' || r.kind === 'change').length,
    removed: rows.filter((r) => r.kind === 'del' || r.kind === 'change').length,
  };
}

// 연속된 변경 구간에서 삭제 줄을 모두 먼저, 추가 줄을 나중에 둔다 (GitHub Unified)
export function toUnified(rows: SplitRow[]): UnifiedLine[] {
  const out: UnifiedLine[] = [];
  let dels: UnifiedLine[] = [];
  let adds: UnifiedLine[] = [];
  const flush = () => {
    out.push(...dels, ...adds);
    dels = [];
    adds = [];
  };
  for (const row of rows) {
    if (row.kind === 'same') {
      flush();
      out.push({ kind: 'same', oldNo: row.left!.no, newNo: row.right!.no, segments: row.left!.segments });
      continue;
    }
    if (row.left) dels.push({ kind: 'del', oldNo: row.left.no, segments: row.left.segments });
    if (row.right) adds.push({ kind: 'add', newNo: row.right.no, segments: row.right.segments });
  }
  flush();
  return out;
}
