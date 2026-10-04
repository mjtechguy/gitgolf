package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/encoding/protojson"
)

func TestRepositoryUnitProjection(t *testing.T) {
	for _, tc := range []struct {
		name, native        string
		issues, pulls, wiki *bool
	}{
		{"unreported", `{}`, nil, nil, nil},
		{"null unknown", `{"has_issues":null,"has_pull_requests":null,"has_wiki":null}`, nil, nil, nil},
		{"disabled", `{"has_issues":false,"has_pull_requests":false,"has_wiki":false}`, boolPointer(false), boolPointer(false), boolPointer(false)},
		{"enabled", `{"has_issues":true,"has_pull_requests":true,"has_wiki":true}`, boolPointer(true), boolPointer(true), boolPointer(true)},
		{"partial mixed", `{"has_issues":false,"has_pull_requests":true}`, boolPointer(false), boolPointer(true), nil},
		// Native has_issues/wiki can mean externally hosted units. Preserve the
		// configuration flags; never expose or follow their arbitrary URLs.
		{"external units", `{"has_issues":true,"has_wiki":true,"external_tracker":{"external_tracker_url":"https://private.invalid/"},"external_wiki":{"external_wiki_url":"http://169.254.169.254/"}}`, boolPointer(true), nil, boolPointer(true)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var native Repository
			if err := json.Unmarshal([]byte(tc.native), &native); err != nil {
				t.Fatal(err)
			}
			native.ID = 9007199254740993
			native.Name, native.FullName = "private", "alice/private"
			row := wireRepository(native)
			if row.Id != "9007199254740993" {
				t.Fatal("unit projection altered canonical repository identity")
			}
			encoded, err := protojson.Marshal(row)
			if err != nil {
				t.Fatal(err)
			}
			var wire map[string]any
			if err := json.Unmarshal(encoded, &wire); err != nil {
				t.Fatal(err)
			}
			for _, field := range []struct {
				name      string
				got, want *bool
			}{{"issuesEnabled", row.IssuesEnabled, tc.issues}, {"pullRequestsEnabled", row.PullRequestsEnabled, tc.pulls}, {"wikiEnabled", row.WikiEnabled, tc.wiki}} {
				value, present := wire[field.name]
				if (field.got == nil) != (field.want == nil) || field.want != nil && (*field.got != *field.want || !present || value != *field.want) || field.want == nil && present {
					t.Fatal("unknown/disabled unit configuration conflated", field.name, encoded)
				}
			}
			if len(wire) > 6 {
				t.Fatal("raw external metadata leaked into public projection")
			}
		})
	}
	for _, native := range []string{`{"has_issues":"false"}`, `{"has_pull_requests":0}`, `{"has_wiki":{}}`} {
		var row Repository
		if json.Unmarshal([]byte(native), &row) == nil {
			t.Fatal("malformed native unit accepted", native)
		}
	}
	// Settings have a stricter existing projection. Embedded Repository's new
	// optional fields must not shadow that native projection or invent can_edit.
	var settings forgeRepositorySettings
	if err := json.Unmarshal([]byte(`{"id":11,"name":"private","full_name":"alice/private","owner":{"id":42,"login":"alice"},"default_branch":"main","topics":[],"permissions":{"admin":false},"has_issues":false,"has_pull_requests":true,"has_wiki":false,"archived":false,"mirror":false}`), &settings); err != nil {
		t.Fatal(err)
	}
	projection, err := wireRepositorySettings(settings, repositoryKey{"alice", "private"})
	if err != nil || projection.HasIssues || !projection.HasPullRequests || projection.HasWiki || projection.CanEdit {
		t.Fatal("existing configuration/authority projection changed", err)
	}
}

func boolPointer(value bool) *bool { return &value }

func newRepositoryUnitsFixture(t *testing.T) *pullMutationFixture {
	t.Helper()
	f := newPullMutationFixture(t)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/repos/alice/private" && r.URL.Path != "/api/v1/user/repos" {
			f.serve(w, r)
			return
		}
		if r.Method != http.MethodGet {
			t.Error("repository unit projection attempted a native mutation")
		}
		mode := f.mode.Load().(string)
		if mode == "private-denied" {
			w.WriteHeader(404)
			return
		}
		row := map[string]any{"id": 11, "name": "private", "full_name": "alice/private", "html_url": "https://forge.invalid/alice/private", "private": true, "permissions": map[string]bool{"admin": false, "push": false, "pull": true}}
		switch mode {
		case "enabled":
			row["has_issues"], row["has_pull_requests"], row["has_wiki"] = true, true, true
		case "disabled":
			row["has_issues"], row["has_pull_requests"], row["has_wiki"] = false, false, false
		case "mixed":
			row["has_issues"], row["has_pull_requests"] = false, true
		case "malformed":
			row["has_issues"] = "true"
		}
		if r.URL.Path == "/api/v1/user/repos" {
			_ = json.NewEncoder(w).Encode([]any{row})
		} else {
			_ = json.NewEncoder(w).Encode(row)
		}
	}))
	t.Cleanup(provider.Close)
	config := testConfig(provider.URL)
	config.GiteaPublicURL, config.GiteaOAuthClientID, config.GiteaOAuthClientSecret = provider.URL, "fixture-client", "fixture-secret"
	var err error
	f.s, err = New(config, f.db)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func TestRepositoryUnitsAPIPostgres(t *testing.T) {
	f := newRepositoryUnitsFixture(t)
	client := f.client(t, f.session(t, "pat"))
	for _, mode := range []string{"unreported", "enabled", "disabled", "mixed"} {
		f.mode.Store(mode)
		get, err := client.GetRepository(t.Context(), connect.NewRequest(&golfv1.GetRepositoryRequest{Repository: pullKey}))
		if err != nil {
			t.Fatal(err)
		}
		list, err := client.ListRepositories(t.Context(), connect.NewRequest(&golfv1.ListRepositoriesRequest{}))
		if err != nil || len(list.Msg.Repositories) != 1 {
			t.Fatal("repository inventory flags", err)
		}
		for _, row := range []*golfv1.Repository{get.Msg.Repository, list.Msg.Repositories[0]} {
			if row.Id != "11" || row.FullName != "alice/private" || !row.Private {
				t.Fatal("configuration changed identity or privacy")
			}
			switch mode {
			case "unreported":
				if row.IssuesEnabled != nil || row.PullRequestsEnabled != nil || row.WikiEnabled != nil {
					t.Fatal("missing native units invented configuration")
				}
			case "enabled", "disabled":
				want := mode == "enabled"
				if row.IssuesEnabled == nil || row.PullRequestsEnabled == nil || row.WikiEnabled == nil || *row.IssuesEnabled != want || *row.PullRequestsEnabled != want || *row.WikiEnabled != want {
					t.Fatal("explicit native boolean presence lost", mode)
				}
			case "mixed":
				if row.IssuesEnabled == nil || *row.IssuesEnabled || row.PullRequestsEnabled == nil || !*row.PullRequestsEnabled || row.WikiEnabled != nil {
					t.Fatal("independent unit configuration collapsed")
				}
			}
		}
		if get.Header().Get("Cache-Control") != "no-store" || list.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("private native unit metadata cacheable")
		}
	}
	for _, mode := range []string{"malformed", "private-denied"} {
		f.mode.Store(mode)
		get, err := client.GetRepository(t.Context(), connect.NewRequest(&golfv1.GetRepositoryRequest{Repository: pullKey}))
		want := connect.CodeUnavailable
		if mode == "private-denied" {
			want = connect.CodeNotFound
		}
		if get != nil || connect.CodeOf(err) != want {
			t.Fatal("invalid/private configuration released", mode, err)
		}
	}
}

// Optional actual supported-native proof, with an owner-only disposable fixture
// envelope. All Golf metadata uses testDatabase's isolated schema; this test
// performs native GETs only and neither provisions nor edits native resources.
func TestRepositoryUnitsNativeProof(t *testing.T) {
	path := os.Getenv("GOLF_REPOSITORY_UNITS_NATIVE_PROOF")
	if path == "" {
		t.Skip("requires supported native unit fixture envelope")
	}
	var proof struct {
		URL, Owner, Repository, Caller, Token string
		UserID, RepositoryID                  int64
		Issues, Pulls, Wiki                   bool
	}
	data, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(data, &proof) != nil || proof.UserID <= 0 || proof.RepositoryID <= 0 {
		t.Fatal("native unit fixture envelope unavailable")
	}
	s, err := New(testConfig(proof.URL), testDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.createSession(t.Context(), User{ID: proof.UserID, Login: proof.Caller}, "pat", proof.Token, "")
	if err != nil {
		t.Fatal("native caller session unavailable")
	}
	_, client, _, transport, origin := testRPCClients(t, s)
	transport.Jar.SetCookies(origin, []*http.Cookie{s.sessionCookie(session.Value, session.Expires, 3600)})
	get, err := client.GetRepository(t.Context(), connect.NewRequest(&golfv1.GetRepositoryRequest{Repository: &golfv1.RepositoryKey{Owner: proof.Owner, Name: proof.Repository}}))
	if err != nil {
		t.Fatal("native repository read failed", err)
	}
	list, err := client.ListRepositories(t.Context(), connect.NewRequest(&golfv1.ListRepositoriesRequest{}))
	if err != nil {
		t.Fatal("native inventory read failed", err)
	}
	var found *golfv1.Repository
	for _, repo := range list.Msg.Repositories {
		if repo.Id == strconv.FormatInt(proof.RepositoryID, 10) {
			found = repo
		}
	}
	if found == nil {
		t.Fatal("native caller inventory omitted fixture")
	}
	for _, row := range []*golfv1.Repository{get.Msg.Repository, found} {
		if row.Id != strconv.FormatInt(proof.RepositoryID, 10) || row.FullName != proof.Owner+"/"+proof.Repository || row.IssuesEnabled == nil || row.PullRequestsEnabled == nil || row.WikiEnabled == nil || *row.IssuesEnabled != proof.Issues || *row.PullRequestsEnabled != proof.Pulls || *row.WikiEnabled != proof.Wiki {
			t.Fatal("native observed unit presence/configuration changed")
		}
	}
	if get.Header().Get("Cache-Control") != "no-store" || list.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("native private unit read cacheable")
	}
}
