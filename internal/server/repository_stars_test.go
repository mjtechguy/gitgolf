package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/encoding/protojson"
)

func starFixtureRow() forgeStarRepository {
	zero := int64(0)
	return forgeStarRepository{Repository: Repository{ID: 11, Name: "private", FullName: "alice/private"}, Owner: &User{ID: 9007199254740993, Login: "alice"}, StarsCount: &zero}
}
func TestRepositoryStarsProjection(t *testing.T) {
	row := starFixtureRow()
	if err := validateStarRepository(row, repositoryKey{"alice", "private"}, 11); err != nil {
		t.Fatal(err)
	}
	got := wireRepositoryStar(row, User{ID: 9007199254740995}, false)
	if got.OwnerId != "9007199254740993" || got.NativeUserId != "9007199254740995" || got.Starred == nil || *got.Starred || got.StarsCount == nil || *got.StarsCount != "0" {
		t.Fatal("lost exact identity or false/zero presence")
	}
	raw, _ := protojson.Marshal(got)
	if !strings.Contains(string(raw), `"starred":false`) {
		t.Fatal("false receipt absent")
	}
	row.StarsCount = nil
	if wireRepositoryStar(row, User{ID: 42}, true).StarsCount != nil {
		t.Fatal("unknown count fabricated")
	}
	for i, change := range []func(*forgeStarRepository){
		func(r *forgeStarRepository) { r.ID++ }, func(r *forgeStarRepository) { r.Owner = nil },
		func(r *forgeStarRepository) { r.Owner.ID = 0 }, func(r *forgeStarRepository) { r.Owner.Login = "bob" },
		func(r *forgeStarRepository) { r.Name = "replacement" }, func(r *forgeStarRepository) { r.FullName = "alice/private/extra" },
		func(r *forgeStarRepository) { n := int64(-1); r.StarsCount = &n },
	} {
		t.Run(strconv.Itoa(i), func(t *testing.T) {
			r := starFixtureRow()
			change(&r)
			if validateStarRepository(r, repositoryKey{"alice", "private"}, 11) == nil {
				t.Fatal("malformed identity/count accepted")
			}
		})
	}
}
func TestRepositoryStarsStrictNativeStatus(t *testing.T) {
	for _, status := range []int{204, 404, 200, 201, 401, 403, 500, 302} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/api/v1/user/starred/alice/private" {
					t.Error("unexpected preference request")
				}
				w.Header().Set("Location", "/api/v1/user/starred/alice/private")
				w.WriteHeader(status)
			}))
			defer provider.Close()
			s, err := New(testConfig(provider.URL), nil)
			if err != nil {
				t.Fatal(err)
			}
			got, err := s.readRepositoryStar(t.Context(), forgeCredential{Kind: "pat", Token: "star-fixture"}, repositoryKey{"alice", "private"})
			if status == 204 || status == 404 {
				if err != nil || got != (status == 204) {
					t.Fatal("strict status", err)
				}
			} else if err == nil {
				t.Fatal("unexpected status became preference")
			}
		})
	}
}
func TestRepositoryStarsRequestAndUncertainty(t *testing.T) {
	s, _ := New(testConfig("http://forge.invalid"), nil)
	for _, id := range []string{"", "0", "01", "+1", "9223372036854775808"} {
		if _, err := s.GetRepositoryStar(t.Context(), connect.NewRequest(&golfv1.GetRepositoryStarRequest{Repository: pullKey, RepositoryId: id})); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("invalid target reached authority", err)
		}
	}
	request := &golfv1.SetRepositoryStarRequest{Repository: pullKey, RepositoryId: "11", OwnerId: "42", NativeUserId: "42"}
	if _, err := s.SetRepositoryStar(t.Context(), connect.NewRequest(request)); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatal("absent desired state", err)
	}
	value := false
	request.Starred = &value
	ctx := context.WithValue(t.Context(), apiAuthKey{}, apiAuth{})
	if _, err := s.SetRepositoryStar(ctx, connect.NewRequest(request)); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatal("delegated bearer wrote preference", err)
	}
	if err := repositoryStarError(errors.New("private provider credential"), true); connect.CodeOf(err) != connect.CodeUnavailable || strings.Contains(err.Error(), "credential") {
		t.Fatal("uncertainty leaked provider error")
	}
	if connect.CodeOf(repositoryStarError(errRepositoryStarUnavailable, false)) != connect.CodeFailedPrecondition || connect.CodeOf(repositoryStarError(errRepositoryStarUnavailable, true)) != connect.CodeUnavailable {
		t.Fatal("optional unavailability became repository denial or write certainty")
	}
	for _, err := range []error{errUnauthenticated, forgeError{status: 403}, forgeError{status: 404}} {
		if connect.CodeOf(repositoryStarError(err, true)) != connect.CodeOf(rpcError(err)) {
			t.Fatal("privacy denial lost")
		}
	}
}

// Authored owned-DB tests; a supported-native HTTP fixture, not live provider evidence.
func TestRepositoryStarsAuthorityPostgres(t *testing.T) {
	db := testDatabase(t)
	var mu sync.Mutex
	mode := ""
	observed := false
	starred := false
	writes := 0
	var onRead func()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/version":
			json.NewEncoder(w).Encode(map[string]string{"version": "1.27.3"})
		case "/api/v1/user":
			id := int64(42)
			if observed && (mode == "actor" || mode == "disabled-actor") {
				id++
			}
			json.NewEncoder(w).Encode(User{ID: id, Login: "reader"})
		case "/api/v1/repos/alice/private":
			if observed && (mode == "denied" || mode == "disabled-denied") {
				w.WriteHeader(404)
				return
			}
			row := starFixtureRow()
			if observed && mode == "replacement" {
				row.ID++
			}
			if observed && mode == "owner" {
				row.Owner.ID++
			}
			count := int64(9)
			if starred {
				count++
			}
			row.StarsCount = &count
			json.NewEncoder(w).Encode(row)
		case "/api/v1/user/starred/alice/private":
			if r.Method == http.MethodPut || r.Method == http.MethodDelete {
				writes++
				starred = r.Method == http.MethodPut
				if mode == "lost-ack" {
					w.WriteHeader(500)
					return
				}
				w.WriteHeader(204)
				return
			}
			if r.Method != http.MethodGet {
				t.Error("unexpected mutation")
				w.WriteHeader(500)
				return
			}
			observed = true
			if onRead != nil {
				callback := onRead
				onRead = nil
				mu.Unlock()
				callback()
				mu.Lock()
			}
			if strings.HasPrefix(mode, "disabled") {
				w.WriteHeader(403)
				return
			}
			if starred {
				w.WriteHeader(204)
			} else {
				w.WriteHeader(404)
			}
		default:
			t.Error("unexpected star endpoint")
			w.WriteHeader(500)
		}
	}))
	defer provider.Close()
	s, err := New(testConfig(provider.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "star-fixture"})
	newCookie := func() string {
		session, err := s.createSession(t.Context(), User{ID: 42, Login: "reader"}, "pat", "star-fixture", "")
		if err != nil {
			t.Fatal(err)
		}
		return s.sessionCookie(session.Value, session.Expires, 3600).String()
	}
	get := func(cookie string) (*connect.Response[golfv1.GetRepositoryStarResponse], error) {
		request := connect.NewRequest(&golfv1.GetRepositoryStarRequest{Repository: pullKey, RepositoryId: "11"})
		request.Header().Set("Cookie", cookie)
		return s.GetRepositoryStar(ctx, request)
	}
	set := func(cookie string, desired bool, owner, actor string) (*connect.Response[golfv1.SetRepositoryStarResponse], error) {
		request := connect.NewRequest(&golfv1.SetRepositoryStarRequest{Repository: pullKey, RepositoryId: "11", OwnerId: owner, NativeUserId: actor, Starred: &desired})
		request.Header().Set("Cookie", cookie)
		return s.SetRepositoryStar(ctx, request)
	}
	for _, testMode := range []string{"", "denied", "replacement", "owner", "actor", "disabled", "logout", "lost-ack"} {
		t.Run(testMode, func(t *testing.T) {
			mu.Lock()
			mode = testMode
			observed = false
			starred = false
			writes = 0
			onRead = nil
			mu.Unlock()
			cookie := newCookie()
			if testMode == "logout" {
				mu.Lock()
				onRead = func() {
					request := connect.NewRequest(&golfv1.LogoutRequest{})
					request.Header().Set("Cookie", cookie)
					if _, err := s.Logout(ctx, request); err != nil {
						t.Error(err)
					}
				}
				mu.Unlock()
			}
			got, err := set(cookie, true, "9007199254740993", "42")
			mu.Lock()
			count := writes
			mu.Unlock()
			if count != 1 {
				t.Fatal("desired change was retried or skipped")
			}
			if testMode == "" {
				if err != nil || got.Msg.Preference.Starred == nil || !*got.Msg.Preference.Starred || *got.Msg.Preference.StarsCount != "10" {
					t.Fatal("reader own preference", err)
				}
				got, err = set(cookie, false, "9007199254740993", "42")
				if err != nil || got.Msg.Preference.GetStarred() || *got.Msg.Preference.StarsCount != "9" {
					t.Fatal("unstar readback", err)
				}
			} else if err == nil || got != nil {
				t.Fatal("late denial/uncertainty leaked preference")
			}
			if testMode == "lost-ack" {
				if connect.CodeOf(err) != connect.CodeUnavailable {
					t.Fatal("lost acknowledgement certainty", err)
				}
				mu.Lock()
				mode = ""
				observed = false
				mu.Unlock()
				// Explicit current observation after a new server instance never repeats the write.
				s, err = New(testConfig(provider.URL), db)
				if err != nil {
					t.Fatal(err)
				}
				current, err := get(cookie)
				mu.Lock()
				count = writes
				mu.Unlock()
				if err != nil || !current.Msg.Preference.GetStarred() || count != 1 {
					t.Fatal("current read replayed/attributed write", err)
				}
			}
		})
	}
	mu.Lock()
	mode = ""
	observed = false
	starred = false
	writes = 0
	mu.Unlock()
	cookie := newCookie()
	for _, ids := range [][2]string{{"9007199254740994", "42"}, {"9007199254740993", "43"}} {
		if got, err := set(cookie, true, ids[0], ids[1]); err == nil || got != nil {
			t.Fatal("wrong original identity accepted")
		}
	}
	mu.Lock()
	count := writes
	mu.Unlock()
	if count != 0 {
		t.Fatal("wrong identity reached preference mutation")
	}
	current, err := get(cookie)
	if err != nil || current.Msg.Preference.Starred == nil || current.Msg.Preference.GetStarred() {
		t.Fatal("authorized false preference", err)
	}
	for _, testMode := range []string{"disabled", "disabled-denied", "disabled-actor", "disabled-logout"} {
		t.Run("read-"+testMode, func(t *testing.T) {
			mu.Lock()
			mode, observed, starred, writes, onRead = testMode, false, false, 0, nil
			mu.Unlock()
			cookie := newCookie()
			if testMode == "disabled-logout" {
				mu.Lock()
				onRead = func() {
					request := connect.NewRequest(&golfv1.LogoutRequest{})
					request.Header().Set("Cookie", cookie)
					if _, err := s.Logout(ctx, request); err != nil {
						t.Error(err)
					}
				}
				mu.Unlock()
			}
			got, err := get(cookie)
			if err == nil || got != nil {
				t.Fatal("unavailable preference fabricated a state")
			}
			expected := connect.CodeUnauthenticated
			if testMode == "disabled" {
				expected = connect.CodeFailedPrecondition
			}
			if testMode == "disabled-denied" {
				expected = connect.CodeNotFound
			}
			if connect.CodeOf(err) != expected {
				t.Fatal("optional failure hid late authority fence", err)
			}
			if testMode == "disabled" {
				request := connect.NewRequest(&golfv1.GetRepositoryRequest{Repository: pullKey})
				request.Header().Set("Cookie", cookie)
				if repository, err := s.GetRepository(ctx, request); err != nil || repository.Msg.Repository.Id != "11" {
					t.Fatal("optional preference failure blocked repository browsing", err)
				}
			}
			mu.Lock()
			count := writes
			mu.Unlock()
			if count != 0 {
				t.Fatal("optional inspection wrote native state")
			}
		})
	}
}
