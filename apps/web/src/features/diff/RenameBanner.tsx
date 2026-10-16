import type { RenameMapping } from '@tdm/core';
import { useMe, useSaveRenames } from '../../api/hooks';
import type { DiffResponse } from '../../api/types';
import { Banner } from '../../components/Banner';
import { canEdit } from '../../lib/roles';
import { AppliedRenames, describeRename, manualRenames, sameRename } from './AppliedRenames';
import s from './diff.module.css';

// rename 후보를 보여 주고, 사용자가 확정하면 (base, target) 쌍에 수동 매핑을 저장한다. 적용된 rename 은 출처(수동/DMS)를 함께 보여 준다
// 저장·해제는 admin·dba 만 한다. viewer 에게는 읽기 전용으로 보여 준다
export function RenameBanner({ data }: { data: DiffResponse }) {
  const me = useMe();
  const isEditor = canEdit(me.data);
  const save = useSaveRenames();
  const manual = manualRenames(data.renames);
  const apply = (renames: RenameMapping[]) => save.mutate({ base: data.base.id, target: data.target.id, renames });
  const candidates = data.diff.renameCandidates.filter((c) => !data.renames.some((r) => sameRename(r, c)));
  const release = (r: RenameMapping) => (
    <button type="button" className={s.linkBtn} disabled={save.isPending} onClick={() => apply(manual.filter((x) => !sameRename(x, r)))}>해제</button>
  );
  return (
    <>
      {candidates.length > 0 && (
        <Banner tone="info" label="이름 변경 후보">
          {candidates.map((c) => (
            <div key={describeRename(c)} className={s.renameRow}>
              <span><code>{c.kind === 'table' ? c.from : `${c.table}.${c.from}`}</code> 삭제 + <code>{c.to}</code> 추가 → 이름 변경일 수 있습니다</span>
              {isEditor && <button type="button" className={s.linkBtn} disabled={save.isPending} onClick={() => apply([...manual, c])}>이름 변경으로 처리</button>}
            </div>
          ))}
          {!isEditor && <div className={s.renameRow}>읽기 전용: 이름 변경은 DBA·관리자가 처리할 수 있습니다</div>}
        </Banner>
      )}
      <AppliedRenames data={data} renderRelease={isEditor ? release : undefined} />
      {save.error && <Banner tone="warn" role="alert">{save.error.message}</Banner>}
    </>
  );
}
