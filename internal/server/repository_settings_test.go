package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

func settingsFixtureRow() forgeRepositorySettings {
	yes, no := true, false
	row := forgeRepositorySettings{Repository: Repository{ID: 9007199254740993, Name: "example", FullName: "alice/example", Description: "Original", DefaultBranch: "main"}, Owner: &User{ID: 42, Login: "alice"}, Topics: &[]string{}, InternalTracker: &forgeInternalTracker{}, HasIssues: &yes, HasWiki: &yes, HasPullRequests: &yes, Archived: &no, Mirror: &no}
	row.Permissions = &struct {
		Admin bool `json:"admin"`
	}{true}
	return row
}

func TestRepositorySettingsValidation(t *testing.T) {
	key := repositoryKey{"alice", "example"}
	row := settingsFixtureRow()
	settings, err := wireRepositorySettings(row, key)
	if err != nil || settings.RepositoryId != "9007199254740993" || !settings.CanEdit || len(settings.Revision) != 64 {
		t.Fatal("valid projection", err)
	}
	row.Description = "Changed"
	updated, _ := wireRepositorySettings(row, key)
	if updated.Revision == settings.Revision {
		t.Fatal("description change did not change revision")
	}
	row = settingsFixtureRow()
	row.Owner.ID = 43
	moved, _ := wireRepositorySettings(row, key)
	if moved.Revision == settings.Revision {
		t.Fatal("owner identity was absent from revision")
	}
	for _, mutate := range []func(*forgeRepositorySettings){func(r *forgeRepositorySettings) { r.Owner = nil }, func(r *forgeRepositorySettings) { r.HasWiki = nil }, func(r *forgeRepositorySettings) { r.Permissions = nil }, func(r *forgeRepositorySettings) { r.FullName = "bob/example" }, func(r *forgeRepositorySettings) { r.DefaultBranch = "bad..ref" }} {
		row = settingsFixtureRow()
		mutate(&row)
		if _, err := wireRepositorySettings(row, key); err == nil {
			t.Fatal("accepted malformed provider settings")
		}
	}
	req := &golfv1.UpdateRepositorySettingsRequest{RepositoryId: settings.RepositoryId, OwnerId: settings.OwnerId, ExpectedRevision: settings.Revision}
	description := ""
	off := false
	req.Description = &description
	req.HasIssues = &off
	patch, err := repositorySettingsPatch(req)
	if err != nil || len(patch) != 2 || patch["description"] != "" || patch["has_issues"] != false {
		t.Fatal("optional empty/false update lost", err)
	}
	for _, mutate := range []func(*golfv1.UpdateRepositorySettingsRequest){func(r *golfv1.UpdateRepositorySettingsRequest) { r.RepositoryId = "09007199254740993" }, func(r *golfv1.UpdateRepositorySettingsRequest) {
		r.ExpectedRevision = strings.ToUpper(r.ExpectedRevision)
	}, func(r *golfv1.UpdateRepositorySettingsRequest) { x := "-----\x00"; r.Description = &x }, func(r *golfv1.UpdateRepositorySettingsRequest) { x := "missing..branch"; r.DefaultBranch = &x }} {
		copied := proto.Clone(req).(*golfv1.UpdateRepositorySettingsRequest)
		mutate(copied)
		if _, err := repositorySettingsPatch(copied); err == nil {
			t.Fatal("accepted invalid update")
		}
	}
}

func TestRepositorySettingsBoundary(t *testing.T) {
	s, err := New(testConfig("http://forgejo.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"GetRepositorySettings", "UpdateRepositorySettings", "UpdateRepositoryTopics"} {
		path := "/golf.v1.RepositorySettingsService/" + method
		for _, origin := range []string{s.config.PublicURL, "https://other.invalid"} {
			req := httptest.NewRequest("POST", "/rpc"+path, strings.NewReader("malformed"))
			req.Header.Set("Origin", origin)
			req.Header.Set("Content-Type", "application/json")
			recorder := httptest.NewRecorder()
			s.ServeHTTP(recorder, req)
			want := 401
			if origin != s.config.PublicURL {
				want = 403
			}
			if recorder.Code != want || recorder.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("%s boundary: %d", method, recorder.Code)
			}
		}
		if response := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), path, "malformed"); response.Code != 403 {
			t.Fatalf("bearer reached browser settings: %d", response.Code)
		}
	}
}

func TestRepositorySettingsPostgres(t *testing.T) {
	db := testDatabase(t)
	var mu sync.Mutex
	row := settingsFixtureRow()
	patches := 0
	mode := ""
	var onRead func()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/v1/version" {
			json.NewEncoder(w).Encode(map[string]string{"version": "1.27.3"})
			return
		}
		if r.URL.Path == "/api/v1/user" {
			json.NewEncoder(w).Encode(User{ID: 42, Login: "alice"})
			return
		}
		if r.URL.Path == "/api/v1/repos/alice/example/git/refs/heads/release/next" {
			json.NewEncoder(w).Encode([]map[string]any{{"ref": "refs/heads/release/next", "object": map[string]string{"type": "commit", "sha": strings.Repeat("a", 40)}}})
			return
		}
		if r.URL.Path != "/api/v1/repos/alice/example" {
			w.WriteHeader(404)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if r.Method == "GET" {
			if onRead != nil {
				onRead()
			}
			json.NewEncoder(w).Encode(row)
			return
		}
		if r.Method != "PATCH" {
			w.WriteHeader(405)
			return
		}
		patches++
		var patch map[string]json.RawMessage
		if json.NewDecoder(r.Body).Decode(&patch) != nil {
			t.Error("invalid PATCH")
			w.WriteHeader(400)
			return
		}
		for field, value := range patch {
			switch field {
			case "description":
				json.Unmarshal(value, &row.Description)
			case "default_branch":
				json.Unmarshal(value, &row.DefaultBranch)
			case "has_issues":
				var enabled bool
				json.Unmarshal(value, &enabled)
				row.HasIssues = &enabled
			case "has_wiki":
				var enabled bool
				json.Unmarshal(value, &enabled)
				row.HasWiki = &enabled
			case "has_pull_requests":
				var enabled bool
				json.Unmarshal(value, &enabled)
				row.HasPullRequests = &enabled
			default:
				t.Error("unexpected PATCH field", field)
			}
		}
		if mode == "lost" {
			w.WriteHeader(500)
			return
		}
		json.NewEncoder(w).Encode(row)
	}))
	defer provider.Close()
	s, err := New(testConfig(provider.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", "fixture-settings", "")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "fixture-settings"})
	get := func() *golfv1.RepositorySettings {
		req := connect.NewRequest(&golfv1.GetRepositorySettingsRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}})
		req.Header().Set("Cookie", s.sessionCookie(session.Value, session.Expires, 3600).String())
		got, err := s.GetRepositorySettings(ctx, req)
		if err != nil {
			t.Fatal(err)
		}
		return got.Msg.Settings
	}
	update := func(settings *golfv1.RepositorySettings, description, branch string) (*connect.Response[golfv1.UpdateRepositorySettingsResponse], error) {
		msg := &golfv1.UpdateRepositorySettingsRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: settings.RepositoryId, OwnerId: settings.OwnerId, ExpectedRevision: settings.Revision, Description: &description}
		if branch != "" {
			msg.DefaultBranch = &branch
		}
		req := connect.NewRequest(msg)
		req.Header().Set("Cookie", s.sessionCookie(session.Value, session.Expires, 3600).String())
		return s.UpdateRepositorySettings(ctx, req)
	}
	before := get()
	after, err := update(before, "Updated", "release/next")
	if err != nil || after.Msg.Settings.Description != "Updated" || after.Msg.Settings.DefaultBranch != "release/next" {
		t.Fatal("supported update", err)
	}
	if _, err := update(before, "Stale", ""); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("stale update", err)
	}
	if patches != 1 {
		t.Fatal("stale update dispatched")
	}
	current := get()
	mu.Lock()
	row.Permissions.Admin = false
	mu.Unlock()
	if get().CanEdit {
		t.Fatal("reader shown editable settings")
	}
	if _, err := update(current, "Denied", ""); connect.CodeOf(err) != connect.CodePermissionDenied || patches != 1 {
		t.Fatal("nonadmin update dispatched", err)
	}
	mu.Lock()
	row.Permissions.Admin = true
	mode = "lost"
	mu.Unlock()
	current = get()
	if _, err := update(current, "Possibly completed", ""); connect.CodeOf(err) != connect.CodeUnavailable {
		t.Fatal("lost result was success", err)
	}
	if patches != 2 || get().Description != "Possibly completed" {
		t.Fatal("lost PATCH repeated or actual outcome concealed")
	}
	mu.Lock()
	mode = ""
	mu.Unlock()
	current = get()
	onRead = func() {
		onRead = nil
		if err := s.logoutSession(t.Context(), session.Value); err != nil {
			t.Error(err)
		}
	}
	if _, err := update(current, "Revoked", ""); connect.CodeOf(err) != connect.CodeUnauthenticated || patches != 2 {
		t.Fatal("revoked session dispatched update", err)
	}
}
