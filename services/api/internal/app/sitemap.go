package app

import "github.com/gofiber/fiber/v3"

// sitemap lists what the Worker puts in sitemap.xml: published recipes of cooks in good
// standing, and those cooks' profiles, freshest first, up to the 50,000 a sitemap may hold;
// and shared cookbooks of cooks in good standing that show any recipes (/cookbooks/<id>).
func (a *App) sitemap(c fiber.Ctx) error {
	var b []byte
	e := a.DB.QueryRow(c.Context(), `SELECT json_build_object(
 'recipes',COALESCE((SELECT json_agg(json_build_object('id',x.id,'updatedAt',x.updated_at) ORDER BY x.updated_at DESC,x.id) FROM (
   SELECT r.id,r.updated_at`+recipeFrom+`WHERE r.published ORDER BY r.updated_at DESC,r.id LIMIT 50000) x),'[]'),
 'creators',COALESCE((SELECT json_agg(json_build_object('id',x.id,'handle',x.handle,'updatedAt',x.updated_at) ORDER BY x.updated_at DESC,x.id) FROM (
   SELECT u.id,u.handle,GREATEST(u.updated_at,max(r.updated_at)) AS updated_at`+recipeFrom+`WHERE r.published GROUP BY u.id ORDER BY 3 DESC,u.id LIMIT 50000) x),'[]'),
 'cookbooks',COALESCE((SELECT json_agg(json_build_object('id',x.id,'updatedAt',x.updated_at) ORDER BY x.updated_at DESC,x.id) FROM (
   SELECT b.id,GREATEST(b.updated_at,max(l.created_at)) AS updated_at FROM collections b JOIN users o ON o.id=b.user_id AND o.suspended_at IS NULL
   CROSS JOIN LATERAL (`+cookbookRecipes+`) l WHERE b.public GROUP BY b.id ORDER BY 2 DESC,b.id LIMIT 50000) x),'[]'))`).Scan(&b)
	if e != nil {
		return e
	}
	c.Set("Cache-Control", "public, max-age=3600")
	c.Set("Content-Type", "application/json")
	return c.Send(b)
}
