// partial(MD) 출처 TARGET의 알 수 없는 속성을 BASE 값으로 보완한다.
// 보완하지 못한 속성은 DDL 문장별 안내(notes)로 남기고, 생성 컬럼 표현식처럼 SQL을 만들 수 없으면 수동 확인으로 돌린다
import { quoteIdent as q } from './lexer';
import type { Column, ColumnField, Index, IndexField, IndexKind, IndexPart, Table } from './model';

const STRING_TYPE = /^((var)?char|(tiny|medium|long)?text|enum|set)\b/i;
const SPATIAL_TYPE = /^(geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geomcollection|geometrycollection)\b/i;
const INDEX_COPY_FIELDS = ['kind', 'using', 'parser', 'comment', 'invisible'] as const;
// 안내할 인덱스 속성 (InnoDB에서 의미 없는 using, FULLTEXT 전용 parser는 제외)
const INDEX_NOTE_FIELDS: IndexField[] = ['kind', 'partDetails', 'partOrder', 'comment', 'invisible'];
export const GENERATED_PLACEHOLDER = '/* 표현식 미상 */';
export const NOTE_PREFIX = '[MD 기반 미확인]';

export const isStringType = (type: string): boolean => STRING_TYPE.test(type);

// MD의 Normal: 0.1.19+(키 파트 상세를 출력)는 INDEX와 UNIQUE 중 무엇인지만 모르므로 FULLTEXT·SPATIAL과의 차이는 확실하다.
// 그 이전(partDetails 미상)은 FULLTEXT·SPATIAL도 Normal로 출력해 계열도 알 수 없다
const kindFamily = (k: IndexKind): string => (k === 'INDEX' || k === 'UNIQUE' ? 'BTREE' : k);
const isFamilyKnown = (i: Index): boolean => !i.unknown?.includes('partDetails');
export const isOtherKindFamily = (a: Index, b: Index): boolean =>
  isFamilyKnown(a) && isFamilyKnown(b) && kindFamily(a.kind) !== kindFamily(b.kind);

// 컬럼 타입에 해당하지 않는 속성(문자열이 아닌 컬럼의 charset 등)은 결과에 영향이 없다
function isRelevant(col: Column, f: ColumnField): boolean {
  if (f === 'charset' || f === 'collation') return isStringType(col.type);
  if (f === 'srid') return SPATIAL_TYPE.test(col.type);
  return true;
}

function canFill(f: ColumnField, from: Column): boolean {
  if (from.unknown?.includes(f)) return false;
  if (f === 'charset' || f === 'collation') return isStringType(from.type);
  if (f === 'generated') return from.generated !== undefined;
  return true;
}

function filledValue(f: ColumnField, to: Column, from: Column): Partial<Column> {
  if (f === 'generated') return { generated: { expr: from.generated!.expr, stored: to.generated?.stored ?? from.generated!.stored } };
  return { [f]: from[f] };
}

// TARGET 컬럼의 unknown 속성을 BASE 컬럼 값으로 채운 새 객체. 남은 unknown은 의미 있는 속성만 둔다
export function fillColumn(to: Column, from?: Column): Column {
  if (!to.unknown?.length) return to;
  let filled: Column = { ...to };
  const remaining: ColumnField[] = [];
  for (const f of to.unknown) {
    if (from && canFill(f, from)) filled = { ...filled, ...filledValue(f, to, from) };
    else if (isRelevant(to, f)) remaining.push(f);
  }
  const { unknown: _, ...rest } = filled;
  return remaining.length ? { ...rest, unknown: remaining } : rest;
}

const partNames = (i: Index) => i.parts.map((p) => p.column ?? p.expr ?? '');
const sameList = (a: string[], b: string[]) => a.join('\n') === b.join('\n');

// 키 파트를 BASE에서 가져온다: partOrder는 같은 컬럼 집합, partDetails(prefix 길이·DESC)는 같은 컬럼 목록일 때
function fillParts(f: IndexField, to: Index, from: Index): IndexPart[] | undefined {
  if (f === 'partOrder') return sameList([...partNames(to)].sort(), [...partNames(from)].sort()) ? from.parts : undefined;
  if (f === 'partDetails') return sameList(partNames(to), partNames(from)) ? from.parts : undefined;
  return undefined;
}

export function fillIndex(to: Index, from?: Index): Index {
  if (!to.unknown?.length) return to;
  let filled: Index = { ...to };
  const remaining: IndexField[] = [];
  for (const f of to.unknown) {
    // 종류가 다른 계열(FULLTEXT → Normal 등)이면 BASE 종류로 채우지 않는다
    const known = from !== undefined && !from.unknown?.includes(f) && !(f === 'kind' && isOtherKindFamily(to, from));
    const parts = known ? fillParts(f, filled, from) : undefined;
    if (known && (INDEX_COPY_FIELDS as readonly string[]).includes(f)) filled = { ...filled, [f]: from[f as (typeof INDEX_COPY_FIELDS)[number]] };
    else if (parts) filled = { ...filled, parts };
    else remaining.push(f);
  }
  const { unknown: _, ...rest } = filled;
  return remaining.length ? { ...rest, unknown: remaining } : rest;
}

export const hasUnknownGenerated = (c: Column): boolean => Boolean(c.unknown?.includes('generated'));

// 생성 컬럼 표현식을 모르면 자리표시자로 출력한다 (수동 확인 문장 안에서만 쓴다)
export const printable = (c: Column): Column =>
  (hasUnknownGenerated(c) ? { ...c, generated: { expr: GENERATED_PLACEHOLDER, stored: c.generated?.stored ?? false } } : c);

export function columnNote(c: Column): string | undefined {
  const fields = (c.unknown ?? []).filter((f) => f !== 'generated');
  return fields.length ? `${NOTE_PREFIX} 컬럼 ${q(c.name)}: ${fields.join(', ')}` : undefined;
}

export function indexNote(i: Index): string | undefined {
  // 단일 컬럼의 순서, PK의 가시성(항상 VISIBLE)은 결과에 영향이 없다
  const irrelevant = (f: IndexField) => (f === 'partOrder' && i.parts.length < 2) || (f === 'invisible' && i.kind === 'PRIMARY');
  const fields = (i.unknown ?? []).filter((f) => INDEX_NOTE_FIELDS.includes(f) && !irrelevant(f));
  return fields.length ? `${NOTE_PREFIX} 인덱스 ${q(i.name)}: ${fields.join(', ')}` : undefined;
}

export function tableNote(t: Table): string | undefined {
  const fields = t.unknown ?? [];
  return fields.length ? `${NOTE_PREFIX} 테이블 ${q(t.name)}: ${fields.join(', ')} (DDL에 포함하지 않음)` : undefined;
}

export const generatedReason = (table: string, columns: string[]): string =>
  `${table}: 생성 컬럼(${columns.map(q).join(', ')})의 표현식을 알 수 없습니다. ${GENERATED_PLACEHOLDER}를 채운 뒤 실행하세요`;
