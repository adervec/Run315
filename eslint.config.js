// Lint: the recommended rules plus the ones that catch what crashes a browser app at runtime
// (undefined names, shadowed imports, unreachable code, await in a loop that was meant to be
// parallel is fine here -- streams are read one at a time on purpose).
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'docs/**', '.venv/**', 'static/vendor/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, google: 'readonly', L: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-use-before-define': ['error', { functions: false, classes: true, variables: false }],
      'no-unreachable-loop': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'warn',
      'eqeqeq': ['warn', 'smart'],
    },
  },
  { files: ['test/**', 'tools/**', 'eslint.config.js'], languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-use-before-define': 'off', 'no-control-regex': 'off', 'no-unused-vars': 'off', 'no-shadow': 'off' } },
  { files: ['sw.js'], languageOptions: { sourceType: 'script', globals: { ...globals.serviceworker } } },
];
