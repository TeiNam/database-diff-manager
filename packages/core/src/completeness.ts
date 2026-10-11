// 덤프 원문이 완전한 td-export 스키마 출력인지 판정 (14회차 1). 확인하지 못하면 SchemaModel.incomplete 로 표시하고,
// TARGET 이면 diff·DDL 가드가 파괴적 문장(객체 DROP·DROP COLUMN)과 끊긴 객체의 문장을 수동 확인으로 돌린다
import type { SchemaIncomplete } from './model';

// td-export SQL 이 내는 문장 종류. other(ALTER·INSERT·DROP 등)는 스키마 정의가 아니다
export type SqlStatementKind = 'set' | 'routine' | 'view' | 'table' | 'other';

const CREATE_TABLE_RE = /^CREATE\s+TABLE\s/i;
const SAVE_RE = /(@OLD_\w+)\s*=\s*@@\w+/gi; // SET @OLD_X = @@X: 헤더(또는 루틴 앞)가 세션 값을 저장한다
const RESTORE_RE = /=\s*(@OLD_\w+)\s*(?:,|$)/gi; // SET X = @OLD_X: 트레일러(또는 루틴 뒤)가 되돌린다

export const isCreateTable = (ddl: string): boolean => CREATE_TABLE_RE.test(ddl);

// 저장한 세션 변수 중 아직 복원하지 않은 것. td-export 0.1.30+ 은 헤더에서 FOREIGN_KEY_CHECKS(0.1.52+ 는 SQL_MODE 도)를 저장하고
// 파일 끝 트레일러에서 되돌린다. 0.1.15 는 헤더 SET 이 없어 이 검사로는 아무것도 요구하지 않는다
export class SessionSaves {
  private readonly open = new Map<string, number>(); // 변수(소문자) → 저장한 줄

  apply(ddl: string, line: number): void {
    for (const m of ddl.matchAll(RESTORE_RE)) this.open.delete(m[1].toLowerCase());
    for (const m of ddl.matchAll(SAVE_RE)) this.open.set(m[1].toLowerCase(), line);
  }

  get pending(): string[] {
    return [...this.open.keys()];
  }
}

// SQL 판정 결과 → incomplete. 사유는 우선순위 순서로 하나만 쓴다 (비스키마 > 끊긴 문장 > 트레일러 없음)
export function sqlIncomplete(opts: { nonSchemaLines: number[]; cut?: { line: number; object?: string }; truncated: boolean; pendingSaves: string[] }): SchemaIncomplete | undefined {
  const objects = opts.cut?.object === undefined ? [] : [opts.cut.object];
  if (opts.nonSchemaLines.length) return { reason: `스키마 정의가 아닌 문장이 있습니다 (줄 ${opts.nonSchemaLines.join(', ')})`, objects };
  if (opts.cut) return { reason: `파일 끝의 문장이 구분자 없이 끊겼습니다 (줄 ${opts.cut.line}) — 파일이 잘렸을 수 있습니다`, objects };
  if (opts.truncated) return { reason: '파일이 문자열·주석 안에서 끝났습니다 — 파일이 잘렸을 수 있습니다', objects };
  if (opts.pendingSaves.length) return { reason: `td-export 트레일러(${opts.pendingSaves.join(', ')} 복원)가 없습니다 — 파일이 잘렸을 수 있습니다`, objects };
  return undefined;
}

// td-export MD 구조: 1행 스키마 이름(제목)과 '## Table List' 섹션 (td-export 는 2행에 '====…' 를 내지만 손으로 만든 정의서의
// '# 이름' 제목도 받는다 — 객체 목록이 있어야 섹션 누락을 판정할 수 있다)
export const TABLE_LIST_HEADING = 'Table List';

export function hasMdStructure(lines: string[], headings: string[]): boolean {
  return (lines[0] ?? '').trim() !== '' && headings.includes(TABLE_LIST_HEADING);
}

// td-export 는 섹션마다 공백 한 칸짜리 줄(' ')로 끝낸다. 마지막 섹션에 그 줄이 없으면 표가 중간에 끊겼을 수 있다
export function isClosedSection(body: string[]): boolean {
  const lines = [...body];
  while (lines.length && lines.at(-1) === '') lines.pop();
  return lines.at(-1) === ' ';
}

export function mdIncomplete(opts: { structured: boolean; missing: string[]; openLast?: string }): SchemaIncomplete | undefined {
  const objects = opts.openLast === undefined ? [] : [opts.openLast];
  if (!opts.structured) return { reason: 'td-export MD 구조(스키마 제목·## Table List)가 없습니다 — 스키마 정의서가 아닙니다', objects };
  if (opts.missing.length) return { reason: `Table List 의 객체 섹션이 없습니다 (${opts.missing.join(', ')}) — 파일이 잘렸을 수 있습니다`, objects };
  if (opts.openLast !== undefined) return { reason: `마지막 섹션(${opts.openLast})이 끝나지 않았습니다 — 파일이 잘렸을 수 있습니다`, objects };
  return undefined;
}
