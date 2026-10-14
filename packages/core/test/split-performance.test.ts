import { describe, expect, it } from 'vitest';
import { parseSqlDump, splitForApply } from '../src/parse-dump';

// 문장 나누기의 계산량 (리뷰 15회차 R15-1·R15-2·Claude F5): ALTER 적용(splitForApply)과 덤프 업로드(parseSqlDump)가 같은 문장 나누기를 쓴다. 서버 한도(1,000,000자)를 채운
// 스크립트도 몇 초 안에 나눠야 한다 — 서버는 한 프로세스라 나누는 동안 다른 요청이 멈추고, 업로드는 파일당 20 MB 까지라 더 길다. 고치기 전에는 한 줄에 되풀이한 DELIMITER 단어마다
// 줄 처음까지 되짚고(28 초), 긴 구분자의 같은 앞부분을 토큰마다 다시 견줘(25 초) 제곱 시간이었다. 여기서는 3 초 안을 본다
const MAX = 1_000_000;
const BOUND_MS = 3000;
const TIMEOUT_MS = 60000;

// 구분자를 DELIMITER 단어로 바꾼 뒤 그 단어를 한 줄에 되풀이한다 — 단어마다 문장 없는 덩어리가 끝난다 (Codex R15-1)
function repeatedWordDelimiter(): string {
  const head = "ALTER TABLE member COMMENT 'x';\nDELIMITER DELIMITER\n/*a*/ ";
  const unit = 'DELIMITER ';
  const count = Math.floor((MAX - head.length) / unit.length);
  return head + unit.repeat(count) + ' '.repeat(MAX - head.length - count * unit.length);
}

// 10,001자 구분자의 앞 10,000자('!')를 연산자 토큰으로 되풀이한다 (Codex R15-2)
function longDelimiterPrefix(): string {
  const head = `DELIMITER ${'!'.repeat(10_000)}x\nSELECT `;
  return `${head}${'!'.repeat(MAX - head.length - 1)};`;
}

// 긴 구분자의 앞뒤 부분('a')으로 된 단어 하나 — 단어 안의 구분자 찾기 (String.indexOf 는 이런 구분자에서 길이의 곱이 든다)
function longDelimiterInWord(): string {
  const half = 'a'.repeat(20_000);
  const head = `DELIMITER ${half}b${half}\nSELECT `;
  return `${head}${'a'.repeat(MAX - head.length - 1)};`;
}

// [이름, 스크립트, splitForApply 의 문장 수]
const CASES: [string, () => string, number][] = [
  ['구분자로 바꾼 DELIMITER 단어를 한 줄에 되풀이 (Codex R15-1)', repeatedWordDelimiter, 1],
  ['긴 구분자의 앞부분을 연산자로 되풀이 (Codex R15-2)', longDelimiterPrefix, 1],
  ["';DELIMITER' 를 한 줄에 되풀이 (Claude F5)", () => `ALTER TABLE member ADD a INT;\n${';DELIMITER'.repeat(99_997)}`, 99_998],
  ['긴 구분자의 앞뒤 부분으로 된 단어', longDelimiterInWord, 1],
];

const timed = <T>(run: () => T): [T, number] => {
  const started = performance.now();
  const result = run();
  return [result, performance.now() - started];
};

describe('문장 나누기 — 1,000,000자 스크립트의 계산량 (ALTER 적용·덤프 업로드)', () => {
  it.each(CASES)('ALTER 적용 splitForApply — %s', (_name, make, statements) => {
    const script = make();
    expect(script.length).toBe(MAX);
    const [split, ms] = timed(() => splitForApply(script));
    expect(ms).toBeLessThan(BOUND_MS);
    expect(split.statements).toHaveLength(statements);
  }, TIMEOUT_MS);

  it.each(CASES)('덤프 업로드 parseSqlDump — %s', (_name, make) => {
    const [parsed, ms] = timed(() => parseSqlDump(make()));
    expect(ms).toBeLessThan(BOUND_MS);
    expect(parsed.model.tables).toEqual([]);
  }, TIMEOUT_MS);
});
