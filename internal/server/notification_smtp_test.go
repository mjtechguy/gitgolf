package server

import (
	"bufio"
	"connectrpc.com/connect"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"io"
	"math/big"
	"mime/quotedprintable"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

type smtpFixtureConn struct{ net.Conn }

func (c smtpFixtureConn) RemoteAddr() net.Addr {
	return &net.TCPAddr{IP: net.ParseIP("192.0.2.44"), Port: 465}
}

type smtpFixture struct {
	onRCPT                      func()
	startTLS                    *tls.Config
	mu                          sync.Mutex
	commands                    []string
	body                        string
	rcpt, dataReply             string
	dropAck, noTLS, bigGreeting bool
	conn                        net.Conn
}

func (f *smtpFixture) server(conn net.Conn) {
	defer conn.Close()
	if f.bigGreeting {
		_, _ = io.WriteString(conn, "220 "+strings.Repeat("x", 70000)+"\r\n")
		return
	}
	_, _ = io.WriteString(conn, "220 owned fixture\r\n")
	r := bufio.NewReader(conn)
	for {
		line, e := r.ReadString('\n')
		if e != nil {
			return
		}
		line = strings.TrimSpace(line)
		f.mu.Lock()
		f.commands = append(f.commands, strings.SplitN(line, " ", 2)[0])
		f.mu.Unlock()
		switch {
		case strings.HasPrefix(line, "EHLO"):
			if f.startTLS != nil {
				_, _ = io.WriteString(conn, "250-owned fixture\r\n250 STARTTLS\r\n")
			} else {
				_, _ = io.WriteString(conn, "250-owned fixture\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n")
			}
		case line == "STARTTLS":
			if f.startTLS == nil {
				return
			}
			_, _ = io.WriteString(conn, "220 upgrade\r\n")
			secured := tls.Server(conn, f.startTLS)
			if secured.Handshake() != nil {
				return
			}
			conn = secured
			r = bufio.NewReader(conn)
			f.startTLS = nil
		case strings.HasPrefix(line, "AUTH PLAIN "):
			_, _ = io.WriteString(conn, "235 authenticated\r\n")
		case strings.HasPrefix(line, "HELO"), strings.HasPrefix(line, "MAIL"):
			_, _ = io.WriteString(conn, "250 accepted\r\n")
		case strings.HasPrefix(line, "RCPT"):
			if f.onRCPT != nil {
				f.onRCPT()
			}
			v := f.rcpt
			if v == "" {
				v = "250 recipient"
			}
			_, _ = io.WriteString(conn, v+"\r\n")
		case line == "DATA":
			_, _ = io.WriteString(conn, "354 send\r\n")
			var b strings.Builder
			for {
				v, e := r.ReadString('\n')
				if e != nil {
					return
				}
				if v == ".\r\n" {
					break
				}
				b.WriteString(v)
			}
			f.mu.Lock()
			f.body = b.String()
			f.mu.Unlock()
			if f.dropAck {
				return
			}
			v := f.dataReply
			if v == "" {
				v = "250 accepted"
			}
			_, _ = io.WriteString(conn, v+"\r\n")
		case line == "QUIT":
			return
		default:
			_, _ = io.WriteString(conn, "500 unsupported\r\n")
		}
	}
}
func smtpFixtureTLS(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "smtp.fixture.test"}, DNSNames: []string{"smtp.fixture.test"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), BasicConstraintsValid: true, IsCA: true, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, e := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if e != nil {
		t.Fatal(e)
	}
	parsed, e := x509.ParseCertificate(der)
	if e != nil {
		t.Fatal(e)
	}
	roots := x509.NewCertPool()
	roots.AddCert(parsed)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, roots
}
func smtpNetworkFixture(t *testing.T, f *smtpFixture, secure bool) emailNetwork {
	t.Helper()
	cert, roots := smtpFixtureTLS(t)
	n := emailNetwork{roots: roots, resolve: func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("192.0.2.44")}}, nil
	}, approvals: []emailEgressApproval{{Host: "smtp.fixture.test", Port: 465, TLSMode: "implicit", IPs: []string{"192.0.2.44/32"}}}}
	n.dial = func(context.Context, string, string) (net.Conn, error) {
		client, server := net.Pipe()
		f.conn = server
		t.Cleanup(func() { client.Close(); server.Close() })
		if secure {
			server = tls.Server(server, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})
		}
		go f.server(server)
		return smtpFixtureConn{client}, nil
	}
	return n
}
func smtpFixtureBody(t *testing.T) []byte {
	t.Helper()
	body, e := emailMessage("sender@example.test", "recipient@example.test", "2e6b1d54-e3f8-4288-a008-18c42ccae436", "Golf test", "Owned synthetic message.")
	if e != nil {
		t.Fatal(e)
	}
	return []byte(body)
}
func TestNotificationSMTPReceiptsAndRefusals(t *testing.T) {
	for _, tc := range []struct {
		name, rcpt, data  string
		drop              bool
		code              int
		failure           string
		unknown, suppress bool
	}{
		{name: "accepted quit lost", code: 250}, {name: "mailbox definitive", rcpt: "550 5.1.1 absent", code: 550, failure: "recipient_rejected", suppress: true}, {name: "policy not mailbox", rcpt: "550 5.7.1 policy", code: 550, failure: "smtp_rejected"}, {name: "transient", rcpt: "451 4.3.0 retry", code: 451, failure: "smtp_temporary"}, {name: "lost DATA ack", drop: true, failure: "smtp_unavailable", unknown: true}, {name: "DATA definitive rejection", data: "550 5.7.1 policy", code: 550, failure: "smtp_rejected"}} {
		t.Run(tc.name, func(t *testing.T) {
			f := &smtpFixture{rcpt: tc.rcpt, dataReply: tc.data, dropAck: tc.drop}
			n := smtpNetworkFixture(t, f, true)
			got := n.deliver(context.Background(), emailSMTPProfile{Host: "smtp.fixture.test", Port: 465, TLSMode: "implicit"}, emailSMTPSecret{Sender: "sender@example.test"}, "recipient@example.test", smtpFixtureBody(t), func(context.Context) error { return nil })
			if got.Code != tc.code || got.Failure != tc.failure || got.Uncertain != tc.unknown || got.Suppress != tc.suppress {
				t.Fatalf("bounded SMTP outcome mismatch: %+v", got)
			}
		})
	}
}
func TestNotificationSMTPCurrentAuthorityBeforeDATA(t *testing.T) {
	f := &smtpFixture{}
	n := smtpNetworkFixture(t, f, true)
	calls := 0
	got := n.deliver(context.Background(), emailSMTPProfile{Host: "smtp.fixture.test", Port: 465, TLSMode: "implicit"}, emailSMTPSecret{Sender: "sender@example.test"}, "recipient@example.test", smtpFixtureBody(t), func(context.Context) error {
		calls++
		if calls == 4 {
			return errEmailRevoked
		}
		return nil
	})
	if got.Failure != "authority_unavailable" || got.Uncertain {
		t.Fatal(got)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, cmd := range f.commands {
		if cmd == "DATA" {
			t.Fatal("revoked authority issued DATA")
		}
	}
}
func TestNotificationSMTPRequiredTLSAndResponseCap(t *testing.T) {
	for _, secure := range []bool{false, true} {
		f := &smtpFixture{bigGreeting: secure}
		n := smtpNetworkFixture(t, f, secure)
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		defer cancel()
		got := n.deliver(ctx, emailSMTPProfile{Host: "smtp.fixture.test", Port: 465, TLSMode: "implicit"}, emailSMTPSecret{Sender: "sender@example.test"}, "recipient@example.test", smtpFixtureBody(t), func(context.Context) error { return nil })
		if got.Code == 250 || got.Uncertain {
			t.Fatal("untrusted/unbounded response admitted")
		}
	}
}
func TestNotificationSMTPMissingSTARTTLSAndBadCertificate(t *testing.T) {
	f := &smtpFixture{}
	n := smtpNetworkFixture(t, f, false)
	n.approvals = []emailEgressApproval{{Host: "smtp.fixture.test", Port: 587, TLSMode: "starttls", IPs: []string{"192.0.2.44/32"}}}
	n.dial = func(context.Context, string, string) (net.Conn, error) {
		c, s := net.Pipe()
		t.Cleanup(func() { c.Close(); s.Close() })
		go f.server(s)
		return notificationPortConn{c, 587}, nil
	}
	got := n.deliver(context.Background(), emailSMTPProfile{Host: "smtp.fixture.test", Port: 587, TLSMode: "starttls"}, emailSMTPSecret{Sender: "sender@example.test"}, "recipient@example.test", smtpFixtureBody(t), func(context.Context) error { return nil })
	if got.Failure != "tls_required" {
		t.Fatal(got)
	}
	f = &smtpFixture{}
	n = smtpNetworkFixture(t, f, true)
	n.roots = x509.NewCertPool()
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	got = n.deliver(ctx, emailSMTPProfile{Host: "smtp.fixture.test", Port: 465, TLSMode: "implicit"}, emailSMTPSecret{Sender: "sender@example.test"}, "recipient@example.test", smtpFixtureBody(t), func(context.Context) error { return nil })
	if got.Code != 0 || got.Uncertain {
		t.Fatal("untrusted certificate admitted")
	}
}

type notificationPortConn struct {
	net.Conn
	port int
}

func (c notificationPortConn) RemoteAddr() net.Addr {
	return &net.TCPAddr{IP: net.ParseIP("192.0.2.44"), Port: c.port}
}
func TestNotificationSMTPPinnedAddressesAndCancellation(t *testing.T) {
	f := &smtpFixture{}
	n := smtpNetworkFixture(t, f, true)
	n.approvals = nil
	dialed := false
	n.dial = func(context.Context, string, string) (net.Conn, error) {
		dialed = true
		return nil, errors.New("owned failure")
	}
	got := n.deliver(context.Background(), emailSMTPProfile{Host: "smtp.fixture.test", Port: 465, TLSMode: "implicit"}, emailSMTPSecret{Sender: "sender@example.test"}, "recipient@example.test", smtpFixtureBody(t), func(context.Context) error { return nil })
	if dialed || got.Failure != "destination_denied" {
		t.Fatal(got)
	}
	n.approvals = []emailEgressApproval{{Host: "smtp.fixture.test", Port: 465, TLSMode: "implicit", IPs: []string{"192.0.2.44/32"}}}
	n.dial = func(context.Context, string, string) (net.Conn, error) {
		c, s := net.Pipe()
		t.Cleanup(func() { c.Close(); s.Close() })
		return smtpFixtureConn{c}, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	start := time.Now()
	got = n.deliver(ctx, emailSMTPProfile{Host: "smtp.fixture.test", Port: 465, TLSMode: "implicit"}, emailSMTPSecret{Sender: "sender@example.test"}, "recipient@example.test", smtpFixtureBody(t), func(context.Context) error { return nil })
	if time.Since(start) > time.Second || got.Uncertain {
		t.Fatal("cancellation did not close owned connection")
	}
}
func TestNotificationSMTPHeadersTokensAndPolicy(t *testing.T) {
	for _, address := range []string{"a@example.test\r\nBcc: other@example.test", "Name <a@example.test>", "a@example.test b@example.test", "ü@example.test"} {
		if emailAddress(address) {
			t.Fatal("unsafe mail address admitted")
		}
	}
	if _, e := emailMessage("sender@example.test", "recipient@example.test", "2e6b1d54-e3f8-4288-a008-18c42ccae436", "Bad\r\nheader", "text"); e == nil {
		t.Fatal("header injection admitted")
	}
	for _, bad := range []string{`[{"host":"smtp.fixture.test","port":465,"tls_mode":"implicit","ips":["192.0.2.1/24"]}]`, `[{"host":"smtp.fixture.test","port":465,"tls_mode":"implicit","ips":["192.0.2.0/24"],"proxy":true}]`, `[]`, `[{"host":"smtp.fixture.test","port":25,"tls_mode":"starttls","ips":["192.0.2.0/24"]}]`} {
		if ValidateEmailEgressPolicy(bad) == nil {
			t.Fatal("unsafe operator policy admitted")
		}
	}
	code, e := emailCode()
	if e != nil || !emailCodeValid(code) {
		t.Fatal("code generation failed")
	}
	if string(emailCodeHash("one", code)) == string(emailCodeHash("two", code)) {
		t.Fatal("challenge hash unbound")
	}
	token, e := emailToken()
	if e != nil || len(token) != 43 {
		t.Fatal("token generation failed")
	}
}

func TestNotificationSMTPReadBoundAndWireRefusals(t *testing.T) {
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	go func() { _, _ = io.WriteString(right, strings.Repeat("x", 65537)) }()
	bounded := &emailBoundConn{Conn: left, remaining: 65536}
	got, e := io.ReadAll(bounded)
	if e == nil || len(got) != 65536 {
		t.Fatal("SMTP response read bound not enforced")
	}
	for _, test := range []struct {
		err  error
		code connect.Code
	}{{errEmailRevoked, connect.CodePermissionDenied}, {errEmailDestination, connect.CodeInvalidArgument}, {connect.NewError(connect.CodeResourceExhausted, errors.New("bounded")), connect.CodeResourceExhausted}} {
		if connect.CodeOf(notificationRPCError(test.err)) != test.code {
			t.Fatal("bounded refusal code lost")
		}
	}
}

func TestNotificationSMTPUnicodeTemplateIsPortable(t *testing.T) {
	text := "A committed activity notice.\nhttps://golf.example/owner/日本語\n"
	body, e := emailMessage("sender@example.test", "recipient@example.test", "2e6b1d54-e3f8-4288-a008-18c42ccae436", "Golf activity", text)
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(body, "Content-Transfer-Encoding: quoted-printable") || !strings.Contains(body, "Auto-Submitted: auto-generated") || !strings.Contains(body, "\r\nDate: ") {
		t.Fatal("portable mail headers absent")
	}
	parts := strings.SplitN(body, "\r\n\r\n", 2)
	decoded, e := io.ReadAll(quotedprintable.NewReader(strings.NewReader(parts[1])))
	if e != nil || strings.ReplaceAll(string(decoded), "\r\n", "\n") != text+"\n" {
		t.Fatal("Unicode authenticated link changed", e)
	}
}

func TestNotificationSMTPSTARTTLSAndAuthentication(t *testing.T) {
	cert, roots := smtpFixtureTLS(t)
	f := &smtpFixture{startTLS: &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}}
	n := emailNetwork{roots: roots, approvals: []emailEgressApproval{{Host: "smtp.fixture.test", Port: 587, TLSMode: "starttls", IPs: []string{"192.0.2.44/32"}}}, resolve: func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("192.0.2.44")}}, nil
	}, dial: func(context.Context, string, string) (net.Conn, error) {
		c, s := net.Pipe()
		t.Cleanup(func() { c.Close(); s.Close() })
		go f.server(s)
		return notificationPortConn{c, 587}, nil
	}}
	got := n.deliver(t.Context(), emailSMTPProfile{Host: "smtp.fixture.test", Port: 587, TLSMode: "starttls"}, emailSMTPSecret{Sender: "sender@example.test", Username: "owned-fixture", Password: "owned-fixture-password"}, "recipient@example.test", smtpFixtureBody(t), func(context.Context) error { return nil })
	if got.Code != 250 || got.Failure != "" {
		t.Fatal("required TLS authenticated exchange failed", got)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	upgrade, auth := -1, -1
	for i, k := range f.commands {
		if k == "STARTTLS" {
			upgrade = i
		}
		if k == "AUTH" {
			auth = i
		}
	}
	if upgrade < 0 || auth <= upgrade {
		t.Fatal("authentication occurred before verified TLS")
	}
	for _, host := range []string{"smtp.fixture.test:443", "smtp.fixture.test/path", "smtp.fixture.test?query=1"} {
		if emailProfileValid(emailSMTPProfile{Host: host, Port: 465, TLSMode: "implicit"}) {
			t.Fatal("non-host destination admitted")
		}
	}
}
