package app

import (
	"context"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
)

func TestFinishedJobsStayFinished(t *testing.T) {
	db := isolatedDB(t)
	testUser(t, db, "cook")
	a := &App{DB: db}
	ctx := context.Background()
	job := func(id, key string) {
		t.Helper()
		if _, e := db.Exec(ctx, `INSERT INTO ai_jobs(id,user_id,kind,prompt,request_key,estimated_cost,status,provider_id) VALUES($1,'cook','video','A clip',$2,1.5,'processing','task')`, id, key); e != nil {
			t.Fatal(e)
		}
	}
	outcome := func(id string) (status, message string) {
		t.Helper()
		if e := db.QueryRow(ctx, `SELECT status,error FROM ai_jobs WHERE id=$1`, id).Scan(&status, &message); e != nil {
			t.Fatal(e)
		}
		return status, message
	}
	clip := jsonBytes(fiber.Map{"url": "https://media.example/clip.mp4"})
	// An admin cancels a video while its poll is in flight; the poll's result can't revive it.
	job("cancelled", "cancelled-key")
	cancelled := "Cancelled by an admin. The provider may still finish and bill this task."
	if _, e := db.Exec(ctx, `UPDATE ai_jobs SET status='failed',error=$1 WHERE id='cancelled'`, cancelled); e != nil {
		t.Fatal(e)
	}
	a.finishJob(ctx, "cancelled", clip, "")
	if status, message := outcome("cancelled"); status != "failed" || message != cancelled {
		t.Fatalf("cancelled job resurrected: %s %q", status, message)
	}
	// A sous-chef draft's media wakes the studio loop to attach it.
	w := a.wakeups()
	select {
	case <-w.studio:
	default:
	}
	job("studio", "studio-media")
	a.finishJob(ctx, "studio", clip, "")
	if status, _ := outcome("studio"); status != "completed" || !wokeWithin(w.studio, time.Second) {
		t.Fatalf("studio media: %s", status)
	}
	// Nor does a late failure undo a completed job.
	a.finishJob(ctx, "studio", nil, "The provider returned no usable video.")
	if status, _ := outcome("studio"); status != "completed" {
		t.Fatal(status)
	}
}
