package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestWebhookURLAndAddressBoundary(t *testing.T) {
	for _, raw := range []string{"http://example.com/a", "https://example.com:444/a", "https://127.0.0.1/a", "https://[::1]/a", "https://example.com@127.0.0.1/a", "https://example.com/a#fragment", "https://receiver.internal/a", "https://localhost/a", "https://EXAMPLE.com/a", "https://example.com./a", "https://example.com/a\nsecret"} {
		if _, e := webhookURL(raw); e == nil {
			t.Fatalf("accepted forbidden endpoint class")
		}
	}
	u, e := webhookURL("https://receiver.example.com/path?token=secret")
	if e != nil || u.Hostname() != "receiver.example.com" {
		t.Fatal("valid HTTPS endpoint refused")
	}
	for _, raw := range []string{"127.0.0.1", "10.1.2.3", "172.16.1.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "192.0.2.1", "198.18.0.1", "203.0.113.1", "224.1.2.3", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::1", "64:ff9b::7f00:1"} {
		if webhookPublicIP(net.ParseIP(raw)) {
			t.Fatalf("accepted forbidden address %s", raw)
		}
	}
	for _, raw := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"} {
		if !webhookPublicIP(net.ParseIP(raw)) {
			t.Fatal("public address refused")
		}
	}
	for _, rows := range [][]net.IPAddr{nil, {{IP: net.ParseIP("8.8.8.8")}, {IP: net.ParseIP("127.0.0.1")}}, {{IP: net.ParseIP("8.8.8.8"), Zone: "scope"}}} {
		n := webhookNetwork{resolve: func(context.Context, string) ([]net.IPAddr, error) { return rows, nil }}
		if _, e = n.addresses(context.Background(), u); e == nil {
			t.Fatal("mixed/private DNS accepted")
		}
	}
}
func TestWebhookNoDialOnDeniedDNSOrAuthority(t *testing.T) {
	calls := 0
	n := webhookNetwork{resolve: func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
	}, dial: func(context.Context, string, string) (net.Conn, error) {
		calls++
		return nil, errors.New("must not dial")
	}}
	_, reason, e := n.deliver(context.Background(), "https://example.com/secret", []byte(`{"ping":true}`), "event", "delivery", "key", func(context.Context) error { return nil })
	if e == nil || reason != "destination_denied" || calls != 0 || strings.Contains(e.Error(), "secret") {
		t.Fatal("DNS denial failed or leaked destination")
	}
	n.resolve = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
	}
	_, reason, e = n.deliver(context.Background(), "https://example.com/secret", []byte(`{"ping":true}`), "event", "delivery", "key", func(context.Context) error { return errors.New("revoked") })
	if e == nil || reason != "authority_changed" || calls != 0 {
		t.Fatal("authority denial attempted a connection")
	}
}
func TestWebhookSignatureBindsTimestampEventAndExactBytes(t *testing.T) {
	body := []byte(`{"count":"9007199254740993"}`)
	got := webhookSignature("test-key", "1760000000", "event-1", body)
	mac := hmac.New(sha256.New, []byte("test-key"))
	mac.Write([]byte("1760000000\nevent-1\n"))
	mac.Write(body)
	if got != "sha256="+hex.EncodeToString(mac.Sum(nil)) {
		t.Fatal("HMAC differs from independently constructed receiver")
	}
	for _, changed := range []string{webhookSignature("other", "1760000000", "event-1", body), webhookSignature("test-key", "1760000001", "event-1", body), webhookSignature("test-key", "1760000000", "event-2", body), webhookSignature("test-key", "1760000000", "event-1", append(body, '\n'))} {
		if changed == got {
			t.Fatal("signature failed to bind envelope")
		}
	}
}

type webhookTestConn struct {
	net.Conn
	remote net.Addr
}

func (c webhookTestConn) RemoteAddr() net.Addr { return c.remote }

func TestWebhookPinnedHTTPSRedirectAndRebinding(t *testing.T) {
	// Owned local HTTPS receiver; fake DNS/dial exists only in this test. Runtime
	// has no tenant private-address switch or test-only certificate override.
	private, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), DNSNames: []string{"example.com"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, e := x509.CreateCertificate(rand.Reader, template, template, &private.PublicKey, private)
	if e != nil {
		t.Fatal(e)
	}
	requests := 0
	sink := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		raw, e := io.ReadAll(r.Body)
		if e != nil {
			t.Error(e)
		}
		expected := webhookSignature("test-key", r.Header.Get("X-Golf-Timestamp"), r.Header.Get("X-Golf-Event-ID"), raw)
		if !hmac.Equal([]byte(expected), []byte(r.Header.Get("X-Golf-Signature-256"))) || r.Host != "example.com" || r.Header.Get("Authorization") != "" {
			t.Error("receiver observed invalid signature/host/header")
		}
		w.Header().Set("Location", "https://other.example.com/path?secret=hidden")
		w.WriteHeader(http.StatusFound)
		io.WriteString(w, "private receiver output")
	}))
	sink.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: private}}}
	sink.StartTLS()
	defer sink.Close()
	roots := x509.NewCertPool()
	cert, e := x509.ParseCertificate(der)
	if e != nil {
		t.Fatal(e)
	}
	roots.AddCert(cert)
	resolves, dials := 0, 0
	n := webhookNetwork{roots: roots, resolve: func(context.Context, string) ([]net.IPAddr, error) {
		resolves++
		if resolves > 1 {
			return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
		}
		return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
	}, dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
		dials++
		if addr != "8.8.8.8:443" {
			t.Error("TCP dial was not pinned")
		}
		conn, e := (&net.Dialer{}).DialContext(ctx, network, sink.Listener.Addr().String())
		if e != nil {
			return nil, e
		}
		return webhookTestConn{Conn: conn, remote: &net.TCPAddr{IP: net.ParseIP("8.8.8.8"), Port: 443}}, nil
	}}
	status, _, e := n.deliver(context.Background(), "https://example.com/private?token=secret", []byte(`{"ping":true}`), "event-1", "delivery-1", "test-key", func(context.Context) error { return nil })
	if e != nil || status != 302 || requests != 1 || resolves != 1 || dials != 1 {
		t.Fatal("HTTPS/redirect boundary failed")
	}
	// Even after a successful TLS handshake, a new authority denial must
	// prevent the first HTTP bytes. This is an owned TLS receiver, not a mock
	// successful delivery assertion.
	originalResolve := n.resolve
	n.resolve = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
	}
	authorityReads := 0
	_, _, denied := n.deliver(context.Background(), "https://example.com/private?token=secret", []byte(`{"ping":true}`), "event-1", "delivery-1", "test-key", func(context.Context) error {
		authorityReads++
		if authorityReads == 4 {
			return errWebhookRevoked
		}
		return nil
	})
	if !errors.Is(denied, errWebhookRevoked) || authorityReads != 4 || requests != 1 || dials != 2 {
		t.Fatal("post-TLS authority denial sent HTTP bytes")
	}
	n.resolve = originalResolve
	_, reason, e := n.deliver(context.Background(), "https://example.com/private?token=secret", []byte(`{"ping":true}`), "event-1", "delivery-1", "test-key", func(context.Context) error { return nil })
	if e == nil || reason != "destination_denied" || requests != 1 || dials != 2 {
		t.Fatal("rebinding was not denied before sending")
	}
}

func TestWebhookActualPeerAndLateAuthorityDenied(t *testing.T) {
	for _, late := range []bool{false, true} {
		calls, requests := 0, 0
		sink := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { requests++ }))
		n := webhookNetwork{resolve: func(context.Context, string) ([]net.IPAddr, error) {
			return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
		}, dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			conn, e := (&net.Dialer{}).DialContext(ctx, network, sink.Listener.Addr().String())
			if e != nil {
				return nil, e
			}
			if late {
				return webhookTestConn{Conn: conn, remote: &net.TCPAddr{IP: net.ParseIP("8.8.8.8"), Port: 443}}, nil
			}
			return conn, nil
		}}
		_, _, e := n.deliver(context.Background(), "https://example.com/private?token=secret", []byte(`{"ping":true}`), "event-1", "delivery-1", "test-key", func(context.Context) error {
			calls++
			if late && calls == 3 {
				return errors.New("revoked")
			}
			return nil
		})
		if e == nil || requests != 0 {
			t.Fatal("wrong peer/late authority transmitted a request")
		}
		sink.Close()
	}
}

func TestWebhookOperatorOriginIsExactAndPathBounded(t *testing.T) {
	raw := `[{"origin":"http://127.0.0.1:9876","addresses":["127.0.0.1"],"path_prefix":"/owned"}]`
	policy, e := parseWebhookEgress(raw)
	if e != nil {
		t.Fatal(e)
	}
	n := defaultWebhookNetwork()
	n.approvals = policy
	for _, value := range []string{"http://127.0.0.1:9876/owned", "http://127.0.0.1:9876/owned/a?private=query"} {
		u, e := n.url(value)
		if e != nil || !n.allowed(u, net.ParseIP("127.0.0.1")) || n.allowed(u, net.ParseIP("127.0.0.2")) {
			t.Fatal("exact operator exception")
		}
	}
	for _, value := range []string{"http://127.0.0.1:9877/owned", "http://127.0.0.1:9876/owned-other", "http://127.0.0.1:9876/owned/../admin", "http://127.0.0.1:9876/owned/%2e%2e/admin", "http://user@127.0.0.1:9876/owned"} {
		if _, e := n.url(value); e == nil {
			t.Fatal("operator scope bypass")
		}
	}
	for _, raw := range []string{raw + `{}`, `[{"origin":"http://127.0.0.1:9876","addresses":["169.254.169.254"],"path_prefix":"/owned"}]`, `[{"origin":"http://127.0.0.1:9876","addresses":["127.0.0.1"],"path_prefix":"/owned","allow_all":true}]`} {
		if _, e := parseWebhookEgress(raw); e == nil {
			t.Fatal("invalid operator policy accepted")
		}
	}
}
