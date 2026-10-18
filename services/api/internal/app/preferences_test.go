package app

import (
	"encoding/json"
	"reflect"
	"testing"
)

type preferencesReply struct {
	Diets, Allergies []string
	Units, Language  string
	Notifications    map[string]bool
}

func TestPreferencesMergeAndKeepTheirDefaults(t *testing.T) {
	db := isolatedDB(t)
	testUser(t, db, "cook")
	f := recipesApp(db, false)
	tok := bearerFor(t, db, "cook")
	prefs := func(method, path string, body any, want int) preferencesReply {
		t.Helper()
		status, b := callAPI(t, f, method, path, tok, body)
		var out struct{ Preferences preferencesReply }
		if status != want || json.Unmarshal(b, &out) != nil {
			t.Fatalf("%s %s %v: want %d, got %d: %s", method, path, body, want, status, b)
		}
		return out.Preferences
	}
	allOn := map[string]bool{"follows": true, "pantry": true, "reviews": true, "comments": true, "renewals": true, "cookAlong": true}
	if p := prefs("GET", "/v1/me", nil, 200); p.Units != "" || p.Language != "" || !reflect.DeepEqual(p.Notifications, allOn) || len(p.Diets) != 0 {
		t.Fatalf("defaults: %+v", p)
	}
	if p := prefs("PATCH", "/v1/me/preferences", map[string]any{"units": "imperial"}, 200); p.Units != "imperial" || p.Language != "" || !reflect.DeepEqual(p.Notifications, allOn) {
		t.Fatalf("units: %+v", p)
	}
	if p := prefs("PATCH", "/v1/me/preferences", map[string]any{"language": "pt-BR"}, 200); p.Units != "imperial" || p.Language != "pt" {
		t.Fatalf("language: %+v", p)
	}
	prefs("PATCH", "/v1/me/preferences", map[string]any{"notifications": map[string]bool{"pantry": false}}, 200)
	p := prefs("PATCH", "/v1/me/preferences", map[string]any{"notifications": map[string]bool{"reviews": false}}, 200)
	if want := map[string]bool{"follows": true, "pantry": false, "reviews": false, "comments": true, "renewals": true, "cookAlong": true}; !reflect.DeepEqual(p.Notifications, want) {
		t.Fatalf("notifications merge: %+v", p.Notifications)
	}
	for _, bad := range []map[string]any{
		{"units": "kelvin"}, {"units": 3}, {"language": "xx"}, {"language": true},
		{"notifications": map[string]any{"pantry": "no"}}, {"notifications": []bool{true}}, {"notifications": nil},
		{"notifications": map[string]any{"follows": nil}},
	} {
		status, b := callAPI(t, f, "PATCH", "/v1/me/preferences", tok, bad)
		if status != 400 {
			t.Errorf("%v: %d %s", bad, status, b)
		}
	}
	// Saving the profile form, which knows only diets and allergies, keeps the rest.
	status, b := callAPI(t, f, "PATCH", "/v1/me", tok, map[string]any{"name": "Test cook", "bio": "", "avatar": "", "preferences": map[string]any{"diets": []string{"Vegetarian"}, "allergies": []string{}}})
	if status != 200 {
		t.Fatalf("profile: %d %s", status, b)
	}
	if status, b = callAPI(t, f, "GET", "/v1/session", tok, nil); status != 200 {
		t.Fatalf("session: %d %s", status, b)
	}
	var session struct {
		User struct{ Preferences preferencesReply }
	}
	if json.Unmarshal(b, &session) != nil {
		t.Fatalf("session: %s", b)
	}
	p = session.User.Preferences
	if p.Units != "imperial" || p.Language != "pt" || p.Notifications["pantry"] || !p.Notifications["follows"] || len(p.Diets) != 1 || p.Diets[0] != "Vegetarian" {
		t.Fatalf("after the profile form: %+v", p)
	}
	// An empty patch changes nothing.
	if q := prefs("PATCH", "/v1/me/preferences", map[string]any{}, 200); !reflect.DeepEqual(q, p) {
		t.Fatalf("empty patch: %+v, want %+v", q, p)
	}
}
