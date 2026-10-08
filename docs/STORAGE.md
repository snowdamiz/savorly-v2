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

The `.env.example` contains local-only credentials matching `infra/seaweedfs/s3.json`. The API authenticates writes; anonymous visitors can read media but cannot upload, delete, or list the bucket. CORS allows the local Expo web origins. Only the S3 port is published, bound to loopback. The other SeaweedFS services are internal to Docker. Development storage is capped at one CPU and 512 MiB of memory.

Media persists in the `savorly_media_data` Docker volume across API rebuilds, container recreation, and `docker compose down`. `docker compose down -v` intentionally destroys both database and media data. The local volume allocation allows roughly 1 GiB for development; increase `-volume.max` in Compose if needed.

For a containerized API, `docker compose --profile full up --build` overrides only the internal S3 endpoint to `http://storage:8333`. The public URL continues to use the browser-reachable host endpoint.

For physical-device testing, use an HTTPS development tunnel for both the API and object endpoint. Set `EXPO_PUBLIC_API_URL` to the API tunnel and `S3_PUBLIC_URL` to the object tunnel plus `/savorly-media`. The S3 write endpoint remains local. Restart the API and create fresh uploads after changing the public URL; saved recipe URLs are not rewritten automatically.

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

Use the bucket's correct jurisdiction-specific endpoint where applicable. Set R2 CORS to allow your frontend origins, methods `GET` and `HEAD`, the `Range` header, and expose `ETag`, `Content-Length`, `Content-Range`, and `Accept-Ranges`. Writes go through the authenticated Go API; browsers never receive S3 credentials. See Cloudflare's [Go SDK example](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-go/) and [CORS configuration](https://developers.cloudflare.com/r2/buckets/cors/).

Uploads are limited to 50 MiB, checked by file signature, and stored under randomized per-user keys with MIME and immutable cache headers. HTTPS generated-media downloads reject private-network addresses before importing bytes into the same store. Missing storage configuration returns `503`; there is no silent disk fallback.

Do not deploy the local SeaweedFS development credentials or Compose setup publicly. R2 is the production media service. Back up metadata and objects together, and establish orphan-object cleanup and deletion retention before launch. Account deletion currently removes database records, not previously uploaded object bytes.

## Verification

With the local services running:

```sh
cd services/api
set -a
. ../../.env
set +a
TEST_OBJECT_STORAGE=true go test -race ./internal/app -run 'Test(Media|ObjectStorage)'
```

The storage integration test is restricted to the local port 8333 endpoint. It writes PNG and MP4 fixtures, checks public reads, MIME, CORS, byte ranges, and denied anonymous writes/deletes/listing, then removes only its own randomized objects. Browser tests additionally publish a recipe with uploaded photo/video and wait for video playback readiness.
