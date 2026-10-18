package app

import (
	"errors"
	"io"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/gofiber/fiber/v3"
	"github.com/gofiber/fiber/v3/middleware/limiter"
	"github.com/google/uuid"
)

// mediaReadTimeout is the server ReadTimeout for app.go: a 50 MB multipart upload to /media
// on a slow mobile connection takes minutes, and the server reads the whole request first.
const mediaReadTimeout = 5 * time.Minute

// Direct uploads: the app asks for a presigned PUT, sends the file straight to storage, then
// confirms it. Large videos never pass through the API, so they can't time out in it.
var uploadTypes = map[string]map[string]string{
	"image": {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"},
	"video": {"video/mp4": ".mp4", "video/webm": ".webm"},
	// Family recordings (family.go): AAC in MP4 from phones and Safari, WebM from other browsers,
	// and MP3.
	"audio": {"audio/mp4": ".m4a", "audio/webm": ".weba", "audio/mpeg": ".mp3"},
}

const uploadExpiry = 15 * time.Minute

var uploadName = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|mp4|webm|m4a|weba|mp3)$`)

// The refusals of a file of the wrong type, by kind.
const (
	wrongMedia     = "Use a JPEG, PNG, WebP, MP4, or WebM file."
	wrongRecording = "Use an M4A, WebM or MP3 recording."
)

// uploadSize is the most a direct upload of type mime may hold, and the refusal past it: recordings
// stay within what speech-to-text takes in one request.
func uploadSize(mime string) (int64, string) {
	if strings.HasPrefix(mime, "audio/") {
		return maxRecordingBytes, "Choose a recording smaller than 25 MB."
	}
	return maxMediaBytes, "Choose a file smaller than 50 MB."
}

// audioType is the kind of recording data starts with: MP4 (an ftyp box, as AAC recordings are
// kept), WebM (an EBML header) or MP3 (an ID3 tag or a frame header); "" for anything else.
func audioType(data []byte) string {
	switch {
	case len(data) >= 12 && string(data[4:8]) == "ftyp":
		return "audio/mp4"
	case len(data) >= 4 && string(data[:4]) == "\x1a\x45\xdf\xa3":
		return "audio/webm"
	case len(data) >= 3 && string(data[:3]) == "ID3", len(data) >= 2 && data[0] == 0xff && data[1]&0xe0 == 0xe0:
		return "audio/mpeg"
	}
	return ""
}

// uploadPrefix is where a member's direct uploads live in the public media bucket.
func uploadPrefix(owner string) string { return "uploads/" + owner + "/" }

// uploadLimit keeps each member to a steady stream of uploads rather than a storage-filling one.
func uploadLimit() fiber.Handler {
	return limiter.New(limiter.Config{Max: 60, Expiration: time.Hour,
		KeyGenerator: func(c fiber.Ctx) string { return "upload:" + userID(c) },
		LimitReached: func(c fiber.Ctx) error {
			return fiber.NewError(429, "Too many requests. Please wait a moment and try again.")
		}})
}

func (a *App) createUpload(c fiber.Ctx) error {
	var in struct {
		Kind        string `json:"kind"`
		ContentType string `json:"contentType"`
		Size        int64  `json:"size"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	ext, ok := uploadTypes[in.Kind][in.ContentType]
	if !ok && in.Kind == "audio" {
		return fiber.NewError(400, wrongRecording)
	}
	if !ok {
		return fiber.NewError(400, wrongMedia)
	}
	if limit, tooLarge := uploadSize(in.ContentType); in.Size < 1 || in.Size > limit {
		return fiber.NewError(400, tooLarge)
	}
	if a.Media == nil || a.Media.Presign == nil || a.Media.BaseURL == "" {
		return fiber.NewError(503, "Media storage has not been configured.")
	}
	key := uploadPrefix(userID(c)) + uuid.NewString() + ext
	expires := time.Now().Add(uploadExpiry).UTC()
	// Type, cache policy and exact length are signed, so storage refuses any other upload.
	signed, e := a.Media.Presign.PresignPutObject(c.Context(), &s3.PutObjectInput{
		Bucket: aws.String(a.Media.Bucket), Key: aws.String(key), ContentType: aws.String(in.ContentType),
		ContentLength: aws.Int64(in.Size), CacheControl: aws.String(publicCache),
	}, s3.WithPresignExpires(uploadExpiry))
	if e != nil {
		return e
	}
	a.queueUpload(c.Context(), a.Media.BaseURL+"/"+key)
	return c.JSON(fiber.Map{
		"uploadUrl": signed.URL, "method": "PUT",
		"headers": fiber.Map{"Content-Type": in.ContentType, "Cache-Control": publicCache},
		"url":     a.Media.BaseURL + "/" + key, "key": key, "expiresAt": expires.Format(time.RFC3339),
	})
}

// completeUpload confirms a direct upload: the member's own key, and a file whose size, label
// and signature all match what was signed. Anything else is deleted.
func (a *App) completeUpload(c fiber.Ctx) error {
	var in struct {
		Key string `json:"key"`
	}
	if e := decode(c, &in); e != nil {
		return e
	}
	name, mine := strings.CutPrefix(in.Key, uploadPrefix(userID(c)))
	if !mine || !uploadName.MatchString(name) {
		return fiber.NewError(404, "Upload not found.")
	}
	if a.Media == nil || a.Media.S3 == nil || a.Media.BaseURL == "" {
		return fiber.NewError(503, "Media storage has not been configured.")
	}
	ctx, bucket, key := c.Context(), aws.String(a.Media.Bucket), aws.String(in.Key)
	head, e := a.Media.S3.HeadObject(ctx, &s3.HeadObjectInput{Bucket: bucket, Key: key})
	if storageNotFound(e) {
		return fiber.NewError(404, "Upload not found.")
	}
	if e != nil {
		return e
	}
	refuse := func(message string) error {
		if _, e := a.Media.S3.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: bucket, Key: key}); e != nil {
			return e
		}
		return fiber.NewError(400, message)
	}
	want := ""
	for _, types := range uploadTypes {
		for mime, ext := range types {
			if ext == path.Ext(name) {
				want = mime
			}
		}
	}
	if limit, tooLarge := uploadSize(want); aws.ToInt64(head.ContentLength) < 1 || aws.ToInt64(head.ContentLength) > limit {
		return refuse(tooLarge)
	}
	// The signed Content-Type only labels the bytes; check what they are.
	first, e := a.Media.S3.GetObject(ctx, &s3.GetObjectInput{Bucket: bucket, Key: key, Range: aws.String("bytes=0-511")})
	if e != nil {
		return e
	}
	sniff, e := io.ReadAll(io.LimitReader(first.Body, 512))
	first.Body.Close()
	if e != nil {
		return e
	}
	got, _ := mediaType(sniff)
	wrong := wrongMedia
	if strings.HasPrefix(want, "audio/") {
		// Recordings come in containers videos use too, so they're judged as recordings.
		got, wrong = audioType(sniff), wrongRecording
	}
	if got != want || aws.ToString(head.ContentType) != want {
		return refuse(wrong)
	}
	return c.JSON(fiber.Map{"url": a.Media.BaseURL + "/" + in.Key})
}

// storageNotFound reports an object storage 404.
func storageNotFound(e error) bool {
	var status interface{ HTTPStatusCode() int }
	return errors.As(e, &status) && status.HTTPStatusCode() == 404
}
