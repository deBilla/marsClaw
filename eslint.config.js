// Flat ESLint config. Type-aware rules are off (too slow for a personal-scale
// repo); the lint pass focuses on catching silent-error patterns that hide
// bugs in an agent codebase.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import noCatchAll from 'eslint-plugin-no-catch-all';

export default [
  {
    ignores: ['node_modules/**', 'data/**', 'logs/**', 'dist/**', 'build/**', 'tools/voice-env/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: {
      'no-catch-all': noCatchAll,
    },
    rules: {
      // Flag every catch that doesn't rethrow. Kept at `warn` (not `error`)
      // because many catches in this codebase are intentional fallback
      // patterns — MCP tool wrappers returning `{ isError: true }`, sidecar
      // health checks falling back to "down", JSON.parse returning null, etc.
      // The warning serves as a review hint: when adding a new catch, decide
      // explicitly whether to rethrow or silence.
      'no-catch-all/no-catch-all': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-console': 'off',
    },
  },
];
