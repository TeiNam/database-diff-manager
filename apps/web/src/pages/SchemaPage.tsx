import { useEffect } from 'react';
import { useDiff, useVersions } from '../api/hooks';
import { Banner } from '../components/Banner';
import { Tabs } from '../components/Tabs';
import { DdlTab } from '../features/diff/DdlTab';
import { DiffTab } from '../features/diff/DiffTab';
import { RenameBanner } from '../features/diff/RenameBanner';
import { SummaryTab } from '../features/diff/SummaryTab';
import { useSchemaContext, type Tab } from '../hooks/useSchemaContext';
import s from './SchemaPage.module.css';

const PARTIAL_MESSAGE = 'MD 정의서가 포함된 비교입니다. 일부 속성(인덱스 종류·순서, 파티션, CHECK, 문자셋 등)은 비교되지 않았습니다.';

export function SchemaPage() {
  const ctx = useSchemaContext();
  const versions = useVersions(ctx.schemaId);
  const diff = useDiff(ctx.base, ctx.target);
  const { base, target, set } = ctx;

  // 기본값: 직전 버전 → 최신 버전 (버전이 하나뿐이면 같은 버전)
  useEffect(() => {
    if (!versions.data?.length || (base && target)) return;
    const [latest, previous] = versions.data;
    set({ base: base ?? (previous ?? latest).id, target: target ?? latest.id });
  }, [versions.data, base, target, set]);

  if (versions.error) return <p className={s.message} role="alert">{versions.error.message}</p>;
  if (versions.data?.length === 0) return <p className={s.message}>아직 업로드된 버전이 없습니다</p>;
  if (diff.error) return <p className={s.message} role="alert">{diff.error.message}</p>;
  if (!diff.data) return <p className={s.message} role="status">비교 결과를 불러오는 중…</p>;

  const changed = diff.data.diff.tables.length + diff.data.diff.views.length;
  return (
    <section className={s.page} aria-label="스키마 비교">
      <Tabs<Tab> value={ctx.tab} onChange={(tab) => set({ tab })}
        items={[{ id: 'summary', label: '요약', badge: changed }, { id: 'diff', label: '객체 diff' }, { id: 'ddl', label: 'DDL' }]} />
      {diff.data.diff.partial && <Banner tone="warn">{PARTIAL_MESSAGE}</Banner>}
      <RenameBanner data={diff.data} />
      {ctx.tab === 'summary' && <SummaryTab data={diff.data} onOpen={(kind, name) => set({ tab: 'diff', obj: name, kind })} />}
      {ctx.tab === 'diff' && <DiffTab data={diff.data} />}
      {ctx.tab === 'ddl' && <DdlTab data={diff.data} />}
    </section>
  );
}
