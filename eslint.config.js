// eslint.config.js — flat config (ESLint 9+), trimmed from the Universe baseline.
import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default [
  {
    ignores: [
      'node_modules/**', '**/node_modules/**', 'client/dist/**', '**/*.min.js',
      // Reference copies + the exported design system are documentation, not code.
      'docs/**',
      'playwright-report/**', 'test-results/**',
      // TypeScript files are checked by tsc (npm run typecheck), not ESLint.
      '**/*.ts', '**/*.tsx',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node, ...globals.es2024 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-duplicate-imports': 'error',
      'no-var': 'error',
      'prefer-const': ['warn', { destructuring: 'all' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-prototype-builtins': 'off',
      'no-useless-escape': 'warn',
      'no-control-regex': 'off',
    },
  },
  {
    files: ['client/src/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser }, parserOptions: { ecmaFeatures: { jsx: true } } },
    settings: { react: { version: '19.0' } },
    rules: {
      'react/jsx-uses-react': 'off',
      'react/react-in-jsx-scope': 'off',
      'react/jsx-uses-vars': 'error',
      'react/jsx-no-undef': 'error',
      'react/no-unknown-property': 'warn',
      'react/jsx-key': 'warn',
      'react/no-direct-mutation-state': 'error',
      'react/jsx-no-duplicate-props': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['client/src/broking/**/*.{js,jsx}', 'client/src/components/**/*.{js,jsx}'],
    ignores: ['**/*.test.{js,jsx}'],
    plugins: { 'jsx-a11y': jsxA11y },
    rules: { ...jsxA11y.configs.recommended.rules },
  },
  {
    files: ['server/src/lib/logger.js', 'server/src/db/seeds/**', 'scripts/**', 'e2e/**'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.test.{js,jsx}', 'client/src/test/**', 'e2e/**'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['server/src/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-restricted-globals': ['warn', 'window', 'document', 'localStorage'] },
  },
];
