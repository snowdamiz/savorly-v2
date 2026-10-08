package app

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Generated provider URLs are copied into our storage so recipe media does not expire.
// The download transport resolves and dials only public addresses, including on redirects.
func (s *MediaStore) Import(ctx context.Context, owner, source string) (string, error) {
	valid := func(raw string) bool {
		u, e := url.Parse(raw)
		return e == nil && u.Scheme == "https" && u.User == nil && (u.Port() == "" || u.Port() == "443")
	}
	if !valid(source) {
		return "", fmt.Errorf("invalid generated media URL")
	}
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
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 60 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > 4 || !valid(req.URL.String()) {
			return fmt.Errorf("invalid media redirect")
		}
		return nil
	}}
	req, e := http.NewRequestWithContext(ctx, "GET", source, nil)
	if e != nil {
		return "", e
	}
	res, e := client.Do(req)
	if e != nil {
		return "", e
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return "", fmt.Errorf("media download status %d", res.StatusCode)
	}
	if res.ContentLength > 50*1024*1024 {
		return "", fmt.Errorf("generated media exceeds 50 MB")
	}
	data, e := io.ReadAll(io.LimitReader(res.Body, 50*1024*1024+1))
	if e != nil {
		return "", e
	}
	return s.Put(ctx, owner, data)
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
