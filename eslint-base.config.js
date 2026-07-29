/**
 * Shared ESLint flat-config baseline for all @tamari/* workspaces.
 *
 * Each workspace's eslint.config.js spreads this and adds only what's specific
 * to it: parserOptions.{project,tsconfigRootDir,ecmaFeatures}, globals
 * (node/browser), a handful of workspace-specific rules, and its
 * test/import-legacy overrides.
 *
 * Keeping the rule baseline here is what prevents the three configs from
 * drifting apart — e.g. the client lagging the server on a new rule.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'prefer-const': 'error',
      'no-extra-boolean-cast': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],

      // Cheap, high-value type-checked rules (cherry-picked from
      // recommended-type-checked rather than taking the whole preset, which
      // surfaces ~1.2k errors driven by `any` propagation).
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/restrict-plus-operands': 'error',
      '@typescript-eslint/restrict-template-expressions': 'error',
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',

      // Block `any` propagation through the type graph. The `any` sources are few
      // (JSON.parse, res.json(), wasmoon Lua returns, raw DB rows, settings blobs)
      // but each blows up downstream.
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',

      // Reject implicit stringification of values that would render as
      // `[object Object]` (libsql Value includes Uint8Array; tool-call /
      // message-extra objects; settings blobs). Call sites use `str()` from
      // lib/coerce to narrow instead.
      '@typescript-eslint/no-base-to-string': 'error',

      'no-console': 'off',
    },
  },
);
