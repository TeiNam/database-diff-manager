// JUDGE_REV 강제 (17회차 5): 파서·완전성 판정 규칙을 바꾸고 JUDGE_REV 를 올리지 않으면 기동 시 재판정(stale 감지)이 돌지 않는다.
// 실출력 픽스처(와 잘린·편집기 공백 제거 변형)의 모델 해시·완전성 판정을 스냅샷으로 두고, 스냅샷 파일에 그 판(judgeRev)을 기록한다.
// - 결과가 스냅샷과 다른데 판이 같으면 실패 → JUDGE_REV 를 올린다
// - 판이 스냅샷과 다르면 실패 → UPDATE_JUDGE_SNAPSHOT=1 로 다시 만든다 (판을 올렸거나 새 픽스처만 늘었을 때만 다시 쓴다)
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceFormat } from '@tdm/core';
import { describe, expect, it } from 'vitest';
import { evidenceJson, JUDGE_REV } from '../src/repos/evidence';
import { modelHash, parseSource } from '../src/services/ingest';

const FIXTURES = fileURLToPath(new URL('../../../packages/core/test/fixtures/', import.meta.url));
const SNAPSHOT = fileURLToPath(new URL('./judge-rev.snapshot.json', import.meta.url));
// 실출력 디렉터리와 손으로 만든 MD (모든 .sql·.md)
const DIRS = ['td-export-0115', 'td-export-0130', 'td-export-0136', 'td-export-0152', 'md', 'dms'];

interface Snapshot {
  judgeRev: number;
  results: Record<string, { hash: string; evidence: string }>;
}

// 판정 규칙이 보는 변형: 원본, 편집기가 줄 끝 공백을 지운 파일, 앞 절반 줄에서 자른 파일
function variants(text: string): [string, string][] {
  const lines = text.split('\n');
  return [['', text], ['#trimmed', lines.map((l) => l.trimEnd()).join('\n')], ['#half', lines.slice(0, Math.floor(lines.length / 2)).join('\n')]];
}

function judgeAll(): Snapshot['results'] {
  const out: Snapshot['results'] = {};
  for (const dir of DIRS) {
    for (const file of readdirSync(join(FIXTURES, dir)).filter((f) => f.endsWith('.sql') || f.endsWith('.md')).sort()) {
      const format: SourceFormat = file.endsWith('.md') ? 'md' : 'sql';
      for (const [suffix, text] of variants(readFileSync(join(FIXTURES, dir, file), 'utf8'))) {
        const key = `${dir}/${file}${suffix}`;
        try {
          const { model } = parseSource(format, text);
          out[key] = { hash: modelHash(model), evidence: model.evidence ? evidenceJson(model.evidence) : 'none' };
        } catch (e) {
          out[key] = { hash: 'error', evidence: e instanceof Error ? e.message : String(e) };
        }
      }
    }
  }
  return out;
}

describe('JUDGE_REV 스냅샷', () => {
  it('파서·완전성 판정 결과가 바뀌면 JUDGE_REV 를 올려야 한다', () => {
    const results = judgeAll();
    const stored = existsSync(SNAPSHOT) ? (JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Snapshot) : undefined;
    const sameAs = (a: Snapshot['results'][string] | undefined, b: Snapshot['results'][string] | undefined) => a?.hash === b?.hash && a?.evidence === b?.evidence;
    // 판정이 바뀐(또는 사라진) 기존 항목, 스냅샷에 없는 새 픽스처 항목
    const changed = Object.keys(stored?.results ?? {}).filter((k) => !sameAs(stored!.results[k], results[k]));
    const added = Object.keys(results).filter((k) => !(k in (stored?.results ?? {})));
    // 판을 올렸거나, 기존 항목이 그대로이고 새 픽스처만 늘었으면 다시 쓴다
    if (process.env.UPDATE_JUDGE_SNAPSHOT === '1' && (!stored || JUDGE_REV > stored.judgeRev || !changed.length)) {
      writeFileSync(SNAPSHOT, `${JSON.stringify({ judgeRev: JUDGE_REV, results }, null, 2)}\n`);
      return;
    }
    expect(stored, 'judge-rev.snapshot.json 이 없습니다 — UPDATE_JUDGE_SNAPSHOT=1 로 만드세요').toBeDefined();
    expect(stored!.judgeRev, 'JUDGE_REV 가 스냅샷의 판과 다릅니다 — UPDATE_JUDGE_SNAPSHOT=1 로 스냅샷을 다시 만드세요').toBe(JUDGE_REV);
    expect(changed, '판정 결과가 스냅샷과 다릅니다 — apps/server/src/repos/evidence.ts 의 JUDGE_REV 를 올리고 UPDATE_JUDGE_SNAPSHOT=1 로 스냅샷을 다시 만드세요').toEqual([]);
    expect(added, '새 픽스처가 스냅샷에 없습니다 — UPDATE_JUDGE_SNAPSHOT=1 로 추가하세요 (판은 그대로)').toEqual([]);
  });
});
