import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };
import { localVersion } from '../../scripts/local-version.mjs';

// 개발 서버는 /api 를 로컬 API 서버(@tdm/server)로 프록시한다
export default defineConfig({
  plugins: [react()],
  // CI 는 태그로 계산한 버전을 APP_VERSION 으로 넘긴다. 로컬 빌드는 git 태그 기준(scripts/local-version.mjs)
  define: { __APP_VERSION__: JSON.stringify(process.env.APP_VERSION || localVersion(pkg.version, import.meta.dirname)) },
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./test/setup.ts'], css: { modules: { classNameStrategy: 'non-scoped' } } },
});
