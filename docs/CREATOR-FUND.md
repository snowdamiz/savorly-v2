# Creator fund and verified cooks

Creators earn from the cooking they inspire. Each calendar month, a share of what paying members pay is split among the creators of the recipes those members actually cooked. The same cooking data gives every recipe its real cook time ("Cooks usually take about 45 min"), which fixes a common complaint: recipes taking longer than they say.

Code: `services/api/internal/app/cook_sessions.go` (sessions, verification, cook times), `creator_fund.go` (the split, the monthly close, earnings, Stripe Connect onboarding, the Connect webhook and payouts), `admin_fund.go` (the console), migration `031_creator_fund.sql`. App: `src/lib/cookSessions.ts` (cooking mode), `src/components/CookTime.tsx` (recipe page), `src/components/CreatorEarnings.tsx` (My kitchen), `src/screens/admin/Fund.tsx` (console).

## Verified cooks

Cooking mode records a **cook session** for a signed-in member: it starts when cooking mode opens (`POST /v1/recipes/:id/cook-sessions`), keeps the furthest step reached as the cook moves on, and finishes at "Dinner is served" (`PATCH /v1/cook-sessions/:id`). Guests record nothing, and the app records nothing for a recipe's own author. Sessions never slow cooking down: the app sends them in the background and drops any that fail.

A finished session is a **verified cook** when it plausibly happened:

- **Someone else's public recipe.** The author's own recipes never count, and the recipe must still be published (by an author in good standing) when the session finishes.
- **Cooked to the end.** The session reached the recipe's last step (the step count is taken when it starts, so a recipe edited meanwhile doesn't change it).
- **Long enough.** At least a third of the recipe's stated time passed between start and finish on the server's clock, never less than 3 minutes, and never more than 20 minutes required (so a long braise or a cook who prepared ahead still counts). Tapping straight through the steps doesn't.
- **Within a day.** A session not finished within 24 hours of starting is over.
- **Once a day.** At most one verified cook per member, recipe and UTC day. A unique index enforces it, and a member's sessions finish one at a time, so two finished at once can't both count.

Sessions that don't become verified cooks are deleted by the janitor two days after they start. Verified cooks are kept: they're each recipe's cook time and each month's fund. Both are the member's data: `GET /v1/me/export` includes them (`cookSessions`), and deleting the account deletes them.

**"I cooked this" posts stay social.** A post (`POST /v1/recipes/:id/cooked`) shows on the recipe with its photo and note as before, but without a session it isn't a verified cook: it counts for neither cook times nor money. Posting takes one tap and proves nothing; a session at least shows the cook spent the time on the steps.

## Real cook time

Each recipe carries `verifiedCooks` (all its verified cooks) and `cookedMinutes`: the median length of its latest 500 verified cooks, in whole minutes, or `null` until 3 verified cooks agree. Both are kept in `recipe_cook_times`, recomputed for one recipe each time one of its cooks is verified, so every recipe list reads them with a single key lookup (`TestCookTimeIsAKeyLookup`). The recipe page shows "Cooks usually take about N min" under the facts, beside the stated time.

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

**Why this resists fraud.** Fake accounts can only redirect their own subscriptions: a ring of accounts paying $9.99 each to send $1.71 each to a creator is a loss. Cooks need time on the steps and count once a day per recipe, so a member can't inflate one creator's share of their own money by much either. Admins can hold a creator's payouts while they look into it.

### Closing a month

The API's creator-fund loop (started with the server, like the janitor) runs soon after start and then hourly. It closes the month before the current one, once: a `creator_fund_months` row is written with that month's `creator_earnings` in one transaction, under an advisory lock, so a second run or replica finds the row and does nothing. Earnings are by verified cooks finished in that UTC month. A month that ended while the API was down for all of the next one isn't closed. The first month paid is the one that ends after `CREATOR_FUND` is switched on, counted whole.

Creators see the current month as it builds up: `GET /v1/me/earnings` works out their part of it live, by the same rule (it reads only the members who cooked their recipes, which is all the split needs).

### Payouts

Creators connect payouts from My kitchen (**Set up payouts**), which opens Stripe Connect Express onboarding in the browser. It isn't a purchase and nothing is sold, so it shows on every platform ([pricing](PRICING.md#where-plans-are-sold-and-why-theres-no-store-commission)).

- **Onboarding.** `POST /v1/me/payouts/onboarding` creates the creator's Express account the first time (in the country they choose, with the transfers capability; outside the US with Stripe's recipient service agreement for cross-border payouts) and answers an Account Link. Once onboarding is done it answers a login link to their Express dashboard instead. Countries Stripe can't pay out to are refused with "Stripe can't send payouts to your country yet…", and the app says so before asking. The list is `payoutCountries` in `creator_fund.go`; check Stripe's cross-border payouts list before changing it.
- **Status.** Stripe's `account.updated` events, on their own Connect webhook (`POST /v1/payouts/webhook`, signed with `STRIPE_CONNECT_WEBHOOK_SECRET`), record whether payouts are enabled: Stripe accepts transfers to the account and pays out to the creator's bank. Like the billing webhook it re-reads the account, so retries and late events converge. Coming back from onboarding, the app also asks `GET /v1/me/earnings?refresh=true`, which re-reads the account.
- **Transfers.** After closing a month, the loop sends every creator whose payouts are enabled, who isn't held or suspended, and whose unpaid earnings reach **$10**, one USD transfer of all of it from the platform's Stripe balance. It records the payout (`creator_payouts`, status `sending`) and links the earnings to it before asking Stripe, uses the payout's id as the transfer's idempotency key and transfer group, and then marks the earnings paid with the transfer. One replica runs payouts at a time (an advisory lock).
- **Failures.** If Stripe doesn't confirm the transfer (it refused, the answer was lost, or it came after the client gave up), the payout stays `sending` and nothing more goes to that creator. Ten minutes on, a later run asks Stripe for a transfer in the payout's group: one that was made after all is recorded as paid; otherwise the payout is `failed` and its earnings go back to unpaid, to be tried again a day later as a new payout. A payout left `sending` by a run that stopped halfway is checked the same way, so nothing is ever sent twice.

## Admin console

The Overview has a **Creator fund** panel: this month so far (pool, paying members, cooks, creators and the leading creators), what's unpaid and paid, payouts in the last 30 days and failures this week, payout accounts, and every closed month. A member's record has their side of it: this month's verified cooks of their recipes and their estimate, unpaid and paid earnings, their payout account (with its Stripe id), each month and each payout, and **Hold payouts** / **Release payouts**, audited as `member.payouts_hold` and `member.payouts_release` with the reason. Held earnings keep adding up; only the transfers wait. The rank rule applies as for suspensions ([admin console](ADMIN.md)).

## Configure

```dotenv
CREATOR_FUND=true                # with PAID_PLANS=true and Stripe configured
CREATOR_FUND_SHARE=0.20          # at most 0.20 (see pricing)
STRIPE_CONNECT_WEBHOOK_SECRET=whsec_...
```

`/v1/capabilities` reports `creatorFund` while `CREATOR_FUND=true`, paid plans are on and billing is configured; without it the earnings and onboarding routes are closed and the loop does nothing. Verified cooks and real cook times don't depend on it: cooking mode records sessions, and recipes show their cook time, whether the fund is on or not. Stripe Connect setup: [accounts](ACCOUNTS.md#stripe-connect--creator-payouts).

## Decisions and limits

- **Deleting an account** deletes its sessions (so their cooks leave cook times the next time the recipe is cooked, and leave months not yet closed), its earnings, unpaid ones included, and its payout records. Closed months keep their totals. The creator's Express account stays at Stripe, where they can close it from the Express dashboard; deleting it from the API on account deletion is a possible follow-up.
- **Refunds and disputes** aren't taken back from creators: the fund uses the plans' net after a conservative fee allowance, which already includes about 1% for refunds and disputes.
- **Suspended creators** keep earning from cooks made before (their recipes are hidden meanwhile, so there are no new ones) but aren't paid until the suspension is lifted.
- **Currency.** Earnings and transfers are in USD; Stripe converts for creators outside the US.
- **Tax forms.** Stripe Express collects creators' tax details during onboarding; whether Savorly must file 1099s (US) or report under DAC7 (EU) for creator payouts needs checking with an accountant before launch.

## Verification

`cook_sessions_test.go` covers the verification rule (too short, not to the last step, the 3-minute floor, own recipes, once a day, expired sessions, someone else's session), sessions finished at once, the cook-time median and its index. `creator_fund_test.go` covers the share cap and margins, plan net cents, the split and its rounding, closing a month once across concurrent runs, earnings, onboarding and the Connect webhook, payouts against a mock Stripe (the minimum, idempotency keys, two months in one transfer, a declined transfer staying unpaid and retried a day later, a lost answer found by its transfer group, stuck payouts, holds), the admin views and holds with their audit entries, and the export and account deletion. `apps/mobile/tests/creator-fund.spec.ts` checks My kitchen's earnings card, payout setup and country rules, the cook-time line and the sessions cooking mode sends.
