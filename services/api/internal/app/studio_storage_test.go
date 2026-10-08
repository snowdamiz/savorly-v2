package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/gofiber/fiber/v3"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestStudioSourcePhotoPrivateStorageAndCleanup(t *testing.T) {
	endpoint := os.Getenv("TEST_S3_ENDPOINT")
	if endpoint == "" {
		t.Skip("set TEST_S3_ENDPOINT to verify private source storage")
	}
	t.Setenv("S3_ENDPOINT", endpoint)
	t.Setenv("S3_ACCESS_KEY_ID", "savorly_local")
	t.Setenv("S3_SECRET_ACCESS_KEY", "savorly_local_only_change_for_any_shared_environment")
	t.Setenv("S3_PUBLIC_URL", endpoint+"/savorly-media")
	t.Setenv("S3_SOURCE_BUCKET", "savorly-sources")
	a, p := studioFixture(t)
	a.Media = NewMediaStore()
	ctx := context.Background()
	f := fiber.New()
	f.Post("/studio/:id/images", func(c fiber.Ctx) error { c.Locals("userID", "cook"); return a.studioImage(c) })
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, e := writer.CreateFormFile("file", "recipe.png")
	if e != nil {
		t.Fatal(e)
	}
	part.Write(testPNG(t))
	writer.Close()
	req := httptest.NewRequest("POST", "/studio/"+p+"/images", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	res, e := f.Test(req)
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	var out map[string]string
	json.NewDecoder(res.Body).Decode(&out)
	if res.StatusCode != 201 {
		t.Fatalf("photo upload %d %v", res.StatusCode, out)
	}
	id := out["id"]
	var key string
	if e = a.DB.QueryRow(ctx, `SELECT object_key FROM voice_sources WHERE id=$1`, id).Scan(&key); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		a.Media.S3.DeleteObject(context.Background(), &s3.DeleteObjectInput{Bucket: aws.String(a.Media.SourceBucket), Key: aws.String(key)})
	})
	public, e := http.Get(endpoint + "/savorly-sources/" + key)
	if e != nil {
		t.Fatal(e)
	}
	public.Body.Close()
	if public.StatusCode != 403 {
		t.Fatalf("recipe source was publicly readable: %d", public.StatusCode)
	}
	data, e := a.sourceData(ctx, p, []string{id})
	if e != nil || len(data) != 1 || data[0] != "data:image/png;base64,"+base64.StdEncoding.EncodeToString(testPNG(t)) {
		t.Fatalf("vision source read: %v", e)
	}
	_, e = a.DB.Exec(ctx, `DELETE FROM voice_projects WHERE id=$1`, p)
	if e != nil {
		t.Fatal(e)
	}
	a.cleanStudioSources(ctx)
	_, e = a.Media.S3.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(a.Media.SourceBucket), Key: aws.String(key)})
	if e == nil {
		t.Fatal("source object survived deletion")
	}
}
