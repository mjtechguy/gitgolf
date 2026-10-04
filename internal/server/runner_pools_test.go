package server

import (
	"crypto/sha256"
	"strconv"
	"strings"
	"testing"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

const poolFixtureID = "12345678-1234-4234-8234-123456789001"
const poolFixtureOtherID = "12345678-1234-4234-8234-123456789002"

func poolInput() *golfv1.SaveRunnerPoolRequest {
	return &golfv1.SaveRunnerPoolRequest{Id: poolFixtureID, ExpectedVersion: "0", Name: "Local builds", Runtime: "local-docker", State: golfv1.RunnerPoolState_RUNNER_POOL_STATE_ACTIVE, MaxParallelAttempts: 1, WorkerIds: []string{"second", "fixture"}, RepositoryAssignmentEnabled: true, CurrentPassword: localTestPassword}
}

func TestRunnerPoolAdmissionInput(t *testing.T) {
	keys := map[string][32]byte{"fixture": {}, "second": {}}
	v, workers, e := validatePoolInput(poolInput(), keys)
	if e != nil || v != 0 || strings.Join(workers, ",") != "fixture,second" {
		t.Fatal("valid enrolled inventory", e)
	}
	for name, change := range map[string]func(*golfv1.SaveRunnerPoolRequest){
		"unsupported runtime":  func(m *golfv1.SaveRunnerPoolRequest) { m.Runtime = "kubernetes" },
		"Cloudflare runtime":   func(m *golfv1.SaveRunnerPoolRequest) { m.Runtime = "cloudflare" },
		"unknown worker":       func(m *golfv1.SaveRunnerPoolRequest) { m.WorkerIds = []string{"not-enrolled"} },
		"duplicate worker":     func(m *golfv1.SaveRunnerPoolRequest) { m.WorkerIds = []string{"fixture", "fixture"} },
		"empty active":         func(m *golfv1.SaveRunnerPoolRequest) { m.WorkerIds = nil },
		"zero capacity":        func(m *golfv1.SaveRunnerPoolRequest) { m.MaxParallelAttempts = 0 },
		"over capacity":        func(m *golfv1.SaveRunnerPoolRequest) { m.MaxParallelAttempts = 101 },
		"unknown state":        func(m *golfv1.SaveRunnerPoolRequest) { m.State = 99 },
		"noncanonical version": func(m *golfv1.SaveRunnerPoolRequest) { m.ExpectedVersion = "01" },
		"version overflow":     func(m *golfv1.SaveRunnerPoolRequest) { m.ExpectedVersion = "9223372036854775808" },
		"non-v4 ID":            func(m *golfv1.SaveRunnerPoolRequest) { m.Id = "12345678-1234-1234-8234-123456789001" },
		"control name":         func(m *golfv1.SaveRunnerPoolRequest) { m.Name = "Build\nworker" },
		"untrimmed name":       func(m *golfv1.SaveRunnerPoolRequest) { m.Name = " worker" },
		"name byte bound":      func(m *golfv1.SaveRunnerPoolRequest) { m.Name = strings.Repeat("界", 43) },
	} {
		t.Run(name, func(t *testing.T) {
			m := proto.Clone(poolInput()).(*golfv1.SaveRunnerPoolRequest)
			change(m)
			if _, _, e := validatePoolInput(m, keys); connect.CodeOf(runnerPoolRPCError(e)) != connect.CodeInvalidArgument {
				t.Fatal("invalid or unenrolled input accepted", e)
			}
		})
	}
	m := poolInput()
	m.State = golfv1.RunnerPoolState_RUNNER_POOL_STATE_DRAINING
	m.WorkerIds = nil
	if _, workers, e := validatePoolInput(m, keys); e != nil || workers == nil || len(workers) != 0 {
		t.Fatal("retained idle draining pool cannot release final worker", e)
	}
}

func TestRunnerPoolsAdminCASMembershipPostgres(t *testing.T) {
	f := newManagementFixture(t)
	enrollLocal(t, f, "alice", true)
	enrollLocal(t, f, "bob", false)
	admin := localLogin(t, f, "alice")
	f.s.runnerKeys = map[string][32]byte{"fixture": sha256.Sum256([]byte("fixture")), "second": sha256.Sum256([]byte("second"))}
	save := func(session loginResult, m *golfv1.SaveRunnerPoolRequest) (*connect.Response[golfv1.SaveRunnerPoolResponse], error) {
		r, ctx := runnerControlRequest(f.s, session, m)
		return f.s.SaveRunnerPool(ctx, r)
	}
	for _, session := range []loginResult{localLogin(t, f, "bob"), f.session(t, "alice", "pat"), f.session(t, "alice", "oauth")} {
		if _, e := save(session, poolInput()); connect.CodeOf(e) != connect.CodePermissionDenied {
			t.Fatal("pool metadata granted instance admin authority", e)
		}
	}
	m := poolInput()
	m.CurrentPassword = "wrong password"
	if _, e := save(admin, m); e == nil {
		t.Fatal("pool step-up bypassed")
	}
	m = poolInput()
	first, e := save(admin, m)
	if e != nil || first.Msg.Pool.Version != "1" || strings.Join(first.Msg.Pool.WorkerIds, ",") != "fixture,second" {
		t.Fatal("create", e)
	}
	if _, e = save(admin, m); connect.CodeOf(e) != connect.CodeAborted {
		t.Fatal("creation key rewrote existing pool", e)
	}
	other := poolInput()
	other.Id, other.Name = poolFixtureOtherID, "Other"
	if _, e = save(admin, other); connect.CodeOf(e) != connect.CodeInvalidArgument {
		t.Fatal("worker joined two pools", e)
	}
	m.ExpectedVersion, m.State, m.WorkerIds = "1", golfv1.RunnerPoolState_RUNNER_POOL_STATE_DRAINING, nil
	if _, e = save(admin, m); e != nil {
		t.Fatal("explicit release of idle membership", e)
	}
	if _, e = save(admin, other); e != nil {
		t.Fatal("released worker could not join another pool", e)
	}
	var count int
	if e = f.db.QueryRow(`SELECT count(*) FROM golf_runner_pool_audit`).Scan(&count); e != nil || count != 3 {
		t.Fatal("CAS failure created history or success omitted it", count, e)
	}
	for _, query := range []string{`DELETE FROM golf_runner_pools`, `DELETE FROM golf_runner_pool_audit`, `TRUNCATE golf_runner_pool_workers`, `UPDATE golf_runner_pools SET version=version+2`} {
		if _, e = f.db.Exec(query); e == nil {
			t.Fatal("retained identity/history erased", query)
		}
	}
	restarted, e := New(f.s.config, f.db)
	if e != nil {
		t.Fatal(e)
	}
	restarted.runnerKeys = f.s.runnerKeys
	r, ctx := runnerControlRequest(restarted, admin, &golfv1.ListRunnerPoolsRequest{})
	list, e := restarted.ListRunnerPools(ctx, r)
	if e != nil || len(list.Msg.Pools) != 2 || list.Msg.Pools[0].Version != "2" || list.Msg.Pools[0].State != golfv1.RunnerPoolState_RUNNER_POOL_STATE_DRAINING || list.Msg.Pools[0].ActiveAttemptCount == nil {
		t.Fatal("restart lost retained current inventory", e)
	}
}

func runnerPoolLocalFixture(t *testing.T) (*workflowRunFixture, loginResult) {
	t.Helper()
	f := newWorkflowRunFixture(t)
	f.row.HTMLURL = "https://forge.invalid/alice/example"
	f.server.runnerKeys["second"] = sha256.Sum256([]byte("second"))
	if _, e := ManageLocalAccount(t.Context(), f.server.db, f.server.keyring, f.server.config.GiteaURL, "create", LocalAccountInput{Username: "alice", Password: localTestPassword, ForgeToken: "run-fixture", IsInstanceAdmin: true}); e != nil {
		t.Fatal(e)
	}
	admin, e := f.server.loginLocalSession(t.Context(), "alice", localTestPassword, "")
	if e != nil {
		t.Fatal(e)
	}
	return f, admin
}

func runnerPoolSaveFixture(t *testing.T, f *workflowRunFixture, admin loginResult, m *golfv1.SaveRunnerPoolRequest) *golfv1.RunnerPool {
	t.Helper()
	r, ctx := runnerControlRequest(f.server, admin, m)
	w, e := f.server.SaveRunnerPool(ctx, r)
	if e != nil {
		t.Fatal(e)
	}
	return w.Msg.Pool
}

func runnerPlacementFixture(t *testing.T, f *workflowRunFixture, admin loginResult) *golfv1.GetRepositoryRunnerPlacementRequest {
	t.Helper()
	r, ctx := runnerControlRequest(f.server, admin, &golfv1.GetRepositoryAccessRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}})
	a, e := f.server.GetRepositoryAccess(ctx, r)
	if e != nil {
		t.Fatal(e)
	}
	return &golfv1.GetRepositoryRunnerPlacementRequest{Repository: &golfv1.RepositoryKey{Owner: "alice", Name: "example"}, RepositoryId: a.Msg.Access.RepositoryId, OwnerId: a.Msg.Access.OwnerId, ExpectedRevision: a.Msg.Access.Revision}
}

func runnerPlacementSetFixture(t *testing.T, f *workflowRunFixture, admin loginResult, version, poolVersion, id string) *golfv1.RepositoryRunnerPlacement {
	t.Helper()
	a := runnerPlacementFixture(t, f, admin)
	m := &golfv1.SetRepositoryRunnerPlacementRequest{Repository: a.Repository, RepositoryId: a.RepositoryId, OwnerId: a.OwnerId, ExpectedRevision: a.ExpectedRevision, ExpectedPlacementVersion: version, PoolId: id, ExpectedPoolVersion: poolVersion, CurrentPassword: localTestPassword}
	r, ctx := runnerControlRequest(f.server, admin, m)
	r.Header().Set("Origin", f.server.config.PublicURL)
	w, e := f.server.SetRepositoryRunnerPlacement(ctx, r)
	if e != nil {
		t.Fatal(e)
	}
	return w.Msg.Placement
}

func TestRunnerPlacementCurrentAuthorityCASPostgres(t *testing.T) {
	f, admin := runnerPoolLocalFixture(t)
	pool := runnerPoolSaveFixture(t, f, admin, poolInput())
	a := runnerPlacementFixture(t, f, admin)
	get := func(m *golfv1.GetRepositoryRunnerPlacementRequest) (*connect.Response[golfv1.GetRepositoryRunnerPlacementResponse], error) {
		r, ctx := runnerControlRequest(f.server, admin, m)
		r.Header().Set("Origin", f.server.config.PublicURL)
		return f.server.GetRepositoryRunnerPlacement(ctx, r)
	}
	initial, e := get(a)
	if e != nil || initial.Msg.Placement.Version != "0" || !initial.Msg.Placement.LegacyUnbound || len(initial.Msg.EligiblePools) != 1 || initial.Msg.EligiblePools[0].ActiveAttemptCount != nil {
		t.Fatal("initial inventory or cross-repository attempt count leak", e)
	}
	bound := runnerPlacementSetFixture(t, f, admin, "0", pool.Version, pool.Id)
	if bound.Version != "1" || bound.PoolId != pool.Id || bound.PoolVersion != "1" || bound.LegacyUnbound {
		t.Fatal("exact placement receipt")
	}
	m := &golfv1.SetRepositoryRunnerPlacementRequest{Repository: a.Repository, RepositoryId: a.RepositoryId, OwnerId: a.OwnerId, ExpectedRevision: a.ExpectedRevision, ExpectedPlacementVersion: "0", PoolId: pool.Id, ExpectedPoolVersion: pool.Version, CurrentPassword: localTestPassword}
	r, ctx := runnerControlRequest(f.server, admin, m)
	r.Header().Set("Origin", f.server.config.PublicURL)
	if _, e = f.server.SetRepositoryRunnerPlacement(ctx, r); connect.CodeOf(e) != connect.CodeAborted {
		t.Fatal("stale placement CAS", e)
	}
	wrong := proto.Clone(a).(*golfv1.GetRepositoryRunnerPlacementRequest)
	wrong.RepositoryId = strconv.FormatInt(f.row.ID+1, 10)
	if _, e = get(wrong); e == nil {
		t.Fatal("replacement ID disclosed placement")
	}
	f.mu.Lock()
	f.permission = "read"
	f.row.Permissions = &struct {
		Admin bool `json:"admin"`
	}{false}
	f.mu.Unlock()
	if _, e = get(a); e == nil {
		t.Fatal("Golf admin bypassed lost ordinary native authority")
	}
}
