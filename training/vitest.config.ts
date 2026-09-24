import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'training',
    include: ['*.test.ts'],
  },
});
