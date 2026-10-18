package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The creator fund pays creators from subscriptions, user-centric: each calendar month (UTC), a
// share of every paying member's net revenue is split among the creators of the recipes that
// member verified-cooked that month (cook_sessions.go), in proportion to those cooks. A member's
// money only reaches cooks they actually cooked from, so fake accounts can only redirect their own
// subscription. Payouts go out through Stripe Connect Express transfers. docs/CREATOR-FUND.md has
// the rules and the reasoning.

// creatorFundRoutes registers cook sessions, creators' earnings and payouts, Stripe's Connect
// webhook and the fund's admin views.
func (a *App) creatorFundRoutes(v fiber.Router) {
	v.Post("/recipes/:id/cook-sessions", a.requireAuth, perUser(60, time.Hour), a.startCookSession)
	v.Patch("/cook-sessions/:id", a.requireAuth, perUser(600, time.Hour), a.updateCookSession)
	v.Get("/me/earnings", a.requireAuth, a.myEarnings)
	v.Post("/me/payouts/onboarding", a.requireAuth, perUser(20, time.Hour), a.payoutOnboarding)
	v.Post("/payouts/webhook", a.connectWebhook)
	// The admin group's middleware covers these paths too, but they name it themselves so they
	// never depend on the order routes are registered in.
	v.Get("/admin/fund", a.requireAuth, a.requireAdmin, a.adminFund)
	v.Get("/admin/users/:id/earnings", a.requireAuth, a.requireAdmin, a.adminMemberEarnings)
	v.Put("/admin/users/:id/payouts-hold", a.requireAuth, a.requireAdmin, a.adminHoldPayouts)
}

// creatorFundEnabled: CREATOR_FUND=true, with paid plans on and Stripe configured, since the fund
// is paid from subscriptions.
func creatorFundEnabled() bool { return os.Getenv("CREATOR_FUND") == "true" && billingEnabled() }

const (
	// The fund's share can't go above 20% of net revenue: a member who uses every AI allowance costs
	// up to 65% of their net (pricing_test.go) and free use takes another 15% (freeShare), so any
	// more could make a plan cost more than it brings in.
	maxFundShare = 0.20
	// Payouts wait until a creator's unpaid earnings reach $10, so transfer fees stay small.
	payoutMinimumCents = 1000
	// A creator's first payout waits this many days after the first month they earned in closes,
	// so a subscription paid with a stolen card is disputed before any of its money leaves.
	firstPayoutDays = 60
)

// firstPayoutSQL is when the creator whose id is the SQL expression creator may first be paid:
// firstPayoutDays after the first month they earned in closed (creator_fund_months.computed_at);
// NULL before they've earned anything. Later payouts don't wait, since by then it has passed. An
// admin's release of a hold doesn't change it.
func firstPayoutSQL(creator string) string {
	return `(SELECT m.computed_at+make_interval(days=>` + strconv.Itoa(firstPayoutDays) + `) FROM creator_earnings f JOIN creator_fund_months m ON m.month=f.month
 WHERE f.creator_id=` + creator + ` ORDER BY f.month LIMIT 1)`
}

// fundShareBP is CREATOR_FUND_SHARE (default 0.20, at most maxFundShare) in basis points.
func fundShareBP() int {
	share := envFloat("CREATOR_FUND_SHARE", maxFundShare)
	if math.IsNaN(share) || share < 0 {
		share = 0
	}
	return int(math.Round(min(share, maxFundShare) * 10000))
}

const fundUnavailable = "The creator fund isn't available yet."

// payoutCountries are where Stripe Connect Express accounts can receive transfers from a US
// platform (stripe.com/global and Stripe's cross-border payouts list, October 2026). Check both
// before adding one.
var payoutCountries = []string{"AT", "AU", "BE", "BG", "CA", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GB", "GI", "GR",
	"HK", "HR", "HU", "IE", "IT", "JP", "LI", "LT", "LU", "LV", "MT", "NL", "NO", "NZ", "PL", "PT", "RO", "SE", "SG", "SI", "SK", "US"}

func monthStart(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
}

// fundCook is how many verified cooks one member made of one creator's recipes in a month, and
// the most their plan brought in that month (net cents).
type fundCook struct {
	member, creator string
	cooks, net      int
}

// fundShare is what one creator earns in a month, from how many cooks by paying members.
type fundShare struct{ cents, cooks int }

// splitFund applies the fund's rule to a month's cooks. Each member gives the fund shareBP of the
// most their plan brought in that month (members with nothing to give are left out), split
// among the creators they cooked from in proportion to their cooks. Shares are whole cents: each
// creator first gets the floor of their exact part, and the cents left over go one each to the
// largest remainders, ties to the lower creator id. So every member's share is allocated exactly,
// the creators' cents add up to pool, and the same cooks always split the same way.
func splitFund(rows []fundCook, shareBP int) (shares map[string]*fundShare, pool, members, cooks int) {
	byMember := map[string][]fundCook{}
	for _, r := range rows {
		if r.cooks > 0 {
			byMember[r.member] = append(byMember[r.member], r)
		}
	}
	shares = map[string]*fundShare{}
	for _, mine := range byMember {
		net, total := 0, 0
		for _, r := range mine {
			net, total = max(net, r.net), total+r.cooks
		}
		given := net * shareBP / 10000
		if given <= 0 {
			continue
		}
		type part struct {
			creator                 string
			cooks, cents, remainder int
		}
		parts, left := make([]part, len(mine)), given
		for i, r := range mine {
			parts[i] = part{r.creator, r.cooks, given * r.cooks / total, given * r.cooks % total}
			left -= parts[i].cents
		}
		slices.SortFunc(parts, func(x, y part) int {
			if x.remainder != y.remainder {
				return y.remainder - x.remainder
			}
			return strings.Compare(x.creator, y.creator)
		})
		for i := 0; i < left; i++ {
			parts[i].cents++
		}
		for _, p := range parts {
			if p.cents == 0 {
				continue
			}
			s := shares[p.creator]
			if s == nil {
				s = &fundShare{}
				shares[p.creator] = s
			}
			s.cents += p.cents
			s.cooks += p.cooks
		}
		pool, members, cooks = pool+given, members+1, cooks+total
	}
	return shares, pool, members, cooks
}

// fundCooks reads the verified cooks between from and to, by member and creator, never of a
// member's own recipes. With creator set, only the members who cooked that creator's recipes
// count, with all their cooks, which is all splitFund needs to work out that creator's part.
func fundCooks(ctx context.Context, q engagementDB, from, to time.Time, creator string) ([]fundCook, error) {
	rows, e := q.Query(ctx, `SELECT k.user_id,r.author_id,count(*)::int,max(k.net_cents)::int FROM cook_sessions k JOIN recipes r ON r.id=k.recipe_id
 WHERE k.verified AND k.finished_at>=$1 AND k.finished_at<$2 AND r.author_id<>k.user_id
 AND ($3='' OR k.user_id IN (SELECT c.user_id FROM cook_sessions c JOIN recipes cr ON cr.id=c.recipe_id
   WHERE cr.author_id=$3 AND c.verified AND c.finished_at>=$1 AND c.finished_at<$2))
 GROUP BY 1,2 ORDER BY 1,2`, from, to, creator)
	if e != nil {
		return nil, e
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (fundCook, error) {
		var f fundCook
		return f, row.Scan(&f.member, &f.creator, &f.cooks, &f.net)
	})
}

// closeFundMonth works out the month starting at month and records every creator's earnings,
// once: the month's row is written in the same transaction, so a second run (or replica) finds it
// and does nothing. It reports whether this run closed the month.
func closeFundMonth(ctx context.Context, db *pgxpool.Pool, month time.Time) (bool, error) {
	tx, e := db.Begin(ctx)
	if e != nil {
		return false, e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(7182320)`); e != nil {
		return false, e
	}
	share := fundShareBP()
	tag, e := tx.Exec(ctx, `INSERT INTO creator_fund_months(month,share_bp) VALUES($1,$2) ON CONFLICT DO NOTHING`, month, share)
	if e != nil || tag.RowsAffected() == 0 {
		return false, e
	}
	rows, e := fundCooks(ctx, tx, month, month.AddDate(0, 1, 0), "")
	if e != nil {
		return false, e
	}
	shares, pool, members, cooks := splitFund(rows, share)
	var creators []string
	var cents, counts []int
	for creator, s := range shares {
		creators, cents, counts = append(creators, creator), append(cents, s.cents), append(counts, s.cooks)
	}
	if _, e = tx.Exec(ctx, `INSERT INTO creator_earnings(creator_id,month,amount_cents,cooks)
 SELECT c,$1,a,n FROM unnest($2::text[],$3::bigint[],$4::int[]) AS x(c,a,n)`, month, creators, cents, counts); e != nil {
		return false, e
	}
	if _, e = tx.Exec(ctx, `UPDATE creator_fund_months SET pool_cents=$2,members=$3,cooks=$4,creators=$5 WHERE month=$1`, month, pool, members, cooks, len(creators)); e != nil {
		return false, e
	}
	return true, tx.Commit(ctx)
}

// RunCreatorFund closes each month once it ends and pays creators what they've earned: soon
// after start, since a container may sleep before an hour passes, then hourly. Nothing happens
// while the fund is off.
func RunCreatorFund(ctx context.Context, db *pgxpool.Pool) {
	timer := time.NewTimer(2 * time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if creatorFundEnabled() {
				if e := runCreatorFund(ctx, db, time.Now()); e != nil && ctx.Err() == nil {
					slog.Error("creator fund", "error", e)
				}
			}
			timer.Reset(time.Hour)
		}
	}
}

// runCreatorFund closes the month before now's, if it isn't yet, and then sends payouts. A month
// that ended while the server was down for all of the next one isn't closed.
func runCreatorFund(ctx context.Context, db *pgxpool.Pool, now time.Time) error {
	month := monthStart(now).AddDate(0, -1, 0)
	closed, e := closeFundMonth(ctx, db, month)
	if e != nil {
		return e
	}
	if closed {
		slog.Info("creator fund month closed", "month", month.Format("2006-01"))
	}
	_, e = runPayouts(ctx, db)
	return e
}

// runPayouts sends every creator whose payouts are on, who isn't held or suspended, whose first
// payout is due (firstPayoutSQL), and whose unpaid earnings reach payoutMinimumCents, one transfer
// of all of it. One replica runs at a time. A creator whose transfer failed waits a day before the
// next try. It reports how many payouts were paid.
func runPayouts(ctx context.Context, db *pgxpool.Pool) (int, error) {
	conn, e := db.Acquire(ctx)
	if e != nil {
		return 0, e
	}
	defer conn.Release()
	var locked bool
	if e = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(7182321)`).Scan(&locked); e != nil || !locked {
		return 0, e
	}
	defer func() {
		if _, e := conn.Exec(context.Background(), `SELECT pg_advisory_unlock(7182321)`); e != nil {
			conn.Conn().Close(context.Background())
		}
	}()
	// First, payouts an earlier run left on their way: Stripe didn't confirm the transfer, or the
	// run stopped before recording the answer. Ten minutes on, Stripe has made it or never will.
	stuck, e := collectIDs(ctx, conn, `SELECT id FROM creator_payouts WHERE status='sending' AND updated_at<now()-interval '10 minutes' ORDER BY updated_at`)
	if e != nil {
		return 0, e
	}
	paid := 0
	for _, id := range stuck {
		ok, e := resolvePayout(ctx, conn, id)
		if e != nil {
			return paid, e
		}
		paid += ok
	}
	due, e := collectIDs(ctx, conn, `SELECT a.user_id FROM creator_accounts a JOIN users u ON u.id=a.user_id AND u.suspended_at IS NULL
 JOIN creator_earnings e ON e.creator_id=a.user_id AND e.status='pending' AND e.payout_id IS NULL
 WHERE a.payouts_enabled AND a.held_at IS NULL AND a.stripe_account_id IS NOT NULL AND `+firstPayoutSQL("a.user_id")+`<=now()
 AND NOT EXISTS(SELECT 1 FROM creator_payouts p WHERE p.creator_id=a.user_id AND (p.status='sending' OR (p.status='failed' AND p.created_at>now()-interval '1 day')))
 GROUP BY a.user_id HAVING sum(e.amount_cents)>=$1 ORDER BY a.user_id`, payoutMinimumCents)
	if e != nil {
		return paid, e
	}
	for _, creator := range due {
		ok, e := payCreator(ctx, conn, creator)
		if e != nil {
			return paid, e
		}
		paid += ok
	}
	return paid, nil
}

func collectIDs(ctx context.Context, q engagementDB, sql string, args ...any) ([]string, error) {
	rows, e := q.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// payCreator records a payout of the creator's unpaid earnings, linked to them, and then asks
// Stripe for the transfer. It reports 1 when the transfer was made.
func payCreator(ctx context.Context, conn *pgxpool.Conn, creator string) (int, error) {
	id := uuid.NewString()
	var account string
	var amount int64
	e := pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		if e := tx.QueryRow(ctx, `SELECT stripe_account_id FROM creator_accounts WHERE user_id=$1 AND payouts_enabled AND held_at IS NULL FOR UPDATE`, creator).Scan(&account); e != nil {
			return e
		}
		// The months are locked and named, so the payout links exactly the rows its amount adds up,
		// even if another month closes meanwhile.
		var months []string
		if e := tx.QueryRow(ctx, `WITH due AS (SELECT month,amount_cents FROM creator_earnings WHERE creator_id=$1 AND status='pending' AND payout_id IS NULL FOR UPDATE)
 SELECT COALESCE(sum(amount_cents),0)::bigint,COALESCE(array_agg(month::text),'{}') FROM due`, creator).Scan(&amount, &months); e != nil {
			return e
		}
		if amount < payoutMinimumCents {
			return pgx.ErrNoRows
		}
		if _, e := tx.Exec(ctx, `INSERT INTO creator_payouts(id,creator_id,stripe_account_id,amount_cents) VALUES($1,$2,$3,$4)`, id, creator, account, amount); e != nil {
			return e
		}
		_, e := tx.Exec(ctx, `UPDATE creator_earnings SET payout_id=$2 WHERE creator_id=$1 AND month=ANY($3::date[])`, creator, id, months)
		return e
	})
	if errors.Is(e, pgx.ErrNoRows) {
		// Held, switched off or paid meanwhile: nothing to send.
		return 0, nil
	}
	if e != nil {
		return 0, e
	}
	var transfer struct{ ID string }
	form := url.Values{"amount": {strconv.FormatInt(amount, 10)}, "currency": {"usd"}, "destination": {account},
		"transfer_group": {id}, "description": {"Savorly creator fund"}, "metadata[user_id]": {creator}, "metadata[payout_id]": {id}}
	if e := stripeCall(ctx, "POST", "/transfers", "creator-payout-"+id, form, &transfer); e != nil || transfer.ID == "" {
		// A transfer whose answer was lost, or came after the client gave up, may still be made, so
		// the payout stays on its way until a later run asks Stripe (resolvePayout) rather than
		// sending it again.
		slog.Warn("creator payout not confirmed", "payout", id, "error", e)
		return 0, nil
	}
	return 1, settlePayout(ctx, conn, id, transfer.ID)
}

// resolvePayout asks Stripe whether a payout's transfer exists (by its transfer group) and records
// the answer: paid, or failed, which leaves the earnings unpaid for a later payout. If Stripe
// can't be asked, the payout stays on its way for the next run.
func resolvePayout(ctx context.Context, conn *pgxpool.Conn, id string) (int, error) {
	var found struct{ Data []struct{ ID string } }
	if e := stripeCall(ctx, "GET", "/transfers?limit=1&transfer_group="+url.QueryEscape(id), "", nil, &found); e != nil {
		slog.Warn("creator payout left to check", "payout", id, "error", e)
		return 0, nil
	}
	if len(found.Data) > 0 && found.Data[0].ID != "" {
		return 1, settlePayout(ctx, conn, id, found.Data[0].ID)
	}
	slog.Warn("creator payout failed", "payout", id)
	return 0, pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, `UPDATE creator_payouts SET status='failed',error='Stripe didn''t make the transfer.',updated_at=now() WHERE id=$1 AND status='sending'`, id); e != nil {
			return e
		}
		_, e := tx.Exec(ctx, `UPDATE creator_earnings SET payout_id=NULL WHERE payout_id=$1 AND status='pending'`, id)
		return e
	})
}

func settlePayout(ctx context.Context, conn *pgxpool.Conn, id, transfer string) error {
	return pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, `UPDATE creator_payouts SET status='paid',transfer_id=$2,error='',updated_at=now() WHERE id=$1 AND status='sending'`, id, transfer); e != nil {
			return e
		}
		_, e := tx.Exec(ctx, `UPDATE creator_earnings SET status='paid',paid_at=now() WHERE payout_id=$1`, id)
		return e
	})
}

// payoutAccountSQL is the member's ($1) payout setup, the same shape with or without an account.
const payoutAccountSQL = `(SELECT jsonb_build_object('connected',a.stripe_account_id IS NOT NULL,'enabled',COALESCE(a.payouts_enabled,false),
 'detailsSubmitted',COALESCE(a.details_submitted,false),'held',a.held_at IS NOT NULL,'country',COALESCE(a.country,''))
 FROM (SELECT $1::text AS id) m LEFT JOIN creator_accounts a ON a.user_id=m.id)`

// myEarnings is a creator's side of the fund: this month's verified cooks of their recipes and
// the estimate the same rule gives so far, what's unpaid and paid, each closed month, when their
// first payout may go while it's still ahead (firstPayoutAt), and their payout setup. ?refresh=true re-reads the payout account from Stripe first, for an app coming
// back from onboarding before the webhook arrives.
func (a *App) myEarnings(c fiber.Ctx) error {
	if !creatorFundEnabled() {
		return fiber.NewError(404, fundUnavailable)
	}
	ctx, me := c.Context(), userID(c)
	if c.Query("refresh") == "true" {
		var account *string
		if e := a.DB.QueryRow(ctx, `SELECT stripe_account_id FROM creator_accounts WHERE user_id=$1`, me).Scan(&account); e == nil && account != nil {
			if _, e = a.syncConnectAccount(ctx, *account); e != nil {
				slog.Warn("refresh a payout account", "error", e)
			}
		}
	}
	from := monthStart(time.Now())
	to := from.AddDate(0, 1, 0)
	rows, e := fundCooks(ctx, a.DB, from, to, me)
	if e != nil {
		return e
	}
	shares, _, _, _ := splitFund(rows, fundShareBP())
	estimate := 0
	if s := shares[me]; s != nil {
		estimate = s.cents
	}
	var b []byte
	e = a.DB.QueryRow(ctx, `SELECT jsonb_build_object(
 'cooks',(SELECT count(*) FROM cook_sessions k JOIN recipes r ON r.id=k.recipe_id WHERE r.author_id=$1 AND k.verified AND k.user_id<>$1 AND k.finished_at>=$2 AND k.finished_at<$3),
 'balanceCents',(SELECT COALESCE(sum(amount_cents),0) FROM creator_earnings WHERE creator_id=$1 AND status='pending'),
 'paidCents',(SELECT COALESCE(sum(amount_cents),0) FROM creator_earnings WHERE creator_id=$1 AND status='paid'),
 'firstPayoutAt',(SELECT t FROM (SELECT `+firstPayoutSQL("$1")+` AS t) w WHERE t>now()),
 'history',COALESCE((SELECT jsonb_agg(jsonb_build_object('month',e.month,'amountCents',e.amount_cents,'cooks',e.cooks,'status',e.status,'paidAt',e.paid_at) ORDER BY e.month DESC)
   FROM (SELECT * FROM creator_earnings WHERE creator_id=$1 ORDER BY month DESC LIMIT 24) e),'[]'),
 'payouts',`+payoutAccountSQL+`)`, me, from, to).Scan(&b)
	if e != nil {
		return e
	}
	var out map[string]any
	if e = json.Unmarshal(b, &out); e != nil {
		return e
	}
	out["month"] = from.Format(time.DateOnly)
	out["estimateCents"] = estimate
	out["sharePercent"] = float64(fundShareBP()) / 100
	out["minimumCents"] = payoutMinimumCents
	out["countries"] = payoutCountries
	return c.JSON(out)
}

// payoutOnboarding answers { url, kind } for the web: Stripe's Express onboarding (kind
// "onboarding"), creating the creator's account the first time in the country they name, or once
// they've finished it, their Express dashboard ("dashboard"). Setting up payouts isn't a purchase,
// so every platform may open it.
func (a *App) payoutOnboarding(c fiber.Ctx) error {
	if !creatorFundEnabled() {
		return fiber.NewError(503, fundUnavailable)
	}
	var in struct{ Country string }
	if len(c.Body()) > 0 {
		if e := decode(c, &in); e != nil {
			return e
		}
	}
	ctx, me := c.Context(), userID(c)
	var email string
	var account *string
	var creator bool
	if e := a.DB.QueryRow(ctx, `SELECT u.email,a.stripe_account_id,EXISTS(SELECT 1 FROM recipes WHERE author_id=u.id AND published) OR EXISTS(SELECT 1 FROM creator_earnings WHERE creator_id=u.id)
 FROM users u LEFT JOIN creator_accounts a ON a.user_id=u.id WHERE u.id=$1`, me).Scan(&email, &account, &creator); e != nil {
		return e
	}
	if !creator {
		return fiber.NewError(403, "Share a recipe first: payouts are for cooks whose recipes others make.")
	}
	if account == nil {
		country := strings.ToUpper(strings.TrimSpace(in.Country))
		if country == "" {
			return fiber.NewError(400, "Choose the country where you'll receive payouts.")
		}
		if !slices.Contains(payoutCountries, country) {
			return fiber.NewError(422, "Stripe can't send payouts to your country yet, so payouts aren't available there.")
		}
		form := url.Values{"type": {"express"}, "country": {country}, "email": {email}, "business_type": {"individual"},
			"capabilities[transfers][requested]": {"true"}, "metadata[user_id]": {me}}
		// Outside the platform's country, accounts only receive transfers (Stripe's cross-border payouts).
		if country != "US" {
			form.Set("tos_acceptance[service_agreement]", "recipient")
		}
		var created struct{ ID string }
		if e := stripeCall(ctx, "POST", "/accounts", "connect-account-"+me+"-"+country, form, &created); e != nil {
			return e
		}
		// A hold can make the row before any account; two requests at once keep the first account.
		if e := a.DB.QueryRow(ctx, `INSERT INTO creator_accounts(user_id,stripe_account_id,country) VALUES($1,$2,$3)
 ON CONFLICT (user_id) DO UPDATE SET stripe_account_id=COALESCE(creator_accounts.stripe_account_id,excluded.stripe_account_id),
  country=CASE WHEN creator_accounts.stripe_account_id IS NULL THEN excluded.country ELSE creator_accounts.country END,updated_at=now()
 RETURNING stripe_account_id`, me, created.ID, country).Scan(&account); e != nil {
			return e
		}
	}
	state, e := a.syncConnectAccount(ctx, *account)
	if e != nil {
		return e
	}
	var link struct{ URL string }
	if state.DetailsSubmitted {
		if e = stripeCall(ctx, "POST", "/accounts/"+url.PathEscape(*account)+"/login_links", "", url.Values{}, &link); e != nil {
			return e
		}
		return c.JSON(fiber.Map{"url": link.URL, "kind": "dashboard"})
	}
	back := appURL(a.Config) + "/?page=profile&payouts="
	if e = stripeCall(ctx, "POST", "/account_links", "", url.Values{"account": {*account}, "type": {"account_onboarding"},
		"refresh_url": {back + "refresh"}, "return_url": {back + "done"}}, &link); e != nil {
		return e
	}
	return c.JSON(fiber.Map{"url": link.URL, "kind": "onboarding"})
}

type connectAccount struct {
	ID               string
	PayoutsEnabled   bool `json:"payouts_enabled"`
	DetailsSubmitted bool `json:"details_submitted"`
	Capabilities     struct{ Transfers string }
}

// syncConnectAccount re-reads an account from Stripe and records whether it can be paid: Stripe
// accepts transfers to it and pays them out to the creator's bank.
func (a *App) syncConnectAccount(ctx context.Context, id string) (connectAccount, error) {
	var acct connectAccount
	if e := stripeCall(ctx, "GET", "/accounts/"+url.PathEscape(id), "", nil, &acct); e != nil {
		return acct, e
	}
	_, e := a.DB.Exec(ctx, `UPDATE creator_accounts SET payouts_enabled=$2,details_submitted=$3,updated_at=now() WHERE stripe_account_id=$1`,
		id, acct.PayoutsEnabled && acct.Capabilities.Transfers == "active", acct.DetailsSubmitted)
	return acct, e
}

// connectWebhook takes Stripe's events about connected accounts, from a Connect webhook
// destination with its own signing secret (STRIPE_CONNECT_WEBHOOK_SECRET). Like the billing
// webhook, it trusts only the signature and the account id, and re-reads the account, so retries
// and out-of-order deliveries converge on Stripe's state.
func (a *App) connectWebhook(c fiber.Ctx) error {
	secret := os.Getenv("STRIPE_CONNECT_WEBHOOK_SECRET")
	if !creatorFundEnabled() || secret == "" {
		return fiber.NewError(404, fundUnavailable)
	}
	if !validStripeSignature(c.Body(), c.Get("Stripe-Signature"), secret, time.Now()) {
		return fiber.NewError(400, "Invalid signature.")
	}
	var ev struct {
		Type    string
		Account string
		Data    struct{ Object struct{ ID string } }
	}
	if e := json.Unmarshal(c.Body(), &ev); e != nil {
		return fiber.NewError(400, "Invalid event.")
	}
	if ev.Type == "account.updated" {
		id := ev.Data.Object.ID
		if id == "" {
			id = ev.Account
		}
		var known bool
		if e := a.DB.QueryRow(c.Context(), `SELECT EXISTS(SELECT 1 FROM creator_accounts WHERE stripe_account_id=$1)`, id).Scan(&known); e != nil {
			return e
		}
		// Accounts that aren't ours here (another environment's) are acknowledged and left alone.
		if known {
			if _, e := a.syncConnectAccount(c.Context(), id); e != nil {
				return e
			}
		}
	}
	return c.SendStatus(200)
}
