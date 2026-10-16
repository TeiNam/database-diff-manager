import { useState } from 'react';
import type { DiffResponse } from '../../api/types';
import { Icon } from '../../components/Icon';
import { downloadText } from '../../lib/download';
import { APP_VERSION } from '../../meta';
import s from './ExportReportButton.module.css';

export type ReportModule = typeof import('./build-report');

// 리포트 모듈(react-dom/server 포함)은 누를 때 불러 첫 화면 번들을 늘리지 않는다 (설계 §4)
const loadReportModule = (): Promise<ReportModule> => import('./build-report');
// 객체가 수천 개면 만드는 데 몇 초 걸린다 — 진행 표시가 먼저 그려지도록 한 번 양보한다
const yieldToPaint = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const HTML_TYPE = 'text/html;charset=utf-8';
const UNKNOWN_USER = '알 수 없음';

type ExportState = { status: 'idle' } | { status: 'pending' } | { status: 'failed'; reason: string };

// 지금 고른 BASE·TARGET 비교와 보기 방식으로 HTML 리포트를 만들어 내려받는다. load 는 테스트에서 바꿔 끼운다
export function ExportReportButton({ data, mode, layout, generatedBy, load = loadReportModule }: {
  data?: DiffResponse; mode: 'sql' | 'grid'; layout: 'split' | 'unified'; generatedBy?: string; load?: () => Promise<ReportModule>;
}) {
  const [state, setState] = useState<ExportState>({ status: 'idle' });
  const pending = state.status === 'pending';
  const run = async (diff: DiffResponse) => {
    setState({ status: 'pending' });
    try {
      const report = await load();
      await yieldToPaint();
      const generatedAt = new Date();
      const html = report.buildReportHtml(diff, { mode, layout, generatedAt, generatedBy: generatedBy ?? UNKNOWN_USER, appVersion: APP_VERSION });
      downloadText(report.reportFileName(diff, generatedAt), html, HTML_TYPE);
      setState({ status: 'idle' });
    } catch (e) {
      setState({ status: 'failed', reason: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div className={s.wrap}>
      <button type="button" className={s.btn} disabled={!data || pending} onClick={() => data && void run(data)}>
        <Icon name="download" />
        {pending ? '리포트 만드는 중…' : '리포트 내보내기'}
      </button>
      {state.status === 'failed' && <span className={s.error} role="alert">리포트를 만들지 못했습니다: {state.reason}</span>}
    </div>
  );
}
