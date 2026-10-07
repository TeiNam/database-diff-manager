import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app';
import { hashPassword, verifyPassword } from '../auth/password';
import { requireLogin } from '../auth/plugin';
import { createSession, deleteSession, purgeExpiredSessions, SESSION_COOKIE } from '../auth/session';
import { AppError } from '../errors';
import { findLoginCandidate, type User } from '../repos/users';

const LoginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) });

// ip+사용자명으로 제한해 같은 NAT 뒤의 다른 사용자가 함께 잠기지 않게 한다
export function loginRateKey(req: FastifyRequest): string {
  const username = (req.body as { username?: unknown } | null | undefined)?.username;
  return typeof username === 'string' && username ? `${req.ip}:${username.toLowerCase()}` : req.ip;
}
const LOGIN_RATE_LIMIT = { max: 5, timeWindow: '1 minute', keyGenerator: loginRateKey };

// 없는 사용자도 같은 시간만큼 해시 비교를 해서 응답 시간으로 계정 존재를 알 수 없게 한다
// 모듈 로드 시점에 미리 계산해 첫 요청의 시간 편차를 없앤다
const dummyHash: Promise<string> = hashPassword('dummy-password-for-timing');

export const publicUser = (u: User) => ({ id: u.id, username: u.username, role: u.role });

export function authRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/login', { config: { rateLimit: LOGIN_RATE_LIMIT } }, async (req, reply) => {
    const { username, password } = LoginBody.parse(req.body);
    const candidate = findLoginCandidate(ctx.db, username);
    const valid = await verifyPassword(password, candidate?.passwordHash ?? (await dummyHash));
    if (!candidate || candidate.disabled || !valid) throw new AppError(401, '사용자명 또는 비밀번호가 올바르지 않습니다');
    purgeExpiredSessions(ctx.db);
    const token = createSession(ctx.db, candidate.id, ctx.config.sessionTtlMs);
    // maxAge 없이 브라우저 세션 쿠키로 두고, 만료는 서버의 expires_at이 정한다(슬라이딩)
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/', httpOnly: true, sameSite: 'strict', secure: ctx.config.cookieSecure,
    });
    return publicUser(candidate);
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) deleteSession(ctx.db, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', { preHandler: requireLogin }, async (req) => publicUser(req.user!));
}
