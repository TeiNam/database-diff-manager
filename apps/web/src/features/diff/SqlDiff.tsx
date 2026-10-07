import { Fragment, useMemo, useState } from 'react';
import { buildRows, hunkHeader, toBlocks, toUnified, type Segment, type SplitRow } from '../../lib/hunks';
import s from './SqlDiff.module.css';

const SIGN = { same: '', del: '−', add: '+', change: '' } as const;

function Text({ segments, tone }: { segments: Segment[]; tone: 'add' | 'del' | 'same' }) {
  return (
    <>
      {segments.map((seg, i) => (
        <span key={i} className={seg.changed ? (tone === 'add' ? 'wordAdd' : 'wordDel') : undefined}>{seg.text}</span>
      ))}
    </>
  );
}

function SplitRowView({ row }: { row: SplitRow }) {
  const leftTone = row.kind === 'change' || row.kind === 'del' ? 'del' : 'same';
  const rightTone = row.kind === 'change' || row.kind === 'add' ? 'add' : 'same';
  return (
    <tr>
      <td className={`${s.no} ${s[leftTone]} ${row.left ? '' : s.empty}`}>{row.left?.no}</td>
      <td className={`${s.sign} ${s[leftTone]} ${row.left ? '' : s.empty}`}>{row.left && leftTone === 'del' ? SIGN.del : ''}</td>
      <td className={`${s.code} ${s[leftTone]} ${row.left ? '' : s.empty} ${s.divider}`}>{row.left && <Text segments={row.left.segments} tone={leftTone} />}</td>
      <td className={`${s.no} ${s[rightTone]} ${row.right ? '' : s.empty}`}>{row.right?.no}</td>
      <td className={`${s.sign} ${s[rightTone]} ${row.right ? '' : s.empty}`}>{row.right && rightTone === 'add' ? SIGN.add : ''}</td>
      <td className={`${s.code} ${s[rightTone]} ${row.right ? '' : s.empty}`}>{row.right && <Text segments={row.right.segments} tone={rightTone} />}</td>
    </tr>
  );
}

function UnifiedRows({ rows }: { rows: SplitRow[] }) {
  return (
    <>
      {toUnified(rows).map((l, i) => (
        <tr key={i}>
          <td className={`${s.no} ${s[l.kind]}`}>{l.oldNo}</td>
          <td className={`${s.no} ${s[l.kind]}`}>{l.newNo}</td>
          <td className={`${s.sign} ${s[l.kind]}`}>{SIGN[l.kind]}</td>
          <td className={`${s.code} ${s[l.kind]}`} colSpan={3}><Text segments={l.segments} tone={l.kind} /></td>
        </tr>
      ))}
    </>
  );
}

// GitHub "Files changed" 형식: hunk 헤더, 양쪽 줄 번호, 단어 강조, 동일 구간 접기
export function SqlDiff({ base, target, layout, expanded = false, rows }: { base: string; target: string; layout: 'split' | 'unified'; expanded?: boolean; rows?: SplitRow[] }) {
  // rows 가 주어지면(카드가 이미 계산한 값) 다시 계산하지 않는다
  const blocks = useMemo(() => toBlocks(rows ?? buildRows(base, target)), [rows, base, target]);
  const [opened, setOpened] = useState<Set<number>>(new Set());
  const open = (i: number) => setOpened((prev) => new Set(prev).add(i));
  return (
    <table className={s.diff} aria-label="SQL diff">
      <colgroup>
        {layout === 'split'
          ? [<col key="a" className={s.colNo} />, <col key="b" className={s.colSign} />, <col key="c" />, <col key="d" className={s.colNo} />, <col key="e" className={s.colSign} />, <col key="f" />]
          : [<col key="a" className={s.colNo} />, <col key="b" className={s.colNo} />, <col key="c" className={s.colSign} />, <col key="d" />]}
      </colgroup>
      <tbody>
        {blocks.map((block, i) => {
          if (block.type === 'fold' && !expanded && !opened.has(i)) {
            return (
              <tr key={i} className={s.fold}>
                <td colSpan={6}>
                  <button type="button" onClick={() => open(i)}>↕ {block.rows.length}줄 동일 · 펼치기</button>
                </td>
              </tr>
            );
          }
          return (
            <Fragment key={i}>
              {block.type === 'hunk' && (
                <tr className={s.hunk}><td colSpan={6}>{hunkHeader(block.rows)}</td></tr>
              )}
              {layout === 'split' ? block.rows.map((row, k) => <SplitRowView key={k} row={row} />) : <UnifiedRows rows={block.rows} />}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
