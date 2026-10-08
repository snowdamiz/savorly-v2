.PHONY: setup db services api web check test build
setup:
	npm --prefix apps/mobile ci
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
	cd services/api && go vet ./... && go test -race ./...

test: check
	npm run test:integration
	npm --prefix apps/mobile run test:e2e

build:
	npm run build
	cd services/api && go build -trimpath -o server ./cmd/server
