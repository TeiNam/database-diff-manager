import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { vi } from 'vitest';

type Handler = unknown | ((init: RequestInit, url: string) => unknown);

// fetch 를 대체한다. 키는 "METHOD /api/path?query" 또는 경로만. 값이 Response 면 그대로 돌려준다
export function mockApi(routes: Record<string, Handler>) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const handler = routes[`${init.method ?? 'GET'} ${url}`] ?? routes[url];
    if (handler === undefined) return json({ error: '없는 경로' }, 404);
    const body = typeof handler === 'function' ? await (handler as (i: RequestInit, u: string) => unknown)(init, url) : handler;
    // Response 는 본문을 한 번만 읽을 수 있어 호출마다 복제본을 돌려준다
    return body instanceof Response ? body.clone() : json(body, 200);
  }));
  return calls;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

export function renderWithProviders(ui: ReactElement, { route = '/', path = '*' }: { route?: string; path?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path={path} element={<>{ui}<LocationProbe /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
