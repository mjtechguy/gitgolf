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

func TestRepositoryGeneralProjectionAndValidation(t *testing.T) {
	for _, raw := range []string{`{"enable_time_tracker":true}`, `{"enable_time_tracker":null,"allow_only_contributors_to_track_time":false,"enable_issue_dependencies":false}`} {
		var config forgeInternalTracker
		if json.Unmarshal([]byte(raw), &config) == nil {
			t.Fatal("missing native tracker option accepted")
		}
	}
	var tracker forgeExternalTracker
	if json.Unmarshal([]byte(`{"external_tracker_url":"https://test"}`), &tracker) == nil {
		t.Fatal("missing external config fields accepted")
	}

	row := settingsFixtureRow()
	key := repositoryKey{"alice", "example"}
	row.Website = "https://example.test"
	row.Topics = &[]string{"git", "agents"}
	row.InternalTracker = &forgeInternalTracker{EnableTimeTracker: true, EnableDependencies: true}
	original, e := wireRepositorySettings(row, key)
	if e != nil || original.IssuesMode != golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_INTERNAL || original.Topics[0] != "agents" || !original.GeneralEditImplemented {
		t.Fatal(original, e)
	}
	row.InternalTracker.EnableDependencies = false
	changed, _ := wireRepositorySettings(row, key)
	if changed.Revision == original.Revision {
		t.Fatal("internal tracker external change invisible")
	}
	row.InternalTracker = nil
	row.ExternalTracker = &forgeExternalTracker{URL: "https://tracker.test", Format: "https://tracker.test/{repo}/{index}", Style: "regexp", Pattern: "ABC-[0-9]+"}
	row.ExternalWiki = &forgeExternalWiki{URL: "https://wiki.test"}
	external, e := wireRepositorySettings(row, key)
	if e != nil || external.IssuesMode != golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_EXTERNAL || external.ExternalTracker.RegexpPattern != "ABC-[0-9]+" || external.WikiMode != golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_EXTERNAL {
		t.Fatal(external, e)
	}
	for _, change := range []func(*forgeRepositorySettings){func(r *forgeRepositorySettings) { r.Topics = nil }, func(r *forgeRepositorySettings) { r.Topics = &[]string{"duplicate", "duplicate"} }, func(r *forgeRepositorySettings) { r.InternalTracker = &forgeInternalTracker{} }, func(r *forgeRepositorySettings) { r.HasWiki = boolPointer(false) }, func(r *forgeRepositorySettings) { r.ExternalTracker.URL = "bad\x00" }} {
		copy := row
		tracker := *row.ExternalTracker
		copy.ExternalTracker = &tracker
		change(&copy)
		if _, e := wireRepositorySettings(copy, key); e == nil {
			t.Fatal("malformed config accepted")
		}
	}
	mode := golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_EXTERNAL
	url := "https://new.test"
	req := &golfv1.UpdateRepositorySettingsRequest{RepositoryId: original.RepositoryId, OwnerId: original.OwnerId, ExpectedRevision: original.Revision, Website: &url, IssuesMode: &mode, ExternalTracker: &golfv1.RepositoryExternalTracker{Url: "https://issues.test", Format: "https://issues.test/{user}/{repo}/{index}", Style: "numeric"}, WikiMode: &mode, ExternalWiki: &golfv1.RepositoryExternalWiki{Url: "https://wiki.test"}}
	patch, e := repositorySettingsPatch(req)
	if e != nil || len(patch) != 5 || patch["has_issues"] != true || patch["has_wiki"] != true {
		t.Fatal(patch, e)
	}
	for _, change := range []func(*golfv1.UpdateRepositorySettingsRequest){func(r *golfv1.UpdateRepositorySettingsRequest) { r.HasIssues = boolPointer(true) }, func(r *golfv1.UpdateRepositorySettingsRequest) { v := "https://user:secret@test"; r.Website = &v }, func(r *golfv1.UpdateRepositorySettingsRequest) { r.ExternalTracker.Format = "javascript:{index}" }, func(r *golfv1.UpdateRepositorySettingsRequest) {
		r.ExternalTracker.Style = "regexp"
		r.ExternalTracker.RegexpPattern = "["
	}, func(r *golfv1.UpdateRepositorySettingsRequest) { r.ExternalWiki = nil }, func(r *golfv1.UpdateRepositorySettingsRequest) { r.IssuesMode = nil }} {
		copy := proto.Clone(req).(*golfv1.UpdateRepositorySettingsRequest)
		change(copy)
		if _, e := repositorySettingsPatch(copy); e == nil {
			t.Fatal("unsafe/config conflicting update accepted")
		}
	}
	for _, topics := range [][]string{{"Upper"}, {"bad topic"}, {"a", "a"}, {strings.Repeat("x", 36)}, make([]string, 26)} {
		if validRepositoryTopics(topics) {
			t.Fatal("invalid topics accepted", topics)
		}
	}
}

func TestRepositoryGeneralPostgres(t *testing.T) {
	db := testDatabase(t)
	var mu sync.Mutex
	row := settingsFixtureRow()
	row.Website = "https://original.test"
	row.Topics = &[]string{"original"}
	row.InternalTracker = &forgeInternalTracker{EnableTimeTracker: true, AllowOnlyContributors: true, EnableDependencies: true}
	writes := 0
	lost := false
	wrongID := false
	var beforeRead func()
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
		if r.URL.Path != "/api/v1/repos/alice/example" && r.URL.Path != "/api/v1/repos/alice/example/topics" {
			w.WriteHeader(404)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if r.Method == "GET" {
			if beforeRead != nil {
				beforeRead()
			}
			copy := row
			if wrongID {
				copy.ID++
			}
			json.NewEncoder(w).Encode(copy)
			return
		}
		writes++
		if r.Method == "PUT" {
			var input struct {
				Topics []string `json:"topics"`
			}
			json.NewDecoder(r.Body).Decode(&input)
			row.Topics = &input.Topics
			if lost {
				w.WriteHeader(500)
			} else {
				w.WriteHeader(204)
			}
			return
		}
		var patch map[string]json.RawMessage
		json.NewDecoder(r.Body).Decode(&patch)
		for k, v := range patch {
			switch k {
			case "website":
				json.Unmarshal(v, &row.Website)
			case "description":
				json.Unmarshal(v, &row.Description)
			case "has_issues":
				var enabled bool
				json.Unmarshal(v, &enabled)
				row.HasIssues = &enabled
				if !enabled {
					row.InternalTracker = nil
					row.ExternalTracker = nil
				} else if patch["external_tracker"] != nil {
					row.InternalTracker = nil
					json.Unmarshal(patch["external_tracker"], &row.ExternalTracker)
				} else {
					row.ExternalTracker = nil
					if row.InternalTracker == nil {
						row.InternalTracker = &forgeInternalTracker{}
					}
				}
			case "has_wiki":
				var enabled bool
				json.Unmarshal(v, &enabled)
				row.HasWiki = &enabled
				row.ExternalWiki = nil
				if enabled && patch["external_wiki"] != nil {
					json.Unmarshal(patch["external_wiki"], &row.ExternalWiki)
				}
			case "external_tracker", "external_wiki":
			default:
				t.Error("unexpected setting", k)
			}
		}
		if lost {
			w.WriteHeader(500)
		} else {
			json.NewEncoder(w).Encode(row)
		}
	}))
	defer provider.Close()
	s, e := New(testConfig(provider.URL), db)
	if e != nil {
		t.Fatal(e)
	}
	session, e := s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", "general-fixture", "")
	if e != nil {
		t.Fatal(e)
	}
	ctx := context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "general-fixture"})
	cookie := s.sessionCookie(session.Value, session.Expires, 3600).String()
	target := &golfv1.RepositoryKey{Owner: "alice", Name: "example"}
	get := func(id string) (*golfv1.RepositorySettings, error) {
		req := connect.NewRequest(&golfv1.GetRepositorySettingsRequest{Repository: target, RepositoryId: id})
		req.Header().Set("Cookie", cookie)
		got, e := s.GetRepositorySettings(ctx, req)
		if e != nil {
			return nil, e
		}
		return got.Msg.Settings, nil
	}
	update := func(m *golfv1.UpdateRepositorySettingsRequest) (*golfv1.RepositorySettings, error) {
		req := connect.NewRequest(m)
		req.Header().Set("Cookie", cookie)
		got, e := s.UpdateRepositorySettings(ctx, req)
		if e != nil {
			return nil, e
		}
		return got.Msg.Settings, nil
	}
	topics := func(v *golfv1.RepositorySettings, values []string) (*golfv1.RepositorySettings, error) {
		req := connect.NewRequest(&golfv1.UpdateRepositoryTopicsRequest{Repository: target, RepositoryId: v.RepositoryId, OwnerId: v.OwnerId, ExpectedRevision: v.Revision, Topics: values})
		req.Header().Set("Cookie", cookie)
		got, e := s.UpdateRepositoryTopics(ctx, req)
		if e != nil {
			return nil, e
		}
		return got.Msg.Settings, nil
	}
	current, e := get("")
	if e != nil {
		t.Fatal(e)
	}
	if _, e := get("99"); connect.CodeOf(e) != connect.CodeFailedPrecondition {
		t.Fatal("wrong refresh identity accepted", e)
	}
	website := "https://golf.test"
	m := &golfv1.UpdateRepositorySettingsRequest{Repository: target, RepositoryId: current.RepositoryId, OwnerId: current.OwnerId, ExpectedRevision: current.Revision, Website: &website}
	after, e := update(m)
	if e != nil || after.Website != website || !row.InternalTracker.EnableDependencies || !row.InternalTracker.AllowOnlyContributors || after.Description != "Original" {
		t.Fatal("metadata save destroyed unrelated config", e)
	}
	if _, e := topics(current, []string{"stale"}); connect.CodeOf(e) != connect.CodeFailedPrecondition || writes != 1 {
		t.Fatal("stale topics dispatched", e)
	}
	after, e = topics(after, []string{"git", "agents"})
	if e != nil || after.Topics[0] != "agents" || after.Website != website {
		t.Fatal("topic readback", e)
	}
	after, e = topics(after, []string{})
	if e != nil || len(after.Topics) != 0 {
		t.Fatal("explicit topic clear", e)
	}
	mode := golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_EXTERNAL
	m.ExpectedRevision = after.Revision
	m.Website = nil
	m.IssuesMode = &mode
	m.ExternalTracker = &golfv1.RepositoryExternalTracker{Url: "https://issues.test", Format: "https://issues.test/{repo}/{index}", Style: "regexp", RegexpPattern: "TASK-[0-9]+"}
	m.WikiMode = &mode
	m.ExternalWiki = &golfv1.RepositoryExternalWiki{Url: "https://wiki.test"}
	after, e = update(m)
	if e != nil || after.ExternalTracker == nil || after.ExternalWiki == nil {
		t.Fatal("external mode readback", e)
	}
	before := writes
	m.IssuesMode = nil
	m.WikiMode = nil
	m.ExternalTracker = nil
	m.ExternalWiki = nil
	m.ExpectedRevision = after.Revision
	m.HasIssues = boolPointer(true)
	if _, e = update(m); connect.CodeOf(e) != connect.CodeInvalidArgument || writes != before {
		t.Fatal("legacy enable silently converted external", e)
	}
	m.HasIssues = nil
	description := "Only metadata"
	m.Description = &description
	after, e = update(m)
	if e != nil || after.ExternalTracker.Url != "https://issues.test" || after.ExternalWiki.Url != "https://wiki.test" {
		t.Fatal("unrelated external mode lost", e)
	}
	m.ExpectedRevision = after.Revision
	m.Description = nil
	internalMode := golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_INTERNAL
	disabledMode := golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_DISABLED
	m.IssuesMode = &internalMode
	m.WikiMode = &disabledMode
	after, e = update(m)
	if e != nil || after.IssuesMode != internalMode || after.WikiMode != disabledMode || after.ExternalTracker != nil || after.ExternalWiki != nil {
		t.Fatal("explicit internal/disabled conversion", e)
	}
	mu.Lock()
	row.Permissions.Admin = false
	mu.Unlock()
	before = writes
	if _, e = topics(after, []string{"denied"}); connect.CodeOf(e) != connect.CodePermissionDenied || writes != before {
		t.Fatal("reader topics write", e)
	}
	mu.Lock()
	row.Permissions.Admin = true
	row.Description = "Outside editor"
	mu.Unlock()
	if _, e = topics(after, []string{"stale"}); connect.CodeOf(e) != connect.CodeFailedPrecondition || writes != before {
		t.Fatal("external edit topics dispatched", e)
	}
	after, e = get("")
	if e != nil {
		t.Fatal(e)
	}
	lost = true
	if _, e = topics(after, []string{"applied"}); connect.CodeOf(e) != connect.CodeUnavailable || writes != before+1 {
		t.Fatal("lost write reported success", e)
	}
	lost = false
	after, e = get("")
	if e != nil || len(after.Topics) != 1 || after.Topics[0] != "applied" {
		t.Fatal("inspection omitted applied state", e)
	}
	wrongID = true
	before = writes
	if _, e = topics(after, []string{"replaced"}); connect.CodeOf(e) != connect.CodeFailedPrecondition || writes != before {
		t.Fatal("replacement write", e)
	}
	wrongID = false
	beforeRead = func() {
		beforeRead = nil
		if e := s.logoutSession(t.Context(), session.Value); e != nil {
			t.Error(e)
		}
	}
	if _, e = topics(after, []string{"revoked"}); connect.CodeOf(e) != connect.CodeUnauthenticated || writes != before {
		t.Fatal("session loss dispatched", e)
	}
}
