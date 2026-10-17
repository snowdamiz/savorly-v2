package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type MediaStore struct {
	S3              *s3.Client
	Bucket, BaseURL string
	SourceBucket    string
	// Presign signs direct uploads for an endpoint the uploading device can reach.
	Presign *s3.PresignClient
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
		client := func(endpoint string) *s3.Client {
			return s3.New(s3.Options{
				Region: Env("S3_REGION", "auto"), BaseEndpoint: aws.String(endpoint),
				Credentials:                credentials.NewStaticCredentialsProvider(accessKey, secretKey, ""),
				UsePathStyle:               Env("S3_FORCE_PATH_STYLE", "true") == "true",
				RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
				ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired,
			})
		}
		s.S3 = client(endpoint)
		// The API may reach storage at an address devices can't (Docker's internal name).
		s.Presign = s3.NewPresignClient(client(Env("S3_UPLOAD_ENDPOINT", endpoint)))
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

const maxMediaBytes = 50 * 1024 * 1024
const publicCache = "public,max-age=31536000,immutable"

func (s *MediaStore) Put(ctx context.Context, owner string, data []byte) (string, error) {
	return s.PutReader(ctx, owner, bytes.NewReader(data), int64(len(data)))
}

// PutReader stores size bytes from body, checking the file's signature first. A seekable body
// is streamed to storage, so an upload is never held in memory as a whole.
func (s *MediaStore) PutReader(ctx context.Context, owner string, body io.ReadSeeker, size int64) (string, error) {
	head := make([]byte, 512)
	n, e := io.ReadFull(body, head)
	if e != nil && !errors.Is(e, io.ErrUnexpectedEOF) && !errors.Is(e, io.EOF) {
		return "", e
	}
	mime, ext := mediaType(head[:n])
	if ext == "" {
		return "", fiber.NewError(400, "Use a JPEG, PNG, WebP, MP4, or WebM file.")
	}
	if size > maxMediaBytes {
		return "", fiber.NewError(400, "Choose a file smaller than 50 MB.")
	}
	if _, e = body.Seek(0, io.SeekStart); e != nil {
		return "", e
	}
	key := owner + "/" + uuid.NewString() + ext
	if s.S3 == nil || s.BaseURL == "" || s.Bucket == "" {
		return "", fiber.NewError(503, "Media storage has not been configured.")
	}
	_, e = s.S3.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(s.Bucket), Key: aws.String(key), Body: body, ContentLength: aws.Int64(size), ContentType: aws.String(mime), CacheControl: aws.String(publicCache)})
	if e != nil {
		return "", e
	}
	return s.BaseURL + "/" + key, nil
}

// Own reports whether url is a file this owner uploaded or generated, as opposed to anyone else's.
func (s *MediaStore) Own(owner, url string) bool {
	if s.BaseURL == "" || strings.Contains(url, "..") {
		return false
	}
	return strings.HasPrefix(url, s.BaseURL+"/"+owner+"/") || strings.HasPrefix(url, s.BaseURL+"/"+uploadPrefix(owner))
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

// uploadMedia is the multipart upload older apps use. The server spools a large part to a
// temporary file while reading the request, and the part goes from there straight to storage.
func (a *App) uploadMedia(c fiber.Ctx) error {
	file, e := c.FormFile("file")
	if e != nil {
		return fiber.NewError(400, "Choose a file to upload.")
	}
	if file.Size > maxMediaBytes {
		return fiber.NewError(400, "Choose a file smaller than 50 MB.")
	}
	f, e := file.Open()
	if e != nil {
		return e
	}
	defer f.Close()
	url, e := a.Media.PutReader(c.Context(), userID(c), f, file.Size)
	if e != nil {
		return e
	}
	a.queueUpload(c.Context(), url)
	return c.Status(201).JSON(fiber.Map{"url": url})
}

// allowedMedia reports whether a recipe or profile may show url. Development takes any
// well-formed URL; production only our own storage and the hosts in MEDIA_HOSTS (plus extra),
// so pages can't hot-link, or track viewers through, someone else's server.
func (a *App) allowedMedia(raw string, extra ...string) bool {
	if !validMedia(raw) {
		return false
	}
	if raw == "" || !a.Config.Production {
		return true
	}
	base := strings.TrimRight(Env("S3_PUBLIC_URL", ""), "/")
	if a.Media != nil {
		base = a.Media.BaseURL
	}
	if base != "" && strings.HasPrefix(raw, base+"/") && !strings.Contains(raw, "..") {
		return true
	}
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.Port() != "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	for _, h := range append(strings.Split(os.Getenv("MEDIA_HOSTS"), ","), extra...) {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" && h == host {
			return true
		}
	}
	return false
}

// validAvatar is allowedMedia for profile photos, which may also be the Google account's.
func (a *App) validAvatar(raw string) bool {
	return a.allowedMedia(raw, "lh3.googleusercontent.com")
}

// checkRecipeMedia applies allowedMedia to a recipe's cover, gallery, video, and step photos and
// clips. Media the recipe already has stays valid, so older recipes with outside images can still
// be edited.
func (a *App) checkRecipeMedia(ctx context.Context, q querier, owner, id string, r RecipeInput, update bool) error {
	var stored map[string]bool
	media := append([]string{r.Image, r.Video}, r.Photos...)
	for _, s := range r.Steps {
		media = append(media, s.Image, s.Video)
	}
	for _, u := range media {
		if a.allowedMedia(u) {
			continue
		}
		if update && stored == nil {
			var image, video string
			var photos []string
			var steps []Step
			e := q.QueryRow(ctx, `SELECT image,video,photos,steps FROM recipes WHERE id=$1 AND author_id=$2`, id, owner).Scan(&image, &video, &photos, &steps)
			if e != nil && !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
			stored = map[string]bool{image: true, video: true}
			for _, p := range photos {
				stored[p] = true
			}
			for _, s := range steps {
				stored[s.Image], stored[s.Video] = true, true
			}
		}
		if !stored[u] {
			return fiber.NewError(400, "Add photos and videos by uploading them to Savorly.")
		}
	}
	return nil
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
