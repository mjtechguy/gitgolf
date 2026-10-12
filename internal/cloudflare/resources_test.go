package cloudflare

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestResourceClientBoundary(t *testing.T) {
	const id = "12345678-1234-4234-8234-123456789abc"
	const name = "golf-env-12345678123442348234123456789abc"
	var calls []string
	response := func(r *http.Request, status int, body string) (*http.Response, error) {
		return &http.Response{StatusCode: status, Header: http.Header{"Location": {"https://foreign.invalid"}}, Request: r, Body: io.NopCloser(strings.NewReader(body))}, nil
	}
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Scheme != "https" || r.URL.Host != "api.cloudflare.com" || !strings.HasPrefix(r.URL.Path, "/client/v4/accounts/"+testAccount+"/") || r.Header.Get("Authorization") != "Bearer "+testToken {
			t.Fatal("resource credential or account destination escaped")
		}
		calls = append(calls, r.Method+" "+r.URL.RequestURI())
		if strings.HasSuffix(r.URL.Path, "/domains/managed") {
			return response(r, 200, `{"success":true,"result":{"enabled":false}}`)
		}
		if strings.HasSuffix(r.URL.Path, "/domains/custom") {
			return response(r, 200, `{"success":true,"result":{"domains":[]}}`)
		}
		if strings.Contains(r.URL.Path, "/d1/") {
			if r.Method == "GET" && r.URL.RawQuery != "" {
				return response(r, 200, `{"success":true,"result":[]}`)
			}
			return response(r, 200, `{"success":true,"result":{"uuid":"`+id+`","name":"`+name+`"}}`)
		}
		return response(r, 200, `{"success":true,"result":{"name":"`+name+`","creation_date":"2026-10-08T00:00:00.123Z"}}`)
	})
	c := &ResourceClient{account: testAccount, token: testToken, client: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	if absent, e := c.D1NameAbsent(t.Context(), name); e != nil || !absent {
		t.Fatal("empty selected D1 discovery failed", e)
	}
	if d1, e := c.CreateD1(t.Context(), name); e != nil || d1.ID != id {
		t.Fatal("D1 creation identity lost", e)
	}
	if d1, e := c.GetD1(t.Context(), id); e != nil || d1.Name != name {
		t.Fatal("D1 readback failed", e)
	}
	if r2, e := c.CreateR2(t.Context(), name); e != nil || r2.CreatedAt == "" {
		t.Fatal("R2 creation identity lost", e)
	}
	if _, e := c.GetR2(t.Context(), name); e != nil {
		t.Fatal(e)
	}
	if private, e := c.R2Private(t.Context(), name); e != nil || !private {
		t.Fatal("private serving readback failed", e)
	}
	if c.DeleteD1(t.Context(), id) != nil || c.DeleteR2(t.Context(), name) != nil || len(calls) != 9 {
		t.Fatal("resource operations were retried or omitted")
	}
	for _, invalid := range []string{"../other", "", strings.Repeat("x", 64), "https://foreign.invalid", "a?account=other"} {
		if _, e := c.CreateD1(t.Context(), invalid); e != ErrConfiguration {
			t.Fatal("invalid D1 name admitted")
		}
		if _, e := c.CreateR2(t.Context(), invalid); e != ErrConfiguration {
			t.Fatal("invalid R2 name admitted")
		}
		if e := c.DeleteD1(t.Context(), invalid); e != ErrConfiguration {
			t.Fatal("invalid D1 deletion ID admitted")
		}
		if e := c.DeleteR2(t.Context(), invalid); e != ErrConfiguration || len(calls) != 9 {
			t.Fatal("invalid deletion reached provider")
		}
	}
	for _, body := range []string{`{"enabled":true}`, `{}`, `{"enabled":false}`} {
		c.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
			if strings.HasSuffix(r.URL.Path, "/domains/managed") {
				return response(r, 200, `{"success":true,"result":`+body+`}`)
			}
			return response(r, 200, `{"success":true,"result":{"domains":[{"domain":"foreign.invalid"}]}}`)
		})
		if private, _ := c.R2Private(t.Context(), name); private {
			t.Fatal("public or incomplete bucket proof accepted")
		}
	}
	for _, tc := range []struct {
		status int
		body   string
	}{
		{302, testToken}, {403, testToken}, {429, testToken}, {500, testToken},
		{200, `{"success":true,"result":{"uuid":"` + id + `","name":"other"}}`},
		{200, `{"success":true,"result":{"name":"` + name + `"}}`},
		{200, `{"success":true,"result":{"name":"` + name + `","creation_date":"invalid"}}`},
		{200, strings.Repeat("x", maxResponseBytes+1)},
	} {
		count := 0
		c.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) { count++; return response(r, tc.status, tc.body) })
		if _, e := c.CreateR2(t.Context(), name); e != ErrResponse || count != 1 || strings.Contains(e.Error(), testToken) {
			t.Fatal("ambiguous resource response retried or disclosed provider diagnostics")
		}
	}
	c.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) { return response(r, 404, testToken) })
	if _, e := c.GetD1(t.Context(), id); !errors.Is(e, ErrNotFound) {
		t.Fatal("exact resource absence concealed")
	}
	if e := c.DeleteD1(t.Context(), id); e != ErrResponse {
		t.Fatal("unverified deletion represented as success")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	c.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) { return nil, r.Context().Err() })
	if _, e := c.CreateD1(ctx, name); e != ErrResponse {
		t.Fatal("cancelled creation fabricated a resource")
	}
}
