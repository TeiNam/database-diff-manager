import type { RenameMapping } from '@tdm/core';
import { useSaveRenames } from '../../api/hooks';
import type { DiffResponse } from '../../api/types';
import { Banner } from '../../components/Banner';
import s from './diff.module.css';

const describe = (r: RenameMapping) => (r.kind === 'table' ? `${r.from} → ${r.to}` : `${r.table}.${r.from} → ${r.to}`);
const same = (a: RenameMapping, b: RenameMapping) => a.kind === b.kind && a.table === b.table && a.from === b.from && a.to === b.to;

// rename 후보를 보여 주고, 사용자가 확정하면 (base, target) 쌍에 매핑을 저장한다
export function RenameBanner({ data }: { data: DiffResponse }) {
  const save = useSaveRenames();
  const apply = (renames: RenameMapping[]) => save.mutate({ base: data.base.id, target: data.target.id, renames });
  const candidates = data.diff.renameCandidates.filter((c) => !data.renames.some((r) => same(r, c)));
  return (
    <>
      {candidates.length > 0 && (
        <Banner tone="info" label="이름 변경 후보">
          {candidates.map((c) => (
            <div key={describe(c)} className={s.renameRow}>
              <span><code>{c.kind === 'table' ? c.from : `${c.table}.${c.from}`}</code> 삭제 + <code>{c.to}</code> 추가 → 이름 변경일 수 있습니다</span>
              <button type="button" className={s.linkBtn} disabled={save.isPending} onClick={() => apply([...data.renames, c])}>이름 변경으로 처리</button>
            </div>
          ))}
        </Banner>
      )}
      {data.renames.length > 0 && (
        <Banner tone="info" label="적용된 이름 변경">
          {data.renames.map((r) => (
            <div key={describe(r)} className={s.renameRow}>
              <span>{describe(r)}</span>
              <button type="button" className={s.linkBtn} disabled={save.isPending} onClick={() => apply(data.renames.filter((x) => !same(x, r)))}>해제</button>
            </div>
          ))}
        </Banner>
      )}
      {data.diff.ignoredRenames.length > 0 && (
        <Banner tone="warn" label="적용하지 못한 이름 변경">
          {data.diff.ignoredRenames.map((i) => <div key={describe(i.mapping)}>{describe(i.mapping)}: {i.reason}</div>)}
        </Banner>
      )}
      {save.error && <Banner tone="warn" role="alert">{save.error.message}</Banner>}
    </>
  );
}
