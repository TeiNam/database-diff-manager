import { useDeleteMigration, useMigrations } from '../../api/hooks';
import { formatDateTime } from '../../lib/format';
import s from './migration.module.css';

// 쌍의 리비전 목록. 최신만 적용되므로 선택은 없고, 원본 다운로드와(admin) 삭제만 한다
export function MigrationRevisions({ from, to, isAdmin }: { from: number; to: number; isAdmin: boolean }) {
  const list = useMigrations(from, to, true);
  const remove = useDeleteMigration();
  if (list.error) return <p role="alert" className={s.error}>{list.error.message}</p>;
  if (!list.data) return <p role="status" className={s.meta}>리비전 목록을 불러오는 중…</p>;
  const confirmDelete = (revision: number) =>
    window.confirm(`전환 매핑 r${revision}을(를) 삭제할까요? 최신 리비전을 지우면 바로 이전 리비전이 적용됩니다.`);
  return (
    <>
      <table className={s.table} aria-label="전환 매핑 리비전">
        <thead><tr><th>리비전</th><th>파일</th><th>룰</th><th>업로드</th><th>메모</th><th><span className="visually-hidden">동작</span></th></tr></thead>
        <tbody>
          {list.data.map((m) => (
            <tr key={m.id}>
              <td className={s.name}>r{m.revision}</td>
              <td className={s.name}>{m.filename}</td>
              <td>{m.ruleCount.toLocaleString('en-US')}</td>
              <td>{m.uploadedBy} · {formatDateTime(m.uploadedAt)}</td>
              <td>{m.note ?? ''}</td>
              <td>
                <div className={s.toolbar}>
                  <a className={s.btn} href={`/api/migrations/${m.id}/source`} download>원본</a>
                  {isAdmin && (
                    <button type="button" className={`${s.btn} ${s.danger}`} aria-label={`r${m.revision} 삭제`} disabled={remove.isPending}
                      onClick={() => confirmDelete(m.revision) && remove.mutate(m.id)}>삭제</button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {remove.error && <p role="alert" className={s.error}>{remove.error.message}</p>}
    </>
  );
}
