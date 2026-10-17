package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// healthcheck asks the server running beside it for GET /health and returns the exit code: 0 when
// it answers 200. The Dockerfile's HEALTHCHECK runs `server -healthcheck`, since the distroless
// image has no shell or curl.
func healthcheck() int {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	client := http.Client{Timeout: 4 * time.Second}
	res, err := client.Get("http://127.0.0.1:" + port + "/health")
	if err != nil {
		fmt.Fprintln(os.Stderr, "healthcheck:", err)
		return 1
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
	if res.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "healthcheck:", res.Status)
		return 1
	}
	return 0
}
