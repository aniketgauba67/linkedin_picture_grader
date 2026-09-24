import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@pps/scoring': fileURLToPath(new URL('../scoring/src/index.ts', import.meta.url)),
      '@pps/schema': fileURLToPath(new URL('../schema/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'db',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // The integration suites rebuild the schema from the migrations and
    // open a dozen real connections.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Each integration file resets the schema, so they must not overlap.
    fileParallelism: false,
  },
});
