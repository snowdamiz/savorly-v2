package app

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
)

// A file uploaded but never used, like a photo picked in an editor that was then abandoned,
// leaves storage once its grace period is over; one a profile uses stays.
func TestUnusedUploadsLeaveStorage(t *testing.T) {
	m := newMediaFixture(t)
	testUser(t, m.db, "cook")
	f := uploadServer(&App{DB: m.db, Media: m.media})
	upload := func() string {
		t.Helper()
		var body bytes.Buffer
		w := multipart.NewWriter(&body)
		part, _ := w.CreateFormFile("file", "photo.png")
		part.Write(testPNG(t))
		w.Close()
		req := httptest.NewRequest("POST", "/media", &body)
		req.Header.Set("Content-Type", w.FormDataContentType())
		req.Header.Set("Test-User", "cook")
		res, e := f.Test(req, fiber.TestConfig{Timeout: 30 * time.Second})
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		var out struct{ URL string }
		if res.StatusCode != 201 || json.NewDecoder(res.Body).Decode(&out) != nil {
			t.Fatalf("upload: %d", res.StatusCode)
		}
		return out.URL
	}
	abandoned, kept := upload(), upload()
	m.exec(`UPDATE users SET avatar=$1 WHERE id='cook'`, kept)
	// Within the grace period nothing is touched.
	if n := m.pass(); n != 0 || !m.stored(abandoned) {
		t.Fatalf("deleted %d before the grace period ended", n)
	}
	// A direct upload is queued when it is signed, whether or not it ever arrives.
	if status, b := uploadCall(t, f, "/media/uploads", "cook", map[string]any{"kind": "image", "contentType": "image/jpeg", "size": 1000}); status != 200 {
		t.Fatalf("presign: %d %s", status, b)
	}
	if got := len(m.queued()); got != 3 {
		t.Fatalf("%d uploads queued, want 3", got)
	}
	m.exec(`UPDATE media_deletions SET queued_at=queued_at-$1*interval '1 second'`, seconds(unusedUploadGrace))
	if m.pass(); m.stored(abandoned) || !m.stored(kept) {
		t.Fatalf("abandoned stored: %v, kept stored: %v", m.stored(abandoned), m.stored(kept))
	}
	if left := m.queued(); len(left) != 0 {
		t.Fatalf("still queued: %v", left)
	}
}
