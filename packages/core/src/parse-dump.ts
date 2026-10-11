// td-export SQL 파일 → SchemaModel
import { lineOf } from './cursor';
import { lexTokens, tokenize, type LexMode, type Token } from './lexer';
import { UNIDENTIFIED_NAME, type Routine, type RoutineKind, type SchemaModel, type Table, type View } from './model';
import { normalizeDdl, normalizeRoutineDdl } from './normalize';
import { parseRoutine } from './parse-routine';
import { parseCreateTable } from './parse-table';
import { parseCreateView } from './parse-view';
import { printRoutine, printTable, printView } from './print';

export interface ParseWarning {
  // parse-error: 파싱 실패(rawDdl만 보존), round-trip: 재출력이 원문과 다름, empty-schema: 객체가 0개인 빈 스키마 (업로드 시 서버가 붙인다)
  code: 'parse-error' | 'round-trip' | 'empty-schema';
  kind: 'table' | 'view' | 'routine' | 'schema';
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
const ROUTINE_RE = /^CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?(FUNCTION|PROCEDURE)\s+(?:`((?:[^`]|``)+)`|(\w+))/i;
// td-export 0.1.52+: 루틴마다 'SET @OLD_ROUTINE_SQL_MODE = @@SQL_MODE, SQL_MODE = '…'' 뒤에 루틴이 온다
const ROUTINE_SQL_MODE_RE = /^SET\s+@OLD_ROUTINE_SQL_MODE\s*=\s*@@SQL_MODE\s*,\s*SQL_MODE\s*=\s*'([^'\\]*)'\s*$/i;
const DATABASE_RE = /\/\*\s*Database\s*:\s*(.+?)\s*\*\//;
// 세션 변수 설정 (td-export 0.1.30+는 FOREIGN_KEY_CHECKS를 끄고 켠다). 스키마 정의가 아니므로 건너뛴다
// ';'가 빠져 뒤 CREATE가 같은 문장에 붙은 경우(줄 위치 무관)는 건너뛰지 않는다 (parse-error로 남긴다)
const SET_RE = /^SET\s/i;

export interface DumpStatement {
  ddl: string;
  line: number;
  noBackslashEscapes: boolean; // 이 문장을 읽을 때의 세션 SQL_MODE 에 NO_BACKSLASH_ESCAPES 가 있었는지
}

// 문장 끝: 기본은 ';', 'DELIMITER x' 줄 뒤로는 x ('DELIMITER ;' 로 복귀). 문자열·주석 안의 구분자는 토큰화에서 이미 빠진다.
// DELIMITER 줄은 클라이언트 명령이라 문장으로 내보내지 않는다
export function splitStatements(text: string): { ddl: string; line: number }[] {
  return splitDump(text).map(({ ddl, line }) => ({ ddl, line }));
}

// splitStatements + 세션 SQL_MODE 추적. mysql 클라이언트처럼 SET … SQL_MODE 가 바꾼 문자열 규칙(NO_BACKSLASH_ESCAPES)으로 뒤 문장을 읽는다
export function splitDump(text: string): DumpStatement[] {
  const out: DumpStatement[] = [];
  const session = new SessionMode();
  const mode: LexMode = {};
  let start: Token | undefined;
  let delimiter = ';';
  let skipUntil = 0; // DELIMITER 줄·구분자를 건너뛸 끝 오프셋
  const emit = (end: number) => {
    const ddl = text.slice(start!.s, end).trim();
    out.push({ ddl, line: lineOf(text, start!.s), noBackslashEscapes: mode.noBackslashEscapes === true });
    session.apply(ddl);
    mode.noBackslashEscapes = session.noBackslashEscapes;
  };
  for (const t of lexTokens(text, mode)) {
    if (t.e <= skipUntil) continue;
    if (!start && isDelimiterCommand(text, t)) {
      const end = lineEnd(text, t.s);
      delimiter = text.slice(t.e, end).trim() || ';';
      skipUntil = end;
      continue;
    }
    // 구분자가 단어에 붙어 있어도(END$$) 문장 끝이다. 문자열·백틱 토큰 안은 보지 않는다
    const at = delimiterAt(text, t, delimiter);
    if (at >= 0) {
      if (!start && at > t.s) start = t;
      if (start) emit(at);
      start = undefined;
      skipUntil = at + delimiter.length;
      continue;
    }
    start ??= t;
  }
  if (start) emit(text.length);
  return out;
}

// 토큰 시작(';;' 처럼 여러 토큰에 걸칠 수 있음) 또는 단어·숫자 토큰 안의 구분자 위치. 없으면 -1
function delimiterAt(text: string, t: Token, delimiter: string): number {
  if (t.t === 'string' || t.t === 'ident') return -1;
  if (text.startsWith(delimiter, t.s)) return t.s;
  if (t.t === 'op') return -1;
  const inside = text.slice(t.s, t.e).indexOf(delimiter);
  return inside < 0 ? -1 : t.s + inside;
}

// SET 문이 바꾸는 세션 SQL_MODE: '@v = @@SQL_MODE' 는 저장, 'SQL_MODE = '…'' 는 설정, 'SQL_MODE = @v' 는 복원
class SessionMode {
  private current = '';
  private readonly saved = new Map<string, string>();

  get noBackslashEscapes(): boolean {
    return /(^|,)NO_BACKSLASH_ESCAPES(,|$)/i.test(this.current);
  }

  apply(ddl: string): void {
    if (!SET_RE.test(ddl)) return;
    for (const m of ddl.matchAll(/(@\w+)\s*=\s*@@(?:SESSION\.)?SQL_MODE\b/gi)) this.saved.set(m[1].toLowerCase(), this.current);
    for (const m of ddl.matchAll(/(?:^SET|[\s,])(?:SESSION\s+)?SQL_MODE\s*=\s*(?:'([^']*)'|(@\w+))/gi)) {
      this.current = m[1] ?? this.saved.get(m[2].toLowerCase()) ?? '';
    }
  }
}

const lineEnd = (text: string, pos: number): number => {
  const end = text.indexOf('\n', pos);
  return end < 0 ? text.length : end;
};

// 줄 맨 앞(공백 제외)의 DELIMITER 단어
function isDelimiterCommand(text: string, t: Token): boolean {
  if (t.t !== 'word' || t.v.toUpperCase() !== 'DELIMITER') return false;
  const lineStart = text.lastIndexOf('\n', t.s - 1) + 1;
  return text.slice(lineStart, t.s).trim() === '';
}

export function parseSqlDump(text: string): ParsedDump {
  const clean = text.replace(/^\uFEFF/, '');
  const model: SchemaModel = { name: DATABASE_RE.exec(clean)?.[1] ?? '', tables: [], views: [], routines: [] };
  const warnings: ParseWarning[] = [];
  let sqlMode: string | undefined; // 다음 루틴에 붙일 SQL_MODE
  for (const { ddl, line, noBackslashEscapes } of splitDump(clean)) {
    if (SET_RE.test(ddl) && !hasCreateToken(ddl)) {
      const mode = ROUTINE_SQL_MODE_RE.exec(ddl);
      if (mode) sqlMode = mode[1];
      continue;
    }
    const routine = ROUTINE_RE.exec(ddl);
    if (routine) {
      model.routines.push(parseRoutineStatement(ddl, line, routine, sqlMode, noBackslashEscapes, warnings));
      sqlMode = undefined;
      continue;
    }
    const isView = VIEW_RE.test(ddl);
    const object = NAME_RE.exec(ddl)?.[1].replace(/``/g, '`') ?? UNIDENTIFIED_NAME;
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

// 루틴 하나. 실패하면 이름·종류만 정규식으로 얻고 원문을 남긴다
function parseRoutineStatement(
  ddl: string, line: number, m: RegExpExecArray, sqlMode: string | undefined, noBackslashEscapes: boolean, warnings: ParseWarning[],
): Routine {
  const withMode = (r: Routine): Routine => (sqlMode === undefined ? r : { ...r, sqlMode });
  try {
    const r = withMode(parseRoutine(ddl, { noBackslashEscapes }));
    return checkRoundTrip(r, printRoutine(r), ddl, line, warnings, normalizeRoutineDdl(ddl, { noBackslashEscapes }));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const name = m[2]?.replace(/``/g, '`') ?? m[3];
    warnings.push({ code: 'parse-error', kind: 'routine', object: name, line, message });
    const kind = m[1].toLowerCase() as RoutineKind;
    return withMode({ kind, name, params: '', characteristics: {}, body: '', parseError: message, rawDdl: normalizeRoutineDdl(ddl, { noBackslashEscapes }) });
  }
}

// 문자열·주석 밖의 CREATE 토큰 (splitStatements가 이미 토큰화한 문장이므로 예외가 나지 않는다)
const hasCreateToken = (ddl: string): boolean => tokenize(ddl).some((t) => t.t === 'word' && t.v.toUpperCase() === 'CREATE');

// 재출력 결과가 원문과 다르면 경고하고, 화면에서 원문을 볼 수 있도록 rawDdl을 남긴다
function checkRoundTrip<T extends Table | View | Routine>(obj: T, printed: string, ddl: string, line: number, warnings: ParseWarning[], normalized = normalizeDdl(ddl)): T {
  if (printed === normalized) return obj;
  const kind = obj.kind === 'table' || obj.kind === 'view' ? obj.kind : 'routine';
  warnings.push({ code: 'round-trip', kind, object: obj.name, line, message: '왕복 불일치: 재출력한 DDL이 원문과 다릅니다. 원문 보기로 확인하세요' });
  return { ...obj, rawDdl: normalized };
}
