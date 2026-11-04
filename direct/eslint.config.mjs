export default [{ignores: ['dist/**', 'node_modules/**']}, {
  files: ['**/*.mjs'], languageOptions: {ecmaVersion: 'latest', sourceType: 'module'},
  rules: {'no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}], 'no-undef': 'off'}
}];
