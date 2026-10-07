import { useCallback, useLayoutEffect, useRef } from 'react';
import { useLocation, useMatch, useNavigate, useSearchParams } from 'react-router';

export type Tab = 'summary' | 'diff' | 'ddl';

export const positive = (v: string | null | undefined) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

// 스키마 화면의 모든 상태는 URL에 둔다 (공유 링크로 같은 화면이 열린다)
export function useSchemaContext() {
  const match = useMatch({ path: '/db/:dbId/schema/:schemaId', end: false });
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  // set 은 항상 같은 함수여야 하고, 같은 틱의 연속 호출이 서로의 패치를 잃지 않아야 한다.
  // 그래서 최신 위치·navigate 를 ref 로 들고, 호출 때마다 ref 의 search 를 갱신한다
  const latest = useRef({ pathname: location.pathname, search: location.search, navigate });
  // 렌더 중에는 ref 를 쓰지 않고, 커밋 직후 레이아웃 단계에서 최신 값으로 맞춘다
  useLayoutEffect(() => {
    latest.current = { ...latest.current, pathname: location.pathname, search: location.search, navigate };
  }, [location.pathname, location.search, navigate]);
  const set = useCallback((patch: Record<string, string | number | undefined>) => {
    const cur = latest.current;
    const next = new URLSearchParams(cur.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '') next.delete(k);
      else next.set(k, String(v));
    }
    const qs = next.toString();
    cur.search = qs ? `?${qs}` : '';
    cur.navigate({ pathname: cur.pathname, search: cur.search }, { replace: true });
  }, []);
  const tab = params.get('tab');
  return {
    dbId: positive(match?.params.dbId),
    schemaId: positive(match?.params.schemaId),
    base: positive(params.get('base')),
    target: positive(params.get('target')),
    tab: (tab === 'summary' || tab === 'ddl' ? tab : 'diff') as Tab,
    obj: params.get('obj') ?? undefined,
    objKind: (params.get('kind') === 'view' ? 'view' : 'table') as 'table' | 'view',
    mode: (params.get('mode') === 'grid' ? 'grid' : 'sql') as 'sql' | 'grid',
    layout: (params.get('layout') === 'unified' ? 'unified' : 'split') as 'split' | 'unified',
    set,
  };
}
