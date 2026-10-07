import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig, parseTrustProxy } from '../src/config';
import { CSRF, testApp } from './helpers';

const attempt = (app: FastifyInstance, username: string, ip?: string) =>
  app.inject({
    method: 'POST', url: '/api/auth/login',
    headers: { ...CSRF, ...(ip ? { 'x-forwarded-for': ip } : {}) },
    payload: { username, password: 'wrong-password' },
  });

describe('TRUST_PROXY 파싱', () => {
  it('기본값과 false는 꺼짐', () => {
    expect(loadConfig({}).trustProxy).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('  ')).toBe(false);
  });

  it('true, 정수 홉 수, IP/CIDR 목록', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('2')).toBe(2);
    expect(loadConfig({ TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' }).trustProxy).toBe('10.0.0.0/8,127.0.0.1');
  });
});

describe('로그인 rate limit 키', () => {
  it('trustProxy가 켜지면 X-Forwarded-For별로 따로 제한한다', async () => {
    const { app } = await testApp({ trustProxy: true });
    for (let i = 0; i < 5; i++) expect((await attempt(app, 'kim', '1.1.1.1')).statusCode).toBe(401);
    expect((await attempt(app, 'kim', '1.1.1.1')).statusCode).toBe(429);
    expect((await attempt(app, 'kim', '2.2.2.2')).statusCode).toBe(401);
  });

  it('trustProxy가 꺼져 있으면 X-Forwarded-For를 무시한다', async () => {
    const { app } = await testApp();
    for (let i = 0; i < 5; i++) await attempt(app, 'kim', `9.9.9.${i}`);
    expect((await attempt(app, 'kim', '9.9.9.99')).statusCode).toBe(429);
  });

  it('같은 IP라도 사용자명이 다르면 따로 제한한다 (대소문자 무시)', async () => {
    const { app } = await testApp();
    for (let i = 0; i < 5; i++) expect((await attempt(app, i % 2 ? 'Kim' : 'kim')).statusCode).toBe(401);
    expect((await attempt(app, 'KIM')).statusCode).toBe(429);
    expect((await attempt(app, 'lee')).statusCode).toBe(401);
  });
});
