// 덤프 원문이 완전한 td-export 스키마 출력이라는 증거 (14회차 1 → 15회차 원칙 전환). 파서가 모은 구조 사실로 증거 수준을 정하고,
// diff·DDL 가드는 targetEvidence 의 수준만 본다: complete 가 아니면(incomplete·unknown) 부재 기반 파괴 문장 — TARGET 에 없다는
// 이유로 나오는 DROP TABLE·VIEW·FUNCTION·PROCEDURE·COLUMN·PARTITION(행이 지워지는 파티션 재구성 포함) — 을 수동 확인으로 돌린다
import { isUnidentified, type SchemaEvidence, type SchemaModel } from './model';

const CREATE_TABLE_RE = /^CREATE\s+TABLE\s/i;
const SAVE_RE = /(@OLD_\w+)\s*=\s*@@\w+/gi; // SET @OLD_X = @@X: 헤더(또는 루틴 앞)가 세션 값을 저장한다
const RESTORE_RE = /=\s*(@OLD_\w+)\s*(?:,|$)/gi; // SET X = @OLD_X: 트레일러(또는 루틴 뒤)가 되돌린다
// 루틴 하나를 감싸는 저장 변수 (td-export 0.1.52+). 루틴 바로 뒤에서 복원하므로 파일 헤더가 아니다
const ROUTINE_SAVE = '@old_routine_sql_mode';

export const isCreateTable = (ddl: string): boolean => CREATE_TABLE_RE.test(ddl);

// 수동 확인 사유 머리말 (화면·문서에서 같은 문구로 찾는다)
export const UNVERIFIED_PREFIX = 'TARGET 이 완전한 덤프인지 확인할 수 없음';
// complete 가 아니면 부재 기반 파괴 문장을 실행하지 않는다
export const holdsAbsenceDrops = (e: SchemaEvidence): boolean => e.level !== 'complete';

const COMPLETE: SchemaEvidence = { level: 'complete', objects: [] };
const incomplete = (reason: string, objects: string[] = []): SchemaEvidence => ({ level: 'incomplete', reason, objects });
const unknown = (reason: string): SchemaEvidence => ({ level: 'unknown', reason, objects: [] });

// diff·DDL 가드가 보는 TARGET 판정. 식별 불가 파싱 실패 문장·객체 0개는 원문 판정과 무관하게 incomplete (어떤 정의를 잃었는지
// 모르거나 잘못된 파일일 수 있다). 원문 판정이 없는 모델(직접 만든 모델·옛 JSON)은 unknown
export function targetEvidence(model: SchemaModel): SchemaEvidence {
  const objects = model.evidence?.objects ?? [];
  if ([...model.tables, ...model.views].some(isUnidentified)) return incomplete('TARGET 에 식별할 수 없는 파싱 실패 문장이 있습니다', objects);
  if (model.evidence?.level === 'incomplete') return model.evidence;
  if (!model.tables.length && !model.views.length && !(model.routines ?? []).length) return incomplete('TARGET 에 객체가 없습니다', objects);
  return model.evidence ?? unknown('원문 판정이 없는 모델입니다 (판정 전에 저장한 버전 등)');
}

// SQL 문장 순서대로 세션 변수 저장·복원을 기록한다. td-export 0.1.30+ 은 헤더(첫 CREATE 앞)에서 FOREIGN_KEY_CHECKS(0.1.52+ 는
// SQL_MODE 도)를 저장하고 파일 끝 트레일러(마지막 CREATE 뒤)에서 되돌린다. 루틴마다의 @OLD_ROUTINE_SQL_MODE 도 저장·복원 쌍이다
export class SqlTrail {
  private readonly open = new Map<string, number>(); // 아직 복원하지 않은 변수(소문자) → 저장한 줄
  private readonly header = new Set<string>(); // 첫 스키마 문장 앞에서 저장한 변수
  private readonly trailer = new Set<string>(); // 마지막 스키마 문장 뒤에서 복원한 변수
  private seenSchema = false;

  set(ddl: string, line: number): void {
    for (const m of ddl.matchAll(RESTORE_RE)) {
      const v = m[1].toLowerCase();
      this.open.delete(v);
      this.trailer.add(v);
    }
    for (const m of ddl.matchAll(SAVE_RE)) {
      const v = m[1].toLowerCase();
      this.open.set(v, line);
      if (!this.seenSchema && v !== ROUTINE_SAVE) this.header.add(v);
    }
  }

  // 스키마 문장(CREATE …): 그 앞의 복원은 트레일러가 아니다
  schema(): void {
    this.seenSchema = true;
    this.trailer.clear();
  }

  get headerSaves(): string[] {
    return [...this.header];
  }

  get pending(): string[] {
    return [...this.open.keys()];
  }

  // 헤더가 저장한 변수 중 하나 이상을 마지막 스키마 문장 뒤에서 되돌렸다
  get hasTrailer(): boolean {
    return [...this.header].some((v) => this.trailer.has(v));
  }
}

export interface SqlFacts {
  named: boolean; // td-export 메타 주석 '/* Database : x */' 가 있음
  nonSchemaLines: number[];
  cut?: { line: number; object?: string }; // 구분자 없이 끝난 마지막 문장
  truncated: boolean; // 문자열·주석 안에서 끝남
  trail: SqlTrail;
}

// SQL 증거. 음성 증거(비스키마 > 끊김 > 트레일러 없음)가 먼저, 헤더(메타 주석·SET)가 없으면 unknown, 헤더·트레일러가 모두 있으면 complete
export function sqlEvidence(f: SqlFacts): SchemaEvidence {
  const objects = f.cut?.object === undefined ? [] : [f.cut.object];
  if (f.nonSchemaLines.length) return incomplete(`스키마 정의가 아닌 문장이 있습니다 (줄 ${f.nonSchemaLines.join(', ')})`, objects);
  if (f.cut) return incomplete(`파일 끝의 문장이 구분자 없이 끊겼습니다 (줄 ${f.cut.line}) — 파일이 잘렸을 수 있습니다`, objects);
  if (f.truncated) return incomplete('파일이 문자열·주석 안에서 끝났습니다 — 파일이 잘렸을 수 있습니다', objects);
  const headerSaves = f.trail.headerSaves;
  if (!headerSaves.length) {
    return unknown('td-export 헤더 SET(@OLD_…)·트레일러가 없습니다 (td-export 0.1.15 형식 등) — 파일 끝을 확인할 수 없어 삭제 문장은 수동 확인입니다');
  }
  const pending = f.trail.pending;
  if (pending.length || !f.trail.hasTrailer) {
    return incomplete(`td-export 트레일러(${(pending.length ? pending : headerSaves).join(', ')} 복원)가 없습니다 — 파일이 잘렸을 수 있습니다`);
  }
  if (!f.named) return unknown('td-export 헤더(/* Database : … */)가 없습니다 — td-export 출력인지 확인할 수 없어 삭제 문장은 수동 확인입니다');
  return COMPLETE;
}

// td-export MD 구조: 1행 스키마 이름(제목)과 '## Table List' 섹션 (td-export 는 2행에 '====…' 를 내지만 손으로 만든 정의서의
// '# 이름' 제목도 받는다 — 객체 목록이 있어야 섹션 누락을 판정할 수 있다)
export const TABLE_LIST_HEADING = 'Table List';

export function hasMdStructure(lines: string[], headings: string[]): boolean {
  return (lines[0] ?? '').trim() !== '' && headings.includes(TABLE_LIST_HEADING);
}

// 표 한 줄의 칸 구분자 수 (이스케이프한 '\|' 제외)
const pipes = (line: string): number => line.replace(/\\\|/g, '').split('|').length - 1;
const isTableRow = (line: string): boolean => line.startsWith('|') && line.endsWith('|') && !line.endsWith('\\|');

// 섹션 본문에 머리글(header 로 시작)·구분 줄·데이터 행 1개 이상인 표가 있다
export function hasTable(body: string[], header: string): boolean {
  const at = body.findIndex((l) => l.startsWith(header));
  return at >= 0 && (body[at + 1] ?? '').startsWith('|---') && isTableRow(body[at + 2] ?? '');
}

// 섹션 끝 상태 (16회차 1): td-export(0.1.15~0.1.52)는 섹션마다 공백 한 칸짜리 줄(' ')로 끝낸다 — 그 줄로 끝나야만 closed.
// 끝 줄 ' ' 은 없지만 마지막 내용 줄이 완결된 줄 — 머리글만큼 칸이 있는 표 행, 완결된 목록 항목(isCompleteItem: Index·FK 줄),
// 코드 블록 닫기(```) — 이면 unmarked: 편집기가 줄 끝 공백을 지운 파일인지 줄 경계에서 잘린 파일인지 구별할 수 없다. 그 밖은 open
export type SectionEnd = 'closed' | 'unmarked' | 'open';

export function sectionEnd(body: string[], isCompleteItem: (line: string) => boolean): SectionEnd {
  const lines = [...body];
  while (lines.length && lines.at(-1)!.trim() === '') {
    if (lines.at(-1) === ' ') return 'closed';
    lines.pop();
  }
  const last = lines.at(-1);
  if (last === undefined) return 'open';
  if (last === '```' || isCompleteItem(last)) return 'unmarked';
  if (!isTableRow(last)) return 'open';
  let head = lines.length - 1;
  while (head > 0 && lines[head - 1].startsWith('|')) head--;
  return lines.length - 1 >= head + 2 && pipes(last) >= pipes(lines[head]) ? 'unmarked' : 'open';
}

// 끝 표식 없는 마지막 섹션의 판정 미상 사유 (화면·문서에서 같은 문구로 찾는다)
export const MD_UNMARKED_REASON = 'MD 끝 표식이 없음 — 편집기가 줄 끝 공백을 지웠다면 원본을 올려 주세요';

export interface MdFacts {
  structured: boolean; // 제목·## Table List
  listed: number; // Table List 항목 수
  schemaSections: number; // 스키마 표가 있는 섹션 수
  missing: string[]; // Table List 에 있는데 섹션이 없는 객체
  tableless: string[]; // 스키마 표가 없는 섹션
  openLast?: string; // 끝나지 않은 마지막 섹션의 객체
  unmarkedLast?: string; // 끝 표식(' ' 줄) 없이 완결된 줄로 끝난 마지막 섹션의 객체
}

// MD 증거와 비스키마 여부 (구조가 없거나, Table List 가 비었거나, 스키마 표가 하나도 없으면 스키마 정의서가 아니다 — 업로드 거부)
export function mdEvidence(f: MdFacts): { evidence: SchemaEvidence; nonSchema: boolean } {
  if (!f.structured) return { evidence: incomplete('td-export MD 구조(스키마 제목·## Table List)가 없습니다 — 스키마 정의서가 아닙니다'), nonSchema: true };
  if (!f.listed || !f.schemaSections) return { evidence: incomplete('Table List 가 비었거나 스키마 표(Columns 표)가 없습니다 — 스키마 정의서가 아닙니다'), nonSchema: true };
  const last = f.openLast === undefined ? [] : [f.openLast];
  if (f.missing.length) return { evidence: incomplete(`Table List 의 객체 섹션이 없습니다 (${f.missing.join(', ')}) — 파일이 잘렸을 수 있습니다`, last), nonSchema: false };
  if (f.tableless.length) {
    return { evidence: incomplete(`스키마 표(Columns 표 머리글 + 1행 이상)가 없는 섹션이 있습니다 (${f.tableless.join(', ')})`, [...new Set([...f.tableless, ...last])]), nonSchema: false };
  }
  if (f.openLast !== undefined) return { evidence: incomplete(`마지막 섹션(${f.openLast})이 끝나지 않았습니다 — 파일이 잘렸을 수 있습니다`, last), nonSchema: false };
  if (f.unmarkedLast !== undefined) return { evidence: unknown(`${MD_UNMARKED_REASON} (마지막 섹션 ${f.unmarkedLast})`), nonSchema: false };
  return { evidence: COMPLETE, nonSchema: false };
}
