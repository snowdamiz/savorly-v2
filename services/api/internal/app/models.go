package app

import (
	"bytes"
	"encoding/json"
	"errors"
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
	// A photo of this step, held to the same rules as the recipe's own photos.
	Image string `json:"image,omitempty"`
	// A short clip of this step, held to the same rules as the recipe's own video.
	Video string `json:"video,omitempty"`
	// Where one of the recipe's family recordings says this step (family.go).
	Voice *StepVoice `json:"voice,omitempty"`
	// What the meal timeline needs of the step (meal_timeline.go); nil when nobody said.
	Timing *StepTiming `json:"timing,omitempty"`
	// Whether the request named an image, a video, a voice or timing at all: older apps and the
	// sous-chef never do, and then a saved recipe keeps its step photos, clips, voices and timing
	// (keepStepMedia, keepStepVoices, keepStepTiming).
	imageSet, videoSet, voiceSet, timingSet bool
}

// StepTiming is how a step spends its time, for cooking several dishes at once: the seconds that
// need the cook's hands and those that need no attention (baking, simmering, resting), the oven's
// heat in °C while it runs (0 for none), and the burners it takes, each with its pot or pan. A
// step that heats the oven and takes no time is preheating it. Estimated is set when a model or
// a reading of the text guessed them, rather than the cook saying so.
type StepTiming struct {
	Active    int  `json:"active,omitempty"`
	Wait      int  `json:"wait,omitempty"`
	Oven      int  `json:"oven,omitempty"`
	Burners   int  `json:"burners,omitempty"`
	Estimated bool `json:"estimated,omitempty"`
}

// The bounds a step's timing is held to.
const (
	maxStepSeconds           = 86400
	minOvenHeat, maxOvenHeat = 50, 300
	maxStepBurners           = 6
)

func (t StepTiming) valid() bool {
	return t.Active >= 0 && t.Active <= maxStepSeconds && t.Wait >= 0 && t.Wait <= maxStepSeconds &&
		(t.Oven == 0 || (t.Oven >= minOvenHeat && t.Oven <= maxOvenHeat)) && t.Burners >= 0 && t.Burners <= maxStepBurners
}

func (s *Step) UnmarshalJSON(b []byte) error {
	var in struct {
		Title   string          `json:"title"`
		Text    string          `json:"text"`
		Seconds int             `json:"seconds"`
		Image   *string         `json:"image"`
		Video   *string         `json:"video"`
		Timing  json.RawMessage `json:"timing"`
		// Raw, so a voice of null (taken off the step) differs from none named.
		Voice json.RawMessage `json:"voice"`
	}
	if e := json.Unmarshal(b, &in); e != nil {
		return e
	}
	*s = Step{Title: in.Title, Text: in.Text, Seconds: in.Seconds, imageSet: in.Image != nil, videoSet: in.Video != nil, voiceSet: in.Voice != nil, timingSet: in.Timing != nil}
	if in.Voice != nil && string(in.Voice) != "null" {
		s.Voice = new(StepVoice)
		if e := json.Unmarshal(in.Voice, s.Voice); e != nil {
			return e
		}
	}
	if in.Image != nil {
		s.Image = *in.Image
	}
	if in.Video != nil {
		s.Video = *in.Video
	}
	// "timing": null says the step has none, so the server's estimate takes its place.
	if in.Timing != nil && string(in.Timing) != "null" {
		var t StepTiming
		if e := json.Unmarshal(in.Timing, &t); e != nil {
			return e
		}
		s.Timing = &t
	}
	return nil
}

// keepStepMedia gives steps that didn't name an image the photo of the saved step with the same
// text, or else of the step in the same place with the same title, and steps that didn't name a
// video that step's clip in the same way, so editing a recipe in an app or with the sous-chef
// that doesn't know step photos or clips never drops them.
func keepStepMedia(steps, saved []Step) {
	keep := func(named func(*Step) bool, media func(*Step) *string) {
		byText := map[string]string{}
		for i := range saved {
			if m := *media(&saved[i]); m != "" {
				byText[strings.TrimSpace(saved[i].Text)] = m
			}
		}
		for i := range steps {
			if named(&steps[i]) {
				continue
			}
			if m, ok := byText[strings.TrimSpace(steps[i].Text)]; ok {
				*media(&steps[i]) = m
			} else if i < len(saved) && *media(&saved[i]) != "" && strings.EqualFold(strings.TrimSpace(saved[i].Title), strings.TrimSpace(steps[i].Title)) {
				*media(&steps[i]) = *media(&saved[i])
			}
		}
	}
	keep(func(s *Step) bool { return s.imageSet }, func(s *Step) *string { return &s.Image })
	keep(func(s *Step) bool { return s.videoSet }, func(s *Step) *string { return &s.Video })
}

// keepStepTiming gives steps that didn't name their timing that of the saved step with the same
// text, so a write from an app or the sous-chef that doesn't know timing keeps it. A step whose
// text changed has none until it is given or estimated again: its old timing may no longer fit.
func keepStepTiming(steps, saved []Step) {
	byText := map[string]*StepTiming{}
	for _, st := range saved {
		if st.Timing != nil {
			byText[strings.TrimSpace(st.Text)] = st.Timing
		}
	}
	for i := range steps {
		if t, ok := byText[strings.TrimSpace(steps[i].Text)]; ok && !steps[i].timingSet {
			copied := *t
			steps[i].Timing = &copied
		}
	}
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
	// ISO 639-1 code of the recipe's own text; "" leaves a saved recipe's language as it is.
	Language string `json:"language"`
	// The page an imported recipe came from. nil (older apps send none) leaves a saved recipe's
	// as it is; "" removes it.
	SourceURL *string `json:"sourceUrl,omitempty"`
	// The recipe this one adapts; see RecipeRef.
	DerivedFrom RecipeRef `json:"derivedFrom,omitzero"`
	// What it needs besides ingredients (pots, pans, appliances, tools), in the author's order and
	// words. nil (older apps and sous-chef drafts send none) leaves a saved recipe's as it is; []
	// removes them.
	Equipment []string `json:"equipment,omitempty"`
}

// RecipeRef is derivedFrom in a recipe write: a recipe id to link, or "" to remove the link. A
// missing field, null, or the {id,title,author} object recipe JSON carries (which older apps
// send back as they got it) leaves a saved recipe's link as it is.
type RecipeRef struct {
	ID  string
	Set bool
}

func (r *RecipeRef) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	switch {
	case len(b) > 0 && b[0] == '"':
		var id string
		if e := json.Unmarshal(b, &id); e != nil {
			return e
		}
		*r = RecipeRef{ID: strings.TrimSpace(id), Set: true}
	case bytes.Equal(b, []byte("null")) || (len(b) > 0 && b[0] == '{'):
		*r = RecipeRef{}
	default:
		return errors.New("derivedFrom must be a recipe id")
	}
	return nil
}

func (r RecipeRef) MarshalJSON() ([]byte, error) {
	if !r.Set {
		return []byte("null"), nil
	}
	return json.Marshal(r.ID)
}

// The languages the app is translated into, which are the ones narration can read.
var recipeLanguages = map[string]bool{"en": true, "fr": true, "de": true, "ru": true, "es": true, "it": true, "pt": true, "zh": true, "ja": true}

// recipeLanguage accepts a listed code, also as a tag like "pt-BR".
func recipeLanguage(s string) (string, bool) {
	s = strings.ToLower(strings.TrimSpace(s))
	if i := strings.IndexAny(s, "-_"); i > 0 {
		s = s[:i]
	}
	return s, s == "" || recipeLanguages[s]
}

// cleanTags trims tags and drops blank and repeated ones, keeping the first spelling.
func cleanTags(tags []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, t := range tags {
		t = strings.TrimSpace(t)
		if k := strings.ToLower(t); t != "" && !seen[k] {
			seen[k] = true
			out = append(out, t)
		}
	}
	return out
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

// validSourceURL accepts "" or an http(s) address of up to 500 characters without credentials.
func validSourceURL(s string) bool {
	if s == "" {
		return true
	}
	u, e := url.Parse(s)
	return e == nil && utf8.RuneCountInString(s) <= 500 && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != "" && u.User == nil
}

func (r *RecipeInput) Validate() error {
	r.Title = strings.TrimSpace(r.Title)
	r.Description = strings.TrimSpace(r.Description)
	r.Cuisine = normalizeCuisine(r.Cuisine)
	if r.Tags != nil {
		r.Tags = cleanTags(r.Tags)
	}
	if r.Equipment != nil {
		r.Equipment = cleanTags(r.Equipment)
	}
	for i := range r.Ingredients {
		in := &r.Ingredients[i]
		in.Name, in.Unit, in.Category = strings.TrimSpace(in.Name), strings.TrimSpace(in.Unit), strings.TrimSpace(in.Category)
	}
	for i := range r.Steps {
		st := &r.Steps[i]
		st.Title, st.Text, st.Image, st.Video = strings.TrimSpace(st.Title), strings.TrimSpace(st.Text), strings.TrimSpace(st.Image), strings.TrimSpace(st.Video)
	}
	if lang, ok := recipeLanguage(r.Language); ok {
		r.Language = lang
	} else {
		return fiber.NewError(400, "Choose a supported recipe language.")
	}
	if r.SourceURL != nil {
		source := strings.TrimSpace(*r.SourceURL)
		if !validSourceURL(source) {
			return fiber.NewError(400, "The source link must start with http:// or https:// and be at most 500 characters.")
		}
		r.SourceURL = &source
	}
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
		return fiber.NewError(400, "You can add up to 8 extra photos.")
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
		if !validText(s.Title, 1, 120) || !validText(s.Text, 5, 3000) || s.Seconds < 0 || s.Seconds > maxStepSeconds {
			return fiber.NewError(400, "Each step needs a title and instructions.")
		}
		if !validMedia(s.Image) || !validMedia(s.Video) {
			return fiber.NewError(400, "Media must use an HTTPS URL.")
		}
		if s.Timing != nil && !s.Timing.valid() {
			return fiber.NewError(400, "Check each step's timing.")
		}
	}
	for _, t := range r.Tags {
		if !validText(t, 1, 40) {
			return fiber.NewError(400, "Tags must be between 1 and 40 characters.")
		}
	}
	if len(r.Equipment) > maxEquipment {
		return fiber.NewError(400, "List up to 20 pieces of equipment.")
	}
	for _, e := range r.Equipment {
		if !validText(e, 1, equipmentNameLength) {
			return fiber.NewError(400, "Name each piece of equipment in 60 characters or fewer.")
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
