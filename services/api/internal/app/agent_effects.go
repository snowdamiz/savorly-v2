package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
)

// effect is something a turn did to the member's data. The app shows it as a receipt under the
// reply, links to where it is, and takes it back with Undo when undo says how. undo stays on
// the server: the app only learns whether there is one.
type effect struct {
	Kind   string          `json:"kind"`
	Count  int             `json:"count,omitempty"`
	Title  string          `json:"title,omitempty"`
	Recipe string          `json:"recipe,omitempty"`
	Page   string          `json:"page,omitempty"`
	Undo   json.RawMessage `json:"undo,omitempty"`
	Undone bool            `json:"undone,omitempty"`
}

// publicEffectsSQL is a voice_events row's (e) effects as the app sees them.
const publicEffectsSQL = `(SELECT COALESCE(jsonb_agg((x - 'undo') || jsonb_build_object('undoable', x ? 'undo' AND NOT COALESCE((x->>'undone')::boolean,false)) ORDER BY n),'[]') FROM jsonb_array_elements(e.effects) WITH ORDINALITY y(x,n))`

func (run *agentRun) note(f effect) { run.effects = append(run.effects, f) }

func (a *App) recipeTitle(ctx context.Context, id string) string {
	var title string
	_ = a.DB.QueryRow(ctx, `SELECT title FROM recipes WHERE id=$1`, id).Scan(&title)
	return title
}

// listedGrocery is a line of the member's grocery list (their household's, if they share one)
// that they added themselves.
type listedGrocery struct{ Quantity string }

func (a *App) groceryList(ctx context.Context, owner string) (map[string]listedGrocery, error) {
	rows, e := a.DB.Query(ctx, `SELECT g.id,g.quantity FROM groceries g WHERE g.user_id=$1 AND `+groceryScope(1), owner)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	list := map[string]listedGrocery{}
	for rows.Next() {
		var id string
		var g listedGrocery
		if e = rows.Scan(&id, &g.Quantity); e != nil {
			return nil, e
		}
		list[id] = g
	}
	return list, rows.Err()
}

// noteGroceries records what a grocery tool added, and the quantities it merged into lines
// already there, by comparing the list with before.
func (a *App) noteGroceries(ctx context.Context, run *agentRun, before map[string]listedGrocery) {
	if before == nil {
		return
	}
	after, e := a.groceryList(ctx, run.state.Owner)
	if e != nil {
		return
	}
	added, quantities := []string{}, map[string]string{}
	for id, g := range after {
		if old, ok := before[id]; !ok {
			added = append(added, id)
		} else if old.Quantity != g.Quantity {
			quantities[id] = old.Quantity
		}
	}
	if n := len(added) + len(quantities); n > 0 {
		run.note(effect{Kind: "groceries", Count: n, Page: "planner", Undo: jsonBytes(fiber.Map{"added": added, "quantities": quantities})})
	}
}

// planSlot is what a day's meal held before a tool planned over it.
type planSlot struct {
	Recipe   string `json:"recipe"`
	Servings int    `json:"servings"`
}

func (a *App) planSlot(ctx context.Context, owner, day, meal string) *planSlot {
	var s planSlot
	if a.DB.QueryRow(ctx, `SELECT recipe_id,servings FROM meal_plans WHERE user_id=$1 AND day=$2::date AND meal=$3`, owner, day, meal).Scan(&s.Recipe, &s.Servings) != nil {
		return nil
	}
	return &s
}

// cookEntry is what the member had recorded about cooking a recipe.
type cookEntry struct {
	Photo string    `json:"photo"`
	Note  string    `json:"note"`
	At    time.Time `json:"at"`
}

func (a *App) cookEntry(ctx context.Context, owner, recipe string) *cookEntry {
	var k cookEntry
	if a.DB.QueryRow(ctx, `SELECT photo,note,created_at FROM cooks WHERE user_id=$1 AND recipe_id=$2`, owner, recipe).Scan(&k.Photo, &k.Note, &k.At) != nil {
		return nil
	}
	return &k
}

// sharedByUser reports whether the member gave the page's address in the conversation.
func (a *App) sharedByUser(ctx context.Context, project, page string) bool {
	host := strings.TrimPrefix(strings.ToLower(hostOf(page)), "www.")
	var shared bool
	_ = a.DB.QueryRow(ctx, `SELECT $2<>'' AND EXISTS(SELECT 1 FROM voice_events WHERE project_id=$1 AND role='user' AND strpos(lower(content),$2)>0)`, project, host).Scan(&shared)
	return shared
}

// pantryEntry is what the pantry held under a name before a tool set it.
type pantryEntry struct {
	Quantity  string  `json:"quantity"`
	ExpiresOn *string `json:"expiresOn"`
}

func (a *App) pantryEntry(ctx context.Context, owner, name string) *pantryEntry {
	var p pantryEntry
	if a.DB.QueryRow(ctx, `SELECT quantity,to_char(expires_on,'YYYY-MM-DD') FROM pantry WHERE user_id=$1 AND name=$2`, owner, name).Scan(&p.Quantity, &p.ExpiresOn) != nil {
		return nil
	}
	return &p
}

// undoEffect takes back what f did, as far as it is still there. It only touches the
// member's own rows.
func undoEffect(ctx context.Context, tx pgx.Tx, owner string, f effect) error {
	var e error
	switch f.Kind {
	case "groceries":
		var u struct {
			Added      []string
			Quantities map[string]string
		}
		if e = json.Unmarshal(f.Undo, &u); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `DELETE FROM groceries g WHERE g.id=ANY($1) AND g.user_id=$2 AND `+groceryScope(2), u.Added, owner); e != nil {
			return e
		}
		for id, quantity := range u.Quantities {
			if _, e = tx.Exec(ctx, `UPDATE groceries g SET quantity=$3 WHERE g.id=$1 AND `+groceryScope(2), id, owner, quantity); e != nil {
				return e
			}
		}
	case "plan":
		var u struct {
			Day, Meal, Recipe string
			Previous          *planSlot
		}
		if e = json.Unmarshal(f.Undo, &u); e != nil {
			return e
		}
		// Only while the slot still holds what was planned: a later change stays.
		if u.Previous == nil {
			_, e = tx.Exec(ctx, `DELETE FROM meal_plans WHERE user_id=$1 AND day=$2::date AND meal=$3 AND recipe_id=$4`, owner, u.Day, u.Meal, u.Recipe)
		} else {
			_, e = tx.Exec(ctx, `UPDATE meal_plans SET recipe_id=$5,servings=$6 WHERE user_id=$1 AND day=$2::date AND meal=$3 AND recipe_id=$4`, owner, u.Day, u.Meal, u.Recipe, u.Previous.Recipe, u.Previous.Servings)
		}
	case "pantry":
		var u struct {
			Name     string
			Previous *pantryEntry
		}
		if e = json.Unmarshal(f.Undo, &u); e != nil {
			return e
		}
		if u.Previous == nil {
			_, e = tx.Exec(ctx, `DELETE FROM pantry WHERE user_id=$1 AND name=$2`, owner, u.Name)
		} else {
			_, e = tx.Exec(ctx, `UPDATE pantry SET quantity=$3,expires_on=$4::date WHERE user_id=$1 AND name=$2`, owner, u.Name, u.Previous.Quantity, u.Previous.ExpiresOn)
		}
	case "saved", "unsaved":
		var u struct {
			Recipe     string
			Saved      bool
			Collection *string
		}
		if e = json.Unmarshal(f.Undo, &u); e != nil {
			return e
		}
		if u.Saved {
			_, e = tx.Exec(ctx, `INSERT INTO saves(user_id,recipe_id,collection_id) SELECT $1,id,(SELECT id FROM collections WHERE id=$3 AND user_id=$1) FROM recipes WHERE id=$2 ON CONFLICT(user_id,recipe_id) DO UPDATE SET collection_id=excluded.collection_id`, owner, u.Recipe, u.Collection)
		} else {
			_, e = tx.Exec(ctx, `DELETE FROM saves WHERE user_id=$1 AND recipe_id=$2`, owner, u.Recipe)
		}
	case "followed", "unfollowed":
		var u struct {
			Cook      string
			Following bool
		}
		if e = json.Unmarshal(f.Undo, &u); e != nil {
			return e
		}
		if u.Following {
			_, e = tx.Exec(ctx, `INSERT INTO follows(user_id,creator_id) SELECT $1,id FROM users WHERE id=$2 AND id<>$1 ON CONFLICT DO NOTHING`, owner, u.Cook)
		} else {
			_, e = tx.Exec(ctx, `DELETE FROM follows WHERE user_id=$1 AND creator_id=$2`, owner, u.Cook)
		}
	case "cookbook":
		var u struct{ ID string }
		if e = json.Unmarshal(f.Undo, &u); e != nil {
			return e
		}
		// Its recipes stay saved, as when the member deletes a cookbook themselves.
		_, e = tx.Exec(ctx, `DELETE FROM collections WHERE id=$1 AND user_id=$2`, u.ID, owner)
	case "cooked":
		var u struct {
			Recipe   string
			Previous *cookEntry
		}
		if e = json.Unmarshal(f.Undo, &u); e != nil {
			return e
		}
		// A recipe cooked before goes back to how it was recorded then.
		if u.Previous == nil {
			_, e = tx.Exec(ctx, `DELETE FROM cooks WHERE user_id=$1 AND recipe_id=$2`, owner, u.Recipe)
		} else {
			_, e = tx.Exec(ctx, `UPDATE cooks SET photo=$3,note=$4,created_at=$5 WHERE user_id=$1 AND recipe_id=$2`, owner, u.Recipe, u.Previous.Photo, u.Previous.Note, u.Previous.At)
		}
	case "checked", "unchecked":
		var u struct {
			ID      string
			Checked bool
		}
		if e = json.Unmarshal(f.Undo, &u); e != nil {
			return e
		}
		_, e = tx.Exec(ctx, `UPDATE groceries g SET checked=$3 WHERE g.id=$1 AND `+groceryScope(2), u.ID, owner, u.Checked)
	default:
		return fiber.NewError(400, "That can't be undone.")
	}
	return e
}

// studioUndo takes back one thing a reply's turn did, from the receipt under it.
func (a *App) studioUndo(c fiber.Ctx) error {
	var in struct {
		Seq   int64 `json:"seq"`
		Index int   `json:"index"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	ctx, owner := c.Context(), userID(c)
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, owner); e != nil {
		return e
	}
	var raw []byte
	e = tx.QueryRow(ctx, `SELECT e.effects FROM voice_events e JOIN voice_projects p ON p.id=e.project_id WHERE e.seq=$1 AND p.id=$2 AND p.user_id=$3 AND p.deleted_at IS NULL FOR UPDATE OF e`, in.Seq, c.Params("id"), owner).Scan(&raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return fiber.NewError(404, "There's nothing to undo there.")
	} else if e != nil {
		return e
	}
	var list []effect
	if e = json.Unmarshal(raw, &list); e != nil {
		return e
	}
	if in.Index < 0 || in.Index >= len(list) || len(list[in.Index].Undo) == 0 {
		return fiber.NewError(400, "That can't be undone.")
	}
	if list[in.Index].Undone {
		return fiber.NewError(409, "That's already undone.")
	}
	if e = undoEffect(ctx, tx, owner, list[in.Index]); e != nil {
		return e
	}
	list[in.Index].Undone = true
	if _, e = tx.Exec(ctx, `UPDATE voice_events SET effects=$2 WHERE seq=$1`, in.Seq, jsonBytes(list)); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `UPDATE voice_projects SET updated_at=now() WHERE id=$1`, c.Params("id")); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	var effects json.RawMessage
	if e = a.DB.QueryRow(ctx, `SELECT `+publicEffectsSQL+` FROM voice_events e WHERE e.seq=$1`, in.Seq).Scan(&effects); e != nil {
		return e
	}
	return c.JSON(fiber.Map{"effects": effects})
}

// undoneSummary lists what the member took back from recent replies, so the next turn doesn't
// redo it or speak as if it still stood.
func (a *App) undoneSummary(ctx context.Context, project string) []string {
	rows, e := a.DB.Query(ctx, `SELECT x->>'kind',COALESCE(x->>'title',''),COALESCE((x->>'count')::int,0) FROM (SELECT effects FROM voice_events WHERE project_id=$1 AND role='assistant' AND effects<>'[]' ORDER BY seq DESC LIMIT 20) r,jsonb_array_elements(r.effects) x WHERE COALESCE((x->>'undone')::boolean,false)`, project)
	if e != nil {
		return nil
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var kind, title string
		var count int
		if rows.Scan(&kind, &title, &count) != nil {
			return nil
		}
		what := map[string]string{"groceries": "added grocery items", "plan": "planned a meal", "pantry": "set a pantry item", "saved": "saved a recipe", "unsaved": "unsaved a recipe", "followed": "followed a cook", "unfollowed": "unfollowed a cook", "cookbook": "created a cookbook", "checked": "checked off a grocery item", "unchecked": "unchecked a grocery item"}[kind]
		if title != "" {
			what += ": " + title
		}
		out = append(out, what)
	}
	return out
}

// step records what the turn is doing now, and reports whether the member asked to stop it.
func (a *App) step(ctx context.Context, run *agentRun, tool string) bool {
	if run.action == "" {
		return false
	}
	// What the app shows while it runs (the caption under the thinking dots); a tool without
	// one keeps the last.
	name := agentToolNamed[tool].step
	if name == "" {
		name = run.step
	}
	run.step = name
	var stop bool
	if e := a.DB.QueryRow(ctx, `UPDATE voice_actions SET progress=$2 WHERE id=$1 RETURNING cancel_requested`, run.action, name).Scan(&stop); e != nil {
		return false
	}
	return stop
}

// turnStopped is the reply to a turn the member stopped.
const turnStopped = "Stopped. Your conversation is saved."

// studioCancel stops the conversation's turn: a queued one never runs, and a running one ends
// at its next step (at once, on the replica running it). What it already did stays.
func (a *App) studioCancel(c fiber.Ctx) error {
	ctx, owner := c.Context(), userID(c)
	var id, status string
	e := a.DB.QueryRow(ctx, `UPDATE voice_actions a SET cancel_requested=true FROM voice_projects p WHERE p.id=a.project_id AND p.id=$1 AND p.user_id=$2 AND p.deleted_at IS NULL AND a.status IN ('queued','running') RETURNING a.id,a.status`, c.Params("id"), owner).Scan(&id, &status)
	if errors.Is(e, pgx.ErrNoRows) {
		return c.SendStatus(204)
	} else if e != nil {
		return e
	}
	if status == "queued" {
		// Claimed here, so the worker won't start it; it never reached the model.
		r, e := a.DB.Exec(ctx, `UPDATE voice_actions SET status='running',updated_at=now() WHERE id=$1 AND status='queued'`, id)
		if e != nil {
			return e
		}
		if r.RowsAffected() == 1 {
			state, e := a.studioProject(ctx, c.Params("id"))
			if e != nil {
				return e
			}
			if e = a.settleTurn(ctx, id, c.Params("id"), &agentRun{state: state}, turnStopped, 0, true, true); e != nil {
				return e
			}
			return c.SendStatus(202)
		}
	}
	if stop, ok := a.turns.Load(id); ok {
		stop.(context.CancelFunc)()
	}
	return c.SendStatus(202)
}
