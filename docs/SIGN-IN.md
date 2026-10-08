# Sign in with Apple and Google

Which buttons appear where:

| Platform | Apple                              | Google                                   | Email |
| -------- | ---------------------------------- | ---------------------------------------- | ----- |
| iOS      | Yes (native button)                | Yes, when an iOS client ID is configured | Yes   |
| Android  | No                                 | Yes (Credential Manager)                 | Yes   |
| Web      | Yes (Sign in with Apple JS, popup) | Yes (Google's own button)                | Yes   |

App Review guideline 4.8 requires Sign in with Apple wherever an iOS app offers Google, so iOS shows Google only alongside Apple. Each button appears only once the server has the provider's configuration (`/v1/capabilities`).

## How it works

- The app asks the API for a single-use nonce (`POST /v1/auth/nonce`, valid 10 minutes), hands it to the provider, and sends the provider's ID token to `POST /v1/auth/oauth`.
- The API verifies the token's signature against the provider's published keys (go-oidc), its issuer, expiry and audience (the bundle ID or Services ID for Apple; the web client ID for Google on every platform), and consumes the nonce. People are identified by the provider's `sub`, never by email.
- A new person gets a kitchen with the provider's verified email and no password. They can set one later with "Forgot your password?".
- **No silent merging.** If the email already belongs to a kitchen, sign-in is refused with instructions: sign in with the password, then connect Apple or Google from My kitchen → Sign-in methods. Otherwise someone who registered your email first could share your account (a "pre-hijacking" attack). Connecting from a signed-in session links the identity to that kitchen.
- A password reset proves the email (`email_verified`) and signs out every session.
- Deleting a kitchen without a password asks for a fresh sign-in with one of its providers. Deletion cancels any subscription first and revokes Sign in with Apple through Apple's REST API.

## Configure

Server (`.env`):

```dotenv
GOOGLE_WEB_CLIENT_ID=123-abc.apps.googleusercontent.com   # the audience for every platform
GOOGLE_IOS_CLIENT_ID=123-ios.apps.googleusercontent.com   # shown to the iOS app
APPLE_BUNDLE_ID=app.savorly.mobile                        # native Apple tokens
APPLE_SERVICES_ID=app.savorly.web                         # web Apple tokens
APPLE_REDIRECT_URI=https://savorly.app/auth/apple         # must match the Services ID
APPLE_TEAM_ID=ABCDE12345                                  # for revocation on deletion
APPLE_KEY_ID=KEY1234567
APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

App build (EAS environment): `GOOGLE_IOS_URL_SCHEME=com.googleusercontent.apps.123-ios`, the reversed iOS client ID. Without it the build uses an inert placeholder and iOS hides Google.

1. **Google Cloud:** create OAuth clients for Web (add your web origins), iOS (bundle ID `app.savorly.mobile`), and Android (package `app.savorly.mobile` with the SHA-1 of both the upload key and Play's app-signing key). The Android client ID isn't referenced in code.
2. **Apple Developer:** enable Sign in with Apple on the App ID (EAS syncs the `usesAppleSignIn` capability). For the web, create a Services ID tied to the App ID with your domain and the HTTPS return URL (no localhost), and a Sign in with Apple key (.p8) for revocation.
3. Rebuild the native apps after changing plugins or the URL scheme (`eas build`); Expo Go doesn't include these modules.
4. Google Play needs a web page where people can request account deletion without the app; App Review needs in-app deletion, which My kitchen provides.

Libraries: `expo-apple-authentication` (iOS), `react-native-nitro-google-signin` (iOS/Android, passes the server's nonce through unchanged), Google Identity Services and Sign in with Apple JS on the web.
