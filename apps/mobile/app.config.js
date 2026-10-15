// Staging builds (APP_VARIANT=staging, see eas.json) install beside the production app under
// their own name and identifiers, and must point at a real staging API.
const staging = process.env.APP_VARIANT === 'staging';
if (staging && !/^https:\/\/(?!.*YOUR_)/.test(process.env.EXPO_PUBLIC_API_URL || '')) {
  throw new Error(
    'Staging builds need EXPO_PUBLIC_API_URL set to the staging HTTPS API (eas.json).',
  );
}

// Google's iOS URL scheme is the reversed iOS OAuth client ID, which differs per
// deployment. The plugin must always run (it also adds the Podfile settings Google's iOS
// SDK needs), so an inert placeholder stands in until GOOGLE_IOS_URL_SCHEME is set; the
// app hides Google sign-in on iOS until the server reports an iOS client ID.
module.exports = ({ config }) => ({
  ...config,
  ...(staging && {
    name: 'Savorly Staging',
    ios: { ...config.ios, bundleIdentifier: `${config.ios.bundleIdentifier}.staging` },
    android: { ...config.android, package: `${config.android.package}.staging` },
  }),
  plugins: [
    ...config.plugins,
    [
      'react-native-nitro-google-signin',
      {
        iosUrlScheme:
          process.env.GOOGLE_IOS_URL_SCHEME || 'com.googleusercontent.apps.savorly-unconfigured',
      },
    ],
  ],
});
