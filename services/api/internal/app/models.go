package app

import (
	"encoding/json"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/gofiber/fiber/v3"
)

type Ingredient struct {
	Name     string  `json:"name"`
	Amount   float64 `json:"amount"`
	Unit     string  `json:"unit"`
	Category string  `json:"category"`
}
type Step struct {
	Title   string `json:"title"`
	Text    string `json:"text"`
	Seconds int    `json:"seconds"`
}
type RecipeInput struct {
	Title       string       `json:"title"`
	Description string       `json:"description"`
	Cuisine     string       `json:"cuisine"`
	Minutes     int          `json:"minutes"`
	Servings    int          `json:"servings"`
	Difficulty  string       `json:"difficulty"`
	Image       string       `json:"image"`
	Photos      []string     `json:"photos"` // nil means "leave the gallery as it is"
	Video       string       `json:"video"`
	Ingredients []Ingredient `json:"ingredients"`
	Steps       []Step       `json:"steps"`
	Tags        []string     `json:"tags"`
	Calories    int          `json:"calories"`
	AIGenerated bool         `json:"aiGenerated"`
	Published   bool         `json:"published"`
}

func validText(s string, min, max int) bool {
	n := utf8.RuneCountInString(strings.TrimSpace(s))
	return n >= min && n <= max
}
func validMedia(s string) bool {
	if s == "" {
		return true
	}
	u, e := url.Parse(s)
	if e != nil || u.User != nil {
		return false
	}
	return (u.Scheme == "https" && u.Host != "") || (u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1"))
}
func (r *RecipeInput) Validate() error {
	r.Title = strings.TrimSpace(r.Title)
	r.Description = strings.TrimSpace(r.Description)
	if !validText(r.Title, 3, 120) || !validText(r.Description, 10, 3000) || !validText(r.Cuisine, 2, 60) {
		return fiber.NewError(400, "Add a title, description, and cuisine.")
	}
	if r.Minutes < 1 || r.Minutes > 1440 || r.Servings < 1 || r.Servings > 100 || r.Calories < 0 || r.Calories > 10000 {
		return fiber.NewError(400, "Check the cooking time, servings, and calories.")
	}
	if r.Difficulty != "Easy" && r.Difficulty != "Medium" && r.Difficulty != "Advanced" {
		return fiber.NewError(400, "Choose a valid difficulty.")
	}
	if !validMedia(r.Image) || !validMedia(r.Video) {
		return fiber.NewError(400, "Media must use an HTTPS URL.")
	}
	if len(r.Photos) > 8 {
		return fiber.NewError(400, "Add up to 8 more photos.")
	}
	for _, p := range r.Photos {
		if p == "" || !validMedia(p) {
			return fiber.NewError(400, "Media must use an HTTPS URL.")
		}
	}
	if len(r.Ingredients) < 1 || len(r.Ingredients) > 80 || len(r.Steps) < 1 || len(r.Steps) > 40 || len(r.Tags) > 12 {
		return fiber.NewError(400, "Add 1–80 ingredients and 1–40 steps.")
	}
	for _, i := range r.Ingredients {
		if !validText(i.Name, 1, 120) || i.Amount < 0 || i.Amount > 100000 || len(i.Unit) > 30 || len(i.Category) > 50 {
			return fiber.NewError(400, "Check your ingredient quantities and names.")
		}
	}
	for _, s := range r.Steps {
		if !validText(s.Title, 1, 120) || !validText(s.Text, 5, 3000) || s.Seconds < 0 || s.Seconds > 86400 {
			return fiber.NewError(400, "Each step needs a title and instructions.")
		}
	}
	for _, t := range r.Tags {
		if !validText(t, 1, 40) {
			return fiber.NewError(400, "Tags must be between 1 and 40 characters.")
		}
	}
	return nil
}
func decode(c fiber.Ctx, dst any) error {
	if err := json.Unmarshal(c.Body(), dst); err != nil {
		return fiber.NewError(400, "Invalid JSON request.")
	}
	return nil
}
func jsonBytes(v any) []byte { b, _ := json.Marshal(v); return b }
