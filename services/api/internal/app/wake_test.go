package app

import (
	"context"
	"testing"
	"time"
)

func wokeWithin(c <-chan struct{}, within time.Duration) bool {
	select {
	case <-c:
		return true
	case <-time.After(within):
		return false
	}
}

func TestPaceSleepsWhileIdleAndWakesAtOnce(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	wake := make(chan struct{}, 1)
	ticks := make(chan struct{}, 8)
	done := make(chan struct{})
	go func() {
		defer close(done)
		pace(ctx, wake, pacing{base: time.Hour, idle: time.Hour}, func() bool { ticks <- struct{}{}; return false })
	}()
	defer func() { cancel(); <-done }()
	if !wokeWithin(ticks, 2*time.Second) {
		t.Fatal("no tick on start")
	}
	if wokeWithin(ticks, 150*time.Millisecond) {
		t.Fatal("ticked while idle")
	}
	poke(wake)
	if !wokeWithin(ticks, 2*time.Second) {
		t.Fatal("a wake didn't run a tick")
	}
}

func TestPaceBacksOffUntilItFindsWork(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	stamps := make(chan time.Time, 16)
	found := make(chan bool, 16)
	for _, f := range []bool{false, false, false, false, true, false} {
		found <- f
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		pace(ctx, nil, pacing{base: 50 * time.Millisecond, idle: 400 * time.Millisecond}, func() bool {
			stamps <- time.Now()
			select {
			case f := <-found:
				return f
			default:
				cancel()
				return false
			}
		})
	}()
	<-done
	close(stamps)
	var gaps []time.Duration
	var last time.Time
	for s := range stamps {
		if !last.IsZero() {
			gaps = append(gaps, s.Sub(last))
		}
		last = s
	}
	// Idle ticks back off 100, 200, 400, 400 ms; after finding work the next comes after the
	// base delay, and backing off starts over.
	ms := func(n int) time.Duration { return time.Duration(n) * time.Millisecond }
	if len(gaps) != 6 || gaps[0] < ms(90) || gaps[1] < ms(190) || gaps[2] < ms(390) || gaps[3] < ms(390) || gaps[4] > ms(300) || gaps[5] < ms(90) {
		t.Fatalf("gaps %v", gaps)
	}
}

func TestWorkListenerRelaysNotifications(t *testing.T) {
	db := isolatedDB(t)
	a := &App{DB: db}
	w := a.wakeups()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); a.listenForWork(ctx) }()
	defer func() { cancel(); <-done }()
	// Once it listens, it wakes both loops for anything enqueued meanwhile.
	if !wokeWithin(w.studio, 5*time.Second) {
		t.Fatal("listener never started")
	}
	wokeWithin(w.jobs, time.Second)
	// Another replica's enqueue arrives as a notification.
	if _, e := db.Exec(context.Background(), `SELECT pg_notify('savorly_work','jobs')`); e != nil {
		t.Fatal(e)
	}
	if !wokeWithin(w.jobs, 5*time.Second) {
		t.Fatal("notification didn't wake the jobs loop")
	}
	if wokeWithin(w.studio, 100*time.Millisecond) {
		t.Fatal("a jobs notification woke the studio loop")
	}
}
