package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
)

func TestReadCommandSessionAndFailureCleanup(t *testing.T) {
	for _, denied := range []bool{false, true} {
		t.Run(fmt.Sprint("denied=", denied), func(t *testing.T) {
			var calls []string
			const token = "fixture-private-token"
			forge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls = append(calls, r.Method+" "+r.URL.Path)
				if r.Header.Get("Origin") != "http://"+r.Host || r.Header.Get("Connect-Protocol-Version") != "1" || r.Method != "POST" {
					t.Error("origin does not match the destination")
				}
				w.Header().Set("Content-Type", "application/json")
				if strings.HasSuffix(r.URL.Path, golfv1connect.SessionServiceLoginWithGiteaTokenProcedure) {
					var input map[string]string
					if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input["token"] != token {
						t.Error("token login failed")
					}
					http.SetCookie(w, &http.Cookie{Name: "golf_session", Value: "opaque-session", Path: "/", HttpOnly: true})
					fmt.Fprint(w, `{"user":{"id":"1"}}`)
					return
				}
				cookie, err := r.Cookie("golf_session")
				if err != nil || cookie.Value != "opaque-session" || r.Header.Get("Authorization") != "" {
					t.Error("request did not use only the ephemeral cookie")
				}
				if strings.HasSuffix(r.URL.Path, golfv1connect.SessionServiceLogoutProcedure) {
					fmt.Fprint(w, `{}`)
					return
				}
				var input struct {
					Ref, Path  string
					Repository struct{ Owner, Name string }
				}
				if json.NewDecoder(r.Body).Decode(&input) != nil || input.Ref != "feature/a&b" || input.Path != "src/hello 世界.txt" || input.Repository.Owner != "alice" || input.Repository.Name != "private" || !strings.HasSuffix(r.URL.Path, golfv1connect.RepositoryServiceGetContentsProcedure) {
					t.Error("query escaping changed the selected source")
				}
				if denied {
					w.WriteHeader(403)
					fmt.Fprintf(w, `{"code":"permission_denied","message":%q}`, token)
					return
				}
				fmt.Fprint(w, `{"commitId":"abc","file":{"content":"<script>alert(1)</script>\u001b[31m"}}`)
			}))
			defer forge.Close()
			var out, diagnostic bytes.Buffer
			code := Run(context.Background(), []string{"--url", forge.URL, "--token-stdin", "repo", "contents", "alice/private", "--ref", "feature/a&b", "--path", "src/hello 世界.txt"}, strings.NewReader(token+"\n"), &out, &diagnostic, func(string) string { return "" })
			if denied {
				if code != 1 || out.Len() != 0 || !strings.Contains(diagnostic.String(), "permission_denied") {
					t.Fatalf("denial was not visible: code=%d", code)
				}
			} else {
				var envelope struct {
					Schema string `json:"schema_version"`
					Data   struct {
						Commit string `json:"commitId"`
					} `json:"data"`
				}
				if code != 0 || json.Unmarshal(out.Bytes(), &envelope) != nil || envelope.Schema != "golf.cli.v1" || envelope.Data.Commit != "abc" || bytes.Contains(out.Bytes(), []byte{27}) {
					t.Fatalf("unsafe or missing machine result: code=%d", code)
				}
			}
			if strings.Contains(out.String()+diagnostic.String(), token) {
				t.Fatal("credential leaked to output")
			}
			want := "POST /rpc" + golfv1connect.SessionServiceLoginWithGiteaTokenProcedure + ",POST /rpc" + golfv1connect.RepositoryServiceGetContentsProcedure + ",POST /rpc" + golfv1connect.SessionServiceLogoutProcedure
			if strings.Join(calls, ",") != want {
				t.Fatalf("missing session cleanup: %v", calls)
			}
		})
	}
}

func TestClientRejectsUnsafeOriginsRedirectsAndMalformedResponses(t *testing.T) {
	for _, origin := range []string{"http://remote.example", "https://user:secret@example.com", "https://example.com/path", "https://example.com?secret", "https://example.com#secret", "file:///tmp/socket"} {
		if _, err := parseOrigin(origin); err == nil {
			t.Fatalf("accepted unsafe origin %s", origin)
		}
	}
	var reached atomic.Bool
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached.Store(true) }))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 307) }))
	defer redirect.Close()
	if _, err := execute(context.Background(), redirect.URL, command{name: "repo list"}, "private-token"); err == nil || reached.Load() {
		t.Fatal("credential-bearing request followed a redirect")
	}
	for _, failure := range []string{"malformed", "oversized", "logout"} {
		t.Run(failure, func(t *testing.T) {
			var cleaned atomic.Bool
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if strings.HasSuffix(r.URL.Path, golfv1connect.SessionServiceLogoutProcedure) {
					cleaned.Store(true)
					if failure == "logout" {
						w.WriteHeader(503)
					} else {
						fmt.Fprint(w, `{}`)
					}
					return
				}
				if strings.HasSuffix(r.URL.Path, golfv1connect.SessionServiceLoginWithGiteaTokenProcedure) {
					http.SetCookie(w, &http.Cookie{Name: "golf_session", Value: "opaque", Path: "/"})
					fmt.Fprint(w, `{}`)
					return
				}
				switch failure {
				case "malformed":
					fmt.Fprint(w, `{"missing":`)
				case "oversized":
					fmt.Fprintf(w, `{"file":{"content":%q}}`, strings.Repeat("a", 8<<20))
				default:
					fmt.Fprint(w, `{}`)
				}
			}))
			defer s.Close()
			if _, err := execute(context.Background(), s.URL, command{name: "repo contents"}, "private-token"); err == nil || !cleaned.Load() {
				t.Fatal("bad response/cleanup was treated as success or session cleanup was skipped")
			}
		})
	}
}

func TestCommandValidationBeforeAuthentication(t *testing.T) {
	for _, args := range [][]string{
		{"repo", "view", "../private"}, {"repo", "list", "--limit", "101"}, {"issue", "view", "alice/private", "0"},
		{"issue", "view", "alice/private", "2147483648"},
		{"issue", "list", "alice/private", "--state", "deleted"}, {"repo", "list", "--token", "do-not-echo-token"},
	} {
		var out, diagnostic bytes.Buffer
		code := Run(context.Background(), args, strings.NewReader(""), &out, &diagnostic, func(string) string { return "" })
		if code != 2 || out.Len() != 0 || strings.Contains(diagnostic.String(), "do-not-echo-token") {
			t.Fatal("invalid command did not fail safely before authentication")
		}
	}
}

func TestCancellationDuringCredentialInput(t *testing.T) {
	input, producer := io.Pipe()
	defer input.Close()
	defer producer.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan int, 1)
	go func() {
		finished <- Run(ctx, []string{"--token-stdin", "repo", "list"}, input, io.Discard, io.Discard, func(string) string { return "" })
	}()
	cancel()
	select {
	case code := <-finished:
		if code != 1 {
			t.Fatalf("cancelled input exit code=%d", code)
		}
	case <-time.After(time.Second):
		t.Fatal("CLI ignored cancellation while waiting for stdin EOF")
	}
}

func TestCancellationStillClosesSession(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var cleaned atomic.Bool
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/rpc" + golfv1connect.SessionServiceLoginWithGiteaTokenProcedure:
			http.SetCookie(w, &http.Cookie{Name: "golf_session", Value: "opaque", Path: "/"})
			fmt.Fprint(w, `{}`)
		case "/rpc" + golfv1connect.RepositoryServiceListRepositoriesProcedure:
			io.Copy(io.Discard, r.Body)
			cancel()
			<-r.Context().Done()
		case "/rpc" + golfv1connect.SessionServiceLogoutProcedure:
			cleaned.Store(true)
			fmt.Fprint(w, `{}`)
		}
	}))
	defer s.Close()
	if _, err := execute(ctx, s.URL, command{name: "repo list"}, "private-token"); err == nil || !cleaned.Load() {
		t.Fatal("cancelled read did not clean up through an independent bounded context")
	}
}
