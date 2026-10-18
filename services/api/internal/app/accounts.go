package app

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net/mail"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/crypto/bcrypt"
)

// accountRoutes are the signed-in member's account settings, plus the public endpoints that
// support them.
func (a *App) accountRoutes(v fiber.Router) {
	v.Get("/session", a.currentSession)
	v.Post("/me/password", a.requireAuth, perUser(10, 15*time.Minute), a.changePassword)
	v.Post("/me/email", a.requireAuth, perUser(10, time.Hour), a.requestEmailChange)
	v.Post("/me/email/confirm", a.requireAuth, perUser(20, 15*time.Minute), a.confirmEmailChange)
	v.Post("/me/verify-email", a.requireAuth, perUser(20, 15*time.Minute), a.verifyEmail)
	v.Post("/me/verify-email/resend", a.requireAuth, perUser(5, time.Hour), a.resendVerification)
	v.Get("/me/sessions", a.requireAuth, a.sessions)
	v.Delete("/me/sessions/:id", a.requireAuth, a.revokeSession)
	v.Post("/me/sessions/revoke-others", a.requireAuth, a.revokeOtherSessions)
	v.Get("/me/export", a.requireAuth, perUser(10, time.Hour), a.exportMe)
	v.Get("/me/export/files", a.requireAuth, perUser(5, time.Hour), a.exportFilesMe)
	v.Post("/me/export-link", a.requireAuth, perUser(10, time.Hour), a.exportLink)
	v.Get("/export/:token", rateLimit(20, time.Hour), a.exportByToken)
	v.Post("/client-errors", rateLimit(30, time.Minute), a.clientError)
}

// currentSession tells the app who is signed in without treating guests as an error.
func (a *App) currentSession(c fiber.Ctx) error {
	id, e := a.authenticate(c)
	if e != nil {
		return e
	}
	if id == "" {
		return c.JSON(fiber.Map{"user": nil})
	}
	c.Locals("userID", id)
	profile, e := a.profile(c.Context(), id)
	if e != nil {
		return e
	}
	c.Set("Content-Type", "application/json")
	return c.Send(append(append([]byte(`{"user":`), profile...), '}'))
}

func normalizeEmail(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

// validEmail takes a normalized address.
func validEmail(email string) bool {
	parsed, e := mail.ParseAddress(email)
	return e == nil && parsed.Address == email && len(email) <= 254
}

type account struct{ Email, Hash string }

func (a *App) loadAccount(ctx context.Context, id string) (account, error) {
	var acct account
	e := a.DB.QueryRow(ctx, `SELECT email,password_hash FROM users WHERE id=$1`, id).Scan(&acct.Email, &acct.Hash)
	return acct, e
}

// confirmOwner checks that whoever holds the session is the account's owner: its password, or
// without one, a fresh sign-in with an Apple or Google account connected to it.
func (a *App) confirmOwner(ctx context.Context, owner, hash, password, provider, token string) error {
	if usablePassword(hash) {
		if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
			return fiber.NewError(401, "Password is incorrect.")
		}
		return nil
	}
	if provider == "" || token == "" {
		return fiber.NewError(400, "Confirm with the Apple or Google account connected to this kitchen.")
	}
	id, e := a.verifyIdentity(ctx, provider, token)
	if e != nil {
		return e
	}
	var mine bool
	if e = a.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM identities WHERE provider=$1 AND subject=$2 AND user_id=$3)`, id.Provider, id.Subject, owner).Scan(&mine); e != nil {
		return e
	}
	if !mine {
		return fiber.NewError(401, "Confirm with the Apple or Google account connected to this kitchen.")
	}
	return nil
}

// stillSignedIn turns confirmOwner's 401s into 403s: the app treats a 401 as a lost session and
// signs out, which a mistyped password shouldn't do.
func stillSignedIn(e error) error {
	var fe *fiber.Error
	if errors.As(e, &fe) && fe.Code == 401 {
		return fiber.NewError(403, fe.Message)
	}
	return e
}

// changePassword sets a new password, or a first one for an Apple or Google account, and signs
// out every other device.
func (a *App) changePassword(c fiber.Ctx) error {
	var in struct{ CurrentPassword, NewPassword, Provider, Token string }
	if e := decode(c, &in); e != nil {
		return e
	}
	if len(in.NewPassword) < 12 || len(in.NewPassword) > 72 {
		return fiber.NewError(400, "Use a password of 12–72 characters.")
	}
	ctx, owner := c.Context(), userID(c)
	acct, e := a.loadAccount(ctx, owner)
	if e != nil {
		return e
	}
	if e = a.confirmOwner(ctx, owner, acct.Hash, in.CurrentPassword, in.Provider, in.Token); e != nil {
		return stillSignedIn(e)
	}
	hash, e := bcrypt.GenerateFromPassword([]byte(in.NewPassword), 12)
	if e != nil {
		return e
	}
	tok, _ := sessionToken(c)
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `UPDATE users SET password_hash=$2 WHERE id=$1`, owner, string(hash)); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2`, owner, hashToken(tok)); e != nil {
		return e
	}
	// An outstanding reset code would otherwise still replace the password just chosen.
	if _, e = tx.Exec(ctx, `DELETE FROM password_resets WHERE user_id=$1`, owner); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	notify(acct.Email, letterPasswordChanged, letterData{})
	return a.me(c)
}

const (
	verifyCodeTTL = 24 * time.Hour
	changeCodeTTL = 15 * time.Minute
)

var errBadCode = fiber.NewError(400, "That code is invalid or expired. Request a new code.")

// sixDigits reports whether s looks like a code these emails send.
func sixDigits(s string) bool {
	if len(s) != 6 {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func codeHash(purpose, email, code string) string {
	return hashToken(purpose + ":" + email + ":" + code)
}

// issueCode stores a fresh code proving email for purpose, replacing any earlier one.
func (a *App) issueCode(ctx context.Context, owner, purpose, email string, ttl time.Duration) (string, error) {
	n, e := rand.Int(rand.Reader, big.NewInt(1000000))
	if e != nil {
		return "", e
	}
	code := fmt.Sprintf("%06d", n.Int64())
	_, e = a.DB.Exec(ctx, `INSERT INTO email_codes(user_id,purpose,email,code_hash,expires_at) VALUES($1,$2,$3,$4,now()+$5*interval '1 second')
 ON CONFLICT(user_id,purpose) DO UPDATE SET email=excluded.email,code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0`, owner, purpose, email, codeHash(purpose, email, code), seconds(ttl))
	return code, e
}

// checkCode spends one of the code's five attempts and returns the address it was sent to.
func (a *App) checkCode(ctx context.Context, owner, purpose, code string) (string, error) {
	var email, hash string
	e := a.DB.QueryRow(ctx, `UPDATE email_codes SET attempts=attempts+1 WHERE user_id=$1 AND purpose=$2 AND expires_at>now() AND attempts<5 RETURNING email,code_hash`, owner, purpose).Scan(&email, &hash)
	if errors.Is(e, pgx.ErrNoRows) {
		return "", errBadCode
	}
	if e != nil {
		return "", e
	}
	if subtle.ConstantTimeCompare([]byte(hash), []byte(codeHash(purpose, email, code))) != 1 {
		return "", errBadCode
	}
	return email, nil
}

func decodeCode(c fiber.Ctx) (string, error) {
	var in struct{ Code string }
	if e := decode(c, &in); e != nil {
		return "", e
	}
	code := strings.TrimSpace(in.Code)
	if !sixDigits(code) {
		return "", fiber.NewError(400, "Enter the 6-digit code from the email.")
	}
	return code, nil
}

// sendVerification mails a fresh code that proves the account's own address.
func (a *App) sendVerification(ctx context.Context, owner, email string, kind letterKind) error {
	code, e := a.issueCode(ctx, owner, "verify", email, verifyCodeTTL)
	if e != nil {
		return e
	}
	l := compose(kind, "en", letterData{Code: code})
	return sendEmail(ctx, email, l.Subject, l.Text)
}

// welcome greets a new kitchen with a code to confirm its address. Sign-up never waits on it.
func (a *App) welcome(ctx context.Context, owner, email string) {
	if !emailEnabled() {
		return
	}
	code, e := a.issueCode(ctx, owner, "verify", email, verifyCodeTTL)
	if e != nil {
		slog.Warn("welcome code not issued", "error", e)
		return
	}
	notify(email, letterWelcome, letterData{Code: code})
}

func (a *App) verifyEmail(c fiber.Ctx) error {
	code, e := decodeCode(c)
	if e != nil {
		return e
	}
	ctx, owner := c.Context(), userID(c)
	email, e := a.checkCode(ctx, owner, "verify", code)
	if e != nil {
		return e
	}
	// The address may have changed since the code was sent; that code no longer proves anything.
	r, e := a.DB.Exec(ctx, `UPDATE users SET email_verified=true WHERE id=$1 AND email=$2`, owner, email)
	if e != nil {
		return e
	}
	if r.RowsAffected() == 0 {
		return errBadCode
	}
	if _, e = a.DB.Exec(ctx, `DELETE FROM email_codes WHERE user_id=$1 AND purpose='verify'`, owner); e != nil {
		return e
	}
	return a.me(c)
}

func (a *App) resendVerification(c fiber.Ctx) error {
	if !emailEnabled() {
		return fiber.NewError(503, "Email confirmation is not connected yet. Contact your Savorly administrator.")
	}
	ctx, owner := c.Context(), userID(c)
	var email string
	var verified bool
	if e := a.DB.QueryRow(ctx, `SELECT email,email_verified FROM users WHERE id=$1`, owner).Scan(&email, &verified); e != nil {
		return e
	}
	if verified {
		return fiber.NewError(409, "Your email address is already confirmed.")
	}
	if e := a.sendVerification(ctx, owner, email, letterVerify); e != nil {
		slog.Error("verification email delivery failed", "error", e)
		return fiber.NewError(502, "We couldn't send the email. Please try again later.")
	}
	return c.JSON(fiber.Map{"ok": true})
}

// requestEmailChange mails a code to the new address; the change applies once it's entered.
func (a *App) requestEmailChange(c fiber.Ctx) error {
	if !emailEnabled() {
		return fiber.NewError(503, "Changing your email needs email delivery, which is not connected yet. Contact your Savorly administrator.")
	}
	var in struct{ Email, Password, Provider, Token string }
	if e := decode(c, &in); e != nil {
		return e
	}
	email := normalizeEmail(in.Email)
	if !validEmail(email) {
		return fiber.NewError(400, "Enter a valid email address.")
	}
	ctx, owner := c.Context(), userID(c)
	acct, e := a.loadAccount(ctx, owner)
	if e != nil {
		return e
	}
	if e = a.confirmOwner(ctx, owner, acct.Hash, in.Password, in.Provider, in.Token); e != nil {
		return stillSignedIn(e)
	}
	if email == acct.Email {
		return fiber.NewError(400, "That is already your email address.")
	}
	var taken bool
	if e = a.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE email=$1)`, email).Scan(&taken); e != nil {
		return e
	}
	if taken {
		return fiber.NewError(409, "An account with that email already exists.")
	}
	code, e := a.issueCode(ctx, owner, "change", email, changeCodeTTL)
	if e != nil {
		return e
	}
	l := compose(letterEmailChangeCode, "en", letterData{Code: code})
	if e = sendEmail(ctx, email, l.Subject, l.Text); e != nil {
		slog.Error("email change code delivery failed", "error", e)
		if _, e = a.DB.Exec(ctx, `DELETE FROM email_codes WHERE user_id=$1 AND purpose='change'`, owner); e != nil {
			return e
		}
		return fiber.NewError(502, "We couldn't send a code to that address. Check it and try again.")
	}
	return c.JSON(fiber.Map{"ok": true, "email": email})
}

// confirmEmailChange moves the account to the address the code was sent to, which the code
// proves, and tells the old address.
func (a *App) confirmEmailChange(c fiber.Ctx) error {
	code, e := decodeCode(c)
	if e != nil {
		return e
	}
	ctx, owner := c.Context(), userID(c)
	email, e := a.checkCode(ctx, owner, "change", code)
	if e != nil {
		return e
	}
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var old string
	if e = tx.QueryRow(ctx, `SELECT email FROM users WHERE id=$1 FOR UPDATE`, owner).Scan(&old); e != nil {
		return e
	}
	_, e = tx.Exec(ctx, `UPDATE users SET email=$2,email_verified=true WHERE id=$1`, owner, email)
	var pe *pgconn.PgError
	if errors.As(e, &pe) && pe.Code == "23505" {
		return fiber.NewError(409, "An account with that email already exists.")
	}
	if e != nil {
		return e
	}
	// Codes and reset codes were all sent to, or for, the old address.
	if _, e = tx.Exec(ctx, `DELETE FROM email_codes WHERE user_id=$1`, owner); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `DELETE FROM password_resets WHERE user_id=$1`, owner); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	if old != email {
		notify(old, letterEmailChanged, letterData{OldEmail: old, NewEmail: email})
	}
	return a.me(c)
}
