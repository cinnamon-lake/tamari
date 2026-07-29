import globals from 'globals';
import tseslint from 'typescript-eslint';
import base from '../eslint-base.config.js';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  ...base,
  {
    languageOptions: {
      globals: {
        ...globals.es2022,
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      // Solid.js ref pattern `let x; <el ref={x}>` assigns the variable through
      // the ref prop at runtime, which this new eslint 10 rule cannot see.
      'no-unassigned-vars': 'off',
      // Defensive `??` defaults on character/persona fields are load-bearing on the
      // client: the domain types (db.ts) declare these non-nullable, but the data
      // arrives from imported v2/v3 cards where the same fields are `.optional()`.
      // Warn so the type-vs-reality gaps stay visible without forcing a risky
      // mass-removal of render-time guards.
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      // Catch fire-and-forget promises (e.g. a missed `await` in an event handler)
      // whose rejection would otherwise vanish as a silent unhandled rejection.
      '@typescript-eslint/no-floating-promises': 'error',
      // NOTE: `@typescript-eslint/no-misused-promises` is intentionally NOT enabled
      // here (unlike the server). Solid event handlers are commonly async
      // (`onClick={async () => …}`) and every such handler in this codebase is
      // already rejection-safe — they either wrap their body in try/catch or only
      // `await` popup promises that never reject. Enabling the rule would force
      // ~30 cosmetic `void` wrappers that add no safety, just churn.
    },
  },
  {
    // Tests may use `any` for mocks/stubs and legitimately fire-and-forget
    // promises to assert side effects; production code may not.
    files: ['**/*.test.ts', '**/*.test.tsx', 'src/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
    },
  },
);
