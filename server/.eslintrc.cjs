module.exports = {
  root: true,
  extends: ['../eslint-base.cjs'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  env: {
    node: true,
  },
  rules: {
    '@typescript-eslint/no-unnecessary-condition': ['error', { allowConstantLoopConditions: true }],
    // Catch fire-and-forget promises (e.g. an un-awaited async dispatch) whose
    // rejection would otherwise vanish as a silent unhandled rejection.
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
  },
  overrides: [
    {
      // Tests may use `any` for mocks/stubs; production code may not.
      files: ['**/*.test.ts', 'src/testing/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unsafe-argument': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
        '@typescript-eslint/no-base-to-string': 'off',
      },
    },
    {
      // One-shot v1→v2 importer: ingests arbitrary legacy flat-file JSON of
      // unknown shape and maps it. `any` is appropriate here — the input is
      // genuinely untyped and validated only by the destination schemas.
      files: ['src/db/import-legacy.ts'],
      rules: {
        '@typescript-eslint/no-unsafe-argument': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
      },
    },
  ],
  ignorePatterns: ['dist/', 'node_modules/'],
};
