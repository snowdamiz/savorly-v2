package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/gofiber/fiber/v3"
)

// Transactional email goes through Cloudflare Email Service's REST API: the sending domain
// is onboarded in the Cloudflare account, and the token only needs Email Sending: Edit.
// https://developers.cloudflare.com/email-service/get-started/send-emails/
var cloudflareAPI = "https://api.cloudflare.com/client/v4"
var emailHTTP = &http.Client{Timeout: 15 * time.Second}

func emailEnabled() bool {
	return os.Getenv("CLOUDFLARE_ACCOUNT_ID") != "" && os.Getenv("CLOUDFLARE_EMAIL_API_TOKEN") != "" && os.Getenv("EMAIL_FROM") != ""
}

// sendEmail sends one plain-text message. Errors describe the failure without recipient
// addresses, so callers can log them.
func sendEmail(ctx context.Context, to, subject, text string) error {
	payload := jsonBytes(fiber.Map{"from": os.Getenv("EMAIL_FROM"), "to": []string{to}, "subject": subject, "text": text})
	endpoint := cloudflareAPI + "/accounts/" + url.PathEscape(os.Getenv("CLOUDFLARE_ACCOUNT_ID")) + "/email/sending/send"
	req, e := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(payload))
	if e != nil {
		return e
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("CLOUDFLARE_EMAIL_API_TOKEN"))
	req.Header.Set("Content-Type", "application/json")
	res, e := emailHTTP.Do(req)
	if e != nil {
		return e
	}
	defer res.Body.Close()
	var out struct {
		Success bool
		Errors  []struct {
			Code    int
			Message string
		}
		Result struct {
			PermanentBounces     []string `json:"permanent_bounces"`
			SuppressedRecipients []string `json:"suppressed_recipients"`
		}
	}
	_ = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&out)
	switch {
	case res.StatusCode >= 300 || !out.Success:
		if len(out.Errors) > 0 {
			return fmt.Errorf("email rejected: status %d, code %d", res.StatusCode, out.Errors[0].Code)
		}
		return fmt.Errorf("email rejected: status %d", res.StatusCode)
	case len(out.Result.PermanentBounces) > 0:
		return fmt.Errorf("email bounced permanently")
	case len(out.Result.SuppressedRecipients) > 0:
		return fmt.Errorf("email recipient is on the suppression list")
	}
	return nil
}
