package cloudflare

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProfileInspectionBoundary(t *testing.T) {
	for _, key := range []string{"CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY", "CLOUDFLARE_EMAIL", "CF_EMAIL"} {
		t.Setenv(key, "")
	}
	dir := t.TempDir()
	calls := filepath.Join(dir, "calls")
	script := `#!/bin/sh
[ "$CLOUDFLARE_ACCOUNT_ID" = "0123456789abcdef0123456789abcdef" ] || exit 21
[ "$CF_SEND_TELEMETRY" = "false" ] && [ "$CI" = "true" ] || exit 22
[ "$1" = "--profile" ] && [ "$2" = "golf" ] || exit 23
shift 2
printf '%s\n' "$*" >> "$CF_TEST_CALLS"
case "$*" in
 'auth whoami') printf '%s' "$CF_TEST_AUTH";;
 'workers scripts search --per-page 1')
   if [ "$CF_TEST_HANG" = "true" ]; then exec sleep 30; fi
   printf '%s' '[{"name":"private-worker","token":"private-token"}]';;
 'r2 buckets list --per-page 1') printf '%s' '{"buckets":[{"name":"private-bucket"}]}';;
 'artifacts namespaces repos list --namespace golf-development --limit 1')
   if [ "$CF_TEST_BODY" != "" ]; then cat "$CF_TEST_BODY"; exit; fi
   printf '%s' "$CF_TEST_REPOS"
   printf '%s' 'private-token provider error' >&2
   exit "$CF_TEST_EXIT";;
 *) exit 24;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "cf"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("CF_TEST_CALLS", calls)
	t.Setenv("CF_TEST_AUTH", `{"authenticated":true,"tokenValid":true,"authSource":"OAuth token from /operator/config/golf.json","accounts":[{"id":"`+testAccount+`"}]}`)
	t.Setenv("CF_TEST_REPOS", `[{"name":"private-repository","token":"private-token"}]`)
	t.Setenv("CF_TEST_EXIT", "0")
	t.Setenv("CF_TEST_BODY", "")
	t.Setenv("CF_TEST_HANG", "")
	t.Setenv("CLOUDFLARE_ACCOUNT_ID", "wrong-ambient-account")
	t.Setenv("CF_ACCOUNT_ID", "wrong-deprecated-account")

	t.Run("native auth selected account and fixed read scopes", func(t *testing.T) {
		report, err := InspectProfile(context.Background(), testAccount, "golf-development", "golf")
		if err != nil || !report.Accessible() || report.AccountID != testAccount || report.Observations[0].Scope != "scripts_search_page_only" {
			t.Fatalf("unexpected report %+v %v", report, err)
		}
		data, _ := json.Marshal(report)
		if strings.Contains(string(data), "private-") || strings.Contains(string(data), "/operator") {
			t.Fatal("CLI metadata or credentials escaped into report")
		}
		data, err = os.ReadFile(calls)
		if err != nil || len(strings.Split(strings.TrimSpace(string(data)), "\n")) != 4 {
			t.Fatal("inspection performed an unexpected operation")
		}
	})
	t.Run("authentication ambiguity stops before service reads", func(t *testing.T) {
		for _, auth := range []string{
			`{"authenticated":true,"tokenValid":true,"authSource":"CLOUDFLARE_API_TOKEN from .env","accounts":[{"id":"` + testAccount + `"}]}`,
			`{"authenticated":true,"tokenValid":true,"authSource":"OAuth token from /operator/config/default.json","accounts":[{"id":"` + testAccount + `"}]}`,
			`{"authenticated":true,"tokenValid":true,"authSource":"OAuth token from /operator/config/golf.json","accounts":[{"id":"another-account"}]}`,
			`{"authenticated":true,"tokenValid":false,"authSource":"OAuth token from /operator/config/golf.json","accounts":[{"id":"` + testAccount + `"}]}`,
			`{"authenticated":false,"tokenValid":true,"authSource":"OAuth token from /operator/config/golf.json","accounts":[{"id":"` + testAccount + `"}]}`,
			`private-token not JSON`,
		} {
			t.Setenv("CF_TEST_AUTH", auth)
			if err := os.Remove(calls); err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
			report, err := InspectProfile(context.Background(), testAccount, "golf-development", "golf")
			if err != errProfile || report.Accessible() || strings.Contains(err.Error(), "private-token") {
				t.Fatal("ambiguous authentication admitted or leaked")
			}
			data, _ := os.ReadFile(calls)
			if strings.TrimSpace(string(data)) != "auth whoami" {
				t.Fatal("provider operation dispatched after failed authentication")
			}
		}
	})
	t.Run("invalid inputs and ambient credentials never dispatch", func(t *testing.T) {
		if err := os.Remove(calls); err != nil {
			t.Fatal(err)
		}
		for _, args := range [][3]string{{"wrong", "golf-development", "golf"}, {testAccount, "../other", "golf"}, {testAccount, "golf-development", "../secret"}} {
			if _, err := InspectProfile(context.Background(), args[0], args[1], args[2]); err != errProfile {
				t.Fatal("invalid selection admitted")
			}
		}
		for _, key := range []string{"CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY", "CLOUDFLARE_EMAIL", "CF_EMAIL"} {
			t.Setenv(key, "private-token")
			if _, err := InspectProfile(context.Background(), testAccount, "golf-development", "golf"); err != errProfile {
				t.Fatal("ambient credential override admitted")
			}
			t.Setenv(key, "")
		}
		if _, err := os.Stat(calls); !os.IsNotExist(err) {
			t.Fatal("invalid configuration launched CLI")
		}
	})
	t.Run("failed or malformed CLI reads cannot report success", func(t *testing.T) {
		for _, tc := range []struct{ exit, body, state string }{
			{"1", "private-token", "unavailable"}, {"0", "null", "invalid_response"}, {"0", `{}`, "invalid_response"}, {"0", `[] {}`, "invalid_response"}, {"0", `[]`, "accessible"},
		} {
			t.Setenv("CF_TEST_EXIT", tc.exit)
			t.Setenv("CF_TEST_REPOS", tc.body)
			report, err := InspectProfile(context.Background(), testAccount, "golf-development", "golf")
			if err != nil || report.Observations[2].State != tc.state || report.Accessible() != (tc.state == "accessible") {
				t.Fatalf("unexpected CLI failure report %+v %v", report, err)
			}
		}
	})
	t.Run("oversized output is bounded and fails closed", func(t *testing.T) {
		body := filepath.Join(dir, "oversized")
		if err := os.WriteFile(body, []byte(strings.Repeat(" ", maxResponseBytes)+"[]"), 0600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("CF_TEST_BODY", body)
		report, err := InspectProfile(context.Background(), testAccount, "golf-development", "golf")
		if err != nil || report.Accessible() || report.Observations[2].State != "unavailable" {
			t.Fatal("oversized subprocess response admitted")
		}
	})
	t.Run("cancellation kills pending read and emits no partial report", func(t *testing.T) {
		t.Setenv("CF_TEST_HANG", "true")
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		defer cancel()
		start := time.Now()
		report, err := InspectProfile(ctx, testAccount, "golf-development", "golf")
		if !errors.Is(err, context.DeadlineExceeded) || len(report.Observations) != 0 || time.Since(start) > 2*time.Second {
			t.Fatal("cancellation concealed or subprocess wait unbounded")
		}
	})
}
