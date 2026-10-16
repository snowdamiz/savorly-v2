# Sign in with Apple and Google

Which buttons appear where:

| Platform | Apple                              | Google                                   | Email |
| -------- | ---------------------------------- | ---------------------------------------- | ----- |
| iOS      | Yes                                | Yes, when an iOS client ID is configured | Yes   |
| Android  | No                                 | Yes (Credential Manager)                 | Yes   |
| Web      | Yes (Sign in with Apple JS, popup) | Yes (Google's sign-in page and back)     | Yes   |

App Review guideline 4.8 requires Sign in with Apple wherever an iOS app offers Google, so iOS shows Google only alongside Apple. Each button appears only once the server has the provider's configuration (`/v1/capabilities`).

Both buttons are drawn by the app (`ProviderFace.tsx`) as full-width pills that keep each provider's branding: Apple's black button with the Apple logo, Google's white one with the four-color mark, each titled "Continue with …".

On the web, Google's button takes the browser to Google's own sign-in page, which sends it back to the site with the ID token in the URL fragment ([googleRedirect.ts](../apps/mobile/src/lib/auth/googleRedirect.ts)). The app checks the returned `state` against the one this tab sent, so a link can't sign someone in to another person's kitchen, removes the token from the address bar and history, returns to the page the button was on, and then signs in, connects Google, or confirms a deletion. Google's embedded button and popup are not used: privacy browsers such as Brave block that frame or the popup's handoff, which left a button that did nothing. Apple still uses its popup.

## How it works

- The app asks the API for a single-use nonce (`POST /v1/auth/nonce`, valid 10 minutes), hands it to the provider, and sends the provider's ID token to `POST /v1/auth/oauth`.
- The API verifies the token's signature against the provider's published keys (go-oidc), its issuer, expiry and audience (the bundle ID or Services ID for Apple; the web client ID for Google on every platform), and consumes the nonce. People are identified by the provider's `sub`, never by email.
- A new person gets a kitchen with the provider's verified email and no password. They can set one later with "Forgot your password?". The app then walks them through a short kitchen setup: their photo (Google's picture to start with, if they signed in with Google), name and username (suggested from their name), food preferences, and a few cooks to follow. Every step can be skipped and changed later in My kitchen.
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
APPLE_REDIRECT_URI=https://savorly.cooking/auth/apple         # must match the Services ID
APPLE_TEAM_ID=ABCDE12345                                  # for revocation on deletion
APPLE_KEY_ID=KEY1234567
APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

App build (EAS environment): `GOOGLE_IOS_URL_SCHEME=com.googleusercontent.apps.123-ios`, the reversed iOS client ID. Without it the build uses an inert placeholder and iOS hides Google.

1. **Google Cloud:** create OAuth clients for Web (add each site's origin as an Authorized JavaScript origin and the origin plus a trailing slash, such as `https://savorly.cooking/`, as an Authorized redirect URI; without it Google answers `redirect_uri_mismatch`), iOS (bundle ID `app.savorly.mobile`), and Android (package `app.savorly.mobile` with the SHA-1 of both the upload key and Play's app-signing key). The Android client ID isn't referenced in code.
2. **Apple Developer:** enable Sign in with Apple on the App ID (EAS syncs the `usesAppleSignIn` capability). For the web, create a Services ID tied to the App ID with your domain and the HTTPS return URL (no localhost), and a Sign in with Apple key (.p8) for revocation.
3. Rebuild the native apps after changing plugins or the URL scheme (`eas build`); Expo Go doesn't include these modules.
4. Google Play needs a web page where people can request account deletion without the app; App Review needs in-app deletion, which My kitchen provides.

Libraries: `expo-apple-authentication` (iOS), `react-native-nitro-google-signin` (iOS/Android, passes the server's nonce through unchanged), Google's OpenID Connect sign-in page and Sign in with Apple JS on the web.
