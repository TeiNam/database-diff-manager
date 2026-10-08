import type { RenameMapping } from '@tdm/core';
import { useMe, useSaveRenames } from '../../api/hooks';
import type { DiffResponse, SourcedRename } from '../../api/types';
import { Banner } from '../../components/Banner';
import { canEdit } from '../../lib/roles';
import s from './diff.module.css';

const describe = (r: RenameMapping) => (r.kind === 'table' ? `${r.from} → ${r.to}` : `${r.table}.${r.from} → ${r.to}`);
const same = (a: RenameMapping, b: RenameMapping) => a.kind === b.kind && a.table === b.table && a.from === b.from && a.to === b.to;
const isDms = (r: SourcedRename) => r.source === 'dms';

// 저장은 수동 매핑만 한다. DMS 에서 온 rename 은 전환 매핑을 바꿔야 달라지고, 함께 저장하면 수동 한도(500)를 넘는다
const manualOnly = (renames: SourcedRename[]): RenameMapping[] =>
  renames.filter((r) => !isDms(r)).map(({ source: _source, ...r }) => r);

// rename 후보를 보여 주고, 사용자가 확정하면 (base, target) 쌍에 수동 매핑을 저장한다. 적용된 rename 은 출처(수동/DMS)를 함께 보여 준다
// 저장·해제는 admin·dba 만 한다. viewer 에게는 읽기 전용으로 보여 준다
export function RenameBanner({ data }: { data: DiffResponse }) {
  const me = useMe();
  const isEditor = canEdit(me.data);
  const save = useSaveRenames();
  const manual = manualOnly(data.renames);
  const dms = data.renames.filter(isDms);
  const apply = (renames: RenameMapping[]) => save.mutate({ base: data.base.id, target: data.target.id, renames });
  const candidates = data.diff.renameCandidates.filter((c) => !data.renames.some((r) => same(r, c)));
  return (
    <>
      {candidates.length > 0 && (
        <Banner tone="info" label="이름 변경 후보">
          {candidates.map((c) => (
            <div key={describe(c)} className={s.renameRow}>
              <span><code>{c.kind === 'table' ? c.from : `${c.table}.${c.from}`}</code> 삭제 + <code>{c.to}</code> 추가 → 이름 변경일 수 있습니다</span>
              {isEditor && <button type="button" className={s.linkBtn} disabled={save.isPending} onClick={() => apply([...manual, c])}>이름 변경으로 처리</button>}
            </div>
          ))}
          {!isEditor && <div className={s.renameRow}>읽기 전용: 이름 변경은 DBA·관리자가 처리할 수 있습니다</div>}
        </Banner>
      )}
      {manual.length > 0 && (
        <Banner tone="info" label="적용된 이름 변경">
          {manual.map((r) => (
            <div key={describe(r)} className={s.renameRow}>
              <span className={s.source}>수동</span>
              <span>{describe(r)}</span>
              {isEditor && <button type="button" className={s.linkBtn} disabled={save.isPending} onClick={() => apply(manual.filter((x) => !same(x, r)))}>해제</button>}
            </div>
          ))}
        </Banner>
      )}
      {dms.length > 0 && (
        <Banner tone="info" label="DMS 매핑에서 적용된 이름 변경">
          <details>
            <summary><span className={s.source}>DMS</span> 전환 매핑에서 이름 변경 {dms.length}건을 적용했습니다 (전환 탭에서 확인, 같은 대상에 수동 매핑을 넣으면 수동이 우선)</summary>
            {dms.map((r) => <div key={describe(r)} className={s.renameRow}><span>{describe(r)}</span></div>)}
          </details>
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
