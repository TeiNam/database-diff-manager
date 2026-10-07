import { describe, expect, it, vi } from 'vitest';
import { api, ApiError, UNAUTHORIZED_EVENT } from '../src/api/client';
import { json, mockApi } from './render';

describe('api', () => {
  it('GET은 CSRF 헤더 없이, 변경 요청은 X-Requested-With와 JSON 본문으로 보낸다', async () => {
    const calls = mockApi({ '/api/tree': [], 'POST /api/users': { id: 1 } });
    await api('/tree');
    await api('/users', { method: 'POST', json: { username: 'a' } });
    expect(calls[0].init.headers).toEqual({});
    expect(calls[1].init).toMatchObject({
      method: 'POST', credentials: 'same-origin', body: '{"username":"a"}',
      headers: { 'X-Requested-With': 'tdm', 'Content-Type': 'application/json' },
    });
  });

  it('오류 응답은 서버 메시지를 담은 ApiError', async () => {
    mockApi({ '/api/x': json({ error: '권한이 없습니다', details: [1] }, 403) });
    await expect(api('/x')).rejects.toMatchObject({ status: 403, message: '권한이 없습니다', details: [1] });
    await expect(api('/x')).rejects.toBeInstanceOf(ApiError);
  });

  it('401이면 로그아웃 이벤트를 보낸다', async () => {
    mockApi({ '/api/x': json({ error: '로그인이 필요합니다' }, 401) });
    const listener = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, listener);
    await expect(api('/x')).rejects.toBeInstanceOf(ApiError);
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(UNAUTHORIZED_EVENT, listener);
  });

  it('JSON이 아닌 오류 응답에도 기본 메시지', async () => {
    mockApi({ '/api/x': new Response('boom', { status: 502 }) });
    await expect(api('/x')).rejects.toMatchObject({ status: 502, message: '요청을 처리하지 못했습니다 (502)' });
  });
});
