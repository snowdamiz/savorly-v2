const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
module.exports = defineConfig([
  expoConfig,
  // Existing screens predate React Compiler diagnostics. Keep these visible as
  // warnings while enforcing the full rules for the new studio and transports.
  {
    files: [
      'src/components/{SousChef,ui}.tsx',
      'src/lib/{store.tsx,useRecipeSearch.ts}',
      'src/screens/{Editor,Kitchen,Profile}.tsx',
    ],
    rules: {
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
    },
  },
  { ignores: ['dist/**', 'test-results/**', 'playwright-report/**', '.expo/**'] },
]);
