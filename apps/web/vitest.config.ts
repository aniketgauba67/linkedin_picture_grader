import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // tsconfig sets jsx:"preserve" because Next compiles the app; vitest
  // transforms test files itself and needs a runtime named here.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@pps/scoring': fileURLToPath(new URL('../../packages/scoring/src/index.ts', import.meta.url)),
      '@pps/schema': fileURLToPath(new URL('../../packages/schema/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'web',
    // .tsx too, so the one component test that needs a DOM is collected.
    // It selects jsdom with a per-file @vitest-environment docblock so
    // every other test here keeps running in plain node.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
  },
});
