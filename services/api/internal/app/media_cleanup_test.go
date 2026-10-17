package app

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// mediaFixture uploads photos into the in-memory store and says which are still there.
type mediaFixture struct {
	t     *testing.T
	store *memoryS3
	media *MediaStore
	db    *pgxpool.Pool
}

func newMediaFixture(t *testing.T) *mediaFixture {
	t.Helper()
	store := newMemoryS3(t)
	useMemoryS3(t, store)
	return &mediaFixture{t: t, store: store, media: NewMediaStore(), db: isolatedDB(t)}
}

// upload stores a photo under folder (an owner, or uploads/<owner>) and returns its URL.
func (m *mediaFixture) upload(folder string) string {
	m.t.Helper()
	url, e := m.media.Put(context.Background(), folder, []byte("\xff\xd8\xff\xe0 a photo"))
	if e != nil {
		m.t.Fatal(e)
	}
	return url
}

func (m *mediaFixture) stored(url string) bool {
	_, ok := m.store.object("media/" + strings.TrimPrefix(url, "https://media.example.com/"))
	return ok
}

func (m *mediaFixture) queued() []string {
	m.t.Helper()
	var urls []string
	if e := m.db.QueryRow(context.Background(), `SELECT COALESCE(array_agg(url ORDER BY url),'{}') FROM media_deletions`).Scan(&urls); e != nil {
		m.t.Fatal(e)
	}
	return urls
}

func (m *mediaFixture) exec(sql string, args ...any) {
	m.t.Helper()
	if _, e := m.db.Exec(context.Background(), sql, args...); e != nil {
		m.t.Fatal(e)
	}
}

// pass runs the janitor once the queue has waited out its grace period, and returns how many
// files it deleted.
func (m *mediaFixture) pass() int64 {
	m.t.Helper()
	m.exec(`UPDATE media_deletions SET queued_at=queued_at-interval '25 hours'`)
	m.exec(`UPDATE media_owner_deletions SET queued_at=queued_at-interval '25 hours'`)
	counts, e := runJanitor(context.Background(), m.db)
	if e != nil {
		m.t.Fatal(e)
	}
	return counts["media"]
}

func sorted(urls ...string) []string {
	out := slices.Clone(urls)
	slices.Sort(out)
	return out
}

func TestMediaLeavesStorageOnceNothingUsesIt(t *testing.T) {
	m := newMediaFixture(t)
	ctx := context.Background()
	testUser(t, m.db, "cook")
	testUser(t, m.db, "fan")
	cover, video, first, shared, step, avatar := m.upload("cook"), m.upload("cook"), m.upload("cook"), m.upload("cook"), m.upload("uploads/cook"), m.upload("uploads/cook")
	outside := "https://images.example.com/cook/" + uuid.NewString() + ".jpg"
	publishRecipe(t, m.db, "cook", "soup", func(r *RecipeInput) {
		r.Image, r.Video, r.Photos = cover, video, []string{first, shared, outside}
	})
	m.exec(`UPDATE recipes SET steps=jsonb_set(steps,'{0,image}',to_jsonb($1::text)) WHERE id='soup'`, step)
	// Another cook's adaptation shows one of the same photos.
	publishRecipe(t, m.db, "fan", "copy", func(r *RecipeInput) { r.Image = shared })
	m.exec(`UPDATE users SET avatar=$1 WHERE id='cook'`, avatar)
	if got := m.queued(); len(got) != 0 {
		t.Fatalf("queued while in use: %v", got)
	}

	// A new cover and a shorter gallery release the old cover and the removed photo.
	newCover := m.upload("cook")
	m.exec(`UPDATE recipes SET image=$1,photos=jsonb_build_array($2::text,$3::text) WHERE id='soup'`, newCover, shared, outside)
	if got := m.queued(); !slices.Equal(got, sorted(cover, first)) {
		t.Fatalf("after editing: %v", got)
	}
	newAvatar := m.upload("uploads/cook")
	m.exec(`UPDATE users SET avatar=$1 WHERE id='cook'`, newAvatar)
	// A generated photo stays while the AI history shows it.
	generated := m.upload("cook")
	m.exec(`INSERT INTO ai_jobs(id,user_id,kind,prompt,status,request_key,result) VALUES('job','cook','image','p','completed','k',jsonb_build_object('url',$1::text))`, generated)
	publishRecipe(t, m.db, "cook", "toast", func(r *RecipeInput) { r.Image = generated })
	m.exec(`DELETE FROM recipes WHERE id IN ('soup','toast')`)
	if got := m.queued(); !slices.Equal(got, sorted(cover, first, avatar, newCover, video, shared, outside, step, generated)) {
		t.Fatalf("after deleting: %v", got)
	}

	// Nothing goes before the grace period ends.
	if counts, e := runJanitor(ctx, m.db); e != nil || counts["media"] != 0 || !m.stored(cover) {
		t.Fatalf("early pass: %v %v", counts, e)
	}
	if n := m.pass(); n != 6 {
		t.Fatalf("deleted %d files, want 6", n)
	}
	for _, url := range []string{cover, first, avatar, newCover, video, step} {
		if m.stored(url) {
			t.Errorf("%s is still stored", url)
		}
	}
	for _, url := range []string{shared, generated, newAvatar} {
		if !m.stored(url) {
			t.Errorf("%s, still in use, was deleted", url)
		}
	}
	if got := m.queued(); len(got) != 0 {
		t.Fatalf("left in the queue: %v", got)
	}
	// Once the job leaves the history, its photo goes.
	m.exec(`DELETE FROM ai_jobs WHERE id='job'`)
	if n := m.pass(); n != 1 || m.stored(generated) {
		t.Fatalf("generated photo: %d deleted", n)
	}

	// Nothing outside the media URL, or named otherwise, is ever deleted; a file already gone
	// is fine.
	m.store.mu.Lock()
	m.store.objects["media/brand/logo.png"] = memoryObject{data: []byte("logo")}
	m.store.mu.Unlock()
	missing := "https://media.example.com/cook/" + uuid.NewString() + ".webp"
	m.exec(`SELECT queue_media($1::text[])`, []string{"https://media.example.com/brand/logo.png", "https://other.example.com/cook/" + uuid.NewString() + ".jpg",
		"https://media.example.com/cook/../brand/logo.png", newAvatar + "?v=2", missing})
	if n := m.pass(); n != 1 {
		t.Fatalf("deleted %d", n)
	}
	if _, ok := m.store.object("media/brand/logo.png"); !ok || !m.stored(newAvatar) {
		t.Fatal("deleted something that isn't a queued upload")
	}
	if got := m.queued(); len(got) != 0 {
		t.Fatalf("left in the queue: %v", got)
	}
}

func TestDeletedAccountsLeaveStorage(t *testing.T) {
	m := newMediaFixture(t)
	testUser(t, m.db, "gone")
	testUser(t, m.db, "fan")
	avatar, cover, unused, generated, adapted := m.upload("uploads/gone"), m.upload("gone"), m.upload("uploads/gone"), m.upload("gone"), m.upload("gone")
	kept := m.upload("fan")
	m.exec(`UPDATE users SET avatar=$1 WHERE id='gone'`, avatar)
	publishRecipe(t, m.db, "gone", "soup", func(r *RecipeInput) { r.Image, r.Photos = cover, []string{adapted} })
	// A cook's adaptation of the recipe keeps showing one of its photos.
	publishRecipe(t, m.db, "fan", "copy", func(r *RecipeInput) { r.Image = adapted })
	m.exec(`DELETE FROM users WHERE id='gone'`)
	if n := count(t, m.db, `SELECT count(*) FROM media_owner_deletions WHERE owner='gone'`); n != 1 {
		t.Fatal("the account's folders weren't queued")
	}
	if n := m.pass(); n != 4 {
		t.Fatalf("deleted %d of the account's files, want 4", n)
	}
	for _, url := range []string{avatar, cover, unused, generated} {
		if m.stored(url) {
			t.Errorf("%s outlived its account", url)
		}
	}
	if !m.stored(adapted) || !m.stored(kept) {
		t.Fatal("deleted a file another cook uses")
	}
	if n := count(t, m.db, `SELECT count(*) FROM media_owner_deletions`); n != 0 {
		t.Fatal("the account's folders stayed queued")
	}
	// Large folders take more than one pass.
	testUser(t, m.db, "hoarder")
	m.exec(`DELETE FROM media_deletions`)
	m.store.mu.Lock()
	for range mediaPages*1000 + 10 {
		m.store.objects["media/hoarder/"+uuid.NewString()+".jpg"] = memoryObject{data: []byte("x")}
	}
	m.store.mu.Unlock()
	m.exec(`DELETE FROM users WHERE id='hoarder'`)
	if n := m.pass(); n != int64(mediaBatches*mediaBatch) {
		t.Fatalf("first pass deleted %d", n)
	}
	for range 30 {
		if count(t, m.db, `SELECT count(*) FROM media_owner_deletions`) == 0 && len(m.queued()) == 0 {
			break
		}
		m.pass()
	}
	left := 0
	m.store.mu.Lock()
	for path := range m.store.objects {
		if strings.HasPrefix(path, "media/hoarder/") {
			left++
		}
	}
	m.store.mu.Unlock()
	if left != 0 {
		t.Fatalf("%d files left", left)
	}
}

// Cooked-it photos (018_social.sql) count as used while shown, and go when their cook does. Before
// that migration exists, a stand-in table gets this migration's triggers.
func TestCookedPhotosLeaveStorage(t *testing.T) {
	m := newMediaFixture(t)
	ctx := context.Background()
	var exists bool
	if e := m.db.QueryRow(ctx, `SELECT to_regclass(format('%I.cooks',current_schema())) IS NOT NULL`).Scan(&exists); e != nil {
		t.Fatal(e)
	}
	if !exists {
		m.exec(`CREATE TABLE cooks(id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 recipe_id text NOT NULL REFERENCES recipes(id) ON DELETE CASCADE, photo text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, recipe_id))`)
		m.exec(`SELECT attach_social_triggers()`)
	}
	testUser(t, m.db, "cook")
	testUser(t, m.db, "fan")
	publishRecipe(t, m.db, "cook", "soup", nil)
	first, second := m.upload("uploads/fan"), m.upload("uploads/fan")
	m.exec(`INSERT INTO cooks(id,user_id,recipe_id,photo) VALUES('c1','fan','soup',$1)`, first)
	// Queued by something else, a photo a cook still shows stays.
	m.exec(`SELECT queue_media($1::text[])`, []string{first})
	if n := m.pass(); n != 0 || !m.stored(first) {
		t.Fatalf("deleted a cooked-it photo in use: %d", n)
	}
	m.exec(`UPDATE cooks SET photo=$1 WHERE id='c1'`, second)
	if got := m.queued(); !slices.Equal(got, []string{first}) {
		t.Fatalf("after a new photo: %v", got)
	}
	m.exec(`DELETE FROM cooks WHERE id='c1'`)
	if n := m.pass(); n != 2 || m.stored(first) || m.stored(second) {
		t.Fatalf("deleted %d", n)
	}
}

func TestMediaWaitsForStorage(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	if _, e := db.Exec(ctx, `SELECT queue_media(ARRAY['https://media.example.com/cook/`+uuid.NewString()+`.jpg']);
 INSERT INTO media_deletions(url,queued_at) VALUES('https://media.example.com/old.jpg',now()-interval '31 days')`); e != nil {
		t.Fatal(e)
	}
	// Without storage nothing is deleted, and what waited a month goes from the queue.
	if n, e := cleanMedia(ctx, db, &MediaStore{}); n != 0 || e != nil {
		t.Fatalf("%d %v", n, e)
	}
	if n := count(t, db, `SELECT count(*) FROM media_deletions`); n != 1 {
		t.Fatalf("%d queued", n)
	}
}

func TestMediaKeys(t *testing.T) {
	s := &MediaStore{BaseURL: "https://media.example.com"}
	id := uuid.NewString()
	for url, want := range map[string]string{
		"https://media.example.com/cook/" + id + ".jpg":            "cook/" + id + ".jpg",
		"https://media.example.com/uploads/cook/" + id + ".mp4":    "uploads/cook/" + id + ".mp4",
		"https://media.example.com/cook/" + id + ".jpg?x=1":        "",
		"https://media.example.com/../cook/" + id + ".jpg":         "",
		"https://media.example.com/brand/logo.png":                 "",
		"https://media.example.com.evil.test/cook/" + id + ".jpg":  "",
		"https://other.example.com/cook/" + id + ".jpg":            "",
		"https://media.example.com/a/b/cook/" + id + ".jpg":        "",
		"https://media.example.com/uploads/uploads/" + id + ".jpg": "uploads/uploads/" + id + ".jpg",
	} {
		key, ok := s.mediaKey(url)
		if ok != (want != "") || key != want && ok {
			t.Errorf("%s: %q %v, want %q", url, key, ok, want)
		}
	}
	if _, ok := (&MediaStore{}).mediaKey("https://media.example.com/cook/" + id + ".jpg"); ok {
		t.Error("a key without a media URL")
	}
}
