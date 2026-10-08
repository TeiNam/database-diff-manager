#!/usr/bin/env node
// 로컬 빌드에 표시할 버전을 git 태그로 정한다 (CI 는 APP_VERSION 을 넘기므로 쓰지 않는다).
//   지금 커밋에 태그가 있고 변경 없음 → 0.1.2
//   태그 뒤에 커밋이 더 있거나 작업 중 변경 있음 → 0.1.2-dev+3.44e9b27
//   git 이 없거나 태그가 없음 → <package.json version>-dev
// 사용: node scripts/local-version.mjs --self-test
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// `git describe --tags --long --dirty` 출력(v0.1.2-3-g44e9b27[-dirty])을 표시용 버전으로 바꾼다
export function describeToVersion(describe, fallback) {
  const m = /^v(\d+\.\d+\.\d+)-(\d+)-g([0-9a-f]+)(-dirty)?$/.exec((describe ?? '').trim());
  if (!m) return `${fallback}-dev`;
  const [, version, ahead, sha, dirty] = m;
  return ahead === '0' && !dirty ? version : `${version}-dev+${ahead}.${sha}${dirty ? '.dirty' : ''}`;
}

export function localVersion(fallback, cwd) {
  try {
    const out = execFileSync('git', ['describe', '--tags', '--match', 'v[0-9]*.[0-9]*.[0-9]*', '--long', '--dirty'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return describeToVersion(out, fallback);
  } catch {
    return `${fallback}-dev`; // git 없음(소스만 복사한 Docker 빌드 등) 또는 태그 없음
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const eq = (a, b) => { if (a !== b) throw new Error(`${a} !== ${b}`); };
  eq(describeToVersion('v0.1.2-0-g44e9b27\n', '0.1.0'), '0.1.2');
  eq(describeToVersion('v0.1.2-3-g44e9b27', '0.1.0'), '0.1.2-dev+3.44e9b27');
  eq(describeToVersion('v0.1.2-0-g44e9b27-dirty', '0.1.0'), '0.1.2-dev+0.44e9b27.dirty');
  eq(describeToVersion('', '0.1.0'), '0.1.0-dev');
  eq(describeToVersion('release-1-0-gabc', '0.1.0'), '0.1.0-dev');
  console.log(process.argv.includes('--self-test') ? 'ok' : localVersion('0.0.0'));
}
