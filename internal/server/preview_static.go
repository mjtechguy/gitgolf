package server

import (
	"context"
	"crypto/tls"
	"database/sql"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/mjtechguy/golf-git/internal/staticpreview"
)

func (s *Server) PreviewHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		select {
		case s.previewRequests <- struct{}{}:
			defer func() { <-s.previewRequests }()
		default:
			previewDenied(w)
			return
		}
		if !s.previewAvailable() || r.TLS == nil || r.TLS.Version < tls.VersionTLS13 || r.Header.Get("Authorization") != "" || len(r.URL.RawQuery) > 1024 {
			previewDenied(w)
			return
		}
		base, _ := url.Parse(s.preview.origin)
		suffix := "." + base.Host
		host := strings.ToLower(r.Host)
		if !strings.HasSuffix(host, suffix) {
			previewDenied(w)
			return
		}
		id := strings.TrimSuffix(host, suffix)
		if !deploymentUUID(id) {
			previewDenied(w)
			return
		}
		d, e := s.deploymentRecord(r.Context(), id)
		if e != nil || d.wire.TargetFingerprint != s.preview.fingerprint {
			previewDenied(w)
			return
		}
		if r.URL.Path == "/__golf/auth" {
			s.redeemPreview(w, r, d)
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" || strings.Contains(r.URL.EscapedPath(), "%") || strings.HasPrefix(r.URL.Path, "/__golf") || r.Header.Get("Sec-Fetch-Dest") == "serviceworker" {
			previewDenied(w)
			return
		}
		value, n := "", 0
		for _, c := range r.Cookies() {
			if c.Name == previewCookie {
				value = c.Value
				n++
			}
			if c.Name == "__Host-golf_session" || c.Name == cookieName {
				previewDenied(w)
				return
			}
		}
		if n != 1 {
			previewDenied(w)
			return
		}
		v, e := s.previewCredential(r.Context(), value, id, "viewer")
		if e != nil {
			previewDenied(w)
			return
		}
		if e = s.deploymentFence(r.Context(), d, v.parent, v.native, func(_ *sql.Tx, current *deploymentRecord, _ time.Time) error {
			if current.wire.State != "READY" {
				return errDeployment
			}
			return nil
		}); e != nil {
			previewDenied(w)
			return
		}
		// Buffered immutable original bytes are fetched before the final authority
		// proof. Changing the active object profile never redirects this locator.
		var digest string
		var size int64
		binding, digest, size, e := artifactRowBinding(s.db.QueryRowContext(r.Context(), "SELECT "+artifactStorageColumns+" FROM golf_workflow_artifacts WHERE run_id=$1 AND attempt_id=$2", d.wire.Artifact.RunId, d.wire.Artifact.AttemptId))
		if e != nil || digest != d.wire.Artifact.ArchiveSha256 {
			previewDenied(w)
			return
		}
		data, e := s.artifactObjectBytes(r.Context(), binding, digest, size)
		if e != nil {
			previewDenied(w)
			return
		}
		site, e := staticpreview.Parse(data)
		if e != nil || site.ManifestSHA256 != d.wire.ManifestSha256 || site.ArchiveSHA256 != digest {
			previewDenied(w)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" {
			name = "index.html"
		}
		file, e := site.File(d.wire.StaticRoot, name)
		if e != nil {
			previewDenied(w)
			return
		}
		var expiry time.Time
		e = s.deploymentFence(r.Context(), d, v.parent, v.native, func(_ *sql.Tx, current *deploymentRecord, deadline time.Time) error {
			if current.wire.State != "READY" || !v.expires.After(time.Now()) {
				return errDeployment
			}
			expiry = deadline
			if v.expires.Before(expiry) {
				expiry = v.expires
			}
			return nil
		})
		if e != nil || !expiry.After(time.Now()) {
			previewDenied(w)
			return
		}
		// Both native observations, current local/CV/expiry and the SQL fence
		// complete before any project bytes. Previously delivered bytes cannot
		// be recalled; this is not atomic revocation against native writers.
		if writeUntil := time.Now().Add(5 * time.Second); writeUntil.Before(expiry) {
			expiry = writeUntil
		}
		if http.NewResponseController(w).SetWriteDeadline(expiry) != nil {
			previewDenied(w)
			return
		}
		previewHeaders(w)
		w.Header().Set("Content-Type", file.ContentType)
		if r.Method == "GET" {
			_, _ = w.Write(file.Bytes)
		} else {
			w.WriteHeader(http.StatusOK)
		}
	})
}
