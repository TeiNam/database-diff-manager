// ALTER 결과를 저장하기 전 안전망: 출력한 덤프를 다시 읽은 모델(저장될 모델)이 적용 결과와 같은지 객체마다 본다.
// - 객체 목록이 같아야 한다 (빠지거나 늘지 않는다)
// - 스크립트가 바꾼 객체(새 객체 포함)는 적용 결과와 같아야 하고, 다시 읽을 때 경고가 없어야 한다
// - 스크립트가 건드리지 않은 객체는 기준 버전의 객체와 같아야 한다. 파싱하지 못한 객체(parseError)만은 기준을 그대로 출력·다시 읽은 결과와 비교하고,
//   그 객체의 경고도 기준을 다시 읽을 때 똑같이 났으면 받는다 — 스크립트와 상관없이 기준에 이미 있던 객체라 다시 뽑아 올려도 같다
// - 파싱한 객체의 rawDdl(원문)은 보지 않는다: 저장할 버전의 원문은 출력한 덤프라, 기준에서 왕복 불일치로 남은 rawDdl 은 의미가 없다
import { canonicalJson, routineNameKey, type ParsedDump, type ParseWarning, type Routine, type SchemaModel, type Table, type View } from '@tdm/core';

type SchemaObject = Table | View | Routine;

export interface RoundTripInput {
  base: SchemaModel;
  baseAgain: () => ParsedDump; // 기준을 그대로 출력·다시 읽은 결과 (필요할 때만 만든다)
  applied: SchemaModel;
  reparsed: ParsedDump;
}

const isRoutine = (o: SchemaObject): o is Routine => o.kind === 'function' || o.kind === 'procedure';
// 짝짓는 열쇠 (루틴 이름은 대소문자를 구분하지 않는다)와 메시지·로그에 쓰는 이름표
const keyOf = (o: SchemaObject): string => `${o.kind} ${isRoutine(o) ? routineNameKey(o.name) : o.name}`;
const labelOf = (o: { kind: string; name: string }): string => `${o.kind} \`${o.name}\``;
const objectsOf = (m: SchemaModel): SchemaObject[] => [...m.tables, ...m.views, ...m.routines];
const byKey = (m: SchemaModel): Map<string, SchemaObject> => new Map(objectsOf(m).map((o) => [keyOf(o), o]));

function comparable(o: SchemaObject): string {
  if (o.parseError) return canonicalJson(o);
  const { rawDdl: _raw, ...rest } = o;
  return canonicalJson(rest);
}

// 경고가 가리키는 객체 열쇠 (루틴 경고는 함수·프로시저를 가르지 않는다, 스키마 경고는 객체가 없다). 줄 번호는 출력 위치에 따라 바뀌어 비교하지 않는다
function warningKeys(w: ParseWarning): string[] {
  if (w.kind === 'table' || w.kind === 'view') return [`${w.kind} ${w.object}`];
  return w.kind === 'routine' ? [`function ${routineNameKey(w.object)}`, `procedure ${routineNameKey(w.object)}`] : [];
}
const warningText = (w: ParseWarning): string => JSON.stringify([w.code, w.kind, w.object, w.message]);

// 어긋난 객체의 이름표 (없으면 빈 배열). 경고만 어긋나면 그 경고가 가리키는 객체(스키마 경고면 경고 종류와 줄)를 적는다
export function roundTripMismatches(input: RoundTripInput): string[] {
  const { base, applied, reparsed } = input;
  let memo: { objects: Map<string, SchemaObject>; warnings: Set<string> } | undefined; // 경고는 문구 집합으로 — 경고마다 기준의 경고를 훑으면 경고 수의 제곱이다
  const baseAgain = () => {
    if (!memo) {
      const parsed = input.baseAgain();
      memo = { objects: byKey(parsed.model), warnings: new Set(parsed.warnings.map(warningText)) };
    }
    return memo;
  };
  const bad = new Map<string, string>(); // 열쇠 → 이름표
  const [baseObjects, readObjects] = [byKey(base), byKey(reparsed.model)];
  const untouched = new Set<string>();
  for (const a of objectsOf(applied)) {
    const key = keyOf(a);
    const b = baseObjects.get(key);
    const isUntouched = b !== undefined && canonicalJson(a) === canonicalJson(b);
    if (isUntouched) untouched.add(key);
    const expected = isUntouched && a.parseError ? baseAgain().objects.get(key) : a;
    const r = readObjects.get(key);
    if (!r || !expected || comparable(r) !== comparable(expected)) bad.set(key, labelOf(a));
  }
  const appliedKeys = new Set(objectsOf(applied).map(keyOf));
  for (const r of objectsOf(reparsed.model)) if (!appliedKeys.has(keyOf(r))) bad.set(keyOf(r), labelOf(r));
  if (objectsOf(applied).length !== objectsOf(reparsed.model).length && !bad.size) bad.set('count', '객체 수');
  for (const w of reparsed.warnings) {
    const keys = warningKeys(w);
    if (keys.some((k) => untouched.has(k)) && baseAgain().warnings.has(warningText(w))) continue;
    bad.set(`warning ${warningText(w)}`, keys.length ? labelOf({ kind: w.kind, name: w.object }) : `${w.code} 경고 (줄 ${w.line})`);
  }
  return [...new Set(bad.values())];
}
