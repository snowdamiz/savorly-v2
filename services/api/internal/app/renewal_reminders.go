package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// A week before a yearly plan renews, its member hears when, for how much, and how to cancel in
// two taps: by email (an account email, like the others in notifications.go) and on their phones,
// unless they turned renewal reminders off (notifications_outbox.go). Each renewal is reminded once: a renewal_reminders row is claimed
// before anything goes out, so restarts and replicas never repeat one. docs/PRICING.md has the rule.

// renewalDueSQL picks yearly plans (users alias u) that renew within the week and haven't been
// reminded of this renewal. Plans set to end, suspended members (whose payments are paused) and
// complimentary plans (no subscription) are left alone.
const renewalDueSQL = `u.plan_interval='yearly' AND u.plan_status IN ('active','trialing') AND NOT u.plan_cancels AND u.stripe_subscription_id<>''
 AND u.suspended_at IS NULL AND u.plan_renews_at>now() AND u.plan_renews_at<=now()+interval '7 days'
 AND NOT EXISTS(SELECT 1 FROM renewal_reminders r WHERE r.subscription_id=u.stripe_subscription_id AND r.renews_at=u.plan_renews_at)`

// RunRenewalReminders sends renewal reminders: soon after start, since a container may sleep
// before an hour passes, then hourly. Nothing happens while billing is off.
func RunRenewalReminders(ctx context.Context, db *pgxpool.Pool) {
	timer := time.NewTimer(3 * time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if billingEnabled() {
				if n, e := remindRenewals(ctx, db); e != nil && ctx.Err() == nil {
					slog.Error("renewal reminders", "error", e)
				} else if n > 0 {
					slog.Info("renewal reminders sent", "members", n)
				}
			}
			timer.Reset(time.Hour)
		}
	}
}

// remindRenewals reminds every member whose renewal is due and reports how many it reminded. One
// replica runs at a time; one member's failure is logged and retried on the next run.
func remindRenewals(ctx context.Context, db *pgxpool.Pool) (int, error) {
	conn, e := db.Acquire(ctx)
	if e != nil {
		return 0, e
	}
	defer conn.Release()
	var locked bool
	if e = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(7182344)`).Scan(&locked); e != nil || !locked {
		return 0, e
	}
	defer func() {
		if _, e := conn.Exec(context.Background(), `SELECT pg_advisory_unlock(7182344)`); e != nil {
			conn.Conn().Close(context.Background())
		}
	}()
	due, e := collectIDs(ctx, conn, `SELECT u.id FROM users u WHERE `+renewalDueSQL+` ORDER BY u.plan_renews_at,u.id`)
	if e != nil {
		return 0, e
	}
	reminded := 0
	for _, member := range due {
		ok, e := remindRenewal(ctx, conn, member)
		if e != nil {
			if ctx.Err() != nil {
				return reminded, e
			}
			slog.Warn("renewal reminder", "user", member, "error", e)
			continue
		}
		if ok {
			reminded++
		}
	}
	return reminded, nil
}

// renewal is what a reminder says: the plan, when it renews, and what it will cost.
type renewal struct {
	Plan        string    `json:"plan"`
	RenewsAt    time.Time `json:"renewsAt"`
	AmountCents int64     `json:"amountCents"`
	Currency    string    `json:"currency"`
}

// remindRenewal reminds one member of their renewal, unless it's no longer due, and reports
// whether it did. Stripe has the last word: the subscription is read again first, so a
// cancellation or a renewal whose webhook hasn't arrived sends nothing.
func remindRenewal(ctx context.Context, conn *pgxpool.Conn, member string) (bool, error) {
	var sub string
	if e := conn.QueryRow(ctx, `SELECT stripe_subscription_id FROM users WHERE id=$1`, member).Scan(&sub); e != nil {
		return false, e
	}
	s, e := fetchSubscription(ctx, sub)
	if e != nil {
		return false, e
	}
	if e = recordSubscription(ctx, conn, s); e != nil {
		return false, e
	}
	var email, language string
	r := renewal{Currency: "usd"}
	e = conn.QueryRow(ctx, `SELECT u.email,COALESCE(u.preferences->>'language',''),u.plan,u.plan_renews_at FROM users u WHERE u.id=$1 AND `+renewalDueSQL, member).
		Scan(&email, &language, &r.Plan, &r.RenewsAt)
	if errors.Is(e, pgx.ErrNoRows) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	r.AmountCents, r.Currency = renewalAmount(ctx, sub, r.Plan)
	claimed := false
	e = pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, `INSERT INTO renewal_reminders(subscription_id,renews_at,user_id,plan,amount_cents,currency) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
			sub, r.RenewsAt, member, r.Plan, r.AmountCents, r.Currency)
		if e != nil || tag.RowsAffected() == 0 {
			return e
		}
		claimed = true
		// The sender turns it into a notification on each of the member's phones, if they have any.
		_, e = tx.Exec(ctx, `INSERT INTO notification_outbox(kind,recipient_id,detail) VALUES('renewal',$1,$2)`, member, jsonBytes(r))
		return e
	})
	if e != nil || !claimed {
		return false, e
	}
	// The email goes once, after the claim: one cut off on its way isn't sent again.
	outcome := "email isn't configured"
	if emailEnabled() {
		outcome = ""
		l := compose(letterRenewal, language, letterData{Plan: planTitle(r.Plan), Amount: formatMoney(r.AmountCents, r.Currency, "en"), When: r.RenewsAt})
		if e := sendEmail(ctx, email, l.Subject, l.Text); e != nil {
			outcome = truncate(e.Error(), 300)
			slog.Warn("renewal reminder email failed", "user", member, "error", e)
		}
	}
	if _, e = conn.Exec(context.WithoutCancel(ctx), `UPDATE renewal_reminders SET emailed_at=CASE WHEN $3='' THEN now() END,email_error=$3 WHERE subscription_id=$1 AND renews_at=$2`,
		sub, r.RenewsAt, outcome); e != nil {
		slog.Error("record a renewal reminder", "error", e)
	}
	return true, nil
}

// renewalAmount is what the renewal will charge: Stripe's preview of the subscription's next
// invoice (discounts and tax included), or the catalog's yearly price if Stripe can't say.
func renewalAmount(ctx context.Context, sub, plan string) (int64, string) {
	var preview struct {
		AmountDue int64 `json:"amount_due"`
		Currency  string
	}
	if e := stripeCall(ctx, "POST", "/invoices/create_preview", "", url.Values{"subscription": {sub}}, &preview); e == nil && preview.Currency != "" {
		return preview.AmountDue, preview.Currency
	}
	return int64(math.Round(planByID(plan).YearlyUSD * 100)), "usd"
}

// planTitle is a plan's name as members see it: Plus or Pro.
func planTitle(id string) string {
	if id == "" {
		return ""
	}
	return strings.ToUpper(id[:1]) + id[1:]
}

// formatMoney writes an amount the way language writes money: "$79.99" in English, Chinese and
// Japanese, "79,99 $" in the other European languages, "US$ 79,99" in Portuguese. Other
// currencies read "79.99 EUR".
func formatMoney(cents int64, currency, language string) string {
	number := strconv.FormatInt(cents/100, 10) + "." + strconv.FormatInt(100+cents%100, 10)[1:]
	comma := slices.Contains([]string{"fr", "de", "ru", "es", "it", "pt"}, language)
	if comma {
		number = strings.Replace(number, ".", ",", 1)
	}
	switch {
	case !strings.EqualFold(currency, "usd"):
		return number + " " + strings.ToUpper(currency)
	case language == "pt":
		return "US$ " + number
	case comma:
		return number + " $"
	}
	return "$" + number
}

// renewalTexts are the renewal notification in the app's nine languages: {plan} is Plus or Pro,
// {date} the day it renews (written with date, a Go layout) and {amount} what it will cost.
var renewalTexts = map[string]struct{ title, body, date string }{
	"en": {"Your {plan} plan renews on {date}", "{amount} for another year. To cancel, tap Cancel plan under Your plan in My kitchen, then confirm.", "2 January 2006"},
	"fr": {"Votre abonnement {plan} se renouvelle le {date}", "{amount} pour une année de plus. Pour résilier, touchez Résilier l’abonnement sous Votre abonnement dans Ma cuisine, puis confirmez.", "02/01/2006"},
	"de": {"Dein {plan}-Abo verlängert sich am {date}", "{amount} für ein weiteres Jahr. Zum Kündigen tippe in Meine Küche unter Dein Abo auf Abo kündigen und bestätige.", "02.01.2006"},
	"ru": {"Тариф {plan} продлится {date}", "{amount} за ещё один год. Чтобы отменить, нажмите «Отменить тариф» в разделе «Ваш тариф» на странице «Моя кухня» и подтвердите.", "02.01.2006"},
	"es": {"Tu plan {plan} se renueva el {date}", "{amount} por un año más. Para cancelarlo, toca Cancelar plan en Tu plan, dentro de Mi cocina, y confirma.", "02/01/2006"},
	"it": {"Il tuo piano {plan} si rinnova il {date}", "{amount} per un altro anno. Per annullarlo, tocca Annulla piano in Il tuo piano, nella sezione La mia cucina, e conferma.", "02/01/2006"},
	"pt": {"Seu plano {plan} será renovado em {date}", "{amount} por mais um ano. Para cancelar, toque em Cancelar plano em Seu plano, na Minha cozinha, e confirme.", "02/01/2006"},
	"zh": {"你的 {plan} 方案将于 {date} 续订", "续订一年需 {amount}。如需取消，请在“我的厨房”的“你的方案”中点按“取消方案”，然后确认。", "2006年1月2日"},
	"ja": {"{plan}プランは{date}に更新されます", "1年分で{amount}です。解約するには、マイキッチンの「ご利用のプラン」で「プランを解約」をタップして確定してください。", "2006年1月2日"},
}

// renewalNoticeText is a renewal notification's title and body in language (English when it
// isn't one of the nine), from the outbox row's detail.
func renewalNoticeText(language string, detail []byte) (title, body string) {
	var r renewal
	_ = json.Unmarshal(detail, &r)
	texts, ok := renewalTexts[language]
	if !ok {
		language, texts = "en", renewalTexts["en"]
	}
	rep := strings.NewReplacer("{plan}", planTitle(r.Plan), "{date}", r.RenewsAt.UTC().Format(texts.date), "{amount}", formatMoney(r.AmountCents, r.Currency, language))
	return rep.Replace(texts.title), rep.Replace(texts.body)
}
