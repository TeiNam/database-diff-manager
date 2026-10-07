import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

// 빌드된 SPA를 서빙한다. index.html 이 없으면 아무것도 등록하지 않는다 (API 전용 실행)
export async function registerWeb(app: FastifyInstance, webDist: string | undefined): Promise<boolean> {
  if (!webDist || !existsSync(join(webDist, 'index.html'))) return false;
  await app.register(fastifyStatic, { root: webDist, wildcard: false, index: ['index.html'] });
  return true;
}
