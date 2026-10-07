// td-export SQL 파일 → SchemaModel
import { lineOf } from './cursor';
import { tokenize, type Token } from './lexer';
import type { SchemaModel, Table, View } from './model';
import { normalizeDdl } from './normalize';
import { parseCreateTable } from './parse-table';
import { parseCreateView } from './parse-view';
import { printTable, printView } from './print';

export interface ParseWarning {
  code: 'parse-error' | 'round-trip'; // parse-error: 파싱 실패(rawDdl만 보존), round-trip: 재출력이 원문과 다름
  kind: 'table' | 'view';
  object: string;
  line: number;
  message: string;
}

export interface ParsedDump {
  model: SchemaModel;
  warnings: ParseWarning[];
}

const VIEW_RE = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:ALGORITHM\s*=\s*\w+\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:SQL\s+SECURITY\s+\w+\s+)?VIEW\b/i;
const NAME_RE = /\b(?:TABLE|VIEW)\s+`((?:[^`]|``)+)`/i;
const DATABASE_RE = /\/\*\s*Database\s*:\s*(.+?)\s*\*\//;
// 세션 변수 설정 (td-export 0.1.30+는 FOREIGN_KEY_CHECKS를 끄고 켠다). 스키마 정의가 아니므로 건너뛴다
// ';'가 빠져 뒤 CREATE가 같은 문장에 붙은 경우(줄 위치 무관)는 건너뛰지 않는다 (parse-error로 남긴다)
const SET_RE = /^SET\s/i;

export function splitStatements(text: string): { ddl: string; line: number }[] {
  const out: { ddl: string; line: number }[] = [];
  let start: Token | undefined;
  for (const t of tokenize(text)) {
    if (t.t === 'op' && t.v === ';') {
      if (start) out.push({ ddl: text.slice(start.s, t.s).trim(), line: lineOf(text, start.s) });
      start = undefined;
      continue;
    }
    start ??= t;
  }
  if (start) out.push({ ddl: text.slice(start.s).trim(), line: lineOf(text, start.s) });
  return out;
}

export function parseSqlDump(text: string): ParsedDump {
  const clean = text.replace(/^\uFEFF/, '');
  const model: SchemaModel = { name: DATABASE_RE.exec(clean)?.[1] ?? '', tables: [], views: [] };
  const warnings: ParseWarning[] = [];
  for (const { ddl, line } of splitStatements(clean)) {
    if (SET_RE.test(ddl) && !hasCreateToken(ddl)) continue;
    const isView = VIEW_RE.test(ddl);
    const object = NAME_RE.exec(ddl)?.[1].replace(/``/g, '`') ?? '(unknown)';
    try {
      if (isView) {
        const view = parseCreateView(ddl);
        model.views.push(checkRoundTrip(view, printView(view), ddl, line, warnings));
      } else {
        const table = parseCreateTable(ddl);
        model.tables.push(checkRoundTrip(table, printTable(table), ddl, line, warnings));
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      warnings.push({ code: 'parse-error', kind: isView ? 'view' : 'table', object, line, message });
      const failed = { name: object, fidelity: 'full' as const, parseError: message, rawDdl: normalizeDdl(ddl) };
      if (isView) model.views.push({ kind: 'view', body: '', ...failed });
      else model.tables.push({ kind: 'table', columns: [], indexes: [], foreignKeys: [], checks: [], options: [], ...failed });
    }
  }
  return { model, warnings };
}

// 문자열·주석 밖의 CREATE 토큰 (splitStatements가 이미 토큰화한 문장이므로 예외가 나지 않는다)
const hasCreateToken = (ddl: string): boolean => tokenize(ddl).some((t) => t.t === 'word' && t.v.toUpperCase() === 'CREATE');

// 재출력 결과가 원문과 다르면 경고하고, 화면에서 원문을 볼 수 있도록 rawDdl을 남긴다
function checkRoundTrip<T extends Table | View>(obj: T, printed: string, ddl: string, line: number, warnings: ParseWarning[]): T {
  const normalized = normalizeDdl(ddl);
  if (printed === normalized) return obj;
  warnings.push({ code: 'round-trip', kind: obj.kind, object: obj.name, line, message: '왕복 불일치: 재출력한 DDL이 원문과 다릅니다. 원문 보기로 확인하세요' });
  return { ...obj, rawDdl: normalized };
}
