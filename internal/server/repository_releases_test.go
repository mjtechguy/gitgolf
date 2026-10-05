package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/encoding/protojson"
)

func releaseFixtureRow() forgeRepositoryRelease {
	yes, no := true, false
	zero, big := int64(0), int64(9007199254740993)
	return forgeRepositoryRelease{ID: big, Title: "Release α", TagName: "release/α", TargetCommitish: "main", Body: "Literal ${{ example }} notes\n", Draft: &yes, Prerelease: &no, CreatedAt: "2026-10-04T10:00:00Z", PublishedAt: "2026-10-04T10:00:00Z", Author: &User{ID: 42, Login: "alice"}, Assets: []forgeReleaseAsset{{ID: big, Name: "literal%.zip", Size: &big, DownloadCount: &zero, CreatedAt: "2026-10-04T10:00:00Z"}}}
}
func TestRepositoryReleasesProjection(t *testing.T) {
	row := releaseFixtureRow()
	got, err := wireRepositoryRelease(row)
	if err != nil || got.Id != "9007199254740993" || got.Assets[0].SizeBytes != "9007199254740993" || got.Assets[0].DownloadCount != "0" || !got.Draft || got.AssetCount != "1" || got.BodyMarkdown != row.Body {
		t.Fatal("exact release metadata", err)
	}
	raw, _ := protojson.Marshal(got)
	for _, forbidden := range []string{"downloadUrl", "browserDownloadUrl", "uuid", "email", "tarball", "zipball"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatal("asset or private authority leaked")
		}
	}
	// Provider URL fields are deliberately outside the decoded and wire shapes.
	encoded, _ := json.Marshal(row)
	var source map[string]any
	if err := json.Unmarshal(encoded, &source); err != nil {
		t.Fatal(err)
	}
	source["url"] = "https://private.invalid/release"
	asset := source["assets"].([]any)[0].(map[string]any)
	asset["uuid"] = "private-secret"
	asset["browser_download_url"] = "https://private.invalid/secret"
	// Retain exact int64 JSON bytes; generic decoding would round the large ID.
	source["id"] = json.Number("9007199254740993")
	asset["id"] = json.Number("9007199254740993")
	asset["size"] = json.Number("9007199254740993")
	encoded, _ = json.Marshal(source)
	var native forgeRepositoryRelease
	if err := json.Unmarshal(encoded, &native); err != nil {
		t.Fatal(err)
	}
	projected, err := wireRepositoryRelease(native)
	if err != nil {
		t.Fatal(err)
	}
	projectedJSON, _ := protojson.Marshal(projected)
	if strings.Contains(string(projectedJSON), "private.invalid") || strings.Contains(string(projectedJSON), "private-secret") {
		t.Fatal("provider URLs exposed")
	}
	row.Author = &User{ID: -1}
	row.Assets = []forgeReleaseAsset{}
	got, err = wireRepositoryRelease(row)
	if err != nil || got.Author != nil || got.AssetCount != "0" {
		t.Fatal("ghost/empty metadata", err)
	}
}
func TestRepositoryReleasesMalformedMetadata(t *testing.T) {
	for i, mutate := range []func(*forgeRepositoryRelease){
		func(r *forgeRepositoryRelease) { r.ID = 0 }, func(r *forgeRepositoryRelease) { r.Title = "bad\x00" }, func(r *forgeRepositoryRelease) { r.Title = strings.Repeat("x", 1025) },
		func(r *forgeRepositoryRelease) { r.TagName = "" }, func(r *forgeRepositoryRelease) { r.TagName = "bad..ref" }, func(r *forgeRepositoryRelease) { r.TargetCommitish = "bad\nref" },
		func(r *forgeRepositoryRelease) { r.Body = strings.Repeat("x", (128<<10)+1) }, func(r *forgeRepositoryRelease) { r.Draft = nil }, func(r *forgeRepositoryRelease) { r.Prerelease = nil },
		func(r *forgeRepositoryRelease) { r.CreatedAt = "" }, func(r *forgeRepositoryRelease) { r.PublishedAt = "invalid" }, func(r *forgeRepositoryRelease) { r.Author = &User{ID: 0, Login: "alice"} },
		func(r *forgeRepositoryRelease) { r.Assets = nil }, func(r *forgeRepositoryRelease) { r.Assets = append(r.Assets, r.Assets[0]) },
		func(r *forgeRepositoryRelease) { r.Assets[0].ID = 0 }, func(r *forgeRepositoryRelease) { r.Assets[0].Name = "" }, func(r *forgeRepositoryRelease) { r.Assets[0].Size = nil },
		func(r *forgeRepositoryRelease) { n := int64(-1); r.Assets[0].Size = &n }, func(r *forgeRepositoryRelease) { r.Assets[0].DownloadCount = nil }, func(r *forgeRepositoryRelease) { r.Assets[0].CreatedAt = "" },
	} {
		t.Run(strconv.Itoa(i), func(t *testing.T) {
			row := releaseFixtureRow()
			mutate(&row)
			if _, err := wireRepositoryRelease(row); err == nil {
				t.Fatal("malformed release accepted")
			}
		})
	}
}
func TestRepositoryReleasesPagination(t *testing.T) {
	header := func(value string) http.Header { return http.Header{"X-Total-Count": []string{value}} }
	row := releaseFixtureRow()
	rows, total, next, err := repositoryReleasePage([]forgeRepositoryRelease{row}, header("2"), 1, 1)
	if err != nil || len(rows) != 1 || total != "2" || next != 2 {
		t.Fatal("next page", err)
	}
	if _, _, next, err := repositoryReleasePage([]forgeRepositoryRelease{}, header("2"), 3, 1); err != nil || next != 0 {
		t.Fatal("past last page", err)
	}
	for _, tc := range []struct {
		rows        []forgeRepositoryRelease
		headers     http.Header
		page, limit uint32
	}{
		{nil, header("0"), 1, 20}, {[]forgeRepositoryRelease{}, header("1"), 1, 20}, {[]forgeRepositoryRelease{row}, header("0"), 1, 20},
		{[]forgeRepositoryRelease{row}, header("01"), 1, 20}, {[]forgeRepositoryRelease{row}, header("9223372036854775808"), 1, 20},
		{[]forgeRepositoryRelease{row}, http.Header{"X-Total-Count": []string{"1", "1"}}, 1, 20},
		{[]forgeRepositoryRelease{row, row}, header("2"), 1, 20}, {[]forgeRepositoryRelease{row}, header("10001"), 10000, 1},
		{[]forgeRepositoryRelease{row}, header("1"), 1, 51},
	} {
		if _, _, _, err := repositoryReleasePage(tc.rows, tc.headers, tc.page, tc.limit); err == nil {
			t.Fatal("inconsistent inventory accepted")
		}
	}
	rowsNative := make([]forgeRepositoryRelease, 5)
	for i := range rowsNative {
		rowsNative[i] = releaseFixtureRow()
		rowsNative[i].ID = int64(i + 1)
		rowsNative[i].Assets = []forgeReleaseAsset{}
		rowsNative[i].Body = strings.Repeat("x", 128<<10)
	}
	if _, _, _, err := repositoryReleasePage(rowsNative, header("5"), 1, 20); err == nil {
		t.Fatal("aggregate notes bound lost")
	}
	rowsNative[0].Body = ""
	rowsNative[1].Body = ""
	rowsNative[2].Body = ""
	rowsNative[3].Body = ""
	rowsNative[4].Body = ""
	rowsNative[0].Assets = releaseFixtureRow().Assets
	rowsNative[1].Assets = releaseFixtureRow().Assets
	if _, _, _, err := repositoryReleasePage(rowsNative, header("5"), 1, 20); err == nil {
		t.Fatal("cross-release duplicate attachment accepted")
	}
}
func TestRepositoryReleasesAssetBounds(t *testing.T) {
	rows := make([]forgeRepositoryRelease, 6)
	for i := range rows {
		rows[i] = releaseFixtureRow()
		rows[i].ID = int64(i + 1)
		rows[i].Assets = make([]forgeReleaseAsset, 100)
		for j := range rows[i].Assets {
			rows[i].Assets[j] = releaseFixtureRow().Assets[0]
			rows[i].Assets[j].ID = int64(i*100 + j + 1)
		}
	}
	if _, _, _, err := repositoryReleasePage(rows[:5], http.Header{"X-Total-Count": []string{"5"}}, 1, 20); err != nil {
		t.Fatal("bounded full page", err)
	}
	if _, _, _, err := repositoryReleasePage(rows, http.Header{"X-Total-Count": []string{"6"}}, 1, 20); err == nil {
		t.Fatal("aggregate asset bound lost")
	}
	rows[0].Assets = append(rows[0].Assets, rows[1].Assets[0])
	if _, err := wireRepositoryRelease(rows[0]); err == nil {
		t.Fatal("per-release bound lost")
	}
}

func TestRepositoryReleasesRequestValidation(t *testing.T) {
	s, _ := New(testConfig("http://forge.invalid"), nil)
	for _, id := range []string{"", "0", "01", "+1", "9223372036854775808"} {
		if _, err := s.ListRepositoryReleases(t.Context(), connect.NewRequest(&golfv1.ListRepositoryReleasesRequest{Repository: pullKey, RepositoryId: id})); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("invalid target reached provider", err)
		}
		if _, err := s.GetRepositoryRelease(t.Context(), connect.NewRequest(&golfv1.GetRepositoryReleaseRequest{Repository: pullKey, RepositoryId: "11", ReleaseId: id})); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatal("invalid release reached provider", err)
		}
	}
	if _, err := s.ListRepositoryReleases(t.Context(), connect.NewRequest(&golfv1.ListRepositoryReleasesRequest{Repository: pullKey, RepositoryId: "11", Page: &golfv1.PageRequest{Limit: 51}})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatal("page limit reached provider", err)
	}
}

// Authored source-DB qualification. No native mutation or asset download occurs.
func TestRepositoryReleasesAuthorityPostgres(t *testing.T) {
	db := testDatabase(t)
	mode := ""
	observed := false
	reads := 0
	var onRead func()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Error("release read mutated native state")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/version":
			json.NewEncoder(w).Encode(map[string]string{"version": "1.27.3"})
		case "/api/v1/user":
			id := int64(42)
			if observed && mode == "actor" {
				id++
			}
			json.NewEncoder(w).Encode(User{ID: id, Login: "alice"})
		case "/api/v1/settings/api":
			json.NewEncoder(w).Encode(map[string]int{"max_response_items": 2})
		case "/api/v1/repos/alice/private":
			if observed && mode == "denied" {
				w.WriteHeader(404)
				return
			}
			id := int64(11)
			if observed && mode == "replacement" {
				id++
			}
			json.NewEncoder(w).Encode(Repository{ID: id, Name: "private", FullName: "alice/private", HTMLURL: "https://forge.invalid/alice/private"})
		case "/api/v1/repos/alice/private/releases", "/api/v1/repos/alice/private/releases/9007199254740993":
			reads++
			observed = true
			if onRead != nil {
				onRead()
			}
			row := releaseFixtureRow()
			if mode == "wrong-release" {
				row.ID++
			}
			if strings.HasSuffix(r.URL.Path, "/releases") {
				if r.URL.Query().Get("limit") != "2" {
					t.Error("native page cap ignored")
				}
				w.Header().Set("X-Total-Count", "1")
				json.NewEncoder(w).Encode([]forgeRepositoryRelease{row})
			} else {
				json.NewEncoder(w).Encode(row)
			}
		default:
			t.Error("unexpected release endpoint")
			w.WriteHeader(500)
		}
	}))
	defer provider.Close()
	s, err := New(testConfig(provider.URL), db)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Kind: "pat", Token: "release-fixture"})
	for _, testMode := range []string{"", "denied", "replacement", "actor", "logout", "wrong-release"} {
		t.Run(testMode, func(t *testing.T) {
			mode = testMode
			observed = false
			onRead = nil
			session, err := s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", "release-fixture", "")
			if err != nil {
				t.Fatal(err)
			}
			cookie := s.sessionCookie(session.Value, session.Expires, 3600).String()
			if mode == "logout" {
				onRead = func() {
					request := connect.NewRequest(&golfv1.LogoutRequest{})
					request.Header().Set("Cookie", cookie)
					if _, err := s.Logout(ctx, request); err != nil {
						t.Fatal(err)
					}
				}
			}
			request := connect.NewRequest(&golfv1.GetRepositoryReleaseRequest{Repository: pullKey, RepositoryId: "11", ReleaseId: "9007199254740993"})
			request.Header().Set("Cookie", cookie)
			got, err := s.GetRepositoryRelease(ctx, request)
			if testMode == "" {
				if err != nil || got.Msg.Release.Id != "9007199254740993" {
					t.Fatal("authorized detail", err)
				}
			} else if err == nil || got != nil {
				t.Fatal("late denial leaked release")
			}
		})
	}
	mode = ""
	observed = false
	onRead = nil
	session, err := s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", "release-fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	request := connect.NewRequest(&golfv1.ListRepositoryReleasesRequest{Repository: pullKey, RepositoryId: "11", Page: &golfv1.PageRequest{Limit: 50}})
	request.Header().Set("Cookie", s.sessionCookie(session.Value, session.Expires, 3600).String())
	got, err := s.ListRepositoryReleases(ctx, request)
	if err != nil || got.Msg.TotalCount != "1" || len(got.Msg.Releases) != 1 {
		t.Fatal("authorized bounded list", err)
	}
	observed = false
	before := reads
	request.Msg.RepositoryId = "12"
	if got, err := s.ListRepositoryReleases(ctx, request); err == nil || got != nil || reads != before {
		t.Fatal("wrong repository accessed releases")
	}
}
