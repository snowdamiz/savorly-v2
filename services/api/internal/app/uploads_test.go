package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/gofiber/fiber/v3"
)

type presigned struct {
	UploadURL, Method, URL, Key string
	Headers                     map[string]string
	ExpiresAt                   time.Time
}

func uploadServer(a *App) *fiber.App {
	f := fiber.New(fiber.Config{BodyLimit: 55 * 1024 * 1024})
	f.Use(func(c fiber.Ctx) error { c.Locals("userID", c.Get("Test-User")); return c.Next() })
	f.Post("/media", a.uploadMedia)
	f.Post("/media/uploads", a.createUpload)
	f.Post("/media/uploads/complete", a.completeUpload)
	return f
}

func uploadCall(t *testing.T, f *fiber.App, path, user string, body any) (int, []byte) {
	t.Helper()
	req := httptest.NewRequest("POST", path, bytes.NewReader(jsonBytes(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Test-User", user)
	res, err := f.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, b
}

// putSigned sends data to a presigned URL the way the app does.
func putSigned(t *testing.T, p presigned, data []byte, origin string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(p.Method, p.UploadURL, bytes.NewReader(data))
	for k, v := range p.Headers {
		req.Header.Set(k, v)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	return res
}

func TestDirectUploadsPresignAndComplete(t *testing.T) {
	storage := newMemoryS3(t)
	useMemoryS3(t, storage)
	a := &App{Media: NewMediaStore()}
	f := uploadServer(a)
	png := testPNG(t)
	status, b := uploadCall(t, f, "/media/uploads", "cook", map[string]any{"kind": "image", "contentType": "image/png", "size": len(png)})
	var p presigned
	if status != 200 || json.Unmarshal(b, &p) != nil {
		t.Fatalf("presign: %d %s", status, b)
	}
	signed, _ := url.Parse(p.UploadURL)
	query := signed.Query()
	if p.Method != "PUT" || !strings.HasPrefix(p.Key, "uploads/cook/") || !strings.HasSuffix(p.Key, ".png") || p.URL != "https://media.example.com/"+p.Key ||
		signed.Path != "/media/"+p.Key || query.Get("X-Amz-Expires") != "900" || query.Get("X-Amz-Signature") == "" {
		t.Fatalf("presigned upload: %+v", p)
	}
	for _, h := range []string{"content-length", "content-type", "cache-control", "host"} {
		if !strings.Contains(query.Get("X-Amz-SignedHeaders"), h) {
			t.Fatalf("%s isn't signed: %s", h, query.Get("X-Amz-SignedHeaders"))
		}
	}
	if p.Headers["Content-Type"] != "image/png" || p.Headers["Cache-Control"] != publicCache || time.Until(p.ExpiresAt) > uploadExpiry || time.Until(p.ExpiresAt) < uploadExpiry-time.Minute {
		t.Fatalf("headers or expiry: %+v", p)
	}
	if !a.Media.Own("cook", p.URL) || a.Media.Own("other", p.URL) {
		t.Fatal("direct uploads belong to their uploader")
	}
	// Confirming before the upload, or someone else's key, finds nothing.
	if status, _ := uploadCall(t, f, "/media/uploads/complete", "cook", map[string]string{"key": p.Key}); status != 404 {
		t.Fatalf("complete before upload: %d", status)
	}
	if res := putSigned(t, p, png, ""); res.StatusCode != 200 {
		t.Fatalf("upload: %d", res.StatusCode)
	}
	for _, bad := range []struct{ user, key string }{
		{"other", p.Key}, {"cook", "cook/" + strings.TrimPrefix(p.Key, "uploads/cook/")},
		{"cook", "uploads/cook/../other/" + strings.TrimPrefix(p.Key, "uploads/cook/")}, {"cook", "uploads/cook/notes.txt"},
	} {
		if status, _ := uploadCall(t, f, "/media/uploads/complete", bad.user, map[string]string{"key": bad.key}); status != 404 {
			t.Errorf("complete %+v: %d", bad, status)
		}
	}
	status, b = uploadCall(t, f, "/media/uploads/complete", "cook", map[string]string{"key": p.Key})
	var done struct{ URL string }
	if status != 200 || json.Unmarshal(b, &done) != nil || done.URL != p.URL {
		t.Fatalf("complete: %d %s", status, b)
	}
	// A file labelled as a photo that isn't one is refused and removed.
	status, b = uploadCall(t, f, "/media/uploads", "cook", map[string]any{"kind": "image", "contentType": "image/png", "size": 30})
	if status != 200 || json.Unmarshal(b, &p) != nil {
		t.Fatalf("presign: %d %s", status, b)
	}
	putSigned(t, p, []byte("<!doctype html><script></script>"), "")
	if status, _ := uploadCall(t, f, "/media/uploads/complete", "cook", map[string]string{"key": p.Key}); status != 400 {
		t.Fatalf("disguised upload: %d", status)
	}
	if _, ok := storage.object("media/" + p.Key); ok {
		t.Fatal("disguised upload kept")
	}
	for _, bad := range []map[string]any{
		{"kind": "image", "contentType": "image/svg+xml", "size": 10}, {"kind": "image", "contentType": "video/mp4", "size": 10},
		{"kind": "audio", "contentType": "audio/mpeg", "size": 10}, {"kind": "video", "contentType": "video/mp4", "size": 51 << 20},
		{"kind": "image", "contentType": "image/png", "size": 0},
	} {
		if status, _ := uploadCall(t, f, "/media/uploads", "cook", bad); status != 400 {
			t.Errorf("presign %v: %d", bad, status)
		}
	}
	if status, _ := uploadCall(t, uploadServer(&App{Media: &MediaStore{}}), "/media/uploads", "cook", map[string]any{"kind": "image", "contentType": "image/png", "size": 10}); status != 503 {
		t.Fatalf("without storage: %d", status)
	}
}

func TestLegacyUploadStreamsLargeFiles(t *testing.T) {
	storage := newMemoryS3(t)
	useMemoryS3(t, storage)
	f := uploadServer(&App{Media: NewMediaStore()})
	// Past the server's 16 MB in-memory limit, the part is spooled to disk and streamed from there.
	data := append(testPNG(t), bytes.Repeat([]byte{0}, 17<<20)...)
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, _ := w.CreateFormFile("file", "large.png")
	part.Write(data)
	w.Close()
	req := httptest.NewRequest("POST", "/media", &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("Test-User", "cook")
	res, err := f.Test(req, fiber.TestConfig{Timeout: 30 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out struct{ URL string }
	if res.StatusCode != 201 || json.NewDecoder(res.Body).Decode(&out) != nil || !strings.HasPrefix(out.URL, "https://media.example.com/cook/") {
		t.Fatalf("upload: %d %+v", res.StatusCode, out)
	}
	stored, ok := storage.object("media/" + strings.TrimPrefix(out.URL, "https://media.example.com/"))
	if !ok || !bytes.Equal(stored.data, data) || stored.mime != "image/png" || stored.cache != publicCache {
		t.Fatalf("stored %d bytes of %d", len(stored.data), len(data))
	}
}

// Opt-in, against the local SeaweedFS only: a browser-style PUT with an Origin reaches storage.
func TestDirectUploadToLocalStorage(t *testing.T) {
	if os.Getenv("TEST_OBJECT_STORAGE") != "true" {
		t.Skip("set TEST_OBJECT_STORAGE=true with local S3_* settings")
	}
	if e := os.Getenv("S3_ENDPOINT"); e != "http://localhost:8333" && e != "http://127.0.0.1:8333" {
		t.Fatal("storage integration tests require the local SeaweedFS endpoint")
	}
	a := &App{Media: NewMediaStore()}
	f := uploadServer(a)
	data, err := os.ReadFile("../../../../apps/mobile/tests/fixtures/sample.mp4")
	if err != nil {
		t.Fatal(err)
	}
	status, b := uploadCall(t, f, "/media/uploads", "storage-test", map[string]any{"kind": "video", "contentType": "video/mp4", "size": len(data)})
	var p presigned
	if status != 200 || json.Unmarshal(b, &p) != nil {
		t.Fatalf("presign: %d %s", status, b)
	}
	t.Cleanup(func() {
		a.Media.S3.DeleteObject(context.Background(), &s3.DeleteObjectInput{Bucket: aws.String(a.Media.Bucket), Key: aws.String(p.Key)})
	})
	// The signature covers the length: a different file is refused.
	if res := putSigned(t, p, data[:len(data)-1], ""); res.StatusCode < 400 {
		t.Fatalf("a shorter file was accepted: %d", res.StatusCode)
	}
	res := putSigned(t, p, data, "http://localhost:8081")
	if res.StatusCode != 200 || res.Header.Get("Access-Control-Allow-Origin") != "http://localhost:8081" {
		t.Fatalf("browser upload: %d %v", res.StatusCode, res.Header)
	}
	status, b = uploadCall(t, f, "/media/uploads/complete", "storage-test", map[string]string{"key": p.Key})
	if status != 200 {
		t.Fatalf("complete: %d %s", status, b)
	}
	public, err := http.Get(p.URL)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(public.Body)
	public.Body.Close()
	if public.StatusCode != 200 || !bytes.Equal(got, data) || public.Header.Get("Content-Type") != "video/mp4" || public.Header.Get("Cache-Control") != publicCache {
		t.Fatalf("public read: %d %v", public.StatusCode, public.Header)
	}
}
