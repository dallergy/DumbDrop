const js = require('@eslint/js');
const prettierConfig = require('eslint-config-prettier');
const nodePlugin = require('eslint-plugin-n');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'uploads/**',
      'local_uploads/**',
      'dist/**',
      'build/**',
      '.metadata/**',
      'test/**',
    ],
  },
  js.configs.recommended,
  prettierConfig,
  {
    files: ['**/*.js'],
    ignores: ['public/service-worker.js', 'public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
      },
    },
    plugins: {
      n: nodePlugin,
    },
    rules: {
      ...nodePlugin.configs.recommended.rules,
      'n/exports-style': ['error', 'module.exports'],
      'n/file-extension-in-import': ['error', 'always'],
      'n/prefer-global/buffer': ['error', 'always'],
      'n/prefer-global/console': ['error', 'always'],
      'n/prefer-global/process': ['error', 'always'],
      'n/prefer-global/url-search-params': ['error', 'always'],
      'n/prefer-global/url': ['error', 'always'],
      'n/prefer-promises/dns': 'error',
      'n/prefer-promises/fs': 'error',
      'n/no-extraneous-require': 'off',
      'n/no-unpublished-require': 'off',
    },
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
        File: 'readonly',
        Blob: 'readonly',
        AbortController: 'readonly',
        CustomEvent: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        Toastify: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
      },
    },
    rules: {
      'n/no-unsupported-features/node-builtins': 'off',
      'n/no-unsupported-features/es-syntax': 'off',
      'n/no-missing-import': 'off',
      'n/file-extension-in-import': 'off',
    },
  },
  {
    files: ['public/service-worker.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        self: 'readonly',
        caches: 'readonly',
        clients: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
    },
  },
];
