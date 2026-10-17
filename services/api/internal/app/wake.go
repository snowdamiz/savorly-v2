package app

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// The worker loops sleep while there is nothing to do, so an idle server doesn't keep the
// database busy. Handlers that enqueue work wake them at once: directly in this process, and
// through NOTIFY on workChannel for the loops of other replicas.
const workChannel = "savorly_work"

type wakeups struct{ studio, jobs chan struct{} }

// The API and the worker run as separate Apps over one pool, so wakeups belong to the pool.
var wakeRegistry sync.Map

func (a *App) wakeups() *wakeups {
	if w, ok := wakeRegistry.Load(a.DB); ok {
		return w.(*wakeups)
	}
	w, _ := wakeRegistry.LoadOrStore(a.DB, &wakeups{studio: make(chan struct{}, 1), jobs: make(chan struct{}, 1)})
	return w.(*wakeups)
}

func poke(c chan struct{}) {
	select {
	case c <- struct{}{}:
	default:
	}
}

// announce tells every replica's "studio" or "jobs" loop about work tx enqueues; Postgres
// delivers it on commit. wake does the same for this process once the commit succeeded.
func announce(ctx context.Context, tx pgx.Tx, loop string) error {
	_, e := tx.Exec(ctx, `SELECT pg_notify($1,$2)`, workChannel, loop)
	return e
}

func (a *App) wake(loop string) {
	w := a.wakeups()
	if loop == "studio" {
		poke(w.studio)
	} else {
		poke(w.jobs)
	}
}

// pacing is how often a claim loop looks for work: every base while it finds some, backing
// off exponentially to idle while it finds none.
type pacing struct{ base, idle time.Duration }

// Tests shorten these. Sweeps that recover stuck work keep their own, slower cadence.
var (
	studioPace = pacing{base: time.Second, idle: 30 * time.Second}
	jobPace    = pacing{base: 2 * time.Second, idle: 30 * time.Second}
	sweepEvery = time.Minute
)

// pace runs tick until ctx ends: at once, then whenever woken or its delay passes. tick
// reports whether it found work.
func pace(ctx context.Context, wake <-chan struct{}, p pacing, tick func() bool) {
	delay := p.base
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-wake:
		case <-timer.C:
		}
		if tick() {
			delay = p.base
		} else {
			delay = min(2*delay, p.idle)
		}
		timer.Reset(delay)
	}
}

// every runs f now and then at each interval until ctx ends.
func every(ctx context.Context, interval time.Duration, f func()) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for ctx.Err() == nil {
		f()
		select {
		case <-ctx.Done():
		case <-t.C:
		}
	}
}

// listenForWork relays NOTIFY from any replica to this process's loops. It holds one pooled
// connection and reconnects with backoff; meanwhile the loops' idle delay bounds the wait.
func (a *App) listenForWork(ctx context.Context) {
	w := a.wakeups()
	backoff := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		e := a.listen(ctx, w)
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		slog.Warn("work listener reconnecting", "error", e, "in", backoff)
		select {
		case <-ctx.Done():
		case <-time.After(backoff):
		}
		backoff = min(2*backoff, time.Minute)
	}
}

func (a *App) listen(ctx context.Context, w *wakeups) error {
	conn, e := a.DB.Acquire(ctx)
	if e != nil {
		return e
	}
	defer func() {
		// A listening connection must not go back to the pool.
		end, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = conn.Conn().Close(end)
		conn.Release()
	}()
	if _, e = conn.Exec(ctx, `LISTEN `+workChannel); e != nil {
		return e
	}
	// Whatever was enqueued while nothing listened.
	poke(w.studio)
	poke(w.jobs)
	for {
		n, e := conn.Conn().WaitForNotification(ctx)
		if e != nil {
			return e
		}
		switch n.Payload {
		case "studio":
			poke(w.studio)
		case "jobs":
			poke(w.jobs)
		}
	}
}
