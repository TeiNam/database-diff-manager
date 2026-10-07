export interface AlignedRow<T> {
  base?: T;
  target?: T;
}

// 표 모드의 좌우 행 정렬: TARGET 순서를 따르고, BASE에만 있는 항목은 BASE에서 바로 앞에 있던 짝지어진 항목 뒤에 끼워 넣는다
export function alignByKey<T>(base: T[], target: T[], key: (x: T) => string, renamedToBase = new Map<string, string>()): AlignedRow<T>[] {
  const baseIndex = new Map(base.map((x, i) => [key(x), i]));
  const matchOf = target.map((t) => baseIndex.get(renamedToBase.get(key(t)) ?? key(t)));
  const matched = new Set(matchOf.filter((i): i is number => i !== undefined));
  // 짝 없는 BASE 항목을 직전의 짝지어진 BASE 인덱스(없으면 -1)별로 모은다
  const orphansAfter = new Map<number, T[]>();
  let anchor = -1;
  base.forEach((item, i) => {
    if (matched.has(i)) {
      anchor = i;
      return;
    }
    orphansAfter.set(anchor, [...(orphansAfter.get(anchor) ?? []), item]);
  });
  const asRows = (anchorIndex: number): AlignedRow<T>[] => (orphansAfter.get(anchorIndex) ?? []).map((b) => ({ base: b }));
  const rows: AlignedRow<T>[] = [...asRows(-1)];
  target.forEach((t, j) => {
    const bi = matchOf[j];
    if (bi === undefined) {
      rows.push({ target: t });
      return;
    }
    rows.push({ base: base[bi], target: t }, ...asRows(bi));
  });
  return rows;
}
