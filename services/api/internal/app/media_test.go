package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
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
	"github.com/google/uuid"
)

func testPNG(t *testing.T) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6dWQAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestMediaStoreS3Contract(t *testing.T) {
	png := testPNG(t)
	paths := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		objectPath := r.URL.Path
		paths <- objectPath
		body, err := io.ReadAll(r.Body)
		if err != nil || !bytes.Equal(body, png) {
			t.Error("object bytes changed in transit")
		}
		if r.Method != http.MethodPut || !strings.HasPrefix(objectPath, "/recipes/owner/") || !strings.HasSuffix(objectPath, ".png") {
			t.Errorf("unexpected object request: %s %s", r.Method, objectPath)
		}
		if r.Header.Get("Content-Type") != "image/png" || r.Header.Get("Cache-Control") != "public,max-age=31536000,immutable" {
			t.Error("missing content type or immutable caching")
		}
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") {
			t.Error("unsigned S3 upload")
		}
		w.Header().Set("ETag", `"test"`)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	t.Setenv("S3_ENDPOINT", server.URL)
	t.Setenv("S3_ACCESS_KEY_ID", "test-key")
	t.Setenv("S3_SECRET_ACCESS_KEY", "test-secret")
	t.Setenv("S3_BUCKET", "recipes")
	t.Setenv("S3_PUBLIC_URL", "https://media.example.com/")
	t.Setenv("S3_FORCE_PATH_STYLE", "true")
	url, err := NewMediaStore().Put(context.Background(), "owner", png)
	if err != nil {
		t.Fatal(err)
	}
	objectPath := <-paths
	if url != "https://media.example.com"+strings.TrimPrefix(objectPath, "/recipes") {
		t.Fatalf("wrong public URL: %s", url)
	}
}

func TestMediaRequiresObjectStorage(t *testing.T) {
	_, err := (&MediaStore{}).Put(context.Background(), "owner", testPNG(t))
	var status *fiber.Error
	if !errors.As(err, &status) || status.Code != 503 {
		t.Fatalf("expected storage unavailable, got %v", err)
	}
}

// Opt-in test against the local object store; never run this against a production bucket.
func TestObjectStorageIntegration(t *testing.T) {
	if os.Getenv("TEST_OBJECT_STORAGE") != "true" {
		t.Skip("set TEST_OBJECT_STORAGE=true with local S3_* settings")
	}
	endpoint := os.Getenv("S3_ENDPOINT")
	if endpoint != "http://localhost:8333" && endpoint != "http://127.0.0.1:8333" {
		t.Fatal("storage integration tests require the local SeaweedFS endpoint")
	}
	store := NewMediaStore()
	if store.S3 == nil {
		t.Fatal("configure local S3_* environment variables")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client := &http.Client{Timeout: 10 * time.Second}
	owner := "storage-test-" + uuid.NewString()
	for _, fixture := range []struct{ name, mime string }{{"sample.png", "image/png"}, {"sample.mp4", "video/mp4"}} {
		t.Run(fixture.name, func(t *testing.T) {
			data, err := os.ReadFile("../../../../apps/mobile/tests/fixtures/" + fixture.name)
			if err != nil {
				t.Fatal(err)
			}
			url, err := store.Put(ctx, owner, data)
			if err != nil {
				t.Fatal(err)
			}
			key := strings.TrimPrefix(url, store.BaseURL+"/")
			t.Cleanup(func() {
				cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cleanupCancel()
				if _, err := store.S3.DeleteObject(cleanupCtx, &s3.DeleteObjectInput{Bucket: aws.String(store.Bucket), Key: aws.String(key)}); err != nil {
					t.Errorf("cleanup object: %v", err)
				}
			})
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
			req.Header.Set("Origin", "http://localhost:8081")
			res, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(res.Body)
			res.Body.Close()
			if err != nil || res.StatusCode != 200 || !bytes.Equal(body, data) {
				t.Fatalf("public read failed: status=%d error=%v", res.StatusCode, err)
			}
			if res.Header.Get("Content-Type") != fixture.mime || res.Header.Get("Access-Control-Allow-Origin") != "http://localhost:8081" {
				t.Fatalf("incorrect MIME or CORS: %v", res.Header)
			}
			req, _ = http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
			req.Header.Set("Range", "bytes=0-15")
			res, err = client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, err = io.ReadAll(res.Body)
			res.Body.Close()
			if err != nil || res.StatusCode != 206 || !bytes.Equal(body, data[:16]) {
				t.Fatalf("byte range failed: status=%d error=%v", res.StatusCode, err)
			}
			for _, method := range []string{http.MethodPut, http.MethodDelete} {
				req, _ = http.NewRequestWithContext(ctx, method, url, bytes.NewReader(data))
				res, err = client.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				io.Copy(io.Discard, res.Body)
				res.Body.Close()
				if res.StatusCode != 403 {
					t.Fatalf("anonymous %s should be forbidden, got %d", method, res.StatusCode)
				}
			}
		})
	}
	res, err := client.Get(store.BaseURL + "?list-type=2")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("anonymous listing should be forbidden, got %d", res.StatusCode)
	}
}
