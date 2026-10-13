// FK 가 자동으로 만든 인덱스: 새 키가 자동 키를 버리는 규칙, 덤프에서 이름으로 가리기, 이 실행(applyScript) 안에서 아는 인덱스 출처(provenance) 추적
import type { ForeignKey, Index, IndexPart, Table } from '../model';
import { sameName, type IndexProvenance, type State } from './state';
import { fail, RE_EXPORT, type ConstraintItem } from './types';

// ── 규칙 (MySQL 8.0.46·8.4.11 실측, sql_table.cc mysql_prepare_create_table·foreign_key_prefix) ──
// MySQL 은 FK 마다 "자동 키" 후보를 하나 만들고, 같은 컬럼으로 시작하는 다른 키가 있으면 자동 키를 버린다. 키 목록은 [문장 뒤에 남은 기존 키] + [문장에서 더한 키·
// FK 의 자동 키, 절 순서] 이다. 자동 키 g 는 다른 키 n 이 앞쪽 파트(컬럼 이름·prefix 길이·정렬 방향)를 g 와 똑같이 가지면 버려진다 (n 의 종류·가시성은 상관없고,
// FULLTEXT 도 받친다). 둘 다 자동 키면 짧은 쪽이, 길이가 같으면 앞선 쪽이 버려진다. 직접 만든 인덱스는 버려지지 않는다.
// 자동 표시는 SHOW CREATE 에 나오지 않는다. FK 를 지워도·컬럼 이름이나 테이블 이름을 바꿔도·보이기를 바꿔도·테이블을 다시 만들어도 남고, RENAME INDEX 만 표시를 지운다
// (원래 이름으로 되돌려도 그대로 직접 만든 인덱스다).
//
// ── 출처 ──
// 모델에는 표시가 없다. 이 실행 안에서 아는 출처는 st.origins.provenance 에 적는다 (auto: ensureFkIndexes 가 만든 것, user: 직접 더한 것·RENAME INDEX 한 것).
// 기준 덤프에서 온 인덱스는 출처를 모르므로 덤프의 이름으로 짐작한다 (classifyFkIndexes). 한계: 기준 덤프나 앞선 업로드에서 FK 가 이미 지워져 남은 자동 인덱스(FK 가 없다),
// FK 이름과 같은 이름으로 직접 만든 인덱스(KEY f + CONSTRAINT f), FOREIGN KEY 뒤에 이름을 쓴 자동 인덱스(FOREIGN KEY ix_g (…))는 덤프로 알아볼 수 없다.
// CREATE TABLE(Task 6)은 addKeys 로 키를 만들면 출처가 저절로 적힌다. 다른 길로 만들면 markProvenance(st, 테이블, 이름들, 'user' | 'auto') 를 불러야 한다

// 자동 인덱스 이름 (소문자). generated: 자동으로 만든 것으로 본다 (아는 auto, 또는 덤프에서 이름이 FK 이름과 같다). ambiguous: 자동인지 직접 만든 것인지 알 수 없다.
// 둘은 겹치지 않는다
export interface FkAutoIndexes {
  readonly generated: ReadonlySet<string>;
  readonly ambiguous: ReadonlySet<string>;
}

const NO_AUTO_INDEXES: FkAutoIndexes = { generated: new Set(), ambiguous: new Set() };

const samePart = (p: IndexPart, q: IndexPart): boolean =>
  p.column !== undefined && q.column !== undefined && sameName(p.column, q.column) && p.length === q.length && p.desc === q.desc;

// short 의 키 파트가 long 의 앞쪽과 같다
const startsWithParts = (long: readonly IndexPart[], short: readonly IndexPart[]): boolean => short.length <= long.length && short.every((p, k) => samePart(p, long[k]));

// FK 컬럼 그대로인 일반 KEY (길이·DESC 없음) — 자동 인덱스의 모양
const isPlainKeyOn = (i: Index, columns: readonly string[]): boolean =>
  i.kind === 'INDEX' && i.parts.length === columns.length && i.parts.every((p, k) => p.column !== undefined && sameName(p.column, columns[k]) && p.length === undefined && !p.desc);

// 자동 FK 이름: '<테이블>_ibfk_<N>'
const isAutoFkName = (table: string, name: string): boolean => name.startsWith(`${table}_ibfk_`) && /^\d+$/.test(name.slice(table.length + '_ibfk_'.length));

// 덤프에서 이름으로 짐작한다: 인덱스 이름이 FK 이름과 같으면 자동, FK 이름이 자동 꼴일 때 첫 컬럼 이름(충돌하면 <컬럼>_2 …)이면 알 수 없음.
// CONSTRAINT 이름이 있으면 자동 인덱스는 늘 그 이름이므로 (FOREIGN KEY 뒤 인덱스 이름보다 먼저 — 8.0.46·8.4.11 실측) 자동 꼴이 아닌 FK 의 첫 컬럼 이름 인덱스는 직접 만든 것이다
function guessProvenance(table: string, fk: ForeignKey, indexName: string): IndexProvenance | undefined {
  const name = indexName.toLowerCase();
  if (name === fk.name.toLowerCase()) return 'auto';
  if (!isAutoFkName(table, fk.name)) return undefined;
  const first = fk.columns[0].toLowerCase();
  const isColumnName = name === first || (name.startsWith(`${first}_`) && /^\d+$/.test(name.slice(first.length + 1)));
  return isColumnName ? 'ambiguous' : undefined;
}

// FK 의 자동 인덱스일 수 있는 인덱스: FK 컬럼 그대로인 일반 KEY 가 하나뿐이고 그 앞쪽을 가진 다른 인덱스가 없을 때만이다 (있으면 자동 키는 버려졌을 것이므로 직접 만든 것이다)
function candidateIndex(t: Table, fk: ForeignKey): Index | undefined {
  const exact = t.indexes.filter((i) => isPlainKeyOn(i, fk.columns));
  return exact.length === 1 && !t.indexes.some((i) => i !== exact[0] && startsWithParts(i.parts, exact[0].parts)) ? exact[0] : undefined;
}

// 이 테이블에서 자동(generated)이거나 자동인지 알 수 없는(ambiguous) 인덱스. 이 실행이 아는 출처(known)가 먼저고 — FK 가 없는 남은 인덱스도 포함 —
// 출처를 모르는 인덱스만 FK 이름으로 덤프에서 짐작한다
export function classifyFkIndexes(t: Table, known: ReadonlyMap<string, IndexProvenance> = new Map()): FkAutoIndexes {
  const generated = new Set<string>();
  const ambiguous = new Set<string>();
  for (const i of t.indexes) {
    const provenance = known.get(i.name.toLowerCase());
    if (provenance === 'auto') generated.add(i.name.toLowerCase());
    else if (provenance === 'ambiguous') ambiguous.add(i.name.toLowerCase());
  }
  for (const fk of t.foreignKeys) {
    const index = candidateIndex(t, fk);
    if (!index || known.has(index.name.toLowerCase())) continue;
    const guess = guessProvenance(t.name, fk, index.name);
    if (guess === 'auto') generated.add(index.name.toLowerCase());
    else if (guess === 'ambiguous') ambiguous.add(index.name.toLowerCase());
  }
  return { generated, ambiguous: new Set([...ambiguous].filter((n) => !generated.has(n))) };
}

interface KeyCandidate {
  parts: readonly IndexPart[];
  auto: boolean; // 자동 키
  isNew: boolean; // 이 문장에서 더한 키 (기존 키끼리는 서로 버리지 않는다)
}

// 뒤 키(later)와 앞 키(earlier) 중 버려지는 쪽: 자동 키가 아닌 상대가 앞쪽을 같게 가지면 자동 키, 둘 다 자동이면 짧은 쪽(같으면 앞선 쪽)
function discarded(later: KeyCandidate, earlier: KeyCandidate): KeyCandidate | undefined {
  if (!later.auto && !earlier.auto) return undefined;
  const [loser, other] = !later.auto ? [earlier, later] : !earlier.auto ? [later, earlier] : later.parts.length < earlier.parts.length ? [later, earlier] : [earlier, later];
  return startsWithParts(other.parts, loser.parts) ? loser : undefined;
}

function discardedKeys(list: readonly KeyCandidate[]): Set<KeyCandidate> {
  const out = new Set<KeyCandidate>();
  list.forEach((key, k) => {
    for (const earlier of list.slice(0, k)) {
      if (out.has(earlier) || (!key.isNew && !earlier.isNew)) continue;
      const loser = discarded(key, earlier);
      if (loser) {
        out.add(loser);
        break;
      }
    }
  });
  return out;
}

// 이 문장이 더하는 키가 자동 키를 버리는 계획. kept: 버려지지 않은 기존 인덱스, skipped: 자동 키가 버려져 만들지 않는 FK,
// uncertain: 자동인지 알 수 없는데(ambiguous) 버려지는 기존 인덱스 이름 — 자동이면 MySQL 이 지우고 직접 만든 것이면 남긴다 (assertAutoKeysKnown)
export interface AutoKeyPlan {
  readonly kept: readonly Index[];
  readonly skipped: ReadonlySet<ConstraintItem>;
  readonly uncertain: readonly string[];
}

export function planAutoKeys(t: Table, items: readonly ConstraintItem[], auto: FkAutoIndexes = NO_AUTO_INDEXES): AutoKeyPlan {
  const isAuto = (i: Index) => auto.generated.has(i.name.toLowerCase()) || auto.ambiguous.has(i.name.toLowerCase());
  const existing = t.indexes.map((index) => ({ index, key: { parts: index.parts, auto: isAuto(index), isNew: false } }));
  const added = items.map((item) => ({
    item,
    key: item.kind === 'index' ? { parts: item.index.parts, auto: false, isNew: true } : { parts: item.fk.columns.map((column) => ({ column, desc: false })), auto: true, isNew: true },
  }));
  const dropped = discardedKeys([...existing, ...added].map((x) => x.key));
  return {
    kept: existing.filter((e) => !dropped.has(e.key)).map((e) => e.index),
    skipped: new Set(added.filter((a) => dropped.has(a.key)).map((a) => a.item)),
    uncertain: existing.filter((e) => dropped.has(e.key) && auto.ambiguous.has(e.index.name.toLowerCase())).map((e) => e.index.name),
  };
}

// 자동인지 알 수 없는 인덱스가 버려지는 문장은 결과를 정할 수 없어 거부한다. 문장이 어느 쪽으로 읽어도 MySQL 오류인 경우를 가리지 않도록 다른 검사를 다 마친 뒤에 부른다
export function assertAutoKeysKnown(plan: Pick<AutoKeyPlan, 'uncertain'>): void {
  if (!plan.uncertain.length) return;
  fail(`인덱스 ${plan.uncertain.map((n) => `\`${n}\``).join(', ')} 이 FK 때문에 MySQL 이 자동으로 만든 것인지 덤프만으로는 알 수 없습니다 — 자동으로 만든 것이면 이 문장이 더하는 키가 대신해 `
    + `MySQL 이 지우고 직접 만든 것이면 남기므로 결과를 정할 수 없습니다 — ${RE_EXPORT}`);
}

// ── 출처 표 (st.origins.provenance: 테이블 → 인덱스 이름 소문자 → 출처). 표는 바꾸지 않고 새로 만들어 넣는다 ──
const tableProvenance = (st: State, table: string): ReadonlyMap<string, IndexProvenance> => st.origins.provenance.get(table) ?? new Map();

// 이 인덱스들의 출처를 적는다 (이미 적힌 값은 덮어쓴다)
export function markProvenance(st: State, table: string, names: readonly string[], provenance: IndexProvenance): void {
  const next = new Map(tableProvenance(st, table));
  for (const n of names) next.set(n.toLowerCase(), provenance);
  st.origins.provenance.set(table, next);
}

// RENAME INDEX: MySQL 은 자동 표시를 지운다 (8.0.46·8.4.11 실측: 바꾼 인덱스는 새 키가 앞쪽을 가져도 남고, 원래 이름으로 되돌려도 그대로다). 옛 이름은 빼고 새 이름은 user
export function renameProvenance(st: State, table: string, from: string, to: string): void {
  const next = new Map(tableProvenance(st, table));
  next.delete(from.toLowerCase());
  st.origins.provenance.set(table, next);
  markProvenance(st, table, [to], 'user');
}

// 문장이 끝난 테이블(t)의 출처 표를 다시 만든다: 남은 인덱스만 두고, 이 문장이 정한 값(addKeys·renameProvenance)이 먼저며, 없으면 문장 시작에 가린 분류(flagged)를 굳힌다 —
// FK 만 지운 문장이면 그 FK 의 자동 인덱스는 이제 FK 로 가릴 수 없으니 여기서 auto·ambiguous 로 기억해 둔다. 그래도 모르는 채 FK 를 받치는 인덱스는 user 로 적는다:
// 이 문장이 FK 를 더하려는데 이미 있던 인덱스가 받쳐 자동 키를 만들지 않았다면 그 인덱스를 FK 가 만든 것으로 오해하지 않게 한다 (FK 이름이 자동 꼴이어도)
export function syncProvenance(st: State, table: string, t: Table, flagged: FkAutoIndexes): void {
  const current = tableProvenance(st, table);
  const known = new Map(t.indexes.flatMap((i): [string, IndexProvenance][] => {
    const key = i.name.toLowerCase();
    const provenance = current.get(key) ?? (flagged.generated.has(key) ? 'auto' : flagged.ambiguous.has(key) ? 'ambiguous' : undefined);
    return provenance === undefined ? [] : [[key, provenance]];
  }));
  for (const fk of t.foreignKeys) {
    const key = candidateIndex(t, fk)?.name.toLowerCase();
    if (key !== undefined && !known.has(key)) known.set(key, 'user');
  }
  st.origins.provenance.set(table, known);
}
