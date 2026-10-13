// FK 가 자동으로 만든 인덱스: 새 키가 자동 키를 버리는 규칙, 덤프에서 이름으로 가리기, 이 실행(applyScript) 안에서 아는 인덱스 출처(provenance) 추적
import type { ForeignKey, Index, IndexPart, Table } from '../model';
import { assertKeyCount } from './limits';
import { sameName, type IndexProvenance, type State } from './state';
import { fail, type ConstraintItem } from './types';

// ── 규칙 (MySQL 8.0.46·8.4.11 실측, sql_table.cc mysql_prepare_create_table·foreign_key_prefix) ──
// MySQL 은 FK 마다 "자동 키" 후보를 하나 만들고, 같은 컬럼으로 시작하는 다른 키가 있으면 자동 키를 버린다. 키 목록은 [문장 뒤에 남은 기존 키] + [문장에서 더한 키·
// FK 의 자동 키, 절 순서] 이다. 자동 키 g 는 다른 키 n 이 앞쪽 파트(컬럼 이름·prefix 길이·정렬 방향)를 g 와 똑같이 가지면 버려진다 (n 의 종류·가시성은 상관없고,
// FULLTEXT 도 받친다). 둘 다 자동 키면 짧은 쪽이, 길이가 같으면 앞선 쪽이 버려진다. 직접 만든 인덱스는 버려지지 않는다.
// 자동 표시는 SHOW CREATE 에 나오지 않는다. FK 를 지워도·컬럼 이름이나 테이블 이름을 바꿔도·보이기를 바꿔도·테이블을 다시 만들어도 남고, RENAME INDEX 만 표시를 지운다
// (원래 이름으로 되돌려도 그대로 직접 만든 인덱스다).
//
// ── 출처 ──
// 모델에는 표시가 없다. 이 실행 안에서 아는 출처는 st.origins.provenance 에 적는다 (auto: ensureFkIndexes 가 만든 것, user: 직접 더한 것·RENAME INDEX 한 것).
// 기준 덤프에서 온 인덱스는 출처를 모르므로 덤프의 이름으로 짐작한다 (classifyFkIndexes): FK 이름과 같은 이름이면 자동, 나머지는 직접 만든 것이다.
// 한계: 이름 없는 FK(<테이블>_ibfk_N)가 첫 컬럼 이름으로 자동으로 만든 인덱스(KEY x0)도 직접 만든 것으로 본다 (사용자 결정 — FK 컬럼으로 시작하는 복합 인덱스 추가·FK 이름 정리 같은
// 흔한 마이그레이션을 막지 않으려고). 실제로 자동 인덱스였다면 MySQL 은 그 인덱스를 지우거나 바꾸는데 모델은 남긴다. 기준 덤프나 앞선 업로드(파생 버전)에서 FK 가 이미 지워져 남은
// 자동 인덱스, FOREIGN KEY 뒤에 이름을 쓴 자동 인덱스(FOREIGN KEY ix_g (…))도 같다. FK 이름과 같은 이름으로 직접 만든 인덱스(KEY f + CONSTRAINT f)는 반대로 자동으로 본다.
// CREATE TABLE(Task 6)은 addKeys 로 키를 만들면 출처가 저절로 적힌다. 다른 길로 만들면 markProvenance(st, 테이블, 이름들, 'user' | 'auto') 를 불러야 한다

// 자동 인덱스 이름 (소문자). generated: 자동으로 만든 것으로 본다 (아는 auto, 또는 덤프에서 이름이 FK 이름과 같다)
export interface FkAutoIndexes {
  readonly generated: ReadonlySet<string>;
}

const NO_AUTO_INDEXES: FkAutoIndexes = { generated: new Set() };

const samePart = (p: IndexPart, q: IndexPart): boolean =>
  p.column !== undefined && q.column !== undefined && sameName(p.column, q.column) && p.length === q.length && p.desc === q.desc;

// short 의 키 파트가 long 의 앞쪽과 같다
const startsWithParts = (long: readonly IndexPart[], short: readonly IndexPart[]): boolean => short.length <= long.length && short.every((p, k) => samePart(p, long[k]));

// FK 컬럼 그대로인 일반 KEY (길이·DESC 없음) — 자동 인덱스의 모양
const isPlainKeyOn = (i: Index, columns: readonly string[]): boolean =>
  i.kind === 'INDEX' && i.parts.length === columns.length && i.parts.every((p, k) => p.column !== undefined && sameName(p.column, columns[k]) && p.length === undefined && !p.desc);

// 덤프에서 이름으로 짐작한다: 인덱스 이름이 FK 이름과 같으면 자동이다 (CONSTRAINT 이름이 있으면 자동 인덱스는 늘 그 이름 — 8.0.46·8.4.11 실측).
// 그 밖은 직접 만든 것으로 본다. 이름 없는 FK(<테이블>_ibfk_N)의 첫 컬럼 이름(<컬럼>_N) 인덱스는 자동일 수도 있지만 직접 만든 것으로 본다 (머리 주석의 한계)
const isAutoByName = (fk: ForeignKey, indexName: string): boolean => sameName(indexName, fk.name);

// FK 의 자동 인덱스일 수 있는 인덱스: FK 컬럼 그대로인 일반 KEY 가 하나뿐이고 그 앞쪽을 가진 다른 인덱스가 없을 때만이다 (있으면 자동 키는 버려졌을 것이므로 직접 만든 것이다).
// 테이블마다 한 번 만들어 FK 마다 쓴다: 일반 KEY 를 첫 컬럼(소문자)으로 묶어 두고 판정은 인덱스마다 한 번만 하므로, FK 가 많아도 FK 수 + 키 수 × 키 수다
function candidateIndexes(t: Table): (fk: ForeignKey) => Index | undefined {
  const byFirst = new Map<string, Index[]>();
  for (const i of t.indexes) {
    const first = i.kind === 'INDEX' ? i.parts[0]?.column?.toLowerCase() : undefined;
    if (first !== undefined) byFirst.set(first, [...(byFirst.get(first) ?? []), i]);
  }
  const isSole = new Map<Index, boolean>(); // 그 앞쪽을 가진 다른 인덱스가 없다
  const sole = (i: Index): boolean => {
    if (!isSole.has(i)) isSole.set(i, !t.indexes.some((o) => o !== i && startsWithParts(o.parts, i.parts)));
    return isSole.get(i)!;
  };
  return (fk) => {
    const exact = (byFirst.get(fk.columns[0].toLowerCase()) ?? []).filter((i) => isPlainKeyOn(i, fk.columns));
    return exact.length === 1 && sole(exact[0]) ? exact[0] : undefined;
  };
}

// 이 테이블에서 자동(generated)으로 보는 인덱스. 이 실행이 아는 출처(known)가 먼저고 — FK 가 없는 남은 인덱스도 포함 —
// 출처를 모르는 인덱스만 FK 이름으로 덤프에서 짐작한다
export function classifyFkIndexes(t: Table, known: ReadonlyMap<string, IndexProvenance> = new Map()): FkAutoIndexes {
  const generated = new Set(t.indexes.filter((i) => known.get(i.name.toLowerCase()) === 'auto').map((i) => i.name.toLowerCase()));
  const candidateIndex = candidateIndexes(t);
  for (const fk of t.foreignKeys) {
    const index = candidateIndex(fk);
    if (index && !known.has(index.name.toLowerCase()) && isAutoByName(fk, index.name)) generated.add(index.name.toLowerCase());
  }
  return { generated };
}

interface KeyCandidate {
  parts: readonly IndexPart[];
  auto: boolean; // 자동 키
  isNew: boolean; // 이 문장이 더했거나 DROP COLUMN 으로 파트를 줄인 키 (문장이 건드리지 않은 기존 키끼리는 서로 버리지 않는다)
}

// 뒤 키(later)와 앞 키(earlier) 중 버려지는 쪽: 자동 키가 아닌 상대가 앞쪽을 같게 가지면 자동 키, 둘 다 자동이면 짧은 쪽(같으면 앞선 쪽)
function discarded(later: KeyCandidate, earlier: KeyCandidate): KeyCandidate | undefined {
  if (!later.auto && !earlier.auto) return undefined;
  const [loser, other] = !later.auto ? [earlier, later] : !earlier.auto ? [later, earlier] : later.parts.length < earlier.parts.length ? [later, earlier] : [earlier, later];
  return startsWithParts(other.parts, loser.parts) ? loser : undefined;
}

// 버려지는 키. 키마다 앞서 남은 키(alive, 순서대로)만 본다 — 이미 버려진 키와는 다시 비교하지 않는다. 키 하나는 남은 키 하나를 대신하거나(그 키가 버려진다)
// 자기가 버려지거나 그냥 남으므로 남은 키 수는 줄지 않는다: 남은 키가 64개를 넘으면 문장 끝 키도 64개를 넘어 1069 다 (그래서 FK 를 얼마나 더해도 비교는 키마다 64번 안쪽이다)
function discardedKeys(list: readonly KeyCandidate[]): Set<KeyCandidate> {
  const out = new Set<KeyCandidate>();
  const alive: KeyCandidate[] = [];
  for (const key of list) {
    const [k, loser] = firstLoser(key, alive);
    if (loser === key) {
      out.add(key);
      continue;
    }
    if (loser) {
      out.add(loser);
      alive.splice(k, 1);
    }
    alive.push(key);
    assertKeyCount(alive.length);
  }
  return out;
}

// key 와 앞서 남은 키 중 처음으로 한쪽이 버려지는 짝: [그 앞 키의 자리, 버려지는 키]. 문장이 건드리지 않은 기존 키끼리는 서로 버리지 않는다
function firstLoser(key: KeyCandidate, alive: readonly KeyCandidate[]): [number, KeyCandidate | undefined] {
  for (const [k, earlier] of alive.entries()) {
    if (!key.isNew && !earlier.isNew) continue;
    const loser = discarded(key, earlier);
    if (loser) return [k, loser];
  }
  return [-1, undefined];
}

// DROP COLUMN 이 파트를 지운 기존 인덱스(소문자 이름): before 의 같은 인덱스(이름을 바꿨으면 옛 이름)보다 파트가 줄었다. 줄어든 키는 앞쪽이 자동 키와 같아질 수 있다
// (MySQL 8.0.46·8.4.11 실측: KEY k (x1, x0) 에서 x1 을 지우면 k (x0) 가 자동 f (x0) 를 버린다). 컬럼 이름 변경·인덱스 이름 변경만으로는 줄어든 것이 아니다
export function shrunkIndexes(before: Table, t: Table, renames: readonly { old: string; to: string }[] = []): ReadonlySet<string> {
  const firstByName = <T>(pairs: [string, T][]) => pairs.reduce((m, [k, v]) => (m.has(k) ? m : m.set(k, v)), new Map<string, T>()); // 소문자 이름 → 처음 것
  const oldName = firstByName(renames.map((r) => [r.to.toLowerCase(), r.old.toLowerCase()]));
  const partsBefore = firstByName(before.indexes.map((b) => [b.name.toLowerCase(), b.parts.length]));
  const shrunk = t.indexes.filter((i) => {
    const was = partsBefore.get(oldName.get(i.name.toLowerCase()) ?? i.name.toLowerCase());
    return was !== undefined && i.parts.length < was;
  });
  return new Set(shrunk.map((i) => i.name.toLowerCase()));
}

// 자동 분류에서 이름을 뺀다. RENAME INDEX 가 건드린 옛 이름·새 이름이다: 이름을 바꾸면 자동 표시가 지워지고 (8.0.46·8.4.11 실측), 다른 인덱스가 그 이름을 이어받을 수도 있다
export function withoutNames(flagged: FkAutoIndexes, names: Iterable<string>): FkAutoIndexes {
  const drop = new Set([...names].map((n) => n.toLowerCase()));
  return { generated: new Set([...flagged.generated].filter((n) => !drop.has(n))) };
}

// 이 문장이 더하는 키가 자동 키를 버리는 계획. kept: 버려지지 않은 기존 인덱스, skipped: 자동 키가 버려져 만들지 않는 FK
export interface AutoKeyPlan {
  readonly kept: readonly Index[];
  readonly skipped: ReadonlySet<ConstraintItem>;
}

// 자동(generated)으로 보는 인덱스 이름인가 — 새 키가 버릴 수 있는 기존 인덱스다 (직접 만든 인덱스는 버려지지 않는다)
export const isFlagged = (auto: FkAutoIndexes, name: string): boolean => auto.generated.has(name.toLowerCase());

export function planAutoKeys(t: Table, items: readonly ConstraintItem[], auto: FkAutoIndexes = NO_AUTO_INDEXES, shrunk: ReadonlySet<string> = new Set()): AutoKeyPlan {
  const isAuto = (i: Index) => isFlagged(auto, i.name);
  const existing = t.indexes.map((index) => ({ index, key: { parts: index.parts, auto: isAuto(index), isNew: shrunk.has(index.name.toLowerCase()) } }));
  const added = items.map((item) => ({
    item,
    key: item.kind === 'index' ? { parts: item.index.parts, auto: false, isNew: true } : { parts: item.fk.columns.map((column) => ({ column, desc: false })), auto: true, isNew: true },
  }));
  const dropped = discardedKeys([...existing, ...added].map((x) => x.key));
  return {
    kept: existing.filter((e) => !dropped.has(e.key)).map((e) => e.index),
    skipped: new Set(added.filter((a) => dropped.has(a.key)).map((a) => a.item)),
  };
}

// ALTER INDEX … VISIBLE|INVISIBLE 의 대상이 같은 문장이 버린 자동 인덱스면 1176: 자동 키가 먼저 버려져 대상이 없다 (8.0.46·8.4.11 실측 — 절 순서, 버리는 키의 종류(인덱스·UNIQUE·새 FK),
// FK 만 지운 뒤 남은 자동 인덱스도 같다. 같은 이름의 새 인덱스가 대신하면 받고, 인덱스 이름 충돌(1061)·없는 컬럼(1072) 같은 오류가 먼저다). t: 키를 더한 뒤의 테이블
export function assertTargetsKept(t: Table, names: readonly string[]): void {
  const lost = names.find((n) => !t.indexes.some((i) => sameName(i.name, n)));
  if (lost !== undefined) fail(`인덱스 \`${lost}\` 이 없습니다 — 같은 문장이 더하는 키가 FK 의 자동 인덱스 \`${lost}\` 를 먼저 버립니다 (MySQL 1176)`);
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
// FK 만 지운 문장이면 그 FK 의 자동 인덱스는 이제 FK 로 가릴 수 없으니 여기서 auto 로 기억해 둔다. 그래도 모르는 채 FK 를 받치는 인덱스는 user 로 적는다:
// 이 문장이 FK 를 더하려는데 이미 있던 인덱스가 받쳐 자동 키를 만들지 않았다면 그 인덱스를 FK 가 만든 것으로 오해하지 않게 한다 (FK 이름이 자동 꼴이어도)
export function syncProvenance(st: State, table: string, t: Table, flagged: FkAutoIndexes): void {
  const current = tableProvenance(st, table);
  const known = new Map(t.indexes.flatMap((i): [string, IndexProvenance][] => {
    const key = i.name.toLowerCase();
    const provenance = current.get(key) ?? (flagged.generated.has(key) ? 'auto' : undefined);
    return provenance === undefined ? [] : [[key, provenance]];
  }));
  const candidateIndex = candidateIndexes(t);
  for (const fk of t.foreignKeys) {
    const key = candidateIndex(fk)?.name.toLowerCase();
    if (key !== undefined && !known.has(key)) known.set(key, 'user');
  }
  st.origins.provenance.set(table, known);
}
