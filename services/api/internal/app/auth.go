package app

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/crypto/bcrypt"
)

func hashToken(t string) string { h := sha256.Sum256([]byte(t)); return hex.EncodeToString(h[:]) }
func token(c fiber.Ctx) string  { t, _ := sessionToken(c); return t }
func userID(c fiber.Ctx) string { u, _ := c.Locals("userID").(string); return u }
func (a *App) requireAuth(c fiber.Ctx) error {
	id, err := a.authenticate(c)
	if err != nil {
		return err
	}
	if id == "" {
		return fiber.NewError(401, "Sign in to your kitchen to continue.")
	}
	c.Locals("userID", id)
	return c.Next()
}

// session signs the device in. `created` tells the app this is a brand-new kitchen, so it can offer
// to pick a username before anything else.
func (a *App) session(c fiber.Ctx, id string, created bool) error {
	// Every sign-in path ends here, after the credentials were checked.
	var suspended, others, known bool
	var email string
	ua := userAgent(c)
	// Sessions from before devices were recorded have no user agent; they could be this device.
	if e := a.DB.QueryRow(c.Context(), `SELECT u.suspended_at IS NOT NULL,u.email,
 EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=u.id AND s.expires_at>now()),
 EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=u.id AND s.expires_at>now() AND s.user_agent IN ($2,''))
 FROM users u WHERE u.id=$1`, id, ua).Scan(&suspended, &email, &others, &known); e != nil {
		return e
	}
	if suspended {
		return fiber.NewError(403, suspendedMessage)
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	t := hex.EncodeToString(b)
	_, err := a.DB.Exec(c.Context(), `INSERT INTO sessions(token_hash,user_id,expires_at,user_agent) VALUES($1,$2,now()+$3*interval '1 second',$4)`, hashToken(t), id, seconds(sessionTTL), ua)
	if err != nil {
		return err
	}
	a.setSessionCookie(c, t)
	if !created && others && !known {
		notify(email, letterNewSignIn, letterData{Device: deviceLabel(ua), When: time.Now()})
	}
	// Browser tokens stay in HttpOnly cookies; only non-browser clients receive bearer tokens.
	out := fiber.Map{"ok": true}
	if created {
		out["created"] = true
	}
	if c.Get("Origin") == "" {
		out["token"] = t
	}
	return c.JSON(out)
}
func (a *App) register(c fiber.Ctx) error {
	var in struct{ Name, Email, Password, TurnstileToken string }
	if e := decode(c, &in); e != nil {
		return e
	}
	in.Email = normalizeEmail(in.Email)
	if !validEmail(in.Email) || !validText(in.Name, 2, 70) || len(in.Password) < 12 || len(in.Password) > 72 {
		return fiber.NewError(400, "Use a valid email, a name, and a password of 12–72 characters.")
	}
	if e := a.signupsOpen(c.Context()); e != nil {
		return e
	}
	if e := verifyTurnstile(c, in.TurnstileToken); e != nil {
		return e
	}
	hash, e := bcrypt.GenerateFromPassword([]byte(in.Password), 12)
	if e != nil {
		return e
	}
	id := uuid.NewString()
	// A suggested handle can be claimed by a sign-up racing this one; pick again if so.
	for try := 0; ; try++ {
		handle, e := freeHandle(c.Context(), a.DB, in.Name)
		if e != nil {
			return e
		}
		_, e = a.DB.Exec(c.Context(), `INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,$3,$4,$5)`, id, in.Email, string(hash), strings.TrimSpace(in.Name), handle)
		if e == nil {
			break
		}
		if handleConflict(e) && try < 2 {
			continue
		}
		var pe *pgconn.PgError
		if errors.As(e, &pe) && pe.Code == "23505" {
			return fiber.NewError(409, "An account with that email already exists.")
		}
		return e
	}
	a.welcome(c.Context(), id, in.Email)
	return a.session(c, id, true)
}

func (a *App) signupsOpen(ctx context.Context) error {
	settings, e := loadSettings(ctx, a.DB)
	if e != nil {
		return e
	}
	if settings.SignupsPaused {
		return fiber.NewError(403, signupsPausedMessage)
	}
	return nil
}

var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("not-a-real-password"), 12)

// usablePassword is false for accounts made with Apple or Google until a password is set.
func usablePassword(hash string) bool { return !strings.HasPrefix(hash, "!") }

// A guess spread over many addresses still meets this per-account limit, whether or not the
// account exists; a successful sign-in or a password reset clears it.
const (
	loginAttempts      = 10
	loginAttemptWindow = 15 * time.Minute
)

func (a *App) login(c fiber.Ctx) error {
	var in struct{ Email, Password string }
	if e := decode(c, &in); e != nil {
		return e
	}
	email := normalizeEmail(in.Email)
	if !a.throttles.logins.hit(email, loginAttempts, loginAttemptWindow) {
		return fiber.NewError(429, "Too many sign-in attempts. Please wait a few minutes and try again.")
	}
	if len(in.Password) > 72 {
		return fiber.NewError(401, "Email or password is incorrect.")
	}
	var id, hash string
	e := a.DB.QueryRow(c.Context(), `SELECT id,password_hash FROM users WHERE email=$1`, email).Scan(&id, &hash)
	if e != nil {
		if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		bcrypt.CompareHashAndPassword(dummyHash, []byte(in.Password))
		return fiber.NewError(401, "Email or password is incorrect.")
	}
	if !usablePassword(hash) {
		// Same work as a wrong password, so timing doesn't reveal sign-in-only accounts.
		bcrypt.CompareHashAndPassword(dummyHash, []byte(in.Password))
		return fiber.NewError(401, "Email or password is incorrect.")
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(in.Password)) != nil {
		return fiber.NewError(401, "Email or password is incorrect.")
	}
	a.throttles.logins.clear(email)
	return a.session(c, id, false)
}
func (a *App) logout(c fiber.Ctx) error {
	_, e := a.DB.Exec(c.Context(), `DELETE FROM sessions WHERE token_hash=$1`, hashToken(token(c)))
	if e != nil {
		return e
	}
	a.clearSessionCookie(c)
	return c.SendStatus(204)
}
func (a *App) me(c fiber.Ctx) error {
	b, e := a.profile(c.Context(), userID(c))
	if e != nil {
		return e
	}
	c.Set("Content-Type", "application/json")
	return c.Send(b)
}

// profile is the member as GET /me describes them.
func (a *App) profile(ctx context.Context, id string) ([]byte, error) {
	// adminPending: an owner's address that hasn't been proven yet, so the console stays closed.
	// onboarded: false until a new kitchen finishes or skips its setup.
	var b []byte
	e := a.DB.QueryRow(ctx, `SELECT jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'emailVerified',u.email_verified,'handle',u.handle,'bio',u.bio,'avatar',u.avatar,'preferences',`+preferencesJSON+`,'onboarded',u.onboarded_at IS NOT NULL,
 'avoid',COALESCE((SELECT avoid FROM food_avoid WHERE user_id=u.id),'{"groups":{},"terms":{}}'),'householdAvoid',`+householdAvoidJSON+`,
 'hasPassword',NOT starts_with(u.password_hash,'!'),'identities',COALESCE((SELECT jsonb_agg(provider ORDER BY provider) FROM identities WHERE user_id=u.id),'[]'),'plan',`+memberPlanSQL+`,
 'admin',`+adminSQL(2, 3)+`,'adminOwner',`+ownerSQL(2, 3)+`,'adminPending',(NOT `+adminSQL(2, 3)+` AND u.email=ANY($2::text[]))) FROM users u WHERE u.id=$1`, id, ownerEmails(), a.Config.Production).Scan(&b)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, fiber.NewError(404, "This item could not be found.")
	}
	return b, e
}
func (a *App) onboarded(c fiber.Ctx) error {
	if _, e := a.DB.Exec(c.Context(), `UPDATE users SET onboarded_at=COALESCE(onboarded_at,now()) WHERE id=$1`, userID(c)); e != nil {
		return e
	}
	return a.me(c)
}
func (a *App) updateMe(c fiber.Ctx) error {
	var in struct {
		Name, Bio, Avatar string
		// Left out (or unchanged), the handle stays as it is, including older generated ones.
		Handle      *string
		Preferences struct{ Diets, Allergies []string }
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	var current, avatar string
	if e := a.DB.QueryRow(c.Context(), `SELECT handle,avatar FROM users WHERE id=$1`, userID(c)).Scan(&current, &avatar); e != nil {
		return e
	}
	handle := current
	if in.Handle != nil && normalizeHandle(*in.Handle) != current {
		handle = normalizeHandle(*in.Handle)
		if !validHandle(handle) {
			return fiber.NewError(400, handleRules)
		}
		if reservedHandles[handle] {
			return fiber.NewError(409, handleTaken)
		}
	}
	if !validText(in.Name, 2, 70) || len(in.Bio) > 1000 || !validMedia(in.Avatar) || len(in.Preferences.Diets) > 12 || len(in.Preferences.Allergies) > 20 {
		return fiber.NewError(400, "Check your profile fields.")
	}
	// A photo kept from before stays, whatever its host; a new one must be Savorly's (or Google's).
	if in.Avatar != avatar && !a.validAvatar(in.Avatar) {
		return fiber.NewError(400, "Add photos and videos by uploading them to Savorly.")
	}
	for _, v := range append(in.Preferences.Diets, in.Preferences.Allergies...) {
		if !validText(v, 1, 60) {
			return fiber.NewError(400, "Each food preference or allergy can be up to 60 characters.")
		}
	}
	// Merged, so the units, language and notifications set through /me/preferences stay.
	tx, e := a.DB.Begin(c.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(c.Context())
	_, e = tx.Exec(c.Context(), `UPDATE users SET name=$2,bio=$3,avatar=$4,preferences=preferences||$5::jsonb,handle=$6 WHERE id=$1`, userID(c), strings.TrimSpace(in.Name), in.Bio, in.Avatar, jsonBytes(fiber.Map{"diets": in.Preferences.Diets, "allergies": in.Preferences.Allergies}), handle)
	if handleConflict(e) {
		return fiber.NewError(409, handleTaken)
	}
	if e != nil {
		return e
	}
	// What recipe pages warn about follows the diets and allergies in the same commit.
	if e = saveAvoid(c.Context(), tx, userID(c), in.Preferences.Diets, in.Preferences.Allergies); e != nil {
		return e
	}
	if e = tx.Commit(c.Context()); e != nil {
		return e
	}
	return a.me(c)
}
func (a *App) deleteMe(c fiber.Ctx) error {
	var in struct{ Password, Provider, Token string }
	if e := decode(c, &in); e != nil {
		return e
	}
	ctx, owner := c.Context(), userID(c)
	// Read before the row goes: the confirmation needs the address.
	acct, e := a.loadAccount(ctx, owner)
	if e != nil {
		return e
	}
	if e = a.confirmOwner(ctx, owner, acct.Hash, in.Password, in.Provider, in.Token); e != nil {
		// A mistyped password keeps the kitchen signed in, as it does for a password change.
		return stillSignedIn(e)
	}
	if e = a.cancelSubscription(ctx, owner); e != nil {
		return e
	}
	if e = a.revokeApple(ctx, owner); e != nil {
		slog.Warn("revoke Sign in with Apple", "error", e)
	}
	if _, e = a.DB.Exec(ctx, `DELETE FROM users WHERE id=$1`, owner); e != nil {
		return e
	}
	notify(acct.Email, letterAccountDeleted, letterData{})
	a.clearSessionCookie(c)
	return c.SendStatus(204)
}
