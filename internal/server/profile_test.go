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

func profileFixture() forgeProfileSettings {
	full, bio, location, website := "Alice", "Developer", "London", "https://example.invalid/alice"
	return forgeProfileSettings{&full, &bio, &location, &website}
}
func TestProfileValidation(t *testing.T) {
	row := profileFixture()
	user := User{ID: 9007199254740993, Login: "alice"}
	p, err := wireProfile(row, user)
	if err != nil || p.UserId != "9007199254740993" || !p.CanEdit {
		t.Fatal("valid own profile", err)
	}
	legacy := "example.com"
	row.Website = &legacy
	if read, err := wireProfile(row, user); err != nil || read.Website != legacy {
		t.Fatal("safe legacy website prevented own profile read", err)
	}
	row = profileFixture()
	original := p.Revision
	user.ID++
	different, _ := wireProfile(row, user)
	if different.Revision == original {
		t.Fatal("revision omitted immutable identity")
	}
	value := ""
	req := &golfv1.UpdateProfileRequest{UserId: p.UserId, ExpectedRevision: p.Revision, FullName: &value, Bio: &value, Location: &value, Website: &value}
	patch, err := profilePatch(req)
	if err != nil || len(patch) != 4 || patch["full_name"] != "" {
		t.Fatal("explicit clear lost", err)
	}
	for _, mutate := range []func(*golfv1.UpdateProfileRequest){func(r *golfv1.UpdateProfileRequest) { r.UserId = "0" }, func(r *golfv1.UpdateProfileRequest) { r.ExpectedRevision = strings.ToUpper(r.ExpectedRevision) }, func(r *golfv1.UpdateProfileRequest) { x := strings.Repeat("é", 51); r.FullName = &x }, func(r *golfv1.UpdateProfileRequest) { x := "bad\nlocation"; r.Location = &x }, func(r *golfv1.UpdateProfileRequest) { x := "javascript:alert(1)"; r.Website = &x }, func(r *golfv1.UpdateProfileRequest) { x := "https://alice:secret@example.invalid"; r.Website = &x }, func(r *golfv1.UpdateProfileRequest) { x := "bad\x00bio"; r.Bio = &x }} {
		copy := proto.Clone(req).(*golfv1.UpdateProfileRequest)
		mutate(copy)
		if _, err := profilePatch(copy); err == nil {
			t.Fatal("invalid public profile input accepted")
		}
	}
	row.Website = nil
	if _, err := wireProfile(row, user); err == nil {
		t.Fatal("missing provider field fabricated")
	}
	if _, err := profilePatch(&golfv1.UpdateProfileRequest{UserId: p.UserId, ExpectedRevision: p.Revision}); err == nil {
		t.Fatal("empty update accepted")
	}
}
func TestProfileBoundary(t *testing.T) {
	s, err := New(testConfig("http://forge.invalid"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"GetProfile", "UpdateProfile"} {
		path := "/golf.v1.ProfileService/" + method
		for _, origin := range []string{s.config.PublicURL, "https://other.invalid"} {
			req := httptest.NewRequest("POST", "/rpc"+path, strings.NewReader("malformed"))
			req.Header.Set("Origin", origin)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			want := 401
			if origin != s.config.PublicURL {
				want = 403
			}
			if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("profile boundary: %d", w.Code)
			}
		}
		if w := apiRequest(s, apiTokenPrefix+strings.Repeat("A", 43), path, "malformed"); w.Code != 403 {
			t.Fatal("bearer reached cookie profile", w.Code)
		}
	}
}
func TestProfilePostgres(t *testing.T) {
	db := testDatabase(t)
	var mu sync.Mutex
	row := profileFixture()
	identity := int64(42)
	patches := 0
	mode := ""
	var onRead func()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Path == "/api/v1/version" {
			json.NewEncoder(w).Encode(map[string]string{"version": "1.27.3"})
			return
		}
		if r.URL.Path == "/api/v1/user" {
			json.NewEncoder(w).Encode(User{ID: identity, Login: "alice", FullName: *row.FullName})
			return
		}
		if r.URL.Path != "/api/v1/user/settings" {
			w.WriteHeader(404)
			return
		}
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
		var values map[string]string
		if json.NewDecoder(r.Body).Decode(&values) != nil {
			t.Error("bad patch")
			w.WriteHeader(400)
			return
		}
		for field, value := range values {
			switch field {
			case "full_name":
				row.FullName = &value
			case "description":
				row.Bio = &value
			case "location":
				row.Location = &value
			case "website":
				row.Website = &value
			default:
				t.Error("credential or unsupported profile field", field)
			}
		}
		if mode == "lost" {
			w.WriteHeader(500)
			return
		}
		if mode == "bad-receipt" {
			other := profileFixture()
			json.NewEncoder(w).Encode(other)
			return
		}
		json.NewEncoder(w).Encode(row)
	}))
	defer provider.Close()
	s, err := New(testConfig(provider.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", "profile-fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "profile-fixture"})
	cookie := s.sessionCookie(session.Value, session.Expires, 3600).String()
	get := func() *golfv1.Profile {
		r := connect.NewRequest(&golfv1.GetProfileRequest{})
		r.Header().Set("Cookie", cookie)
		p, err := s.GetProfile(ctx, r)
		if err != nil {
			t.Fatal(err)
		}
		return p.Msg.Profile
	}
	update := func(p *golfv1.Profile, name string) (*connect.Response[golfv1.UpdateProfileResponse], error) {
		r := connect.NewRequest(&golfv1.UpdateProfileRequest{UserId: p.UserId, ExpectedRevision: p.Revision, FullName: &name})
		r.Header().Set("Cookie", cookie)
		return s.UpdateProfile(ctx, r)
	}
	before := get()
	after, err := update(before, "Updated profile")
	if err != nil || after.Msg.Profile.FullName != "Updated profile" {
		t.Fatal("supported update", err)
	}
	if _, err := update(before, "Stale"); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatal("stale accepted", err)
	}
	foreign := proto.Clone(after.Msg.Profile).(*golfv1.Profile)
	foreign.UserId = "43"
	if _, err := update(foreign, "Other user"); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatal("foreign target accepted", err)
	}
	mu.Lock()
	if patches != 1 {
		t.Fatal("denied updates dispatched")
	}
	mode = "lost"
	mu.Unlock()
	p := get()
	if _, err := update(p, "Possibly applied"); err == nil {
		t.Fatal("lost receipt reported success")
	}
	mu.Lock()
	if patches != 2 || *row.FullName != "Possibly applied" {
		t.Fatal("unknown update automatically retried")
	}
	mode = ""
	mu.Unlock()
	observed := get()
	if observed.FullName != "Possibly applied" {
		t.Fatal("manual observation lost actual native update")
	}
	mu.Lock()
	identity = 43
	mu.Unlock()
	r := connect.NewRequest(&golfv1.GetProfileRequest{})
	r.Header().Set("Cookie", cookie)
	if _, err := s.GetProfile(ctx, r); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatal("substituted native identity accepted", err)
	}
	mu.Lock()
	identity = 42
	onRead = func() { _ = s.logoutSession(t.Context(), session.Value) }
	mu.Unlock()
	if _, err := update(observed, "Revoked during read"); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatal("revoked during wait accepted", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if patches != 2 {
		t.Fatal("revoked update dispatched")
	}
}
