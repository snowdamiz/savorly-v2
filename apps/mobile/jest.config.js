// Unit tests for code the browser suite (Playwright, web only) can't reach: native-only modules and
// platform twins. Each project resolves files the way Metro does for its platform and inlines
// Platform.OS, so `x.test.native.ts` runs on iOS and Android against `x.ts`, `x.test.web.ts` runs
// against `x.web.ts`, and a plain `x.test.ts` runs everywhere. Playwright owns `tests/`.
module.exports = {
  projects: ['ios', 'android', 'web'].map((platform) => ({
    preset: `jest-expo/${platform}`,
    roots: ['<rootDir>/src', '<rootDir>/modules'],
    setupFiles: ['<rootDir>/jest/setup.js'],
    clearMocks: true,
    // The platform presets pass Babel only the platform caller and expect a babel.config.js; the
    // app has none (Metro uses Expo's default preset), so name the same preset here.
    transform: {
      '\\.[jt]sx?$': [
        'babel-jest',
        {
          presets: [require.resolve('expo/internal/babel-preset')],
          plugins: [require.resolve('./jest/dynamic-import')],
          caller: { name: 'metro', bundler: 'jest', platform },
        },
      ],
    },
  })),
};
