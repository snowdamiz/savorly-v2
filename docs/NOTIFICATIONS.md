# Push notifications

The API sends push notifications through [Expo's push service](https://docs.expo.dev/push-notifications/sending-notifications/), which hands them to Apple (APNs) and Google (FCM). The routes are in the [API conventions](API.md#push-notifications); the sender is `services/api/internal/app/notifications_outbox.go`, started by `cmd/server/main.go` next to the janitor.

## What sends what

| Notification | When | To | Switch (`preferences.notifications`) | `data` |
| --- | --- | --- | --- | --- |
| New recipe | A recipe is published for the first time (created published, or a draft published later). Unpublishing and publishing again, or an admin's restore, sends nothing. | The author's followers | `follows` | `{ "type": "recipe", "recipeId" }` |
| Review | A review is written. Editing one sends nothing; at most one per reviewer and recipe a day, even if a review is deleted and written again. | The recipe's author | `reviews` | `{ "type": "recipe", "recipeId" }` |
| Comment | A comment or reply is written; at most one per commenter and recipe an hour. | The recipe's author | `comments` | `{ "type": "recipe", "recipeId" }` |
| Pantry | Once a day, from 12:00 UTC: pantry items that expire today or in the next two days. Each item is mentioned once per expiry date; one notification lists a member's items. | The pantry's owner, or every member of a household's pantry | `pantry` | `{ "type": "pantry" }` |
| Renewal | A week before a yearly plan renews: the plan, the day and what Stripe will charge, and how to cancel in two taps. Once per renewal; plans set to end, monthly and complimentary plans, and suspended members get none. An email says the same whatever the switch. | The member who pays for the plan | `renewals` | `{ "type": "plan" }` (opens My kitchen) |
| Cook-along | Once a week: the week's [cook-along](CREATOR-FUND.md#the-weekly-cook-along), from 12:00 UTC on its Monday, or as soon as the week has a public recipe after that. Changing the week's recipe later sends nothing. | Every member but the recipe's author | `cookAlong` | `{ "type": "recipe", "recipeId" }` |

Nobody is told about their own action, and suspended members neither send nor receive notifications. A review or comment deleted before it goes out, a recipe unpublished, or a member suspended meanwhile sends nothing. Every switch is on until the member turns it off with `PATCH /me/preferences`.

Text is in the recipient's `preferences.language` (the app's nine languages); a member without one gets English. The titles and bodies are in `noticeLanguages` in `notifications_outbox.go`, and the renewal's in `renewalTexts` in `renewal_reminders.go`; they quote the cook's name, the recipe's title and the start of the review or comment, never translated. The cook-along's names the recipe and its author. The renewal names the app's own buttons (Cancel plan, under Your plan in My kitchen), so a change to those labels in the catalogs belongs there too.

## How it works

1. Database triggers (`021_engagement.sql`) write each event to `notification_outbox`, whichever code path made the change: the app, the sous-chef or an admin. The pantry and cook-along passes write theirs from the sender, every 10 minutes, each claiming its day or week in `notification_runs` so it runs once across replicas (`cook_along.go`). The comment trigger attaches only where the `comments` table (`018_social.sql`) exists; after creating that table later, run `SELECT attach_social_triggers()`. Renewals come from `renewal_reminders.go` instead ([pricing](PRICING.md#cancelling-renewals-and-refunds)), which claims a `renewal_reminders` row and writes the outbox row in one transaction, then sends the email.
2. The sender polls every 2 seconds while there is work, backing off to 30 seconds when idle. It claims outbox rows (`FOR UPDATE SKIP LOCKED`) and writes one `push_messages` row per recipient device.
3. It claims up to 100 due messages (Expo's limit per request) and sends them, up to five requests a turn. A message whose device has since signed out, or moved to another account, isn't sent.
4. Expo answers with a ticket per message. `DeviceNotRegistered` deletes the device's token; `MessageRateExceeded`, network errors, 429 and 5xx are retried after 30 seconds, 2, 8 and 32 minutes, and then given up; anything else fails the message. Fifteen minutes after sending, the sender reads Expo's receipts and deletes the tokens Apple or Google no longer deliver to.
5. A message is claimed before it is sent, so no two replicas send it. One left claimed by a server that stopped mid-request is marked failed after ten minutes rather than sent again, because Expo may already have it.

The API container sleeps after 30 idle minutes ([deployment](DEPLOYMENT.md)), and the sender sleeps with it: notifications wait for the next request to wake it, and the pantry and cook-along passes run the first time the API is awake after 12:00 UTC. The renewal pass runs three minutes after the API starts and then hourly, so a renewal is reminded within an hour of entering its last week, or the first time the API is awake after that. With no registered devices, nothing is sent.

Devices: `PUT /me/push-token` registers the device's Expo push token with the session that sent it. Signing out, revoking the session from another device, a password change that signs other devices out, or the session expiring removes the token. A token registered by another account moves to it, and each member keeps their ten most recently registered devices.

Retention: messages, which carry names and the start of reviews and comments, are deleted after 7 days, and so are outbox rows, which keep no text once handled (`janitor.go`). A member's devices, messages and pending notices go with their account.

## Setting it up

1. **The app** asks for permission and calls `Notifications.getExpoPushTokenAsync({ projectId })` with the EAS project ID in `app.json` (`extra.eas.projectId`, `c0e4c4a0-bfbf-4b82-9701-0e46c9463c6c`), then sends the token with `PUT /me/push-token` (and `DELETE /me/push-token` before signing out). Push tokens need a development or store build, not Expo Go, and a physical device or an emulator with Google Play services. `data.type` and `data.recipeId` say where a tapped notification opens.
2. **iOS credentials**: an Apple Push Notifications key in EAS (`eas credentials` → iOS → the build profile → Push Notifications → set up a new push key, or answer yes when `eas build` offers it). One key serves both bundle IDs, `app.savorly.mobile` and the staging app's `app.savorly.mobile.staging`.
3. **Android credentials**: a Firebase project with an Android app for each package (`app.savorly.mobile`, `app.savorly.mobile.staging`). Put its `google-services.json` in `apps/mobile` and commit it; `app.config.js` uses it whenever it's there (a native change, so a new build). Then upload the Firebase service account key to EAS (`eas credentials` → Android → the build profile → Google Service Account → Manage your Google Service Account Key for Push Notifications (FCM V1) → upload, or expo.dev → Project settings → Credentials). See [Expo's FCM guide](https://docs.expo.dev/push-notifications/fcm-credentials/).
4. **The server** needs nothing more, unless the project turns on Expo's enhanced push security ([expo.dev → access tokens](https://expo.dev/settings/access-tokens)). Then create an access token (a robot user's is best) and set it as `EXPO_ACCESS_TOKEN` in `.env` locally, or as a Worker secret in `.env.staging` and `.env.production`; requests without it fail with `UNAUTHORIZED`.

## Checking on it

```sql
-- Messages from the last day, by outcome.
SELECT status, error, count(*) FROM push_messages WHERE created_at > now() - interval '1 day' GROUP BY 1, 2 ORDER BY 3 DESC;
-- Events waiting for the sender (should be empty within a minute while the API is awake).
SELECT kind, count(*) FROM notification_outbox WHERE processed_at IS NULL GROUP BY 1;
-- Renewal reminders of the last month whose email didn't go, and why.
SELECT user_id, renews_at, email_error FROM renewal_reminders WHERE emailed_at IS NULL AND created_at > now() - interval '30 days';
```

`failed` with `DeviceNotRegistered` is normal (an uninstalled app). `InvalidCredentials` or `MismatchSenderId` (from tickets or, as `receipt: …`, from receipts) points at a platform's credentials in EAS; `401` with `UNAUTHORIZED` on every message at `EXPO_ACCESS_TOKEN` after turning on enhanced push security.
