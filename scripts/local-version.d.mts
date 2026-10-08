// scripts/local-version.mjs 의 타입 (apps/web/vite.config.ts 에서 사용)
export function describeToVersion(describe: string | undefined, fallback: string): string;
export function localVersion(fallback: string, cwd?: string): string;
