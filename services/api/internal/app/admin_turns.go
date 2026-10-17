package app

import (
	"strings"

	"github.com/gofiber/fiber/v3"
)

// The sous-chef's turns for the admin console: who asked, by text or voice, how long it took,
// what it cost, and from the trace each model round and tool. The list carries no
// conversation text; one turn's detail adds its reply, for following up a member's report.

const turnRowJSON = `'id',a.id,'status',a.status,'channel',CASE WHEN starts_with(a.session_id,'chat_') THEN 'text' ELSE 'voice' END,
 'cost',a.estimated_cost,'createdAt',a.created_at,'startedAt',a.started_at,'updatedAt',a.updated_at,'project',a.project_id,
 'model',COALESCE(a.trace->>'model',''),'ms',(a.trace->>'ms')::bigint,'rounds',jsonb_array_length(COALESCE(a.trace->'rounds','[]')),
 'tools',(SELECT COALESCE(jsonb_agg(t->>'name' ORDER BY r.n,t.n),'[]') FROM jsonb_array_elements(COALESCE(a.trace->'rounds','[]')) WITH ORDINALITY r(round,n), jsonb_array_elements(COALESCE(r.round->'tools','[]')) WITH ORDINALITY t(t,n)),
 'toolErrors',(SELECT count(*) FROM jsonb_array_elements(COALESCE(a.trace->'rounds','[]')) r, jsonb_array_elements(COALESCE(r->'tools','[]')) t WHERE COALESCE(t->>'error','')<>''),
 'user',jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'avatar',u.avatar)`

// adminTurns lists turns, newest first: by status (queued, running, completed, failed), by
// channel (text, voice), and by a member's email or id, or the turn's id.
func (a *App) adminTurns(c fiber.Ctx) error {
	return a.adminList(c, `SELECT jsonb_build_object(`+turnRowJSON+`),count(*) OVER() FROM voice_actions a JOIN voice_projects p ON p.id=a.project_id JOIN users u ON u.id=p.user_id
 WHERE ($1='' OR a.status=$1) AND ($2='' OR $2=CASE WHEN starts_with(a.session_id,'chat_') THEN 'text' ELSE 'voice' END)
 AND ($3='' OR u.email ILIKE '%'||$3||'%' OR a.id=$3 OR p.user_id=$3)
 ORDER BY a.created_at DESC,a.id`, c.Query("status"), c.Query("channel"), strings.TrimSpace(c.Query("q")))
}

// adminTurn adds the trace, what the turn was doing while it ran, and its reply.
func (a *App) adminTurn(c fiber.Ctx) error {
	b, e := a.jsonRow(c.Context(), `SELECT jsonb_build_object(`+turnRowJSON+`,'trace',a.trace,'step',a.progress,'reply',left(a.reply,4000))
 FROM voice_actions a JOIN voice_projects p ON p.id=a.project_id JOIN users u ON u.id=p.user_id WHERE a.id=$1`, c.Params("id"))
	if e != nil {
		return e
	}
	c.Set("Content-Type", "application/json")
	return c.Send(b)
}
