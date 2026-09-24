import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@pps/scoring': fileURLToPath(new URL('../../packages/scoring/src/index.ts', import.meta.url)),
      '@pps/schema': fileURLToPath(new URL('../../packages/schema/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'web',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
