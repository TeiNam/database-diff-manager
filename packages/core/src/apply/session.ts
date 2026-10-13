// SET 문: FOREIGN_KEY_CHECKS·SQL_MODE 만 추적한다 (NAMES 등 나머지는 스키마에 영향이 없어 무시).
// td-export·마이그레이션 스크립트의 'SET @OLD_X = @@X, X = 0' 저장과 'SET X = @OLD_X' 복원을 따른다
import { Cursor } from '../cursor';
import { splitList } from './lists';
import type { State } from './state';
import { DEFAULT_SQL_MODE, fail } from './types';

export function applySet(st: State, c: Cursor): void {
  c.expectWord('SET');
  for (const toks of splitList(c.toks.slice(c.i), 'SET')) assign(st, new Cursor(toks, c.src));
}

function assign(st: State, a: Cursor): void {
  if (a.isWord('NAMES') || a.isWord('CHARACTER') || a.isWord('CHARSET')) return;
  if (a.isWord('GLOBAL') || a.isWord('PERSIST') || a.isWord('PERSIST_ONLY')) fail('SET GLOBAL·PERSIST 는 받을 수 없습니다');
  if (!a.acceptWord('SESSION')) a.acceptWord('LOCAL');
  const target = variable(a);
  if (!a.acceptOp('=')) {
    a.expectOp(':');
    a.expectOp('=');
  }
  const value = valueOf(st, a);
  if (!a.done) fail(`SET 값은 리터럴·@변수·@@변수만 받습니다: ${a.src.slice(a.peek()!.s).trim()}`);
  if (target.startsWith('@')) st.saved.set(target, value);
  else if (target === 'foreign_key_checks') st.fkChecks = !['0', 'OFF'].includes(value.toUpperCase());
  else if (target === 'sql_mode') st.sqlMode = sqlModeOf(value);
}

// '@v' (사용자 변수), '@@[session.]x' 와 'x' (세션 변수, 소문자)
function variable(a: Cursor): string {
  if (!a.acceptOp('@')) return a.ident().toLowerCase();
  return a.acceptOp('@') ? systemName(a) : `@${a.ident().toLowerCase()}`;
}

function systemName(a: Cursor): string {
  const first = a.ident().toLowerCase();
  if (!a.acceptOp('.')) return first;
  if (first === 'global') fail('SET GLOBAL 은 받을 수 없습니다');
  return a.ident().toLowerCase();
}

function valueOf(st: State, a: Cursor): string {
  if (a.acceptOp('@')) {
    if (a.acceptOp('@')) return current(st, systemName(a));
    const name = `@${a.ident().toLowerCase()}`;
    return st.saved.get(name) ?? fail(`값을 저장하지 않은 변수입니다: ${name}`);
  }
  const t = a.next();
  if (t.t === 'string' || t.t === 'number') return t.v;
  if (t.t === 'word') return t.v.toUpperCase();
  return fail(`SET 값을 읽을 수 없습니다: ${t.v}`);
}

const current = (st: State, name: string): string => (name === 'foreign_key_checks' ? (st.fkChecks ? '1' : '0') : name === 'sql_mode' ? st.sqlMode : '');

function sqlModeOf(value: string): string {
  if (value === 'DEFAULT') return DEFAULT_SQL_MODE;
  return /^[A-Za-z_,]*$/.test(value) ? value.toUpperCase() : fail(`SQL_MODE 값을 읽을 수 없습니다: ${value}`);
}
