import js from '@eslint/js';
import globals from 'globals';

// Flat config. Intentionally lenient for now: real correctness problems
// (no-undef, unreachable code) are errors; style/hygiene (unused vars, empty
// blocks) are warnings so CI can run lint non-blocking until the P22 cleanup
// lands. Tighten to blocking once the dead-code sweep is done.
export default [
  { ignores: ['dist/**', 'dist-lab/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        Phaser: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['warn', { checkLoops: false }],
    },
  },
];
