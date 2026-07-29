import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', '../e2e/tests/server/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/testing/**', '../e2e/tests/server/**/*.test.ts'],
      reporter: ['text', 'json', 'html'],
    },
  },
});
