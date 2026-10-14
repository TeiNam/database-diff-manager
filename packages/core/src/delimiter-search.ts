// 원문에서 구분자가 나오는 자리를 앞에서부터 차례로 찾는다 (KMP, 리뷰 15회차 R15-2). 문장 나누기는 토큰마다 그 자리에 구분자가 있는지 보는데, 그때마다 원문과 구분자를
// 견주면 긴 구분자의 같은 앞부분을 토큰마다 다시 견줘 원문 길이 × 구분자 길이가 든다 — 10,001자 구분자의 앞부분을 되풀이한 1,000,000자 스크립트 하나가 25 초였다.
// String.indexOf 도 긴 구분자에서는 같은 곱이 들 수 있어(앞뒤가 같은 글자인 40,001자 구분자로 950,000자 단어 하나를 찾으면 5 초) 쓰지 않는다. 원문의 글자를 한 번씩만
// 견주고, 찾은 자리를 두었다가 묻는 자리가 지나가면 그다음 것을 찾는다
export class DelimiterSearch {
  // fallback[k]: 구분자 앞 k+1 글자의 앞부분이면서 뒷부분인 가장 긴 글의 길이 (자신은 빼고 — KMP 실패 함수)
  private readonly fallback: Int32Array;
  private scanned: number; // 원문을 이 자리 앞까지 훑었다
  private matched = 0; // scanned 바로 앞에서 끝나는 글 가운데 구분자의 앞부분과 같은 가장 긴 것의 길이
  private next = -1; // 찾고 아직 지나가지 않은 첫 구분자 자리 (없으면 -1)

  // from: 원문을 훑기 시작할 자리 — 그 앞에서 시작하는 구분자는 찾지 않는다
  constructor(private readonly text: string, readonly delimiter: string, from: number) {
    this.fallback = fallbackOf(delimiter);
    this.scanned = from;
  }

  // pos 에서 시작해 limit 까지 끝나는 첫 구분자 자리 (없으면 -1). pos 는 부를 때마다 앞으로만 간다 — 지나간 자리는 다시 보지 않는다
  within(pos: number, limit: number): number {
    if (this.next >= 0 && this.next < pos) this.next = -1;
    const end = Math.min(limit, this.text.length);
    while (this.next < 0 && this.scanned < end) this.step(pos);
    return this.next >= 0 && this.next + this.delimiter.length <= limit ? this.next : -1;
  }

  // 원문 한 글자를 더 견준다. 구분자가 끝났고 그 자리가 pos 뒤면 next 로 둔다 (pos 앞의 것은 이미 지나갔다)
  private step(pos: number): void {
    const d = this.delimiter;
    const c = this.text.charCodeAt(this.scanned++);
    while (this.matched > 0 && d.charCodeAt(this.matched) !== c) this.matched = this.fallback[this.matched - 1];
    if (d.charCodeAt(this.matched) === c) this.matched++;
    if (this.matched < d.length) return;
    const at = this.scanned - d.length;
    this.matched = this.fallback[this.matched - 1];
    if (at >= pos) this.next = at;
  }
}

// [from, to) 안에 pattern 이 있는가 — 두 길이의 합에 비례한다 (String.includes 는 긴 pattern 에서 길이의 곱이 들 수 있다)
export function containsWithin(text: string, pattern: string, from: number, to: number): boolean {
  return to - from >= pattern.length && new DelimiterSearch(text, pattern, from).within(from, to) >= 0;
}

function fallbackOf(pattern: string): Int32Array {
  const out = new Int32Array(pattern.length);
  let k = 0;
  for (let i = 1; i < pattern.length; i++) {
    while (k > 0 && pattern.charCodeAt(i) !== pattern.charCodeAt(k)) k = out[k - 1];
    if (pattern.charCodeAt(i) === pattern.charCodeAt(k)) k++;
    out[i] = k;
  }
  return out;
}
