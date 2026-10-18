package app

import (
	"context"
	"crypto/rand"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Households share one kitchen: the grocery list, the meal plan and the pantry. A member is in
// at most one; while they are, /kitchen and every grocery, planner and pantry route work on the
// household's, whose rows say who added them. Starting or joining a household moves the
// member's own kitchen into it (where the household already has a plan for a day's meal, or an
// item of the same name, the household's stays). A member who leaves (or is removed) starts a
// new kitchen of their own, except the last one out, who takes the kitchen back. The ownership
// hand-off and the dissolution are a trigger (021_engagement.sql), so deleting an account
// follows the same rules.

const (
	householdSize  = 20
	inviteLifetime = 7 * 24 * time.Hour
	inviteAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789"
	inviteLength   = 8
	// Live codes per household; making another retires the oldest beyond this.
	invitesKept = 10
)

const (
	householdNameRule  = "Give your household a name (up to 60 characters)."
	alreadyInHousehold = "You're already in a household. Leave it to start or join another."
	notInHousehold     = "You're not in a household."
	inviteInvalid      = "That invite code is invalid or has expired. Ask for a new one."
	householdFull      = "This household is full."
	notInYourHousehold = "That person isn't in your household."
	ownerRemoves       = "Only the household's owner can remove other members."
)

// kitchenScope is the condition for the rows of a shared kitchen table (grocery lines, plans,
// pantry items; alias a) that member $n sees: their household's while they are in one, and
// their own otherwise.
func kitchenScope(a string, n int) string {
	p := "$" + strconv.Itoa(n)
	return `(` + a + `.household_id=(SELECT household_id FROM household_members WHERE user_id=` + p + `) OR (` + a + `.household_id IS NULL AND ` + a + `.user_id=` + p +
		` AND NOT EXISTS(SELECT 1 FROM household_members WHERE user_id=` + p + `)))`
}

// groceryScope is kitchenScope for grocery lines (alias g).
func groceryScope(n int) string { return kitchenScope("g", n) }

// lockList serializes changes to one grocery list until tx ends: a member's own (key: their
// id) or a household's (householdKey). Take a member's lock before their household's.
func lockList(ctx context.Context, tx pgx.Tx, key string) error {
	_, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,7182304))`, key)
	return e
}

func householdKey(id string) string { return "household:" + id }

// householdOf is the member's household and role, or "" for none.
func householdOf(ctx context.Context, q engagementDB, user string) (id, role string, err error) {
	err = q.QueryRow(ctx, `SELECT household_id,role FROM household_members WHERE user_id=$1`, user).Scan(&id, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", nil
	}
	return id, role, err
}

// householdJSON is GET /household's answer for user, or nil when they have no household.
func householdJSON(ctx context.Context, q engagementDB, user string) ([]byte, error) {
	var b []byte
	e := q.QueryRow(ctx, `SELECT jsonb_build_object('id',h.id,'name',h.name,'role',me.role,
 'members',(SELECT jsonb_agg(jsonb_build_object('id',u.id,'name',u.name,'handle',u.handle,'avatar',u.avatar,'role',m.role) ORDER BY m.role='owner' DESC,m.joined_at,m.user_id)
  FROM household_members m JOIN users u ON u.id=m.user_id WHERE m.household_id=h.id))
 FROM household_members me JOIN households h ON h.id=me.household_id WHERE me.user_id=$1`, user).Scan(&b)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	return b, e
}

func sendHousehold(c fiber.Ctx, b []byte) error {
	if b == nil {
		b = []byte("null")
	}
	c.Set("Content-Type", "application/json")
	return c.Send(b)
}

func (a *App) household(c fiber.Ctx) error {
	b, e := householdJSON(c.Context(), a.DB, userID(c))
	if e != nil {
		return e
	}
	return sendHousehold(c, b)
}

// moveKitchenIn puts the member's own kitchen in their household's: every grocery line, and the
// plans and pantry items the household doesn't already have a plan or an item of that name for
// (those of the member's go).
func moveKitchenIn(ctx context.Context, tx pgx.Tx, user, household string) error {
	return execAll(ctx, tx, []string{
		`UPDATE groceries SET household_id=$2 WHERE user_id=$1 AND household_id IS NULL`,
		`DELETE FROM meal_plans m WHERE m.user_id=$1 AND m.household_id IS NULL AND EXISTS (SELECT 1 FROM meal_plans h WHERE h.household_id=$2 AND h.day=m.day AND h.meal=m.meal)`,
		`UPDATE meal_plans SET household_id=$2 WHERE user_id=$1 AND household_id IS NULL`,
		`DELETE FROM pantry p WHERE p.user_id=$1 AND p.household_id IS NULL AND EXISTS (SELECT 1 FROM pantry h WHERE h.household_id=$2 AND h.name=p.name)`,
		`UPDATE pantry SET household_id=$2 WHERE user_id=$1 AND household_id IS NULL`,
	}, user, household)
}

// takeKitchenBack gives a household's kitchen to its last member as their own.
func takeKitchenBack(ctx context.Context, tx pgx.Tx, household, user string) error {
	return execAll(ctx, tx, []string{
		`UPDATE groceries SET household_id=NULL,user_id=$2 WHERE household_id=$1`,
		`UPDATE meal_plans SET household_id=NULL,user_id=$2 WHERE household_id=$1`,
		`UPDATE pantry SET household_id=NULL,user_id=$2 WHERE household_id=$1`,
	}, household, user)
}

// execAll runs each statement with the same arguments, in order.
func execAll(ctx context.Context, tx pgx.Tx, statements []string, args ...any) error {
	for _, sql := range statements {
		if _, e := tx.Exec(ctx, sql, args...); e != nil {
			return e
		}
	}
	return nil
}

func (a *App) createHousehold(c fiber.Ctx) error {
	var in struct{ Name string }
	if e := decode(c, &in); e != nil {
		return e
	}
	if !validText(in.Name, 1, 60) {
		return fiber.NewError(400, householdNameRule)
	}
	ctx, me, id := c.Context(), userID(c), uuid.NewString()
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if e = lockList(ctx, tx, me); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `INSERT INTO households(id,name) VALUES($1,$2)`, id, strings.TrimSpace(in.Name)); e != nil {
		return e
	}
	r, e := tx.Exec(ctx, `INSERT INTO household_members(user_id,household_id,role) VALUES($1,$2,'owner') ON CONFLICT (user_id) DO NOTHING`, me, id)
	if e != nil {
		return e
	}
	if r.RowsAffected() == 0 {
		return fiber.NewError(409, alreadyInHousehold)
	}
	if e = moveKitchenIn(ctx, tx, me, id); e != nil {
		return e
	}
	b, e := householdJSON(ctx, tx, me)
	if e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	c.Status(201)
	return sendHousehold(c, b)
}

// newInviteCode is inviteLength characters from inviteAlphabet, uniformly random.
func newInviteCode() (string, error) {
	out := make([]byte, 0, inviteLength)
	buf := make([]byte, 32)
	// The largest multiple of the alphabet's size below 256; bytes above it would skew the draw.
	limit := byte(256 - 256%len(inviteAlphabet))
	for len(out) < inviteLength {
		if _, e := rand.Read(buf); e != nil {
			return "", e
		}
		for _, b := range buf {
			if b < limit && len(out) < inviteLength {
				out = append(out, inviteAlphabet[int(b)%len(inviteAlphabet)])
			}
		}
	}
	return string(out), nil
}

// normalizeInviteCode accepts a code as people type it: any case, with spaces or dashes.
func normalizeInviteCode(s string) (string, bool) {
	s = strings.ToUpper(strings.NewReplacer(" ", "", "-", "", "\t", "").Replace(strings.TrimSpace(s)))
	if len(s) != inviteLength {
		return "", false
	}
	for _, r := range s {
		if !strings.ContainsRune(inviteAlphabet, r) {
			return "", false
		}
	}
	return s, true
}

// createInvite makes a code that lets anyone who has it join, for seven days. Any member can.
func (a *App) createInvite(c fiber.Ctx) error {
	code, e := newInviteCode()
	if e != nil {
		return e
	}
	ctx, me := c.Context(), userID(c)
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var household string
	var expires time.Time
	e = tx.QueryRow(ctx, `INSERT INTO household_invites(code_hash,household_id,expires_at) SELECT $1,household_id,now()+$3*interval '1 second' FROM household_members WHERE user_id=$2
 RETURNING household_id,expires_at`, hashToken(code), me, seconds(inviteLifetime)).Scan(&household, &expires)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, notInHousehold)
	}
	if e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `DELETE FROM household_invites WHERE household_id=$1 AND (expires_at<=now() OR code_hash IN (
 SELECT code_hash FROM household_invites WHERE household_id=$1 ORDER BY created_at DESC,code_hash OFFSET $2))`, household, invitesKept); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return c.JSON(fiber.Map{"code": code, "expiresAt": expires.UTC().Format(time.RFC3339)})
}

func (a *App) joinHousehold(c fiber.Ctx) error {
	var in struct{ Code string }
	if e := decode(c, &in); e != nil {
		return e
	}
	code, ok := normalizeInviteCode(in.Code)
	if !ok {
		return fiber.NewError(400, inviteInvalid)
	}
	ctx, me := c.Context(), userID(c)
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if e = lockList(ctx, tx, me); e != nil {
		return e
	}
	current, _, e := householdOf(ctx, tx, me)
	if e != nil {
		return e
	}
	if current != "" {
		return fiber.NewError(409, alreadyInHousehold)
	}
	var household string
	e = tx.QueryRow(ctx, `SELECT household_id FROM household_invites WHERE code_hash=$1 AND expires_at>now()`, hashToken(code)).Scan(&household)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(400, inviteInvalid)
	}
	if e != nil {
		return e
	}
	if e = lockList(ctx, tx, householdKey(household)); e != nil {
		return e
	}
	// Membership changes queue on the household's row, which also says it still exists.
	var members int
	e = tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM household_members WHERE household_id=h.id) FROM households h WHERE h.id=$1 FOR UPDATE`, household).Scan(&members)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(400, inviteInvalid)
	}
	if e != nil {
		return e
	}
	if members >= householdSize {
		return fiber.NewError(409, householdFull)
	}
	if _, e = tx.Exec(ctx, `INSERT INTO household_members(user_id,household_id) VALUES($1,$2)`, me, household); e != nil {
		return e
	}
	if e = moveKitchenIn(ctx, tx, me, household); e != nil {
		return e
	}
	b, e := householdJSON(ctx, tx, me)
	if e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return sendHousehold(c, b)
}

// removeHouseholdMember lets a member leave (their own id) and the owner remove anyone.
func (a *App) removeHouseholdMember(c fiber.Ctx) error {
	ctx, me, target := c.Context(), userID(c), c.Params("userId")
	household, _, e := householdOf(ctx, a.DB, me)
	if e != nil {
		return e
	}
	if household == "" {
		return fiber.NewError(404, notInHousehold)
	}
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if e = lockList(ctx, tx, target); e != nil {
		return e
	}
	if e = lockList(ctx, tx, householdKey(household)); e != nil {
		return e
	}
	// Under the household's lock, both memberships and the owner are as they are now.
	var mine, theirs string
	var members int
	e = tx.QueryRow(ctx, `SELECT COALESCE((SELECT role FROM household_members WHERE user_id=$2 AND household_id=h.id),''),
 COALESCE((SELECT role FROM household_members WHERE user_id=$3 AND household_id=h.id),''),
 (SELECT count(*) FROM household_members WHERE household_id=h.id) FROM households h WHERE h.id=$1 FOR UPDATE`, household, me, target).Scan(&mine, &theirs, &members)
	if errors.Is(e, pgx.ErrNoRows) || (e == nil && mine == "") {
		return fiber.NewError(404, notInHousehold)
	}
	if e != nil {
		return e
	}
	if theirs == "" {
		return fiber.NewError(404, notInYourHousehold)
	}
	if target != me && mine != "owner" {
		return fiber.NewError(403, ownerRemoves)
	}
	if members == 1 {
		// The last one out keeps the kitchen as their own.
		if e = takeKitchenBack(ctx, tx, household, target); e != nil {
			return e
		}
	}
	if _, e = tx.Exec(ctx, `DELETE FROM household_members WHERE user_id=$1`, target); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return c.SendStatus(204)
}
