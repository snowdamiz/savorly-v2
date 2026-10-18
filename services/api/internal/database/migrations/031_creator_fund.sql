-- The creator fund (docs/CREATOR-FUND.md): cooking sessions from cooking mode, the real cook
-- times they give recipes, and the monthly ledger that pays creators from subscriptions.

-- One run through cooking mode by a signed-in member. A finished session that plausibly happened
-- is a verified cook (cook_sessions.go has the rule): verified_day is the UTC day it finished, and
-- a member has at most one verified cook of a recipe a day. net_cents is what the member's
-- subscription brought in a month after fees when the cook was verified, 0 for Free,
-- complimentary, trial and past-due plans; the fund's share of it goes to the creators the member
-- cooked from that month. steps is the recipe's step count when the session started.
CREATE TABLE cook_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipe_id text NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  steps integer NOT NULL CHECK (steps > 0),
  step_reached integer NOT NULL DEFAULT 1 CHECK (step_reached BETWEEN 1 AND steps),
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  verified boolean NOT NULL DEFAULT false,
  verified_day date,
  net_cents integer NOT NULL DEFAULT 0 CHECK (net_cents >= 0),
  CONSTRAINT cook_sessions_verified_finished CHECK (NOT verified OR (finished_at IS NOT NULL AND verified_day IS NOT NULL))
);
CREATE UNIQUE INDEX cook_sessions_one_a_day ON cook_sessions(user_id, recipe_id, verified_day) WHERE verified;
-- A recipe's latest verified cooks (its cook time) and a creator's month, recipe by recipe.
CREATE INDEX cook_sessions_recipe_idx ON cook_sessions(recipe_id, finished_at DESC) WHERE verified;
-- A month's verified cooks, for closing the fund.
CREATE INDEX cook_sessions_finished_idx ON cook_sessions(finished_at) WHERE verified;
-- The member's own sessions (the export), and the ones the janitor clears.
CREATE INDEX cook_sessions_user_idx ON cook_sessions(user_id, started_at);
CREATE INDEX cook_sessions_unverified_idx ON cook_sessions(started_at) WHERE NOT verified;

-- How long a recipe really takes: the median of its latest verified cooks, kept up to date as
-- cooks are verified so recipe lists read it with one key lookup. cooks counts every verified
-- cook of the recipe.
CREATE TABLE recipe_cook_times (
  recipe_id text PRIMARY KEY REFERENCES recipes(id) ON DELETE CASCADE,
  cooks integer NOT NULL CHECK (cooks >= 0),
  minutes integer NOT NULL CHECK (minutes > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A creator's Stripe Connect Express account, and an admin's hold on their payouts (which can
-- exist before any account does). payouts_enabled follows Stripe's account.updated events.
CREATE TABLE creator_accounts (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_account_id text UNIQUE,
  country text NOT NULL DEFAULT '' CHECK (country ~ '^([A-Z]{2})?$'),
  payouts_enabled boolean NOT NULL DEFAULT false,
  details_submitted boolean NOT NULL DEFAULT false,
  held_at timestamptz,
  held_reason text NOT NULL DEFAULT '' CHECK (char_length(held_reason) <= 500),
  held_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per closed month, written with that month's earnings in one transaction: its existence
-- is what makes closing a month happen once. pool_cents is the share of paying members' net
-- revenue allocated to creators, and equals the month's earnings added up.
CREATE TABLE creator_fund_months (
  month date PRIMARY KEY CHECK (extract(day FROM month) = 1),
  share_bp integer NOT NULL CHECK (share_bp BETWEEN 0 AND 10000),
  pool_cents bigint NOT NULL DEFAULT 0 CHECK (pool_cents >= 0),
  members integer NOT NULL DEFAULT 0,
  cooks integer NOT NULL DEFAULT 0,
  creators integer NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now()
);

-- A Stripe transfer to a creator. A payout is 'sending' from just before the transfer is asked
-- for until Stripe's answer is recorded; its id is the transfer's idempotency key and transfer
-- group, so a payout interrupted in between is found again at Stripe rather than sent twice.
CREATE TABLE creator_payouts (
  id text PRIMARY KEY,
  creator_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_account_id text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'paid', 'failed')),
  transfer_id text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX creator_payouts_creator_idx ON creator_payouts(creator_id, created_at DESC);
CREATE INDEX creator_payouts_sending_idx ON creator_payouts(updated_at) WHERE status = 'sending';

-- What a creator earned in a closed month, in whole cents, and from how many verified cooks by
-- paying members. Unpaid rows are 'pending'; payout_id links them to the transfer on its way, and
-- goes back to NULL if that transfer fails.
CREATE TABLE creator_earnings (
  creator_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month date NOT NULL REFERENCES creator_fund_months(month),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  cooks integer NOT NULL CHECK (cooks > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  payout_id text REFERENCES creator_payouts(id) ON DELETE SET NULL,
  paid_at timestamptz,
  PRIMARY KEY (creator_id, month)
);
CREATE INDEX creator_earnings_month_idx ON creator_earnings(month);
CREATE INDEX creator_earnings_payout_idx ON creator_earnings(payout_id) WHERE payout_id IS NOT NULL;
