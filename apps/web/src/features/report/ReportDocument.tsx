import type { DiffResponse, VersionMeta } from '../../api/types';
import { Banner } from '../../components/Banner';
import { formatDateTime } from '../../lib/format';
import { changedObjects, objectAnchor, unchangedObjects, type ObjectEntry } from '../../lib/object-diff';
import { APP_NAME } from '../../meta';
import { AppliedRenames } from '../diff/AppliedRenames';
import { PARTIAL_MESSAGE } from '../diff/messages';
import { SummaryView, type SummaryItemRenderer } from '../diff/SummaryView';
import { ReportObject } from './ReportObject';
import { excludedLabel, filteredEmptyMessage, formatGeneratedAt, reportTitle, viewLabel, type ReportOptions } from './report-meta';

const sourceLabel = (v: VersionMeta) => `${v.databaseName} › ${v.schemaName} v${v.versionNo}`;
const versionLine = (v: VersionMeta) => `${sourceLabel(v)} · ${v.sourceFilename} · ${v.uploadedBy} · ${formatDateTime(v.uploadedAt)}`;

// 객체 diff 의 왼쪽(BASE)·오른쪽(TARGET)이 어느 DB 인지. Unified 는 좌우가 없어 −/+ 로 가리킨다.
// 표 보기라도 뷰는 SQL diff 로 그리므로(ObjectBody), Unified 뷰가 섞이면 두 표기를 함께 적는다
function sideTags(options: ReportOptions, entries: ObjectEntry[]): [string, string] {
  if (options.layout !== 'unified') return ['BASE', 'TARGET'];
  if (options.mode === 'sql') return ['− BASE', '+ TARGET'];
  return entries.some((e) => e.kind === 'view') ? ['BASE (SQL −)', 'TARGET (SQL +)'] : ['BASE', 'TARGET'];
}

function SidesLegend({ data, tags }: { data: DiffResponse; tags: [string, string] }) {
  return (
    <div className="report-sides">
      <div><span className="report-side-tag">{tags[0]}</span>{sourceLabel(data.base)}</div>
      <div><span className="report-side-tag">{tags[1]}</span>{sourceLabel(data.target)}</div>
    </div>
  );
}

// 요약 목록 항목은 같은 파일 안의 객체 diff 로 가는 링크다
const linkItem: SummaryItemRenderer = ({ entry, className, children }) => (
  <a href={`#${objectAnchor(entry.kind, entry.name)}`} className={`${className} report-link`}>{children}</a>
);

function ReportHeader({ data, options }: { data: DiffResponse; options: ReportOptions }) {
  const rows: [string, string][] = [
    ['BASE', versionLine(data.base)],
    ['TARGET', versionLine(data.target)],
    ['보기 방식', viewLabel(options.mode, options.layout)],
    ['범위', options.scope === 'all' ? '전체 (변경 없는 객체 포함)' : '변경분'],
    ...(excludedLabel(options) ? [['뺀 객체', excludedLabel(options)] as [string, string]] : []),
    ['만든 시각', formatGeneratedAt(options.generatedAt)],
    ['만든 사람', options.generatedBy],
    ['도구 버전', `${APP_NAME} ${options.appVersion}`],
  ];
  return (
    <header className="report-header">
      <h1>{reportTitle(data)}</h1>
      <dl className="report-meta">
        {rows.map(([term, value]) => (
          <div key={term}><dt>{term}</dt><dd>{value}</dd></div>
        ))}
      </dl>
    </header>
  );
}

// 리포트 본문: 머리말 → 화면 안내 → 요약 → 객체 diff → (전체 범위면) 변경 없는 객체 (설계 §3). 화면 조작 요소(탭·복사·이력 링크)는 넣지 않는다
export function ReportDocument({ data, options }: { data: DiffResponse; options: ReportOptions }) {
  const entries = changedObjects(data.diff);
  const same = options.scope === 'all' ? unchangedObjects(data.baseModel, data.targetModel, data.diff) : [];
  return (
    <main className="report">
      <ReportHeader data={data} options={options} />
      {data.diff.partial && <Banner tone="warn">{PARTIAL_MESSAGE}</Banner>}
      <AppliedRenames data={data} dmsOpen />
      <h2 className="report-section-title">요약</h2>
      <SummaryView data={data} renderItem={linkItem} emptyMessage={filteredEmptyMessage(options)} />
      {entries.length > 0 && (
        <section aria-label="객체 diff">
          <h2 className="report-section-title">객체 diff</h2>
          <SidesLegend data={data} tags={sideTags(options, entries)} />
          {entries.map((e) => <ReportObject key={e.key} entry={e} mode={options.mode} layout={options.layout} />)}
        </section>
      )}
      {same.length > 0 && (
        <section aria-label="변경 없는 객체">
          <h2 className="report-section-title">변경 없는 객체 ({same.length})</h2>
          {same.map((e) => <ReportObject key={e.key} entry={e} mode={options.mode} layout={options.layout} />)}
        </section>
      )}
    </main>
  );
}
