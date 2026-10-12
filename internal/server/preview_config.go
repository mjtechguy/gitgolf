package server

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type previewConfiguration struct {
	address, origin, fingerprint string
	tls                          *tls.Config
	cloudflare                   *cloudflarePreview
}

func previewConfig(public string, insecure bool, getenv func(string) string) (*previewConfiguration, error) {
	names := []string{"GOLF_PREVIEW_TLS_LISTEN_ADDR", "GOLF_PREVIEW_TLS_CERT_FILE", "GOLF_PREVIEW_TLS_KEY_FILE", "GOLF_PREVIEW_BASE_URL"}
	vals := make([]string, len(names))
	n := 0
	for i, k := range names {
		vals[i] = getenv(k)
		if vals[i] != "" {
			n++
		}
	}
	if n == 0 {
		return nil, nil
	}
	bad := errors.New("Static preview requires complete isolated HTTPS configuration")
	if n != len(names) || insecure || !strings.HasPrefix(public, "https://") {
		return nil, bad
	}
	u, e := url.Parse(vals[3])
	if e != nil || u.Scheme != "https" || u.Hostname() != "preview.localhost" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
		return nil, bad
	}
	if u.Port() != "" {
		port, e := strconv.Atoi(u.Port())
		if e != nil || port < 1 || port > 65535 {
			return nil, bad
		}
	}
	control, e := url.Parse(public)
	if e != nil || control.Scheme != "https" || control.Hostname() == "" || control.User != nil || control.Path != "" || control.RawQuery != "" || control.Fragment != "" || control.Hostname() == u.Hostname() || strings.HasSuffix(control.Hostname(), ".preview.localhost") {
		return nil, bad
	}
	if _, _, e = net.SplitHostPort(vals[0]); e != nil {
		return nil, bad
	}
	cert, e := tls.LoadX509KeyPair(vals[1], vals[2])
	if e != nil || len(cert.Certificate) == 0 {
		return nil, bad
	}
	leaf, e := x509.ParseCertificate(cert.Certificate[0])
	now := time.Now()
	if e != nil || now.Before(leaf.NotBefore) || !now.Before(leaf.NotAfter) || leaf.VerifyHostname("00000000-0000-4000-8000-000000000000.preview.localhost") != nil {
		return nil, bad
	}
	cert.Leaf = leaf
	sum := sha256.Sum256(append([]byte("golf.local-static.v1\x00"+u.String()+"\x00"), leaf.RawSubjectPublicKeyInfo...))
	return &previewConfiguration{address: vals[0], origin: u.String(), fingerprint: hex.EncodeToString(sum[:]), tls: &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{cert}}}, nil
}

// Bind before any listeners serve; only this listener serves project content.
func (s *Server) BindPreviewListener() (*http.Server, net.Listener, error) {
	if s.preview == nil || s.preview.cloudflare != nil {
		return nil, nil, nil
	}
	l, e := net.Listen("tcp", s.preview.address)
	if e != nil {
		return nil, nil, errors.New("Static preview listener unavailable")
	}
	srv := &http.Server{Handler: s.PreviewHandler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10, TLSConfig: s.preview.tls}
	s.previewBound.Store(true)
	return srv, tls.NewListener(l, s.preview.tls), nil
}
func (s *Server) previewAvailable() bool {
	if s.preview == nil || !s.previewBound.Load() {
		return false
	}
	if s.preview.tls != nil {
		certs := s.preview.tls.Certificates
		if len(certs) != 1 || certs[0].Leaf == nil || !time.Now().Before(certs[0].Leaf.NotAfter) || time.Now().Before(certs[0].Leaf.NotBefore) {
			return false
		}
	}
	return true
}
func (s *Server) previewOrigin(id string) string {
	u, _ := url.Parse(s.preview.origin)
	u.Host = id + "." + u.Host
	return u.String()
}
