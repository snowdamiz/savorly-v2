FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS builder
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Cross-compile natively: Cloudflare Containers run linux/amd64, often built on arm64 machines.
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /server ./cmd/server
# The static binary needs only CA certificates (TLS to Postgres, R2 and the AI providers), which
# this image has; time zones and migrations are compiled in. No shell, and it runs as nonroot.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /server /app/server
EXPOSE 8080
# No curl here, so the binary checks itself: GET /health on $PORT, which also pings the database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["/app/server", "-healthcheck"]
CMD ["/app/server"]
