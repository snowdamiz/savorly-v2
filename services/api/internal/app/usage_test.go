package app

import (
	"context"
	"testing"
)

func TestUsageLedgerCountsTowardSpend(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "cook")
	reserved, err := recordUsage(ctx, db, "cook", "translation", 0.02)
	if err != nil {
		t.Fatal(err)
	}
	shared, err := recordUsage(ctx, db, "", "translation", 0.03)
	if err != nil {
		t.Fatal(err)
	}
	spend := func(owner string) float64 {
		t.Helper()
		var cost float64
		if err := db.QueryRow(ctx, `SELECT COALESCE(sum(cost),0) FROM ai_spend WHERE user_id IS NOT DISTINCT FROM NULLIF($1,'')`, owner).Scan(&cost); err != nil {
			t.Fatal(err)
		}
		return cost
	}
	if got := spend("cook"); got != 0.02 {
		t.Fatalf("member spend %v, want the reservation", got)
	}
	if got := spend(""); got != 0.03 {
		t.Fatalf("shared spend %v, want the reservation", got)
	}
	// A higher or unknown cost keeps the reservation; a lower one replaces it.
	for _, cost := range []float64{0.5, 0, -1} {
		if err = settleUsage(ctx, db, reserved, cost); err != nil {
			t.Fatal(err)
		}
	}
	if got := spend("cook"); got != 0.02 {
		t.Fatalf("after unusable costs %v, want 0.02", got)
	}
	if err = settleUsage(ctx, db, reserved, 0.004); err != nil {
		t.Fatal(err)
	}
	if got := spend("cook"); got != 0.004 {
		t.Fatalf("settled spend %v, want 0.004", got)
	}
	if err = releaseUsage(ctx, db, shared); err != nil {
		t.Fatal(err)
	}
	if got := spend(""); got != 0 {
		t.Fatalf("released spend %v, want 0", got)
	}
	// Settling or releasing a row that is gone is not an error.
	if err = settleUsage(ctx, db, shared, 0.001); err != nil {
		t.Fatal(err)
	}
	if err = releaseUsage(ctx, db, shared); err != nil {
		t.Fatal(err)
	}
}

func TestSharedReservationsUseTheFreeBudget(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	t.Setenv("AI_FREE_DAILY_BUDGET_USD", "0.05")
	t.Setenv("AI_DAILY_BUDGET_USD", "1")
	reserve := func(estimate float64) error {
		t.Helper()
		tx, err := db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if err = reserveShared(ctx, tx, estimate); err != nil {
			return err
		}
		if _, err = recordUsage(ctx, tx, "", "translation", estimate); err != nil {
			t.Fatal(err)
		}
		return tx.Commit(ctx)
	}
	if err := reserve(0.03); err != nil {
		t.Fatal(err)
	}
	if err := reserve(0.03); err == nil {
		t.Fatal("a shared call past the free daily budget was reserved")
	}
	if err := reserve(0.02); err != nil {
		t.Fatalf("a call inside what is left was refused: %v", err)
	}
}
