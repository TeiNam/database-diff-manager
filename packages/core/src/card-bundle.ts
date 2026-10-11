// 객체 카드 복사 묶음: 그 객체의 문장과, 그 문장들이 새 BASE DB 에서 단독으로 성공하는 데 필요한 다른 객체 문장 (전체 DDL 순서의 부분 집합)
import type { Statement } from './ddl';
import { quoteIdent as q } from './lexer';

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
  // 뷰 본문이 참조하는 객체(테이블·뷰·함수)의 생성·변경 문장
  const used = (view: Statement) => stmts.filter((st) => st.object !== view.object && st.op !== 'drop' && view.sql.includes(q(st.object)))
    .flatMap((st) => (st.kind === 'table' ? prepare(st.object) : [st]));

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
  }
  const statements = stmts.filter((st) => picked.has(st));
  const dependencies = [...new Set(statements.filter((st) => !isOwn(st)).map((st) => st.object))].sort();
  return { statements, dependencies };
}
