import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * ESLint 9 flat config.
 *
 * With TypeScript removed, ESLint is the only tool that parses every source file,
 * so it is now the syntax gate that `tsc --noEmit` used to provide in CI. Rules
 * that duplicated type checking are gone; rules that catch real runtime mistakes
 * in plain JavaScript are turned up.
 */
export default [
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      'backend/prisma/migrations/**',
    ],
  },

  js.configs.recommended,

  // ── Language defaults: modern ESM everywhere ─────────────────────────────────
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },

  // ── Backend + shared: Node environment ──────────────────────────────────────
  {
    files: ['backend/**/*.js', 'shared/**/*.js', '*.config.js', 'eslint.config.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // ── Frontend: browser environment + React rules ─────────────────────────────
  {
    files: ['frontend/**/*.{js,jsx}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // Without this, `no-unused-vars` cannot see that `<Link />` uses the `Link`
      // import and flags every component import in the project as unused. The
      // TypeScript parser used to supply this knowledge.
      'react/jsx-uses-vars': 'error',
      // React 19's automatic JSX runtime means `React` itself is never referenced,
      // so only the identifiers inside JSX need tracking.

      // Listed explicitly rather than spreading the plugin's preset, so the
      // config keeps working if the plugin changes its exported config shape.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // Vite's own config runs in Node, not the browser.
  {
    files: ['frontend/vite.config.js'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // ── Project-wide rules ──────────────────────────────────────────────────────
  {
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'smart'],
      'no-console': ['error', { allow: ['warn', 'error'] }],

      // These four replace guarantees the type checker used to give for free.
      // `undefined` slipping through a lookup or a shadowed binding is exactly the
      // class of bug that no longer fails a build.
      'no-shadow': 'error',
      'no-param-reassign': 'error',
      'no-implicit-coercion': 'error',
      'consistent-return': 'error',
    },
  },

  prettier,
];
