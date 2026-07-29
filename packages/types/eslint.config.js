import globals from 'globals';
import tseslint from 'typescript-eslint';
import base from '../../eslint-base.config.js';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  ...base,
  {
    languageOptions: {
      globals: {
        ...globals.es2022,
      },
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
