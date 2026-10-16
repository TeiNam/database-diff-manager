import { renderToStaticMarkup } from 'react-dom/server';
import type { DiffResponse } from '../../api/types';
import { ReportDocument } from './ReportDocument';
import { reportTitle, type ReportOptions } from './report-meta';
import { REPORT_CSS } from './styles';

export { reportFileName } from './report-meta';

// 파일이 외부 자원을 읽거나 스크립트를 실행하지 못하게 한다 (설계 §5)
export const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
// React 는 charset 을 charSet 으로, 작은따옴표를 &#x27; 로 쓰므로 고정된 문서 머리는 문자열로 쓴다. 값이 들어가는 제목·본문만 React 로 렌더해 이스케이프한다
const HEAD_META = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`;

// 순수 함수: 불러온 비교 결과로 스크립트 없는 HTML 문서 하나를 만든다
export function buildReportHtml(data: DiffResponse, opts: ReportOptions): string {
  const title = renderToStaticMarkup(<title>{reportTitle(data)}</title>);
  const body = renderToStaticMarkup(<ReportDocument data={data} options={opts} />);
  return `<!doctype html>\n<html lang="ko" data-theme="light">\n<head>${HEAD_META}${title}<style>${REPORT_CSS}</style></head>\n<body>${body}</body>\n</html>\n`;
}
