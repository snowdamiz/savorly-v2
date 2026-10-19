# Admin console

Savorly has a built-in admin console for running the community: the moderation queue, members, recipes, reviews, AI spend and jobs, whether members cook, the weekly cook-along, operator settings, and an audit log of every change made there. It opens from **Admin console** in the desktop sidebar or **My kitchen** on phones (`/?page=admin` on the web), and only for admins. The console is an operator tool, so it is in English; dates, relative times ("3 hours ago") and numbers follow the app's language.

## Who is an admin

- **Owners** are the addresses in `ADMIN_EMAILS` (comma separated). There is no default: without it, no one can open the console, and the API logs a warning at startup in production. Owners can do everything, including appointing other admins.
- **Admins** are members an owner appoints from a member's record (**Make admin**). They can do everything except appoint or remove admins and change the daily AI budgets, and they can't act on owners, on each other, or on any address in `ADMIN_EMAILS` (verified or not). That covers what those people made too: an admin can't unpublish, restore, delete or close reports on their recipes, delete their reviews, cancel their AI jobs or end their voice sessions. Admins also can't restore their own recipe, close its reports or give themselves a complimentary plan; an owner decides those. No one, owners included, gives themselves a plan.

An owner's address only counts once it is **verified**. Registering with an email proves nothing, so otherwise anyone could register an owner's address before its owner and take over the console. An account's email is verified by the code in its welcome or confirmation email, a password reset code, confirming a change of address, or by signing in or connecting Google or Apple with the same verified address. Until then, the owner's Settings explain what to do. Local development (`APP_ENV` other than `production`) skips this check because it has no email; staging runs in production mode and needs it.

To verify an owner on a server without password-reset email or Google sign-in, set it in the database:

```sql
UPDATE users SET email_verified = true WHERE email = 'owner@example.com';
```

No one can mark an address in `ADMIN_EMAILS` as verified from the console, or appoint it as an admin, so a squatted owner address can't be promoted. An owner can still suspend or delete it; appointed admins can't act on it at all, so an owner who hasn't verified yet is safe from them.

## What's in it

The sections come in four groups: at a glance (Overview, Cooking), moderation (Reports, Reviews), people and recipes (Members, Recipes), and running Savorly (AI & jobs, Settings, Audit log). The desktop shows them as tabs; on phones and tablets the section's name at the top opens a menu of them in those groups, with the open reports beside Reports (and beside the section's name elsewhere). A member's record is in three parts, Account, Activity and Manage (every action, then the admin history); a recipe's in two, Recipe and Moderation (its actions, reports and admin history), under its status and any hold. AI & jobs is split into Usage, Turns and Jobs.

| Section | What you can do |
| --- | --- |
| Overview | Members, sign-ins, recipes, open reports, AI spend against today's budgets, the AI queue, 30-day sign-ups/recipes/spend/jobs, plan and sign-in mix, community activity, and which integrations are configured (never their secrets). Alerts point at anything needing attention. While the creator fund is on, a Creator fund panel: this month so far, unpaid and paid earnings, the paid-cooks signals, payouts, payout accounts and every closed month. |
| Cooking | Whether members cook in Savorly ([below](#cooking)), the creator fund week by week (while it's on), the weekly cook-along's weeks with who scheduled them and how many cooked, and the founding creators in the order their turns come. |
| Reports | The moderation queue, grouped by recipe and most-reported first. Dismiss, unpublish (which resolves the reports), delete the recipe, or open the author. Resolved and dismissed reports stay browsable with who closed them and their note. A new report on a closed recipe reopens it. |
| Reviews | Search and filter by rating; delete reviews (the audit log keeps the text). |
| Members | Search and filter (admins, suspended, unverified, paid, reported, sample cooks, founding creators); sort by newest, last sign-in, AI spend or recipes. A member's record shows their account, sign-in methods, plan and Stripe IDs, 30-day AI use against their plan, activity counts, recipes, reviews, AI jobs, reports they filed, their creator earnings and payouts (while the creator fund is on), and admin history. |
| Recipes | Every recipe including drafts, filtered by published, drafts, reported, AI-generated or suspended author, and sorted by newest, recently edited, most reported, most saved or top rated. A recipe's record shows its full content, reports and admin history. |
| AI & jobs | Usage: live voice sessions (end one), top spenders, and use and failures per tool. Jobs: every AI job with its prompt, result and error. Cancel queued or processing jobs. Turns: sous-chef turns, by status, channel (text or voice) and member, each with its trace (model rounds with their time and cost, and the tools each called, with any error) and its reply. |
| Settings | Pause all AI, override the daily AI budgets, pause sign-ups, and publish a site-wide announcement. |
| Audit log | Every console action, newest first, searchable. Entries can't be edited from the console and survive deletion of the admin, member or recipe. An entry marked **Needs attention** says what to finish by hand, such as a Stripe change Stripe didn't confirm. |

### Member actions

- **Suspend** (with a reason only admins see): signs them out everywhere, ends live voice, cancels AI work that hasn't reached a provider (releasing its reservation), and blocks sign-in with a "contact support" message. Their recipes, reviews, profile, and the sous-chef's search results stop showing them. A subscription that's billing stops collecting payment (Stripe's `pause_collection` with `void`, so invoices due meanwhile are voided; the plan itself is kept). Nothing is deleted; **Lift suspension** restores everything and resumes collection.
- **Sign out everywhere**, **Mark email as verified**, **Edit profile** (for clearing offensive names, handles, bios or photos; the audit entry keeps the values before and after, so an edit can be reviewed and undone).
- **Restart kitchen setup**: the new-kitchen setup (photo, name and username, food preferences, cooks to follow, meeting the sous-chef) opens for them the next time they open Savorly, starting from the profile they have. It works on your own record too, and opens yours straight away.
- **Complimentary plan**: put a member on Plus or Pro (or back to Free) outside Stripe, but never yourself. Members who pay through Stripe are changed in the Stripe dashboard instead. A comp forgets any ended subscription the member had, so a late Stripe event about it can't undo the comp; a subscription that becomes live again replaces it. Comps add nothing to the members' share of the daily AI budgets ([pricing](PRICING.md)), since they bring no revenue. While `PAID_PLANS` is off, everyone is unlimited anyway; the plan applies once paid plans launch.
- **Make founding creator** / **Remove founding creator**: the "Founding creator" mark on their profile and author lines, and a place in the cook-along's rotation ([creator fund](CREATOR-FUND.md#founding-creators)). Weeks already scheduled stay as they are. The rank rule applies as for suspensions, and no one marks themselves.
- **Hold payouts** (with a reason only admins see; the creator sees only that their payouts are on hold) and **Release payouts**, while the creator fund is on: their earnings keep adding up, but no transfer goes out until the hold is released ([creator fund](CREATOR-FUND.md)). The record shows their payout account with its Stripe id, this month's verified cooks and estimate, each month's earnings and each payout.
- **Delete account**: type their email to confirm. The deletion and its audit entry are committed first; then, as when members delete themselves, any subscription is cancelled and Sign in with Apple is revoked. A deletion that fails leaves nothing done in Stripe or at Apple. If Stripe can't confirm the cancellation, the account is still deleted and the entry says **Needs attention** with the subscription to cancel in the Stripe dashboard.

Stripe and Apple can't share the database transaction, so suspending, lifting a suspension and deleting call them only after the change has committed, best effort. The audit entry records the subscription and each outcome in its detail (`billing`: `pending`, then `paused`, `resumed`, `cancelled`, `failed` or `skipped` when Stripe isn't configured; `apple`: `revoked` or `failed`) and keeps a `followUp` note while anything is left to do. Without a subscription that bills, Stripe isn't involved.

### Recipe actions

**Unpublish** takes a recipe out of public view at once and holds it there: the recipe records when and by whom (`unpublished_by_admin_at`, `unpublished_by`). Its author can still see and edit it as a draft, but publishing it again is refused (`403`) until an admin **Restores** it, which lifts the hold and makes it public again. Restore applies only to a held recipe; publishing anyone else's draft stays with its author. **Delete** is permanent.

The database refuses to publish a held recipe from any path (a check constraint). The sous-chef's own publish step doesn't check for the hold first, so there the recipe stays private and the sous-chef only says it couldn't finish that step.

## Cooking

How we'll know cooking works (plan section 10), worked out when the console asks from what's already recorded. Targets are for the end of Phase 2 and are a starting point; sample cooks never count.

| Metric | How it's counted | Target |
| --- | --- | --- |
| Verified cooks per active member | Verified cooks in the last 30 days, over members active in them: a session used or an app event recorded | 3 (warns under 1) |
| Cooking-mode finish rate | Sessions started 1 to 31 days ago, and how many were finished at the last step | 70% |
| Paying members who cooked | Members paying now (an active subscription), and those with a verified cook this UTC month | 80% |
| Creators earning over $25 | Creators whose earnings in the last closed month are over $25 | 100 |
| Month-3 retention of paying members | Members who first started paying 90 to 120 days ago, and those still paying 90 days in | Above the meal-app norm |
| AI cost per paying member | Paying members' AI spend in 30 days, with their household members who use their plan, and that spend against their plan's cap on average | Under 40% of the cap (warns above) |
| Cook-tested recipes | Published recipes with 5 verified cooks or more ([cook-tested](COOK-TESTED.md)), and those with 1 to 4 | 500 |
| Fixes accepted | Cooks' [suggested fixes](RECIPE-FIXES.md) in 90 days (withdrawn ones left out) and how many their authors accepted | 1 in 4 |

When members start and stop paying is recorded from migration 038 on (`paid_spans`, kept by a trigger on every plan change, deleted with the account); members already paying then have no start, so retention leaves them out until new cohorts reach three months. Cook-tested recipes, step notes and accepted fixes come with the work that records them.

The **cook-along** list shows this week and the next eight (open weeks too) and the last four, each with its recipe, who scheduled it or that the rotation picked it, whether it was announced, and how many started cooking it and verified cooks; **Schedule** or **Change** picks a recipe (the founding creators' first, in the order their turn offers them, or any public recipe), and the clear button hands a week back to the rotation. The first open week says what the rotation will give it. Rules: [creator fund](CREATOR-FUND.md#the-weekly-cook-along).

## Operator settings

Settings take effect on the next request, without a redeploy, and are stored in the `app_settings` table. Saves are checked against the version the form was opened with: if another admin saved in between, the save is refused and the console reloads their settings and says so, instead of quietly undoing their change.

- **Pause all AI features** refuses every new sous-chef message, photo, video, voice call and read-aloud with a maintenance message. Conversations and drafts are kept. Use it if a provider misbehaves or spend runs away.
- **Daily AI budgets** override `AI_DAILY_BUDGET_USD` and `AI_FREE_DAILY_BUDGET_USD`. Leave a field empty to use the environment's value; paying members' plans still add headroom on top ([pricing](PRICING.md)). `0` stops all AI spend. Budgets are the one hard stop on AI spend, so only owners change them, and an override can be at most ten times the environment's value (raise the environment to go higher). Admins see them and can save the rest of the form. An override set before this limit existed stays until an owner changes it.
- **Pause new sign-ups** refuses new accounts by email, Apple or Google, while existing members keep signing in.
- **Test onboarding** (only for you, on this device): **Replay my kitchen setup** opens the new-kitchen setup now, recorded in the audit log like a restart from your member record. **Replay the welcome** signs you out and shows the first-launch welcome a new phone sees (language, then join, sign in or look around), on the web too, where it otherwise never appears.
- **Announcement** shows a message (up to 280 characters, info or warning) at the top of the app for everyone, signed in or not, through `GET /v1/capabilities`. Each person can dismiss it on their device; changing the text shows it again. Announcements aren't translated.

## API

Every endpoint is under `/v1/admin`, requires a signed-in admin (`401` signed out, `403` otherwise), and records writes in `admin_actions`. Lists take `q`, `offset` and `limit` (up to 500) and return `{ items, total, offset, limit }`; each list's order ends on the row's id, so offset pages never repeat or skip rows that otherwise sort alike. Request fields an endpoint doesn't name are ignored.

| Area | Endpoints |
| --- | --- |
| Overview | `GET /overview`, `GET /insights?days=7\|30` (searches, searches with no results, the kitchen-setup funnel and event counts; see [analytics](API.md#analytics)) |
| Members | `GET /users?q=&filter=&sort=`, `GET /users/:id`, `PATCH /users/:id`, `POST` or `DELETE /users/:id/suspend`, `POST /users/:id/sign-out`, `POST /users/:id/verify`, `POST /users/:id/setup`, `PUT /users/:id/admin`, `PUT /users/:id/plan`, `DELETE /users/:id` (body `{ "confirm": "<their email>" }`) |
| Recipes | `GET /recipes?q=&filter=&sort=`, `GET /recipes/:id`, `PUT /recipes/:id/published`, `POST /recipes/:id/reports` (`resolved` or `dismissed`), `DELETE /recipes/:id` |
| Moderation | `GET /reports?status=open`, `GET /reviews?q=&rating=`, `DELETE /reviews/:id`, `DELETE /comments/:id` (with its replies), `DELETE /suggestions/:id` (a cook's [suggested fix](RECIPE-FIXES.md)) |
| AI | `GET /ai`, `GET /jobs?status=&kind=&q=`, `GET /jobs/:id`, `POST /jobs/:id/cancel`, `POST /voice/:id/end`, `GET /turns?status=&channel=&q=`, `GET /turns/:id` |
| Settings and audit | `GET` or `PUT /settings`, `GET /audit?q=&type=` |
| Creator fund | `GET /fund`, `GET /fund/weeks`, `GET /users/:id/earnings`, `PUT /users/:id/payouts-hold` (body `{ "held": true, "reason" }` or `{ "held": false }`) |
| Cooking | `GET /cooking`, `GET /cook-alongs`, `PUT /cook-alongs/:week` (body `{ "recipeId" }`), `DELETE /cook-alongs/:week`, `PUT /users/:id/founding` (body `{ "founding": true }` or `{ "founding": false }`) |

`GET /v1/me` includes `admin`, `adminOwner`, and `adminPending` (an owner address that isn't verified yet).

- `GET /settings` also returns `budgetLimits` (the highest overrides allowed, ten times `defaults`) and `canChangeBudgets` (true for owners). `PUT /settings` takes `expectedUpdatedAt`: the `updatedAt` the form was loaded with, sent back exactly as received, or `null` before the first save. If the settings changed since, it answers `409` and saves nothing. Requests without it aren't checked. A changed budget answers `403` for an appointed admin and `400` above `budgetLimits`.
- Recipes in `GET /recipes` and `GET /recipes/:id` include `unpublishedByAdminAt` (null unless held), and the record also `unpublishedBy`. `PUT /recipes/:id/published` with `true` answers `409` unless the recipe is held.
- An author's `PUT /v1/recipes/:id` with `published: true` answers `403` while the recipe is held.
- `GET /fund` also has `firstPayoutsWaiting` (creators whose first payout is still waiting its 60 days) and `flags`: `{ "threshold", "members": [{ "id", "name", "email", "cooks", "cents", "creator" }], "creators": [{ "id", "name", "email", "estimateCents", "flaggedCents", "members" }] }`, this month's paying members whose verified cooks, at least `threshold`, all went to one creator, and the creators more than half of whose estimate comes from them. `GET /users/:id/earnings` has `firstPayoutAt` while that wait is ahead. `GET /fund/weeks` answers `{ "weeks": [{ "week", "current", "cooks", "payingMembers", "poolCents", "top", "flaggedMembers", "flaggedCreators" }], "threshold", "sharePercent" }`, the last 8 weeks newest first.
- `GET /cooking` answers `{ "cooksPerActive": { "cooks", "active" }, "finishRate": { "started", "finished" }, "payingCooked": { "month", "paying", "cooked" }, "creatorsOver25": { "month", "creators" }, "retention": { "cohort", "retained", "recordedSince" }, "aiCost": { "members", "spend", "perMember", "shareOfCap" } }` (see [cooking](#cooking)).
- `GET /cook-alongs` answers `{ "week", "announcedWeek", "weeks", "rotation", "next" }`: this week's Monday, the last week announced, the weeks from four back to eight ahead that have a row (`{ "week", "automatic", "scheduledBy", "creator", "recipe", "cooks", "started", "updatedAt" }`, `recipe` `null` once deleted), the founding creators in turn order with their public recipes in the order the rotation offers them (`{ "id", "title", "image", "saveCount", "featuredWeek" }`, up to 5), and the id of whose turn the next open week is. `:week` is a Monday as `YYYY-MM-DD`, this week up to a year ahead (`400` otherwise). `PUT` takes a public recipe whose author isn't suspended (`409`), under the rank rule for the recipe's author (`403`), and answers like `GET`; the same recipe again is `409` unless the rotation picked it. `DELETE` answers like `GET`, or `404` for a week with nothing scheduled. `PUT /users/:id/founding` answers the member's record (`foundingCreatorAt`), `409` when nothing changes.
- Audit entries for suspensions, lifted suspensions and deletions can carry `subscription`, `billing`, `apple` and `followUp` in their `detail`; `member.edit` carries `fields`, `before` and `after`; `member.plan` carries `endedSubscription` when a comp replaced one; `comment.delete` carries up to 300 characters of the comment, its `recipeId` and how many `replies` went with it; `member.payouts_hold` carries its `reason` and `member.payouts_release` the `previousReason`; `cookalong.schedule` carries the `week` and any `previousRecipeId`, and `cookalong.unschedule` the `week`.

## Retention of deleted members' details

The audit log keeps entries after the member they're about is deleted, on purpose: it's the record of what admins did. Today that includes personal data with no expiry: a deletion's entry stores the member's name and email in its detail, every entry's summary names the member's email (for example "Suspended cook@example.com"), `member.edit` entries keep the profile values before and after, and `review.delete` and `comment.delete` entries keep up to 300 characters of what they removed. Admins' own emails stay on the entries they made after they're gone. Nothing in the code removes or redacts these; that is a privacy decision still to make. The options:

- **Keep everything** (today's behaviour). Simplest, and the log stays fully readable, but the privacy policy should say that moderation records keep a deleted member's name and email, and why.
- **Redact on deletion.** When an account is deleted, replace its email and name in earlier entries (summaries and detail) with a placeholder such as "deleted member", keeping the member ID, actions and dates. The log stays useful for patterns and counts but can no longer say who it was, which also loses evidence if they come back under a new account.
- **Expire after a period.** Keep the details for a fixed time (for example 12 or 24 months, to cover disputes, chargebacks and repeat abuse), then redact or delete the entries with a scheduled job.
- **Keep a hashed address.** Store a keyed hash of the email instead of the email itself in new entries, so a returning abuser's address can still be matched without keeping the address readable.

Whichever is chosen, review deletions and `member.edit` detail together, since both hold profile data.

## Verification

`services/api/internal/app/admin_test.go` covers owner verification, appointments and their limits, suspension (sign-in, sessions, public views, cancelled AI work), the report lifecycle, publish rules, operator settings, complimentary plans, deletion and the audit trail. `admin_rules_test.go` covers the rank rule on content and on unverified owners, the moderation hold, comps against late Stripe webhooks and the budget headroom, owner-only and capped budget overrides, stale settings saves, deletion committing before Stripe and Apple, pausing billing on suspension, before-and-after edit records, paging without repeats, and that unknown request fields never reach protected columns; `admin_comments_test.go` the rank rule and audit for comments; `creator_fund_test.go` the creator fund's views and payout holds; `fund_signals_test.go` the paid-cooks signals, the first payout's wait and the weekly report; `cook_along_test.go` the cook-along and founding creators; `admin_metrics_test.go` the cooking metrics and paid spans. They need `TEST_DATABASE_URL` like the other database tests. `apps/mobile/tests/admin.spec.ts`, `admin-actions.spec.ts` and `admin-cooking.spec.ts` check the console in the browser with a mocked API, and `scripts/integration.py` checks that the admin API is closed to members.
