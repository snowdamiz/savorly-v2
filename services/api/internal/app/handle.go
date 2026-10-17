package app

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"regexp"
	"strings"
	"unicode"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
)

// A handle is 3–24 lowercase letters, digits, dots or underscores, starting and ending with a
// letter or digit, so @mentions and profile links read cleanly.
var handlePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._]{1,22}[a-z0-9]$`)

// Names that would read as Savorly speaking, collide with app routes or pages, or confuse code
// that prints a missing value.
var reservedHandles = map[string]bool{
	"about": true, "account": true, "admin": true, "administrator": true, "api": true, "cook": true,
	"cooks": true, "creator": true, "creators": true, "help": true, "login": true, "mail": true,
	"me": true, "moderator": true, "null": true, "official": true, "privacy": true, "recipe": true,
	"recipes": true, "root": true, "savorly": true, "settings": true, "signin": true, "signup": true,
	"staff": true, "support": true, "system": true, "team": true, "terms": true, "undefined": true,
	"www": true,
}

const handleRules = "Usernames use 3–24 lowercase letters, numbers, dots or underscores."
const handleTaken = "That username is taken."

func normalizeHandle(s string) string {
	return strings.ToLower(strings.TrimPrefix(strings.TrimSpace(s), "@"))
}

func validHandle(h string) bool {
	return handlePattern.MatchString(h) && !strings.Contains(h, "..")
}

// handleBase turns a display name into a handle stem: accents dropped, letters and digits kept.
func handleBase(name string) string {
	folded, _, _ := transform.String(transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn))), strings.ToLower(name))
	var b strings.Builder
	for _, r := range folded {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	stem := b.String()
	if len(stem) > 18 {
		stem = stem[:18]
	}
	switch {
	case stem == "":
		return "cook"
	case len(stem) < 3:
		return stem + "cooks"
	}
	return stem
}

type rowQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// freeHandle suggests an unused handle from a name: the plain stem when it's free, then the stem
// with a few digits.
func freeHandle(ctx context.Context, q rowQuerier, name string) (string, error) {
	base := handleBase(name)
	for try := 0; try < 6; try++ {
		h := base
		switch {
		case try >= 3:
			h = fmt.Sprintf("%s%d", base, 1000+rand.IntN(9000))
		case try > 0 || reservedHandles[base]:
			h = fmt.Sprintf("%s%d", base, 10+rand.IntN(90))
		}
		var taken bool
		if e := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE handle=$1)`, h).Scan(&taken); e != nil {
			return "", e
		}
		if !taken {
			return h, nil
		}
	}
	return fmt.Sprintf("%s_%d", base, 100000+rand.IntN(900000)), nil
}

// handleConflict is a unique violation on users.handle, which two sign-ups can race into.
func handleConflict(e error) bool {
	var pe *pgconn.PgError
	return errors.As(e, &pe) && pe.Code == "23505" && strings.Contains(pe.ConstraintName, "handle")
}

// handleAvailability lets a cook check a username while typing it. Their own counts as available.
func (a *App) handleAvailability(c fiber.Ctx) error {
	h := normalizeHandle(c.Params("handle"))
	if !validHandle(h) {
		return c.JSON(fiber.Map{"handle": h, "valid": false, "available": false})
	}
	if reservedHandles[h] {
		return c.JSON(fiber.Map{"handle": h, "valid": true, "available": false})
	}
	var owner string
	e := a.DB.QueryRow(c.Context(), `SELECT id FROM users WHERE handle=$1`, h).Scan(&owner)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return e
	}
	return c.JSON(fiber.Map{"handle": h, "valid": true, "available": owner == "" || owner == userID(c)})
}
