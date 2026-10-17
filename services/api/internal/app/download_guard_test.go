package app

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

// download() must refuse anything but public HTTPS before it opens a connection, including hosts
// that resolve to this machine or a private network (the SSRF guard on provider media imports).
func TestDownloadRefusesNonPublicTargets(t *testing.T) {
	ctx := context.Background()
	for _, source := range []string{
		"http://example.com/photo.jpg",
		"ftp://example.com/photo.jpg",
		"https://user:secret@example.com/photo.jpg",
		"https://example.com:8443/photo.jpg",
		"file:///etc/passwd",
		"not a url",
	} {
		if _, e := download(ctx, source, 1024); e == nil || e.Error() != "invalid media URL" {
			t.Fatalf("%s: want invalid media URL, got %v", source, e)
		}
	}
	for _, source := range []string{
		"https://127.0.0.1/photo.jpg",
		"https://localhost/photo.jpg",
		"https://[::1]/photo.jpg",
		"https://10.0.0.8/photo.jpg",
		"https://192.168.1.20/photo.jpg",
		"https://169.254.169.254/latest/meta-data/",
		"https://100.64.0.1/photo.jpg",
	} {
		_, e := download(ctx, source, 1024)
		if e == nil || !strings.Contains(e.Error(), "media host is not public") {
			t.Fatalf("%s: want the public-address guard, got %v", source, e)
		}
	}
}

// Every redirect a media or page download follows must itself be public HTTPS on the default
// port, without credentials, and the chain stops after a few hops.
func TestDownloadRedirectsStayPublic(t *testing.T) {
	client := publicClient(time.Second)
	defer client.CloseIdleConnections()
	hop := func(target string, hops int) error {
		req, e := http.NewRequest("GET", target, nil)
		if e != nil {
			t.Fatal(e)
		}
		via := make([]*http.Request, hops)
		for i := range via {
			via[i], _ = http.NewRequest("GET", "https://example.com/step", nil)
		}
		return client.CheckRedirect(req, via)
	}
	if e := hop("https://cdn.example.com/photo.jpg", 1); e != nil {
		t.Fatalf("a public HTTPS redirect was refused: %v", e)
	}
	for _, target := range []string{
		"http://cdn.example.com/photo.jpg",
		"https://user:secret@cdn.example.com/photo.jpg",
		"https://cdn.example.com:8443/photo.jpg",
		"file:///etc/passwd",
	} {
		if e := hop(target, 1); e == nil || e.Error() != "invalid media redirect" {
			t.Fatalf("%s: %v", target, e)
		}
	}
	if e := hop("https://cdn.example.com/photo.jpg", 5); e == nil {
		t.Fatal("a sixth hop was followed")
	}
}
