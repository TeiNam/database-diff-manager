// 테이블 기본 문자셋·콜레이션 변경 계획.
// CONVERT TO는 모든 문자열 컬럼의 데이터를 새 문자셋으로 옮기므로 손실이 없을 때만 쓰고,
// 그 밖에는 테이블 옵션(DEFAULT CHARSET=… COLLATE=…)과 실제로 바뀌는 컬럼의 MODIFY로 처리한다
import type { OptionChange, TableDiff } from './diff';
import { quoteIdent as q } from './lexer';
import type { Column, Table } from './model';
import { fillColumn, isStringType, NOTE_PREFIX } from './partial-fill';

export const CHARSET_KEYS = ['DEFAULT CHARSET', 'COLLATE'];
const TEXT_TYPE = /^(tiny|medium|long)?text\b/i;
// utf8mb4로 옮겨도 모든 문자를 표현할 수 있는 문자셋
const UTF8MB4_SUBSETS = ['latin1', 'ascii', 'utf8mb3'];
export const DATA_NOTE_PREFIX = '[데이터 확인]';

export interface CharsetPlan {
  convert?: string; // 안전할 때만 만드는 CONVERT TO 문장 (';' 없음)
  columns: Set<string>; // 본 ALTER에서 MODIFY로 다시 정의할 컬럼 (TARGET 이름)
  notes: string[]; // convert가 있으면 CONVERT 문장, 없으면 본 ALTER에 붙인다
}

interface TableCharset {
  charset?: string;
  collation?: string;
}

interface ColumnPair {
  col: Column; // unknown 속성을 BASE로 채운 TARGET 컬럼
  base?: Column; // 짝지어진 BASE 문자열 컬럼
}

const normCharset = (c: string): string => (c.toLowerCase() === 'utf8' ? 'utf8mb3' : c.toLowerCase());
const charsetOf = (collation: string): string => normCharset(collation.split('_')[0]);

// TARGET 이름 → 짝지어진 BASE 컬럼 (rename 반영)
export function baseColumns(d: TableDiff): Map<string, Column> {
  const out = new Map((d.from?.columns ?? []).map((c) => [c.name, c]));
  for (const c of d.columns) if (c.op === 'rename' && c.from) out.set(c.name, c.from);
  return out;
}

function tableCharset(t: Table): TableCharset {
  const value = (key: string) => t.options.find((o) => o.key === key)?.value;
  const collation = value('COLLATE');
  const charset = value('DEFAULT CHARSET') ?? collation?.split('_')[0];
  return { charset: charset === undefined ? undefined : normCharset(charset), collation };
}

// 컬럼의 실제 문자셋·콜레이션. 콜레이션이 문자셋 기본값이라 이름을 모르면 ''
function effective(c: Column, t: TableCharset): { charset?: string; collation: string } {
  const charset = c.charset ? normCharset(c.charset) : c.collation ? charsetOf(c.collation) : t.charset;
  return { charset, collation: c.collation ?? (charset === t.charset ? t.collation ?? '' : '') };
}

// 손실 없는 변환: 같은 문자셋(콜레이션만 변경), ascii에서, latin1·ascii·utf8mb3에서 utf8mb4로
export function isLosslessConversion(from?: string, to?: string): boolean {
  if (from === undefined || to === undefined) return false;
  return from === to || from === 'ascii' || (to === 'utf8mb4' && UTF8MB4_SUBSETS.includes(from));
}

// TARGET에서 테이블 기본값을 상속하지 않는(명시 지정한) 문자열 컬럼
const isExplicit = (c: Column, t: TableCharset): boolean => Boolean(c.charset || (c.collation && c.collation !== t.collation));

function columnPairs(d: TableDiff): ColumnPair[] {
  const bases = baseColumns(d);
  const added = new Set(d.columns.filter((c) => c.op === 'add').map((c) => c.name));
  return d.to!.columns
    .filter((c) => isStringType(c.type))
    .map((raw) => {
      const base = added.has(raw.name) ? undefined : bases.get(raw.name);
      return { col: fillColumn(raw, base), base: base && isStringType(base.type) ? base : undefined };
    });
}

export function charsetPlan(d: TableDiff): CharsetPlan | undefined {
  if (!d.options.some((o) => CHARSET_KEYS.includes(o.key) && o.to !== undefined)) return undefined;
  const to = tableCharset(d.to!);
  if (!to.charset) return undefined;
  const from = tableCharset(d.from!);
  const pairs = columnPairs(d);
  const narrowed = pairs.filter((p) => p.base && !isLosslessConversion(effective(p.base, from).charset, effective(p.col, to).charset));
  const notes = commonNotes(d);
  const isSafe = isLosslessConversion(from.charset, to.charset) && !narrowed.length && !pairs.some((p) => isExplicit(p.col, to));
  if (isSafe) return convertPlan(d.name, pairs, from, to, notes);
  const changed = pairs.filter((p) => p.base && !sameEffective(p, from, to)).map((p) => p.col.name);
  return { columns: new Set(changed), notes: narrowed.length ? [...notes, narrowNote(narrowed, from, to)] : notes };
}

// 문자셋 변경 문장에 맞춘 옵션 변경 목록. CONVERT TO가 문자셋·콜레이션을 함께 바꾸고,
// 옵션으로 바꿀 때는 DEFAULT CHARSET만으로 기본 콜레이션이 정해지므로 COLLATE 제거는 따로 처리하지 않는다
export function charsetOptions(options: OptionChange[], plan?: CharsetPlan): OptionChange[] {
  if (!plan) return options;
  if (plan.convert) return options.filter((o) => !CHARSET_KEYS.includes(o.key));
  const setsCharset = options.some((o) => o.key === 'DEFAULT CHARSET' && o.to !== undefined);
  return setsCharset ? options.filter((o) => !(o.key === 'COLLATE' && o.to === undefined)) : options;
}

function sameEffective(p: ColumnPair, from: TableCharset, to: TableCharset): boolean {
  const a = effective(p.base!, from);
  const b = effective(p.col, to);
  return a.charset === b.charset && a.collation === b.collation;
}

// CONVERT TO는 같은 ALTER 안의 컬럼 문자셋 지정을 덮어쓰므로 별도 문장으로 먼저 실행한다.
// 그 뒤 본 ALTER에서 BASE에 명시 문자셋이 있던 컬럼, CONVERT가 넓힌 TEXT 계열 컬럼(TEXT → MEDIUMTEXT 등)을 다시 정의한다
function convertPlan(table: string, pairs: ColumnPair[], from: TableCharset, to: TableCharset, notes: string[]): CharsetPlan {
  const restored = pairs.filter((p) => p.base?.charset);
  const texts = from.charset === to.charset ? [] : pairs.filter((p) => p.base && TEXT_TYPE.test(p.col.type) && !p.base.charset);
  const convert = `ALTER TABLE ${q(table)} CONVERT TO CHARACTER SET ${to.charset}${to.collation ? ` COLLATE ${to.collation}` : ''}`;
  const textNote = texts.length
    ? [`${DATA_NOTE_PREFIX} CONVERT TO가 넓힌 TEXT 계열 컬럼(${texts.map((p) => q(p.col.name)).join(', ')})을 TARGET 타입으로 되돌립니다. 변환으로 길어진 값이 타입 한도를 넘으면 실패하거나 잘릴 수 있습니다`]
    : [];
  return { convert, columns: new Set([...restored, ...texts].map((p) => p.col.name)), notes: [...notes, ...textNote] };
}

function commonNotes(d: TableDiff): string[] {
  const notes: string[] = [];
  const collation = d.to!.options.find((o) => o.key === 'COLLATE')?.value;
  if (!d.to!.options.some((o) => o.key === 'DEFAULT CHARSET')) notes.push(`${NOTE_PREFIX} 테이블 문자셋을 콜레이션(${collation})에서 추정했습니다`);
  if (d.to!.fidelity === 'partial') notes.push(`${NOTE_PREFIX} 컬럼별 문자셋을 알 수 없어 BASE의 명시 문자셋을 유지했습니다`);
  return notes;
}

function narrowNote(narrowed: ColumnPair[], from: TableCharset, to: TableCharset): string {
  const list = narrowed.map((p) => `${q(p.col.name)}(${effective(p.base!, from).charset ?? '?'} → ${effective(p.col, to).charset ?? '?'})`);
  return `${DATA_NOTE_PREFIX} 문자셋이 좁아지는 컬럼: ${list.join(', ')}. 대상 문자셋에 없는 문자가 있으면 엄격 모드에서는 오류(1366)로 실패하고, 아니면 '?'로 바뀝니다. 실행 전에 데이터를 확인하세요`;
}
