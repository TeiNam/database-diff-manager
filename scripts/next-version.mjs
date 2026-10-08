#!/usr/bin/env node
// 다음 제품 버전을 계산한다: apps/web/package.json 의 major.minor 에서, 같은 major.minor 의
// 가장 큰 태그(vX.Y.N) 다음 패치 번호. 해당 태그가 없으면 X.Y.0.
// 사용: node scripts/next-version.mjs            → git 태그를 읽어 출력
//       node scripts/next-version.mjs --self-test → 계산 규칙 확인
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function nextVersion(baseVersion, tags) {
  const m = /^(\d+)\.(\d+)\./.exec(baseVersion);
  if (!m) throw new Error(`package.json version 형식이 올바르지 않습니다: ${baseVersion}`);
  const [major, minor] = [m[1], m[2]];
  const patches = tags
    .map((t) => new RegExp(`^v${major}\\.${minor}\\.(\\d+)$`).exec(t.trim()))
    .filter(Boolean)
    .map((x) => Number(x[1]));
  const patch = patches.length ? Math.max(...patches) + 1 : 0;
  return `${major}.${minor}.${patch}`;
}

if (process.argv.includes('--self-test')) {
  const eq = (a, b) => { if (a !== b) throw new Error(`${a} !== ${b}`); };
  eq(nextVersion('0.1.0', []), '0.1.0');
  eq(nextVersion('0.1.0', ['v0.1.0', 'v0.1.2', 'v0.1.1']), '0.1.3');
  eq(nextVersion('0.2.0', ['v0.1.9']), '0.2.0'); // 마이너를 올리면 패치는 0부터
  eq(nextVersion('0.1.0', ['v0.1.10', 'v0.1.9', 'v0.1.x', 'release-1']), '0.1.11');
  console.log('ok');
} else {
  const pkg = JSON.parse(readFileSync(new URL('../apps/web/package.json', import.meta.url), 'utf8'));
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  console.log(nextVersion(pkg.version, tags));
}
