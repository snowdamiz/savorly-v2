package app

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
)

// First-party product analytics: a short list of named events with a few properties each, so
// the admin console can show what people search for and where the kitchen setup loses them.
// No IP address or user agent is stored; an event names its member when one is signed in, is
// deleted with their account, and is kept 90 days (janitor.go). Only a search's query is free
// text; every other property is an id, a count, a flag or a short label.

type eventProp struct {
	kind     string // query, label, id, count, flag or step
	required bool
}

var eventProps = map[string]map[string]eventProp{
	"search":          {"query": {"query", true}, "results": {"count", true}},
	"recipe_open":     {"recipeId": {"id", true}, "from": {"label", false}},
	"cook_start":      {"recipeId": {"id", true}},
	"studio_start":    {"mode": {"label", true}},
	"share":           {"recipeId": {"id", true}},
	"onboarding_step": {"step": {"step", true}},
	"onboarding_done": {"skipped": {"flag", true}},
	"import":          {"method": {"label", true}},
}

var (
	eventLabel   = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,40}$`)
	eventID      = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	eventSession = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

const (
	eventBatch = 50
	// A client's own timestamp is used when it is at most this old (a batch sent late).
	eventAge = 7 * 24 * time.Hour
)

// normalizeQuery is how searches are counted: lowercase, single spaces, at most 80 characters.
func normalizeQuery(q string) string {
	q = strings.ToLower(strings.Join(strings.Fields(q), " "))
	if r := []rune(q); len(r) > 80 {
		q = strings.TrimSpace(string(r[:80]))
	}
	return q
}

// wholeNumber reads a JSON number that is a whole number from 0 to most.
func wholeNumber(raw json.RawMessage, most float64) (int, bool) {
	var f float64
	if json.Unmarshal(raw, &f) != nil || f < 0 || f > most || f != math.Trunc(f) {
		return 0, false
	}
	return int(f), true
}

// cleanEvent keeps an event's known properties, each in its expected form. It reports false for
// an event this server doesn't record: an unknown name, or a property missing or malformed.
func cleanEvent(name string, raw json.RawMessage) (map[string]any, bool) {
	schema, known := eventProps[name]
	if !known {
		return nil, false
	}
	sent := map[string]json.RawMessage{}
	if len(raw) > 0 && string(raw) != "null" && json.Unmarshal(raw, &sent) != nil {
		return nil, false
	}
	out := map[string]any{}
	for key, p := range schema {
		v, ok := sent[key]
		if !ok || string(v) == "null" {
			if p.required {
				return nil, false
			}
			continue
		}
		var s string
		switch p.kind {
		case "query":
			if json.Unmarshal(v, &s) != nil || normalizeQuery(s) == "" {
				return nil, false
			}
			out[key] = normalizeQuery(s)
		case "label", "id":
			pattern := eventLabel
			if p.kind == "id" {
				pattern = eventID
			}
			if json.Unmarshal(v, &s) != nil || !pattern.MatchString(s) {
				return nil, false
			}
			out[key] = s
		case "count":
			n, ok := wholeNumber(v, 1e6)
			if !ok {
				return nil, false
			}
			out[key] = n
		case "flag":
			var b bool
			if json.Unmarshal(v, &b) != nil {
				return nil, false
			}
			out[key] = b
		case "step":
			// A step's name, or its number.
			if json.Unmarshal(v, &s) == nil && eventLabel.MatchString(s) {
				out[key] = s
			} else if n, ok := wholeNumber(v, 100); ok {
				out[key] = strconv.Itoa(n)
			} else {
				return nil, false
			}
		}
	}
	return out, true
}

// recordEvents stores a batch of events from the app. Unknown or malformed events are dropped
// and the rest kept, so an app newer than the server loses only what this server doesn't know.
func (a *App) recordEvents(c fiber.Ctx) error {
	var in struct {
		Session string `json:"session"`
		Events  []struct {
			Name  string          `json:"name"`
			Props json.RawMessage `json:"props"`
			At    string          `json:"at"`
		} `json:"events"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	if !eventSession.MatchString(in.Session) {
		return fiber.NewError(400, "Send a session id of 1–64 letters, digits, dashes or underscores.")
	}
	if len(in.Events) > eventBatch {
		return fiber.NewError(400, "Send up to 50 events at a time.")
	}
	var names, props []string
	var times []time.Time
	now := time.Now()
	for _, ev := range in.Events {
		clean, ok := cleanEvent(ev.Name, ev.Props)
		if !ok {
			continue
		}
		at := now
		if t, e := time.Parse(time.RFC3339, ev.At); e == nil && t.After(now.Add(-eventAge)) && t.Before(now) {
			at = t // a device's clock a little ahead counts as now
		}
		names, props, times = append(names, ev.Name), append(props, string(jsonBytes(clean))), append(times, at)
	}
	if len(names) == 0 {
		return c.SendStatus(204)
	}
	user, e := a.sessionUser(c)
	if e != nil {
		return e
	}
	if _, e = a.DB.Exec(c.Context(), `INSERT INTO events(name,props,user_id,session,created_at)
 SELECT n,p::jsonb,NULLIF($4,''),$5,t FROM unnest($1::text[],$2::text[],$3::timestamptz[]) AS x(n,p,t)`, names, props, times, user, in.Session); e != nil {
		return e
	}
	return c.SendStatus(204)
}

// adminInsights summarizes the last 7 or 30 days of events for the admin console: the most
// common searches, those that found nothing, how many people reached each setup step, and
// how often each event happened. Setup steps count people (members, or app launches for
// guests); the rest count events.
func (a *App) adminInsights(c fiber.Ctx) error {
	days := 7
	switch c.Query("days") {
	case "", "7":
	case "30":
		days = 30
	default:
		return fiber.NewError(400, "Choose 7 or 30 days.")
	}
	return a.queryOne(c, `WITH e AS (SELECT name,props,user_id,session FROM events WHERE created_at>now()-$1*interval '1 day'),
 searches AS (SELECT props->>'query' AS query,props->'results'='0'::jsonb AS nothing FROM e WHERE name='search' AND props->>'query'<>'')
SELECT jsonb_build_object('days',$1::int,
 'topSearches',COALESCE((SELECT jsonb_agg(jsonb_build_object('query',query,'count',n) ORDER BY n DESC,query)
   FROM (SELECT query,count(*) n FROM searches GROUP BY query ORDER BY n DESC,query LIMIT 20) x),'[]'),
 'zeroResultSearches',COALESCE((SELECT jsonb_agg(jsonb_build_object('query',query,'count',n) ORDER BY n DESC,query)
   FROM (SELECT query,count(*) n FROM searches WHERE nothing GROUP BY query ORDER BY n DESC,query LIMIT 20) x),'[]'),
 'onboarding',COALESCE((SELECT jsonb_agg(jsonb_build_object('step',step,'count',n) ORDER BY o,n DESC,step) FROM (
   SELECT props->>'step' AS step,count(DISTINCT COALESCE(user_id,'session:'||session)) n,0 AS o FROM e WHERE name='onboarding_step' GROUP BY 1
   UNION ALL SELECT CASE WHEN props->>'skipped'='true' THEN 'skipped' ELSE 'done' END,count(DISTINCT COALESCE(user_id,'session:'||session)),1
   FROM e WHERE name='onboarding_done' GROUP BY 1) x),'[]'),
 'events',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',name,'count',n) ORDER BY n DESC,name) FROM (SELECT name,count(*) n FROM e GROUP BY name) x),'[]'))`, days)
}
