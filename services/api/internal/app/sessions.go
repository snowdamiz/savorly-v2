package app

import (
	"errors"
	"log/slog"
	"strings"
	"time"
	"unicode"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
)

const (
	sessionTTL = 30 * 24 * time.Hour
	// last_used_at is only as precise as this, so most authenticated reads stay reads.
	sessionTouchEvery = 5 * time.Minute
)

// sessionToken is the request's session token, and whether it came in the browser cookie.
func sessionToken(c fiber.Ctx) (string, bool) {
	if b := strings.TrimPrefix(c.Get("Authorization"), "Bearer "); b != "" && b != c.Get("Authorization") {
		return b, false
	}
	return c.Cookies("savorly_session"), true
}

// seconds is d in whole seconds, for SQL that adds it to the database's clock.
func seconds(d time.Duration) int64 { return int64(d / time.Second) }

// authenticate returns the signed-in member, or "" for a guest. A session in use slides forward:
// past half its life it is extended (and the cookie with it), so active cooks stay signed in.
// Session times are only ever compared with the database's clock, never this server's.
func (a *App) authenticate(c fiber.Ctx) (string, error) {
	tok, cookie := sessionToken(c)
	if tok == "" {
		return "", nil
	}
	hash := hashToken(tok)
	var id string
	var renew, stale bool
	// Suspension deletes sessions; the join also covers one that raced the suspension.
	err := a.DB.QueryRow(c.Context(), `SELECT s.user_id,s.expires_at<now()+$2*interval '1 second',s.last_used_at<now()-$3*interval '1 second'
 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.suspended_at IS NULL`, hash, seconds(sessionTTL/2), seconds(sessionTouchEvery)).Scan(&id, &renew, &stale)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if renew || stale {
		_, err = a.DB.Exec(c.Context(), `UPDATE sessions SET last_used_at=now(),expires_at=CASE WHEN $2::boolean THEN now()+$3*interval '1 second' ELSE expires_at END,
 user_agent=COALESCE(NULLIF($4,''),user_agent) WHERE token_hash=$1`, hash, renew, seconds(sessionTTL), userAgent(c))
		switch {
		case err != nil:
			// Bookkeeping; the session itself is valid, so the request goes on.
			slog.Warn("session touch failed", "error", err)
		case renew && cookie:
			a.setSessionCookie(c, tok)
		}
	}
	return id, nil
}

func (a *App) setSessionCookie(c fiber.Ctx, tok string) {
	c.Cookie(&fiber.Cookie{Name: "savorly_session", Value: tok, HTTPOnly: true, Secure: a.Config.Production, SameSite: "Lax", Path: "/", MaxAge: int(sessionTTL / time.Second)})
}

// clearSessionCookie must match setSessionCookie's attributes, or browsers keep the old cookie.
func (a *App) clearSessionCookie(c fiber.Ctx) {
	c.Cookie(&fiber.Cookie{Name: "savorly_session", Value: "", HTTPOnly: true, Secure: a.Config.Production, SameSite: "Lax", Path: "/", MaxAge: -1})
}

// userAgent is the request's User-Agent, made safe to store and show: valid UTF-8 without
// control characters, and short.
func userAgent(c fiber.Ctx) string {
	ua := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.ToValidUTF8(c.Get("User-Agent"), ""))
	ua = strings.TrimSpace(ua)
	if r := []rune(ua); len(r) > 255 {
		ua = string(r[:255])
	}
	return ua
}

// deviceOf names the client and system a user agent describes, from a fixed vocabulary, so the
// result is safe to put in an email. Either is "" when unknown.
func deviceOf(ua string) (client, system string) {
	has := func(s ...string) bool {
		for _, x := range s {
			if strings.Contains(ua, x) {
				return true
			}
		}
		return false
	}
	switch {
	case has("iPhone"):
		system = "iPhone"
	case has("iPad"):
		system = "iPad"
	case has("Android", "okhttp"):
		system = "Android"
	case has("CrOS"):
		system = "ChromeOS"
	case has("Macintosh", "Mac OS X"):
		system = "macOS"
	case has("Windows"):
		system = "Windows"
	case has("Darwin"):
		system = "iOS"
	case has("Linux"):
		system = "Linux"
	}
	switch {
	case has("CFNetwork", "okhttp", "Expo") || strings.HasPrefix(ua, "Savorly"):
		client = "Savorly"
	case has("Edg/", "EdgiOS", "EdgA/"):
		client = "Edge"
	case has("OPR/", "Opera"):
		client = "Opera"
	case has("Firefox/", "FxiOS"):
		client = "Firefox"
	case has("SamsungBrowser"):
		client = "Samsung Internet"
	case has("Chrome/", "CriOS"):
		client = "Chrome"
	case has("Safari/"):
		client = "Safari"
	}
	return client, system
}

// sessions lists the member's signed-in devices, this one first.
func (a *App) sessions(c fiber.Ctx) error {
	tok, _ := sessionToken(c)
	rows, e := a.DB.Query(c.Context(), `SELECT public_id,created_at,last_used_at,expires_at,user_agent,token_hash=$2 FROM sessions WHERE user_id=$1 AND expires_at>now() ORDER BY token_hash=$2 DESC,last_used_at DESC`, userID(c), hashToken(tok))
	if e != nil {
		return e
	}
	defer rows.Close()
	out := []fiber.Map{}
	for rows.Next() {
		var id, ua string
		var created, used, expires time.Time
		var current bool
		if e = rows.Scan(&id, &created, &used, &expires, &ua, &current); e != nil {
			return e
		}
		client, system := deviceOf(ua)
		out = append(out, fiber.Map{"id": id, "createdAt": created, "lastUsedAt": used, "expiresAt": expires, "userAgent": ua, "client": client, "system": system, "current": current})
	}
	if e = rows.Err(); e != nil {
		return e
	}
	return c.JSON(out)
}

// revokeSession signs one device out. Signing out this device also clears its cookie.
func (a *App) revokeSession(c fiber.Ctx) error {
	tok, _ := sessionToken(c)
	var current bool
	e := a.DB.QueryRow(c.Context(), `DELETE FROM sessions WHERE user_id=$1 AND public_id=$2 RETURNING token_hash=$3`, userID(c), c.Params("id"), hashToken(tok)).Scan(&current)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "This device is already signed out.")
	}
	if e != nil {
		return e
	}
	if current {
		a.clearSessionCookie(c)
	}
	return c.SendStatus(204)
}

// revokeOtherSessions signs out everywhere except this device. The count leaves out expired
// sessions, which the device list never showed.
func (a *App) revokeOtherSessions(c fiber.Ctx) error {
	tok, _ := sessionToken(c)
	var n int
	if e := a.DB.QueryRow(c.Context(), `WITH gone AS (DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2 RETURNING expires_at)
 SELECT count(*) FILTER (WHERE expires_at>now()) FROM gone`, userID(c), hashToken(tok)).Scan(&n); e != nil {
		return e
	}
	return c.JSON(fiber.Map{"revoked": n})
}
