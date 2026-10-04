package server

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/mail"
	"net/netip"
	"net/smtp"
	"net/textproto"
	"os"
	"strconv"
	"strings"
	"time"
)

var errEmailDestination = errors.New("SMTP transport is not an operator-approved secure destination.")
var errEmailRevoked = errors.New("Email authorization is unavailable.")
var errEmailLeaseLost = errors.New("Email delivery lease is no longer current.")

type emailSMTPSecret struct{ Sender, Username, Password string }
type emailSMTPProfile struct {
	ID                  string
	Version             int64
	Name, Host, TLSMode string
	Port                int
	ContentID           string
	CreatedAt           time.Time
}
type emailEgressApproval struct {
	Host    string   `json:"host"`
	Port    int      `json:"port"`
	TLSMode string   `json:"tls_mode"`
	IPs     []string `json:"ips"`
}
type emailNetwork struct {
	resolve   func(context.Context, string) ([]net.IPAddr, error)
	dial      func(context.Context, string, string) (net.Conn, error)
	roots     *x509.CertPool
	approvals []emailEgressApproval
}

func emailAddress(value string) bool {
	if len(value) == 0 || len(value) > 254 || strings.ContainsAny(value, "\x00\r\n\t ") {
		return false
	}
	for _, r := range value {
		if r < 33 || r > 126 {
			return false
		}
	}
	a, e := mail.ParseAddress(value)
	return e == nil && a.Name == "" && a.Address == value && strings.Contains(value, "@")
}
func emailProfileValid(p emailSMTPProfile) bool {
	u, e := webhookURL("https://" + p.Host + "/")
	return e == nil && u.Hostname() == p.Host && u.Port() == "" && u.Path == "/" && u.RawQuery == "" && p.Port >= 1 && p.Port <= 65535 && (p.TLSMode == "implicit" && p.Port == 465 || p.TLSMode == "starttls" && p.Port == 587 || p.TLSMode == "operator_plaintext")
}
func emailSecretValid(p emailSMTPSecret) bool {
	return emailAddress(p.Sender) && len(p.Username) <= 512 && len(p.Password) <= 8192 && !strings.ContainsAny(p.Username+p.Password, "\x00\r\n") && (p.Username == "") == (p.Password == "")
}
func emailNetworkPolicy(value string) ([]emailEgressApproval, error) {
	if value == "" {
		return nil, nil
	}
	if len(value) > 16384 {
		return nil, errEmailDestination
	}
	var rows []emailEgressApproval
	d := json.NewDecoder(strings.NewReader(value))
	d.DisallowUnknownFields()
	if d.Decode(&rows) != nil || len(rows) == 0 || len(rows) > 16 {
		return nil, errEmailDestination
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return nil, errEmailDestination
	}
	seen := map[string]bool{}
	for _, r := range rows {
		key := r.Host + ":" + strconv.Itoa(r.Port)
		if seen[key] || !emailProfileValid(emailSMTPProfile{Host: r.Host, Port: r.Port, TLSMode: r.TLSMode}) || len(r.IPs) == 0 || len(r.IPs) > 8 {
			return nil, errEmailDestination
		}
		seen[key] = true
		for _, v := range r.IPs {
			p, e := netip.ParsePrefix(v)
			if e != nil || p.String() != v || p != p.Masked() {
				return nil, errEmailDestination
			}
		}
	}
	return rows, nil
}
func ValidateEmailEgressPolicy(value string) error { _, e := emailNetworkPolicy(value); return e }
func defaultEmailNetwork() (emailNetwork, error) {
	rows, e := emailNetworkPolicy(os.Getenv("GOLF_EMAIL_EGRESS_POLICY"))
	return emailNetwork{resolve: net.DefaultResolver.LookupIPAddr, dial: (&net.Dialer{Timeout: 3 * time.Second}).DialContext, approvals: rows}, e
}
func (n emailNetwork) profileApproved(p emailSMTPProfile) bool {
	for _, row := range n.approvals {
		if row.Host == p.Host && row.Port == p.Port && row.TLSMode == p.TLSMode {
			return true
		}
	}
	return false
}
func (n emailNetwork) allowed(p emailSMTPProfile, ip net.IP) bool {
	a, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	a = a.Unmap()
	for _, r := range n.approvals {
		if r.Host == p.Host && r.Port == p.Port && r.TLSMode == p.TLSMode {
			for _, v := range r.IPs {
				prefix, _ := netip.ParsePrefix(v)
				if prefix.Contains(a) {
					return true
				}
			}
			return false
		}
	}
	return p.TLSMode != "operator_plaintext" && webhookPublicIP(ip)
}
func (n emailNetwork) addresses(ctx context.Context, p emailSMTPProfile) ([]net.IPAddr, error) {
	if !emailProfileValid(p) {
		return nil, errEmailDestination
	}
	rows, e := n.resolve(ctx, p.Host)
	if e != nil || len(rows) == 0 {
		return nil, errors.New("SMTP DNS is unavailable.")
	}
	if len(rows) > 32 {
		return nil, errEmailDestination
	}
	for _, r := range rows {
		if r.Zone != "" || !n.allowed(p, r.IP) {
			return nil, errEmailDestination
		}
	}
	return rows, nil
}

type emailBoundConn struct {
	net.Conn
	remaining int
}

func (c *emailBoundConn) Read(p []byte) (int, error) {
	if c.remaining <= 0 {
		return 0, errors.New("SMTP response bound exceeded")
	}
	if len(p) > c.remaining {
		p = p[:c.remaining]
	}
	n, e := c.Conn.Read(p)
	c.remaining -= n
	return n, e
}

type emailSMTPResult struct {
	Code                int
	Failure             string
	Uncertain, Suppress bool
}

func emailSMTPError(e error, phase string, dataIssued bool) emailSMTPResult {
	out := emailSMTPResult{Failure: "smtp_unavailable", Uncertain: dataIssued}
	var response *textproto.Error
	if errors.As(e, &response) {
		out.Code = response.Code
		out.Uncertain = false
		if response.Code >= 400 && response.Code < 500 {
			out.Failure = "smtp_temporary"
		} else {
			out.Failure = "smtp_rejected"
		}
		// Only an exact receiver RCPT enhanced mailbox status suppresses this recipient.
		// A server-wide policy/auth failure or later bounce is not a mailbox identity.
		if phase == "rcpt" && response.Code == 550 && (response.Msg == "5.1.1" || strings.HasPrefix(response.Msg, "5.1.1 ")) {
			out.Suppress = true
			out.Failure = "recipient_rejected"
		}
	}
	if errors.Is(e, errEmailDestination) {
		out.Failure = "destination_denied"
		out.Uncertain = false
	}
	if errors.Is(e, errEmailRevoked) || errors.Is(e, errEmailLeaseLost) || errors.Is(e, errUnauthenticated) || webhookDenied(e) || sourceNotFound(e) {
		out.Failure = "authority_unavailable"
		out.Uncertain = dataIssued
	}
	return out
}

// One recipient, pinned DNS and required verified TLS. No proxy, opportunistic
// downgrade, server response text, attachment, arbitrary header or auth fallback.
func (n emailNetwork) deliver(ctx context.Context, p emailSMTPProfile, secret emailSMTPSecret, to string, body []byte, beforeData func(context.Context) error) emailSMTPResult {
	if !emailSecretValid(secret) || !emailAddress(to) || len(body) == 0 || len(body) > 16384 || beforeData == nil {
		return emailSMTPResult{Failure: "invalid_payload"}
	}
	ctx, stop := context.WithTimeout(ctx, 12*time.Second)
	defer stop()
	rows, e := n.addresses(ctx, p)
	if e != nil {
		return emailSMTPError(e, "dns", false)
	}
	if e = beforeData(ctx); e != nil {
		return emailSMTPError(e, "authority", false)
	}
	raw, e := n.dial(ctx, "tcp", net.JoinHostPort(rows[0].IP.String(), strconv.Itoa(p.Port)))
	if e != nil {
		return emailSMTPError(e, "dial", false)
	}
	defer raw.Close()
	cancel := context.AfterFunc(ctx, func() { _ = raw.Close() })
	defer cancel()
	peer, ok := raw.RemoteAddr().(*net.TCPAddr)
	if !ok || !peer.IP.Equal(rows[0].IP) || peer.Port != p.Port {
		return emailSMTPResult{Failure: "destination_denied"}
	}
	_ = raw.SetDeadline(time.Now().Add(12 * time.Second))
	if e = beforeData(ctx); e != nil {
		return emailSMTPError(e, "authority", false)
	}
	conn := net.Conn(&emailBoundConn{Conn: raw, remaining: 65536})
	cfg := &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: n.roots, ServerName: p.Host}
	if p.TLSMode == "implicit" {
		secured := tls.Client(conn, cfg)
		if e = secured.HandshakeContext(ctx); e != nil {
			return emailSMTPError(e, "tls", false)
		}
		conn = secured
	}
	c, e := smtp.NewClient(conn, p.Host)
	if e != nil {
		return emailSMTPError(e, "greeting", false)
	}
	defer func() { _ = conn.SetDeadline(time.Now().Add(100 * time.Millisecond)); _ = c.Close() }()
	if p.TLSMode == "starttls" {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return emailSMTPResult{Failure: "tls_required"}
		}
		if e = c.StartTLS(cfg); e != nil {
			return emailSMTPError(e, "tls", false)
		}
	}
	if p.TLSMode != "operator_plaintext" {
		if state, ok := c.TLSConnectionState(); !ok || len(state.VerifiedChains) == 0 {
			return emailSMTPResult{Failure: "tls_required"}
		}
	}
	if e = beforeData(ctx); e != nil {
		return emailSMTPError(e, "authority", false)
	}
	if secret.Username != "" {
		if p.TLSMode == "operator_plaintext" {
			return emailSMTPResult{Failure: "plaintext_auth_denied"}
		}
		if e = c.Auth(smtp.PlainAuth("", secret.Username, secret.Password, p.Host)); e != nil {
			return emailSMTPError(e, "auth", false)
		}
	}
	if e = c.Mail(secret.Sender); e != nil {
		return emailSMTPError(e, "mail", false)
	}
	if e = c.Rcpt(to); e != nil {
		return emailSMTPError(e, "rcpt", false)
	}
	// Native authorization and SQL lease are independent observations immediately
	// before DATA. Permission changes after this boundary cannot recall accepted mail.
	if e = beforeData(ctx); e != nil {
		return emailSMTPError(e, "authority", false)
	}
	w, e := c.Data()
	if e != nil {
		return emailSMTPError(e, "data", false)
	}
	if _, e = w.Write(body); e != nil {
		return emailSMTPError(e, "data", true)
	}
	if e = w.Close(); e != nil {
		return emailSMTPError(e, "data", true)
	}
	// DATA's positive completion is authoritative; a failing QUIT cannot undo it.
	_ = conn.SetDeadline(time.Now().Add(250 * time.Millisecond))
	_ = c.Quit()
	return emailSMTPResult{Code: 250}
}
