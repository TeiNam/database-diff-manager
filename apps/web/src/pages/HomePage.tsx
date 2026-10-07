import { useDeleteDatabase, useMe, useTree } from '../api/hooks';
import { confirmByName } from '../lib/confirm-name';
import s from './Page.module.css';

export function HomePage() {
  const me = useMe();
  const isAdmin = me.data?.role === 'admin';
  return (
    <section className={s.page}>
      <h1 className={s.title}>스키마를 선택하세요</h1>
      <p className={s.empty}>왼쪽 트리에서 Database와 Schema를 고르면 버전 비교 화면이 열립니다. 아직 스키마가 없으면 관리자가 정의서를 업로드해야 합니다.</p>
      {isAdmin && <DatabaseList />}
    </section>
  );
}

// admin 전용: Schema 가 하나도 남지 않은 Database 는 이력 화면이 없으므로 여기서 지운다
function DatabaseList() {
  const tree = useTree();
  const remove = useDeleteDatabase();
  const list = tree.data ?? [];
  const onDelete = (id: number, name: string) => {
    if (!confirmByName('Database', name)) return;
    remove.reset();
    remove.mutate({ id, confirmName: name });
  };
  return (
    <>
      <h2 className={s.title}>Database 목록</h2>
      {tree.error && <p role="alert" className={s.error}>{tree.error.message}</p>}
      {list.length > 0 && (
        <table className={s.table} aria-label="Database 목록">
          <thead><tr><th>이름</th><th>Schema 수</th><th /></tr></thead>
          <tbody>
            {list.map((d) => (
              <tr key={d.id}>
                <td className="mono">{d.name}</td>
                <td>{d.schemas.length}</td>
                <td>
                  <button type="button" className={`${s.btn} ${s.danger}`} aria-label={`${d.name} 삭제`} disabled={remove.isPending}
                    onClick={() => onDelete(d.id, d.name)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {remove.error && <p role="alert" className={s.error}>{remove.error.message}</p>}
    </>
  );
}
