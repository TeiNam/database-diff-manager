import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

// 개발 서버는 /api 를 로컬 API 서버(@tdm/server)로 프록시한다
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./test/setup.ts'], css: { modules: { classNameStrategy: 'non-scoped' } } },
});
