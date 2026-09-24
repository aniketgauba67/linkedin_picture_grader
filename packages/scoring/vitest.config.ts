import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'scoring',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
