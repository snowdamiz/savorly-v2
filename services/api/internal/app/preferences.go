package app

import (
	"encoding/json"

	"github.com/gofiber/fiber/v3"
)

// Preferences live in users.preferences next to the diets and allergies that PATCH /me sets:
// units (metric or imperial; empty follows the device), language (one of the app's nine; empty
// follows the device), which is also the language of push notifications, which notifications to
// send, translateRecipes, whether recipes in other languages open translated into the app's
// (translations.go), and shareDiet, whether the member's household sees their diets and
// allergies, so recipes warn about them for everyone (food_index.go), and shareCooking, whether
// their cooking counts toward recipes' insights: how long steps take and what cooks ask
// (cook_insights.go). Each writer merges its own keys, so neither undoes the other.

// preferencesJSON is the member's preferences (alias u) with every key filled in: units and
// language empty, recipes as written, and every notification on, until changed.
const preferencesJSON = `(jsonb_build_object('diets','[]'::jsonb,'allergies','[]'::jsonb,'units','','language','','translateRecipes',false,'shareDiet',false,'shareCooking',true) || u.preferences
 || jsonb_build_object('notifications',jsonb_build_object('follows',true,'pantry',true,'reviews',true,'comments',true)
  || CASE WHEN jsonb_typeof(u.preferences->'notifications')='object' THEN u.preferences->'notifications' ELSE '{}'::jsonb END))`

// notificationKinds are the switches under preferences.notifications: new recipes from cooks
// the member follows, pantry items about to expire, and reviews and comments on their recipes.
var notificationKinds = []string{"follows", "pantry", "reviews", "comments"}

// updatePreferences merges what it is sent; anything left out stays as it was.
func (a *App) updatePreferences(c fiber.Ctx) error {
	var in map[string]json.RawMessage
	if e := decode(c, &in); e != nil {
		return e
	}
	top := map[string]any{}
	if raw, ok := in["units"]; ok {
		var units string
		if json.Unmarshal(raw, &units) != nil || (units != "" && units != "metric" && units != "imperial") {
			return fiber.NewError(400, "Choose metric or imperial units.")
		}
		top["units"] = units
	}
	if raw, ok := in["language"]; ok {
		var language string
		if json.Unmarshal(raw, &language) != nil {
			return fiber.NewError(400, "Choose a supported language.")
		}
		code, valid := recipeLanguage(language)
		if !valid {
			return fiber.NewError(400, "Choose a supported language.")
		}
		top["language"] = code
	}
	if raw, ok := in["translateRecipes"]; ok {
		var on bool
		if json.Unmarshal(raw, &on) != nil || string(raw) == "null" {
			return fiber.NewError(400, "Turn automatic translation on or off.")
		}
		top["translateRecipes"] = on
	}
	if raw, ok := in["shareDiet"]; ok {
		var on bool
		if json.Unmarshal(raw, &on) != nil || string(raw) == "null" {
			return fiber.NewError(400, "Turn sharing with your household on or off.")
		}
		top["shareDiet"] = on
	}
	// Keeping one's cooking out also takes back what it already added.
	forget := false
	if raw, ok := in["shareCooking"]; ok {
		var on bool
		if json.Unmarshal(raw, &on) != nil || string(raw) == "null" {
			return fiber.NewError(400, "Turn sharing your cooking on or off.")
		}
		top["shareCooking"], forget = on, !on
	}
	var notifications []byte // nil: unchanged
	if raw, ok := in["notifications"]; ok {
		var sent map[string]json.RawMessage
		if json.Unmarshal(raw, &sent) != nil || sent == nil {
			return fiber.NewError(400, "Turn each notification on or off.")
		}
		changed := map[string]bool{}
		for _, kind := range notificationKinds {
			if v, ok := sent[kind]; ok {
				var on bool
				if json.Unmarshal(v, &on) != nil || string(v) == "null" {
					return fiber.NewError(400, "Turn each notification on or off.")
				}
				changed[kind] = on
			}
		}
		notifications = jsonBytes(changed)
	}
	tx, e := a.DB.Begin(c.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(c.Context())
	_, e = tx.Exec(c.Context(), `UPDATE users SET preferences=preferences||$2::jsonb||CASE WHEN $3::jsonb IS NULL THEN '{}'::jsonb
 ELSE jsonb_build_object('notifications',CASE WHEN jsonb_typeof(preferences->'notifications')='object' THEN preferences->'notifications' ELSE '{}'::jsonb END||$3::jsonb) END
 WHERE id=$1`, userID(c), jsonBytes(top), notifications)
	if e != nil {
		return e
	}
	if forget {
		if e = forgetCooking(c.Context(), tx, userID(c)); e != nil {
			return e
		}
	}
	if e = tx.Commit(c.Context()); e != nil {
		return e
	}
	return a.me(c)
}
