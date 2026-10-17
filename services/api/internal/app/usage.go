package app

import (
	"context"
	"errors"
	"math"

	"github.com/jackc/pgx/v5"
)

// The ai_usage ledger (027_ai_usage.sql) records the small AI calls that have no table of their
// own: a recipe's translation and a hands-free cooking question. A row is written as the call's
// reservation, inside the transaction that took reserveGeneration (or reserveShared) and its
// lock, so a concurrent request sees it; settleUsage lowers it to what the provider reported.

// usageWriter is a transaction or the pool.
type usageWriter interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

// recordUsage reserves estimate for kind, against owner ("" for a call no member pays for).
func recordUsage(ctx context.Context, q usageWriter, owner, kind string, estimate float64) (int64, error) {
	var id int64
	e := q.QueryRow(ctx, `INSERT INTO ai_usage(user_id,kind,estimated_cost) VALUES(NULLIF($1,''),$2,$3) RETURNING id`, owner, kind, estimate).Scan(&id)
	return id, e
}

// settleUsage records the provider's cost for a reserved call. A cost that is unknown (zero or
// negative) or higher than the reservation leaves the reservation, so spend never undercounts.
func settleUsage(ctx context.Context, q usageWriter, id int64, cost float64) error {
	if cost <= 0 || math.IsNaN(cost) || math.IsInf(cost, 0) {
		return nil
	}
	var kept float64
	e := q.QueryRow(ctx, `UPDATE ai_usage SET estimated_cost=least(estimated_cost,$2) WHERE id=$1 RETURNING estimated_cost::float8`, id, cost).Scan(&kept)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil
	}
	return e
}

// releaseUsage drops a reservation for a call that never reached the provider.
func releaseUsage(ctx context.Context, q usageWriter, id int64) error {
	var gone int64
	e := q.QueryRow(ctx, `DELETE FROM ai_usage WHERE id=$1 RETURNING id`, id).Scan(&gone)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil
	}
	return e
}
