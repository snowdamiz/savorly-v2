FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS builder
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Cross-compile natively: Cloudflare Containers run linux/amd64, often built on arm64 machines.
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /server ./cmd/server
FROM alpine:3.23
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 savorly
WORKDIR /app
COPY --from=builder /server /app/server
USER savorly
EXPOSE 8080
CMD ["/app/server"]
