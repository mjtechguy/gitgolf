package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
)

func environmentTestPolicy() *golfv1.RepositoryEnvironmentPolicy {
	return &golfv1.RepositoryEnvironmentPolicy{AllowAllSources: true, PreventSelfApproval: true, ProtectedPreviews: true, MaxConcurrency: 1, PreviewTtlSeconds: 3600}
}
func TestEnvironmentPolicyAndIntent(t *testing.T) {
	if e := validateEnvironmentPolicy(environmentTestPolicy()); e != nil {
		t.Fatal(e)
	}
	for name, change := range map[string]func(*golfv1.RepositoryEnvironmentPolicy){
		"self approval":   func(p *golfv1.RepositoryEnvironmentPolicy) { p.PreventSelfApproval = false },
		"bypass":          func(p *golfv1.RepositoryEnvironmentPolicy) { p.AllowAdminBypass = true },
		"public preview":  func(p *golfv1.RepositoryEnvironmentPolicy) { p.ProtectedPreviews = false },
		"unknown sources": func(p *golfv1.RepositoryEnvironmentPolicy) { p.AllowAllSources = false },
		"all plus selectors": func(p *golfv1.RepositoryEnvironmentPolicy) {
			p.Sources = []*golfv1.RepositorySourceSelector{{Kind: 2, Name: "main"}}
		},
		"default source": func(p *golfv1.RepositoryEnvironmentPolicy) {
			p.AllowAllSources = false
			p.Sources = []*golfv1.RepositorySourceSelector{{Kind: 1}}
		},
		"glob": func(p *golfv1.RepositoryEnvironmentPolicy) {
			p.AllowAllSources = false
			p.Sources = []*golfv1.RepositorySourceSelector{{Kind: 2, Name: "release/*"}}
		},
		"partial commit": func(p *golfv1.RepositoryEnvironmentPolicy) {
			p.AllowAllSources = false
			p.Sources = []*golfv1.RepositorySourceSelector{{Kind: 4, Name: "abcd"}}
		},
		"duplicate ref": func(p *golfv1.RepositoryEnvironmentPolicy) {
			p.AllowAllSources = false
			p.Sources = []*golfv1.RepositorySourceSelector{{Kind: 2, Name: "main"}, {Kind: 2, Name: "main"}}
		},
		"duplicate identity": func(p *golfv1.RepositoryEnvironmentPolicy) {
			p.RequiredApprovals = 1
			p.Reviewers = []*golfv1.RepositoryEnvironmentReviewer{{Id: "42", Login: "alice"}, {Id: "42", Login: "bob"}}
		},
		"duplicate login": func(p *golfv1.RepositoryEnvironmentPolicy) {
			p.RequiredApprovals = 1
			p.Reviewers = []*golfv1.RepositoryEnvironmentReviewer{{Id: "42", Login: "Alice"}, {Id: "43", Login: "alice"}}
		},
		"unneeded reviewers": func(p *golfv1.RepositoryEnvironmentPolicy) {
			p.Reviewers = []*golfv1.RepositoryEnvironmentReviewer{{Id: "42", Login: "alice"}}
		},
		"too many approvals": func(p *golfv1.RepositoryEnvironmentPolicy) { p.RequiredApprovals = 1 },
		"wait":               func(p *golfv1.RepositoryEnvironmentPolicy) { p.WaitSeconds = 86401 },
		"concurrency":        func(p *golfv1.RepositoryEnvironmentPolicy) { p.MaxConcurrency = 11 },
		"ttl":                func(p *golfv1.RepositoryEnvironmentPolicy) { p.PreviewTtlSeconds = 59 },
		"unknown field":      func(p *golfv1.RepositoryEnvironmentPolicy) { p.ProtoReflect().SetUnknown([]byte{0xa0, 0x06, 0x01}) },
	} {
		t.Run(name, func(t *testing.T) {
			p := environmentTestPolicy()
			change(p)
			if e := validateEnvironmentPolicy(p); e == nil {
				t.Fatal("unsupported policy accepted")
			}
		})
	}
	exact := environmentTestPolicy()
	exact.AllowAllSources = false
	exact.Sources = []*golfv1.RepositorySourceSelector{{Kind: 2, Name: "feature/a%25"}, {Kind: 3, Name: "feature/a%25"}, {Kind: 4, Name: strings.Repeat("a", 64)}}
	if e := validateEnvironmentPolicy(exact); e != nil {
		t.Fatal("literal distinct namespaces", e)
	}
	for _, name := range []string{"", " leading", "trailing ", "x\n", strings.Repeat("ü", 65), string([]byte{255})} {
		if validateEnvironmentName(name) == nil {
			t.Fatal("invalid name", name)
		}
	}
	if validateEnvironmentName("Preview ü / team") != nil {
		t.Fatal("literal unicode name")
	}
	m := &golfv1.SaveRepositoryEnvironmentRequest{Target: &golfv1.RepositoryEnvironmentTarget{RepositoryId: "42"}, EnvironmentId: uuid.NewString(), OperationId: uuid.NewString(), ExpectedVersion: "0", Name: "Preview", Policy: exact, CurrentPassword: "private-password"}
	fp, e := environmentFingerprint(m)
	if e != nil {
		t.Fatal(e)
	}
	changed := proto.Clone(m).(*golfv1.SaveRepositoryEnvironmentRequest)
	changed.CurrentPassword = "different-private-password"
	other, _ := environmentFingerprint(changed)
	if !bytes.Equal(fp, other) {
		t.Fatal("password entered retained intent")
	}
	changed.Policy.Sources[0], changed.Policy.Sources[1] = changed.Policy.Sources[1], changed.Policy.Sources[0]
	other, _ = environmentFingerprint(changed)
	if bytes.Equal(fp, other) {
		t.Fatal("ordered accepted selectors silently normalized")
	}
	changed = proto.Clone(m).(*golfv1.SaveRepositoryEnvironmentRequest)
	changed.Name = "preview"
	other, _ = environmentFingerprint(changed)
	if bytes.Equal(fp, other) {
		t.Fatal("changed request accepted as replay")
	}
}
func TestEnvironmentHistoricalReceipt(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Microsecond)
	raw, _ := proto.Marshal(environmentTestPolicy())
	v := database.GolfRepositoryEnvironmentVersion{EnvironmentID: uuid.New(), RepositoryID: 42, OwnerID: 7, Version: 2, Name: "Preview", Policy: raw, CreatorNativeID: 7, ActorNativeID: 8, ActorUserID: 3, EnvironmentCreatedAt: now.Add(-time.Hour), CreatedAt: now, RepositoryOwner: "owner", RepositoryName: "repo", AccessRevision: strings.Repeat("a", 64)}
	op := database.GolfRepositoryEnvironmentOperation{OperationID: uuid.New(), EnvironmentID: v.EnvironmentID, RepositoryID: 42, OwnerID: 7, UserID: 3, Version: 2, ExpectedVersion: 1, Action: "save", CreatedAt: now}
	receipt, env, e := wireEnvironmentOperation(op, v)
	if e != nil || receipt.State != "SUCCEEDED" || env.DeploymentAvailable || env.Capability != 1 || env.CreatorId != "7" || env.UpdaterId != "8" {
		t.Fatal("configuration receipt", e)
	}
	for _, change := range []func(*database.GolfRepositoryEnvironmentOperation){func(o *database.GolfRepositoryEnvironmentOperation) { o.OwnerID++ }, func(o *database.GolfRepositoryEnvironmentOperation) { o.EnvironmentID = uuid.New() }, func(o *database.GolfRepositoryEnvironmentOperation) { o.Action = "delete" }, func(o *database.GolfRepositoryEnvironmentOperation) { o.UserID++ }, func(o *database.GolfRepositoryEnvironmentOperation) { o.CreatedAt = o.CreatedAt.Add(time.Second) }} {
		bad := op
		change(&bad)
		if _, _, e := wireEnvironmentOperation(bad, v); e == nil {
			t.Fatal("unbound receipt")
		}
	}
}
func TestEnvironmentManagedBoundary(t *testing.T) {
	s, e := New(testConfig("http://forge.invalid"), nil)
	if e != nil {
		t.Fatal(e)
	}
	ctx := context.WithValue(t.Context(), sessionTokenKey{}, forgeCredential{Token: "never-used"})
	for _, headers := range []http.Header{{"Origin": []string{"https://other.invalid"}}, {"Origin": []string{s.config.PublicURL}, "Authorization": []string{"Bearer not-browser"}}, {"Origin": []string{s.config.PublicURL}, "Sec-Fetch-Site": []string{"cross-site"}}} {
		req := connect.NewRequest(&golfv1.ListRepositoryEnvironmentsRequest{})
		req.Header().Set("Cookie", cookieName+"=fixture")
		for k, v := range headers {
			req.Header()[k] = v
		}
		if _, e = s.ListRepositoryEnvironments(ctx, req); connect.CodeOf(e) != connect.CodePermissionDenied {
			t.Fatal("unsafe origin/credential reached configuration", e)
		}
	}
}
func environmentRequest[T any](f *workflowRunFixture, l loginResult, m *T) (*connect.Request[T], context.Context) {
	r, c := runnerControlRequest(f.server, l, m)
	r.Header().Set("Origin", f.server.config.PublicURL)
	return r, c
}
func environmentFixture(t *testing.T) (*workflowRunFixture, loginResult, *golfv1.RepositoryEnvironmentTarget) {
	f, l := runnerPoolLocalFixture(t)
	a := runnerPlacementFixture(t, f, l)
	return f, l, &golfv1.RepositoryEnvironmentTarget{Repository: a.Repository, RepositoryId: a.RepositoryId, OwnerId: a.OwnerId, AccessRevision: a.ExpectedRevision}
}
func environmentSave(t *testing.T, f *workflowRunFixture, l loginResult, m *golfv1.SaveRepositoryEnvironmentRequest) (*golfv1.SaveRepositoryEnvironmentResponse, error) {
	t.Helper()
	r, c := environmentRequest(f, l, m)
	w, e := f.server.SaveRepositoryEnvironment(c, r)
	if e != nil {
		return nil, e
	}
	return w.Msg, nil
}
func environmentInput(target *golfv1.RepositoryEnvironmentTarget) *golfv1.SaveRepositoryEnvironmentRequest {
	return &golfv1.SaveRepositoryEnvironmentRequest{Target: proto.Clone(target).(*golfv1.RepositoryEnvironmentTarget), EnvironmentId: uuid.NewString(), OperationId: uuid.NewString(), ExpectedVersion: "0", Name: "Preview ü", Policy: environmentTestPolicy(), CurrentPassword: localTestPassword}
}
func TestEnvironmentVersionsAndOriginalPostgres(t *testing.T) {
	f, l, target := environmentFixture(t)
	m := environmentInput(target)
	first, e := environmentSave(t, f, l, m)
	if e != nil {
		t.Fatal(e)
	}
	if first.Environment.Version != "1" || first.Environment.DeploymentAvailable {
		t.Fatal("false deployment/initial version")
	}
	// Same original acknowledgement is read-only, even after a later edit/delete.
	replay, e := environmentSave(t, f, l, m)
	if e != nil || !proto.Equal(first, replay) {
		t.Fatal("original replay", e)
	}
	edit := proto.Clone(m).(*golfv1.SaveRepositoryEnvironmentRequest)
	edit.ExpectedVersion = "1"
	edit.OperationId = uuid.NewString()
	edit.Name = "Production"
	edit.Policy.WaitSeconds = 60
	second, e := environmentSave(t, f, l, edit)
	if e != nil || second.Environment.Version != "2" || second.Environment.CreatorId != first.Environment.CreatorId || second.Environment.CreatedAt != first.Environment.CreatedAt {
		t.Fatal("immutable creation/edit", e)
	}
	stale := proto.Clone(edit).(*golfv1.SaveRepositoryEnvironmentRequest)
	stale.OperationId = uuid.NewString()
	if _, e = environmentSave(t, f, l, stale); connect.CodeOf(e) != connect.CodeAborted {
		t.Fatal("stale CAS", e)
	}
	changed := proto.Clone(m).(*golfv1.SaveRepositoryEnvironmentRequest)
	changed.Policy.WaitSeconds = 1
	if _, e = environmentSave(t, f, l, changed); connect.CodeOf(e) != connect.CodeFailedPrecondition {
		t.Fatal("changed original intent", e)
	}
	r, c := environmentRequest(f, l, &golfv1.GetRepositoryEnvironmentOperationRequest{Target: target, OperationId: m.OperationId})
	status, e := f.server.GetRepositoryEnvironmentOperation(c, r)
	if e != nil || status.Msg.Environment.Version != "1" || status.Msg.Environment.Name != m.Name {
		t.Fatal("historical accepted version", e)
	}
	d := &golfv1.DeleteRepositoryEnvironmentRequest{Target: target, EnvironmentId: m.EnvironmentId, ExpectedVersion: "2", OperationId: uuid.NewString(), CurrentPassword: localTestPassword}
	dr, dc := environmentRequest(f, l, d)
	deleted, e := f.server.DeleteRepositoryEnvironment(dc, dr)
	if e != nil || !deleted.Msg.Environment.Deleted || deleted.Msg.Environment.Version != "3" {
		t.Fatal("tombstone", e)
	}
	replay, e = environmentSave(t, f, l, m)
	if e != nil || !proto.Equal(first, replay) {
		t.Fatal("post-delete original receipt", e)
	}
	resurrect := proto.Clone(m).(*golfv1.SaveRepositoryEnvironmentRequest)
	resurrect.OperationId = uuid.NewString()
	if _, e = environmentSave(t, f, l, resurrect); connect.CodeOf(e) != connect.CodeAborted {
		t.Fatal("tombstone ABA", e)
	}
	nr, nc := environmentRequest(f, l, &golfv1.ListRepositoryEnvironmentsRequest{Target: target})
	inventory, e := f.server.ListRepositoryEnvironments(nc, nr)
	if e != nil || inventory.Msg.TotalCount != "0" || len(inventory.Msg.Environments) != 0 {
		t.Fatal("deleted inventory", e)
	}
	// A different immutable ID may use the released name; no old receipt is rewritten.
	fresh := environmentInput(target)
	fresh.Name = "Production"
	if _, e = environmentSave(t, f, l, fresh); e != nil {
		t.Fatal("new ID after deletion", e)
	}
	var ops, versions, activities int
	f.server.db.QueryRow(`SELECT count(*) FROM golf_repository_environment_operations`).Scan(&ops)
	f.server.db.QueryRow(`SELECT count(*) FROM golf_repository_environment_versions`).Scan(&versions)
	f.server.db.QueryRow(`SELECT count(*) FROM golf_repository_activity`).Scan(&activities)
	if ops != 4 || versions != 4 || activities != 0 {
		t.Fatalf("once-only/private configuration rows %d/%d/%d", ops, versions, activities)
	}
	if _, e = f.server.db.Exec(`UPDATE golf_repository_environment_versions SET name='rewrite'`); e == nil {
		t.Fatal("history mutable")
	}
}
func TestEnvironmentAuthorityCASAndPaginationPostgres(t *testing.T) {
	f, l, target := environmentFixture(t)
	m := environmentInput(target)
	m.CurrentPassword = "wrong"
	if _, e := environmentSave(t, f, l, m); connect.CodeOf(e) != connect.CodePermissionDenied {
		t.Fatal("password", e)
	}
	m.CurrentPassword = localTestPassword
	wrong := proto.Clone(m).(*golfv1.SaveRepositoryEnvironmentRequest)
	wrong.Target.RepositoryId = "123"
	if _, e := environmentSave(t, f, l, wrong); connect.CodeOf(e) != connect.CodeFailedPrecondition {
		t.Fatal("foreign repository identity", e)
	}
	wrong = proto.Clone(m).(*golfv1.SaveRepositoryEnvironmentRequest)
	wrong.Target.AccessRevision = strings.Repeat("f", 64)
	if _, e := environmentSave(t, f, l, wrong); connect.CodeOf(e) != connect.CodeFailedPrecondition {
		t.Fatal("stale native observation", e)
	}
	f.mu.Lock()
	f.row.Permissions.Admin = false
	f.mu.Unlock()
	if _, e := environmentSave(t, f, l, m); connect.CodeOf(e) != connect.CodePermissionDenied {
		t.Fatal("global admin did not bypass native repository", e)
	}
	f.mu.Lock()
	f.row.Permissions.Admin = true
	f.mu.Unlock()
	for i := 0; i < 3; i++ {
		x := environmentInput(target)
		x.Name = "Preview " + strconv.Itoa(i)
		if _, e := environmentSave(t, f, l, x); e != nil {
			t.Fatal(e)
		}
	}
	r, c := environmentRequest(f, l, &golfv1.ListRepositoryEnvironmentsRequest{Target: target, Page: &golfv1.PageRequest{Limit: 2}})
	a, e := f.server.ListRepositoryEnvironments(c, r)
	if e != nil || a.Msg.TotalCount != "3" || len(a.Msg.Environments) != 2 || a.Msg.Page.NextPage != 2 {
		t.Fatal("bounded native-ID inventory", e)
	}
	r, c = environmentRequest(f, l, &golfv1.ListRepositoryEnvironmentsRequest{Target: target, Page: &golfv1.PageRequest{Page: 2, Limit: 2}})
	b, e := f.server.ListRepositoryEnvironments(c, r)
	if e != nil || len(b.Msg.Environments) != 1 || b.Msg.Page.NextPage != 0 {
		t.Fatal("last page", e)
	}
	dup := environmentInput(target)
	dup.Name = "pREVIEW 0"
	if _, e := environmentSave(t, f, l, dup); connect.CodeOf(e) != connect.CodeAlreadyExists {
		t.Fatal("case-insensitive unique active name", e)
	}
	// Reset only this disposable fixture bucket: CAS competition must exercise
	// the repository gate rather than the independently tested login limiter.
	if e := database.New(f.server.db).ResetLocalLoginLimit(t.Context(), localLoginBucket("alice")); e != nil {
		t.Fatal(e)
	}
	// Competing create of same immutable identity cannot both advance version0.
	one := environmentInput(target)
	one.Name = "Race"
	two := proto.Clone(one).(*golfv1.SaveRepositoryEnvironmentRequest)
	two.OperationId = uuid.NewString()
	var wg sync.WaitGroup
	codes := make(chan connect.Code, 2)
	for _, input := range []*golfv1.SaveRepositoryEnvironmentRequest{one, two} {
		wg.Add(1)
		go func(input *golfv1.SaveRepositoryEnvironmentRequest) {
			defer wg.Done()
			_, e := environmentSave(t, f, l, input)
			codes <- connect.CodeOf(e)
		}(input)
	}
	wg.Wait()
	close(codes)
	success, conflict := 0, 0
	for code := range codes {
		if code == connect.CodeUnknown {
			success++
		} else if code == connect.CodeAborted {
			conflict++
		} else {
			t.Fatal("race", code)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatal("CAS race not serialized", success, conflict)
	}
}

// Required source gate: an owner/session lock wait cannot retain private data
// after the native repository is revoked. SQL changes roll back entirely.
func TestEnvironmentAuthorityAfterWaitPostgres(t *testing.T) {
	f, l, target := environmentFixture(t)
	m := environmentInput(target)
	held, e := f.server.db.BeginTx(t.Context(), nil)
	if e != nil {
		t.Fatal(e)
	}
	defer held.Rollback()
	if _, e = held.Exec(`SELECT pg_advisory_xact_lock(hashtextextended($1||'/repository-environments/'||$2::bigint::text,0))`, f.server.config.GiteaURL, f.row.ID); e != nil {
		t.Fatal(e)
	}
	result := make(chan error, 1)
	go func() { _, e := environmentSave(t, f, l, m); result <- e }()
	// Positive pg_locks observation, not an arbitrary scheduling sleep.
	deadline := time.Now().Add(5 * time.Second)
	waiting := false
	for time.Now().Before(deadline) {
		var n int
		if e = f.server.db.QueryRow(`SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted`).Scan(&n); e != nil {
			t.Fatal(e)
		}
		if n > 0 {
			waiting = true
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !waiting {
		t.Fatal("mutation did not wait at repository gate")
	}
	f.mu.Lock()
	f.denied = true
	f.mu.Unlock()
	held.Rollback()
	if e = <-result; connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("late native revoke", e)
	}
	var n int
	if e = f.server.db.QueryRow(`SELECT count(*) FROM golf_repository_environment_operations`).Scan(&n); e != nil || n != 0 {
		t.Fatal("refused wait committed configuration", n, e)
	}
}
func TestEnvironmentSQLBindingsPostgres(t *testing.T) {
	f, l, target := environmentFixture(t)
	m := environmentInput(target)
	if _, e := environmentSave(t, f, l, m); e != nil {
		t.Fatal(e)
	}
	var v database.GolfRepositoryEnvironmentVersion
	v, e := database.New(f.server.db).GetRepositoryEnvironment(t.Context(), database.GetRepositoryEnvironmentParams{ForgeURL: f.server.config.GiteaURL, ID: uuid.MustParse(m.EnvironmentId), RepositoryID: f.row.ID, OwnerID: 42})
	if e != nil {
		t.Fatal(e)
	}
	tx, e := f.server.db.BeginTx(t.Context(), nil)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	q := database.New(f.server.db).WithTx(tx)
	if _, e = q.AdvanceRepositoryEnvironment(t.Context(), database.AdvanceRepositoryEnvironmentParams{ForgeURL: v.ForgeURL, ID: v.EnvironmentID, RepositoryID: v.RepositoryID, OwnerID: v.OwnerID, Column5: v.Name, CurrentVersion: v.Version}); e != nil {
		t.Fatal(e)
	}
	if _, e = q.InsertRepositoryEnvironmentVersion(t.Context(), database.InsertRepositoryEnvironmentVersionParams{ForgeURL: v.ForgeURL, EnvironmentID: v.EnvironmentID, RepositoryID: v.RepositoryID, OwnerID: v.OwnerID, Version: 2, Name: v.Name, Policy: v.Policy, CreatorUserID: v.CreatorUserID, CreatorNativeID: v.CreatorNativeID + 1, ActorUserID: v.ActorUserID, ActorNativeID: v.ActorNativeID, RepositoryOwner: v.RepositoryOwner, RepositoryName: v.RepositoryName, AccessRevision: v.AccessRevision, EnvironmentCreatedAt: v.EnvironmentCreatedAt, CreatedAt: time.Now()}); e == nil {
		t.Fatal("creator identity transplant")
	}
}

type environmentRoundTripper func(*http.Request) (*http.Response, error)

func (f environmentRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestEnvironmentCommittedReceiptWithheldPostgres(t *testing.T) {
	f, l, target := environmentFixture(t)
	m := environmentInput(target)
	underlying := f.server.client.Transport
	if underlying == nil {
		underlying = http.DefaultTransport
	}
	armed := true
	f.server.client.Transport = environmentRoundTripper(func(r *http.Request) (*http.Response, error) {
		if armed && r.URL.Path == "/api/v1/repos/alice/example" {
			var n int
			if e := f.server.db.QueryRowContext(r.Context(), `SELECT count(*) FROM golf_repository_environment_operations`).Scan(&n); e != nil {
				return nil, e
			}
			if n == 1 {
				armed = false
				f.mu.Lock()
				f.denied = true
				f.mu.Unlock()
			}
		}
		return underlying.RoundTrip(r)
	})
	// The exact SQL operation committed, but current native authority disappeared
	// during final postcommit observation. Do not disclose the private receipt.
	if response, e := environmentSave(t, f, l, m); response != nil || connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("postcommit authority loss", e)
	}
	var n int
	if e := f.server.db.QueryRow(`SELECT count(*) FROM golf_repository_environment_operations`).Scan(&n); e != nil || n != 1 {
		t.Fatal("lost acknowledgement receipt missing", n, e)
	}
	f.mu.Lock()
	f.denied = false
	f.mu.Unlock()
	r, c := environmentRequest(f, l, &golfv1.GetRepositoryEnvironmentOperationRequest{Target: target, OperationId: m.OperationId})
	status, e := f.server.GetRepositoryEnvironmentOperation(c, r)
	if e != nil || status.Msg.Environment.Version != "1" {
		t.Fatal("inspect restored authority", e)
	}
	if _, e := environmentSave(t, f, l, m); e != nil {
		t.Fatal("read-only original replay", e)
	}
	if e := f.server.db.QueryRow(`SELECT count(*) FROM golf_repository_environment_operations`).Scan(&n); e != nil || n != 1 {
		t.Fatal("replayed effect", n, e)
	}
}
func TestEnvironmentConfiguredIdentitiesPostgres(t *testing.T) {
	f, l, target := environmentFixture(t)
	m := environmentInput(target)
	m.Policy.AllowAllSources = false
	m.Policy.Sources = []*golfv1.RepositorySourceSelector{{Kind: 4, Name: f.commit}, {Kind: 2, Name: "future/release"}}
	if _, e := environmentSave(t, f, l, m); e != nil {
		t.Fatal("verified existing commit and literal future branch", e)
	}
	// Existing native reviewer identity is required, not an unverified login,
	// global-admin bypass or a claimed approval. Fixture has no /users/missing.
	reviewer := environmentInput(target)
	reviewer.Name = "Review protected"
	reviewer.Policy.RequiredApprovals = 1
	reviewer.Policy.Reviewers = []*golfv1.RepositoryEnvironmentReviewer{{Id: "123", Login: "missing"}}
	if _, e := environmentSave(t, f, l, reviewer); connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal("missing reviewer configured", e)
	}
	missing := environmentInput(target)
	missing.Name = "Missing commit"
	missing.Policy.AllowAllSources = false
	missing.Policy.Sources = []*golfv1.RepositorySourceSelector{{Kind: 4, Name: strings.Repeat("f", 40)}}
	// Strict supported object API must bind requested hash. Inject a different
	// native commit receipt rather than allowing a SHA-looking ref guess.
	underlying := f.server.client.Transport
	if underlying == nil {
		underlying = http.DefaultTransport
	}
	f.server.client.Transport = environmentRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/api/v1/repos/alice/example/git/commits/"+strings.Repeat("f", 40) {
			clone := r.Clone(r.Context())
			u := *r.URL
			u.Path = "/api/v1/repos/alice/example/git/commits/" + f.commit
			clone.URL = &u
			return underlying.RoundTrip(clone)
		}
		return underlying.RoundTrip(r)
	})
	if _, e := environmentSave(t, f, l, missing); e == nil {
		t.Fatal("foreign source receipt accepted")
	}
	var n int
	if e := f.server.db.QueryRow(`SELECT count(*) FROM golf_repository_environment_operations`).Scan(&n); e != nil || n != 1 {
		t.Fatal("refused configuration persisted", n, e)
	}
}

// Different current native administrators have different locked Golf user rows.
// Editing another creator's environment must acquire both before the repository
// gate, because the immutable version's creator FK takes a KEY SHARE lock.
func TestEnvironmentIndependentAdministratorCreatorLockPostgres(t *testing.T) {
	f, creatorLogin, target := environmentFixture(t)
	initial := environmentInput(target)
	first, e := environmentSave(t, f, creatorLogin, initial)
	if e != nil {
		t.Fatal(e)
	}
	underlying := f.server.client.Transport
	if underlying == nil {
		underlying = http.DefaultTransport
	}
	const secondCredential = "environment-second-admin-fixture"
	secondUser := User{ID: 43, Login: "bob"}
	f.server.client.Transport = environmentRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Authorization") != "token "+secondCredential && r.Header.Get("Authorization") != "Bearer "+secondCredential {
			return underlying.RoundTrip(r)
		}
		reply := func(status int, value any) (*http.Response, error) {
			body, e := json.Marshal(value)
			if e != nil {
				return nil, e
			}
			return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(bytes.NewReader(body)), Request: r}, nil
		}
		switch r.URL.Path {
		case "/api/v1/user":
			return reply(http.StatusOK, secondUser)
		case "/api/v1/repos/alice/example/collaborators/bob/permission":
			return reply(http.StatusOK, map[string]any{"permission": "admin", "user": secondUser})
		case "/api/v1/repos/alice/example/collaborators/bob":
			return reply(http.StatusNoContent, nil)
		default:
			clone := r.Clone(r.Context())
			clone.Header = r.Header.Clone()
			clone.Header.Set("Authorization", "token run-fixture")
			return underlying.RoundTrip(clone)
		}
	})
	if _, e = ManageLocalAccount(t.Context(), f.server.db, f.server.keyring, f.server.config.GiteaURL, "create", LocalAccountInput{Username: "bob", Password: localTestPassword, ForgeToken: secondCredential}); e != nil {
		t.Fatal(e)
	}
	secondLogin, e := f.server.loginLocalSession(t.Context(), "bob", localTestPassword, "")
	if e != nil {
		t.Fatal(e)
	}
	var creatorGolfID, secondGolfID int64
	if e = f.server.db.QueryRow(`SELECT creator_user_id FROM golf_repository_environment_versions WHERE forge_url=$1 AND environment_id=$2 AND version=1`, f.server.config.GiteaURL, initial.EnvironmentId).Scan(&creatorGolfID); e != nil {
		t.Fatal(e)
	}
	if e = f.server.db.QueryRow(`SELECT id FROM golf_users WHERE forge_url=$1 AND forge_user_id=43`, f.server.config.GiteaURL).Scan(&secondGolfID); e != nil || creatorGolfID == secondGolfID {
		t.Fatal("actors must be independent", e)
	}
	held, e := f.server.db.BeginTx(t.Context(), nil)
	if e != nil {
		t.Fatal(e)
	}
	defer held.Rollback()
	if _, e = held.Exec(`SELECT pg_advisory_xact_lock(hashtextextended($1||'/repository-environments/'||$2::bigint::text,0))`, f.server.config.GiteaURL, f.row.ID); e != nil {
		t.Fatal(e)
	}
	type outcome struct {
		response *golfv1.SaveRepositoryEnvironmentResponse
		err      error
	}
	run := func(login loginResult, input *golfv1.SaveRepositoryEnvironmentRequest, result chan<- outcome) {
		request, ctx := environmentRequest(f, login, input)
		ctx, cancel := context.WithCancel(ctx)
		stop := context.AfterFunc(t.Context(), cancel)
		defer stop()
		defer cancel()
		response, e := f.server.SaveRepositoryEnvironment(ctx, request)
		if response == nil {
			result <- outcome{err: e}
			return
		}
		result <- outcome{response: response.Msg, err: e}
	}
	editor := proto.Clone(initial).(*golfv1.SaveRepositoryEnvironmentRequest)
	editor.ExpectedVersion = "1"
	editor.OperationId = uuid.NewString()
	editor.Name = "Independent editor"
	editorResult := make(chan outcome, 1)
	go run(secondLogin, editor, editorResult)
	// Observe this exact repository advisory waiter, not a scheduling sleep.
	deadline := time.Now().Add(5 * time.Second)
	waiting := false
	var editorPID int
	for time.Now().Before(deadline) {
		var n int
		e = f.server.db.QueryRow(`SELECT count(*),coalesce(min(pid),0) FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=((hashtextextended($1||'/repository-environments/'||$2::bigint::text,0)>>32)&4294967295)::oid AND objid=(hashtextextended($1||'/repository-environments/'||$2::bigint::text,0)&4294967295)::oid AND objsubid=1`, f.server.config.GiteaURL, f.row.ID).Scan(&n, &editorPID)
		if e != nil {
			t.Fatal(e)
		}
		if n == 1 {
			waiting = true
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !waiting {
		t.Fatal("second administrator never reached repository lock")
	}
	// Both native actors are ordinary, independent identities. The second actor
	// must already hold the immutable creator's row before waiting on the gate.
	for _, id := range []int64{creatorGolfID, secondGolfID} {
		probe, e := f.server.db.BeginTx(t.Context(), nil)
		if e != nil {
			t.Fatal(e)
		}
		var observed int64
		e = probe.QueryRow(`SELECT id FROM golf_users WHERE id=$1 FOR UPDATE NOWAIT`, id).Scan(&observed)
		probe.Rollback()
		var pe *pgconn.PgError
		if !errors.As(e, &pe) || pe.Code != "55P03" {
			t.Fatal("editor did not lock both actor and creator before repository", id, e)
		}
	}
	creatorEdit := proto.Clone(initial).(*golfv1.SaveRepositoryEnvironmentRequest)
	creatorEdit.ExpectedVersion = "1"
	creatorEdit.OperationId = uuid.NewString()
	creatorEdit.Name = "Competing creator"
	creatorResult := make(chan outcome, 1)
	go run(creatorLogin, creatorEdit, creatorResult)
	deadline = time.Now().Add(5 * time.Second)
	waiting = false
	for time.Now().Before(deadline) {
		var n int
		if e = f.server.db.QueryRow(`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`, editorPID).Scan(&n); e != nil {
			t.Fatal(e)
		}
		if n > 0 {
			waiting = true
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !waiting {
		t.Fatal("creator did not contend on its already-held user lock")
	}
	if e = held.Rollback(); e != nil {
		t.Fatal(e)
	}
	edited, competing := <-editorResult, <-creatorResult
	if edited.err != nil || edited.response == nil || edited.response.Environment.Version != "2" || edited.response.Environment.CreatorId != first.Environment.CreatorId || edited.response.Environment.UpdaterId != "43" {
		t.Fatal("independent admin edit failed", edited.err)
	}
	if connect.CodeOf(competing.err) != connect.CodeAborted {
		t.Fatal("creator's original version must fail CAS after serialized edit", competing.err)
	}
	var versions, operations int
	if e = f.server.db.QueryRow(`SELECT count(*) FROM golf_repository_environment_versions WHERE forge_url=$1 AND environment_id=$2`, f.server.config.GiteaURL, initial.EnvironmentId).Scan(&versions); e != nil {
		t.Fatal(e)
	}
	if e = f.server.db.QueryRow(`SELECT count(*) FROM golf_repository_environment_operations WHERE forge_url=$1 AND environment_id=$2`, f.server.config.GiteaURL, initial.EnvironmentId).Scan(&operations); e != nil || versions != 2 || operations != 2 {
		t.Fatal("competing actor created a duplicate version/receipt", versions, operations, e)
	}
}
