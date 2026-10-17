.PHONY: setup db services api web check test build

# `make check` runs every Go test suite, including the database and object-storage ones, against
# the local services (`make services`). They use isolated schemas and their own objects, so the
# development database and bucket are safe. Point them elsewhere on the command line:
#   make check TEST_DATABASE_URL=postgres://… TEST_S3_ENDPOINT=http://…
TEST_DATABASE_URL ?= postgres://savorly:savorly_local_only@localhost:54329/savorly?sslmode=disable
TEST_S3_ENDPOINT ?= http://localhost:8333
# The local SeaweedFS account (infra/seaweedfs/s3.json); the storage tests refuse other endpoints.
GO_TEST_ENV = TEST_DATABASE_URL='$(TEST_DATABASE_URL)' TEST_OBJECT_STORAGE=true \
	TEST_S3_ENDPOINT='$(TEST_S3_ENDPOINT)' S3_ENDPOINT='$(TEST_S3_ENDPOINT)' \
	S3_PUBLIC_URL='$(TEST_S3_ENDPOINT)/savorly-media' S3_BUCKET=savorly-media \
	S3_SOURCE_BUCKET=savorly-sources S3_REGION=us-east-1 S3_FORCE_PATH_STYLE=true \
	S3_ACCESS_KEY_ID=savorly_local S3_SECRET_ACCESS_KEY=savorly_local_only_change_for_any_shared_environment

setup:
	npm --prefix apps/mobile ci
	npm --prefix infra/cloudflare ci
	cd services/api && go mod download
	@test -f .env || cp .env.example .env

db: services

services:
	docker compose up -d --wait db storage

api:
	cd services/api && go run ./cmd/server

web:
	npm run dev

check:
	npm run typecheck
	npm --prefix apps/mobile run lint
	npm --prefix infra/cloudflare test
	npm --prefix apps/mobile run test:unit
	@node scripts/check-services.mjs '$(TEST_DATABASE_URL)' '$(TEST_S3_ENDPOINT)'
	cd services/api && go vet ./... && $(GO_TEST_ENV) go test -race ./...

test: check
	npm run test:integration
	npm --prefix apps/mobile run test:e2e

build:
	npm run build
	cd services/api && go build -trimpath -o server ./cmd/server
