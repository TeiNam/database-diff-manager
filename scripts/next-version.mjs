#!/usr/bin/env node
// 제품 버전을 정한다. 규칙:
// - 사람이 푸시한 태그(ref_type=tag): 그 태그 버전. vX.Y.Z 형식이 아니면 실패한다.
// - 이 커밋(GITHUB_SHA)에 이미 vX.Y.Z 태그가 있으면(같은 커밋 재실행) 그 버전을 다시 쓴다 (멱등).
// - 아니면 apps/web/package.json 의 major.minor 에서, 같은 major.minor 의 가장 큰 태그 다음 패치 번호. 해당 태그가 없으면 X.Y.0.
// latest 이미지 태그는 main 브랜치 실행이면서 그 커밋이 지금 origin/main HEAD 일 때만 붙인다 (오래된 run 재실행이 latest 를 되돌리지 않게).
// 사용: node scripts/next-version.mjs                 → 다음 버전만 출력
//       node scripts/next-version.mjs --github-output → GITHUB_* 환경 변수를 읽어 version=…, tag_exists=…, latest=… 출력
//       node scripts/next-version.mjs --self-test     → 계산 규칙 확인
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

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

// 정식 태그 중 가장 큰 버전 (숫자 비교)
function highestReleaseTag(tags) {
  const parsed = tags.map((t) => RELEASE_TAG.exec(t.trim())).filter(Boolean).map((m) => m.slice(1, 4).map(Number));
  if (parsed.length === 0) return undefined;
  parsed.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return parsed[parsed.length - 1].join('.');
}

// { version, tagExists }. tagExists 면 release 잡은 태그를 새로 만들지 않는다
export function resolveVersion({ refType, refName, baseVersion, tags, tagsAtSha }) {
  if (refType === 'tag') {
    if (!RELEASE_TAG.test(refName)) throw new Error(`태그 형식이 vX.Y.Z 가 아닙니다: ${refName}`);
    return { version: refName.slice(1), tagExists: true };
  }
  const existing = highestReleaseTag(tagsAtSha);
  if (existing !== undefined) return { version: existing, tagExists: true };
  return { version: nextVersion(baseVersion, tags), tagExists: false };
}

export const isLatest = ({ refType, refName, sha, mainHead }) => refType === 'branch' && refName === 'main' && sha === mainHead;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).split('\n').map((l) => l.trim()).filter(Boolean);

function runSelfTest() {
  const eq = (a, b) => { if (a !== b) throw new Error(`${a} !== ${b}`); };
  eq(nextVersion('0.1.0', []), '0.1.0');
  eq(nextVersion('0.1.0', ['v0.1.0', 'v0.1.2', 'v0.1.1']), '0.1.3');
  eq(nextVersion('0.2.0', ['v0.1.9']), '0.2.0'); // 마이너를 올리면 패치는 0부터
  eq(nextVersion('0.1.0', ['v0.1.10', 'v0.1.9', 'v0.1.x', 'release-1']), '0.1.11');
  const throws = (fn, pattern) => {
    try { fn(); } catch (e) { if (pattern.test(e.message)) return; throw e; }
    throw new Error(`예외가 나야 합니다: ${pattern}`);
  };
  const base = { refType: 'branch', refName: 'main', baseVersion: '0.1.0', tags: ['v0.1.0', 'v0.1.1'], tagsAtSha: [] };
  const show = (r) => `${r.version}/${r.tagExists}`;
  eq(show(resolveVersion(base)), '0.1.2/false'); // 새 커밋: 다음 패치를 새로 만든다
  eq(show(resolveVersion({ ...base, tagsAtSha: ['v0.1.1'] })), '0.1.1/true'); // 재실행: 이 커밋의 태그를 다시 쓴다
  eq(show(resolveVersion({ ...base, tagsAtSha: ['v0.1.1', 'v0.1.x', 'v0.1.3'] })), '0.1.3/true'); // 여럿이면 가장 큰 정식 태그
  eq(show(resolveVersion({ ...base, refType: 'tag', refName: 'v2.0.5' })), '2.0.5/true'); // 사람이 푸시한 태그
  throws(() => resolveVersion({ ...base, refType: 'tag', refName: 'v2.0' }), /태그 형식/);
  throws(() => resolveVersion({ ...base, refType: 'tag', refName: 'v1.2.3-rc1' }), /태그 형식/);
  eq(isLatest({ refType: 'branch', refName: 'main', sha: 'abc', mainHead: 'abc' }), true);
  eq(isLatest({ refType: 'branch', refName: 'main', sha: 'abc', mainHead: 'def' }), false); // 오래된 run 재실행
  eq(isLatest({ refType: 'tag', refName: 'v0.1.0', sha: 'abc', mainHead: 'abc' }), false);
  console.log('ok');
}

function readBaseVersion() {
  return JSON.parse(readFileSync(new URL('../apps/web/package.json', import.meta.url), 'utf8')).version;
}

// 워크플로의 version 잡에서 쓴다. 출력은 그대로 $GITHUB_OUTPUT 에 붙인다
function printGithubOutput() {
  const { GITHUB_REF_TYPE: refType = '', GITHUB_REF_NAME: refName = '', GITHUB_SHA: sha = '' } = process.env;
  if (!sha) throw new Error('GITHUB_SHA 가 없습니다');
  const { version, tagExists } = resolveVersion({
    refType, refName, baseVersion: readBaseVersion(), tags: git('tag', '--list', 'v*'), tagsAtSha: git('tag', '--points-at', sha, '--list', 'v*'),
  });
  const mainHead = git('ls-remote', 'origin', 'refs/heads/main')[0]?.split(/\s+/)[0] ?? '';
  console.log(`version=${version}\ntag_exists=${tagExists}\nlatest=${isLatest({ refType, refName, sha, mainHead })}`);
}

if (process.argv.includes('--self-test')) runSelfTest();
else if (process.argv.includes('--github-output')) printGithubOutput();
else console.log(nextVersion(readBaseVersion(), git('tag', '--list', 'v*')));
