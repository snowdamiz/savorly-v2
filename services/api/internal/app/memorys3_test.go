package app

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// memoryS3 is an in-memory path-style object store for unit tests: PUT, GET (with Range), HEAD
// and DELETE on /<bucket>/<key>, HEAD on a bucket, and ListObjectsV2. It doesn't check
// signatures.
type memoryS3 struct {
	*httptest.Server
	mu      sync.Mutex
	objects map[string]memoryObject
}

type memoryObject struct {
	data        []byte
	mime, cache string
}

func newMemoryS3(t *testing.T) *memoryS3 {
	t.Helper()
	f := &memoryS3{objects: map[string]memoryObject{}}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		path := strings.TrimPrefix(r.URL.Path, "/")
		if r.Method == http.MethodGet && r.URL.Query().Get("list-type") == "2" {
			f.list(w, strings.TrimSuffix(path, "/"), r.URL.Query())
			return
		}
		if !strings.Contains(path, "/") {
			w.WriteHeader(200) // HeadBucket / CreateBucket
			return
		}
		switch r.Method {
		case http.MethodPut:
			b, _ := io.ReadAll(r.Body)
			f.objects[path] = memoryObject{data: b, mime: r.Header.Get("Content-Type"), cache: r.Header.Get("Cache-Control")}
			w.Header().Set("ETag", `"fake"`)
			w.WriteHeader(200)
		case http.MethodDelete:
			delete(f.objects, path)
			w.WriteHeader(204)
		case http.MethodGet, http.MethodHead:
			o, ok := f.objects[path]
			if !ok {
				w.Header().Set("Content-Type", "application/xml")
				w.WriteHeader(404)
				if r.Method == http.MethodGet {
					_, _ = w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>`))
				}
				return
			}
			w.Header().Set("Content-Type", o.mime)
			http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(o.data))
		default:
			w.WriteHeader(405)
		}
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *memoryS3) object(path string) (memoryObject, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	o, ok := f.objects[path]
	return o, ok
}

// list answers ListObjectsV2: a bucket's keys under prefix in order, max-keys at a time, with
// the last key as the continuation token. f.mu is held.
func (f *memoryS3) list(w http.ResponseWriter, bucket string, q url.Values) {
	prefix, after := q.Get("prefix"), q.Get("continuation-token")
	most, e := strconv.Atoi(q.Get("max-keys"))
	if e != nil || most <= 0 {
		most = 1000
	}
	keys := []string{}
	for path := range f.objects {
		if key, ok := strings.CutPrefix(path, bucket+"/"); ok && strings.HasPrefix(key, prefix) && key > after {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	truncated := len(keys) > most
	if truncated {
		keys = keys[:most]
	}
	var b strings.Builder
	fmt.Fprintf(&b, `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>%s</Name><KeyCount>%d</KeyCount><MaxKeys>%d</MaxKeys><IsTruncated>%t</IsTruncated>`, bucket, len(keys), most, truncated)
	for _, k := range keys {
		b.WriteString("<Contents><Key>")
		_ = xml.EscapeText(&b, []byte(k))
		fmt.Fprintf(&b, "</Key><Size>%d</Size></Contents>", len(f.objects[bucket+"/"+k].data))
	}
	if truncated {
		b.WriteString("<NextContinuationToken>")
		_ = xml.EscapeText(&b, []byte(keys[len(keys)-1]))
		b.WriteString("</NextContinuationToken>")
	}
	b.WriteString("</ListBucketResult>")
	w.Header().Set("Content-Type", "application/xml")
	_, _ = w.Write([]byte(b.String()))
}

// useMemoryS3 points NewMediaStore at f, with media in "media" and private files in "sources".
func useMemoryS3(t *testing.T, f *memoryS3) {
	t.Setenv("S3_ENDPOINT", f.URL)
	t.Setenv("S3_UPLOAD_ENDPOINT", "")
	t.Setenv("S3_ACCESS_KEY_ID", "test-key")
	t.Setenv("S3_SECRET_ACCESS_KEY", "test-secret")
	t.Setenv("S3_REGION", "us-east-1")
	t.Setenv("S3_BUCKET", "media")
	t.Setenv("S3_SOURCE_BUCKET", "sources")
	t.Setenv("S3_PUBLIC_URL", "https://media.example.com")
	t.Setenv("S3_FORCE_PATH_STYLE", "true")
}
