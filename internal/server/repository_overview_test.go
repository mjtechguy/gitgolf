package server

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
)

func overviewFixtureMetadata() forgeRepositoryOverview {
	topics := []string{"git", "agentic"}
	zero, big := int64(0), int64(9007199254740993)
	return forgeRepositoryOverview{
		Repository: Repository{ID: big, Name: "example", FullName: "alice/example", HTMLURL: "https://forge.invalid/alice/example", Description: "Private description"},
		Website:    "https://example.invalid/docs?view=repo", Topics: &topics, StarsCount: &big, WatchersCount: &zero,
	}
}

func TestRepositoryOverviewMetadata(t *testing.T) {
	row := overviewFixtureMetadata()
	result, err := wireRepositoryOverview(row, row.Repository)
	if err != nil || result.RepositoryId != "9007199254740993" || result.Repository.Owner != "alice" || result.GetStarsCount() != "9007199254740993" ||
		result.WatchersCount == nil || *result.WatchersCount != "0" || result.ForksCount != nil || len(result.Topics) != 2 {
		t.Fatal("exact metadata/unknown versus zero", err)
	}
	for _, website := range []string{"javascript:alert(1)", "//example.invalid", "https://user:secret@example.invalid", "https://example.invalid/\n", strings.Repeat("x", 1025)} {
		row.Website = website
		got, err := wireRepositoryOverview(row, row.Repository)
		if err != nil || got.Website != "" {
			t.Fatal("unsafe website displayed", err)
		}
	}
	for _, mutate := range []func(*forgeRepositoryOverview){
		func(r *forgeRepositoryOverview) { r.ID++ },
		func(r *forgeRepositoryOverview) { r.FullName = "bob/example" },
		func(r *forgeRepositoryOverview) { r.Name = "other" },
		func(r *forgeRepositoryOverview) { r.Description = strings.Repeat("x", 2049) },
		func(r *forgeRepositoryOverview) { r.Topics = nil },
		func(r *forgeRepositoryOverview) { v := []string{strings.Repeat("x", 101)}; r.Topics = &v },
		func(r *forgeRepositoryOverview) {
			v := make([]string, 101)
			for i := range v {
				v[i] = "topic" + strconv.Itoa(i)
			}
			r.Topics = &v
		},
		func(r *forgeRepositoryOverview) { v := []string{"same", "same"}; r.Topics = &v },
		func(r *forgeRepositoryOverview) { v := []string{"bad\x00name"}; r.Topics = &v },
		func(r *forgeRepositoryOverview) { v := int64(-1); r.StarsCount = &v },
	} {
		row := overviewFixtureMetadata()
		expected := row.Repository
		mutate(&row)
		if _, err := wireRepositoryOverview(row, expected); err == nil {
			t.Fatal("malformed overview metadata accepted")
		}
	}
}

func TestRepositoryOverviewLanguages(t *testing.T) {
	for _, input := range []string{`null`, `[]`, `{"Go":-1}`, `{"Go":1.5}`, `{"Go":1e2}`, `{"Go":"5"}`, `{"Go":1,"Go":2}`, `{"Go":9223372036854775808}`, `{"Go":9223372036854775807,"Rust":1}`, `{"":1}`, `{"bad\nname":1}`} {
		var values overviewLanguages
		if json.Unmarshal([]byte(input), &values) == nil {
			t.Fatal("malformed language map accepted", input)
		}
	}
	for _, input := range []string{`{}`, `{"Go":0}`, `{"Go":9007199254740993}`, `{"Go":9223372036854775807}`} {
		var values overviewLanguages
		if err := json.Unmarshal([]byte(input), &values); err != nil {
			t.Fatal("exact byte-count observation rejected", err)
		}
	}
	values := map[string]int64{}
	for i := range 257 {
		values["Language"+strconv.Itoa(i)] = 1
	}
	encoded, _ := json.Marshal(values)
	var tooMany overviewLanguages
	if json.Unmarshal(encoded, &tooMany) == nil {
		t.Fatal("language cardinality bound lost")
	}
}

func TestRepositoryOverviewIndexes(t *testing.T) {
	available := golfv1.RepositoryOverviewSectionState_REPOSITORY_OVERVIEW_SECTION_STATE_AVAILABLE
	unavailable := golfv1.RepositoryOverviewSectionState_REPOSITORY_OVERVIEW_SECTION_STATE_UNAVAILABLE
	failure := golfv1.RepositoryOverviewSectionState_REPOSITORY_OVERVIEW_SECTION_STATE_ERROR
	for _, tc := range []struct {
		name, languages, licenses   string
		status                      int
		languageState, licenseState golfv1.RepositoryOverviewSectionState
	}{
		{"complete", `{"Go":9007199254740993,"Rust":4,"C":4}`, `["MIT"]`, 200, available, available},
		{"empty", `{}`, `[]`, 200, available, available},
		{"denied", `{}`, `[]`, 403, unavailable, available},
		{"missing index", `{}`, `[]`, 404, unavailable, available},
		{"provider failure", `{}`, `[]`, 500, failure, available},
		{"malformed", `{"Go":5,"Go":6}`, `["MIT","MIT"]`, 200, failure, failure},
		{"incomplete", `{"Go":`, `null`, 200, failure, failure},
		{"oversize", strings.Repeat("x", maxForgeResponse+1), `[]`, 200, failure, available},
	} {
		t.Run(tc.name, func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					t.Error("overview issued a native write")
				}
				switch r.URL.Path {
				case "/api/v1/repos/alice/example/languages":
					w.WriteHeader(tc.status)
					w.Write([]byte(tc.languages))
				case "/api/v1/repos/alice/example/licenses":
					w.Write([]byte(tc.licenses))
				default:
					t.Error("overview followed an external URL")
					w.WriteHeader(500)
				}
			}))
			defer provider.Close()
			s, _ := New(testConfig(provider.URL), nil)
			result := &golfv1.GetRepositoryOverviewResponse{}
			err := s.readOverviewIndexes(t.Context(), "/repos/alice/example", forgeCredential{Kind: "pat", Token: "fixture"}, result)
			if err != nil || result.LanguagesState != tc.languageState || result.LicensesState != tc.licenseState {
				t.Fatal("independent index availability", err)
			}
			if tc.languageState != available && len(result.Languages) != 0 || tc.licenseState != available && len(result.LicenseIds) != 0 {
				t.Fatal("failed index leaked partial values")
			}
			if tc.name == "complete" && (len(result.Languages) != 3 || result.Languages[0].ByteCount != "9007199254740993" || result.Languages[1].Name != "C") {
				t.Fatal("complete exact language observation/order lost")
			}
		})
	}
	for _, err := range []error{forgeError{http.StatusUnauthorized}, context.Canceled, context.DeadlineExceeded} {
		if _, fatal := overviewSectionError(err); fatal == nil {
			t.Fatal("authentication/cancellation converted to harmless section state")
		}
	}
}

func TestRepositoryOverviewBoundary(t *testing.T) {
	s, _ := New(testConfig("http://forge.invalid"), nil)
	for _, origin := range []string{s.config.PublicURL, "https://foreign.invalid"} {
		req := httptest.NewRequest("POST", "/rpc"+golfv1connect.RepositoryServiceGetRepositoryOverviewProcedure, strings.NewReader("malformed"))
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		s.ServeHTTP(res, req)
		want := 401
		if origin != s.config.PublicURL {
			want = 403
		}
		if res.Code != want || res.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("overview authentication before decoding", res.Code)
		}
	}
	for _, id := range []string{"", "0", "01", "+1", strconv.FormatUint(math.MaxUint64, 10)} {
		if _, err := s.GetRepositoryOverview(t.Context(), connect.NewRequest(&golfv1.GetRepositoryOverviewRequest{Repository: pullKey, RepositoryId: id})); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("invalid ID reached authentication/native calls", id, err)
		}
	}
}

func TestRepositoryOverviewAuthorityPostgres(t *testing.T) {
	db := testDatabase(t)
	var mode atomic.Value
	mode.Store("")
	var repoReads atomic.Int32
	var denied atomic.Bool
	var onIndex func()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Error("overview native mutation")
		}
		if denied.Load() {
			w.WriteHeader(404)
			return
		}
		switch r.URL.Path {
		case "/api/v1/version":
			json.NewEncoder(w).Encode(map[string]string{"version": "1.27.3"})
		case "/api/v1/user":
			json.NewEncoder(w).Encode(User{ID: 42, Login: "alice"})
		case "/api/v1/repos/alice/example":
			row := overviewFixtureMetadata()
			if repoReads.Add(1) > 2 && mode.Load().(string) == "identity" {
				row.ID++
			}
			json.NewEncoder(w).Encode(row)
		case "/api/v1/repos/alice/example/languages":
			if onIndex != nil {
				onIndex()
			}
			w.Write([]byte(`{"Go":20}`))
		case "/api/v1/repos/alice/example/licenses":
			w.Write([]byte(`["MIT"]`))
		default:
			t.Error("overview unexpected endpoint")
			w.WriteHeader(500)
		}
	}))
	defer provider.Close()
	s, _ := New(testConfig(provider.URL), db)
	session, err := s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", "overview-fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "overview-fixture"})
	request := func(id string) *connect.Request[golfv1.GetRepositoryOverviewRequest] {
		req := connect.NewRequest(&golfv1.GetRepositoryOverviewRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: id})
		req.Header().Set("Cookie", s.sessionCookie(session.Value, session.Expires, 3600).String())
		return req
	}
	res, err := s.GetRepositoryOverview(ctx, request("9007199254740993"))
	if err != nil || res.Msg.RepositoryId != "9007199254740993" || len(res.Msg.Languages) != 1 {
		t.Fatal("authorized overview", err)
	}
	// Actual bearer read delegation reaches the same identity/authority guards.
	grant := connect.NewRequest(&golfv1.CreateApiCredentialRequest{Label: "overview"})
	grant.Header().Set("Cookie", request("9007199254740993").Header().Get("Cookie"))
	issued, err := s.CreateApiCredential(ctx, grant)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := protojson.Marshal(request("9007199254740993").Msg)
	if response := apiRequest(s, issued.Msg.Token, golfv1connect.RepositoryServiceGetRepositoryOverviewProcedure, string(body)); response.Code != 200 {
		t.Fatal("bounded bearer overview denied", response.Code)
	}
	if response := apiRequest(s, issued.Msg.Token, golfv1connect.RepositoryServiceCreateRepositoryProcedure, `{}`); response.Code != 403 {
		t.Fatal("overview read delegation granted writes")
	}
	if _, err = s.GetRepositoryOverview(ctx, request("11")); err == nil {
		t.Fatal("wrong native identity admitted")
	}
	repoReads.Store(0)
	mode.Store("identity")
	if res, err = s.GetRepositoryOverview(ctx, request("9007199254740993")); err == nil || res != nil {
		t.Fatal("post-read repository replacement disclosed metadata")
	}
	mode.Store("")
	canceled, cancel := context.WithCancel(ctx)
	onIndex = cancel
	if res, err = s.GetRepositoryOverview(canceled, request("9007199254740993")); err == nil || res != nil {
		t.Fatal("canceled index read disclosed overview")
	}
	onIndex = nil
	for _, revoke := range []string{"native", "local"} {
		onIndex = func() {
			if revoke == "native" {
				denied.Store(true)
			} else if err := s.logoutSession(t.Context(), session.Value); err != nil {
				t.Error(err)
			}
		}
		if res, err = s.GetRepositoryOverview(ctx, request("9007199254740993")); err == nil || res != nil {
			t.Fatal("post-wait revocation disclosed overview", revoke)
		}
		denied.Store(false)
	}
}
