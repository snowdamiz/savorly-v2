package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/net/html/charset"
)

// Generated provider URLs are copied into our storage so recipe media does not expire.
func (s *MediaStore) Import(ctx context.Context, owner, source string) (string, error) {
	data, e := download(ctx, source, 50*1024*1024)
	if e != nil {
		return "", e
	}
	return s.Put(ctx, owner, data)
}

// publicURL is the only kind of address download and fetchPage open, redirects included:
// HTTPS on the default port, without credentials.
func publicURL(raw string) bool {
	u, e := url.Parse(raw)
	return e == nil && u.Scheme == "https" && u.User == nil && (u.Port() == "" || u.Port() == "443")
}

// publicClient resolves and dials only public addresses, including on redirects, which must be
// publicURLs too. Close its idle connections when done with it.
func publicClient(timeout time.Duration) *http.Client {
	transport := &http.Transport{DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, e := net.SplitHostPort(addr)
		if e != nil {
			return nil, e
		}
		ips, e := net.DefaultResolver.LookupIPAddr(ctx, host)
		if e != nil {
			return nil, e
		}
		if len(ips) == 0 {
			return nil, fmt.Errorf("media host has no addresses")
		}
		for _, ip := range ips {
			if !publicIP(ip.IP) {
				return nil, fmt.Errorf("media host is not public")
			}
		}
		dialer := net.Dialer{Timeout: 10 * time.Second}
		return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
	}, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 20 * time.Second}
	return &http.Client{Transport: transport, Timeout: timeout, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > 4 || !publicURL(req.URL.String()) {
			return fmt.Errorf("invalid media redirect")
		}
		return nil
	}}
}

// download fetches a public HTTPS file of at most limit bytes. The transport resolves and dials
// only public addresses, including on redirects.
func download(ctx context.Context, source string, limit int64) ([]byte, error) {
	if !publicURL(source) {
		return nil, fmt.Errorf("invalid media URL")
	}
	client := publicClient(60 * time.Second)
	defer client.CloseIdleConnections()
	req, e := http.NewRequestWithContext(ctx, "GET", source, nil)
	if e != nil {
		return nil, e
	}
	res, e := client.Do(req)
	if e != nil {
		return nil, e
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("media download status %d", res.StatusCode)
	}
	if res.ContentLength > limit {
		return nil, fmt.Errorf("media exceeds %d bytes", limit)
	}
	data, e := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if e != nil {
		return nil, e
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("media exceeds %d bytes", limit)
	}
	return data, nil
}

// pageLimit is as much of a page as an import reads; recipe markup sits well inside it.
const pageLimit = 3 << 20

// errNotPage is an answer that isn't a web page, such as a PDF or a photo.
var errNotPage = errors.New("not an HTML page")

// pageClient stands in for publicClient in tests, whose pages are on this machine, which the
// public-address guard rightly refuses. Nothing else sets it.
var pageClient *http.Client

type webPage struct {
	URL  string // where the page ended up, after redirects
	HTML []byte // UTF-8
}

// importClient is the client an import reads source through: download's guard (pageClient in
// tests). done closes its idle connections.
func importClient(source string) (client *http.Client, done func(), e error) {
	if pageClient != nil {
		return pageClient, func() {}, nil
	}
	if !publicURL(source) {
		return nil, nil, fmt.Errorf("invalid page URL")
	}
	client = publicClient(15 * time.Second)
	return client, client.CloseIdleConnections, nil
}

// importRequest is a GET for an import, sending header as well. Some sites turn away clients
// that don't say what they are.
func importRequest(ctx context.Context, source, accept string, header http.Header) (*http.Request, error) {
	req, e := http.NewRequestWithContext(ctx, "GET", source, nil)
	if e != nil {
		return nil, e
	}
	for k, v := range header {
		req.Header[k] = v
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; Savorly/1.0; +https://savorly.cooking)")
	req.Header.Set("Accept", accept)
	return req, nil
}

// fetchPage reads a web page to import through download's guard, keeping at most pageLimit
// bytes of an HTML document.
func fetchPage(ctx context.Context, source string) (webPage, error) {
	return fetchPageWith(ctx, source, nil)
}

// fetchPageWith is fetchPage sending header too, such as a cookie that skips a consent page.
func fetchPageWith(ctx context.Context, source string, header http.Header) (webPage, error) {
	client, done, e := importClient(source)
	if e != nil {
		return webPage{}, e
	}
	defer done()
	req, e := importRequest(ctx, source, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", header)
	if e != nil {
		return webPage{}, e
	}
	res, e := client.Do(req)
	if e != nil {
		return webPage{}, e
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return webPage{}, fmt.Errorf("page status %d", res.StatusCode)
	}
	html := func(contentType string) bool {
		kind, _, _ := mime.ParseMediaType(contentType)
		return kind == "text/html" || kind == "application/xhtml+xml"
	}
	contentType := res.Header.Get("Content-Type")
	if contentType != "" && !html(contentType) {
		return webPage{}, errNotPage
	}
	body, e := io.ReadAll(io.LimitReader(res.Body, pageLimit))
	if e != nil {
		return webPage{}, e
	}
	if contentType == "" {
		if contentType = http.DetectContentType(body); !html(contentType) {
			return webPage{}, errNotPage
		}
	}
	return webPage{URL: res.Request.URL.String(), HTML: utf8Page(body, contentType)}, nil
}

// fetchJSON reads a JSON answer of at most limit bytes for an import, such as a platform's
// oEmbed description of a post, through download's guard.
func fetchJSON(ctx context.Context, source string, limit int64) ([]byte, error) {
	client, done, e := importClient(source)
	if e != nil {
		return nil, e
	}
	defer done()
	req, e := importRequest(ctx, source, "application/json", nil)
	if e != nil {
		return nil, e
	}
	res, e := client.Do(req)
	if e != nil {
		return nil, e
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("data status %d", res.StatusCode)
	}
	data, e := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if e != nil {
		return nil, e
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("data exceeds %d bytes", limit)
	}
	return data, nil
}

// followLink is where a short link leads, through download's guard: the first address along
// its redirects that arrived accepts, or else where they end. It reads none of the page there.
func followLink(ctx context.Context, link string, arrived func(*url.URL) bool) (string, error) {
	client, done, e := importClient(link)
	if e != nil {
		return "", e
	}
	defer done()
	var landed *url.URL
	guarded := *client
	guarded.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if client.CheckRedirect != nil {
			if e := client.CheckRedirect(req, via); e != nil {
				return e
			}
		} else if len(via) >= 10 {
			return errors.New("stopped after 10 redirects")
		}
		if arrived(req.URL) {
			landed = req.URL
			return http.ErrUseLastResponse
		}
		return nil
	}
	req, e := importRequest(ctx, link, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", nil)
	if e != nil {
		return "", e
	}
	res, e := guarded.Do(req)
	if e != nil {
		return "", e
	}
	res.Body.Close()
	if landed != nil {
		return landed.String(), nil
	}
	return res.Request.URL.String(), nil
}

// utf8Page converts a page to UTF-8 the way a browser reads it: by its byte-order mark, its
// Content-Type's charset or its <meta charset>. An undeclared page that is valid UTF-8 stays
// as it is.
func utf8Page(body []byte, contentType string) []byte {
	// pageLimit may have cut the last character short.
	for i := len(body) - 1; i >= 0 && i >= len(body)-utf8.UTFMax; i-- {
		if utf8.RuneStart(body[i]) {
			if !utf8.FullRune(body[i:]) {
				body = body[:i]
			}
			break
		}
	}
	enc, _, certain := charset.DetermineEncoding(body, contentType)
	if !certain && utf8.Valid(body) {
		return body
	}
	if out, e := enc.NewDecoder().Bytes(body); e == nil {
		return out
	}
	return []byte(strings.ToValidUTF8(string(body), "�"))
}

func publicIP(ip net.IP) bool {
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
		return false
	}
	for _, block := range strings.Fields("100.64.0.0/10 192.0.0.0/24 192.0.2.0/24 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 240.0.0.0/4 2001:db8::/32") {
		_, cidr, _ := net.ParseCIDR(block)
		if cidr.Contains(ip) {
			return false
		}
	}
	return true
}
