import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { queryKeys, useDeleteDatabase, useDeleteSchema, useDeleteVersion } from '../src/api/hooks';
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
