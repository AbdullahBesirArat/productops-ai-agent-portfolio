import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.npm-cache/**', 'coverage/**', 'test-results/**'] },
  ...tseslint.configs.recommended,
  { rules: { 'no-control-regex': 'off' } },
);
