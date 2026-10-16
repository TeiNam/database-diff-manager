import type { RenameMapping } from '@tdm/core';
import type { ReactNode } from 'react';
import type { DiffResponse, SourcedRename } from '../../api/types';
import { Banner } from '../../components/Banner';
import s from './diff.module.css';

export const describeRename = (r: RenameMapping) => (r.kind === 'table' ? `${r.from} → ${r.to}` : `${r.table}.${r.from} → ${r.to}`);
export const sameRename = (a: RenameMapping, b: RenameMapping) => a.kind === b.kind && a.table === b.table && a.from === b.from && a.to === b.to;
const isDms = (r: SourcedRename) => r.source === 'dms';

// 저장은 수동 매핑만 한다. DMS 에서 온 rename 은 전환 매핑을 바꿔야 달라지고, 함께 저장하면 수동 한도(500)를 넘는다
// 역쌍에서 뒤집어 온 매핑도 함께 저장한다 (이 쌍에 매핑이 생기면 역쌍 매핑은 더 쓰지 않으므로 빠뜨리면 사라진다)
export const manualRenames = (renames: SourcedRename[]): RenameMapping[] =>
  renames.filter((r) => !isDms(r)).map(({ source: _source, reversed: _reversed, ...r }) => r);

// 적용된 rename(수동·DMS)을 출처와 함께, 적용하지 못한 rename 을 이유와 함께 보여 준다. 화면 배너와 HTML 리포트가 함께 쓴다
// renderRelease: 이 쌍에 저장된 수동 매핑 옆에 둘 해제 버튼 (없으면 읽기 전용). dmsOpen: DMS 목록을 펼친 채로 둔다 (리포트)
export function AppliedRenames({ data, renderRelease, dmsOpen = false }: { data: DiffResponse; renderRelease?: (mapping: RenameMapping) => ReactNode; dmsOpen?: boolean }) {
  const manual = manualRenames(data.renames);
  const reversed = new Set(data.renames.filter((r) => r.reversed).map(describeRename));
  const dms = data.renames.filter(isDms);
  return (
    <>
      {manual.length > 0 && (
        <Banner tone="info" label="적용된 이름 변경">
          {manual.map((r) => {
            const isReversed = reversed.has(describeRename(r));
            return (
              <div key={describeRename(r)} className={s.renameRow}>
                <span className={s.source}>{isReversed ? '수동 · 역방향' : '수동'}</span>
                <span>{describeRename(r)}</span>
                {/* 역방향 매핑은 역쌍(target → base) 비교에 저장되어 있어 거기서 해제한다 */}
                {isReversed ? <span>(반대 방향 비교에 저장된 매핑을 뒤집어 적용 — 해제는 그 비교에서)</span> : renderRelease?.(r)}
              </div>
            );
          })}
        </Banner>
      )}
      {dms.length > 0 && (
        <Banner tone="info" label="DMS 매핑에서 적용된 이름 변경">
          <details open={dmsOpen}>
            <summary><span className={s.source}>DMS</span> 전환 매핑에서 이름 변경 {dms.length}건을 적용했습니다 (전환 탭에서 확인, 같은 대상에 수동 매핑을 넣으면 수동이 우선)</summary>
            {dms.map((r) => <div key={describeRename(r)} className={s.renameRow}><span>{describeRename(r)}</span></div>)}
          </details>
        </Banner>
      )}
      {data.diff.ignoredRenames.length > 0 && (
        <Banner tone="warn" label="적용하지 못한 이름 변경">
          {data.diff.ignoredRenames.map((i) => <div key={describeRename(i.mapping)}>{describeRename(i.mapping)}: {i.reason}</div>)}
        </Banner>
      )}
    </>
  );
}
