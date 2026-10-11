// SHOW CREATE FUNCTION / PROCEDURE 출력 → Routine 모델 (DEFINER는 비교 대상이 아니므로 버린다)
import { Cursor } from './cursor';
import { tokenize, type LexMode } from './lexer';
import type { Routine, RoutineCharacteristics, RoutineKind } from './model';
import { normalizeBody } from './normalize';

// RETURNS 타입 뒤에 올 수 있는 수식어
const TYPE_MODIFIERS = new Set(['UNSIGNED', 'SIGNED', 'ZEROFILL', 'BINARY', 'ASCII', 'UNICODE', 'PRECISION', 'VARYING']);

export function parseRoutine(ddl: string, mode: LexMode = {}): Routine {
  const c = new Cursor(tokenize(ddl, mode), ddl);
  c.expectWord('CREATE');
  if (c.acceptWord('DEFINER')) skipDefiner(c);
  const kind: RoutineKind = c.acceptWord('FUNCTION') ? 'function' : c.acceptWord('PROCEDURE') ? 'procedure' : fail(c, 'FUNCTION 또는 PROCEDURE 필요');
  const name = c.ident();
  const params = c.parenRaw();
  const returns = kind === 'function' ? returnsType(c) : undefined;
  const characteristics = readCharacteristics(c);
  const start = c.peek();
  if (!start) throw c.error('루틴 본문 없음');
  const body = normalizeBody(ddl.slice(start.s), mode);
  return { kind, name, params, ...(returns !== undefined ? { returns } : {}), characteristics, body };
}

const fail = (c: Cursor, message: string): never => {
  throw c.error(message);
};

// DEFINER = `user`@`host` | CURRENT_USER[()]
function skipDefiner(c: Cursor): void {
  c.expectOp('=');
  c.next();
  if (c.acceptOp('@')) c.next();
  else if (c.isOp('(')) c.parenRaw();
}

// RETURNS 타입 원문: 타입 이름, (길이), 수식어, CHARSET/CHARACTER SET x, COLLATE x
function returnsType(c: Cursor): string {
  c.expectWord('RETURNS');
  const first = c.next();
  if (first.t !== 'word') throw c.error('RETURNS 타입 필요', first);
  let last = first;
  for (;;) {
    if (c.isOp('(')) {
      c.next();
      last = c.closeParen();
    } else if (c.isWord('CHARACTER', 'SET')) {
      c.i += 2;
      last = c.next();
    } else if (c.isWord('CHARSET') || c.isWord('COLLATE')) {
      c.i++;
      last = c.next();
    } else if (c.peek()?.t === 'word' && TYPE_MODIFIERS.has(c.peek()!.v.toUpperCase())) {
      last = c.next();
    } else {
      break;
    }
  }
  return c.src.slice(first.s, last.e);
}

// 특성은 순서와 무관하게 여러 번 올 수 있다. 특성 키워드가 아닌 첫 토큰부터 본문이다
function readCharacteristics(c: Cursor): RoutineCharacteristics {
  const ch: RoutineCharacteristics = {};
  for (;;) {
    if (c.acceptWord('COMMENT')) ch.comment = c.string();
    else if (c.acceptWord('LANGUAGE', 'SQL')) ch.language = 'SQL';
    else if (c.acceptWord('NOT', 'DETERMINISTIC')) ch.deterministic = false;
    else if (c.acceptWord('DETERMINISTIC')) ch.deterministic = true;
    else if (c.acceptWord('CONTAINS', 'SQL')) ch.dataAccess = 'CONTAINS SQL';
    else if (c.acceptWord('NO', 'SQL')) ch.dataAccess = 'NO SQL';
    else if (c.acceptWord('READS', 'SQL', 'DATA')) ch.dataAccess = 'READS SQL DATA';
    else if (c.acceptWord('MODIFIES', 'SQL', 'DATA')) ch.dataAccess = 'MODIFIES SQL DATA';
    else if (c.acceptWord('SQL', 'SECURITY', 'DEFINER')) ch.security = 'DEFINER';
    else if (c.acceptWord('SQL', 'SECURITY', 'INVOKER')) ch.security = 'INVOKER';
    else return ch;
  }
}
