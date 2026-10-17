package app

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v3"
)

func TestClientIPComesFromGatewayHeaderOnlyWhenConfigured(t *testing.T) {
	for _, tc := range []struct {
		header, want string
	}{{"", "0.0.0.0"}, {"X-Savorly-Client-IP", "203.0.113.9"}} {
		f := New(nil, Config{Origins: []string{"http://localhost:8081"}, ProxyHeader: tc.header})
		f.Get("/client-ip", func(c fiber.Ctx) error { return c.SendString(c.IP()) })
		req := httptest.NewRequest("GET", "/client-ip", nil)
		req.Header.Set("X-Savorly-Client-IP", "203.0.113.9")
		res, e := f.Test(req)
		if e != nil {
			t.Fatal(e)
		}
		got, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if string(got) != tc.want {
			t.Errorf("proxy header %q: client IP %q, want %q", tc.header, got, tc.want)
		}
	}
}

func TestRateLimitAnswersInJSON(t *testing.T) {
	f := New(nil, Config{Origins: []string{"http://localhost:8081"}})
	f.Get("/ping", func(c fiber.Ctx) error { return c.SendString("ok") })
	var res *http.Response
	for i := 0; i <= 300; i++ {
		var e error
		if res, e = f.Test(httptest.NewRequest("GET", "/ping", nil)); e != nil {
			t.Fatal(e)
		}
		if i < 300 {
			res.Body.Close()
		}
	}
	defer res.Body.Close()
	var body map[string]string
	if res.StatusCode != 429 || json.NewDecoder(res.Body).Decode(&body) != nil || body["error"] == "" {
		t.Fatalf("over the limit: %d %v", res.StatusCode, body)
	}
}
