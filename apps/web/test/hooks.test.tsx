import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIFF_REFETCH_MS, DIFF_STALE_MS, queryKeys, useDeleteDatabase, useDeleteMigration, useDeleteSchema, useDeleteVersion, useDiff, useMigrationFlow, useUploadMigration } from '../src/api/hooks';
import { mockApi } from './render';

// 삭제된 id 를 SQLite 가 다시 쓸 수 있어, 지운 버전·스키마·객체 이력 캐시가 남으면 새 데이터 대신 옛 내용이 보인다
describe('삭제 훅의 캐시 정리', () => {
  const setup = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(queryKeys.version(12), { id: 12 });
    client.setQueryData(queryKeys.schema(7), { id: 7 });
    client.setQueryData(queryKeys.objectHistory(5), { object: { id: 5 } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    return { client, wrapper };
  };
  const cached = (client: QueryClient) => [queryKeys.version(12), queryKeys.objectHistory(5)].map((k) => client.getQueryData(k));

  it.each([
    ['버전', () => { const m = useDeleteVersion(); return { isSuccess: m.isSuccess, run: () => m.mutate(12) }; }, false],
    ['Schema', () => { const m = useDeleteSchema(); return { isSuccess: m.isSuccess, run: () => m.mutate({ id: 7, confirmName: 'shop' }) }; }, true],
    ['Database', () => { const m = useDeleteDatabase(); return { isSuccess: m.isSuccess, run: () => m.mutate({ id: 1, confirmName: 'db' }) }; }, true],
  ] as const)('%s 삭제 후 version·object-history(Schema·Database 는 schema 도) 캐시를 지운다', async (_label, useHook, isSchemaRemoved) => {
    mockApi({ 'DELETE /api/versions/12': { ok: true }, 'DELETE /api/schemas/7': { ok: true }, 'DELETE /api/databases/1': { ok: true } });
    const { client, wrapper } = setup();
    const { result } = renderHook(useHook, { wrapper });
    result.current.run();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(cached(client)).toEqual([undefined, undefined]);
    // 버전 삭제는 스키마가 그대로 남는다
    expect(client.getQueryData(queryKeys.schema(7))).toEqual(isSchemaRemoved ? undefined : { id: 7 });
  });
});

// 쌍의 최신 매핑이 바뀌면 rename 이 반영된 diff·전환 표·리비전 목록이 모두 달라진다
describe('전환 매핑 훅의 캐시 정리', () => {
  const KEYS = [queryKeys.diff(11, 12), queryKeys.migrationFlow(11, 12), queryKeys.migrations(1, 2)];
  const setup = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    for (const key of KEYS) client.setQueryData(key, { cached: true });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    return { client, wrapper };
  };

  it.each([
    ['올리기', () => { const m = useUploadMigration(); return { isSuccess: m.isSuccess, run: () => m.mutate({ fromSchemaId: 1, toSchemaId: 2, filename: 'm.json', source: '{"rules":[]}' }) }; }],
    ['삭제', () => { const m = useDeleteMigration(); return { isSuccess: m.isSuccess, run: () => m.mutate(5) }; }],
  ] as const)('%s 후 diff·전환 표·리비전 목록을 무효화한다', async (_label, useHook) => {
    mockApi({ 'POST /api/migrations': { migration: { id: 5 }, warnings: [] }, 'DELETE /api/migrations/5': { ok: true } });
    const { client, wrapper } = setup();
    const { result } = renderHook(useHook, { wrapper });
    result.current.run();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(KEYS.map((k) => client.getQueryState(k)?.isInvalidated)).toEqual([true, true, true]);
  });

  it('Schema 삭제는 전환 표·리비전 캐시도 지운다', async () => {
    mockApi({ 'DELETE /api/schemas/7': { ok: true } });
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useDeleteSchema(), { wrapper });
    result.current.mutate({ id: 7, confirmName: 'shop' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(KEYS.map((k) => client.getQueryData(k))).toEqual([undefined, undefined, undefined]);
  });
});

// 다른 사용자가 바꾼 전환 매핑·rename 이 반영되도록 diff·전환 표는 30초가 지나면 다시 받는다
describe('diff·전환 표 신선도', () => {
  it.each([
    ['diff', (): { isSuccess: boolean } => useDiff(11, 12), queryKeys.diff(11, 12)],
    ['migration-flow', (): { isSuccess: boolean } => useMigrationFlow(11, 12), queryKeys.migrationFlow(11, 12)],
  ] as const)('%s 의 staleTime 은 30초', async (_label, useHook, key) => {
    mockApi({ '/api/diff?base=11&target=12': {}, '/api/migration-flow?base=11&target=12': { mapping: null } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(useHook, { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const observer = client.getQueryCache().find({ queryKey: key })!.observers[0];
    expect(observer.options.staleTime).toBe(DIFF_STALE_MS);
    expect(DIFF_STALE_MS).toBe(30_000);
  });
});

// staleTime 은 재요청을 예약하지 않는다. 다른 사용자의 변경이 반영되도록 주기 재조회·포커스 재조회를 켠다
describe('diff·전환 표 주기적 재조회', () => {
  afterEach(() => {
    vi.useRealTimers();
    focusManager.setFocused(undefined);
  });

  it.each([
    ['diff', (): unknown => useDiff(11, 12), '/api/diff?base=11&target=12'],
    ['migration-flow', (): unknown => useMigrationFlow(11, 12), '/api/migration-flow?base=11&target=12'],
  ] as const)('%s 는 60초마다 다시 받고(백그라운드 탭에선 멈춤), 창으로 돌아오면 다시 받는다', async (_label, useHook, url) => {
    vi.useFakeTimers();
    const calls = mockApi({ '/api/diff?base=11&target=12': {}, '/api/migration-flow?base=11&target=12': { mapping: null } });
    const count = () => calls.filter((c) => c.url === url).length;
    // 전역 기본값(main.tsx)처럼 포커스 재조회를 끈 클라이언트에서도 쿼리별 옵션이 이긴다
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    renderHook(useHook, { wrapper });
    await vi.advanceTimersByTimeAsync(0);
    expect(count()).toBe(1);
    await vi.advanceTimersByTimeAsync(DIFF_REFETCH_MS);
    expect(count()).toBe(2);
    focusManager.setFocused(false);
    await vi.advanceTimersByTimeAsync(DIFF_REFETCH_MS * 2);
    expect(count()).toBe(2);
    focusManager.setFocused(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(count()).toBe(3);
    expect(DIFF_REFETCH_MS).toBe(60_000);
  });
});
