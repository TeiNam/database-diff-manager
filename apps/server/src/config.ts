import { join, resolve } from 'node:path';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  cookieSecure: boolean;
  sessionTtlMs: number;
  // 리버스 프록시 뒤에서 X-Forwarded-For를 신뢰할 범위 (기본: 신뢰하지 않음)
  trustProxy?: boolean | number | string;
  // 빌드된 웹(apps/web/dist). index.html 이 있으면 서버가 함께 서빙한다
  webDist?: string;
}

const HOUR_MS = 60 * 60 * 1000;
const SESSION_TTL_HOURS = 12;

// 'true'/'false', 정수(홉 수), 쉼표로 구분한 IP/CIDR 목록을 Fastify trustProxy 값으로 바꾼다
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const value = raw?.trim();
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value.split(',').map((v) => v.trim()).filter(Boolean).join(',');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`PORT 값이 올바르지 않습니다: ${env.PORT}`);
  return {
    host: env.HOST ?? '127.0.0.1',
    port,
    dataDir: env.DATA_DIR ?? join(process.cwd(), 'data'),
    cookieSecure: env.COOKIE_SECURE !== 'false',
    sessionTtlMs: SESSION_TTL_HOURS * HOUR_MS,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    webDist: resolve(process.cwd(), env.WEB_DIST ?? '../web/dist'),
  };
}

export const dbPath = (config: Config): string => join(config.dataDir, 'tdm.db');
