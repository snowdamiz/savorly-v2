package app

import (
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

func (a *App) forgotPassword(c fiber.Ctx) error {
	if !emailEnabled() {
		return fiber.NewError(503, "Password recovery is not connected yet. Contact the kitchen administrator.")
	}
	var in struct{ Email string }
	if e := decode(c, &in); e != nil {
		return e
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))
	if !validText(email, 3, 254) {
		return fiber.NewError(400, "Enter your email address.")
	}
	var id string
	e := a.DB.QueryRow(c.Context(), `SELECT id FROM users WHERE email=$1 AND password_hash<>'!disabled'`, email).Scan(&id)
	if errors.Is(e, pgx.ErrNoRows) {
		return c.JSON(fiber.Map{"ok": true})
	}
	if e != nil {
		return e
	}
	n, e := rand.Int(rand.Reader, big.NewInt(100000000))
	if e != nil {
		return e
	}
	code := fmt.Sprintf("%08d", n.Int64())
	_, e = a.DB.Exec(c.Context(), `INSERT INTO password_resets(user_id,code_hash,expires_at) VALUES($1,$2,now()+interval '15 minutes') ON CONFLICT(user_id) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0`, id, hashToken(email+":"+code))
	if e != nil {
		return e
	}
	if e = sendEmail(c.Context(), email, "Your Savorly password reset code", "Your Savorly reset code is "+code+". Enter it in the app to choose a new password. It expires in 15 minutes. If you did not request this, you can ignore this email."); e != nil {
		slog.Error("recovery email delivery failed", "error", e)
	}
	// The response is identical whether or not an address exists or delivery succeeds.
	return c.JSON(fiber.Map{"ok": true})
}
func (a *App) resetPassword(c fiber.Ctx) error {
	var in struct{ Email, Code, Password string }
	if e := decode(c, &in); e != nil {
		return e
	}
	if len(in.Password) < 12 || len(in.Password) > 72 || len(in.Code) != 8 {
		return fiber.NewError(400, "Enter the 8-digit code and a password of 12–72 characters.")
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))
	tx, e := a.DB.Begin(c.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(c.Context())
	var id, hash string
	var attempts int
	var expiry time.Time
	e = tx.QueryRow(c.Context(), `SELECT p.user_id,p.code_hash,p.attempts,p.expires_at FROM password_resets p JOIN users u ON u.id=p.user_id WHERE u.email=$1 FOR UPDATE OF p`, email).Scan(&id, &hash, &attempts, &expiry)
	invalid := fiber.NewError(400, "That reset code is invalid or expired. Request a new code.")
	if errors.Is(e, pgx.ErrNoRows) {
		return invalid
	}
	if e != nil {
		return e
	}
	if attempts >= 5 || time.Now().After(expiry) {
		return invalid
	}
	if subtle.ConstantTimeCompare([]byte(hash), []byte(hashToken(email+":"+in.Code))) != 1 {
		_, e = tx.Exec(c.Context(), `UPDATE password_resets SET attempts=attempts+1 WHERE user_id=$1`, id)
		if e != nil {
			return e
		}
		if e = tx.Commit(c.Context()); e != nil {
			return e
		}
		return invalid
	}
	password, e := bcrypt.GenerateFromPassword([]byte(in.Password), 12)
	if e != nil {
		return e
	}
	if _, e = tx.Exec(c.Context(), `UPDATE users SET password_hash=$2,email_verified=true WHERE id=$1`, id, string(password)); e != nil {
		return e
	}
	if _, e = tx.Exec(c.Context(), `DELETE FROM sessions WHERE user_id=$1`, id); e != nil {
		return e
	}
	if _, e = tx.Exec(c.Context(), `DELETE FROM password_resets WHERE user_id=$1`, id); e != nil {
		return e
	}
	if e = tx.Commit(c.Context()); e != nil {
		return e
	}
	return c.JSON(fiber.Map{"ok": true})
}
