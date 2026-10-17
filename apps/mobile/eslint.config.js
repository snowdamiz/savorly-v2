const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
module.exports = defineConfig([
  expoConfig,
  { ignores: ['dist/**', 'test-results/**', 'playwright-report/**', '.expo/**'] },
  // Icons come one module each through src/components/icons.ts: the barrel puts every lucide
  // icon in the web bundle.
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['src/components/icons.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'lucide-react-native',
              message: 'Import icons from src/components/icons.ts, which loads each on its own.',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  // Unit tests load modules inside isolated Jest registries, which needs require().
  {
    files: ['**/__tests__/**', 'jest/**'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
]);
