import globals from 'globals';
import tseslint from 'typescript-eslint';
import base from '../eslint-base.config.js';

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      'playwright-report/',
      'test-results/',
      'coverage/',
      '.coverage/',
      '.auth/',
      'ux-audit/shots/',
    ],
  },
  ...base,
  {
    languageOptions: {
      globals: {
        ...globals.es2022,
        ...globals.node,
        // page.evaluate callbacks execute in the browser; specs reference
        // window/document/localStorage directly inside those callbacks.
        ...globals.browser,
      },
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Catch fire-and-forget promises — in Playwright specs an un-awaited
      // action/assertion silently passes before the page has acted.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    // The whole workspace is test code: specs, fixtures, and helpers may use
    // `any` at the page.evaluate / JSON.parse boundaries the same way
    // server/client tests use it for mocks. `no-floating-promises` stays on.
    files: ['**/*.spec.ts', '**/*.test.ts', 'helpers/**/*.ts', 'fixtures/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      // Server-test message literals are deliberately cast `as ClientMessage`
      // (the WS boundary accepts the raw JSON shape) — same override as
      // server/eslint.config.js's test block.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
  {
    // Plain-JS scripts are not in tsconfig.json (`include` covers only
    // **/*.ts), so type-checked rules cannot run on them.
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
);
