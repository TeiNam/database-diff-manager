// SHOW CREATE VIEW 출력 → View 모델 (DEFINER는 비교 대상이 아니므로 버린다)
import { Cursor } from './cursor';
import { tokenize } from './lexer';
import type { View } from './model';

const CHECK_OPTION = /\s+WITH\s+(?:(CASCADED|LOCAL)\s+)?CHECK\s+OPTION$/i;

export function parseCreateView(ddl: string): View {
  const c = new Cursor(tokenize(ddl), ddl);
  c.expectWord('CREATE');
  c.acceptWord('OR', 'REPLACE');
  const view: View = { kind: 'view', name: '', body: '', fidelity: 'full' };
  while (!c.isWord('VIEW')) {
    if (c.acceptWord('ALGORITHM')) { c.expectOp('='); view.algorithm = c.next().v.toUpperCase(); }
    else if (c.acceptWord('DEFINER')) { c.expectOp('='); c.next(); if (c.acceptOp('@')) c.next(); }
    else if (c.acceptWord('SQL', 'SECURITY')) view.security = c.next().v.toUpperCase();
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
  return { ...view, body };
}
