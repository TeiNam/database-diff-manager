import type { RenameMapping } from '@tdm/core';
import { useIsFetching, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api, ApiError } from './client';
import type { AlterDefaultsSuggestion, AlterRequest, AlterResponse, Derivation, DiffResponse, Me, MigrationFlowResponse, MigrationMeta, MigrationUploadInput, MigrationUploadResult, ObjectHistory, Role, SchemaInfo, TreeDatabase, UploadMeta, UploadResult, User, VersionDetail, VersionSummary } from './types';

export const queryKeys = {
  me: ['me'] as const,
  tree: ['tree'] as const,
  schema: (id?: number) => ['schema', id] as const,
  versions: (schemaId?: number) => ['versions', schemaId] as const,
  version: (id?: number) => ['version', id] as const,
  alterDefaults: (id?: number) => ['alter-defaults', id] as const,
  diff: (base?: number, target?: number) => ['diff', base, target] as const,
  users: ['users'] as const,
  objectHistory: (id?: number) => ['object-history', id] as const,
  migrationFlow: (base?: number, target?: number) => ['migration-flow', base, target] as const,
  migrations: (from?: number, to?: number) => ['migrations', from, to] as const,
};

export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: () => api<Me>('/auth/me').catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }),
    staleTime: 60_000,
  });
}

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { username: string; password: string }) => api<Me>('/auth/login', { method: 'POST', json: body }),
    onSuccess: (me) => client.setQueryData(queryKeys.me, me),
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: true }>('/auth/logout', { method: 'POST' }),
    // 실패해도 화면은 로그인으로 가므로, 남은 me 캐시가 되돌려 보내지 않게 항상 비운다
    onSettled: () => {
      client.clear();
      client.setQueryData(queryKeys.me, null);
    },
  });
}

export const useTree = () => useQuery({ queryKey: queryKeys.tree, queryFn: () => api<TreeDatabase[]>('/tree') });

export const useSchemaInfo = (id?: number) =>
  useQuery({ queryKey: queryKeys.schema(id), queryFn: () => api<SchemaInfo>(`/schemas/${id}`), enabled: id !== undefined });

export const useVersions = (schemaId?: number) =>
  useQuery({ queryKey: queryKeys.versions(schemaId), queryFn: () => api<VersionSummary[]>(`/schemas/${schemaId}/versions`), enabled: schemaId !== undefined });

export const useVersion = (id?: number) =>
  useQuery({ queryKey: queryKeys.version(id), queryFn: () => api<VersionDetail>(`/versions/${id}`), enabled: id !== undefined, staleTime: Infinity });

// 버전 내용은 불변이지만 diff 에 반영되는 전환 매핑·수동 rename 은 다른 사용자가 바꿀 수 있다.
// 내가 바꾼 것은 mutation 이 캐시를 갱신·무효화한다. 남이 바꾼 것은 staleTime 이 지난 뒤 창으로 돌아오거나
// DIFF_REFETCH_MS 주기(보이는 탭에서만 — 백그라운드 탭에선 멈춘다)로 다시 받아 반영한다.
// staleTime 만으로는 재요청이 예약되지 않고 전역 refetchOnWindowFocus 가 꺼져 있어 쿼리별로 켠다
export const DIFF_STALE_MS = 30_000;
export const DIFF_REFETCH_MS = 60_000;
const LIVE_QUERY = { staleTime: DIFF_STALE_MS, refetchOnWindowFocus: true, refetchInterval: DIFF_REFETCH_MS } as const;

const fetchDiff = (base?: number, target?: number) => api<DiffResponse>(`/diff?base=${base}&target=${target}`);

export const useDiff = (base?: number, target?: number) =>
  useQuery({
    queryKey: queryKeys.diff(base, target),
    queryFn: () => fetchDiff(base, target),
    enabled: base !== undefined && target !== undefined,
    ...LIVE_QUERY,
  });

// 복사·다운로드 직전에 최신 diff 를 한 번 더 받는다 (캐시가 신선해도 서버에 다시 묻는다). 결과는 캐시에도 반영된다
export function useFreshDiff(base: number, target: number): () => Promise<DiffResponse> {
  const client = useQueryClient();
  return useCallback(
    () => client.fetchQuery({ queryKey: queryKeys.diff(base, target), queryFn: () => fetchDiff(base, target), staleTime: 0 }),
    [client, base, target],
  );
}

export function useSaveRenames() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { base: number; target: number; renames: RenameMapping[] }) => api<DiffResponse>('/diff/renames', { method: 'PUT', json: body }),
    onSuccess: (data, body) => client.setQueryData(queryKeys.diff(body.base, body.target), data),
  });
}

export function useUpload() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { meta: UploadMeta[]; files: File[] }) => {
      const form = new FormData();
      form.append('meta', JSON.stringify(input.meta));
      input.files.forEach((file, i) => form.append('files', file, input.meta[i].filename));
      return api<{ results: UploadResult[] }>('/uploads', { method: 'POST', form });
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.tree });
      client.invalidateQueries({ queryKey: ['versions'] });
      client.invalidateQueries({ queryKey: ['object-history'] }); // 새 버전으로 객체 리비전이 늘어난다
    },
  });
}

// 삭제된 id 는 SQLite 가 다시 쓸 수 있다 → id 로 캐시한 내용이 남으면 새 객체 자리에 옛 내용이 보인다
const CATALOG_CACHE_KEYS = [['versions'], ['version'], ['schema'], ['object-history'], ['diff'], ['migration-flow'], ['migrations'], ['derivation'], ['alter-defaults']] as const;

export function useDeleteVersion() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<{ ok: true }>(`/versions/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      client.invalidateQueries({ queryKey: queryKeys.tree });
      client.invalidateQueries({ queryKey: ['versions'] });
      // 스키마는 그대로 남는다. 지운 버전과 그 버전을 담은 객체 이력·diff 는 버린다
      client.removeQueries({ queryKey: queryKeys.version(id) });
      client.removeQueries({ queryKey: queryKeys.alterDefaults(id) });
      client.removeQueries({ queryKey: ['object-history'] });
      client.removeQueries({ queryKey: ['diff'] });
      client.removeQueries({ queryKey: ['migration-flow'] });
      client.removeQueries({ queryKey: ['derivation'] });
    },
  });
}

// Schema·Database 삭제는 하위 버전까지 연쇄로 지워지므로 서버가 확인용 이름을 요구한다
function useDeleteCatalog(path: 'schemas' | 'databases') {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: number; confirmName: string }) =>
      api<{ ok: true }>(`/${path}/${input.id}`, { method: 'DELETE', json: { confirmName: input.confirmName } }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.tree });
      for (const queryKey of CATALOG_CACHE_KEYS) client.removeQueries({ queryKey });
    },
  });
}

export const useDeleteSchema = () => useDeleteCatalog('schemas');
export const useDeleteDatabase = () => useDeleteCatalog('databases');

export const useUsers = (enabled: boolean) =>
  useQuery({ queryKey: queryKeys.users, queryFn: () => api<User[]>('/users'), enabled });

export function useCreateUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { username: string; password: string; role: Role }) => api<User>('/users', { method: 'POST', json: body }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.users }),
  });
}

export function usePatchUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: number; role?: Role; disabled?: boolean; password?: string }) => api<User>(`/users/${id}`, { method: 'PATCH', json: patch }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.users }),
  });
}

export const useObjectHistory = (id?: number) =>
  useQuery({ queryKey: queryKeys.objectHistory(id), queryFn: () => api<ObjectHistory>(`/objects/${id}/history`), enabled: id !== undefined });

// 전환 매핑은 내가 올리기·삭제하면 캐시를 무효화하고, 다른 사용자가 바꾼 것은 diff 와 같은 주기·포커스 재조회로 받는다.
// enabled=false(같은 Schema 끼리 비교 등)면 요청하지 않는다
export const useMigrationFlow = (base?: number, target?: number, enabled = true) =>
  useQuery({
    queryKey: queryKeys.migrationFlow(base, target),
    queryFn: () => api<MigrationFlowResponse>(`/migration-flow?base=${base}&target=${target}`),
    enabled: enabled && base !== undefined && target !== undefined,
    ...LIVE_QUERY,
  });

export const useMigrations = (from: number, to: number, enabled: boolean) =>
  useQuery({ queryKey: queryKeys.migrations(from, to), queryFn: () => api<MigrationMeta[]>(`/migrations?from=${from}&to=${to}`), enabled });

// 쌍의 최신 매핑이 바뀌면 diff(rename 반영)·전환 표·리비전 목록이 모두 달라진다
const MIGRATION_DEPENDENT_KEYS = [['diff'], ['migration-flow'], ['migrations']] as const;

function useMigrationMutation<T, R>(fn: (input: T) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const queryKey of MIGRATION_DEPENDENT_KEYS) client.invalidateQueries({ queryKey });
    },
  });
}

export const useUploadMigration = () =>
  useMigrationMutation((input: MigrationUploadInput) => api<MigrationUploadResult>('/migrations', { method: 'POST', json: input }));

export const useDeleteMigration = () =>
  useMigrationMutation((id: number) => api<{ ok: true }>(`/migrations/${id}`, { method: 'DELETE' }));

// ALTER 스크립트 적용 (미리보기는 저장하지 않으므로 캐시를 건드리지 않는다)
export function useApplyAlter() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { baseId: number; body: AlterRequest }) => api<AlterResponse>(`/versions/${input.baseId}/alter`, { method: 'POST', json: input.body }),
    onSuccess: (data) => {
      if (data.status === 'preview') return;
      client.invalidateQueries({ queryKey: queryKeys.tree });
      client.invalidateQueries({ queryKey: ['versions'] });
      client.invalidateQueries({ queryKey: ['object-history'] });
    },
  });
}

// 버전 목록을 다 받았는데도 이 버전이 그 안에 없는지 (ALTER 적용 뒤 기다리던 버전이 끝내 오지 않았는지 가린다).
// 목록을 받는 중이면 아직 모르고, 캐시에 이 스키마의 목록이 없으면 알 수 없다 — 둘 다 false 다.
// 목록 쿼리를 하나 더 만들지 않고 캐시만 읽는다: 같은 키에 옵션(queryFn)이 다른 관찰자를 두면 목록을 받는 함수가 뒤섞인다
export function useIsVersionMissing(schemaId: number | undefined, versionId: number | undefined): boolean {
  const client = useQueryClient();
  const key = queryKeys.versions(schemaId);
  const isFetching = useIsFetching({ queryKey: key }) > 0;
  const list = client.getQueryData<VersionSummary[]>(key);
  return versionId !== undefined && !isFetching && list !== undefined && !list.some((v) => v.id === versionId);
}

export const useDerivation = (id?: number) =>
  useQuery({ queryKey: ['derivation', id] as const, queryFn: () => api<Derivation>(`/versions/${id}/derivation`), enabled: id !== undefined, staleTime: Infinity });

// ALTER 적용 대화상자의 스키마 기본값 제안 (기준 버전 테이블의 DEFAULT CHARSET·COLLATE 최빈값). 대화상자의 첫 값이 되므로
// 실패하면 다시 시도하지 않고 바로 알린다
export const useAlterDefaults = (versionId?: number) =>
  useQuery({
    queryKey: queryKeys.alterDefaults(versionId),
    queryFn: () => api<AlterDefaultsSuggestion>(`/versions/${versionId}/alter-defaults`),
    enabled: versionId !== undefined,
    staleTime: Infinity,
    retry: false,
  });
