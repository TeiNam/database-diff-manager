// 업로드 파일의 형식과 Database/Schema 이름을 추정한다. 사용자가 확정하기 전 제안값이다
export type SourceFormat = 'sql' | 'md';

export interface TargetSuggestion {
  format?: SourceFormat;
  databaseName?: string;
  schemaName?: string;
}

const WITH_ENDPOINT = /^(.+)\((.+)\)\.(sql|md)$/i; // td-export: {schema}({endpoint}).sql|md
const PLAIN = /^(.+)\.(sql|md)$/i;
// td-export 0.1.20+: 기본 포트가 아니면 endpoint 뒤에 _{port}를 붙인다 (':'는 파일명에 못 써서 '_')
// 100 미만은 실제 DB 포트가 아니므로 'db_2' 같은 호스트명 꼬리로 본다
const ENDPOINT_PORT = /^(.+)_([1-9]\d{2,4})$/;
const MAX_PORT = 65535;
const SQL_HEADER = /\/\*\s*Database\s*:\s*(.+?)\s*\*\//;

export function suggestTarget(filename: string, text: string): TargetSuggestion {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const withEndpoint = WITH_ENDPOINT.exec(base);
  const match = withEndpoint ?? PLAIN.exec(base);
  if (!match) return {};
  const format = match[match.length - 1].toLowerCase() as SourceFormat;
  const fromText = format === 'sql' ? SQL_HEADER.exec(text)?.[1] : mdTitle(text);
  return {
    format,
    schemaName: fromText || match[1],
    ...(withEndpoint ? { databaseName: databaseOf(withEndpoint[2]) } : {}),
  };
}

// Database는 물리 엔진 인스턴스 하나다 → host와 port로 식별해 'host:port'로 제안한다
function databaseOf(endpoint: string): string {
  const m = ENDPOINT_PORT.exec(endpoint);
  return m && Number(m[2]) <= MAX_PORT ? `${m[1]}:${m[2]}` : endpoint;
}

function mdTitle(text: string): string | undefined {
  const first = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0]?.trim();
  return first || undefined;
}
