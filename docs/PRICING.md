# Plans, pricing, and where they're sold

Checked October 3, 2026. Prices are USD. Re-check provider prices and store rules before launch and at least quarterly; `services/api/internal/app/pricing_test.go` fails if a change to prices, allowances, or cost estimates makes a plan unprofitable.

## Before launch: unlimited Free

Paid plans are off until `PAID_PLANS=true`. Until then every member is on Free with no allowances or `SpendCap`; only the shared daily budgets (`AI_FREE_DAILY_BUDGET_USD`, `AI_DAILY_BUDGET_USD`) bound AI spend. The app hides the plan card, `/v1/billing` returns 404, and checkout and the Stripe webhook are closed even if Stripe keys are set, so no Stripe account is needed. Videos are included when `REAPI_API_KEY` is set, and recipes made with the sous-chef then generate one automatically, at about $1.50 each against the daily budget.

To launch: configure Stripe ([accounts](ACCOUNTS.md#6-stripe--subscriptions)), set `PAID_PLANS=true`, and size the daily budgets for the table below.

## Plans

Allowances cover a rolling 30 days once `PAID_PLANS=true`.

|                                       |  Free |             Plus |               Pro |
| ------------------------------------- | ----: | ---------------: | ----------------: |
| Monthly                               |    $0 |            $9.99 |            $19.99 |
| Yearly                                |     – | $79.99 (33% off) | $159.99 (33% off) |
| Sous-chef messages                    |    10 |               80 |               130 |
| Live voice minutes                    |     2 |               20 |                40 |
| AI photos                             |     1 |                6 |                10 |
| AI videos                             |     0 |                0 |                 1 |
| Natural-voice read-alouds (new steps) |     5 |               30 |                30 |
| Cooking questions (“Chef, …”)         |    30 |              100 |               150 |
| AI spend ceiling (`SpendCap`)         | $0.50 |            $3.80 |             $7.69 |

Everything else (recipes, cookbooks, planner, groceries, pantry, community, device read-aloud, recipes translated into your language, and hands-free cooking's spoken commands) stays free. Comparable apps charge $4.99–$9.99 a month: Samsung Food+ $6.99/$59.99, SideChef $4.99/$49.99, Plan to Eat $5.95/$49, Ollie from $9.99 (October 2026 store listings).

## Why these numbers are cash-flow positive

**Unit costs** (conservative planning values, including OpenRouter's 5.5% credit fee). The agent now uses GPT-6 Luna, verified October 7, 2026; the existing per-turn planning allowance is retained as headroom for longer conversations and multiple tool calls.

| Unit                              |                                                                                               Cost | Source                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------: | ----------------------------------------------------------------------------------- |
| Sous-chef turn                    | $0.025 planning allowance; actual cost depends on tokens and tool rounds | [GPT-6 Luna](https://openrouter.ai/openai/gpt-6-luna): standard $0.10 / $0.50 per M input/output tokens; fast tier $0.20 / $1 |
| Live voice minute                 |                                                                                              $0.05 | GPT-Live, developers.openai.com/api/docs/models/gpt-live-1                          |
| AI cover photo                    |                                                                       ~$0.01–0.02 (reserved $0.05) | GPT Image 2.5 Flare, OpenRouter image endpoints                                     |
| AI video (5 s, 720p)              |                                                                            $1.005 (reserved $1.50) | Seedance 2.5 Eco, reapi.ai/models/seedance-2-5                                      |
| Read-aloud step (~300 characters) |                                                                                            ~$0.012 | OpenRouter elevenlabs/eleven-v4-turbo, regular $0.04 per 1K characters; launch discount excluded                                 |
| Recipe translation (~3,000 characters), once per recipe and language | ~$0.005 (reserved $0.01 + $1 per million characters) | GPT-6 Luna fast tier with low reasoning: the recipe in, the same text out; shared by every later reader |
| Cooking question (hands-free)     | $0.0005 planning cost (~1,500 tokens in, ~150 out); reserved ~$0.001, at most ~$0.005; settles to provider usage | GPT-6 Luna at the fast tier's $0.20 / $1 per M tokens, low reasoning, 300 output tokens at most |

**Per-member guarantee.** Every AI cost is recorded against the member (the `ai_spend` view). A request is refused once it would take the member past their plan's `SpendCap` for the last 30 days. Sous-chef turns and cooking questions settle to the cost OpenRouter reports, voice to the connected seconds, and media keeps its (higher) reservation, so recorded spend never undercounts. Each plan's allowances at the costs above fit inside its ceiling, so members reach their allowances before the ceiling in normal use.

**Fees.** Revenue is counted after a conservative 11% + $0.30 per charge: Stripe cards 2.9% + $0.30, Billing 0.7%, Tax 0.5%, plus room for Stripe Managed Payments (+3.5%), international cards and conversion, and about 1% refunds and disputes (stripe.com/pricing).

|              | Net per month | Worst-case AI | Share of net |
| ------------ | ------------: | ------------: | -----------: |
| Plus monthly |         $8.59 |         $3.80 |          44% |
| Plus yearly  |         $5.91 |         $3.80 |          64% |
| Pro monthly  |        $17.49 |         $7.69 |          44% |
| Pro yearly   |        $11.84 |         $7.69 |          65% |

So even a member who maxes out everything leaves at least 35% of net revenue (15% once the creator fund, below, takes its share).

**Cooking questions.** Hands-free cooking ([hands-free](HANDS-FREE.md)) recognizes speech on the device, so its commands cost nothing and have no limit; only a question that starts with "Chef" calls the model. A question reserves its prompt counted byte for byte as tokens at the fast tier's prices (about $0.001 for a typical recipe; the longest prompt the server builds, about 20 KB, reserves about $0.005) and settles to OpenRouter's reported cost, typically $0.0002–0.0005. At the $0.0005 planning cost, Free's 30 questions add $0.015 (its allowances come to $0.475 of its $0.50 ceiling) and Plus's 100 add $0.05 ($3.71 of $3.80). Pro's other allowances already came to $7.61 of its $7.65 ceiling, so its 150 questions ($0.075) raise the ceiling to $7.69, still under 65% of its yearly net ($7.70). Allowances of 300 and 600 would not fit Pro's ceiling without cutting another allowance; a typical cook asks a handful, so 30, 100 and 150 cover several cooks a week. A cook who runs out keeps every command, and the live sous-chef keeps its own minutes. Yearly plans collect twelve months up front. Typical members use a fraction of their allowances, so the realistic margin is much higher.

**The creator fund** ([creator fund](CREATOR-FUND.md)), once `CREATOR_FUND=true`, pays creators `CREATOR_FUND_SHARE` (default and maximum 20%) of a paying member's monthly net above ($1.71 Plus monthly, $1.18 Plus yearly, $3.49 Pro monthly, $2.36 Pro yearly), split among the creators of the recipes that member verified-cooked that month; a member with no verified cooks that month contributes nothing. With the fund, a member who maxes out every allowance (up to 65% of net), the fund's 20% and the free members' 15% (below) add up to at most 100% of net, so even that member doesn't cost more than they bring in; `creator_fund_test.go` fails if a change breaks it, and the share is capped at 20% for that reason. Typical members leave far more, since few use every allowance and the fund only takes a share from members who cooked.

**Shared translations.** A recipe's translation is made once per language and read by everyone after, so no member pays for it and it counts toward no plan: it comes out of the free members' daily budget below, reserved at a cent plus $1 per million characters and settled to the reported cost. Only signed-in members start one, 30 an hour each, so crawlers can't spend that budget ([API](API.md#recipe-translations)).

**Free use is paid for.** Free members share a daily budget of `AI_FREE_DAILY_BUDGET_USD` (default $5, about $150 a month at most) plus 15% of paying members' daily net revenue. A hard daily circuit breaker (`AI_DAILY_BUDGET_USD`, default $25, plus every paying member's ceiling ÷ 30) stops runaway spend from a bug without blocking members inside their plan. Complimentary plans granted in the admin console bring no revenue, so they add to neither; their use comes out of the base budgets. Owners can override the base budgets from the console, up to ten times the environment's values ([admin console](ADMIN.md#operator-settings)).

**Infrastructure costs** need a new estimate for the intended Cloudflare deployment. Use Cloudflare Workers, Containers, R2, and Email Service, plus Neon for the current PostgreSQL database; do not budget for Fly.io or a separate email provider. Containers add usage charges to the Workers Paid plan, so a reliable total depends on instance size, active time, CPU, and traffic (see [Containers pricing](https://developers.cloudflare.com/containers/pricing/)). While the API runs, the background worker looks for work every 30 seconds when idle (enqueued work wakes it at once) and its recovery sweeps run every minute, which affects database idle time and must be considered alongside container sleep/restart behavior. The previous fixed-cost and break-even estimate is withdrawn until this deployment is sized; per-member AI ceilings above are unchanged.

## Where plans are sold, and why there's no store commission

Plans are bought only on the web through Stripe Checkout. The apps never take payment.

| Platform                     | Shows prices / checkout link                      | Store fee           | Unlocks web plans |
| ---------------------------- | ------------------------------------------------- | ------------------- | ----------------- |
| Web                          | Yes                                               | none                | Yes               |
| iOS, US App Store storefront | Yes (opens the browser)                           | 0% today            | Yes               |
| iOS, other storefronts       | No: no prices, links, or "buy on the web" wording | none (nothing sold) | Yes (see risk 2)  |
| Android, everywhere          | No ("consumption-only")                           | none                | Yes               |

- **Apple, US.** Since Epic v. Apple (contempt order April 30, 2025; affirmed by the Ninth Circuit December 11, 2025; stay lifted April 29, 2026), US-storefront apps may link to web checkout with no entitlement and no commission (developer.apple.com/app-store/review/guidelines, 3.1.1(a)). The app reads the storefront from StoreKit (`modules/storefront`), never the device region.
- **Apple, elsewhere.** Linking out from the EU, Japan, or Brazil costs 15% (10% after a subscription's first year) and needs an entitlement, disclosure sheets, and monthly reports. Other storefronts forbid steering entirely. The app shows only plan status and usage there.
- **Google Play.** Play's US external-links program charges 10% on subscriptions within 24 hours of a link tap, and EEA/UK programs charge similar fees. Instead, the Android app is consumption-only, which Play allows everywhere: nothing is sold in the app, and plans bought elsewhere unlock (support.google.com/googleplay/android-developer/answer/10281818).
- **The assistant** is told never to quote prices or say where to buy, so it can't steer where the app may not.
- **Creator payouts aren't a purchase.** My kitchen's Creator earnings (shown to cooks with published recipes while the creator fund is on) opens Stripe Connect onboarding in the browser on every platform: it pays creators and sells nothing. The card shows no prices, plans or checkout links, only what the creator earned and the fund's share ("Each month, 20% of what members pay goes to the cooks whose recipes they actually cooked."), so the iOS and Android apps still sell nothing. If App Review reads that sentence as steering on a non-US storefront, hide it there with `canSellHere()` like the plan prices.
- Purchases someone makes on the website on their own, with no in-app link, carry no store fee on either platform.

### Risks to decide on

1. **Apple's fee may return.** On August 13, 2026, Apple asked the district court for 15% (10% renewals, 5% Small Business) on US link-outs, and the Supreme Court is reviewing the contempt ruling (No. 25-1311). If a fee is approved, purchases started from the iOS link would owe it. The 35% margin floor absorbs it (with the creator fund at 20%, lower `CREATOR_FUND_SHARE` to make room), but set `canSellHere()` (apps/mobile/src/lib/billing.ts) to `false` for iOS if you'd rather not pay.
2. **Guideline 3.1.3(b).** Its text says apps may unlock features bought elsewhere "provided those items are also available as in-app purchases within the app". Some link-only US apps have passed review, but App Review may require IAP. If it does, add StoreKit IAP at a higher price that covers Apple's 15–30% (expo-iap or RevenueCat), and keep web checkout as the cheaper option where linking is allowed.
3. **Provider routing and pricing.** The agent requests the lowest-latency provider. GPT-6 Luna's fast tier currently costs twice its standard per-token rate. Prices and token use can change; the spend ceiling still applies, and longer conversations can reach it sooner.

## Configure

```dotenv
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PLUS_MONTHLY=price_...
STRIPE_PRICE_PLUS_YEARLY=price_...
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_PRICE_PRO_YEARLY=price_...
STRIPE_AUTOMATIC_TAX=true   # after registering for tax where required
APP_URL=https://savorly.cooking # where checkout returns
AI_FREE_DAILY_BUDGET_USD=5
AI_DAILY_BUDGET_USD=25
# The creator fund, once plans are on sale (docs/CREATOR-FUND.md, Stripe Connect in ACCOUNTS.md):
CREATOR_FUND=true
CREATOR_FUND_SHARE=0.20
STRIPE_CONNECT_WEBHOOK_SECRET=whsec_...
```

1. In Stripe, create products Plus and Pro with monthly and yearly recurring prices matching the table (the catalog in `internal/app/plans.go` is what the app displays).
2. Add a webhook endpoint `https://<api>/v1/billing/webhook` for `checkout.session.completed` and `customer.subscription.created/updated/deleted/paused/resumed`.
3. Enable the customer portal (plan changes, cancellation, payment methods, invoices).
4. Decide on tax: Stripe Tax requires registering where you have obligations; Stripe Managed Payments (merchant of record, +3.5%) handles global tax for you.

The webhook re-reads each subscription from Stripe, so duplicate or out-of-order events converge on Stripe's state. A live subscription always applies; any other event applies only to the subscription on record, so a late event about an ended subscription can't undo a complimentary plan. When members delete their account, the subscription is cancelled first, and deletion stops if Stripe can't confirm. An admin's deletion is committed and audited first and then cancels the subscription; if Stripe can't confirm, the audit log says which subscription to cancel in the Stripe dashboard. Suspending a member pauses payment collection (invoices due meanwhile are voided) until the suspension is lifted. Past-due subscriptions keep access while Stripe retries.
