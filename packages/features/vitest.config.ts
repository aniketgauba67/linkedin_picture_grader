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
    name: 'features',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // sharp decodes real pixels; give it more room than the default.
    testTimeout: 20_000,
  },
});
