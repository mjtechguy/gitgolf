package cloudflare

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

const testAccount = "0123456789abcdef0123456789abcdef"
const testToken = "private-operator-token"

func TestInspectionBoundary(t *testing.T) {
	t.Run("independent read scopes and redaction", func(t *testing.T) {
		var paths []string
		client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			if r.Method != "GET" || r.URL.Scheme != "https" || r.URL.Host != "api.cloudflare.com" || r.Header.Get("Authorization") != "Bearer "+testToken {
				t.Fatal("unexpected credential destination or operation")
			}
			paths = append(paths, r.URL.RequestURI())
			status, body := 200, `{"success":true,"errors":[],"result":[{"name":"private-repository","token":"`+testToken+`"}]}`
			if strings.Contains(r.URL.Path, "/r2/") {
				status, body = 403, testToken
			}
			return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header), Request: r}, nil
		})}
		report, err := inspect(context.Background(), client, testAccount, "golf-development", testToken)
		if err != nil || report.Accessible() || len(paths) != 3 || report.Observations[0].State != "accessible" || report.Observations[1].State != "denied" || report.Observations[2].State != "accessible" {
			t.Fatalf("unexpected report: %+v, %v", report, err)
		}
		if paths[1] != "/client/v4/accounts/"+testAccount+"/r2/buckets?per_page=1" || paths[2] != "/client/v4/accounts/"+testAccount+"/artifacts/namespaces/golf-development/repos?limit=1" {
			t.Fatal("scope was not bounded to the selected account/namespace/page")
		}
		encoded, _ := json.Marshal(report)
		if strings.Contains(string(encoded), testToken) || strings.Contains(string(encoded), "private-repository") {
			t.Fatal("provider data escaped into report")
		}
	})
	t.Run("invalid inputs never dispatch", func(t *testing.T) {
		client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			t.Fatal("invalid configuration reached provider")
			return nil, nil
		})}
		for _, args := range [][3]string{{"other-account", "default", testToken}, {testAccount, "../other", testToken}, {testAccount, "default", ""}, {testAccount, "default", "x\nsecret"}, {testAccount, "default", "x y"}} {
			if _, err := inspect(context.Background(), client, args[0], args[1], args[2]); err != ErrConfiguration {
				t.Fatal("invalid configuration was admitted")
			}
		}
	})
	t.Run("provider states never imply write qualification", func(t *testing.T) {
		for _, tc := range []struct {
			status      int
			body, state string
		}{
			{200, `{"success":true,"result":[],"errors":[]}`, "accessible"},
			{200, `{"success":false,"result":[]}`, "invalid_response"},
			{200, `{"success":true}`, "invalid_response"},
			{200, `{"success":true,"result":null}`, "invalid_response"},
			{200, `{"success":true,"result":{},"errors":[]}`, "invalid_response"},
			{200, `{"success":true,"result":[],"errors":[{"message":"` + testToken + `"}]}`, "invalid_response"},
			{200, `{"success":true,"result":[]} {}`, "invalid_response"},
			{200, strings.Repeat("x", maxResponseBytes+1), "invalid_response"},
			{401, testToken, "denied"}, {404, testToken, "not_found"}, {429, testToken, "rate_limited"}, {500, testToken, "unavailable"},
		} {
			client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: tc.status, Body: io.NopCloser(strings.NewReader(tc.body)), Header: make(http.Header), Request: r}, nil
			})}
			o := observe(context.Background(), client, "https://api.cloudflare.com/client/v4/accounts/"+testAccount+"/workers/scripts", testToken)
			if o.State != tc.state {
				t.Fatalf("status %d: got %s want %s", tc.status, o.State, tc.state)
			}
		}
	})
	t.Run("redirect never forwards token", func(t *testing.T) {
		calls := 0
		client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			calls++
			if r.URL.Host != "api.cloudflare.com" {
				t.Fatal("redirect received operator token")
			}
			return &http.Response{StatusCode: 302, Header: http.Header{"Location": {"https://foreign.invalid/"}}, Body: io.NopCloser(strings.NewReader(testToken)), Request: r}, nil
		})}
		report, err := inspect(context.Background(), client, testAccount, "default", testToken)
		if err != nil || report.Accessible() || calls != 3 {
			t.Fatal("redirect escaped the provider boundary")
		}
		for _, o := range report.Observations {
			if o.State != "redirect_refused" {
				t.Fatal("redirect was reported as accessible")
			}
		}
	})
	t.Run("all accessible read probes and R2 response shape", func(t *testing.T) {
		client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			body := `{"success":true,"result":[]}`
			if strings.Contains(r.URL.Path, "/r2/") {
				body = `{"success":true,"result":{"buckets":[]}}`
			}
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
		})}
		report, err := inspect(context.Background(), client, testAccount, "default", testToken)
		if err != nil || !report.Accessible() {
			t.Fatalf("valid response not accepted: %+v %v", report, err)
		}
		if (Report{}).Accessible() {
			t.Fatal("empty report was accessible")
		}
	})
	t.Run("cancelled inspection emits no success report", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := inspect(ctx, http.DefaultClient, testAccount, "default", testToken); err != context.Canceled {
			t.Fatal("cancellation was concealed")
		}
	})
}
