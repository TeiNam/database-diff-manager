// 자동 제약명 '<테이블>_chk_N'·'<테이블>_ibfk_N' 의 테이블 rename 보정
import type { ForeignKey } from './model';

// RENAME TABLE 은 자동 제약명 '<옛 테이블>_chk_N'·'<옛 테이블>_ibfk_N' 을 '<새 테이블>_…_N' 으로 바꾼다 (맞바꾸기·연쇄의
// 임시 이름을 거쳐도 마지막 이름이 남는다). CHECK·FK 추가는 rename 뒤에 실행되므로 새 이름으로 비교·출력한다
export function renamedAutoName(name: string, from: string, to: string, kind: 'chk' | 'ibfk'): string {
  if (from === to) return name;
  const prefix = `${from}_${kind}_`;
  const n = name.startsWith(prefix) ? name.slice(prefix.length) : '';
  return /^\d+$/.test(n) ? `${to}_${kind}_${n}` : name;
}

// 보정한 FK 이름이 같은 테이블의 다른 FK 이름과 겹치는지 (c_ibfk_1 과 명시적 c2_ibfk_1 이 함께 있고 c→c2)
export function fkAutoNameCollides(fks: readonly ForeignKey[], from: string, to: string): boolean {
  return fks.some((f) => {
    const renamed = renamedAutoName(f.name, from, to, 'ibfk');
    return renamed !== f.name && fks.some((o) => o !== f && o.name === renamed);
  });
}

// 테이블 rename 뒤의 FK 이름 (fks 순서). 보정명이 다른 FK 이름과 겹치면 보정하지 않고 원래 이름을 쓴다 (그 테이블은 수동 확인)
export function renamedFkNames(fks: readonly ForeignKey[], from: string, to: string): string[] {
  if (fkAutoNameCollides(fks, from, to)) return fks.map((f) => f.name);
  return fks.map((f) => renamedAutoName(f.name, from, to, 'ibfk'));
}
