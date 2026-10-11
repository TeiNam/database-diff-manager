// 객체 카드 복사 묶음: 그 객체의 문장과, 그 문장들이 새 BASE DB 에서 단독으로 성공하는 데 필요한 다른 객체 문장 (전체 DDL 순서의 부분 집합)
import type { Statement } from './ddl';
import { routineNameKey } from './diff';

type Kind = Statement['kind'];

// 테이블과 뷰는 같은 이름 공간을 쓴다 (함수·프로시저는 각자 별개)
const isRelation = (kind: Kind) => kind === 'table' || kind === 'view';

// 다른 테이블을 바꾸거나 지우는 문장: 그 테이블을 참조하는 FK 가 먼저 풀려야 성공한다 (error 3780·3730)
const blocksIncomingFks = (st: Statement) => st.kind === 'table' && st.op !== 'add' && !st.fkDrops && !st.fkAdds;

// stmts: 전체 DDL. dependencies: 함께 들어간 다른 객체 이름 (이름순)
export function objectStatements(stmts: Statement[], kind: Kind, name: string): { statements: Statement[]; dependencies: string[] } {
  const isOwn = (st: Statement) => st.kind === kind && (st.object === name || Boolean(st.related?.includes(name)));
  const ofTable = (t: string) => stmts.filter((st) => st.kind === 'table' && (st.object === t || Boolean(st.related?.includes(t))));
  // 포함 관계 닫힘: 카드에 테이블 문장이 하나라도 들어가면 그 테이블의 문장 전부(FK 해제·재추가 포함, DROP TABLE 제외)를 넣는다.
  // FK 해제 없이 FK 컬럼을 바꾸는 ALTER 는 실패하고(error 1828·1553), 생성만 넣고 FK 추가를 빼면 TARGET 과 다른 테이블이 된다.
  // 넣은 문장의 의존(FK 부모, fk-retype 묶음, 들어오는 FK 해제 …)은 아래 고정점 반복이 다시 넓힌다
  const closure = (t: string) => ofTable(t).filter((st) => !(st.op === 'drop' && !st.fkDrops));
  // 이 테이블을 참조하는 다른 테이블의 FK 해제. 삭제되는 테이블은 해제 문장만, 남는 테이블은 재추가까지 그 테이블 문장 전부
  const incoming = (t: string) => stmts
    .filter((st) => st.kind === 'table' && st.object !== t && Boolean(st.fkDrops?.includes(t)))
    .flatMap((st) => (st.op === 'drop' ? [st] : ofTable(st.object)));
  // 뷰 본문이 참조하는 객체의 생성·변경 문장. 참조는 뷰 생성 순서와 같은 토큰 기반 판정이다 (objectReferences). FROM/JOIN 참조(reads)는
  // 테이블·뷰 문장만, 함수 호출(calls, 대소문자 무시)은 함수 문장만 묶는다 — 함수 f() 만 부르는 뷰에 테이블 f 의 DROP COLUMN 을 넣지 않는다.
  // 자기 자신(같은 종류·이름)만 빼므로 같은 이름의 함수를 부르는 뷰는 그 함수 생성을 포함한다
  const used = (view: Statement) => {
    const reads = new Set(view.reads ?? []);
    const calls = new Set((view.calls ?? []).map(routineNameKey));
    const isUsed = (st: Statement) => (isRelation(st.kind) ? reads.has(st.object) : st.kind === 'function' && calls.has(routineNameKey(st.object)));
    return stmts.filter((st) => !(st.kind === view.kind && st.object === view.object) && st.op !== 'drop' && isUsed(st))
      .flatMap((st) => (st.kind === 'table' ? closure(st.object) : [st]));
  };
  // 이름 N 을 차지하는(생성·rename into) 문장 앞에 N 을 비워야 하는 문장: 같은 이름 공간(테이블·뷰는 공유, 함수·프로시저는 별개)의
  // 다른 종류 객체 삭제(테이블↔뷰 교체)와 N 을 다른 이름으로 옮기는 테이블 rename. 빠지면 단독 실행 때 'already exists'·'is not VIEW'
  // 로 실패한다. 다른 이름 공간의 삭제를 넣으면 무관한 객체를 지운다 (테이블 p 삭제 + 프로시저 p 추가)
  const freeing = (st: Statement) => (isRelation(st.kind) ? stmts.filter((o) => o !== st && isRelation(o.kind)
    && ((o.op === 'drop' && o.kind !== st.kind && o.object === st.object) || Boolean(o.frees?.includes(st.object)))) : []);

  const picked = new Set<Statement>();
  const queue: Statement[] = [];
  const pick = (list: Statement[]) => {
    for (const st of list) if (!picked.has(st)) { picked.add(st); queue.push(st); }
  };
  pick(stmts.filter(isOwn));
  while (queue.length) {
    const st = queue.pop()!;
    if (st.depends) for (const t of st.depends) pick(ofTable(t));
    if (st.kind === 'table' && !(st.op === 'drop' && !st.fkDrops)) pick((st.related ?? [st.object]).flatMap(closure));
    if (st.fkAdds) pick(st.fkAdds.flatMap(closure));
    if (blocksIncomingFks(st)) pick(incoming(st.object));
    if (st.kind === 'view' && st.op !== 'drop' && !st.comment) pick(used(st));
    if (st.op !== 'drop') pick(freeing(st));
  }
  const statements = stmts.filter((st) => picked.has(st));
  const dependencies = [...new Set(statements.filter((st) => !isOwn(st)).map((st) => st.object))].sort();
  return { statements, dependencies };
}
