package app

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5/pgxpool"
	"savorly/api/internal/narration"
)

// narrationFixture is a recipe with two steps, a provider that answers audio once release is
// closed (already closed unless wait), and a server factory for separate replicas.
func narrationFixture(t *testing.T, db *pgxpool.Pool, audio []byte, wait bool) (func(store *MediaStore) *fiber.App, chan struct{}) {
	t.Helper()
	testUser(t, db, "owner")
	if _, err := db.Exec(context.Background(), `INSERT INTO recipes(id,author_id,title,description,cuisine,minutes,servings,difficulty,ingredients,steps,published) VALUES('recipe','owner','Toast','Toast','Italian',5,1,'Easy','[]','[{"text":"Stir."},{"text":"Serve."}]',true)`); err != nil {
		t.Fatal(err)
	}
	release := make(chan struct{})
	if !wait {
		close(release)
	}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "audio/mpeg")
		_, _ = w.Write(audio)
	}))
	t.Cleanup(provider.Close)
	client := &narration.Client{Key: "test", Voice: "voice", URL: provider.URL}
	return func(store *MediaStore) *fiber.App {
		a := &App{DB: db, Narrator: client, Media: store, Context: context.Background()}
		f := fiber.New()
		f.Use(func(c fiber.Ctx) error { c.Locals("userID", "owner"); return c.Next() })
		f.Post("/recipes/:id/steps/:step/narration", a.prepareNarration)
		f.Get("/recipes/:id/steps/:step/narration/:key", a.readNarration)
		f.Post("/clean", func(c fiber.Ctx) error { a.cleanStudioSources(c.Context()); return nil })
		return f
	}, release
}

func narrationCall(t *testing.T, f *fiber.App, method, path, header string) (int, http.Header, []byte) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(`{"text":"Stir."}`))
	req.Header.Set("Content-Type", "application/json")
	if header != "" {
		req.Header.Set("Range", header)
	}
	res, err := f.Test(req, fiber.TestConfig{Timeout: 30 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, res.Header, b
}

func TestNarrationAudioInPrivateStorage(t *testing.T) {
	t.Setenv("AI_DAILY_BUDGET_USD", "10")
	storage := newMemoryS3(t)
	useMemoryS3(t, storage)
	db := isolatedDB(t)
	ctx := context.Background()
	audio := []byte("0123456789-fake-mp3")
	server, _ := narrationFixture(t, db, audio, false)
	f := server(NewMediaStore())
	prepare, read := "/recipes/recipe/steps/0/narration", "/recipes/recipe/steps/0/narration/"+narrationKey("recipe", 0, "Stir.", "voice")
	if status, _, b := narrationCall(t, f, "POST", prepare, ""); status != 200 {
		t.Fatalf("prepare: %d %s", status, b)
	}
	if status, _, b := narrationCall(t, f, "GET", read, ""); status != 200 || !bytes.Equal(b, audio) {
		t.Fatalf("first play: %d %q", status, b)
	}
	var object string
	var stored []byte
	var size int
	if err := db.QueryRow(ctx, `SELECT object_key,audio,size FROM recipe_narrations`).Scan(&object, &stored, &size); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(object, "narration/") || stored != nil || size != len(audio) {
		t.Fatalf("row %q %v %d", object, stored, size)
	}
	if o, ok := storage.object("sources/" + object); !ok || !bytes.Equal(o.data, audio) || o.mime != "audio/mpeg" || o.cache != "private,no-store" {
		t.Fatalf("object %v %+v", ok, o)
	}
	// Another replica streams it from storage, ranges included, and touches its last use.
	if _, err := db.Exec(ctx, `UPDATE recipe_narrations SET last_used_at=now()-interval '2 days'`); err != nil {
		t.Fatal(err)
	}
	replica := server(NewMediaStore())
	if status, h, b := narrationCall(t, replica, "GET", read, ""); status != 200 || !bytes.Equal(b, audio) || h.Get("Accept-Ranges") != "bytes" || h.Get("Content-Type") != "audio/mpeg" {
		t.Fatalf("replica: %d %v %q", status, h, b)
	}
	var stale bool
	if err := db.QueryRow(ctx, `SELECT last_used_at<now()-interval '1 hour' FROM recipe_narrations`).Scan(&stale); err != nil || stale {
		t.Fatalf("last use not recorded: %v", err)
	}
	for _, tc := range []struct {
		header, body, contentRange string
		status                     int
	}{{"bytes=0-1", "01", "bytes 0-1/19", 206}, {"bytes=15-", "-mp3", "bytes 15-18/19", 206}, {"bytes=-3", "mp3", "bytes 16-18/19", 206}, {"bytes=99-", "", "bytes */19", 416}} {
		status, h, b := narrationCall(t, replica, "GET", read, tc.header)
		if status != tc.status || h.Get("Content-Range") != tc.contentRange || (status == 206 && string(b) != tc.body) {
			t.Errorf("range %s: %d %q %q", tc.header, status, h.Get("Content-Range"), b)
		}
	}
	// Rows from before keep playing from Postgres.
	if _, err := db.Exec(ctx, `INSERT INTO recipe_narrations(cache_key,recipe_id,audio) VALUES($1,'recipe','older-bytes')`, narrationKey("recipe", 1, "Serve.", "voice")); err != nil {
		t.Fatal(err)
	}
	if status, _, b := narrationCall(t, replica, "GET", "/recipes/recipe/steps/1/narration/"+narrationKey("recipe", 1, "Serve.", "voice"), ""); status != 200 || string(b) != "older-bytes" {
		t.Fatalf("bytea row: %d %q", status, b)
	}
	// Without object storage a stored recording can't be read, and says so.
	if status, _, _ := narrationCall(t, server(nil), "GET", read, ""); status != 503 {
		t.Fatalf("no storage: %d", status)
	}
	// Purged by the janitor, the object is queued and removed from the bucket.
	if _, err := db.Exec(ctx, `UPDATE recipe_narrations SET last_used_at=now()-interval '61 days' WHERE object_key IS NOT NULL`); err != nil {
		t.Fatal(err)
	}
	if counts, err := runJanitor(ctx, db); err != nil || counts["recipe_narrations"] != 1 {
		t.Fatalf("purge: %v %v", counts, err)
	}
	narrationCall(t, replica, "POST", "/clean", "")
	if _, ok := storage.object("sources/" + object); ok {
		t.Fatal("purged recording left in storage")
	}
	// A recording lost from storage is dropped, so the next read-aloud makes it again.
	if _, err := db.Exec(ctx, `INSERT INTO recipe_narrations(cache_key,recipe_id,object_key,size) VALUES($1,'recipe','narration/lost.mp3',5)`, narrationKey("recipe", 0, "Stir.", "voice")); err != nil {
		t.Fatal(err)
	}
	if status, _, _ := narrationCall(t, replica, "GET", read, ""); status != 404 {
		t.Fatalf("lost recording: %d", status)
	}
	var rows int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM recipe_narrations WHERE cache_key=$1`, narrationKey("recipe", 0, "Stir.", "voice")).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("lost recording kept: %d %v", rows, err)
	}
}

func TestNarrationReplicaWaitsForStoredRecording(t *testing.T) {
	t.Setenv("AI_DAILY_BUDGET_USD", "10")
	storage := newMemoryS3(t)
	useMemoryS3(t, storage)
	db := isolatedDB(t)
	audio := []byte("slow-fake-mp3")
	server, release := narrationFixture(t, db, audio, true)
	generating, waiting := server(NewMediaStore()), server(NewMediaStore())
	if status, _, _ := narrationCall(t, generating, "POST", "/recipes/recipe/steps/0/narration", ""); status != 200 {
		t.Fatal("prepare")
	}
	// The GET lands on a replica without the live stream: it waits for the shared cache.
	done := make(chan []byte, 1)
	go func() {
		_, _, b := narrationCall(t, waiting, "GET", "/recipes/recipe/steps/0/narration/"+narrationKey("recipe", 0, "Stir.", "voice"), "")
		done <- b
	}()
	time.Sleep(300 * time.Millisecond)
	close(release)
	select {
	case b := <-done:
		if !bytes.Equal(b, audio) {
			t.Fatalf("waiting replica got %q", b)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("waiting replica never answered")
	}
}

// Opt-in, against the local SeaweedFS: recordings land in the private bucket, unreadable
// without credentials, and leave it when purged.
func TestNarrationObjectStorageIntegration(t *testing.T) {
	if os.Getenv("TEST_OBJECT_STORAGE") != "true" {
		t.Skip("set TEST_OBJECT_STORAGE=true with local S3_* settings")
	}
	endpoint := os.Getenv("S3_ENDPOINT")
	if endpoint != "http://localhost:8333" && endpoint != "http://127.0.0.1:8333" {
		t.Fatal("storage integration tests require the local SeaweedFS endpoint")
	}
	t.Setenv("AI_DAILY_BUDGET_USD", "10")
	db := isolatedDB(t)
	ctx := context.Background()
	audio := []byte("integration-fake-mp3")
	server, _ := narrationFixture(t, db, audio, false)
	store := NewMediaStore()
	f := server(store)
	read := "/recipes/recipe/steps/0/narration/" + narrationKey("recipe", 0, "Stir.", "voice")
	narrationCall(t, f, "POST", "/recipes/recipe/steps/0/narration", "")
	if status, _, b := narrationCall(t, f, "GET", read, ""); status != 200 || !bytes.Equal(b, audio) {
		t.Fatalf("play: %d %q", status, b)
	}
	var object string
	if err := db.QueryRow(ctx, `SELECT object_key FROM recipe_narrations`).Scan(&object); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		store.S3.DeleteObject(context.Background(), &s3.DeleteObjectInput{Bucket: aws.String(store.SourceBucket), Key: aws.String(object)})
	})
	if status, _, b := narrationCall(t, server(NewMediaStore()), "GET", read, "bytes=0-10"); status != 206 || !bytes.Equal(b, audio[:11]) {
		t.Fatalf("range from storage: %d %q", status, b)
	}
	public, err := http.Get(endpoint + "/" + store.SourceBucket + "/" + object)
	if err != nil {
		t.Fatal(err)
	}
	public.Body.Close()
	if public.StatusCode != 403 {
		t.Fatalf("recording publicly readable: %d", public.StatusCode)
	}
	if _, err = db.Exec(ctx, `DELETE FROM recipes WHERE id='recipe'`); err != nil {
		t.Fatal(err)
	}
	narrationCall(t, f, "POST", "/clean", "")
	if _, err = store.S3.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(store.SourceBucket), Key: aws.String(object)}); err == nil {
		t.Fatal("recording outlived its recipe")
	}
}
