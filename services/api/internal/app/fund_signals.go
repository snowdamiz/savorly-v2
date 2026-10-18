package app

import (
	"cmp"
	"context"
	"slices"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
)

// What the creator fund's console shows to guard against paid cooks, and its weekly report
// (docs/CREATOR-FUND.md). A creator paying real members to cook only their recipes shows up as
// paying members whose every verified cook went to that creator. These are signals for an admin
// to look into, never holds: plenty of members cook one favourite creator for a month, and an
// admin who finds a ring holds the creator's payouts by hand (admin_fund.go).

// paidCooksThreshold is how many verified cooks a paying member must make in the period, all of one
// creator's recipes, before they're flagged. Fewer is too ordinary to mean anything: a member who
// cooks two or three recipes a month often cooks them from one cook they follow.
const paidCooksThreshold = 4

type flaggedMember struct {
	member, creator string
	cooks, cents    int
}

type flaggedCreator struct {
	creator                 string
	cents, flagged, members int
}

// fundFlags reads a period's cooks (fundCooks) and its split: the paying members whose verified
// cooks, at least paidCooksThreshold of them, all went to one creator, and the creators who get
// more than half their money from such members. Each list is largest first.
func fundFlags(rows []fundCook, shares map[string]*fundShare, shareBP int) ([]flaggedMember, []flaggedCreator) {
	type cooked struct {
		creators   map[string]bool
		creator    string
		cooks, net int
	}
	byMember := map[string]*cooked{}
	for _, r := range rows {
		if r.cooks <= 0 {
			continue
		}
		m := byMember[r.member]
		if m == nil {
			m = &cooked{creators: map[string]bool{}}
			byMember[r.member] = m
		}
		m.creators[r.creator], m.creator = true, r.creator
		m.cooks, m.net = m.cooks+r.cooks, max(m.net, r.net)
	}
	members := []flaggedMember{}
	fromFlagged := map[string]*flaggedCreator{}
	for id, m := range byMember {
		// With one creator, the member's whole share goes to them (splitFund).
		given := m.net * shareBP / 10000
		if len(m.creators) != 1 || m.cooks < paidCooksThreshold || given <= 0 {
			continue
		}
		members = append(members, flaggedMember{id, m.creator, m.cooks, given})
		f := fromFlagged[m.creator]
		if f == nil {
			f = &flaggedCreator{creator: m.creator}
			fromFlagged[m.creator] = f
		}
		f.flagged, f.members = f.flagged+given, f.members+1
	}
	slices.SortFunc(members, func(x, y flaggedMember) int {
		return cmp.Or(y.cents-x.cents, y.cooks-x.cooks, cmp.Compare(x.member, y.member))
	})
	creators := []flaggedCreator{}
	for id, f := range fromFlagged {
		if s := shares[id]; s != nil && f.flagged*2 > s.cents {
			f.cents = s.cents
			creators = append(creators, *f)
		}
	}
	slices.SortFunc(creators, func(x, y flaggedCreator) int {
		return cmp.Or(y.flagged-x.flagged, cmp.Compare(x.creator, y.creator))
	})
	return members, creators
}

type person struct{ name, email string }

// namesOf looks up members' names and emails by id, for the console.
func namesOf(ctx context.Context, q engagementDB, ids []string) (map[string]person, error) {
	who := map[string]person{}
	if len(ids) == 0 {
		return who, nil
	}
	rows, e := q.Query(ctx, `SELECT id,name,email FROM users WHERE id=ANY($1)`, ids)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var p person
		if e = rows.Scan(&id, &p.name, &p.email); e != nil {
			return nil, e
		}
		who[id] = p
	}
	return who, rows.Err()
}

func flagsJSON(members []flaggedMember, creators []flaggedCreator, who map[string]person) fiber.Map {
	m := []fiber.Map{}
	for _, f := range members {
		m = append(m, fiber.Map{"id": f.member, "name": who[f.member].name, "email": who[f.member].email, "cooks": f.cooks, "cents": f.cents,
			"creator": fiber.Map{"id": f.creator, "name": who[f.creator].name, "email": who[f.creator].email}})
	}
	c := []fiber.Map{}
	for _, f := range creators {
		c = append(c, fiber.Map{"id": f.creator, "name": who[f.creator].name, "email": who[f.creator].email,
			"estimateCents": f.cents, "flaggedCents": f.flagged, "members": f.members})
	}
	return fiber.Map{"threshold": paidCooksThreshold, "members": m, "creators": c}
}

// fundDay is fundCook a UTC day at a time.
type fundDay struct {
	member, creator string
	day             time.Time
	cooks, net      int
}

// fundDays reads the verified cooks between from and to as fundCooks does, by UTC day too.
func fundDays(ctx context.Context, q engagementDB, from, to time.Time) ([]fundDay, error) {
	rows, e := q.Query(ctx, `SELECT k.user_id,r.author_id,k.verified_day,count(*)::int,max(k.net_cents)::int FROM cook_sessions k JOIN recipes r ON r.id=k.recipe_id
 WHERE k.verified AND k.finished_at>=$1 AND k.finished_at<$2 AND r.author_id<>k.user_id GROUP BY 1,2,3 ORDER BY 1,2,3`, from, to)
	if e != nil {
		return nil, e
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (fundDay, error) {
		var f fundDay
		return f, row.Scan(&f.member, &f.creator, &f.day, &f.cooks, &f.net)
	})
}

// cooksBetween adds up the days from from up to to into fundCooks.
func cooksBetween(days []fundDay, from, to time.Time) []fundCook {
	type pair struct{ member, creator string }
	at := map[pair]int{}
	out := []fundCook{}
	for _, d := range days {
		if d.day.Before(from) || !d.day.Before(to) {
			continue
		}
		k := pair{d.member, d.creator}
		i, ok := at[k]
		if !ok {
			i = len(out)
			at[k] = i
			out = append(out, fundCook{member: d.member, creator: d.creator})
		}
		out[i].cooks += d.cooks
		out[i].net = max(out[i].net, d.net)
	}
	return out
}

// fundWeeks is how many weeks the weekly report covers, this one included.
const fundWeeks = 8

// fundWeek is one week of the weekly report.
type fundWeek struct {
	start               time.Time
	cooks, paying, pool int
	top                 []fundTop
	members             []flaggedMember
	creators            []flaggedCreator
}

// fundTop is a creator and their verified cooks by paying members.
type fundTop struct {
	creator string
	cooks   int
}

// fundWeekReport is the fund's weekly report for the fundWeeks weeks up to the one starting at
// current, newest first, Monday to Sunday in UTC: each week's verified cooks, the paying members
// who cooked, what the pool grew by, the three creators most cooked by paying members, and the
// paid-cooks signals over the week's cooks. A member's share joins the month's pool as they cook,
// so a week's growth is what its months owed by its end less what they owed by its start, by the
// rule that closes months: the weeks of a month add up to its pool. It reads the cooks once.
func fundWeekReport(ctx context.Context, q engagementDB, current time.Time, shareBP int) ([]fundWeek, error) {
	first := current.AddDate(0, 0, -7*(fundWeeks-1))
	days, e := fundDays(ctx, q, monthStart(first), current.AddDate(0, 0, 7))
	if e != nil {
		return nil, e
	}
	owed := func(month, until time.Time) int {
		_, pool, _, _ := splitFund(cooksBetween(days, month, until), shareBP)
		return pool
	}
	weeks := []fundWeek{}
	for i := fundWeeks - 1; i >= 0; i-- {
		start := first.AddDate(0, 0, 7*i)
		end := start.AddDate(0, 0, 7)
		w := fundWeek{start: start}
		for month := monthStart(start); month.Before(end); month = month.AddDate(0, 1, 0) {
			w.pool += owed(month, minTime(end, month.AddDate(0, 1, 0))) - owed(month, maxTime(start, month))
		}
		rows := cooksBetween(days, start, end)
		paying, paid := map[string]bool{}, map[string]int{}
		for _, r := range rows {
			w.cooks += r.cooks
			if r.net > 0 {
				paying[r.member] = true
				paid[r.creator] += r.cooks
			}
		}
		w.paying = len(paying)
		for creator, n := range paid {
			w.top = append(w.top, fundTop{creator, n})
		}
		slices.SortFunc(w.top, func(x, y fundTop) int { return cmp.Or(y.cooks-x.cooks, cmp.Compare(x.creator, y.creator)) })
		w.top = w.top[:min(len(w.top), 3)]
		shares, _, _, _ := splitFund(rows, shareBP)
		w.members, w.creators = fundFlags(rows, shares, shareBP)
		weeks = append(weeks, w)
	}
	return weeks, nil
}

func minTime(x, y time.Time) time.Time {
	if x.Before(y) {
		return x
	}
	return y
}

func maxTime(x, y time.Time) time.Time {
	if x.After(y) {
		return x
	}
	return y
}

// Tapped-through cooks: verified cooks whose step events (cook_insights.go) look mechanical
// rather than cooked. A session passes verification by lasting the recipe's minimum time, but
// cooking takes steps of different lengths; a script, or someone tapping through on a timer,
// spends the same few seconds on every step and waits out the rest. These are signals too.
const (
	// tappedCooks such cooks in the month flag a member.
	tappedCooks = 2
	// A session counts when it lasted within tappedSlack of its minimum and every step it
	// visited took within tappedSpreadMillis of the others, over at least tappedSteps steps.
	tappedSlack, tappedSpreadMillis, tappedSteps = 1.1, 10_000, 3
)

// tappedSession is a verified cook as the check reads it: how long it lasted, the least it had
// to, and how long each visit to a step took, in order.
type tappedSession struct {
	member              string
	seconds, minimumSec int
	visits              []int64
}

// mechanical is whether a session looks tapped through.
func (s tappedSession) mechanical() bool {
	if len(s.visits) < tappedSteps || float64(s.seconds) > float64(s.minimumSec)*tappedSlack+30 {
		return false
	}
	return slices.Max(s.visits)-slices.Min(s.visits) <= tappedSpreadMillis
}

// visitsOf is how long each visit to a step took, from entering it to entering the next step or
// leaving, in milliseconds.
func visitsOf(events []insightEvent) []int64 {
	var visits []int64
	since, open := int64(0), false
	for _, ev := range events {
		if ev.kind != "enter" && ev.kind != "leave" {
			continue
		}
		if open {
			visits = append(visits, ev.at-since)
		}
		since, open = ev.at, ev.kind == "enter"
	}
	return visits
}

// tappedMembers is the members with tappedCooks or more tapped-through cooks between from and to,
// most first, with how many.
func tappedMembers(ctx context.Context, q engagementDB, from, to time.Time) ([]flaggedMember, error) {
	rows, e := q.Query(ctx, `SELECT k.id,k.user_id,extract(epoch FROM k.finished_at-k.started_at)::int,60*least($3::int,greatest($4::int,r.minutes/3)),e.kind,e.at_ms
 FROM cook_sessions k JOIN recipes r ON r.id=k.recipe_id JOIN cook_step_events e ON e.session_id=k.id
 WHERE k.verified AND k.events>0 AND k.finished_at>=$1 AND k.finished_at<$2 ORDER BY k.id,e.seq`, from, to, maxCookMinutes, minCookMinutes)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	counts := map[string]int{}
	var current string
	var session tappedSession
	var events []insightEvent
	done := func() {
		if current != "" {
			session.visits = visitsOf(events)
			if session.mechanical() {
				counts[session.member]++
			}
		}
	}
	for rows.Next() {
		var id string
		var s tappedSession
		var ev insightEvent
		if e = rows.Scan(&id, &s.member, &s.seconds, &s.minimumSec, &ev.kind, &ev.at); e != nil {
			return nil, e
		}
		if id != current {
			done()
			current, session, events = id, s, nil
		}
		events = append(events, ev)
	}
	if e = rows.Err(); e != nil {
		return nil, e
	}
	done()
	out := []flaggedMember{}
	for member, n := range counts {
		if n >= tappedCooks {
			out = append(out, flaggedMember{member: member, cooks: n})
		}
	}
	slices.SortFunc(out, func(x, y flaggedMember) int { return cmp.Or(y.cooks-x.cooks, cmp.Compare(x.member, y.member)) })
	return out, nil
}
