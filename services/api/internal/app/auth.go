package app

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/mail"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/crypto/bcrypt"
)

func hashToken(t string) string { h := sha256.Sum256([]byte(t)); return hex.EncodeToString(h[:]) }
func token(c fiber.Ctx) string {
	if b := strings.TrimPrefix(c.Get("Authorization"), "Bearer "); b != "" && b != c.Get("Authorization") {
		return b
	}
	return c.Cookies("savorly_session")
}
func userID(c fiber.Ctx) string { u, _ := c.Locals("userID").(string); return u }
func (a *App) requireAuth(c fiber.Ctx) error {
	var id string
	err := a.DB.QueryRow(c.Context(), `SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now()`, hashToken(token(c))).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return fiber.NewError(401, "Sign in to your kitchen to continue.")
	}
	if err != nil {
		return err
	}
	c.Locals("userID", id)
	return c.Next()
}
func (a *App) session(c fiber.Ctx, id string) error {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	t := hex.EncodeToString(b)
	_, err := a.DB.Exec(c.Context(), `INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)`, hashToken(t), id, time.Now().Add(30*24*time.Hour))
	if err != nil {
		return err
	}
	c.Cookie(&fiber.Cookie{Name: "savorly_session", Value: t, HTTPOnly: true, Secure: a.Config.Production, SameSite: "Lax", Path: "/", MaxAge: 30 * 86400})
	// Browser tokens stay in HttpOnly cookies; only non-browser clients receive bearer tokens.
	if c.Get("Origin") != "" {
		return c.JSON(fiber.Map{"ok": true})
	}
	return c.JSON(fiber.Map{"ok": true, "token": t})
}
func (a *App) register(c fiber.Ctx) error {
	var in struct{ Name, Email, Password string }
	if e := decode(c, &in); e != nil {
		return e
	}
	in.Email = strings.ToLower(strings.TrimSpace(in.Email))
	parsed, e := mail.ParseAddress(in.Email)
	if e != nil || parsed.Address != in.Email || len(in.Email) > 254 || !validText(in.Name, 2, 70) || len(in.Password) < 12 || len(in.Password) > 72 {
		return fiber.NewError(400, "Use a valid email, a name, and a password of 12–72 characters.")
	}
	hash, e := bcrypt.GenerateFromPassword([]byte(in.Password), 12)
	if e != nil {
		return e
	}
	id := uuid.NewString()
	_, e = a.DB.Exec(c.Context(), `INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,$3,$4,$5)`, id, in.Email, string(hash), strings.TrimSpace(in.Name), newHandle(in.Name, id))
	if e != nil {
		var pe *pgconn.PgError
		if errors.As(e, &pe) && pe.Code == "23505" {
			return fiber.NewError(409, "An account with that email already exists.")
		}
		return e
	}
	return a.session(c, id)
}

func newHandle(name, id string) string {
	return strings.ToLower(strings.Join(strings.Fields(name), "")) + "-" + id[:6]
}

var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("not-a-real-password"), 12)

// usablePassword is false for accounts made with Apple or Google until a password is set.
func usablePassword(hash string) bool { return !strings.HasPrefix(hash, "!") }

func (a *App) login(c fiber.Ctx) error {
	var in struct{ Email, Password string }
	if e := decode(c, &in); e != nil {
		return e
	}
	if len(in.Password) > 72 {
		return fiber.NewError(401, "Email or password is incorrect.")
	}
	var id, hash string
	e := a.DB.QueryRow(c.Context(), `SELECT id,password_hash FROM users WHERE email=$1`, strings.ToLower(strings.TrimSpace(in.Email))).Scan(&id, &hash)
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
	return a.session(c, id)
}
func (a *App) logout(c fiber.Ctx) error {
	_, e := a.DB.Exec(c.Context(), `DELETE FROM sessions WHERE token_hash=$1`, hashToken(token(c)))
	if e != nil {
		return e
	}
	c.Cookie(&fiber.Cookie{Name: "savorly_session", Value: "", Path: "/", HTTPOnly: true, Secure: a.Config.Production, SameSite: "Lax", MaxAge: -1})
	return c.SendStatus(204)
}
func (a *App) me(c fiber.Ctx) error {
	return a.queryOne(c, `SELECT jsonb_build_object('id',id,'name',name,'email',email,'handle',handle,'bio',bio,'avatar',avatar,'preferences',preferences,
 'hasPassword',NOT starts_with(password_hash,'!'),'identities',COALESCE((SELECT jsonb_agg(provider ORDER BY provider) FROM identities WHERE user_id=users.id),'[]'),'plan',(SELECT `+effectivePlanSQL+` FROM users u WHERE u.id=users.id)) FROM users WHERE id=$1`, userID(c))
}
func (a *App) updateMe(c fiber.Ctx) error {
	var in struct {
		Name, Bio, Avatar string
		Preferences       struct{ Diets, Allergies []string }
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	if !validText(in.Name, 2, 70) || len(in.Bio) > 1000 || !validMedia(in.Avatar) || len(in.Preferences.Diets) > 12 || len(in.Preferences.Allergies) > 20 {
		return fiber.NewError(400, "Check your profile fields.")
	}
	for _, v := range append(in.Preferences.Diets, in.Preferences.Allergies...) {
		if !validText(v, 1, 60) {
			return fiber.NewError(400, "Preference labels are too long.")
		}
	}
	_, e := a.DB.Exec(c.Context(), `UPDATE users SET name=$2,bio=$3,avatar=$4,preferences=$5 WHERE id=$1`, userID(c), strings.TrimSpace(in.Name), in.Bio, in.Avatar, jsonBytes(fiber.Map{"diets": in.Preferences.Diets, "allergies": in.Preferences.Allergies}))
	if e != nil {
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
	var hash string
	if e := a.DB.QueryRow(ctx, `SELECT password_hash FROM users WHERE id=$1`, owner).Scan(&hash); e != nil {
		return e
	}
	if usablePassword(hash) {
		if bcrypt.CompareHashAndPassword([]byte(hash), []byte(in.Password)) != nil {
			return fiber.NewError(401, "Password is incorrect.")
		}
	} else {
		// Without a password, a fresh sign-in with a connected provider confirms it's them.
		id, e := a.verifyIdentity(ctx, in.Provider, in.Token)
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
	}
	if e := a.cancelSubscription(ctx, owner); e != nil {
		return e
	}
	if e := a.revokeApple(ctx, owner); e != nil {
		slog.Warn("revoke Sign in with Apple", "error", e)
	}
	_, e := a.DB.Exec(ctx, `DELETE FROM users WHERE id=$1`, owner)
	if e != nil {
		return e
	}
	c.Cookie(&fiber.Cookie{Name: "savorly_session", Path: "/", MaxAge: -1})
	return c.SendStatus(204)
}
