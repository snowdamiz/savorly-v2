package app

import (
	"crypto/sha256"
	"sync"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/gofiber/fiber/v3/middleware/limiter"
)

// attemptCounter counts attempts per key (an email address, say) in fixed windows. The API runs
// as one instance, so memory is enough; keys are hashed and their number capped, so a flood of
// distinct keys can't grow it without bound. The zero value is ready to use.
type attemptCounter struct {
	mu      sync.Mutex
	entries map[[32]byte]attemptWindow
}

type attemptWindow struct {
	n     int
	reset time.Time
}

const maxTrackedKeys = 10000

// hit records an attempt, unless key already used up max in the current window.
func (t *attemptCounter) hit(key string, max int, window time.Duration) bool {
	k, now := sha256.Sum256([]byte(key)), time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	w, ok := t.entries[k]
	if !ok || now.After(w.reset) {
		if !ok {
			t.makeRoom(now)
		}
		w = attemptWindow{reset: now.Add(window)}
	}
	if w.n >= max {
		return false
	}
	w.n++
	t.entries[k] = w
	return true
}

func (t *attemptCounter) clear(key string) {
	k := sha256.Sum256([]byte(key))
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.entries, k)
}

func (t *attemptCounter) makeRoom(now time.Time) {
	if t.entries == nil {
		t.entries = map[[32]byte]attemptWindow{}
	}
	if len(t.entries) < maxTrackedKeys {
		return
	}
	for k, w := range t.entries {
		if now.After(w.reset) {
			delete(t.entries, k)
		}
	}
	// Still full of live windows: drop an arbitrary one rather than stop counting.
	for k := range t.entries {
		if len(t.entries) < maxTrackedKeys {
			break
		}
		delete(t.entries, k)
	}
}

// accountThrottles back the per-account limits that per-IP limiters can't express.
type accountThrottles struct {
	logins     attemptCounter // sign-in attempts per email, cleared by a successful one
	resetMails attemptCounter // reset codes mailed per address
	assistants attemptCounter // MCP requests per linked app, or per address (mcp.go)
}

// perUser limits a signed-in member's use of a route, wherever they connect from. It must come
// after requireAuth.
func perUser(max int, window time.Duration) fiber.Handler {
	return limiter.New(limiter.Config{Max: max, Expiration: window, KeyGenerator: func(c fiber.Ctx) string { return "user:" + userID(c) },
		LimitReached: func(c fiber.Ctx) error {
			return fiber.NewError(429, "Too many requests. Please wait a moment and try again.")
		}})
}
