// 모든 API 호출의 단일 통로: 같은 출처 쿠키, 변경 요청 CSRF 헤더, 오류 응답 → ApiError
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

export const UNAUTHORIZED_EVENT = 'tdm:unauthorized';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function api<T>(path: string, init: { method?: string; json?: unknown; form?: FormData } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (MUTATING.has(method)) headers['X-Requested-With'] = 'tdm';
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.form) {
    body = init.form;
  }
  const res = await fetch(`/api${path}`, { method, headers, body, credentials: 'same-origin' });
  const isJson = res.headers.get('content-type')?.includes('application/json') ?? false;
  const data = isJson ? await res.json() : undefined;
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    throw new ApiError(res.status, data?.error ?? `요청을 처리하지 못했습니다 (${res.status})`, data?.details);
  }
  return data as T;
}
