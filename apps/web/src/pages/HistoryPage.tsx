import { Link, useNavigate, useParams } from 'react-router';
import { useDeleteDatabase, useDeleteSchema, useDeleteVersion, useMe, useSchemaInfo, useVersions } from '../api/hooks';
import { positive } from '../hooks/useSchemaContext';
import { confirmByName } from '../lib/confirm-name';
import { formatDateTime } from '../lib/format';
import s from './Page.module.css';

export function HistoryPage() {
  const params = useParams();
  const schemaId = positive(params.schemaId);
  const me = useMe();
  const schema = useSchemaInfo(schemaId);
  const versions = useVersions(schemaId);
  const remove = useDeleteVersion();
  const removeSchema = useDeleteSchema();
  const removeDatabase = useDeleteDatabase();
  const navigate = useNavigate();
  const isAdmin = me.data?.role === 'admin';
  const info = schema.data;
  const confirmDelete = (target: typeof removeSchema, id: number, label: string, name: string) => {
    if (!confirmByName(label, name)) return;
    // 같은 오류 영역을 쓰므로 이전 삭제의 실패 메시지를 지운다
    removeSchema.reset();
    removeDatabase.reset();
    target.mutate({ id, confirmName: name }, { onSuccess: () => navigate('/') });
  };
  const list = versions.data ?? [];
  if (schemaId === undefined) return <section className={s.page}><p role="alert" className={s.error}>올바르지 않은 스키마 주소입니다</p></section>;
  return (
    <section className={s.page}>
      <h1 className={s.title}>버전 이력 · {info ? `${info.databaseName} › ${info.name}` : ''}</h1>
      {isAdmin && info && (
        <div className={s.row}>
          <button type="button" className={`${s.btn} ${s.danger}`} disabled={removeSchema.isPending || removeDatabase.isPending}
            onClick={() => confirmDelete(removeSchema, info.id, 'Schema', info.name)}>Schema 삭제</button>
          <button type="button" className={`${s.btn} ${s.danger}`} disabled={removeSchema.isPending || removeDatabase.isPending}
            onClick={() => confirmDelete(removeDatabase, info.databaseId, 'Database', info.databaseName)}>Database 삭제</button>
        </div>
      )}
      {(removeSchema.error ?? removeDatabase.error) && <p role="alert" className={s.error}>{(removeSchema.error ?? removeDatabase.error)!.message}</p>}
      {versions.error && <p role="alert" className={s.error}>{versions.error.message}</p>}
      {list.length === 0 && versions.isSuccess && <p className={s.empty}>아직 업로드된 버전이 없습니다</p>}
      {list.length > 0 && (
        <table className={s.table}>
          <thead><tr><th>버전</th><th>업로드</th><th>업로더</th><th>형식</th><th>파일</th><th>변경 객체</th><th>메모</th><th /></tr></thead>
          <tbody>
            {list.map((v, i) => {
              const previous = list[i + 1];
              return (
                <tr key={v.id}>
                  <td className="mono">v{v.versionNo}</td>
                  <td>{formatDateTime(v.uploadedAt)}</td>
                  <td>{v.uploadedBy}</td>
                  <td>{v.sourceFormat.toUpperCase()}</td>
                  <td className="mono">{v.sourceFilename}</td>
                  <td>{v.changedObjects}</td>
                  <td>{v.note ?? ''}</td>
                  <td>
                    <div className={s.row}>
                      {previous && <Link className={s.btn} to={`/db/${params.dbId}/schema/${schemaId}?base=${previous.id}&target=${v.id}`}>v{previous.versionNo}과 비교</Link>}
                      <a className={s.btn} href={`/api/versions/${v.id}/source`} download>원본</a>
                      {isAdmin && (
                        <button type="button" className={`${s.btn} ${s.danger}`} aria-label={`v${v.versionNo} 삭제`} disabled={remove.isPending}
                          onClick={() => window.confirm(`v${v.versionNo}을(를) 삭제할까요? 다른 버전에는 영향이 없습니다.`) && remove.mutate(v.id)}>
                          삭제
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {remove.error && <p role="alert" className={s.error}>{remove.error.message}</p>}
    </section>
  );
}
