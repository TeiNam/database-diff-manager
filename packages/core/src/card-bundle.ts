// 객체 카드 복사 묶음: 그 객체의 문장과, 그 문장들이 새 BASE DB 에서 단독으로 성공하는 데 필요한 다른 객체 문장 (전체 DDL 순서의 부분 집합)
import type { Statement } from './ddl';
import { quoteIdent as q, viewReferences } from './lexer';

type Kind = Statement['kind'];

// 다른 테이블을 바꾸거나 지우는 문장: 그 테이블을 참조하는 FK 가 먼저 풀려야 성공한다 (error 3780·3730)
const blocksIncomingFks = (st: Statement) => st.kind === 'table' && st.op !== 'add' && !st.fkDrops && !st.fkAdds;

// stmts: 전체 DDL. dependencies: 함께 들어간 다른 객체 이름 (이름순)
export function objectStatements(stmts: Statement[], kind: Kind, name: string): { statements: Statement[]; dependencies: string[] } {
  const isOwn = (st: Statement) => st.kind === kind && (st.object === name || Boolean(st.related?.includes(name)));
  const ofTable = (t: string) => stmts.filter((st) => st.kind === 'table' && (st.object === t || Boolean(st.related?.includes(t))));
  // FK 를 추가하기 전에 있어야 하는 테이블 상태: 생성·rename·변경 (FK 문장·DROP TABLE 제외)
  const prepare = (t: string) => ofTable(t).filter((st) => st.op !== 'drop' && !st.fkDrops && !st.fkAdds);
  // 이 테이블을 참조하는 다른 테이블의 FK 해제. 삭제되는 테이블은 해제 문장만, 남는 테이블은 재추가까지 그 테이블 문장 전부
  const incoming = (t: string) => stmts
    .filter((st) => st.kind === 'table' && st.object !== t && Boolean(st.fkDrops?.includes(t)))
    .flatMap((st) => (st.op === 'drop' ? [st] : ofTable(st.object)));
  // 뷰 본문이 참조하는 객체(테이블·뷰·함수)의 생성·변경 문장. 참조는 FROM/JOIN 테이블과 함수 호출만 본다 (별칭·컬럼명·문자열의
  // 같은 이름은 무관하다). 토큰으로 나눌 수 없으면 `이름` 이 나오기만 해도 참조로 본다 (안전 쪽)
  const used = (view: Statement) => {
    const refs = viewReferences(view.sql);
    const reads = (n: string) => (refs ? refs.includes(n) : view.sql.includes(q(n)));
    return stmts.filter((st) => st.object !== view.object && st.op !== 'drop' && reads(st.object))
      .flatMap((st) => (st.kind === 'table' ? prepare(st.object) : [st]));
  };
  // 이름 N 을 차지하는(생성·rename into) 문장 앞에 N 을 비워야 하는 문장: 같은 이름의 다른 종류 객체 삭제(테이블↔뷰 교체)와
  // N 을 다른 이름으로 옮기는 테이블 rename. 빠지면 단독 실행 때 'already exists'·'is not VIEW' 로 실패한다
  const freeing = (st: Statement) => stmts.filter((o) => o !== st
    && ((o.op === 'drop' && o.kind !== st.kind && o.object === st.object) || Boolean(o.frees?.includes(st.object))));

  const picked = new Set<Statement>();
  const queue: Statement[] = [];
  const pick = (list: Statement[]) => {
    for (const st of list) if (!picked.has(st)) { picked.add(st); queue.push(st); }
  };
  pick(stmts.filter(isOwn));
  while (queue.length) {
    const st = queue.pop()!;
    if (st.depends) for (const t of st.depends) pick(ofTable(t));
    if (st.fkAdds) pick([...prepare(st.object), ...st.fkAdds.flatMap(prepare)]);
    if (blocksIncomingFks(st)) pick(incoming(st.object));
    if (st.kind === 'view' && st.op !== 'drop' && !st.comment) pick(used(st));
    if (st.op !== 'drop') pick(freeing(st));
  }
  const statements = stmts.filter((st) => picked.has(st));
  const dependencies = [...new Set(statements.filter((st) => !isOwn(st)).map((st) => st.object))].sort();
  return { statements, dependencies };
}
