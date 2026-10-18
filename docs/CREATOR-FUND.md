# Creator fund and verified cooks

Creators earn from the cooking they inspire. Each calendar month, a share of what paying members pay is split among the creators of the recipes those members actually cooked. The same cooking data gives every recipe its real cook time ("Cooks usually take about 45 min"), which fixes a common complaint: recipes taking longer than they say.

Code: `services/api/internal/app/cook_sessions.go` (sessions, verification, cook times), `creator_fund.go` (the split, the monthly close, earnings, Stripe Connect onboarding, the Connect webhook and payouts), `fund_signals.go` (the paid-cooks signals and the weekly report), `admin_fund.go` and `admin_metrics.go` (the console), `cook_along.go` and `admin_cook_along.go` (the weekly cook-along and founding creators), migrations `031_creator_fund.sql` and `038_cook_along_and_founding_creators.sql`. App: `src/lib/cookSessions.ts` (cooking mode), `src/components/CookTested.tsx` (recipe page), `src/components/CreatorEarnings.tsx` (My kitchen), `src/screens/Discover.tsx` (the cook-along on Home), `src/components/FoundingMark.tsx`, `src/screens/admin/Fund.tsx` and `Cooking.tsx` (console).

## Verified cooks

Cooking mode records a **cook session** for a signed-in member: it starts when cooking mode opens (`POST /v1/recipes/:id/cook-sessions`), keeps the furthest step reached as the cook moves on, and finishes at "Dinner is served" (`PATCH /v1/cook-sessions/:id`). Guests record nothing, and the app records nothing for a recipe's own author. Sessions never slow cooking down: the app sends them in the background and drops any that fail.

A finished session is a **verified cook** when it plausibly happened:

- **Someone else's public recipe.** The author's own recipes never count, and the recipe must still be published (by an author in good standing) when the session finishes.
- **Cooked to the end.** The session reached the recipe's last step (the step count is taken when it starts, so a recipe edited meanwhile doesn't change it).
- **Long enough.** At least a third of the recipe's stated time passed between start and finish on the server's clock, never less than 3 minutes, and never more than 20 minutes required (so a long braise or a cook who prepared ahead still counts). Tapping straight through the steps doesn't.
- **Within a day.** A session not finished within 24 hours of starting is over.
- **Once a day.** At most one verified cook per member, recipe and UTC day. A unique index enforces it, and a member's sessions finish one at a time, so two finished at once can't both count.

Sessions that don't become verified cooks are deleted by the janitor 35 days after they start; until then they count only toward the console's finish rate and how many people are cooking the week's cook-along. Those with step events for [cook-tested recipes](COOK-TESTED.md) stay 180 days. Verified cooks are kept: they're each recipe's cook time and each month's fund. Both are the member's data: `GET /v1/me/export` includes them (`cookSessions`), and deleting the account deletes them.

**"I cooked this" posts stay social.** A post (`POST /v1/recipes/:id/cooked`) shows on the recipe with its photo and note as before, but without a session it isn't a verified cook: it counts for neither cook times nor money. Posting takes one tap and proves nothing; a session at least shows the cook spent the time on the steps.

## Real cook time

Each recipe carries `verifiedCooks` (all its verified cooks) and `cookedMinutes`: the median length of its latest 500 verified cooks, in whole minutes, or `null` until 3 verified cooks agree. Both are kept in `recipe_cook_times`, recomputed for one recipe each time one of its cooks is verified, so every recipe list reads them with a single key lookup (`TestCookTimeIsAKeyLookup`). The recipe page shows it under the facts, beside the stated time, and from 5 verified cooks the recipe is [cook-tested](COOK-TESTED.md): "Cook-tested · 214 cooks · usually 55 min (says 40)".

## The fund

The fund is user-centric: **a member's money only goes to the cooks they cooked from.**

1. **Each paying member's share.** A member's monthly net revenue is their plan's net after fees as [pricing](PRICING.md) computes it (11% + $0.30 a charge; a yearly plan counts a twelfth each month). The fund takes `CREATOR_FUND_SHARE` of it (default 0.20, in basis points, rounded down to the cent):

   | Plan | Net a month | Fund share at 20% |
   | --- | ---: | ---: |
   | Plus monthly | $8.59 | $1.71 |
   | Plus yearly | $5.91 | $1.18 |
   | Pro monthly | $17.49 | $3.49 |
   | Pro yearly | $11.84 | $2.36 |

   What counts is the plan the member was paying for when each cook was verified (stored on the session as `net_cents`), so a member who cancels later in the month still pays for the cooks they made while subscribed. A member whose plan changed during the month counts at the highest. Free, complimentary, trialing and past-due plans bring no revenue, so they contribute nothing, though their cooks still count for cook times.
2. **Split by their cooks.** That share is divided among the creators of the recipes the member verified-cooked that month, in proportion to how many verified cooks each creator's recipes got from them. The member's own recipes are never among them.
3. **A paying member with no verified cooks contributes nothing that month.** The share isn't pooled and handed to whoever was cooked most, because that would let a creator with fake accounts (or a popular one) collect money from members who never cooked their recipes. Unspent shares stay with Savorly.

**Rounding never makes or loses money.** Amounts are integer cents. Each member's share is split by largest remainder: every creator gets the floor of their exact part, and the cents left over go one each to the largest remainders, ties to the lower creator id. So a member's share is allocated exactly, the month's earnings add up to its `pool_cents`, and the same cooks always split the same way (`TestSplitFundAllocatesEveryCentDeterministically` checks random months).

**Why this resists fraud.** Fake accounts can only redirect their own subscriptions: a ring of accounts paying $9.99 each to send $1.71 each to a creator is a loss. Cooks need time on the steps and count once a day per recipe, so a member can't inflate one creator's share of their own money by much either. Admins can hold a creator's payouts while they look into it. What's left:

- **Paid cooks.** A creator paying real members to cook only their recipes gets at most each member's share ($1.71 to $3.49), and it shows: the console's fund panel lists the paying members whose verified cooks this month, at least 4 of them, all went to one creator, and the creators who get more than half their month's money from such members. These are signals to look into, never holds: plenty of members cook one favourite creator for a month. An admin who finds a ring holds the creator's payouts.
- **Stolen cards.** A subscription paid with a stolen card is disputed weeks later. Months already close only after they end, and a creator's **first payout waits 60 days** after the first month they earned in closed, so the first months' disputes arrive before any of that money leaves. Later payouts don't wait; a hold stays the tool for anything flagged.
- **Fake cooking.** The minimum time, the last-step rule and once a day per recipe stop tapping through. Cooking mode's step events ([cook-tested recipes](COOK-TESTED.md)) add a check: the fund panel lists members with 2 or more verified cooks this month that lasted barely their minimum (within a tenth, and 30 seconds) with every step taking the same time (within 10 seconds, over 3 steps or more), which is what a script or a timer looks like rather than cooking (`tappedMembers` in `fund_signals.go`). Like paid cooks, it's a signal, not a hold.

### Closing a month

The API's creator-fund loop (started with the server, like the janitor) runs soon after start and then hourly. It closes the month before the current one, once: a `creator_fund_months` row is written with that month's `creator_earnings` in one transaction, under an advisory lock, so a second run or replica finds the row and does nothing. Earnings are by verified cooks finished in that UTC month. A month that ended while the API was down for all of the next one isn't closed. The first month paid is the one that ends after `CREATOR_FUND` is switched on, counted whole.

Creators see the current month as it builds up: `GET /v1/me/earnings` works out their part of it live, by the same rule (it reads only the members who cooked their recipes, which is all the split needs).

### Payouts

Creators connect payouts from My kitchen (**Set up payouts**), which opens Stripe Connect Express onboarding in the browser. It isn't a purchase and nothing is sold, so it shows on every platform ([pricing](PRICING.md#where-plans-are-sold-and-why-theres-no-store-commission)).

- **Onboarding.** `POST /v1/me/payouts/onboarding` creates the creator's Express account the first time (in the country they choose, with the transfers capability; outside the US with Stripe's recipient service agreement for cross-border payouts) and answers an Account Link. Once onboarding is done it answers a login link to their Express dashboard instead. Countries Stripe can't pay out to are refused with "Stripe can't send payouts to your country yet…", and the app says so before asking. The list is `payoutCountries` in `creator_fund.go`; check Stripe's cross-border payouts list before changing it.
- **Status.** Stripe's `account.updated` events, on their own Connect webhook (`POST /v1/payouts/webhook`, signed with `STRIPE_CONNECT_WEBHOOK_SECRET`), record whether payouts are enabled: Stripe accepts transfers to the account and pays out to the creator's bank. Like the billing webhook it re-reads the account, so retries and late events converge. Coming back from onboarding, the app also asks `GET /v1/me/earnings?refresh=true`, which re-reads the account.
- **Transfers.** After closing a month, the loop sends every creator whose payouts are enabled, who isn't held or suspended, whose first payout isn't still waiting its 60 days, and whose unpaid earnings reach **$10**, one USD transfer of all of it from the platform's Stripe balance. My kitchen tells a creator when their first payout can go (`firstPayoutAt`). It records the payout (`creator_payouts`, status `sending`) and links the earnings to it before asking Stripe, uses the payout's id as the transfer's idempotency key and transfer group, and then marks the earnings paid with the transfer. One replica runs payouts at a time (an advisory lock).
- **Failures.** If Stripe doesn't confirm the transfer (it refused, the answer was lost, or it came after the client gave up), the payout stays `sending` and nothing more goes to that creator. Ten minutes on, a later run asks Stripe for a transfer in the payout's group: one that was made after all is recorded as paid; otherwise the payout is `failed` and its earnings go back to unpaid, to be tried again a day later as a new payout. A payout left `sending` by a run that stopped halfway is checked the same way, so nothing is ever sent twice.

## Founding creators

The first creators Savorly recruits (plan section 8) are **founding creators**. An admin marks them from a member's record in the console (**Make founding creator**, audited as `member.founding`, and `member.unfounding` to take it back). Their profile has a small "Founding creator" badge, and their recipes' author lines say it beside their name. They take turns in the weekly cook-along, so early cooking concentrates on their recipes; there's no guaranteed minimum. `founding` on recipe authors and creators lets other features put their recipes first.

## The weekly cook-along

One recipe a week, Monday to Sunday in UTC, so many members cook the same thing in the same week and it gathers real cooks fast.

- **On Home** it's a section of its own after the daily dish, "This week's cook-along", with one line saying how many people are cooking it this week (members who started it in cooking mode this week, each once) and the recipe's card. `GET /feed` carries it as `cookAlong` while the recipe is public and its author in good standing; no shelf repeats it.
- **Announced once.** A push notification goes to every member from 12:00 UTC on the week's Monday, or as soon as a recipe is set later that week, never to its author. Claiming the week in `notification_runs` makes it once, however often the week's recipe changes. Members turn it off with its own switch (`preferences.notifications.cookAlong`; [notifications](NOTIFICATIONS.md)).
- **Founding creators take turns.** An admin schedules or changes any week from this one to a year ahead in the console's Cooking section, with any public recipe whose author isn't suspended (the rank rule applies: an appointed admin can't feature their own recipe or another admin's). A week nobody scheduled, or whose recipe has since been deleted, unpublished or its author suspended, goes to the rotation when it starts: the next founding creator in line (never featured first, then featured longest ago, where a week scheduled ahead counts as a turn; then by when they were marked) who has a public recipe, with their most saved recipe that hasn't been a cook-along yet (their most saved, once all have been). The notification loop fills the week within minutes of the API being awake in it. Clearing a week hands it back to the rotation.
- Each week records whose turn it was, so a recipe deleted later doesn't give its creator another turn early. Schedules and clears are audited as `cookalong.schedule` and `cookalong.unschedule` on the recipe.

## Admin console

The Overview has a **Creator fund** panel: this month so far (pool, paying members, cooks, creators and the leading creators), what's unpaid and paid (with how many first payouts are still waiting their 60 days), the paid-cooks signals, payouts in the last 30 days and failures this week, payout accounts, and every closed month. The Cooking section has the fund **week by week** for the last 8 weeks (Monday to Sunday, UTC): what each week added to the pool, its verified cooks, the paying members who cooked, the three creators most cooked by paying members, and that week's paid-cooks signals. A paying member's share joins the month's pool with their first verified cook of the month, so a month's weeks add up to what it closes with. A member's record has their side of it: this month's verified cooks of their recipes and their estimate, unpaid and paid earnings, their payout account (with its Stripe id), each month and each payout, and **Hold payouts** / **Release payouts**, audited as `member.payouts_hold` and `member.payouts_release` with the reason. Held earnings keep adding up; only the transfers wait. The rank rule applies as for suspensions ([admin console](ADMIN.md)).

## Configure

```dotenv
CREATOR_FUND=true                # with PAID_PLANS=true and Stripe configured
CREATOR_FUND_SHARE=0.20          # at most 0.20 (see pricing)
STRIPE_CONNECT_WEBHOOK_SECRET=whsec_...
```

`/v1/capabilities` reports `creatorFund` while `CREATOR_FUND=true`, paid plans are on and billing is configured; without it the earnings and onboarding routes are closed and the loop does nothing. Verified cooks and real cook times don't depend on it: cooking mode records sessions, and recipes show their cook time, whether the fund is on or not. Stripe Connect setup: [accounts](ACCOUNTS.md#stripe-connect--creator-payouts).

## Decisions and limits

- **Deleting an account** deletes its sessions (so their cooks leave cook times the next time the recipe is cooked, and leave months not yet closed), its earnings, unpaid ones included, and its payout records. Closed months keep their totals. The creator's Express account stays at Stripe, where they can close it from the Express dashboard; deleting it from the API on account deletion is a possible follow-up.
- **Refunds and disputes** aren't taken back from creators once a month has closed: the fund uses the plans' net after a conservative fee allowance, which already includes about 1% for refunds and disputes. A yearly plan refunded in the app in its first 14 days ([pricing](PRICING.md#cancelling-renewals-and-refunds)) pays nothing for the cooks made since its year began in months not yet closed: their `net_cents` goes to 0, under the fund's lock, so a month can't close halfway through.
- **Suspended creators** keep earning from cooks made before (their recipes are hidden meanwhile, so there are no new ones) but aren't paid until the suspension is lifted.
- **Currency.** Earnings and transfers are in USD; Stripe converts for creators outside the US.
- **Tax forms.** Stripe Express collects creators' tax details during onboarding; whether Savorly must file 1099s (US) or report under DAC7 (EU) for creator payouts needs checking with an accountant before launch.

## Verification

`cook_sessions_test.go` covers the verification rule (too short, not to the last step, the 3-minute floor, own recipes, once a day, expired sessions, someone else's session), sessions finished at once, the cook-time median and its index. `fund_signals_test.go` covers the paid-cooks signals, the first payout's 60 days, and the weekly report adding up to its months; `cook_along_test.go` the cook-along's weeks, scheduling and its rules, Home, the notification, the rotation and founding creators. `creator_fund_test.go` covers the share cap and margins, plan net cents, the split and its rounding, closing a month once across concurrent runs, earnings, onboarding and the Connect webhook, payouts against a mock Stripe (the minimum, idempotency keys, two months in one transfer, a declined transfer staying unpaid and retried a day later, a lost answer found by its transfer group, stuck payouts, holds), the admin views and holds with their audit entries, and the export and account deletion. `apps/mobile/tests/creator-fund.spec.ts` checks My kitchen's earnings card, payout setup and country rules, the cook-time line and the sessions cooking mode sends; `cook-along.spec.ts` the cook-along on Home, the founding creator mark and the notification switch; `admin-cooking.spec.ts` the console's Cooking section and paid-cooks signals.
