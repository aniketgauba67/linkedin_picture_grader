import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Test against workspace source so `pnpm test` does not depend on a
      // prior `pnpm build`.
      '@pps/scoring': fileURLToPath(new URL('../scoring/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'schema',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
