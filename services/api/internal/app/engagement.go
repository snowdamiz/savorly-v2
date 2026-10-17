package app

import (
	"context"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// engagementRoutes are households (household.go), preferences (preferences.go), push tokens
// (push.go) and first-party analytics (events.go). The admin's insights live with the other
// admin routes.
func (a *App) engagementRoutes(v fiber.Router) {
	v.Get("/household", a.requireAuth, a.household)
	v.Post("/household", a.requireAuth, a.createHousehold)
	v.Post("/household/invite", a.requireAuth, perUser(30, time.Hour), a.createInvite)
	// Codes are guessed one try at a time, so tries are few per member and per address.
	v.Post("/household/join", a.requireAuth, perUser(10, time.Hour), rateLimit(30, time.Hour), a.joinHousehold)
	v.Delete("/household/members/:userId", a.requireAuth, a.removeHouseholdMember)
	v.Patch("/me/preferences", a.requireAuth, a.updatePreferences)
	v.Put("/me/push-token", a.requireAuth, a.savePushToken)
	v.Delete("/me/push-token", a.requireAuth, a.deletePushToken)
	v.Post("/events", rateLimit(120, time.Minute), a.recordEvents)
}

// engagementDB is a pool, a transaction or one pooled connection.
type engagementDB interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}
