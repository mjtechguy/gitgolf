package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/mail"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const cloudflarePreviewContract = "golf.repository.cloudflare-static.v1"

// shortcut: one operator-owned deployment per process; replace with durable targets before automatic PR fleets.
type cloudflarePreview struct {
	AccessReviewerNativeID int64  `json:"access_reviewer_native_id,omitempty"`
	AccessReviewerEmail    string `json:"access_reviewer_email,omitempty"`
	BaseURL                string `json:"base_url"`
	DeploymentID           string `json:"deployment_id"`
	AccountID              string `json:"account_id"`
	D1ID                   string `json:"d1_id"`
	R2Bucket               string `json:"r2_bucket"`
	R2Created              string `json:"r2_created"`
	AccessAUD              string `json:"access_aud"`
	BrokerSecret           string `json:"broker_secret"`
	ProbeClientID          string `json:"probe_client_id"`
	ProbeClientSecret      string `json:"probe_client_secret"`
}

func loadCloudflarePreview(public string, oidc *accessOIDC, path string) (*previewConfiguration, error) {
	if path == "" {
		return nil, nil
	}
	bad := errors.New("Cloudflare preview requires complete isolated private configuration")
	v := &cloudflarePreview{}
	if privateConfiguration(path, v) != nil || oidc == nil || !deploymentUUID(v.DeploymentID) || !deploymentUUID(v.D1ID) || !deploymentSHA.MatchString(v.AccessAUD) || !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(v.AccountID) || v.ProbeClientID == "" || v.ProbeClientSecret == "" {
		return nil, bad
	}
	// An operator may bind one existing external Access identity to one native
	// repository reader. This never changes the identities issued by Golf OIDC.
	if v.AccessReviewerNativeID != 0 || v.AccessReviewerEmail != "" {
		address, e := mail.ParseAddress(v.AccessReviewerEmail)
		if e != nil || v.AccessReviewerNativeID <= 0 || len(v.AccessReviewerEmail) > 254 || address.Address != v.AccessReviewerEmail {
			return nil, bad
		}
	}
	if _, e := previewTokenHash(v.BrokerSecret); e != nil {
		return nil, bad
	}
	base, e := url.Parse(v.BaseURL)
	if e != nil || base.Scheme != "https" || base.Hostname() != base.Host || base.Host == "" || base.User != nil || base.Path != "" || base.RawQuery != "" || base.Fragment != "" || strings.ToLower(base.Host) != base.Host {
		return nil, bad
	}
	control, e := url.Parse(public)
	if e != nil || control.Host == base.Host || strings.HasSuffix(control.Host, "."+base.Host) || strings.HasSuffix(base.Host, "."+control.Host) {
		return nil, bad
	}
	if !regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`).MatchString(v.R2Bucket) {
		return nil, bad
	}
	if _, e = time.Parse(time.RFC3339Nano, v.R2Created); e != nil {
		return nil, bad
	}
	raw, _ := json.Marshal(v)
	sum := sha256.Sum256(append([]byte(cloudflarePreviewContract+"\x00"+public+"\x00"+oidc.fingerprint+"\x00"), raw...))
	return &previewConfiguration{origin: base.String(), fingerprint: hex.EncodeToString(sum[:]), cloudflare: v}, nil
}

func (v *cloudflarePreview) matchesReviewer(native int64, email string) bool {
	if v.AccessReviewerNativeID != 0 {
		return native == v.AccessReviewerNativeID && email == v.AccessReviewerEmail
	}
	return email == accessReviewerEmail(native)
}

type cloudflarePreviewRequest struct {
	Method     string `json:"method"`
	Path       string `json:"path"`
	Origin     string `json:"origin"`
	Email      string `json:"email"`
	Credential string `json:"credential"`
	Grant      string `json:"grant"`
}

// Only the authenticated broker may translate the edge's Access identity into
// an isolated preview request. Caller-supplied forwarding headers grant nothing.
func (s *Server) CloudflarePreviewHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		if s.preview == nil || s.preview.cloudflare == nil || r.Method != "POST" || r.URL.Path != "/internal/cloudflare/preview" || r.URL.RawQuery != "" || len(r.Cookies()) != 0 || r.Header.Get("Origin") != "" {
			previewDenied(w)
			return
		}
		presented := sha256.Sum256([]byte(r.Header.Get("Authorization")))
		expected := sha256.Sum256([]byte("Bearer " + s.preview.cloudflare.BrokerSecret))
		if subtle.ConstantTimeCompare(presented[:], expected[:]) != 1 {
			previewDenied(w)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 8192)
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		var input cloudflarePreviewRequest
		if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || len(input.Path) > 1024 {
			previewDenied(w)
			return
		}
		u, e := url.ParseRequestURI(input.Path)
		if e != nil || u.RawQuery != "" || u.Fragment != "" || u.Host != "" || strings.Contains(u.EscapedPath(), "%") || !strings.HasPrefix(u.Path, "/") || strings.HasPrefix(u.Path, "//") {
			previewDenied(w)
			return
		}
		kind := "viewer"
		credential := input.Credential
		if u.Path == "/__golf/auth" {
			if input.Method != "POST" || input.Credential != "" {
				previewDenied(w)
				return
			}
			kind = "launch"
			credential = input.Grant
		} else if input.Method != "GET" && input.Method != "HEAD" || input.Grant != "" {
			previewDenied(w)
			return
		}
		id := s.preview.cloudflare.DeploymentID
		grant, e := s.previewCredential(r.Context(), credential, id, kind)
		if e != nil || !s.preview.cloudflare.matchesReviewer(grant.native, input.Email) {
			previewDenied(w)
			return
		}
		body := ""
		if kind == "launch" {
			body = url.Values{"grant": {credential}}.Encode()
		}
		request, e := http.NewRequestWithContext(r.Context(), input.Method, s.previewOrigin(id)+input.Path, strings.NewReader(body))
		if e != nil {
			previewDenied(w)
			return
		}
		request.TLS = &tls.ConnectionState{Version: tls.VersionTLS13}
		request.Header.Set("Origin", input.Origin)
		if kind == "launch" {
			request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		} else {
			request.AddCookie(&http.Cookie{Name: previewCookie, Value: credential})
		}
		s.PreviewHandler().ServeHTTP(w, request)
	})
}

func (s *Server) qualifyCloudflarePreview(ctx context.Context, d *deploymentRecord) error {
	if s.preview == nil {
		return errDeployment
	}
	v := s.preview.cloudflare
	if v == nil {
		return nil
	}
	if d.wire.Id != v.DeploymentID || d.wire.Contract != cloudflarePreviewContract {
		return errDeployment
	}
	address := s.previewOrigin(d.wire.Id) + "/__golf/health"
	request, e := http.NewRequestWithContext(ctx, "GET", address, nil)
	if e != nil {
		return errDeployment
	}
	response, e := s.client.Do(request)
	if e != nil {
		return errDeployment
	}
	response.Body.Close()
	location, e := url.Parse(response.Header.Get("Location"))
	if e != nil || response.StatusCode != 302 || location.Scheme != "https" || location.Host != s.accessOIDC.TeamDomain || !strings.HasPrefix(location.Path, "/cdn-cgi/access/") {
		return errDeployment
	}
	request, e = http.NewRequestWithContext(ctx, "GET", address, nil)
	if e != nil {
		return errDeployment
	}
	request.Header.Set("CF-Access-Client-Id", v.ProbeClientID)
	request.Header.Set("CF-Access-Client-Secret", v.ProbeClientSecret)
	request.Header.Set("Authorization", "Bearer "+v.BrokerSecret)
	response, e = s.client.Do(request)
	if e != nil {
		return errDeployment
	}
	defer response.Body.Close()
	var health struct {
		Fingerprint string `json:"fingerprint"`
		Archive     string `json:"archive"`
		Commit      string `json:"commit"`
		D1          string `json:"d1"`
		R2          string `json:"r2"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 4097))
	decoder.DisallowUnknownFields()
	if response.StatusCode != 200 || decoder.Decode(&health) != nil || decoder.Decode(new(any)) != io.EOF || health.Fingerprint != s.preview.fingerprint || health.Archive != d.wire.Artifact.ArchiveSha256 || health.Commit != d.wire.Artifact.CommitId || health.D1 != v.D1ID || health.R2 != v.R2Bucket {
		return errDeployment
	}
	return nil
}
