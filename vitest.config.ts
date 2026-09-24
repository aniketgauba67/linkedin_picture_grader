import { defineConfig } from 'vitest/config';

// Root vitest entrypoint. `pnpm test` from the repo root runs every
// workspace project in one process; each package also has its own
// vitest.config.ts so it can be run in isolation.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
  },
});
