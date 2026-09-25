import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@pps/scoring': fileURLToPath(new URL('../../../packages/scoring/src/index.ts', import.meta.url)),
      '@pps/schema': fileURLToPath(new URL('../../../packages/schema/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'edge-score',
    include: ['*.test.ts'],
    environment: 'node',
  },
});
