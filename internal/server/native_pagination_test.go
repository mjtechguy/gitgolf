package server

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNativePageSize(t *testing.T) {
	for _, tc := range []struct {
		name            string
		first, last     int
		requested, want uint32
		fail            bool
	}{
		{"clamped", 50, 50, 100, 50, false}, {"smaller request", 50, 50, 20, 20, false},
		{"one-row limit", 1, 1, 100, 1, false}, {"missing setting", 0, 0, 100, 0, true},
		{"drift", 50, 25, 100, 50, true}, {"negative", -1, -1, 100, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reads := 0
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/version" {
					fmt.Fprint(w, `{"version":"1.27.3"}`)
					return
				}
				if r.URL.Path != "/api/v1/settings/api" {
					t.Error("unexpected route", r.URL.Path)
					w.WriteHeader(404)
					return
				}
				maximum := tc.first
				if reads > 0 {
					maximum = tc.last
				}
				reads++
				fmt.Fprintf(w, `{"max_response_items":%d}`, maximum)
			}))
			defer provider.Close()
			s, err := New(testConfig(provider.URL), nil)
			if err != nil {
				t.Fatal(err)
			}
			called := false
			err = s.withNativePageSize(context.Background(), forgeCredential{Kind: "pat", Token: "fixture"}, tc.requested, func(limit uint32) error {
				called = true
				if limit != tc.want {
					t.Fatalf("span %d, want %d", limit, tc.want)
				}
				return nil
			})
			if (err != nil) != tc.fail || called != (tc.first > 0) {
				t.Fatal("invalid setting/read outcome", err, called)
			}
		})
	}
}
