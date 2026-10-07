import { Link, useParams } from 'react-router';
import { useObjectHistory, useSchemaInfo } from '../api/hooks';
import { positive } from '../hooks/useSchemaContext';
import { formatDate } from '../lib/format';
import s from './Page.module.css';

export function ObjectHistoryPage() {
  const objectId = positive(useParams().objectId);
  const history = useObjectHistory(objectId);
  const schema = useSchemaInfo(history.data?.object.schemaId);
  if (objectId === undefined) return <section className={s.page}><p role="alert" className={s.error}>올바르지 않은 객체 주소입니다</p></section>;
  if (history.error) return <section className={s.page}><p role="alert" className={s.error}>{history.error.message}</p></section>;
  if (!history.data) return <section className={s.page}><p className={s.muted}>불러오는 중…</p></section>;
  const { object, revisions } = history.data;
  // 스키마 정보(databaseId)가 오기 전에는 링크를 만들 수 없다
  const databaseId = schema.data?.databaseId;
  const compareHref = (base: number, target: number) =>
    `/db/${databaseId}/schema/${object.schemaId}?base=${base}&target=${target}&obj=${encodeURIComponent(object.name)}&kind=${object.kind}`;
  return (
    <section className={s.page}>
      <h1 className={s.title}>객체 이력 · <span className="mono">{object.kind} {object.name}</span></h1>
      {schema.error && <p role="alert" className={s.error}>스키마 정보를 불러오지 못해 비교 링크를 표시할 수 없습니다: {schema.error.message}</p>}
      <table className={s.table}>
        <thead><tr><th>리비전</th><th>처음 나온 버전</th><th>출처</th><th>파싱</th><th /></tr></thead>
        <tbody>
          {revisions.map((r, i) => (
            <tr key={r.revisionNo}>
              <td className="mono">r{r.revisionNo}</td>
              <td>v{r.firstVersion.versionNo} · {formatDate(r.firstVersion.uploadedAt)}</td>
              <td>{r.fidelity === 'partial' ? 'MD(일부 속성)' : 'SQL'}</td>
              <td>{r.parseError ? <span className={s.error}>{r.parseError}</span> : '정상'}</td>
              <td>{i > 0 && databaseId !== undefined && <Link className={s.btn} to={compareHref(revisions[i - 1].firstVersion.id, r.firstVersion.id)}>r{revisions[i - 1].revisionNo} → r{r.revisionNo} 비교</Link>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
