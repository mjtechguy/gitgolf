package server

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"connectrpc.com/connect"
)

func TestProtectionUnknownFencesManagedWritesPostgres(t *testing.T) {
	db := testDatabase(t)
	native := newRuleMutationFixture(t)
	s, e := New(testConfig(native.provider.URL), db)
	if e != nil {
		t.Fatal(e)
	}
	credential := forgeCredential{Kind: "pat", Token: "rules-source-only"}
	session, e := s.createSession(t.Context(), User{ID: 42, Login: "alice"}, "pat", credential.Token, "")
	if e != nil {
		t.Fatal(e)
	}
	ctx := context.WithValue(t.Context(), sessionTokenKey{}, credential)
	before, e := s.currentRuleInventory(ctx, session.Value, credential, repositoryKey{"alice", "example"}, "9007199254740993", "42")
	if e != nil {
		t.Fatal(e)
	}
	m := ruleRequestFixture()
	m.ExpectedAccessRevision = before.AccessRevision
	m.ExpectedRulesRevision = before.RulesRevision
	m.DesiredBranch.RequiredApprovals = "3"
	native.fault = "accepted500"
	req := connect.NewRequest(m)
	req.Header().Set("Origin", s.config.PublicURL)
	req.Header().Set("Cookie", s.sessionCookie(session.Value, session.Expires, 3600).String())
	original, e := s.MutateRepositoryRules(ctx, req)
	if e != nil || original.Msg.Operation.Phase != "DISPATCH_UNKNOWN" || native.writes.Load() != 1 {
		t.Fatal("uncertain accepted protection fixture", e)
	}
	for _, write := range []struct{ method, path string }{
		{http.MethodPost, "/contents/file.txt"}, {http.MethodPost, "/pulls/1/reviews"}, {http.MethodPut, "/collaborators/direct"}, {http.MethodDelete, "/wiki/page"}, {http.MethodPatch, ""},
	} {
		_, e = s.forge(ctx, write.method, "/repos/alice/example"+write.path, credential, nil, nil)
		if !errors.Is(e, errLifecycleBlocked) || native.writes.Load() != 1 {
			t.Fatal("unknown protection admitted another managed mutation", write.method, write.path, e)
		}
	}
	// Reads and inspection stay available, and replay never dispatches again.
	if _, e = s.currentRuleInventory(ctx, session.Value, credential, repositoryKey{"alice", "example"}, m.RepositoryId, m.OwnerId); e != nil {
		t.Fatal("policy inspection blocked", e)
	}
	again, e := s.MutateRepositoryRules(ctx, req)
	if e != nil || again.Msg.Operation.Phase != "DISPATCH_UNKNOWN" || native.writes.Load() != 1 {
		t.Fatal("unknown original replay dispatched")
	}
	for _, lock := range []func(context.Context) error{
		func(ctx context.Context) error {
			tx, e := db.BeginTx(ctx, nil)
			if e != nil {
				return e
			}
			defer tx.Rollback()
			_, e = s.lockRepositoryLifecycleTransaction(ctx, tx, 9007199254740993)
			return e
		},
		func(ctx context.Context) error {
			tx, e := db.BeginTx(ctx, nil)
			if e != nil {
				return e
			}
			defer tx.Rollback()
			_, e = s.lockFileMutation(ctx, tx, 9007199254740993)
			return e
		},
		func(ctx context.Context) error {
			tx, e := db.BeginTx(ctx, nil)
			if e != nil {
				return e
			}
			defer tx.Rollback()
			_, e = s.lockRefMutation(ctx, tx, 9007199254740993)
			return e
		},
	} {
		if e = lock(ctx); !errors.Is(e, errLifecycleBlocked) {
			t.Fatal("uncertain policy allowed write reservation", e)
		}
	}
	if e = s.protectionDispatchAllowed(ctx, db, 7); e != nil {
		t.Fatal("unrelated repository was blocked")
	}
	var id, user, actor int64
	if e = db.QueryRow(`SELECT id,user_id,actor_id FROM golf_repository_rule_mutations WHERE operation_id=$1`, m.OperationId).Scan(&id, &user, &actor); e != nil {
		t.Fatal(e)
	}
	digest, _ := protectionPayloadHash(map[string]string{"exact": "original"})
	p := protectionDispatchPermit{id, user, actor, 9007199254740993, s.config.ForgeURL, http.MethodPatch, "/repos/alice/example/branch_protections/main", digest}
	owned := context.WithValue(ctx, protectionDispatchPermitKey{}, p)
	if e = s.protectionDispatchAllowed(owned, db, p.repository); e != nil {
		t.Fatal("original own dispatch identity refused", e)
	}
	if e = validateProtectionDispatchRequest(owned, p.method, p.path, map[string]string{"exact": "changed"}); !errors.Is(e, errLifecycleBlocked) {
		t.Fatal("permit retargeted body")
	}
	if e = validateProtectionDispatchRequest(owned, http.MethodPost, p.path, map[string]string{"exact": "original"}); !errors.Is(e, errLifecycleBlocked) {
		t.Fatal("permit retargeted method")
	}
	p.actor++
	foreign := context.WithValue(ctx, protectionDispatchPermitKey{}, p)
	if e = s.protectionDispatchAllowed(foreign, db, p.repository); !errors.Is(e, errLifecycleBlocked) {
		t.Fatal("foreign actor consumed policy permit")
	}
	// An application restart has no timer-based release or presumed rollback.
	restarted, e := New(s.config, db)
	if e != nil {
		t.Fatal(e)
	}
	if e = restarted.protectionDispatchAllowed(ctx, db, p.repository); !errors.Is(e, errLifecycleBlocked) {
		t.Fatal("restart released uncertain protection")
	}
}
