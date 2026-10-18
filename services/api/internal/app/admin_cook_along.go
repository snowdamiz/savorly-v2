package app

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
)

// The cook-along (cook_along.go) and founding creators in the admin console. Founding creators
// are the first creators Savorly recruits: an admin marks them, their profile and every author
// line of their recipes say "Founding creator" (`founding` on creator and author JSON, from
// users.founding_creator_at), and they take turns in the weekly cook-along.

// growthRoutes registers what plan sections 8 to 10 add to the admin console: the cook-along,
// founding creators, the cooking metrics and the creator fund's weekly report
// (admin_metrics.go). Like the fund's routes, they name the admin middleware themselves.
func (a *App) growthRoutes(v fiber.Router) {
	v.Get("/admin/cook-alongs", a.requireAuth, a.requireAdmin, a.adminCookAlongs)
	v.Put("/admin/cook-alongs/:week", a.requireAuth, a.requireAdmin, a.adminScheduleCookAlong)
	v.Delete("/admin/cook-alongs/:week", a.requireAuth, a.requireAdmin, a.adminUnscheduleCookAlong)
	v.Put("/admin/users/:id/founding", a.requireAuth, a.requireAdmin, a.adminSetFounding)
	v.Get("/admin/cooking", a.requireAuth, a.requireAdmin, a.adminCooking)
	v.Get("/admin/fund/weeks", a.requireAuth, a.requireAdmin, a.adminFundWeeks)
}

const (
	// The console lists the cook-alongs of the last four weeks and the next eight.
	cookAlongPast, cookAlongAhead = 4, 8
	// Weeks can be scheduled up to a year ahead.
	cookAlongHorizon = 52
	// A founding creator's public recipes the console offers for their turn.
	rotationRecipes = 5
)

// adminCookAlongs is the cook-along at a glance: the current week, the weeks around it with their
// recipe and counts, the last week announced, and the founding creators in the order their turns
// come, each with their public recipes in the order the rotation offers them (turnRecipesSQL).
// next is the first of them with a public recipe: whose turn the next open week is.
func (a *App) adminCookAlongs(c fiber.Ctx) error {
	var b []byte
	e := a.DB.QueryRow(c.Context(), `SELECT jsonb_build_object('week',`+currentWeekSQL+`,
 'announcedWeek',(SELECT ran_on FROM notification_runs WHERE name='cookalong'),
 'weeks',COALESCE((SELECT jsonb_agg(jsonb_build_object('week',k.week,'updatedAt',k.updated_at,'automatic',k.automatic,'scheduledBy',(SELECT email FROM users WHERE id=k.scheduled_by),
   'creator',(SELECT jsonb_build_object('id',c.id,'name',c.name,'email',c.email) FROM users c WHERE c.id=k.creator_id),
   'recipe',(SELECT jsonb_build_object('id',r.id,'title',r.title,'image',r.image,'published',r.published,
     'author',jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'suspended',u.suspended_at IS NOT NULL,'founding',u.founding_creator_at IS NOT NULL))
     FROM recipes r JOIN users u ON u.id=r.author_id WHERE r.id=k.recipe_id),`+cookAlongCountsSQL+`) ORDER BY k.week)
   FROM cook_alongs k WHERE k.week>=`+currentWeekSQL+`-7*$1::int AND k.week<=`+currentWeekSQL+`+7*$2::int),'[]'),
 'rotation',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'avatar',u.avatar,'foundingAt',u.founding_creator_at,'lastWeek',f.last,
   'recipes',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',x.id,'title',x.title,'image',x.image,'saveCount',x.saves,'featuredWeek',x.featured) ORDER BY `+turnOrder+`)
     FROM (`+turnRecipesSQL+` LIMIT $3) x),'[]')) ORDER BY `+rotationOrder+`)`+rotationFrom+rotationWhere+`),'[]'))`,
		cookAlongPast, cookAlongAhead, rotationRecipes).Scan(&b)
	if e != nil {
		return e
	}
	var out map[string]any
	if e = json.Unmarshal(b, &out); e != nil {
		return e
	}
	out["next"] = nil
	rotation, _ := out["rotation"].([]any)
	for _, r := range rotation {
		creator, _ := r.(map[string]any)
		if recipes, _ := creator["recipes"].([]any); len(recipes) > 0 {
			out["next"] = creator["id"]
			break
		}
	}
	return c.JSON(out)
}

// scheduledWeek reads the :week a cook-along route names: a Monday, this week or later, up to
// cookAlongHorizon weeks ahead.
func scheduledWeek(c fiber.Ctx) (time.Time, error) {
	week, e := time.Parse(time.DateOnly, c.Params("week"))
	if e != nil || week.Weekday() != time.Monday {
		return week, fiber.NewError(400, "Name the week by its Monday, as YYYY-MM-DD.")
	}
	now := cookAlongWeek(time.Now())
	if week.Before(now) {
		return week, fiber.NewError(400, "That week is over. Choose this week or a later one.")
	}
	if week.After(now.AddDate(0, 0, 7*cookAlongHorizon)) {
		return week, fiber.NewError(400, "Schedule a cook-along up to a year ahead.")
	}
	return week, nil
}

// adminScheduleCookAlong makes { "recipeId" } the cook-along of the week named, replacing any
// other, the rotation's included: a public recipe whose author isn't suspended. The rank rule
// applies as for moderating the recipe, so an appointed admin can't feature their own recipe or
// another admin's. Audited as cookalong.schedule on the recipe. It answers like
// GET /admin/cook-alongs.
func (a *App) adminScheduleCookAlong(c fiber.Ctx) error {
	week, e := scheduledWeek(c)
	if e != nil {
		return e
	}
	var in struct{ RecipeID string }
	if e = decode(c, &in); e != nil {
		return e
	}
	if in.RecipeID == "" {
		return fiber.NewError(400, "Choose a recipe.")
	}
	ctx := c.Context()
	e = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		r, e := lockRecipe(ctx, tx, in.RecipeID)
		if e != nil {
			return e
		}
		var published, suspended bool
		if e = tx.QueryRow(ctx, `SELECT r.published,u.suspended_at IS NOT NULL FROM recipes r JOIN users u ON u.id=r.author_id WHERE r.id=$1`, in.RecipeID).Scan(&published, &suspended); e != nil {
			return e
		}
		if !published {
			return fiber.NewError(409, "Only a public recipe can be the cook-along.")
		}
		if suspended {
			return fiber.NewError(409, "This recipe's author is suspended, so it can't be the cook-along.")
		}
		if e = mayModerate(c, r.Author, false); e != nil {
			return e
		}
		var previous *string
		var automatic bool
		e = tx.QueryRow(ctx, `SELECT recipe_id,automatic FROM cook_alongs WHERE week=$1 FOR UPDATE`, week).Scan(&previous, &automatic)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		if previous != nil && *previous == in.RecipeID && !automatic {
			return fiber.NewError(409, "This recipe is already that week's cook-along.")
		}
		if _, e = tx.Exec(ctx, `INSERT INTO cook_alongs(week,recipe_id,creator_id,scheduled_by) VALUES($1,$2,$3,$4)
 ON CONFLICT (week) DO UPDATE SET recipe_id=excluded.recipe_id,creator_id=excluded.creator_id,scheduled_by=excluded.scheduled_by,automatic=false,updated_at=now()`,
			week, in.RecipeID, r.Author.ID, userID(c)); e != nil {
			return e
		}
		detail := fiber.Map{"week": week.Format(time.DateOnly)}
		if previous != nil {
			detail["previousRecipeId"] = *previous
		}
		return audit(ctx, tx, c, "cookalong.schedule", "recipe", in.RecipeID, "Made “"+truncate(r.Title, 80)+"” the cook-along for the week of "+week.Format("2 January 2006"), detail)
	})
	if e != nil {
		return e
	}
	return a.adminCookAlongs(c)
}

// adminUnscheduleCookAlong empties a week that hasn't ended, which hands it back to the rotation
// (this week's at once, on the notifier's next pass). Audited as cookalong.unschedule on the
// recipe it had.
func (a *App) adminUnscheduleCookAlong(c fiber.Ctx) error {
	week, e := scheduledWeek(c)
	if e != nil {
		return e
	}
	ctx := c.Context()
	e = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		var recipe, title *string
		e := tx.QueryRow(ctx, `DELETE FROM cook_alongs k WHERE k.week=$1 RETURNING k.recipe_id,(SELECT title FROM recipes WHERE id=k.recipe_id)`, week).Scan(&recipe, &title)
		if errors.Is(e, pgx.ErrNoRows) {
			return fiber.NewError(404, "Nothing is scheduled that week.")
		}
		if e != nil {
			return e
		}
		target, name := "", "a deleted recipe"
		if recipe != nil {
			target = *recipe
		}
		if title != nil {
			name = "“" + truncate(*title, 80) + "”"
		}
		return audit(ctx, tx, c, "cookalong.unschedule", "recipe", target, "Removed "+name+" as the cook-along for the week of "+week.Format("2 January 2006"), fiber.Map{"week": week.Format(time.DateOnly)})
	})
	if e != nil {
		return e
	}
	return a.adminCookAlongs(c)
}

// adminSetFounding marks a member as a founding creator ({ "founding": true }) or removes the
// mark. The rank rule applies as for other member actions, so no one marks themselves, and each
// change is audited as member.founding or member.unfounding. It answers with the member's record.
func (a *App) adminSetFounding(c fiber.Ctx) error {
	m, e := a.manage(c, false)
	if e != nil {
		return e
	}
	var in struct{ Founding bool }
	if e = decode(c, &in); e != nil {
		return e
	}
	return a.adminWrite(c, func(ctx context.Context, tx pgx.Tx) error {
		r, e := tx.Exec(ctx, `UPDATE users SET founding_creator_at=CASE WHEN $2 THEN now() END WHERE id=$1 AND (founding_creator_at IS NOT NULL)<>$2`, m.ID, in.Founding)
		if e != nil {
			return e
		}
		if r.RowsAffected() == 0 {
			if in.Founding {
				return fiber.NewError(409, "This member is already a founding creator.")
			}
			return fiber.NewError(409, "This member isn't a founding creator.")
		}
		if in.Founding {
			return audit(ctx, tx, c, "member.founding", "user", m.ID, "Made "+m.Email+" a founding creator", nil)
		}
		return audit(ctx, tx, c, "member.unfounding", "user", m.ID, "Removed "+m.Email+" as a founding creator", nil)
	})
}
