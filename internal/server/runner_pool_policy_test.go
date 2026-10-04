package server

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// This deliberately exercises the new authoritative ordered fence, not the old
// transport selector awaiting root integration. Native/policy/lease fences are
// tested separately by that existing consumer; SQL remains the final backstop.
func runnerPoolTestClaim(ctx context.Context, s *Server, id, worker string) (bool, error) {
	r, e := s.loadWorkflowRun(ctx, id)
	if e != nil {
		return false, e
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return false, e
	}
	defer tx.Rollback()
	if _, e = s.lockRepositoryLifecycleTransaction(ctx, tx, r.RepositoryID); e != nil {
		return false, e
	}
	allowed, e := s.runnerPoolClaimFence(ctx, tx, r, worker)
	if e != nil || !allowed {
		return false, e
	}
	hash := sha256.Sum256([]byte(id + worker))
	_, e = tx.ExecContext(ctx, `UPDATE golf_workflow_runs SET state='running',version=version+1,started_at=clock_timestamp(),runner_id=$3,attempt_id=$4,lease_token_hash=$5,lease_expires_at=clock_timestamp()+interval '45 seconds' WHERE forge_url=$1 AND id=$2::uuid AND state='queued'`, s.config.GiteaURL, id, worker, fmt.Sprintf("%x", hash[:16]), hash[:])
	if e != nil {
		return false, e
	}
	return true, tx.Commit()
}

func runnerPoolTestDispatch(t *testing.T, f *workflowRunFixture, n int) string {
	t.Helper()
	w, e := f.dispatch(t, fmt.Sprintf("12345678-1234-4234-8234-%012d", n))
	if e != nil {
		t.Fatal(e)
	}
	return w.Msg.Run.Id
}

func TestRunnerPoolClaimSelectedMetadata(t *testing.T) {
	a := workflowRunRecord{ID: poolFixtureID, ForgeURL: "https://forge.invalid", RepositoryID: 91, OwnerID: 7, UserID: 13, RepositoryOwner: "alice", RepositoryName: "example", Version: 1, SessionHash: []byte{1}, CommitID: "selected-head", BlobID: "workflow-blob", SourceSHA256: "archive-proof", EngineCatalog: "qualified-catalog", InputHash: []byte{2}, PolicyEpochs: []byte("[]")}
	if !sameRunnerPoolClaimTarget(a, a) {
		t.Fatal("unchanged selected admission refused")
	}
	for name, change := range map[string]func(*workflowRunRecord){
		"native replacement":         func(b *workflowRunRecord) { b.RepositoryID++ },
		"owner transfer":             func(b *workflowRunRecord) { b.OwnerID++ },
		"snapshot moved":             func(b *workflowRunRecord) { b.CommitID = "different-head" },
		"source bytes changed":       func(b *workflowRunRecord) { b.SourceSHA256 = "other-archive" },
		"workflow changed":           func(b *workflowRunRecord) { b.BlobID = "other-blob" },
		"actor changed":              func(b *workflowRunRecord) { b.UserID++ },
		"session replaced":           func(b *workflowRunRecord) { b.SessionHash = []byte{9} },
		"dispatch version changed":   func(b *workflowRunRecord) { b.Version++ },
		"policy changed":             func(b *workflowRunRecord) { b.PolicyEpochs = []byte("[1]") },
		"event changed":              func(b *workflowRunRecord) { b.EventRef = "different-ref" },
		"credential version changed": func(b *workflowRunRecord) { b.AutomationCredentialVersion.Int64++ },
		"source storage replaced":    func(b *workflowRunRecord) { b.SourceKey = "other-object" },
		"cancel requested":           func(b *workflowRunRecord) { b.CancelRequested = true },
	} {
		t.Run(name, func(t *testing.T) {
			b := a
			change(&b)
			if sameRunnerPoolClaimTarget(a, b) {
				t.Fatal("stale inspected admission remained claimable")
			}
		})
	}
}

func TestRunnerPoolPinnedAdmissionCapacityPostgres(t *testing.T) {
	f, admin := runnerPoolLocalFixture(t)
	pool := runnerPoolSaveFixture(t, f, admin, poolInput())
	runnerPlacementSetFixture(t, f, admin, "0", pool.Version, pool.Id)
	f.enable(t)
	first := runnerPoolTestDispatch(t, f, 1)
	// A separate repository placement is essential: competing attempts must be
	// serialized by their shared pool, not accidentally by one placement lock.
	// This is an owned Golf coordination fixture, not a native authorization
	// qualification; the existing current-authority test covers that boundary.
	if _, e := f.server.db.Exec(`INSERT INTO golf_repository_runner_placements(forge_url,repository_id,owner_id,version,pool_id,selected_pool_version,actor_user_id) SELECT forge_url,repository_id+1,owner_id,version,pool_id,selected_pool_version,actor_user_id FROM golf_repository_runner_placements WHERE repository_id=$1`, f.row.ID); e != nil {
		t.Fatal(e)
	}
	second := "12345678-1234-4234-8234-123456789098"
	if _, e := f.server.db.Exec(`INSERT INTO golf_workflow_runs(id,forge_url,repository_id,owner_id,repository_owner,repository_name,organization_owned,user_id,session_hash,commit_id,workflow_path,blob_id,format,plan,source_archive,source_sha256,policy_epochs,idempotency_key,input_hash) SELECT $1::uuid,forge_url,repository_id+1,owner_id,repository_owner,'other',organization_owned,user_id,session_hash,commit_id,workflow_path,blob_id,format,plan,source_archive,source_sha256,policy_epochs,$1::uuid,input_hash FROM golf_workflow_runs WHERE id=$2::uuid`, second, first); e != nil {
		t.Fatal(e)
	}
	ids := []string{first, second}
	for _, id := range ids {
		b, e := f.server.runnerPoolRunBinding(t.Context(), f.server.db, id)
		if e != nil || b.PoolID.String != pool.Id || b.PoolVersion.Int64 != 1 || b.PlacementVersion != 1 {
			t.Fatal("source admission did not freeze original placement", b, e)
		}
	}
	start := make(chan struct{})
	type result struct {
		claimed bool
		err     error
	}
	out := make(chan result, 2)
	var wg sync.WaitGroup
	for i, worker := range []string{"fixture", "second"} {
		wg.Add(1)
		go func(id, worker string) {
			defer wg.Done()
			<-start
			ok, e := runnerPoolTestClaim(t.Context(), f.server, id, worker)
			out <- result{ok, e}
		}(ids[i], worker)
	}
	close(start)
	wg.Wait()
	close(out)
	claimed := 0
	for r := range out {
		if r.err != nil {
			t.Fatal(r.err)
		}
		if r.claimed {
			claimed++
		}
	}
	if claimed != 1 {
		t.Fatal("capacity was exceeded or neither candidate progressed", claimed)
	}
	var running, queued int
	if e := f.server.db.QueryRow(`SELECT count(*) FILTER(WHERE state='running'),count(*) FILTER(WHERE state='queued') FROM golf_workflow_runs`).Scan(&running, &queued); e != nil || running != 1 || queued != 1 {
		t.Fatal("backpressure cancelled or claimed excess work", running, queued, e)
	}
	// A running worker remains in the pool; a drain retains its attempt, but
	// increments the pin and makes the other queued admission explicitly stale.
	m := poolInput()
	m.ExpectedVersion = "1"
	m.State = golfv1.RunnerPoolState_RUNNER_POOL_STATE_DRAINING
	m.WorkerIds = nil
	req, ctx := runnerControlRequest(f.server, admin, m)
	if _, e := f.server.SaveRunnerPool(ctx, req); connect.CodeOf(e) != connect.CodeInvalidArgument {
		t.Fatal("live membership moved or returned ambiguous storage refusal", e)
	}
	m.WorkerIds = []string{"fixture", "second"}
	runnerPoolSaveFixture(t, f, admin, m)
	var remaining, worker string
	if e := f.server.db.QueryRow(`SELECT id::text FROM golf_workflow_runs WHERE state='queued'`).Scan(&remaining); e != nil {
		t.Fatal(e)
	}
	if e := f.server.db.QueryRow(`SELECT runner_id FROM golf_workflow_runs WHERE state='running'`).Scan(&worker); e != nil {
		t.Fatal(e)
	}
	other := "fixture"
	if worker == other {
		other = "second"
	}
	if ok, e := runnerPoolTestClaim(t.Context(), f.server, remaining, other); ok || !errors.Is(e, errRunnerPoolStale) {
		t.Fatal("drain silently reassigned stale work", ok, e)
	}
	// Capacity/state edits must not rewrite the original receipt or end a live attempt.
	b, e := f.server.runnerPoolRunBinding(t.Context(), f.server.db, remaining)
	if e != nil || b.PoolVersion.Int64 != 1 {
		t.Fatal("original pin rewritten", e)
	}
	if e = f.server.db.QueryRow(`SELECT count(*) FROM golf_workflow_runs WHERE state='running'`).Scan(&running); e != nil || running != 1 {
		t.Fatal("drain erased live attempt", e)
	}
	if _, e = f.dispatch(t, "12345678-1234-4234-8234-123456789099"); e == nil {
		t.Fatal("draining pool admitted new work")
	}
}

func TestRunnerPoolPlacementChangeLegacyAndSQLGuardsPostgres(t *testing.T) {
	f, admin := runnerPoolLocalFixture(t)
	f.enable(t)
	legacy := runnerPoolTestDispatch(t, f, 1)
	pool := runnerPoolSaveFixture(t, f, admin, poolInput())
	if ok, e := runnerPoolTestClaim(t.Context(), f.server, legacy, "fixture"); ok || e != nil {
		t.Fatal("pooled worker stole legacy unbound work", ok, e)
	}
	f.server.runnerKeys["legacy"] = sha256.Sum256([]byte("legacy"))
	if ok, e := runnerPoolTestClaim(t.Context(), f.server, legacy, "legacy"); !ok || e != nil {
		t.Fatal("unpooled worker cannot service unchanged legacy admission", ok, e)
	}
	busy := poolInput()
	busy.Id, busy.Name, busy.WorkerIds = poolFixtureOtherID, "Busy legacy", []string{"legacy"}
	r, ctx := runnerControlRequest(f.server, admin, busy)
	if _, e := f.server.SaveRunnerPool(ctx, r); connect.CodeOf(e) != connect.CodeInvalidArgument {
		t.Fatal("active legacy worker joined a pool", e)
	}
	runnerPlacementSetFixture(t, f, admin, "0", pool.Version, pool.Id)
	bound := runnerPoolTestDispatch(t, f, 2)
	runnerPlacementSetFixture(t, f, admin, "1", "", "")
	if ok, e := runnerPoolTestClaim(t.Context(), f.server, bound, "fixture"); ok || !errors.Is(e, errRunnerPoolStale) {
		t.Fatal("placement changed admitted binding", ok, e)
	}
	if _, e := f.server.db.Exec(`UPDATE golf_workflow_runs SET runner_pool_id=NULL,runner_pool_version=NULL WHERE id=$1`, bound); e == nil {
		t.Fatal("immutable admitted binding erased")
	}
	if _, e := f.server.db.Exec(`UPDATE golf_workflow_runs SET state='running',version=version+1,runner_id='fixture',attempt_id='0123456789abcdef0123456789abcdef',started_at=clock_timestamp() WHERE id=$1`, bound); e == nil {
		t.Fatal("direct update bypassed stale placement guard")
	}
	if _, e := f.server.db.Exec(`UPDATE golf_workflow_runs SET state='running',version=version+1,started_at=clock_timestamp() WHERE id=$1`, bound); e == nil {
		t.Fatal("missing worker identity bypassed claim guard")
	}
	if _, e := f.server.db.Exec(`DELETE FROM golf_repository_runner_placements`); e == nil {
		t.Fatal("placement tombstone erased")
	}
	if _, e := f.server.db.Exec(`UPDATE golf_repository_runner_placements SET owner_id=owner_id+1,version=version+1`); e == nil {
		t.Fatal("immutable native owner rewritten")
	}
	// New explicit dispatch observes retained unbound generation; it is not the
	// original queued admission being automatically reassigned.
	fresh := runnerPoolTestDispatch(t, f, 3)
	b, e := f.server.runnerPoolRunBinding(t.Context(), f.server.db, fresh)
	if e != nil || b.PoolID.Valid || b.PlacementVersion != 2 {
		t.Fatal("new admission ignored retained unbound version", b, e)
	}
}

func TestRunnerPoolPlacementLockSerializesChangePostgres(t *testing.T) {
	f, admin := runnerPoolLocalFixture(t)
	pool := runnerPoolSaveFixture(t, f, admin, poolInput())
	runnerPlacementSetFixture(t, f, admin, "0", pool.Version, pool.Id)
	f.enable(t)
	id := runnerPoolTestDispatch(t, f, 1)
	tx, e := f.server.db.BeginTx(t.Context(), nil)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	if e = f.server.lockRunnerPlacement(t.Context(), tx, f.row.ID); e != nil {
		t.Fatal(e)
	}
	result := make(chan error, 1)
	go func() { _, e := runnerPoolTestClaim(t.Context(), f.server, id, "fixture"); result <- e }()
	select {
	case <-result:
		t.Fatal("claim skipped placement serialization")
	case <-time.After(50 * time.Millisecond):
	}
	_, e = tx.Exec(`UPDATE golf_repository_runner_placements SET pool_id=NULL,selected_pool_version=NULL,version=version+1 WHERE forge_url=$1 AND repository_id=$2`, f.server.config.GiteaURL, f.row.ID)
	if e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	select {
	case e := <-result:
		if !errors.Is(e, errRunnerPoolStale) {
			t.Fatal("claim ignored changed placement", e)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("claim did not settle")
	}
	var state string
	if e = f.server.db.QueryRow(`SELECT state FROM golf_workflow_runs WHERE id=$1`, id).Scan(&state); e != nil || state != "queued" {
		t.Fatal("stale predicate created a native attempt", state, e)
	}
}

func TestRunnerPoolRevocationLockRechecksCurrentControlPostgres(t *testing.T) {
	f, admin := runnerPoolLocalFixture(t)
	pool := runnerPoolSaveFixture(t, f, admin, poolInput())
	runnerPlacementSetFixture(t, f, admin, "0", pool.Version, pool.Id)
	f.enable(t)
	id := runnerPoolTestDispatch(t, f, 1)
	tx, e := f.server.db.BeginTx(t.Context(), nil)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	if e = f.server.lockRunnerControl(t.Context(), tx, "fixture"); e != nil {
		t.Fatal(e)
	}
	result := make(chan error, 1)
	go func() {
		ok, e := runnerPoolTestClaim(t.Context(), f.server, id, "fixture")
		if ok && e == nil {
			e = fmt.Errorf("revoked runner claimed")
		}
		result <- e
	}()
	select {
	case <-result:
		t.Fatal("claim skipped worker lock")
	case <-time.After(50 * time.Millisecond):
	}
	if _, e = tx.Exec(`INSERT INTO golf_runner_controls(forge_url,runner_id,state,version) VALUES($1,'fixture','revoked',1)`, f.server.config.GiteaURL); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	select {
	case e := <-result:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("claim failed to settle")
	}
	var n int
	if e = f.server.db.QueryRow(`SELECT count(*) FROM golf_workflow_runs WHERE state='running'`).Scan(&n); e != nil || n != 0 {
		t.Fatal("revoked runner resurrected", n, e)
	}
}

func TestRunnerPoolFinalSelectedSourceFencePostgres(t *testing.T) {
	f := newWorkflowRunFixture(t)
	f.enable(t)
	id := runnerPoolTestDispatch(t, f, 1)
	selected, e := f.server.loadWorkflowRun(t.Context(), id)
	if e != nil {
		t.Fatal(e)
	}
	holder, e := f.server.db.BeginTx(t.Context(), nil)
	if e != nil {
		t.Fatal(e)
	}
	defer holder.Rollback()
	if e = f.server.lockRunnerPlacement(t.Context(), holder, f.row.ID); e != nil {
		t.Fatal(e)
	}
	result := make(chan error, 1)
	go func() {
		tx, e := f.server.db.BeginTx(t.Context(), nil)
		if e != nil {
			result <- e
			return
		}
		defer tx.Rollback()
		if _, e = f.server.lockRepositoryLifecycleTransaction(t.Context(), tx, selected.RepositoryID); e == nil {
			var ok bool
			ok, e = f.server.runnerPoolClaimFence(t.Context(), tx, selected, "fixture")
			if ok && e == nil {
				e = fmt.Errorf("changed source was accepted")
			}
		}
		result <- e
	}()
	select {
	case <-result:
		t.Fatal("source fence skipped placement lock")
	case <-time.After(50 * time.Millisecond):
	}
	// Deliberate owned Golf metadata fault, never a native source mutation. The
	// final locked read must reject what the earlier native/source checks did
	// not inspect, even for a legacy shell archive-receipt field outside graph immutability.
	// Native head/actor/origin fields already have stronger SQL immutability.
	if _, e = holder.Exec(`UPDATE golf_workflow_runs SET source_sha256=$2,version=version+1 WHERE id=$1`, id, strings.Repeat("c", 64)); e != nil {
		t.Fatal(e)
	}
	if e = holder.Commit(); e != nil {
		t.Fatal(e)
	}
	select {
	case e := <-result:
		if !errors.Is(e, errRunnerPoolStale) {
			t.Fatal("final selected source fence", e)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("source fence did not settle")
	}
}
