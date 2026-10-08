// Google's iOS URL scheme is the reversed iOS OAuth client ID, which differs per
// deployment. The plugin must always run (it also adds the Podfile settings Google's iOS
// SDK needs), so an inert placeholder stands in until GOOGLE_IOS_URL_SCHEME is set; the
// app hides Google sign-in on iOS until the server reports an iOS client ID.
module.exports = ({ config }) => ({
  ...config,
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
