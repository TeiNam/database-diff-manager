// SHOW CREATE FUNCTION / PROCEDURE 출력 → Routine 모델 (DEFINER는 비교 대상이 아니므로 버린다)
import { Cursor } from './cursor';
import { tokenize, type LexMode } from './lexer';
import type { Routine, RoutineCharacteristics, RoutineKind } from './model';
import { normalizeBody } from './normalize';

// RETURNS 타입 뒤에 올 수 있는 수식어
const TYPE_MODIFIERS = new Set(['UNSIGNED', 'SIGNED', 'ZEROFILL', 'BINARY', 'ASCII', 'UNICODE', 'PRECISION', 'VARYING']);

export function parseRoutine(ddl: string, mode: LexMode = {}): Routine {
  const { kind, name, params, returns, characteristics, bodyStart } = routineHeader(ddl, mode);
  const body = normalizeBody(ddl.slice(bodyStart), mode);
  return { kind, name, params, ...(returns !== undefined ? { returns } : {}), characteristics, body };
}

interface RoutineHeader extends Pick<Routine, 'kind' | 'name' | 'params' | 'returns' | 'characteristics'> {
  bodyStart: number; // 본문 첫 토큰의 원문 오프셋
}

// CREATE … FUNCTION|PROCEDURE 이름(인자) [RETURNS 타입] [특성…] 까지 읽는다. 본문은 그다음 토큰부터다 (서버 문법과 같다)
export function routineHeader(ddl: string, mode: LexMode = {}): RoutineHeader {
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
  return { kind, name, params, returns, characteristics, bodyStart: start.s };
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

// SHOW CREATE 는 특성 COMMENT 를 SQL_MODE 와 무관하게 일반 escaping 으로 낸다 (NO_BACKSLASH_ESCAPES 루틴도 'C:\\new' —
// 8.4 실측). 그 모드로 토큰을 나눴어도 문자열 원문을 일반 규칙으로 다시 읽는다 (경계는 같다: \ 는 \\, ' 는 '' 로만 나온다)
function showCreateString(c: Cursor): string {
  const tok = c.peek();
  const value = c.string();
  const [plain] = tokenize(c.src.slice(tok!.s, tok!.e));
  return plain?.t === 'string' ? plain.v : value;
}

// 특성은 순서와 무관하게 여러 번 올 수 있다. 특성 키워드가 아닌 첫 토큰부터 본문이다
function readCharacteristics(c: Cursor): RoutineCharacteristics {
  const ch: RoutineCharacteristics = {};
  for (;;) {
    if (c.acceptWord('COMMENT')) ch.comment = showCreateString(c);
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
