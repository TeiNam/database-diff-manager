import { useRef, useState } from 'react';
import { useFreshVersions } from '../../api/hooks';
import type { VersionSummary } from '../../api/types';

// 미리보기가 알려 준, 기준 버전보다 더 새 SQL 버전 (미리보기 응답의 versionNo·latestVersionNo)
export interface StalePreview {
  versionNo: number;
  latestVersionNo: number;
}

// 기준 버전보다 더 새 SQL 버전이 있어 최신 버전으로 옮기는 일. fetching: 목록을 새로 받는 중, moved: 옮길 버전(versionNo)을 정했다,
// failed: 새로 받은 목록에서 최신 SQL 버전을 찾지 못했다. stale: 미리보기가 알려 줬으면 그 미리보기 (저장 409 로 알았으면 없다 — 서버 메시지가 이유를 알린다)
export type Rebase =
  | { phase: 'fetching'; stale?: StalePreview }
  | { phase: 'moved'; stale?: StalePreview; versionNo: number }
  | { phase: 'failed'; stale?: StalePreview };

// 목록을 새로 받아 그 목록의 최신 SQL 버전을 onNewest 로 넘긴다 (리뷰 6회차 Codex #1). 409 가 알려 준 버전이 아니라 새로 받은 목록의 최신 버전이다 —
// 409 를 받은 뒤 목록이 오는 사이에도 다른 버전이 저장될 수 있다. cancel 하면(사용자가 기준 버전을 직접 고름·새 요청) 늦게 온 목록으로 옮기지 않는다
export function useRebase(schemaId: number | undefined, onNewest: (version: VersionSummary) => void) {
  const freshVersions = useFreshVersions(schemaId);
  const [rebase, setRebase] = useState<Rebase>();
  const latestRequest = useRef(0);
  const start = (stale?: StalePreview) => {
    const request = ++latestRequest.current;
    const isCurrent = () => request === latestRequest.current;
    setRebase({ phase: 'fetching', stale });
    freshVersions().then(
      (list) => {
        if (!isCurrent()) return;
        const newest = list.find((v) => v.sourceFormat === 'sql'); // 목록은 최신 버전이 앞이다
        if (newest) onNewest(newest);
        setRebase(newest ? { phase: 'moved', stale, versionNo: newest.versionNo } : { phase: 'failed', stale });
      },
      () => {
        if (isCurrent()) setRebase({ phase: 'failed', stale });
      },
    );
  };
  const cancel = () => {
    latestRequest.current++;
    setRebase(undefined);
  };
  return { state: rebase, isFetching: rebase?.phase === 'fetching', start, cancel };
}

const NEWEST_NOT_FOUND = '다시 받은 버전 목록에서 최신 SQL 버전을 찾지 못했습니다 — 목록을 받지 못했거나 다른 곳에서 지웠을 수 있습니다. 미리보기를 다시 실행하거나 대화상자를 닫았다 다시 여세요';

// 화면에 보일 안내 (없으면 undefined): 미리보기를 왜 남기지 않았는지와, 기준 버전을 어떻게 했는지
export function rebaseNotice(rebase: Rebase | undefined): string | undefined {
  if (rebase === undefined) return undefined;
  const { stale } = rebase;
  const why = stale && `미리보기한 기준 버전(v${stale.versionNo})보다 더 새 버전(v${stale.latestVersionNo})이 있어 이 미리보기로는 저장할 수 없습니다 — 대화상자를 연 뒤 다른 사용자가 저장했을 수 있습니다.`;
  return [why, nextStepOf(rebase)].filter(Boolean).join(' ') || undefined;
}

function nextStepOf(rebase: Rebase): string | undefined {
  if (rebase.phase === 'moved') return `기준 버전을 다시 받은 목록의 최신 버전(v${rebase.versionNo})으로 옮겼습니다 — 이 버전에서 미리보기를 다시 실행하세요. 옛 버전을 기준으로 저장하려면 기준 버전에서 직접 고르세요`;
  return rebase.phase === 'failed' ? NEWEST_NOT_FOUND : undefined; // 목록을 받는 중에는 아래 줄의 '불러오는 중' 이 알린다
}
