package app

import (
	"fmt"
	"regexp"
	"sort"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
)

// publicRoutes answer without a session. Every other route must turn guests away, so a route
// added without requireAuth fails TestPrivateRoutesTurnGuestsAway until it is listed here.
var publicRoutes = map[string]bool{
	"GET /health":                 true,
	"GET /v1/capabilities":        true,
	"GET /v1/session":             true,
	"POST /v1/auth/register":      true,
	"POST /v1/auth/login":         true,
	"POST /v1/auth/forgot":        true,
	"POST /v1/auth/reset":         true,
	"POST /v1/auth/nonce":         true,
	"POST /v1/auth/oauth":         true,
	"GET /v1/recipes":             true,
	"GET /v1/recipes/:id":         true,
	"GET /v1/recipes/:id/reviews": true,
	"GET /v1/creators":            true,
	"GET /v1/creators/:id":        true,
	"GET /v1/feed":                true, // personal shelf only when signed in
	"GET /v1/sitemap":             true,
	"POST /v1/billing/webhook":    true, // Stripe signs it
	"GET /v1/export/:token":       true, // the single-use token is the credential
	"POST /v1/client-errors":      true,

	// A session only adds canDelete to comments, and lets an owner open a private cookbook.
	"GET /v1/recipes/:id/variations": true,
	"GET /v1/recipes/:id/comments":   true,
	"GET /v1/recipes/:id/cooks":      true,
	"GET /v1/cookbooks/:id":          true,
	"GET /v1/creators/:id/cookbooks": true,
	"POST /v1/events":                true, // anonymous analytics; names the member when signed in

	// Guests read the translations members made; making one needs a session (translations.go).
	"GET /v1/recipes/:id/translation": true,
}

// Rejections the middleware makes before a handler runs.
const (
	signInRequired  = "Sign in to your kitchen to continue."
	originForbidden = "Origin is not allowed."
	originRequired  = "An Origin header is required."
)

type route struct{ method, path string }

func (r route) String() string { return r.method + " " + r.path }

// routes lists what the router serves, as registered. HEAD routes mirror GET ones.
func routes(f *fiber.App) []route {
	seen := map[route]bool{}
	out := []route{}
	for _, r := range f.GetRoutes(true) {
		k := route{r.Method, r.Path}
		if r.Method == fiber.MethodHead || seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, k)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].String() < out[j].String() })
	return out
}

var routeParam = regexp.MustCompile(`:[A-Za-z_]+`)

// concrete fills a route's parameters with an id nothing has.
func concrete(path string) string { return routeParam.ReplaceAllString(path, "1") }

func mutation(method string) bool { return method != fiber.MethodGet && method != fiber.MethodHead }

// clientIP hands every request its own address, so the shared per-IP limits don't interfere.
func clientIP() func() string {
	n := 0
	return func() string { n++; return fmt.Sprintf("10.%d.%d.%d", n>>16&255, n>>8&255, n&255) }
}

func TestPrivateRoutesTurnGuestsAway(t *testing.T) {
	f := New(nil, Config{Origins: []string{testOrigin}, ProxyHeader: testIPHeader})
	ip := clientIP()
	listed := map[string]bool{}
	private := 0
	for _, r := range routes(f) {
		listed[r.String()] = true
		if publicRoutes[r.String()] {
			continue
		}
		private++
		var body any
		if mutation(r.method) {
			body = fiber.Map{}
		}
		if got := do(t, f, call{method: r.method, path: concrete(r.path), ip: ip(), body: body}); got.status != 401 || got.message() != signInRequired {
			t.Errorf("%s answered a guest with %d %s; if it is meant to be public, add it to publicRoutes", r, got.status, got.body)
		}
	}
	for r := range publicRoutes {
		if !listed[r] {
			t.Errorf("publicRoutes lists %s, which the router no longer serves", r)
		}
	}
	if private < 60 {
		t.Fatalf("only %d private routes found; is the route list complete?", private)
	}
}

// Browsers carry the session in a cookie, which a forged cross-site form would send too, so a
// cookie mutation needs an allowed Origin. Native apps send a bearer token and no Origin.
func TestCookieMutationsNeedAnAllowedOrigin(t *testing.T) {
	db := isolatedDB(t)
	for _, key := range []string{"OPENROUTER_API_KEY", "OPENAI_API_KEY", "REAPI_API_KEY", "STRIPE_SECRET_KEY", "PAID_PLANS", "S3_ENDPOINT",
		"CLOUDFLARE_EMAIL_API_TOKEN", "TURNSTILE_SECRET_KEY", "GOOGLE_WEB_CLIENT_ID", "APPLE_BUNDLE_ID", "APPLE_SERVICES_ID"} {
		t.Setenv(key, "")
	}
	// An owner, so the admin console's routes reach their handlers too.
	t.Setenv("ADMIN_EMAILS", "router@example.test")
	f := accountsApp(db, false)
	id := member(t, db, "router@example.test")
	session := func() string { return deviceSession(t, db, id, laptopUA, 20*24*time.Hour) }
	ip := clientIP()
	blocked := func(r reply) bool {
		m := r.message()
		return m == signInRequired || m == originForbidden || m == originRequired
	}
	for _, r := range routes(f) {
		path := concrete(r.path)
		public := publicRoutes[r.String()]
		t.Run(r.String(), func(t *testing.T) {
			if mutation(r.method) {
				for _, c := range []struct {
					origin, want string
				}{{"https://evil.example", originForbidden}, {"", originRequired}} {
					got := do(t, f, call{method: r.method, path: path, ip: ip(), cookie: session(), origin: c.origin, body: fiber.Map{}})
					if got.status != 403 || got.message() != c.want {
						t.Errorf("cookie with origin %q: %d %s", c.origin, got.status, got.body)
					}
				}
			}
			if public {
				return
			}
			var body any
			if mutation(r.method) {
				body = fiber.Map{}
				if got := do(t, f, call{method: r.method, path: path, ip: ip(), cookie: session(), origin: testOrigin, body: body}); blocked(got) {
					t.Errorf("cookie with an allowed origin was turned away: %d %s", got.status, got.body)
				}
			}
			if got := do(t, f, call{method: r.method, path: path, ip: ip(), bearer: session(), body: body}); blocked(got) {
				t.Errorf("bearer token without an origin was turned away: %d %s", got.status, got.body)
			}
		})
	}
}
