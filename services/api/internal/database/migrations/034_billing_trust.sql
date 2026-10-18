-- Billing members can trust (docs/PRICING.md#cancelling-renewals-and-refunds): when the paid
-- period started, the reminders sent before yearly renewals, and the refunds asked for in the app.

-- The start of the subscription's current period, from Stripe, beside plan_renews_at (its end).
ALTER TABLE users ADD COLUMN plan_period_start timestamptz;

-- One reminder per subscription and renewal, a week before a yearly plan renews. The row is
-- written before anything is sent, in the same transaction as the push notice, so a renewal is
-- reminded once across restarts and replicas. emailed_at or email_error is what became of the
-- email; one cut off on its way isn't sent again.
CREATE TABLE renewal_reminders (
  subscription_id text NOT NULL,
  renews_at timestamptz NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  currency text NOT NULL,
  emailed_at timestamptz,
  email_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subscription_id, renews_at)
);
CREATE INDEX renewal_reminders_user_idx ON renewal_reminders(user_id);

-- A full refund of a yearly plan's payment, asked for in the app in the first 14 days of its
-- year: one per invoice. completed_at is set once Stripe has refunded the payment and ended the
-- subscription; until then the member's next request finishes it rather than starting another.
CREATE TABLE plan_refunds (
  invoice_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id text NOT NULL,
  period_start timestamptz NOT NULL,
  payment_intent text NOT NULL DEFAULT '',
  charge text NOT NULL DEFAULT '',
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL,
  refund_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (payment_intent <> '' OR charge <> '')
);
CREATE INDEX plan_refunds_user_idx ON plan_refunds(user_id);
CREATE UNIQUE INDEX plan_refunds_open_idx ON plan_refunds(subscription_id) WHERE completed_at IS NULL;

-- Renewal reminders reach phones through the push sender (notifications_outbox.go).
ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_kind_check,
  ADD CONSTRAINT notification_outbox_kind_check CHECK (kind IN ('publish','review','comment','pantry','reply','renewal'));
