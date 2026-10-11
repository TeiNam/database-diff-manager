// 모델 → MySQL SHOW CREATE 형식 DDL (세미콜론 없음)
import { quoteIdent as q, quoteString } from './lexer';
import type { Check, Column, ForeignKey, Index, IndexKind, IndexPart, Routine, Table, TableOption, View } from './model';
import { normalizeDdl, routineLexMode } from './normalize';

const KEY_PREFIX: Record<IndexKind, string> = {
  PRIMARY: 'PRIMARY KEY', UNIQUE: 'UNIQUE KEY', INDEX: 'KEY', FULLTEXT: 'FULLTEXT KEY', SPATIAL: 'SPATIAL KEY',
};

// SHOW CREATE 속성 순서: 타입, 문자셋, 콜레이션, GENERATED, NULL, SRID, INVISIBLE, DEFAULT, ON UPDATE, AUTO_INCREMENT, COMMENT
export function printColumn(c: Column, versioned = true): string {
  let s = `${q(c.name)} ${c.type}`;
  if (c.charset) s += ` CHARACTER SET ${c.charset}`;
  if (c.collation) s += ` COLLATE ${c.collation}`;
  if (c.generated) s += ` GENERATED ALWAYS AS (${c.generated.expr}) ${c.generated.stored ? 'STORED' : 'VIRTUAL'}`;
  if (!c.nullable) s += ' NOT NULL';
  else if (/^timestamp\b/i.test(c.type)) s += ' NULL';
  if (c.srid !== undefined) s += versioned ? ` /*!80003 SRID ${c.srid} */` : ` SRID ${c.srid}`;
  if (c.invisible) s += versioned ? ' /*!80023 INVISIBLE */' : ' INVISIBLE';
  if (c.default !== undefined) s += ` DEFAULT ${c.default}`;
  if (c.onUpdate) s += ` ON UPDATE ${c.onUpdate}`;
  if (c.autoIncrement) s += ' AUTO_INCREMENT';
  if (c.comment !== undefined) s += ` COMMENT ${quoteString(c.comment)}`;
  return s;
}

export function printIndexParts(parts: IndexPart[]): string {
  const items = parts.map((p) => {
    const base = p.expr !== undefined ? `(${p.expr})` : q(p.column ?? '') + (p.length ? `(${p.length})` : '');
    return base + (p.desc ? ' DESC' : '');
  });
  return `(${items.join(',')})`;
}

export function printIndex(i: Index): string {
  let s = KEY_PREFIX[i.kind] + (i.kind === 'PRIMARY' ? '' : ` ${q(i.name)}`) + ` ${printIndexParts(i.parts)}`;
  if (i.using) s += ` USING ${i.using}`;
  if (i.parser) s += ` /*!50100 WITH PARSER ${q(i.parser)} */`;
  if (i.comment !== undefined) s += ` COMMENT ${quoteString(i.comment)}`;
  if (i.invisible) s += ' /*!80000 INVISIBLE */';
  return s;
}

export function printForeignKey(f: ForeignKey): string {
  const ref = (f.refSchema ? `${q(f.refSchema)}.` : '') + q(f.refTable);
  let s = `CONSTRAINT ${q(f.name)} FOREIGN KEY (${f.columns.map(q).join(', ')}) REFERENCES ${ref} (${f.refColumns.map(q).join(', ')})`;
  if (f.onDelete) s += ` ON DELETE ${f.onDelete}`;
  if (f.onUpdate) s += ` ON UPDATE ${f.onUpdate}`;
  return s;
}

export function printCheck(c: Check, versioned = true): string {
  const enforced = c.enforced ? '' : versioned ? ' /*!80016 NOT ENFORCED */' : ' NOT ENFORCED';
  return `CONSTRAINT ${q(c.name)} CHECK (${c.expr})${enforced}`;
}

const printOption = (o: TableOption): string => `${o.key}=${o.value}`;

export function printTable(t: Table, opts: { foreignKeys?: boolean } = {}): string {
  if (t.parseError && t.rawDdl) return normalizeDdl(t.rawDdl);
  const items = [
    ...t.columns.map((c) => printColumn(c)),
    ...t.indexes.map(printIndex),
    ...(opts.foreignKeys === false ? [] : t.foreignKeys.map(printForeignKey)),
    ...t.checks.map((c) => printCheck(c)),
  ];
  let s = `CREATE TABLE ${q(t.name)} (\n${items.map((x) => `  ${x}`).join(',\n')}\n)`;
  if (t.options.length) s += ` ${t.options.map(printOption).join(' ')}`;
  if (t.partition) s += `\n/*!${t.partition.version} ${t.partition.clause} */`;
  return s;
}

export function printView(v: View, opts: { orReplace?: boolean } = {}): string {
  if (v.parseError && v.rawDdl) return normalizeDdl(v.rawDdl);
  let s = opts.orReplace ? 'CREATE OR REPLACE' : 'CREATE';
  if (v.algorithm) s += ` ALGORITHM=${v.algorithm}`;
  if (v.security) s += ` SQL SECURITY ${v.security}`;
  s += ` VIEW ${q(v.name)}`;
  if (v.columnList) s += ` (${v.columnList})`;
  s += ` AS ${v.body}`;
  if (v.checkOption) s += ` WITH ${v.checkOption} CHECK OPTION`;
  return s;
}

// SHOW CREATE FUNCTION/PROCEDURE 형식 (DEFINER 없이). 특성 순서는 MySQL sp.cc 와 같고 기본값 특성은 찍지 않는다.
// executable: 루틴의 SQL_MODE 로 실행할 생성 문장. NO_BACKSLASH_ESCAPES 면 COMMENT 의 백슬래시를 이스케이프하지 않고 ' 만 두 배로 쓴다
// (SHOW CREATE 처럼 'C:\\new' 로 쓰면 그 모드에서는 백슬래시 두 개로 저장된다)
export function printRoutine(r: Routine, opts: { executable?: boolean } = {}): string {
  if (r.parseError && r.rawDdl) return normalizeDdl(r.rawDdl);
  const ch = r.characteristics;
  let s = `CREATE ${r.kind.toUpperCase()} ${q(r.name)}(${r.params})`;
  if (r.kind === 'function' && r.returns !== undefined) s += ` RETURNS ${r.returns}`;
  s += '\n';
  if (ch.dataAccess && ch.dataAccess !== 'CONTAINS SQL') s += `    ${ch.dataAccess}\n`;
  if (ch.deterministic) s += '    DETERMINISTIC\n';
  if (ch.security === 'INVOKER') s += '    SQL SECURITY INVOKER\n';
  if (ch.comment) s += `    COMMENT ${quoteRoutineComment(ch.comment, opts.executable === true && routineLexMode(r.sqlMode).noBackslashEscapes === true)}\n`;
  return s + r.body;
}

const quoteRoutineComment = (value: string, noBackslashEscapes: boolean): string =>
  (noBackslashEscapes ? `'${value.replace(/'/g, "''")}'` : quoteString(value));
