package app

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
)

// Cloudflare Turnstile keeps scripts away from sign-up and password-reset email. It is off until
// TURNSTILE_SECRET_KEY is set; the app renders the widget with the public TURNSTILE_SITE_KEY.
// https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
var turnstileEndpoint = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
var turnstileHTTP = &http.Client{Timeout: 10 * time.Second}

func turnstileEnabled() bool { return os.Getenv("TURNSTILE_SECRET_KEY") != "" }

// turnstileSiteKey is what the app needs to show the widget, and only when the server checks it.
func turnstileSiteKey() string {
	if !turnstileEnabled() {
		return ""
	}
	return os.Getenv("TURNSTILE_SITE_KEY")
}

// verifyTurnstile checks the widget's token with Cloudflare. Once configured it fails closed:
// if Cloudflare can't be asked, the request is refused rather than let through unchecked.
func verifyTurnstile(c fiber.Ctx, token string) error {
	if !turnstileEnabled() {
		return nil
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return fiber.NewError(400, "Complete the security check to continue.")
	}
	// Cloudflare's tokens are at most 2048 characters.
	if len(token) > 2048 {
		return fiber.NewError(400, "The security check didn't pass. Please try again.")
	}
	form := url.Values{"secret": {os.Getenv("TURNSTILE_SECRET_KEY")}, "response": {token}}
	if ip := c.IP(); ip != "" {
		form.Set("remoteip", ip)
	}
	unavailable := fiber.NewError(503, "The security check is unavailable right now. Please try again in a moment.")
	req, e := http.NewRequestWithContext(c.Context(), "POST", turnstileEndpoint, strings.NewReader(form.Encode()))
	if e != nil {
		return e
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, e := turnstileHTTP.Do(req)
	if e != nil {
		slog.Error("turnstile verification failed", "error", e)
		return unavailable
	}
	defer res.Body.Close()
	var out struct {
		Success    bool     `json:"success"`
		ErrorCodes []string `json:"error-codes"`
	}
	if e = json.NewDecoder(io.LimitReader(res.Body, 1<<16)).Decode(&out); e != nil || res.StatusCode != 200 {
		slog.Error("turnstile verification failed", "status", res.StatusCode, "error", e)
		return unavailable
	}
	if out.Success {
		return nil
	}
	// Our own misconfiguration or Cloudflare's trouble isn't the visitor's fault.
	for _, code := range []string{"missing-input-secret", "invalid-input-secret", "internal-error"} {
		if slices.Contains(out.ErrorCodes, code) {
			slog.Error("turnstile verification failed", "codes", out.ErrorCodes)
			return unavailable
		}
	}
	return fiber.NewError(400, "The security check didn't pass. Please try again.")
}
