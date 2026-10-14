import { Fragment, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useDeleteDatabase, useDeleteSchema, useDeleteVersion, useDerivation, useMe, useSchemaInfo, useVersions } from '../api/hooks';
import { AlterDialog } from '../features/alter/AlterDialog';
import { positive } from '../hooks/useSchemaContext';
import { confirmByName } from '../lib/confirm-name';
import { formatDateTime } from '../lib/format';
import { canEdit } from '../lib/roles';
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
  const [alterFor, setAlterFor] = useState<number>(); // ALTER 대화상자를 연 스키마 (undefined: 닫힘)
  const [scriptOf, setScriptOf] = useState<number>();
  const isEditor = canEdit(me.data);
  const info = schema.data;
  // 대화상자는 연 스키마의 것이다. 주소가 다른 스키마로 바뀌면 닫아, 보고 있는 스키마와 다른 스키마의 버전에 저장하지 않게 한다
  if (alterFor !== undefined && alterFor !== schemaId) setAlterFor(undefined);
  const confirmDelete = (target: typeof removeSchema, id: number, label: string, name: string) => {
    if (!confirmByName(label, name)) return;
    // 같은 오류 영역을 쓰므로 이전 삭제의 실패 메시지를 지운다
    removeSchema.reset();
    removeDatabase.reset();
    target.mutate({ id, confirmName: name }, { onSuccess: () => navigate('/') });
  };
  // 지운 버전의 스크립트 패널은 닫는다. 지운 id 는 다시 쓰일 수 있어, 남기면 같은 id 의 새 버전 행에서 저절로 열린다
  const closeScriptOf = (id: number) => setScriptOf((open) => (open === id ? undefined : open));
  const list = versions.data ?? [];
  if (schemaId === undefined) return <section className={s.page}><p role="alert" className={s.error}>올바르지 않은 스키마 주소입니다</p></section>;
  return (
    <section className={s.page}>
      <h1 className={s.title}>버전 이력 · {info ? `${info.databaseName} › ${info.name}` : ''}</h1>
      {isEditor && info && (
        <div className={s.row}>
          {list.some((v) => v.sourceFormat === 'sql') && <button type="button" className={s.btn} onClick={() => setAlterFor(schemaId)}>ALTER 적용</button>}
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
                <Fragment key={v.id}>
                  <tr>
                    <td className="mono">v{v.versionNo}</td>
                    <td>{formatDateTime(v.uploadedAt)}</td>
                    <td>{v.uploadedBy}</td>
                    <td>
                      {v.sourceFormat.toUpperCase()}
                      {v.derivedFrom && (
                        <button type="button" className={s.btn} aria-expanded={scriptOf === v.id} onClick={() => setScriptOf(scriptOf === v.id ? undefined : v.id)}>
                          ALTER 적용 (기준 v{v.derivedFrom.baseVersionNo})
                        </button>
                      )}
                    </td>
                    <td className="mono">{v.sourceFilename}</td>
                    <td>{v.changedObjects}</td>
                    <td>{v.note ?? ''}</td>
                    <td>
                      <div className={s.row}>
                        {previous && <Link className={s.btn} to={`/db/${params.dbId}/schema/${schemaId}?base=${previous.id}&target=${v.id}`}>v{previous.versionNo}과 비교</Link>}
                        <a className={s.btn} href={`/api/versions/${v.id}/source`} download>원본</a>
                        {isEditor && (
                          <button type="button" className={`${s.btn} ${s.danger}`} aria-label={`v${v.versionNo} 삭제`} disabled={remove.isPending}
                            onClick={() => window.confirm(`v${v.versionNo}을(를) 삭제할까요? 다른 버전에는 영향이 없습니다.`) && remove.mutate(v.id, { onSuccess: () => closeScriptOf(v.id) })}>
                            삭제
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {v.derivedFrom && scriptOf === v.id && <tr><td colSpan={8}><DerivationScript id={v.id} /></td></tr>}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      {remove.error && <p role="alert" className={s.error}>{remove.error.message}</p>}
      {alterFor !== undefined && <AlterDialog versions={list} onClose={() => setAlterFor(undefined)} />}
    </section>
  );
}

// ALTER 적용으로 만든 버전의 스크립트 원문
function DerivationScript({ id }: { id: number }) {
  const derivation = useDerivation(id);
  if (derivation.error) return <p role="alert" className={s.error}>{derivation.error.message}</p>;
  if (!derivation.data) return <p className={s.empty}>불러오는 중…</p>;
  return <pre className={s.script}>{derivation.data.script}</pre>;
}
