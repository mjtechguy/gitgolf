// Package cloudflare implements bounded Cloudflare account operations.
package cloudflare

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var ErrConfiguration = errors.New("provide a canonical Cloudflare account ID, namespace and operator API token")

var accountPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var namespacePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{1,62}$`)

const maxResponseBytes = 2 << 20

type Observation struct {
	Service    string `json:"service"`
	State      string `json:"state"`
	HTTPStatus int    `json:"http_status,omitempty"`
	Scope      string `json:"scope"`
}

type Report struct {
	SchemaVersion string        `json:"schema_version"`
	AccountID     string        `json:"account_id"`
	Namespace     string        `json:"artifacts_namespace"`
	CheckedAt     string        `json:"checked_at"`
	Observations  []Observation `json:"observations"`
}

// Accessible means every named read operation succeeded, not that deployment,
// writes, runtime bindings, billing or a complete service inventory are qualified.
func (r Report) Accessible() bool {
	if len(r.Observations) != 3 {
		return false
	}
	for _, o := range r.Observations {
		if o.State != "accessible" {
			return false
		}
	}
	return true
}

// Inspect uses only the official API origin. It does not persist or return the
// token, resource names, provider messages or raw provider response bodies.
func Inspect(ctx context.Context, accountID, namespace, token string) (Report, error) {
	client, close := inspectionClient()
	defer close()
	return inspect(ctx, client, accountID, namespace, token)
}

func inspectionClient() (*http.Client, func()) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.ResponseHeaderTimeout = 5 * time.Second
	return &http.Client{Transport: transport, Timeout: 10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, transport.CloseIdleConnections
}

func inspect(ctx context.Context, client *http.Client, accountID, namespace, token string) (Report, error) {
	if !accountPattern.MatchString(accountID) || !namespacePattern.MatchString(namespace) || token == "" || len(token) > 8192 || strings.IndexFunc(token, func(r rune) bool { return r < 33 || r > 126 }) >= 0 {
		return Report{}, ErrConfiguration
	}
	client = &http.Client{Transport: client.Transport, Timeout: 10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	report := Report{SchemaVersion: "golf.cloudflare.inspection.v1", AccountID: accountID, Namespace: namespace,
		CheckedAt: time.Now().UTC().Format(time.RFC3339Nano), Observations: make([]Observation, 0, 3)}
	base := "https://api.cloudflare.com/client/v4/accounts/" + accountID
	for _, target := range []struct{ service, path, scope string }{
		{"workers", "/workers/scripts", "scripts_list_only"},
		{"r2", "/r2/buckets?per_page=1", "default_jurisdiction_bucket_page_only"},
		{"artifacts", "/artifacts/namespaces/" + namespace + "/repos?limit=1", "namespace_repository_page_only"},
	} {
		if err := ctx.Err(); err != nil {
			return Report{}, err
		}
		observation := observe(ctx, client, base+target.path, token)
		if err := ctx.Err(); err != nil {
			return Report{}, err
		}
		observation.Service, observation.Scope = target.service, target.scope
		report.Observations = append(report.Observations, observation)
	}
	return report, nil
}

func observe(ctx context.Context, client *http.Client, endpoint, token string) Observation {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	o := Observation{State: "unavailable"}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return o
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	response, err := client.Do(req)
	if err != nil {
		return o
	}
	defer response.Body.Close()
	o.HTTPStatus = response.StatusCode
	switch response.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		o.State = "denied"
		return o
	case http.StatusNotFound:
		o.State = "not_found"
		return o
	case http.StatusTooManyRequests:
		o.State = "rate_limited"
		return o
	}
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		o.State = "redirect_refused"
		return o
	}
	if response.StatusCode != http.StatusOK {
		return o
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(body) > maxResponseBytes {
		o.State = "invalid_response"
		return o
	}
	var envelope struct {
		Success bool              `json:"success"`
		Result  json.RawMessage   `json:"result"`
		Errors  []json.RawMessage `json:"errors"`
	}
	if json.Unmarshal(body, &envelope) != nil || !envelope.Success || len(envelope.Errors) != 0 || len(envelope.Result) == 0 || string(envelope.Result) == "null" {
		o.State = "invalid_response"
		return o
	}
	// A success envelope must carry the documented collection shape.
	if !validCollection(envelope.Result, strings.Contains(endpoint, "/r2/buckets?")) {
		o.State = "invalid_response"
		return o
	}
	o.State = "accessible"
	return o
}

func validCollection(body []byte, r2 bool) bool {
	if r2 {
		var result struct {
			Buckets []json.RawMessage `json:"buckets"`
		}
		return json.Unmarshal(body, &result) == nil && result.Buckets != nil
	}
	var result []json.RawMessage
	return json.Unmarshal(body, &result) == nil && result != nil
}
