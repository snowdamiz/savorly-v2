package app

import (
	"context"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// Uploaded photos and videos leave storage once nothing uses them. Triggers
// (021_engagement.sql, with step clips since 023_step_clips.sql) queue a file's URL when a recipe
// (cover, video, gallery, step photo or step clip), a profile photo, an AI job in the member's
// history or a cooked-it photo stops using it, and a deleted account queues its upload folders.
// A day later the janitor checks again that nothing uses the file, and only then deletes it. It
// deletes nothing outside the media bucket's public URL (S3_PUBLIC_URL), and nothing there that
// isn't named the way Savorly names uploads.

const (
	// mediaGrace is how long a queued file waits, so an editor still open on an older version
	// of a recipe can save its photo back meanwhile.
	mediaGrace = 24 * time.Hour
	mediaBatch = 200
	// Per janitor pass: batches of queued files, and deleted accounts to list.
	mediaBatches = 10
	mediaOwners  = 5
	// Listing pages (1,000 keys each) per upload folder per pass; a larger folder takes more passes.
	mediaPages = 5
	// A file storage keeps refusing to delete is retried this many times, a pass apart.
	mediaAttempts = 24
)

// unusedUploadGrace is how long a new upload may go unused before it is deleted. Every upload
// waits in the deletion queue from the start, and whatever uses it by then keeps it, because
// deleteQueued checks before deleting; that covers files that were never saved into a recipe or
// profile, and direct uploads that were never confirmed. A draft kept on a device for longer
// than this loses its new photos, so it is generous.
const unusedUploadGrace = 14 * 24 * time.Hour

// queueUpload starts a new upload's wait in the deletion queue.
func (a *App) queueUpload(ctx context.Context, url string) {
	if a.DB == nil {
		return
	}
	if _, e := a.DB.Exec(ctx, `INSERT INTO media_deletions(url,queued_at) VALUES($1,now()+$2*interval '1 second') ON CONFLICT (url) DO NOTHING`, url, seconds(unusedUploadGrace-mediaGrace)); e != nil {
		slog.Warn("queue a new upload for cleanup", "error", e)
	}
}

// Media.Put stores <owner>/<uuid>.<ext>; direct uploads are uploads/<owner>/<uuid>.<ext>.
var mediaName = regexp.MustCompile(`^(uploads/)?[A-Za-z0-9_-]{1,64}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|mp4|webm)$`)

// mediaKey is the storage key of a public media URL Savorly stored, or false for anything
// else: another host, another name, or a URL with a query.
func (s *MediaStore) mediaKey(url string) (string, bool) {
	if s == nil || s.BaseURL == "" {
		return "", false
	}
	key, ok := strings.CutPrefix(url, s.BaseURL+"/")
	return key, ok && mediaName.MatchString(key)
}

// mediaInUse returns which of urls something still shows. Cooked-it photos count where that
// table exists (018_social.sql).
func mediaInUse(ctx context.Context, q engagementDB, urls []string) (map[string]bool, error) {
	used := map[string]bool{}
	if len(urls) == 0 {
		return used, nil
	}
	var cooks bool
	if e := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(format('%I.cooks',current_schema())) AND attname='photo' AND NOT attisdropped)`).Scan(&cooks); e != nil {
		return nil, e
	}
	sql := `SELECT DISTINCT u FROM (
 SELECT m AS u FROM recipes r CROSS JOIN LATERAL unnest(recipe_media(r.image,r.video,r.photos,r.steps)) m WHERE m=ANY($1)
 UNION ALL SELECT avatar FROM users WHERE avatar=ANY($1)
 UNION ALL SELECT v FROM ai_jobs j CROSS JOIN LATERAL unnest(ARRAY[j.result->>'url',j.source,j.result->'recipe'->>'image']) v WHERE v=ANY($1)`
	if cooks {
		sql += ` UNION ALL SELECT photo FROM cooks WHERE photo=ANY($1)`
	}
	rows, e := q.Query(ctx, sql+`) x`, urls)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	for rows.Next() {
		var u string
		if e = rows.Scan(&u); e != nil {
			return nil, e
		}
		used[u] = true
	}
	return used, rows.Err()
}

// cleanMedia is the janitor's storage step. It reports how many files it deleted.
func cleanMedia(ctx context.Context, q engagementDB, s *MediaStore) (int64, error) {
	if s == nil || s.S3 == nil || s.BaseURL == "" {
		// Without storage there is nothing to delete; what waited a month for it goes.
		if _, e := q.Exec(ctx, `DELETE FROM media_deletions WHERE queued_at<now()-interval '30 days'`); e != nil {
			return 0, e
		}
		_, e := q.Exec(ctx, `DELETE FROM media_owner_deletions WHERE queued_at<now()-interval '30 days'`)
		return 0, e
	}
	if e := s.queueOwnerFolders(ctx, q); e != nil {
		return 0, e
	}
	var deleted int64
	for range mediaBatches {
		n, more, e := s.deleteQueued(ctx, q)
		deleted += n
		if e != nil || !more {
			return deleted, e
		}
	}
	return deleted, nil
}

// queueOwnerFolders lists deleted accounts' upload folders and queues every file in them as
// due, so this pass checks and deletes them like any other.
func (s *MediaStore) queueOwnerFolders(ctx context.Context, q engagementDB) error {
	rows, e := q.Query(ctx, `SELECT owner FROM media_owner_deletions WHERE queued_at<now()-$1*interval '1 second' ORDER BY queued_at,owner LIMIT $2`, seconds(mediaGrace), mediaOwners)
	if e != nil {
		return e
	}
	var owners []string
	for rows.Next() {
		var owner string
		if e = rows.Scan(&owner); e != nil {
			rows.Close()
			return e
		}
		owners = append(owners, owner)
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return e
	}
	for _, owner := range owners {
		var urls []string
		listed := true
		for _, prefix := range []string{owner + "/", uploadPrefix(owner)} {
			var next *string
			for page := 0; ; page++ {
				if page == mediaPages {
					listed = false // the rest next pass, once these are gone
					break
				}
				out, e := s.S3.ListObjectsV2(ctx, &s3.ListObjectsV2Input{Bucket: aws.String(s.Bucket), Prefix: aws.String(prefix), ContinuationToken: next})
				if e != nil {
					return e
				}
				for _, o := range out.Contents {
					urls = append(urls, s.BaseURL+"/"+aws.ToString(o.Key))
				}
				if !aws.ToBool(out.IsTruncated) || out.NextContinuationToken == nil {
					break
				}
				next = out.NextContinuationToken
			}
		}
		if _, e = q.Exec(ctx, `INSERT INTO media_deletions(url,queued_at) SELECT DISTINCT unnest($1::text[]),now()-$2*interval '1 second' ON CONFLICT (url) DO NOTHING`, urls, seconds(mediaGrace)+1); e != nil {
			return e
		}
		if listed {
			if _, e = q.Exec(ctx, `DELETE FROM media_owner_deletions WHERE owner=$1`, owner); e != nil {
				return e
			}
		}
	}
	return nil
}

// deleteQueued handles one batch of due files and reports how many it deleted and whether
// more may be due.
func (s *MediaStore) deleteQueued(ctx context.Context, q engagementDB) (int64, bool, error) {
	rows, e := q.Query(ctx, `SELECT url,attempts FROM media_deletions WHERE queued_at<now()-$1*interval '1 second' ORDER BY queued_at,url LIMIT $2`, seconds(mediaGrace), mediaBatch)
	if e != nil {
		return 0, false, e
	}
	attempts := map[string]int{}
	var ours, done []string
	keys := map[string]string{}
	for rows.Next() {
		var url string
		var n int
		if e = rows.Scan(&url, &n); e != nil {
			rows.Close()
			return 0, false, e
		}
		attempts[url] = n
		if key, ok := s.mediaKey(url); ok {
			ours, keys[url] = append(ours, url), key
		} else {
			done = append(done, url) // not ours to delete
		}
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return 0, false, e
	}
	more := len(attempts) == mediaBatch
	used, e := mediaInUse(ctx, q, ours)
	if e != nil {
		return 0, false, e
	}
	var deleted int64
	var retry, abandon []string
	for _, url := range ours {
		if used[url] {
			// Whatever uses it queues it again when it stops.
			done = append(done, url)
			continue
		}
		_, e := s.S3.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.Bucket), Key: aws.String(keys[url])})
		if e != nil && !storageNotFound(e) {
			if ctx.Err() != nil {
				return deleted, false, ctx.Err()
			}
			if attempts[url]+1 >= mediaAttempts {
				slog.Error("media deletion abandoned", "url", url, "error", e)
				abandon = append(abandon, url)
			} else {
				slog.Warn("media deletion failed; retrying next pass", "url", url, "error", e)
				retry = append(retry, url)
			}
			continue
		}
		deleted++
		done = append(done, url)
	}
	if _, e = q.Exec(ctx, `DELETE FROM media_deletions WHERE url=ANY($1)`, append(done, abandon...)); e != nil {
		return deleted, false, e
	}
	// Due again at the next hourly pass, not later in this one.
	if _, e = q.Exec(ctx, `UPDATE media_deletions SET attempts=attempts+1,queued_at=now()-$2*interval '1 second'+interval '30 minutes' WHERE url=ANY($1)`, retry, seconds(mediaGrace)); e != nil {
		return deleted, false, e
	}
	return deleted, more, nil
}
