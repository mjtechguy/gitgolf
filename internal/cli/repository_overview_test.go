package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func overviewReadFixture(t *testing.T, api bool, failure string) (*httptest.Server, func() []string) {
	t.Helper()
	var mu sync.Mutex
	var calls []string
	const id = "9007199254740993"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		mu.Lock()
		calls = append(calls, method)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Origin") != "http://"+r.Host {
			t.Error("lost origin")
		}
		if api {
			if r.Header.Get("Authorization") != "Bearer "+fixtureAPIToken || r.Header.Get("Cookie") != "" || method == "LoginWithGiteaToken" || method == "Logout" {
				t.Error("bearer crossed session boundary")
			}
		} else if method == "LoginWithGiteaToken" {
			http.SetCookie(w, &http.Cookie{Name: "golf_session", Value: "opaque", Path: "/", HttpOnly: true})
			fmt.Fprint(w, `{"user":{"id":"1"}}`)
			return
		} else if cookie, err := r.Cookie("golf_session"); err != nil || cookie.Value != "opaque" {
			t.Error("lost temporary session")
		}
		if method == "Logout" {
			fmt.Fprint(w, `{}`)
			return
		}
		var input struct {
			Repository   struct{ Owner, Name string }
			RepositoryId string
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil || input.Repository.Owner != "alice" || input.Repository.Name != "private" {
			t.Error("wrong repository")
		}
		if method == "GetRepository" {
			metadata := map[string]any{"id": id, "name": "private", "fullName": "alice/private"}
			if failure == "metadata-id" {
				metadata["id"] = "01"
			}
			if failure == "metadata-route" {
				metadata["fullName"] = "alice/replaced"
			}
			json.NewEncoder(w).Encode(map[string]any{"repository": metadata})
			return
		}
		if method != "GetRepositoryOverview" || input.RepositoryId != id {
			t.Error("wrong exact metadata request")
		}
		if failure == "denied" {
			w.WriteHeader(403)
			fmt.Fprint(w, `{"code":"permission_denied","message":"private-overview fixture-private-token"}`)
			return
		}
		row := map[string]any{"repository": map[string]string{"owner": "alice", "name": "private"}, "repositoryId": id, "description": "private-overview", "website": "https://example.invalid/private", "topics": []string{"golf"}, "starsCount": "0", "watchersCount": id, "languages": []map[string]string{{"name": "Python", "byteCount": id}}, "languagesState": "REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE", "licensesState": "REPOSITORY_OVERVIEW_SECTION_STATE_UNAVAILABLE"}
		switch failure {
		case "receipt-id":
			row["repositoryId"] = "2"
		case "receipt-route":
			row["repository"] = map[string]string{"owner": "alice", "name": "replaced"}
		case "count":
			row["starsCount"] = "-1"
		case "unsafe-url":
			row["website"] = "javascript:private-overview"
		case "duplicate-topic":
			row["topics"] = []string{"golf", "golf"}
		case "long-description":
			row["description"] = strings.Repeat("x", 2049)
		case "duplicate-language":
			row["languages"] = []map[string]string{{"name": "Python", "byteCount": "1"}, {"name": "Python", "byteCount": "1"}}
		case "overflow":
			row["languages"] = []map[string]string{{"name": "Python", "byteCount": "9223372036854775807"}, {"name": "Go", "byteCount": "1"}}
		case "unknown-state":
			row["languagesState"] = "REPOSITORY_OVERVIEW_SECTION_STATE_UNSPECIFIED"
		case "unavailable-with-data":
			row["languagesState"] = "REPOSITORY_OVERVIEW_SECTION_STATE_UNAVAILABLE"
		}
		json.NewEncoder(w).Encode(row)
	}))
	t.Cleanup(server.Close)
	return server, func() []string { mu.Lock(); defer mu.Unlock(); return append([]string{}, calls...) }
}

func TestRepositoryOverviewCredentialModesAndReceipts(t *testing.T) {
	for _, api := range []bool{false, true} {
		for _, failure := range []string{"", "metadata-id", "metadata-route", "receipt-id", "receipt-route", "denied", "count", "unsafe-url", "duplicate-topic", "long-description", "duplicate-language", "overflow", "unknown-state", "unavailable-with-data"} {
			t.Run(fmt.Sprintf("api=%v/%s", api, failure), func(t *testing.T) {
				server, calls := overviewReadFixture(t, api, failure)
				flag, token := "--token-stdin", "fixture-private-token"
				if api {
					flag, token = "--api-token-stdin", fixtureAPIToken
				}
				var out, diagnostic bytes.Buffer
				code := Run(context.Background(), []string{"--url", server.URL, flag, "repo", "overview", "alice/private"}, strings.NewReader(token+"\n"), &out, &diagnostic, func(string) string { return "" })
				if failure == "" {
					var envelope struct{ Data map[string]any }
					if code != 0 || json.Unmarshal(out.Bytes(), &envelope) != nil || envelope.Data["watchersCount"] != "9007199254740993" || envelope.Data["starsCount"] != "0" {
						t.Fatalf("lost exact/optional counts: code=%d", code)
					}
					if _, present := envelope.Data["forksCount"]; present {
						t.Fatal("unknown count became a value")
					}
				} else if code == 0 || out.Len() != 0 || strings.Contains(diagnostic.String(), "private-overview") {
					t.Fatal("unverified private receipt escaped")
				}
				if strings.Contains(out.String(), token) || strings.Contains(diagnostic.String(), token) {
					t.Fatal("credential escaped")
				}
				trace := calls()
				if !api && (trace[0] != "LoginWithGiteaToken" || trace[len(trace)-1] != "Logout") {
					t.Fatal("session not cleaned up")
				}
				if strings.HasPrefix(failure, "metadata") && strings.Contains(strings.Join(trace, ","), "GetRepositoryOverview") {
					t.Fatal("invalid identity traversed")
				}
			})
		}
	}
}

func TestMCPRepositoryOverviewUsesBoundedRead(t *testing.T) {
	for _, api := range []bool{false, true} {
		server, _ := overviewReadFixture(t, api, "")
		auth := credential{token: "fixture-private-token", api: api}
		if api {
			auth.token = fixtureAPIToken
		}
		client := mcpTestCredentialSession(t, server.URL, "2026-07-28", context.Background(), auth)
		result, err := client.CallTool(context.Background(), &mcp.CallToolParams{Name: "golf_repo_overview", Arguments: map[string]any{"repository": "alice/private"}})
		if err != nil || result.IsError || !strings.Contains(result.Content[0].(*mcp.TextContent).Text, `"9007199254740993"`) {
			t.Fatal("overview tool lost exact metadata")
		}
		for _, args := range []map[string]any{{"repository": "alice/private", "token": "secret"}, {"repository": "alice/private", "ref": "main"}, {"repository": "../private"}} {
			result, err := client.CallTool(context.Background(), &mcp.CallToolParams{Name: "golf_repo_overview", Arguments: args})
			if err == nil && !result.IsError {
				t.Fatal("tool accepted undeclared authority/selectors")
			}
		}
	}
}
