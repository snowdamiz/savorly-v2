package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
)

func TestHandleRules(t *testing.T) {
	for h, valid := range map[string]bool{
		"alexrivera": true, "alex.rivera": true, "alex_rivera": true, "a1b": true, "cook2026": true,
		"ab": false, "alex rivera": false, "alex-rivera": false, "Alex": false, ".alex": false,
		"alex.": false, "alex..rivera": false, "_alex": false, "josé": false,
		strings.Repeat("a", 24): true, strings.Repeat("a", 25): false,
	} {
		if validHandle(h) != valid {
			t.Errorf("validHandle(%q) = %v", h, !valid)
		}
	}
	if got := normalizeHandle("  @Alex.Rivera "); got != "alex.rivera" {
		t.Errorf("normalizeHandle = %q", got)
	}
	for name, want := range map[string]string{
		"Alex Rivera":                   "alexrivera",
		"José García":                   "josegarcia",
		"Zoë O'Brien":                   "zoeobrien",
		"Al":                            "alcooks",
		"Анна Петрова":                  "cook",
		"李小龍":                           "cook",
		"Bartholomew Montgomery-Smythe": "bartholomewmontgom",
	} {
		if got := handleBase(name); got != want || !validHandle(got) {
			t.Errorf("handleBase(%q) = %q, want %q", name, got, want)
		}
	}
}

func profileServer(a *App) *fiber.App {
	f := fiber.New()
	as := func(h fiber.Handler) fiber.Handler {
		return func(c fiber.Ctx) error { c.Locals("userID", c.Get("Test-User")); return h(c) }
	}
	f.Patch("/me", as(a.updateMe))
	f.Get("/handles/:handle", as(a.handleAvailability))
	return f
}

func profileRequest(t *testing.T, f *fiber.App, method, path, user string, body any) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(jsonBytes(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Test-User", user)
	res, e := f.Test(req, fiber.TestConfig{Timeout: 30 * time.Second})
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func TestHandlesCanBeChosenOnceEach(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	testUser(t, db, "first")
	testUser(t, db, "second")
	// Older kitchens keep generated handles that today's rules reject; saving a profile keeps them.
	if _, e := db.Exec(ctx, `UPDATE users SET handle='test cook-1a2b3c' WHERE id='first'`); e != nil {
		t.Fatal(e)
	}
	f := profileServer(&App{DB: db})
	profile := func(handle any) fiber.Map {
		p := fiber.Map{"name": "Test cook", "bio": "", "avatar": "", "preferences": fiber.Map{"diets": []string{}, "allergies": []string{}}}
		if handle != nil {
			p["handle"] = handle
		}
		return p
	}
	if status, out := profileRequest(t, f, "PATCH", "/me", "first", profile(nil)); status != 200 || out["handle"] != "test cook-1a2b3c" {
		t.Fatalf("profile without a handle: %d %v", status, out)
	}
	if status, out := profileRequest(t, f, "PATCH", "/me", "first", profile("test cook-1a2b3c")); status != 200 || out["handle"] != "test cook-1a2b3c" {
		t.Fatalf("unchanged legacy handle: %d %v", status, out)
	}
	if status, out := profileRequest(t, f, "PATCH", "/me", "first", profile("@Lemon.Lover")); status != 200 || out["handle"] != "lemon.lover" {
		t.Fatalf("new handle: %d %v", status, out)
	}
	if status, _ := profileRequest(t, f, "PATCH", "/me", "second", profile("lemon.lover")); status != 409 {
		t.Fatalf("taken handle: %d", status)
	}
	if status, _ := profileRequest(t, f, "PATCH", "/me", "second", profile("support")); status != 409 {
		t.Fatalf("reserved handle: %d", status)
	}
	if status, _ := profileRequest(t, f, "PATCH", "/me", "second", profile("no spaces")); status != 400 {
		t.Fatalf("invalid handle: %d", status)
	}
	for _, c := range []struct {
		user, handle     string
		valid, available bool
	}{
		{"second", "lemon.lover", true, false},
		{"first", "lemon.lover", true, true},
		{"second", "fresh.basil", true, true},
		{"second", "savorly", true, false},
		{"second", "x", false, false},
	} {
		status, out := profileRequest(t, f, "GET", "/handles/"+c.handle, c.user, nil)
		if status != 200 || out["valid"] != c.valid || out["available"] != c.available {
			t.Errorf("%s checks %q: %d %v", c.user, c.handle, status, out)
		}
	}
	// New kitchens get the plain name when it's free and a numbered one when it isn't.
	if _, e := db.Exec(ctx, `UPDATE users SET handle='alexrivera' WHERE id='second'`); e != nil {
		t.Fatal(e)
	}
	h, e := freeHandle(ctx, db, "Alex Rivera")
	if e != nil || h == "alexrivera" || !strings.HasPrefix(h, "alexrivera") || !validHandle(h) {
		t.Fatalf("suggested %q: %v", h, e)
	}
	if h, e = freeHandle(ctx, db, "Fresh Basil"); e != nil || h != "freshbasil" {
		t.Fatalf("suggested %q: %v", h, e)
	}
}
