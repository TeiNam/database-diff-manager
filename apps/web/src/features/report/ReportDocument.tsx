import type { DiffResponse, VersionMeta } from '../../api/types';
import { Banner } from '../../components/Banner';
import { formatDateTime } from '../../lib/format';
import { changedObjects, objectAnchor } from '../../lib/object-diff';
import { APP_NAME } from '../../meta';
import { AppliedRenames } from '../diff/AppliedRenames';
import { PARTIAL_MESSAGE } from '../diff/messages';
import { SummaryView, type SummaryItemRenderer } from '../diff/SummaryView';
import { ReportObject } from './ReportObject';
import { formatGeneratedAt, reportTitle, viewLabel, type ReportOptions } from './report-meta';

const versionLine = (v: VersionMeta) => `v${v.versionNo} · ${v.sourceFilename} · ${v.uploadedBy} · ${formatDateTime(v.uploadedAt)}`;

// 요약 목록 항목은 같은 파일 안의 객체 diff 로 가는 링크다
const linkItem: SummaryItemRenderer = ({ entry, className, children }) => (
  <a href={`#${objectAnchor(entry.kind, entry.name)}`} className={`${className} report-link`}>{children}</a>
);

function ReportHeader({ data, options }: { data: DiffResponse; options: ReportOptions }) {
  const rows: [string, string][] = [
    ['BASE', versionLine(data.base)],
    ['TARGET', versionLine(data.target)],
    ['보기 방식', viewLabel(options.mode, options.layout)],
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

// 리포트 본문: 머리말 → 화면 안내 → 요약 → 객체 diff (설계 §3). 화면 조작 요소(탭·복사·이력 링크)는 넣지 않는다
export function ReportDocument({ data, options }: { data: DiffResponse; options: ReportOptions }) {
  const entries = changedObjects(data.diff);
  return (
    <main className="report">
      <ReportHeader data={data} options={options} />
      {data.diff.partial && <Banner tone="warn">{PARTIAL_MESSAGE}</Banner>}
      <AppliedRenames data={data} dmsOpen />
      <h2 className="report-section-title">요약</h2>
      <SummaryView data={data} renderItem={linkItem} />
      {entries.length > 0 && (
        <section aria-label="객체 diff">
          <h2 className="report-section-title">객체 diff</h2>
          {entries.map((e) => <ReportObject key={e.key} entry={e} mode={options.mode} layout={options.layout} />)}
        </section>
      )}
    </main>
  );
}
