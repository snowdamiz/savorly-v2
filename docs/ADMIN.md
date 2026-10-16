# Admin console

Savorly has a built-in admin console for running the community: the moderation queue, members, recipes, reviews, AI spend and jobs, operator settings, and an audit log of every change made there. It opens from **Admin console** in the desktop sidebar or **My kitchen** on phones (`/?page=admin` on the web), and only for admins. The console is an operator tool, so it is in English; dates and numbers follow the app's language.

## Who is an admin

- **Owners** are the addresses in `ADMIN_EMAILS` (comma separated). Without it, the owner is `yurlovandrew@gmail.com` (`services/api/internal/app/operator.go`). Owners can do everything, including appointing other admins.
- **Admins** are members an owner appoints from a member's record (**Make admin**). They can do everything except appoint or remove admins, and they can't act on owners or on each other.

An owner's address only counts once it is **verified**. Registering with an email proves nothing, so otherwise anyone could register an owner's address before its owner and take over the console. An account's email is verified by a password reset code, or by signing in or connecting Google or Apple with the same verified address. Until then, the owner's My kitchen explains what to do. Local development (`APP_ENV` other than `production`) skips this check because it has no email; staging runs in production mode and needs it.

To verify an owner on a server without password-reset email or Google sign-in, set it in the database:

```sql
UPDATE users SET email_verified = true WHERE email = 'yurlovandrew@gmail.com';
```

No one can mark an address in `ADMIN_EMAILS` as verified from the console, or appoint it as an admin, so a squatted owner address can't be promoted. It can still be suspended or deleted.

## What's in it

| Section | What you can do |
| --- | --- |
| Overview | Members, sign-ins, recipes, open reports, AI spend against today's budgets, the AI queue, 30-day sign-ups/recipes/spend/jobs, plan and sign-in mix, community activity, and which integrations are configured (never their secrets). Alerts point at anything needing attention. |
| Reports | The moderation queue, grouped by recipe and most-reported first. Dismiss, unpublish (which resolves the reports), delete the recipe, or open the author. Resolved and dismissed reports stay browsable with who closed them and their note. A new report on a closed recipe reopens it. |
| Members | Search and filter (admins, suspended, unverified, paid, reported, sample cooks); sort by newest, last sign-in, AI spend or recipes. A member's record shows their account, sign-in methods, plan and Stripe IDs, 30-day AI use against their plan, activity counts, recipes, reviews, AI jobs, reports they filed, and admin history. |
| Recipes | Every recipe including drafts, filtered by published, drafts, reported, AI-generated or suspended author, and sorted by newest, recently edited, most reported, most saved or top rated. A recipe's record shows its full content, reports and admin history. |
| Reviews | Search and filter by rating; delete reviews (the audit log keeps the text). |
| AI & jobs | Live voice sessions (end one), top spenders, use and failures per tool, and every AI job with its prompt, result and error. Cancel queued or processing jobs. |
| Settings | Pause all AI, override the daily AI budgets, pause sign-ups, and publish a site-wide announcement. |
| Audit log | Every console action, newest first, searchable. Entries can't be edited and survive deletion of the admin, member or recipe. |

### Member actions

- **Suspend** (with a reason only admins see): signs them out everywhere, ends live voice, cancels AI work that hasn't reached a provider (releasing its reservation), and blocks sign-in with a "contact support" message. Their recipes, reviews, profile, and the sous-chef's search results stop showing them. Nothing is deleted; **Lift suspension** restores everything.
- **Sign out everywhere**, **Mark email as verified**, **Edit profile** (for clearing offensive names, handles, bios or photos).
- **Restart kitchen setup**: the new-kitchen setup (photo, name and username, food preferences, cooks to follow, meeting the sous-chef) opens for them the next time they open Savorly, starting from the profile they have. It works on your own record too, and opens yours straight away.
- **Complimentary plan**: put a member on Plus or Pro (or back to Free) outside Stripe. Members who pay through Stripe are changed in the Stripe dashboard instead. While `PAID_PLANS` is off, everyone is unlimited anyway; the plan applies once paid plans launch.
- **Delete account**: type their email to confirm. As when members delete themselves, any subscription is cancelled first and Sign in with Apple is revoked.

### Recipe actions

**Unpublish** takes a recipe out of public view at once and leaves it as its author's draft. An admin can **Restore** a recipe that an admin unpublished; publishing anyone else's draft stays with its author. **Delete** is permanent.

## Operator settings

Settings take effect on the next request, without a redeploy, and are stored in the `app_settings` table.

- **Pause all AI features** refuses every new sous-chef message, photo, video, voice call and read-aloud with a maintenance message. Conversations and drafts are kept. Use it if a provider misbehaves or spend runs away.
- **Daily AI budgets** override `AI_DAILY_BUDGET_USD` and `AI_FREE_DAILY_BUDGET_USD`. Leave a field empty to use the environment's value; paying members' plans still add headroom on top ([pricing](PRICING.md)). `0` stops all AI spend.
- **Pause new sign-ups** refuses new accounts by email, Apple or Google, while existing members keep signing in.
- **Test onboarding** (only for you, on this device): **Replay my kitchen setup** opens the new-kitchen setup now, recorded in the audit log like a restart from your member record. **Replay the welcome** signs you out and shows the first-launch welcome a new phone sees (language, then join, sign in or look around), on the web too, where it otherwise never appears.
- **Announcement** shows a message (up to 280 characters, info or warning) at the top of the app for everyone, signed in or not, through `GET /v1/capabilities`. Each person can dismiss it on their device; changing the text shows it again. Announcements aren't translated.

## API

Every endpoint is under `/v1/admin`, requires a signed-in admin (`401` signed out, `403` otherwise), and records writes in `admin_actions`. Lists take `q`, `offset` and `limit` (up to 500) and return `{ items, total, offset, limit }`.

| Area | Endpoints |
| --- | --- |
| Overview | `GET /overview` |
| Members | `GET /users?q=&filter=&sort=`, `GET /users/:id`, `PATCH /users/:id`, `POST` or `DELETE /users/:id/suspend`, `POST /users/:id/sign-out`, `POST /users/:id/verify`, `POST /users/:id/setup`, `PUT /users/:id/admin`, `PUT /users/:id/plan`, `DELETE /users/:id` (body `{ "confirm": "<their email>" }`) |
| Recipes | `GET /recipes?q=&filter=&sort=`, `GET /recipes/:id`, `PUT /recipes/:id/published`, `POST /recipes/:id/reports` (`resolved` or `dismissed`), `DELETE /recipes/:id` |
| Moderation | `GET /reports?status=open`, `GET /reviews?q=&rating=`, `DELETE /reviews/:id` |
| AI | `GET /ai`, `GET /jobs?status=&kind=&q=`, `GET /jobs/:id`, `POST /jobs/:id/cancel`, `POST /voice/:id/end` |
| Settings and audit | `GET` or `PUT /settings`, `GET /audit?q=&type=` |

`GET /v1/me` includes `admin`, `adminOwner`, and `adminPending` (an owner address that isn't verified yet).

## Verification

`services/api/internal/app/admin_test.go` covers owner verification, appointments and their limits, suspension (sign-in, sessions, public views, cancelled AI work), the report lifecycle, publish rules, operator settings, complimentary plans, deletion and the audit trail. It needs `TEST_DATABASE_URL` like the other database tests. `apps/mobile/tests/admin.spec.ts` checks the console in the browser with a mocked API, and `scripts/integration.py` checks that the admin API is closed to members.
