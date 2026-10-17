# Media storage

**Production: Cloudflare R2. Development: SeaweedFS 4.48 in Docker.** Photos, uploaded recipe videos, generated images, and generated videos all use the same Go S3 adapter. There is no filesystem upload fallback or MinIO dependency.

SeaweedFS was selected for its maintained S3 implementation and single-process local setup. The development container is pinned by version and multi-platform image digest. See the [4.48 release](https://github.com/seaweedfs/seaweedfs/releases/tag/4.48), [single-node setup](https://github.com/seaweedfs/seaweedfs/wiki/Quick-Start-with-weed-mini), and [S3 credentials](https://github.com/seaweedfs/seaweedfs/wiki/S3-Credentials).

## Local development

```sh
make setup
make services
make api
# In another terminal:
make web
```

`make services` starts Postgres and SeaweedFS and waits for their health checks. `make db` and `npm run db:up` are aliases for the same complete local setup. SeaweedFS creates the `savorly-media` bucket on startup. Its S3 endpoint is `http://localhost:8333`; public objects have URLs of the form `http://localhost:8333/savorly-media/<user-id>/<random-id>.png`.

The `.env.example` contains local-only credentials matching `infra/seaweedfs/s3.json`. The API authenticates writes, either itself or by signing a single direct upload (below); anonymous visitors can read media but cannot upload, delete, or list the bucket. CORS (`-s3.allowedOrigins` in Compose) allows the local Expo web origins to read and to `PUT` a presigned upload with its `Content-Type` and `Cache-Control` headers, so direct uploads work locally without further setup. Only the S3 port is published, bound to loopback. The other SeaweedFS services are internal to Docker. Development storage is capped at one CPU and 512 MiB of memory.

Media persists in the `savorly_media_data` Docker volume across API rebuilds, container recreation, and `docker compose down`. `docker compose down -v` intentionally destroys both database and media data. The local volume allocation allows roughly 1 GiB for development; increase `-volume.max` in Compose if needed.

For a containerized API, `docker compose --profile full up --build` overrides only the internal S3 endpoint to `http://storage:8333`. The public URL continues to use the browser-reachable host endpoint. Presigned uploads are signed for the host they will be sent to, so set `S3_UPLOAD_ENDPOINT=http://localhost:8333` for that profile (it defaults to `S3_ENDPOINT`).

For physical-device testing, use an HTTPS development tunnel for both the API and object endpoint. Set `EXPO_PUBLIC_API_URL` to the API tunnel, `S3_PUBLIC_URL` to the object tunnel plus `/savorly-media`, and `S3_UPLOAD_ENDPOINT` to the object tunnel so the device can send direct uploads. The API's own S3 endpoint remains local. Restart the API and create fresh uploads after changing the public URL; saved recipe URLs are not rewritten automatically.

## Production R2

Create two R2 buckets in the same jurisdiction: `savorly-media` for public recipe media and `savorly-sources` for private source imports. Grant the server token object read/write access to both. Enable a custom domain only on the media bucket; keep public access disabled on the source bucket. See the [dashboard setup steps](ACCOUNTS.md#r2-media-storage). Configure these server-side variables:

```dotenv
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_ACCESS_KEY_ID=<r2-access-key>
S3_SECRET_ACCESS_KEY=<r2-secret-key>
S3_BUCKET=savorly-media
S3_SOURCE_BUCKET=savorly-sources
S3_PUBLIC_URL=https://media.your-domain.com
S3_FORCE_PATH_STYLE=true
```

Use the bucket's correct jurisdiction-specific endpoint where applicable. Browsers never receive S3 credentials: they read public media, and they write only through the authenticated API or a presigned URL it signs for one object. See Cloudflare's [Go SDK example](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-go/), [presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) and [CORS configuration](https://developers.cloudflare.com/r2/buckets/cors/).

Set this CORS policy on `savorly-media` (R2 → the bucket → Settings → CORS policy), listing your app origins. It covers reads and range requests on the public domain, and the direct-upload `PUT` the browser sends to the S3 endpoint; `savorly-sources` needs none, because only the API reads it.

```json
[
  {
    "AllowedOrigins": ["https://savorly.cooking"],
    "AllowedMethods": ["GET", "HEAD", "PUT"],
    "AllowedHeaders": ["Content-Type", "Cache-Control", "Range"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]
```

Staging uses its own origin (`https://staging.savorly.cooking`) on `savorly-staging-media`. Native apps don't send an Origin and need no CORS.

Uploads are limited to 50 MiB, checked by file signature, and stored under randomized per-user keys with MIME and immutable cache headers. HTTPS generated-media downloads reject private-network addresses before importing bytes into the same store. Missing storage configuration returns `503`; there is no silent disk fallback.

### Direct uploads

Large files, videos especially, go straight from the device to storage instead of through the API, so a slow connection never meets the API's timeouts:

1. `POST /v1/media/uploads` with `{ "kind": "image" | "video", "contentType", "size" }` (JPEG, PNG or WebP photos; MP4 or WebM videos; up to 50 MiB) answers `{ uploadUrl, method: "PUT", headers, url, key, expiresAt }`. The URL is valid for 15 minutes, for one key under `uploads/<user-id>/` in the media bucket, and its signature covers the content type, the cache policy and the exact length, so storage refuses any other file. Each member can request 60 an hour.
2. The app sends the file to `uploadUrl` with exactly `headers`.
3. `POST /v1/media/uploads/complete` with `{ "key" }` checks that the key is the member's, then reads the object's size, type and first bytes; a file whose bytes aren't what its label says is deleted. It answers `{ url }`, which recipes and profiles accept like any other upload.

The app shows the upload's progress and can cancel it. When the API can't sign uploads (an older or unconfigured server answers `404` or `503`), or the browser's PUT fails before any byte is sent (a bucket without the CORS rules above), it falls back to `POST /v1/media` on its own, so a missing CORS rule makes web uploads slower rather than broken.

`POST /v1/media` (multipart field `file`) stays for older apps. The server spools a large part to a temporary file while it reads the request and streams it to storage from there; its read timeout allows a slow 50 MiB upload.

### Smaller images on cards

The app asks for photos at the width it shows them (snapped to a few sizes from 160 to 2048 pixels), so a feed card never downloads a full-size cover. The sample recipes' Unsplash photos resize through their address. For uploads, a build can use [Cloudflare Image Transformations](https://developers.cloudflare.com/images/transform-images/) on the media domain: enable transformations for the zone that serves `S3_PUBLIC_URL`, then build the app with `EXPO_PUBLIC_IMAGE_RESIZE=cloudflare` and `EXPO_PUBLIC_MEDIA_URL` set to that same public URL (it defaults to `https://media.savorly.cooking`). Photos on the media domain are then requested as `/cdn-cgi/image/width=…,quality=75,format=auto/<path>`. Transformations are billed per unique image and size, which is why the sizes are few. Without these settings every photo is requested as it was uploaded; the editor already resizes new photos to at most 2048 pixels before uploading them. Where a photo's host can resize it, the app also asks for a 32-pixel, blurred copy and shows it while the photo loads (`blurred()` in `apps/mobile/src/lib/images.ts`), so a card has the photo's colours at once; elsewhere the card shows a plain background.

### Media hosts in production

With `APP_ENV=production`, recipe covers, gallery photos and videos must be under `S3_PUBLIC_URL`, or on a host listed in `MEDIA_HOSTS` (comma-separated host names, for example `images.unsplash.com` for staging's fixture recipes). Profile photos may also come from `lh3.googleusercontent.com` (a Google account's picture). This stops pages from hot-linking, or tracking their viewers through, someone else's server. A recipe keeps media it already has, so older recipes with outside images can still be edited. Development accepts any HTTPS URL, plus HTTP on localhost.

### Private bucket

`savorly-sources` holds recipe-source photos the sous-chef reads (`recipe-sources/`) and natural-voice narration recordings (`narration/`, one object per recording; rows from before this layout keep their audio in Postgres). Without object storage, narration stays in Postgres. When a recording goes unused for 60 days, or its recipe or account is deleted, the row is removed and its object is queued in `source_deletions`, which the API's worker empties.

Do not deploy the local SeaweedFS development credentials or Compose setup publicly. R2 is the production media service. Back up metadata and objects together.

### When uploaded files are deleted

Every upload waits in a deletion queue (`media_deletions`), and whatever uses a file keeps it: the API's janitor checks recipes (cover, video, gallery, step photos and clips), profile photos, cooked-it photos and the sous-chef history before it deletes anything. A file that stops being used (a replaced photo, a deleted recipe or account) is deleted about a day later; a file that was uploaded but never used, including a direct upload that was never confirmed, two weeks after upload. Only files under `S3_PUBLIC_URL` named the way Savorly names uploads are ever deleted. See `services/api/internal/app/media_cleanup.go`.

## Verification

With the local services running:

```sh
cd services/api
set -a
. ../../.env
set +a
TEST_OBJECT_STORAGE=true go test -race ./internal/app -run 'Test(Media|ObjectStorage|DirectUpload|NarrationObjectStorage)'
```

The storage integration tests are restricted to the local port 8333 endpoint. They write PNG and MP4 fixtures and check public reads, MIME, CORS, byte ranges, and denied anonymous writes/deletes/listing; send a presigned upload as a browser would and confirm it; and store, stream and purge a narration recording in the private bucket. They remove only their own randomized objects (the narration test also needs `TEST_DATABASE_URL`). Browser tests additionally publish a recipe with uploaded photo/video and wait for video playback readiness.
