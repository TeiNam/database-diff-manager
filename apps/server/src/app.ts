import cookie from '@fastify/cookie';
import helmet, { type FastifyHelmetOptions } from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { registerAuth } from './auth/plugin';
import type { Config } from './config';
import type { Db } from './db/connection';
import { AppError } from './errors';
import { JSON_BODY_LIMIT, MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES } from './limits';
import { authRoutes } from './routes/auth';
import { catalogRoutes } from './routes/databases';
import { diffRoutes } from './routes/diff';
import { migrationRoutes } from './routes/migrations';
import { objectRoutes } from './routes/objects';
import { uploadRoutes } from './routes/uploads';
import { userRoutes } from './routes/users';
import { versionRoutes } from './routes/versions';
import { registerWeb } from './static';
import { DiffCache } from './services/diff-service';

export interface AppContext {
  db: Db;
  config: Config;
  cache: DiffCache;
}

// diff 캐시에 보관하는 최대 항목 수
const DIFF_CACHE_SIZE = 50;

// '/api' 자체와 '/api?x=1' 도 API 영역으로 본다 (SPA 폴백 대상이 아니다)
const isApiUrl = (url: string) => url === '/api' || /^\/api[/?]/.test(url);

export type RouteModule = (app: FastifyInstance, ctx: AppContext) => void;

export { MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES };

export const ROUTES: [string, RouteModule][] = [
  ['/api/auth', authRoutes],
  ['/api/users', userRoutes],
  ['/api', catalogRoutes],
  ['/api/uploads', uploadRoutes],
  ['/api', versionRoutes],
  ['/api/diff', diffRoutes],
  ['/api/objects', objectRoutes],
  ['/api', migrationRoutes],
];

// HTTP 모드(cookieSecure=false)에서는 HSTS와 https 승격을 꺼서 평문 배포가 https로 끌려가지 않게 한다
function helmetOptions(config: Config): FastifyHelmetOptions {
  const directives: Record<string, unknown> = { defaultSrc: ["'self'"] };
  if (!config.cookieSecure) directives.upgradeInsecureRequests = null;
  return { contentSecurityPolicy: { directives }, ...(config.cookieSecure ? {} : { hsts: false }) } as FastifyHelmetOptions;
}

export async function buildApp(deps: { db: Db; config: Config }, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { redact: ['req.headers.cookie', 'req.body.password'] },
    bodyLimit: JSON_BODY_LIMIT,
    // 런타임은 홉 수(number)도 받지만 Fastify 타입 정의에는 빠져 있어 좁혀서 넘긴다
    trustProxy: (deps.config.trustProxy ?? false) as string | boolean,
  });
  const ctx: AppContext = { ...deps, cache: new DiffCache(DIFF_CACHE_SIZE) };
  await app.register(helmet, helmetOptions(deps.config));
  await app.register(cookie);
  await app.register(rateLimit, { global: false, hook: 'preHandler' });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_UPLOAD_FILES } });
  registerAuth(app, ctx);
  app.setErrorHandler(handleError);
  const hasWeb = await registerWeb(app, deps.config.webDist);
  app.setNotFoundHandler((req, reply) => {
    // SPA 경로(GET, /api 밖)는 index.html 로 돌려 클라이언트 라우터가 처리하게 한다
    if (hasWeb && req.method === 'GET' && !isApiUrl(req.url)) return reply.type('text/html').sendFile('index.html');
    return reply.status(404).send({ error: '요청한 경로를 찾을 수 없습니다' });
  });
  for (const [prefix, routes] of ROUTES) await app.register(async (scope) => routes(scope, ctx), { prefix });
  return app;
}

function handleError(err: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return reply.status(400).send({ error: '입력값이 올바르지 않습니다', details });
  }
  if (err instanceof AppError) return reply.status(err.status).send({ error: err.message, ...(err.details ? { details: err.details } : {}) });
  const status = err.statusCode ?? 500;
  if (status < 500) return reply.status(status).send({ error: clientMessage(status, err.code) });
  req.log.error({ err }, '처리되지 않은 오류');
  return reply.status(500).send({ error: '서버 오류가 발생했습니다', requestId: req.id });
}

// 프레임워크의 영어 메시지가 노출되지 않도록 상태·코드별 한국어 메시지로 바꾼다
function clientMessage(status: number, code: string | undefined): string {
  if (status === 429) return '요청이 너무 많습니다. 잠시 후 다시 시도하세요';
  if (status === 413) {
    if (code === 'FST_REQ_FILE_TOO_LARGE') return `파일이 너무 큽니다 (최대 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)`;
    if (code === 'FST_FILES_LIMIT') return `파일은 한 번에 최대 ${MAX_UPLOAD_FILES}개까지 올릴 수 있습니다`;
    return '요청 본문이 너무 큽니다';
  }
  if (status === 400) return '요청 형식이 올바르지 않습니다';
  if (status === 415) return '지원하지 않는 Content-Type입니다';
  return '요청을 처리할 수 없습니다';
}
