// SHOW CREATE VIEW 출력 → View 모델 (DEFINER는 비교 대상이 아니므로 버린다)
import { Cursor } from './cursor';
import { tokenize } from './lexer';
import type { View } from './model';
import { assertExpression, UnsafeValueError } from './sql-safety';

const CHECK_OPTION = /\s+WITH\s+(?:(CASCADED|LOCAL)\s+)?CHECK\s+OPTION$/i;
const ALGORITHMS = ['UNDEFINED', 'MERGE', 'TEMPTABLE'];
const SECURITIES = ['DEFINER', 'INVOKER'];

// strict: 출처가 SHOW CREATE 가 아닌 텍스트(MD 의 View Create SQL 블록)라 본문의 주석도 거부한다.
// 출처와 무관하게 본문·컬럼 목록에 문장 끝(;)·괄호 불균형·클라이언트 명령이 있으면 거부한다 (주입 방지, sql-safety)
export interface ViewParseOptions {
  strict?: boolean;
}

export function parseCreateView(ddl: string, opts: ViewParseOptions = {}): View {
  const c = new Cursor(tokenize(ddl), ddl);
  c.expectWord('CREATE');
  c.acceptWord('OR', 'REPLACE');
  const view: View = { kind: 'view', name: '', body: '', fidelity: 'full' };
  while (!c.isWord('VIEW')) {
    if (c.acceptWord('ALGORITHM')) { c.expectOp('='); view.algorithm = oneOf(c, ALGORITHMS); }
    else if (c.acceptWord('DEFINER')) { c.expectOp('='); c.next(); if (c.acceptOp('@')) c.next(); }
    else if (c.acceptWord('SQL', 'SECURITY')) view.security = oneOf(c, SECURITIES);
    else throw c.error('알 수 없는 뷰 옵션');
  }
  c.expectWord('VIEW');
  view.name = c.ident();
  if (c.isOp('(')) view.columnList = c.parenRaw();
  c.expectWord('AS');
  const start = c.peek();
  if (!start) throw c.error('뷰 본문 없음');
  let body = ddl.slice(start.s).trim().replace(/;$/, '').trimEnd();
  const m = CHECK_OPTION.exec(body);
  if (m) {
    view.checkOption = (m[1] ?? 'CASCADED').toUpperCase();
    body = body.slice(0, m.index);
  }
  try {
    if (view.columnList !== undefined) assertExpression(view.columnList, '뷰 컬럼 목록');
    assertExpression(body, '뷰 본문', { allowComments: opts.strict !== true });
  } catch (e) {
    if (e instanceof UnsafeValueError) throw c.error(e.message, start);
    throw e;
  }
  return { ...view, body };
}

function oneOf(c: Cursor, values: string[]): string {
  const t = c.next();
  const v = t.v.toUpperCase();
  if (t.t !== 'word' || !values.includes(v)) throw c.error(`${values.join('|')} 필요`, t);
  return v;
}
