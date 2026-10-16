package app

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
)

type MediaStore struct {
	S3              *s3.Client
	Bucket, BaseURL string
	SourceBucket    string
}

func NewMediaStore() *MediaStore {
	s := &MediaStore{
		Bucket:       Env("S3_BUCKET", "savorly-media"),
		SourceBucket: Env("S3_SOURCE_BUCKET", "savorly-sources"),
		BaseURL:      strings.TrimRight(Env("S3_PUBLIC_URL", ""), "/"),
	}
	endpoint, accessKey, secretKey := Env("S3_ENDPOINT", ""), Env("S3_ACCESS_KEY_ID", ""), Env("S3_SECRET_ACCESS_KEY", "")
	if endpoint != "" && accessKey != "" && secretKey != "" && s.BaseURL != "" {
		// R2 and local SeaweedFS share the S3 protocol and the same object write path.
		s.S3 = s3.New(s3.Options{
			Region: Env("S3_REGION", "auto"), BaseEndpoint: aws.String(endpoint),
			Credentials:                credentials.NewStaticCredentialsProvider(accessKey, secretKey, ""),
			UsePathStyle:               Env("S3_FORCE_PATH_STYLE", "true") == "true",
			RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
			ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired,
		})
	}
	return s
}
func mediaType(data []byte) (string, string) {
	mime := http.DetectContentType(data)
	switch mime {
	case "image/jpeg":
		return mime, ".jpg"
	case "image/png":
		return mime, ".png"
	case "image/webp":
		return mime, ".webp"
	case "video/mp4":
		return mime, ".mp4"
	case "video/webm":
		return mime, ".webm"
	}
	return "", ""
}
func (s *MediaStore) Put(ctx context.Context, owner string, data []byte) (string, error) {
	mime, ext := mediaType(data)
	if ext == "" {
		return "", fiber.NewError(400, "Use a JPEG, PNG, WebP, MP4, or WebM file.")
	}
	if len(data) > 50*1024*1024 {
		return "", fiber.NewError(400, "Choose a file smaller than 50 MB.")
	}
	key := owner + "/" + uuid.NewString() + ext
	if s.S3 == nil || s.BaseURL == "" || s.Bucket == "" {
		return "", fiber.NewError(503, "Media storage has not been configured.")
	}
	_, e := s.S3.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(s.Bucket), Key: aws.String(key), Body: bytes.NewReader(data), ContentType: aws.String(mime), CacheControl: aws.String("public,max-age=31536000,immutable")})
	if e != nil {
		return "", e
	}
	return s.BaseURL + "/" + key, nil
}

// Own reports whether url is a file this owner uploaded or generated, as opposed to anyone else's.
func (s *MediaStore) Own(owner, url string) bool {
	return s.BaseURL != "" && strings.HasPrefix(url, s.BaseURL+"/"+owner+"/") && !strings.Contains(url, "..")
}

// Read returns a photo of at most limit bytes: the owner's own files straight from storage,
// anything else downloaded from its public HTTPS address.
func (s *MediaStore) Read(ctx context.Context, owner, url string, limit int64) ([]byte, error) {
	if !s.Own(owner, url) {
		return download(ctx, url, limit)
	}
	if s.S3 == nil {
		return nil, fiber.NewError(503, "Media storage has not been configured.")
	}
	out, e := s.S3.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.Bucket), Key: aws.String(strings.TrimPrefix(url, s.BaseURL+"/"))})
	if e != nil {
		return nil, e
	}
	defer out.Body.Close()
	data, e := io.ReadAll(io.LimitReader(out.Body, limit+1))
	if e == nil && int64(len(data)) > limit {
		e = fmt.Errorf("media exceeds %d bytes", limit)
	}
	return data, e
}
func (a *App) uploadMedia(c fiber.Ctx) error {
	file, e := c.FormFile("file")
	if e != nil {
		return fiber.NewError(400, "Choose a file to upload.")
	}
	if file.Size > 50*1024*1024 {
		return fiber.NewError(400, "Choose a file smaller than 50 MB.")
	}
	f, e := file.Open()
	if e != nil {
		return e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, 50*1024*1024+1))
	if e != nil {
		return e
	}
	url, e := a.Media.Put(c.Context(), userID(c), b)
	if e != nil {
		return e
	}
	return c.Status(201).JSON(fiber.Map{"url": url})
}

// Recipe-source photographs use a separate bucket with no public domain or anonymous read policy.
func (s *MediaStore) ensureSourceBucket(ctx context.Context, production bool) error {
	_, e := s.S3.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(s.SourceBucket)})
	if e == nil {
		return nil
	}
	if production {
		return fiber.NewError(503, "Configure the private recipe-source bucket before importing photos.")
	}
	_, e = s.S3.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(s.SourceBucket)})
	return e
}
