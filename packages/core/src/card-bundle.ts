// 객체 카드 복사 묶음: 그 객체의 문장과, 그 문장들이 새 BASE DB 에서 단독으로 성공하는 데 필요한 다른 객체 문장 (전체 DDL 순서의 부분 집합)
import type { Statement } from './ddl';
import { routineNameKey, type Change, type SchemaDiff, type TableDiff } from './diff';
import type { Column } from './model';

type Kind = Statement['kind'];

// 테이블과 뷰는 같은 이름 공간을 쓴다 (함수·프로시저는 각자 별개)
const isRelation = (kind: Kind) => kind === 'table' || kind === 'view';

// 문장이 다루는 모든 이름: 얽힌 rename(맞바꾸기·연쇄)은 object 하나에 related 로 여러 테이블을 묶는다. 의존 매칭은 모두 이 이름들로 한다
const namesOf = (st: Statement): string[] => st.related ?? [st.object];

// 다른 테이블을 바꾸거나 지우는 문장: 그 테이블을 참조하는 FK 가 먼저 풀려야 성공한다 (error 3780·3730).
// 들어오는 FK 가 쓰는 컬럼·키를 건드리지 않는 변경(keepsIncomingFks — 컬럼 추가 등)은 빼서, 부모 카드가 자식 FK 만 지우지 않게 한다
const blocksIncomingFks = (st: Statement) => st.kind === 'table' && st.op !== 'add' && !st.fkDrops && !st.fkAdds && !st.keepsIncomingFks;

// 들어오는 FK(카드에 해제 문장이 생기는 FK: 삭제되는 테이블의 FK 전부, 바뀌는 테이블의 삭제·변경 FK)와 충돌하지 않는 변경 테이블 (TARGET 이름).
// 충돌: 테이블 rename·삭제, 파싱 실패, 파티션·옵션(COMMENT 제외 — 엔진·문자셋 변환 등) 변경, 참조 컬럼의 삭제와 FK 를 유지할 수 없는
// 변경(타입·문자셋·콜레이션·NULL 성 등 FK_KEEPING_FIELDS 밖), 참조 컬럼을 담은 인덱스의 삭제·변경·rename. 참조 컬럼의 단순 rename·
// COMMENT·DEFAULT 변경·위치 이동은 InnoDB 가 자식 FK 를 유지·따라 옮긴다 (8.4 실측, 14회차 2). fk-retype 묶음은 depends 로 따로 묶인다
export function incomingFkSafeTables(diff: SchemaDiff): Set<string> {
  const referenced = new Map<string, Set<string>>(); // BASE 테이블 → 들어오는 FK 의 참조 컬럼
  for (const d of diff.tables) {
    const fks = d.op === 'drop' ? d.from?.foreignKeys ?? [] : d.foreignKeys.filter((f) => f.op === 'drop' || f.op === 'modify').flatMap((f) => (f.from ? [f.from] : []));
    for (const fk of fks) {
      if (fk.refSchema !== undefined) continue;
      const cols = referenced.get(fk.refTable) ?? new Set<string>();
      for (const c of fk.refColumns) cols.add(c);
      referenced.set(fk.refTable, cols);
    }
  }
  return new Set(diff.tables.filter((d) => d.op === 'modify' && !conflictsWithIncoming(d, referenced.get(d.name))).map((d) => d.name));
}

// 참조 컬럼에서 바뀌어도 자식 FK 가 유지되는 속성 (rename 은 op 로 따로 본다)
const FK_KEEPING_FIELDS: ReadonlySet<string> = new Set(['comment', 'default']);
const keepsFk = (c: Change<Column>): boolean => (c.op === 'modify' || c.op === 'rename') && c.fields.every((f) => FK_KEEPING_FIELDS.has(f));

function conflictsWithIncoming(d: TableDiff, cols: ReadonlySet<string> | undefined): boolean {
  if (!cols) return false;
  if (d.unparsed || d.from?.parseError || d.to?.parseError || d.partition) return true;
  if (d.options.some((o) => o.key !== 'COMMENT')) return true;
  const hits = (name: string | undefined) => name !== undefined && cols.has(name);
  if (d.columns.some((c) => c.op !== 'add' && hits(c.from?.name) && !keepsFk(c))) return true;
  return d.indexes.some((i) => i.op !== 'add' && (i.from?.parts ?? []).some((p) => hits(p.column)));
}

// stmts: 전체 DDL. dependencies: 함께 들어간 다른 객체 이름 (이름순)
export function objectStatements(stmts: Statement[], kind: Kind, name: string): { statements: Statement[]; dependencies: string[] } {
  const isOwn = (st: Statement) => st.kind === kind && (st.object === name || namesOf(st).includes(name));
  const ofTable = (t: string) => stmts.filter((st) => st.kind === 'table' && (st.object === t || namesOf(st).includes(t)));
  // 포함 관계 닫힘: 카드에 테이블 문장이 하나라도 들어가면 그 테이블의 문장 전부(FK 해제·재추가 포함, DROP TABLE 제외)를 넣는다.
  // FK 해제 없이 FK 컬럼을 바꾸는 ALTER 는 실패하고(error 1828·1553), 생성만 넣고 FK 추가를 빼면 TARGET 과 다른 테이블이 된다.
  // 넣은 문장의 의존(FK 부모, fk-retype 묶음, 들어오는 FK 해제 …)은 아래 고정점 반복이 다시 넓힌다
  const closure = (t: string) => ofTable(t).filter((st) => !(st.op === 'drop' && !st.fkDrops));
  // 이 테이블을 참조하는 다른 테이블의 FK 해제. 삭제되는 테이블은 해제 문장만, 남는 테이블은 재추가까지 그 테이블 문장 전부
  const incoming = (t: string) => stmts
    .filter((st) => st.kind === 'table' && !namesOf(st).includes(t) && Boolean(st.fkDrops?.includes(t)))
    .flatMap((st) => (st.op === 'drop' ? [st] : ofTable(st.object)));
  // 뷰 본문이 참조하는 객체의 생성·변경 문장. 참조는 뷰 생성 순서와 같은 토큰 기반 판정이다 (objectReferences). FROM/JOIN 참조(reads)는
  // 테이블·뷰 문장만, 함수 호출(calls, 대소문자 무시)은 함수 문장만 묶는다 — 함수 f() 만 부르는 뷰에 테이블 f 의 DROP COLUMN 을 넣지 않는다.
  // 자기 자신(같은 종류·이름)만 빼므로 같은 이름의 함수를 부르는 뷰는 그 함수 생성을 포함한다
  const used = (view: Statement) => {
    const reads = new Set(view.reads ?? []);
    const calls = new Set((view.calls ?? []).map(routineNameKey));
    const isUsed = (st: Statement) => (isRelation(st.kind) ? namesOf(st).some((n) => reads.has(n)) : st.kind === 'function' && calls.has(routineNameKey(st.object)));
    return stmts.filter((st) => !(st.kind === view.kind && st.object === view.object) && st.op !== 'drop' && isUsed(st))
      .flatMap((st) => (st.kind === 'table' ? namesOf(st).flatMap(closure) : [st]));
  };
  // 이름 N 을 차지하는(생성·rename into) 문장 앞에 N 을 비워야 하는 문장: 같은 이름 공간(테이블·뷰는 공유, 함수·프로시저는 별개)의
  // 다른 종류 객체 삭제(테이블↔뷰 교체)와 N 을 다른 이름으로 옮기는 테이블 rename. 빠지면 단독 실행 때 'already exists'·'is not VIEW'
  // 로 실패한다. 다른 이름 공간의 삭제를 넣으면 무관한 객체를 지운다 (테이블 p 삭제 + 프로시저 p 추가)
  const freeing = (st: Statement) => (isRelation(st.kind) ? stmts.filter((o) => o !== st && isRelation(o.kind) && namesOf(st).some((n) =>
    (o.op === 'drop' && o.kind !== st.kind && namesOf(o).includes(n)) || Boolean(o.frees?.includes(n)))) : []);

  const picked = new Set<Statement>();
  const queue: Statement[] = [];
  const pick = (list: Statement[]) => {
    for (const st of list) if (!picked.has(st)) { picked.add(st); queue.push(st); }
  };
  pick(stmts.filter(isOwn));
  while (queue.length) {
    const st = queue.pop()!;
    if (st.depends) for (const t of st.depends) pick(ofTable(t));
    if (st.kind === 'table' && !(st.op === 'drop' && !st.fkDrops)) pick(namesOf(st).flatMap(closure));
    if (st.fkAdds) pick(st.fkAdds.flatMap(closure));
    if (blocksIncomingFks(st)) pick(namesOf(st).flatMap(incoming));
    if (st.kind === 'view' && st.op !== 'drop' && !st.comment) pick(used(st));
    if (st.op !== 'drop') pick(freeing(st));
  }
  const statements = stmts.filter((st) => picked.has(st));
  const dependencies = [...new Set(statements.filter((st) => !isOwn(st)).map((st) => st.object))].sort();
  return { statements, dependencies };
}
