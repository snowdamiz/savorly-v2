# Plans, pricing, and where they're sold

Checked October 3, 2026. Prices are USD. Re-check provider prices and store rules before launch and at least quarterly; `services/api/internal/app/pricing_test.go` fails if a change to prices, allowances, or cost estimates makes a plan unprofitable.

## Plans

Allowances cover a rolling 30 days.

|                                       |  Free |             Plus |               Pro |
| ------------------------------------- | ----: | ---------------: | ----------------: |
| Monthly                               |    $0 |            $9.99 |            $19.99 |
| Yearly                                |     – | $79.99 (33% off) | $159.99 (33% off) |
| Sous-chef messages                    |    10 |               80 |               130 |
| Live voice minutes                    |     2 |               20 |                40 |
| AI photos                             |     1 |                6 |                10 |
| AI videos                             |     0 |                0 |                 1 |
| Natural-voice read-alouds (new steps) |     5 |               30 |                30 |
| AI spend ceiling (`SpendCap`)         | $0.50 |            $3.80 |             $7.65 |

Everything else (recipes, cookbooks, planner, groceries, pantry, community, device read-aloud) stays free. Comparable apps charge $4.99–$9.99 a month: Samsung Food+ $6.99/$59.99, SideChef $4.99/$49.99, Plan to Eat $5.95/$49, Ollie from $9.99 (October 2026 store listings).

## Why these numbers are cash-flow positive

**Unit costs** (conservative planning values, including OpenRouter's 5.5% credit fee). The agent now uses GPT-6 Luna, verified October 7, 2026; the existing per-turn planning allowance is retained as headroom for longer conversations and multiple tool calls.

| Unit                              |                                                                                               Cost | Source                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------: | ----------------------------------------------------------------------------------- |
| Sous-chef turn                    | $0.025 planning allowance; actual cost depends on tokens and tool rounds | [GPT-6 Luna](https://openrouter.ai/openai/gpt-6-luna): standard $0.10 / $0.50 per M input/output tokens; fast tier $0.20 / $1 |
| Live voice minute                 |                                                                                              $0.05 | GPT-Live, developers.openai.com/api/docs/models/gpt-live-1                          |
| AI cover photo                    |                                                                       ~$0.01–0.02 (reserved $0.05) | GPT Image 2.5 Flare, OpenRouter image endpoints                                     |
| AI video (5 s, 720p)              |                                                                            $1.005 (reserved $1.50) | Seedance 2.5 Eco, reapi.ai/models/seedance-2-5                                      |
| Read-aloud step (~300 characters) |                                                                                            ~$0.012 | OpenRouter elevenlabs/eleven-v4-turbo, regular $0.04 per 1K characters; launch discount excluded                                 |

**Per-member guarantee.** Every AI cost is recorded against the member (the `ai_spend` view). A request is refused once it would take the member past their plan's `SpendCap` for the last 30 days. Sous-chef turns settle to the cost OpenRouter reports, voice to the connected seconds, and media keeps its (higher) reservation, so recorded spend never undercounts. Each plan's allowances at the costs above fit inside its ceiling, so members reach their allowances before the ceiling in normal use.

**Fees.** Revenue is counted after a conservative 11% + $0.30 per charge: Stripe cards 2.9% + $0.30, Billing 0.7%, Tax 0.5%, plus room for Stripe Managed Payments (+3.5%), international cards and conversion, and about 1% refunds and disputes (stripe.com/pricing).

|              | Net per month | Worst-case AI | Share of net |
| ------------ | ------------: | ------------: | -----------: |
| Plus monthly |         $8.59 |         $3.80 |          44% |
| Plus yearly  |         $5.91 |         $3.80 |          64% |
| Pro monthly  |        $17.49 |         $7.65 |          44% |
| Pro yearly   |        $11.84 |         $7.65 |          65% |

So even a member who maxes out everything leaves at least 35% of net revenue. Yearly plans collect twelve months up front. Typical members use a fraction of their allowances, so the realistic margin is much higher.

**Free use is paid for.** Free members share a daily budget of `AI_FREE_DAILY_BUDGET_USD` (default $5, about $150 a month at most) plus 15% of paying members' daily net revenue. A hard daily circuit breaker (`AI_DAILY_BUDGET_USD`, default $25, plus every paying member's ceiling ÷ 30) stops runaway spend from a bug without blocking members inside their plan.

**Infrastructure costs** need a new estimate for the intended Cloudflare deployment. Use Cloudflare Workers, Containers, R2, and Email Service, plus Neon for the current PostgreSQL database; do not budget for Fly.io or a separate email provider. Containers add usage charges to the Workers Paid plan, so a reliable total depends on instance size, active time, CPU, and traffic (see [Containers pricing](https://developers.cloudflare.com/containers/pricing/)). The current background worker polls Postgres every second while the API runs, which affects database idle time and must be considered alongside container sleep/restart behavior. The previous fixed-cost and break-even estimate is withdrawn until this deployment is sized; per-member AI ceilings above are unchanged.

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
- Purchases someone makes on the website on their own, with no in-app link, carry no store fee on either platform.

### Risks to decide on

1. **Apple's fee may return.** On August 13, 2026, Apple asked the district court for 15% (10% renewals, 5% Small Business) on US link-outs, and the Supreme Court is reviewing the contempt ruling (No. 25-1311). If a fee is approved, purchases started from the iOS link would owe it. The 35% margin floor absorbs it, but set `canSellHere()` (apps/mobile/src/lib/billing.ts) to `false` for iOS if you'd rather not pay.
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
APP_URL=https://savorly.app # where checkout returns
AI_FREE_DAILY_BUDGET_USD=5
AI_DAILY_BUDGET_USD=25
```

1. In Stripe, create products Plus and Pro with monthly and yearly recurring prices matching the table (the catalog in `internal/app/plans.go` is what the app displays).
2. Add a webhook endpoint `https://<api>/v1/billing/webhook` for `checkout.session.completed` and `customer.subscription.created/updated/deleted/paused/resumed`.
3. Enable the customer portal (plan changes, cancellation, payment methods, invoices).
4. Decide on tax: Stripe Tax requires registering where you have obligations; Stripe Managed Payments (merchant of record, +3.5%) handles global tax for you.

The webhook re-reads each subscription from Stripe, so duplicate or out-of-order events converge on Stripe's state. Deleting an account cancels its subscription first, and stops if Stripe can't confirm. Past-due subscriptions keep access while Stripe retries.
