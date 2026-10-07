import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import type { Db } from '../db/connection';
import { AppError } from '../errors';
import type { User } from '../repos/users';
import { resolveSession, SESSION_COOKIE } from './session';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'tdm';

// 모든 요청에 대해(경로 인코딩 우회 방지) CSRF 헤더를 확인하고 세션 쿠키로 사용자를 붙인다
export function registerAuth(app: FastifyInstance, ctx: { db: Db; config: Config }): void {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    if (MUTATING_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== CSRF_VALUE) {
      throw new AppError(403, '허용되지 않은 요청입니다');
    }
    const token = req.cookies[SESSION_COOKIE];
    req.user = token ? resolveSession(ctx.db, token, ctx.config.sessionTtlMs) ?? null : null;
  });
}

export async function requireLogin(req: FastifyRequest): Promise<void> {
  if (!req.user) throw new AppError(401, '로그인이 필요합니다');
}

export async function requireAdmin(req: FastifyRequest): Promise<void> {
  await requireLogin(req);
  if (req.user!.role !== 'admin') throw new AppError(403, '관리자 권한이 필요합니다');
}
