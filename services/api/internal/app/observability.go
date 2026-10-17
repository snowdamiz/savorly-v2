package app

import (
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"regexp"
	"runtime/debug"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/gofiber/fiber/v3/middleware/requestid"
)

// SetupLogging writes JSON lines in production, where the platform collects the container's
// output, and readable text in development.
func SetupLogging(config Config) {
	var h slog.Handler = slog.NewTextHandler(os.Stderr, nil)
	if config.Production {
		h = slog.NewJSONHandler(os.Stderr, nil)
	}
	slog.SetDefault(slog.New(h))
	warnMisconfiguration(config)
}

// warnMisconfiguration flags settings a deployment can't be run well without.
func warnMisconfiguration(config Config) {
	if config.Production && len(ownerEmails()) == 0 {
		slog.Warn("ADMIN_EMAILS is empty, so no one can open the admin console")
	}
	if turnstileEnabled() && os.Getenv("TURNSTILE_SITE_KEY") == "" {
		slog.Warn("TURNSTILE_SECRET_KEY is set without TURNSTILE_SITE_KEY, so the app can't pass the sign-up check")
	}
}

// accessLog writes one line per request. It renders errors itself, so the line carries the
// status the client actually received.
func accessLog(c fiber.Ctx) error {
	if c.Path() == "/health" {
		return c.Next()
	}
	start := time.Now()
	if err := c.Next(); err != nil {
		if e := c.App().ErrorHandler(c, err); e != nil {
			_ = c.SendStatus(fiber.StatusInternalServerError)
		}
	}
	res := c.Response()
	// Reading a streamed body would consume it; streams report their declared length, or -1.
	size := res.Header.ContentLength()
	if !res.IsBodyStream() {
		size = len(res.Body())
	}
	status := res.StatusCode()
	attrs := []any{"method", c.Method(), "route", routeOf(c), "status", status,
		"durationMs", time.Since(start).Milliseconds(), "bytes", size, "requestId", requestid.FromContext(c)}
	if id := userID(c); id != "" {
		attrs = append(attrs, "userId", id)
	}
	level := slog.LevelInfo
	if status >= 500 {
		level = slog.LevelError
	}
	slog.Log(c.Context(), level, "request", attrs...)
	return nil
}

// routeOf is the matched route's pattern, so ids and tokens stay out of the logs. Requests turned
// away before routing log their path, with the one secret a path carries masked.
func routeOf(c fiber.Ctx) string {
	if c.Matched() {
		return c.Route().Path
	}
	if p := c.Path(); !strings.HasPrefix(p, "/v1/export/") {
		return p
	}
	return "/v1/export/:token"
}

func logPanic(c fiber.Ctx, e any) {
	slog.Error("panic", "panic", fmt.Sprint(e), "method", c.Method(), "route", routeOf(c), "requestId", requestid.FromContext(c), "stack", string(debug.Stack()))
}

var narrationAudio = regexp.MustCompile(`^/v1/recipes/[^/]+/steps/[^/]+/narration/[^/]+$`)

// skipCompression keeps streamed responses out of the compressor, which would buffer them:
// narration audio (already compressed, and sent while it is generated) and event streams.
func skipCompression(c fiber.Ctx) bool {
	return narrationAudio.MatchString(c.Path()) || strings.Contains(c.Get("Accept"), "text/event-stream")
}

// clientError logs a crash the app reported, one line per report. Reports need no session, but
// carry the member when there is one.
func (a *App) clientError(c fiber.Ctx) error {
	if len(c.Body()) > 16<<10 {
		return fiber.NewError(413, "This report is too large.")
	}
	var in struct {
		Message        string `json:"message"`
		Stack          string `json:"stack"`
		ComponentStack string `json:"componentStack"`
		Platform       string `json:"platform"`
		AppVersion     string `json:"appVersion"`
		URL            string `json:"url"`
		Release        string `json:"release"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	if strings.TrimSpace(in.Message) == "" && strings.TrimSpace(in.Stack) == "" {
		return fiber.NewError(400, "Describe the error in the report.")
	}
	attrs := []any{"message", truncate(in.Message, 1000), "stack", truncate(in.Stack, 8000), "componentStack", truncate(in.ComponentStack, 4000),
		"platform", truncate(in.Platform, 40), "appVersion", truncate(in.AppVersion, 40), "release", truncate(in.Release, 80),
		"url", truncate(reportURL(in.URL), 500), "userAgent", userAgent(c), "requestId", requestid.FromContext(c)}
	if tok, _ := sessionToken(c); tok != "" {
		if id := a.signedInUser(c); id != "" {
			attrs = append(attrs, "userId", id)
		}
	}
	slog.Error("client error", attrs...)
	return c.SendStatus(204)
}

var secretParam = regexp.MustCompile(`(?i)token|code|secret|password|key|nonce|state|session|auth|email`)

// reportURL drops the fragment and masks query values that could carry a credential, such as a
// sign-in redirect's code.
func reportURL(raw string) string {
	u, e := url.Parse(strings.TrimSpace(raw))
	if e != nil {
		return ""
	}
	u.Fragment, u.RawFragment, u.User = "", "", nil
	q := u.Query()
	for k := range q {
		if secretParam.MatchString(k) {
			q.Set(k, "redacted")
		}
	}
	u.RawQuery = q.Encode()
	return u.String()
}
