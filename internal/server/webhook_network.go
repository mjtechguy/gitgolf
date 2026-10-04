package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Destination errors deliberately omit the URL: a receiver's path/query can
// contain a credential. Caller-supplied authorization/headers are never accepted.
var errWebhookDestination = errors.New("Webhook destination is not an approved HTTPS endpoint.")
var errWebhookNetwork = errors.New("Webhook destination is unavailable or its network address is denied.")

func webhookURL(value string) (*url.URL, error) {
	if len(value) > 2048 || strings.ContainsAny(value, "\\\x00\r\n\t ") {
		return nil, errWebhookDestination
	}
	u, e := url.Parse(value)
	if e != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || u.Opaque != "" || u.Host == "" || u.Port() != "" && u.Port() != "443" {
		return nil, errWebhookDestination
	}
	host := u.Hostname()
	if host != strings.ToLower(host) || len(host) > 253 || net.ParseIP(host) != nil || !strings.Contains(host, ".") || strings.HasSuffix(host, ".") {
		return nil, errWebhookDestination
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return nil, errWebhookDestination
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return nil, errWebhookDestination
			}
		}
	}
	for _, suffix := range []string{".localhost", ".local", ".internal", ".home.arpa"} {
		if strings.HasSuffix(host, suffix) {
			return nil, errWebhookDestination
		}
	}
	if u.Path == "" {
		u.Path = "/"
	}
	return u, nil
}

func webhookPublicIP(ip net.IP) bool {
	addr, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	addr = addr.Unmap()
	if !addr.IsGlobalUnicast() || addr.IsPrivate() || addr.IsLoopback() || addr.IsLinkLocalUnicast() || addr.IsUnspecified() {
		return false
	}
	for _, block := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20"} {
		if netip.MustParsePrefix(block).Contains(addr) {
			return false
		}
	}
	return addr.Is4() || netip.MustParsePrefix("2000::/3").Contains(addr)
}

type webhookNetwork struct {
	resolve   func(context.Context, string) ([]net.IPAddr, error)
	dial      func(context.Context, string, string) (net.Conn, error)
	roots     *x509.CertPool
	approvals map[string]webhookEgressApproval
}

func defaultWebhookNetwork() webhookNetwork {
	return webhookNetwork{resolve: net.DefaultResolver.LookupIPAddr, dial: (&net.Dialer{Timeout: 3 * time.Second}).DialContext}
}
func (n webhookNetwork) addresses(ctx context.Context, u *url.URL) ([]net.IPAddr, error) {
	rows, e := n.resolve(ctx, u.Hostname())
	if e != nil || len(rows) == 0 {
		return nil, errWebhookNetwork
	}
	if len(rows) > 32 {
		return nil, errWebhookDestination
	}
	for _, row := range rows {
		if row.Zone != "" || !n.allowed(u, row.IP) {
			return nil, errWebhookDestination
		}
	}
	return rows, nil
}

// Every attempt resolves anew and pins the actual TCP dial to one validated IP.
// No proxies, redirects, shared connections, cookies or arbitrary request headers.
// beforeWrite rechecks the durable delivery/configuration and current authority;
// it must be called again inside the dial boundary, before any request bytes.
func (n webhookNetwork) deliver(ctx context.Context, destination string, body []byte, eventID, deliveryID, key string, beforeWrite func(context.Context) error) (int, string, error) {
	u, e := n.url(destination)
	if e != nil {
		return 0, "destination_denied", e
	}
	if len(body) > 16<<10 || len(body) == 0 || beforeWrite == nil {
		return 0, "invalid_payload", errWebhookDestination
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	rows, e := n.addresses(ctx, u)
	if e != nil {
		if errors.Is(e, errWebhookDestination) {
			return 0, "destination_denied", e
		}
		return 0, "dns_unavailable", e
	}
	if e = beforeWrite(ctx); e != nil {
		return 0, "authority_changed", e
	}
	dialPinned := func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, e := net.SplitHostPort(address)
		if e != nil || host != u.Hostname() || port != webhookPort(u) {
			return nil, errWebhookNetwork
		}
		if e = beforeWrite(ctx); e != nil {
			return nil, e
		}
		conn, e := n.dial(ctx, network, net.JoinHostPort(rows[0].IP.String(), port))
		if e != nil {
			return nil, errWebhookNetwork
		}
		remote, ok := conn.RemoteAddr().(*net.TCPAddr)
		if !ok || !remote.IP.Equal(rows[0].IP) || strconv.Itoa(remote.Port) != webhookPort(u) {
			conn.Close()
			return nil, errWebhookNetwork
		}
		if e = beforeWrite(ctx); e != nil {
			conn.Close()
			return nil, e
		}
		return conn, nil
	}
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true, MaxResponseHeaderBytes: 16 << 10, ResponseHeaderTimeout: 5 * time.Second, DialContext: dialPinned,
		DialTLSContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			raw, e := dialPinned(ctx, network, address)
			if e != nil {
				return nil, e
			}
			secure := tls.Client(raw, &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: n.roots, ServerName: u.Hostname(), NextProtos: []string{"http/1.1"}})
			handshake, stop := context.WithTimeout(ctx, 3*time.Second)
			e = secure.HandshakeContext(handshake)
			stop()
			if e != nil {
				raw.Close()
				return nil, errWebhookNetwork
			}
			// TLS may wait independently after TCP admission. Recheck the current owner,
			// delivery lease and native authority immediately before returning a usable
			// connection to net/http. This remains an observation, not native atomic CAS.
			if e = beforeWrite(ctx); e != nil {
				secure.Close()
				return nil, e
			}
			return secure, nil
		}}
	defer transport.CloseIdleConnections()
	stamp := strconv.FormatInt(time.Now().Unix(), 10)
	req, e := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), strings.NewReader(string(body)))
	if e != nil {
		return 0, "invalid_payload", errWebhookDestination
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Golf-Webhooks/1")
	req.Header.Set("X-Golf-Event-ID", eventID)
	req.Header.Set("X-Golf-Delivery-ID", deliveryID)
	req.Header.Set("X-Golf-Timestamp", stamp)
	req.Header.Set("X-Golf-Signature-256", webhookSignature(key, stamp, eventID, body))
	client := http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, e := client.Do(req)
	if e != nil {
		if errors.Is(e, errWebhookLeaseLost) {
			return 0, "lease_lost", errWebhookLeaseLost
		}
		if errors.Is(e, errWebhookRevoked) || errors.Is(e, errUnauthenticated) || webhookDenied(e) || sourceNotFound(e) {
			return 0, "authority_changed", errWebhookRevoked
		}
		return 0, "transport_uncertain", errWebhookNetwork
	}
	defer response.Body.Close()
	// Response text can contain private data/credentials and is never retained.
	_, e = io.Copy(io.Discard, io.LimitReader(response.Body, 4097))
	if e != nil {
		return response.StatusCode, "response_unavailable", errWebhookNetwork
	}
	return response.StatusCode, response.Header.Get("Retry-After"), nil
}
func webhookSignature(key, timestamp, eventID string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(timestamp + "\n" + eventID + "\n"))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

// Operator deployment configuration only, never subscription input. Exact
// origins and explicit IPs permit an owned private receiver; link-local and
// metadata addresses remain denied even under this exception.
type webhookEgressApproval struct {
	Origin     string   `json:"origin"`
	Addresses  []string `json:"addresses"`
	PathPrefix string   `json:"path_prefix"`
}

func parseWebhookEgress(raw string) (map[string]webhookEgressApproval, error) {
	out := map[string]webhookEgressApproval{}
	if raw == "" {
		return out, nil
	}
	if len(raw) > 16384 {
		return nil, errWebhookDestination
	}
	var rows []webhookEgressApproval
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&rows) != nil || len(rows) > 16 {
		return nil, errWebhookDestination
	}
	if _, e := decoder.Token(); e != io.EOF {
		return nil, errWebhookDestination
	}
	for _, row := range rows {
		u, e := url.Parse(row.Origin)
		if e != nil || u.Scheme != "https" && u.Scheme != "http" || u.User != nil || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.String() != row.Origin || out[row.Origin].Origin != "" || len(row.Addresses) < 1 || len(row.Addresses) > 32 || !strings.HasPrefix(row.PathPrefix, "/") || strings.ContainsAny(row.PathPrefix, "\\?\r\n") {
			return nil, errWebhookDestination
		}
		if port, e := strconv.Atoi(webhookPort(u)); e != nil || port < 1 || port > 65535 {
			return nil, errWebhookDestination
		}
		for _, ip := range row.Addresses {
			a, e := netip.ParseAddr(ip)
			if e != nil || a.String() != ip || !webhookPublicIP(net.ParseIP(ip)) && !a.IsPrivate() && !a.IsLoopback() {
				return nil, errWebhookDestination
			}
		}
		out[row.Origin] = row
	}
	return out, nil
}
func webhookPort(u *url.URL) string {
	if u.Port() != "" {
		return u.Port()
	}
	if u.Scheme == "http" {
		return "80"
	}
	return "443"
}
func (n webhookNetwork) url(value string) (*url.URL, error) {
	if u, e := webhookURL(value); e == nil {
		return u, nil
	}
	if len(value) > 2048 || strings.ContainsAny(value, "\\\x00\r\n\t ") {
		return nil, errWebhookDestination
	}
	u, e := url.Parse(value)
	if e != nil || u.User != nil || u.Fragment != "" || u.Opaque != "" {
		return nil, errWebhookDestination
	}
	row, ok := n.approvals[u.Scheme+"://"+u.Host]
	if !ok || !webhookApprovedPath(u, row.PathPrefix) {
		return nil, errWebhookDestination
	}
	return u, nil
}
func (n webhookNetwork) allowed(u *url.URL, ip net.IP) bool {
	if row, ok := n.approvals[u.Scheme+"://"+u.Host]; ok {
		if !webhookApprovedPath(u, row.PathPrefix) {
			return false
		}
		a, ok := netip.AddrFromSlice(ip)
		if !ok {
			return false
		}
		a = a.Unmap()
		for _, allowed := range row.Addresses {
			if a == netip.MustParseAddr(allowed).Unmap() {
				return true
			}
		}
		return false
	}
	return webhookPublicIP(ip)
}
func (s *Server) webhookNet() webhookNetwork {
	n := defaultWebhookNetwork()
	n.approvals, _ = parseWebhookEgress(s.config.WebhookEgressPolicyJSON)
	return n
}

func webhookApprovedPath(u *url.URL, prefix string) bool {
	for _, part := range strings.Split(u.Path, "/") {
		if part == "." || part == ".." {
			return false
		}
	}
	encoded := u.EscapedPath()
	return encoded == prefix || strings.HasPrefix(encoded, strings.TrimSuffix(prefix, "/")+"/")
}
