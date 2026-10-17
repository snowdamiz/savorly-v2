const fs = require('fs');
const path = require('path');

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
// Recipe and public cookbook links (https://<site>/recipes/<id>, /cookbooks/<id>) open the app:
// universal links on iOS and verified app links on Android, set up in app.json for
// savorly.cooking. Staging builds take them from the staging site, which serves association files
// for the staging app (infra/cloudflare/worker.ts).
const stagingHost = 'staging.savorly.cooking';
// Android push (FCM) needs Firebase's google-services.json, with an Android app for each package
// (docs/NOTIFICATIONS.md). Once the file is in this folder, builds use it; it holds only public
// identifiers, so it's committed. Until then builds have no Android push, which the app handles.
const googleServices = fs.existsSync(path.join(__dirname, 'google-services.json'))
  ? { googleServicesFile: './google-services.json' }
  : {};

module.exports = ({ config }) => ({
  ...config,
  android: { ...config.android, ...googleServices },
  ...(staging && {
    name: 'Savorly Staging',
    ios: {
      ...config.ios,
      bundleIdentifier: `${config.ios.bundleIdentifier}.staging`,
      associatedDomains: [`applinks:${stagingHost}`],
    },
    android: {
      ...config.android,
      ...googleServices,
      package: `${config.android.package}.staging`,
      intentFilters: config.android.intentFilters.map((filter) => ({
        ...filter,
        data: filter.data.map((data) => ({ ...data, host: stagingHost })),
      })),
    },
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
