import type { DmsWarning } from '@tdm/core';
import { useState } from 'react';
import { useMe, useMigrationFlow } from '../../api/hooks';
import type { DiffResponse } from '../../api/types';
import { Banner } from '../../components/Banner';
import { formatDateTime } from '../../lib/format';
import { MigrationRevisions } from './MigrationRevisions';
import { MigrationTable } from './MigrationTable';
import { MigrationUploadDialog, type SchemaRef } from './MigrationUploadDialog';
import s from './migration.module.css';

function Warnings({ warnings }: { warnings: DmsWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <Banner tone="warn" label="전환 매핑 경고" className={s.flush}>
      <details>
        <summary>경고 {warnings.length}건 — 반영하지 않은 룰과 이름 불일치</summary>
        <ul className={s.warnings}>
          {warnings.map((w, i) => <li key={`${w.ruleId}-${i}`}>{w.ruleId ? `rule ${w.ruleId} · ` : ''}{w.message}</li>)}
        </ul>
      </details>
    </Banner>
  );
}

// 전환 탭: BASE 버전 Schema(As-Is) → TARGET 버전 Schema(To-Be) 쌍의 최신 매핑을 표로 보여 준다
export function MigrationTab({ data }: { data: DiffResponse }) {
  const me = useMe();
  // 같은 Schema 끼리는 매핑이 걸릴 수 없으므로 전환 표를 요청하지 않는다
  const flow = useMigrationFlow(data.base.id, data.target.id, data.base.schemaId !== data.target.schemaId);
  const [uploading, setUploading] = useState(false);
  const [showRevisions, setShowRevisions] = useState(false);
  const isAdmin = me.data?.role === 'admin';
  const from: SchemaRef = { id: data.base.schemaId, name: data.base.schemaName };
  const to: SchemaRef = { id: data.target.schemaId, name: data.target.schemaName };
  const dialog = uploading && <MigrationUploadDialog from={from} to={to} onClose={() => setUploading(false)} />;

  if (from.id === to.id) return <p className={s.emptyText}>같은 Schema 의 버전끼리는 전환 매핑을 쓰지 않습니다. BASE 를 As-Is Schema 의 버전으로 고르세요 (BASE → 다른 Database/Schema와 비교…).</p>;
  if (flow.error) return <p role="alert" className={s.emptyText}>{flow.error.message}</p>;
  if (!flow.data) return <p role="status" className={s.emptyText}>전환 표를 불러오는 중…</p>;
  const result = flow.data;
  if (result.mapping === null) {
    return (
      <div className={s.wrap}>
        <div className={s.empty}>
          <p>{from.name} → {to.name} 쌍에는 전환 매핑이 없습니다. AWS DMS table-mapping JSON 을 올리면 테이블·컬럼 대응을 보여 주고 rename 을 diff 에 반영합니다.</p>
          <p className={s.meta}>역방향 비교에는 매핑을 뒤집어 rename 으로 반영합니다 ({to.name} → {from.name} 쌍에 매핑이 있으면 이 비교의 DDL 은 DROP 대신 RENAME 을 씁니다).</p>
          {isAdmin && <button type="button" className={s.btn} onClick={() => setUploading(true)}>매핑 올리기</button>}
        </div>
        {dialog}
      </div>
    );
  }
  const { mapping, flow: table, warnings } = result;
  return (
    <div className={s.wrap}>
      <div className={s.head} role="group" aria-label="적용 중인 전환 매핑">
        <span className={s.headTitle}>{mapping.filename}</span>
        <span className={s.meta}>r{mapping.revision} · 룰 {mapping.ruleCount.toLocaleString('en-US')}개 · 검증 {table.totals.verified}/{table.totals.inScope}</span>
        <span className={s.meta}>{mapping.uploadedBy} · {formatDateTime(mapping.uploadedAt)}</span>
        <span className={s.spacer} />
        <button type="button" className={s.btn} aria-expanded={showRevisions} onClick={() => setShowRevisions((v) => !v)}>리비전 목록</button>
        {isAdmin && <button type="button" className={s.btn} onClick={() => setUploading(true)}>새 리비전 올리기</button>}
      </div>
      {showRevisions && <MigrationRevisions from={from.id} to={to.id} isAdmin={isAdmin} />}
      <Warnings warnings={warnings} />
      <MigrationTable flow={table} />
      {dialog}
    </div>
  );
}
