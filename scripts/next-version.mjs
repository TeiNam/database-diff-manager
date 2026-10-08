#!/usr/bin/env node
// 제품 버전을 정한다. 규칙:
// - 사람이 푸시한 태그(ref_type=tag): 그 태그 버전. vX.Y.Z 형식이 아니면 실패한다.
// - 이 커밋(GITHUB_SHA)에 이미 vX.Y.Z 태그가 있으면(같은 커밋 재실행) 그 버전을 다시 쓴다 (멱등).
// - 아니면 apps/web/package.json 의 major.minor 에서, 같은 major.minor 의 가장 큰 태그 다음 패치 번호. 해당 태그가 없으면 X.Y.0.
// latest 이미지 태그는 main 브랜치 실행이면서 그 커밋이 지금 origin/main HEAD 일 때만 붙인다 (오래된 run 재실행이 latest 를 되돌리지 않게).
// :X.Y 이미지 태그는 이 버전이 원격 vX.Y.* 태그 중 가장 큰 패치 이상일 때만 붙인다 (옛 커밋 재실행이 :X.Y 를 되돌리지 않게).
// 원격에 v<버전> 태그가 이미 있는데 다른 커밋을 가리키면 이미지 push·Release 전에 실패한다
// (커밋 A 가 계산한 버전을 커밋 B 가 먼저 출시한 뒤 A 의 잡만 재실행하는 경우).
// 사용: node scripts/next-version.mjs                 → 다음 버전만 출력
//       node scripts/next-version.mjs --github-output → GITHUB_* 환경 변수를 읽어 version=…, tag_exists=…, latest=… 출력
//       node scripts/next-version.mjs --check-tag     → VERSION·GITHUB_SHA 로 원격 태그 커밋 검증, minor_latest=… 출력
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

// git ls-remote --tags 출력 → Map<태그명, 커밋 sha>. 주석 태그는 벗긴(^{}) 커밋을 쓴다
export function parseRemoteTags(lines) {
  const out = new Map();
  for (const line of lines) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref?.startsWith('refs/tags/')) continue;
    const name = ref.slice('refs/tags/'.length);
    if (name.endsWith('^{}')) out.set(name.slice(0, -3), sha);
    else if (!out.has(name)) out.set(name, sha);
  }
  return out;
}

// v<버전> 태그가 이미 다른 커밋에 있으면 오류 메시지, 없거나 같은 커밋이면 undefined
export function tagConflict({ version, tagCommit, sha }) {
  if (tagCommit === undefined || tagCommit === sha) return undefined;
  return `v${version} 태그가 이미 다른 커밋(${tagCommit.slice(0, 7)})에 있습니다. 이 커밋(${sha.slice(0, 7)})으로 덮어쓰지 않도록 중단합니다. 실패한 잡만 재실행하지 말고 워크플로 전체를 다시 실행해 버전 계산부터 다시 하세요`;
}

// 이 버전이 원격 vX.Y.* 태그 중 가장 큰 패치 이상인지 (:X.Y 이미지 태그를 붙일지)
export function isMinorLatest(version, tags) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`버전 형식이 X.Y.Z 가 아닙니다: ${version}`);
  const patches = tags.map((t) => RELEASE_TAG.exec(t.trim())).filter((x) => x && x[1] === m[1] && x[2] === m[2]).map((x) => Number(x[3]));
  return patches.every((p) => Number(m[3]) >= p);
}

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
  const remote = parseRemoteTags(['aaa\trefs/tags/v0.1.0', 'ttt\trefs/tags/v0.1.1', 'bbb\trefs/tags/v0.1.1^{}', 'ccc\trefs/heads/main', '']);
  eq([...remote].map(([k, v]) => `${k}=${v}`).join(','), 'v0.1.0=aaa,v0.1.1=bbb'); // 주석 태그는 가리키는 커밋
  eq(tagConflict({ version: '0.1.2', tagCommit: undefined, sha: 'aaa' }), undefined); // 아직 태그 없음
  eq(tagConflict({ version: '0.1.2', tagCommit: 'aaa', sha: 'aaa' }), undefined); // 같은 커밋 재실행
  eq(/버전 계산부터 다시/.test(tagConflict({ version: '0.1.2', tagCommit: 'bbbbbbbbb', sha: 'aaaaaaaaa' })), true); // 다른 커밋이 이미 출시
  eq(isMinorLatest('0.1.3', ['v0.1.0', 'v0.1.2']), true); // 새 버전 (태그는 release 잡이 나중에 만든다)
  eq(isMinorLatest('0.1.2', ['v0.1.0', 'v0.1.2']), true); // 최신 패치 재실행
  eq(isMinorLatest('0.1.1', ['v0.1.1', 'v0.1.2']), false); // 옛 패치 재실행: :0.1 을 되돌리지 않는다
  eq(isMinorLatest('0.1.1', ['v0.1.1', 'v0.2.5', 'v1.1.9']), true); // 다른 X.Y 는 보지 않는다
  eq(isMinorLatest('0.1.9', ['v0.1.10']), false); // 숫자 비교
  throws(() => isMinorLatest('0.1', []), /버전 형식/);
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

// image·release 잡에서 쓴다. 원격 태그를 다시 읽어 판정한다 ("실패한 잡만 재실행" 때 앞선 잡의 판정이 낡았을 수 있음)
function checkTag() {
  const { VERSION: version = '', GITHUB_SHA: sha = '' } = process.env;
  if (!version || !sha) throw new Error('VERSION·GITHUB_SHA 가 없습니다');
  const remote = parseRemoteTags(git('ls-remote', '--tags', 'origin', 'refs/tags/v*'));
  const conflict = tagConflict({ version, tagCommit: remote.get(`v${version}`), sha });
  if (conflict) {
    console.log(`::error title=버전 태그 충돌::${conflict}`);
    process.exit(1);
  }
  console.log(`minor_latest=${isMinorLatest(version, [...remote.keys()])}`);
}

if (process.argv.includes('--self-test')) runSelfTest();
else if (process.argv.includes('--check-tag')) checkTag();
else if (process.argv.includes('--github-output')) printGithubOutput();
else console.log(nextVersion(readBaseVersion(), git('tag', '--list', 'v*')));
