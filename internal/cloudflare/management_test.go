package cloudflare

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestManagementInspectionBoundary(t *testing.T) {
	for _, namespace := range []string{"", "private-workspace"} {
		calls := 0
		client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			calls++
			if r.Method != "GET" || r.URL.Host != "api.cloudflare.com" || r.URL.Scheme != "https" || !strings.HasPrefix(r.URL.Path, "/client/v4/accounts/"+testAccount+"/") || r.Header.Get("Authorization") != "Bearer "+testToken {
				t.Fatal("credential or account boundary escaped")
			}
			status, body := 200, `{"success":true,"result":[]}`
			if strings.Contains(r.URL.Path, "/r2/") {
				body = `{"success":true,"result":{"buckets":[]}}`
			}
			if strings.Contains(r.URL.Path, "/d1/") {
				status, body = 403, testToken
			}
			if strings.Contains(r.URL.Path, "/artifacts/") {
				if namespace == "" && r.URL.RequestURI() != "/client/v4/accounts/"+testAccount+"/artifacts/namespaces?limit=1" || namespace != "" && !strings.HasSuffix(r.URL.RequestURI(), "/namespaces/"+namespace+"/repos?limit=1") {
					t.Fatal("namespace read widened")
				}
				status, body = 302, testToken
			}
			return &http.Response{StatusCode: status, Header: http.Header{"Location": {"https://foreign.invalid"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
		})}
		r, err := inspectManagement(t.Context(), client, testAccount, namespace, testToken)
		if err != nil || calls != 4 || len(r.Observations) != 4 || r.Observations[0].State != "accessible" || r.Observations[1].State != "accessible" || r.Observations[2].State != "denied" || r.Observations[3].State != "redirect_refused" {
			t.Fatal("partial access concealed or redirect dispatched", err)
		}
		raw, _ := json.Marshal(r)
		if strings.Contains(string(raw), testToken) {
			t.Fatal("provider diagnostic disclosed token")
		}
		for _, bad := range [][3]string{{"other", namespace, testToken}, {testAccount, "../private", testToken}, {testAccount, namespace, "x\r\nsecret"}, {testAccount, namespace, "x y"}} {
			if _, err := inspectManagement(t.Context(), client, bad[0], bad[1], bad[2]); err != ErrConfiguration || calls != 4 {
				t.Fatal("invalid inputs dispatched")
			}
		}
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		if _, err := inspectManagement(ctx, client, testAccount, namespace, testToken); err != context.Canceled || calls != 4 {
			t.Fatal("cancelled inspection dispatched")
		}
	}
}
