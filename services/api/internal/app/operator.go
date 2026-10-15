package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Owners run Savorly. They're admins once their email is proven, since registration alone
// proves nothing and anyone could otherwise register an owner's address first. Only owners
// appoint other admins. ADMIN_EMAILS replaces this list (comma separated).
const defaultOwners = "yurlovandrew@gmail.com"

func ownerEmails() []string {
	out := []string{}
	for _, e := range strings.Split(Env("ADMIN_EMAILS", defaultOwners), ",") {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			out = append(out, e)
		}
	}
	return out
}

// ownerSQL and adminSQL describe a users row aliased u. $owners holds ownerEmails() and
// $prod whether owners must have proven their email (always, outside local development).
func ownerSQL(owners, prod int) string {
	return fmt.Sprintf(`(u.email=ANY($%d::text[]) AND (u.email_verified OR NOT $%d::boolean))`, owners, prod)
}
func adminSQL(owners, prod int) string {
	return `(u.admin OR ` + ownerSQL(owners, prod) + `)`
}

// Settings are the operator's overrides from the admin console. Budgets left unset follow
// the environment.
type Settings struct {
	AIPaused             bool     `json:"aiPaused"`
	AIDailyBudgetUSD     *float64 `json:"aiDailyBudgetUSD"`
	AIFreeDailyBudgetUSD *float64 `json:"aiFreeDailyBudgetUSD"`
	SignupsPaused        bool     `json:"signupsPaused"`
	Announcement         string   `json:"announcement"`
	AnnouncementTone     string   `json:"announcementTone"` // "info" or "warning"
}

const (
	aiPausedMessage      = "AI features are paused for maintenance. Your conversation and drafts are saved; please try again later."
	signupsPausedMessage = "New sign-ups are paused right now. Please try again later."
	suspendedMessage     = "This account is suspended. Contact Savorly support if you think this is a mistake."
)

func loadSettings(ctx context.Context, q querier) (Settings, error) {
	var s Settings
	var raw []byte
	e := q.QueryRow(ctx, `SELECT value FROM app_settings WHERE key='operator'`).Scan(&raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return s, nil
	}
	if e != nil {
		return s, e
	}
	return s, json.Unmarshal(raw, &s)
}

func (s Settings) dailyBudget() float64 {
	if s.AIDailyBudgetUSD != nil {
		return *s.AIDailyBudgetUSD
	}
	return envFloat("AI_DAILY_BUDGET_USD", 25)
}
func (s Settings) freeDailyBudget() float64 {
	if s.AIFreeDailyBudgetUSD != nil {
		return *s.AIFreeDailyBudgetUSD
	}
	return envFloat("AI_FREE_DAILY_BUDGET_USD", 5)
}
