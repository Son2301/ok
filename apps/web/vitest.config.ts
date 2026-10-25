import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
      // `server-only` throws outside the React server bundle; unit tests run in plain Node.
      'server-only': fileURLToPath(new URL('./lib/test/empty.ts', import.meta.url)),
    },
  },
  test: {
    include: ['lib/**/*.test.ts'],
    testTimeout: 30_000,
    env: { NODE_ENV: 'test' },
  },
});
