package server

import (
	"bytes"
	"connectrpc.com/connect"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
	"net/http"
	"strconv"
	"time"
)

type mirrorConfiguration struct {
	ID          int64  `json:"id"`
	Mirror      *bool  `json:"mirror"`
	Interval    string `json:"mirror_interval"`
	OriginalURL string `json:"original_url"`
	Archived    *bool  `json:"archived"`
}

func mirrorRevision(row mirrorConfiguration) string {
	return resourceHash([]any{row.ID, row.Mirror, row.Interval, row.OriginalURL, row.Archived})
}
func (s *Server) mirrorAuthority(ctx context.Context, session string, token forgeCredential, key repositoryKey, id, owner string) (actor User, row mirrorConfiguration, e error) {
	e = s.withForgeCaller(ctx, session, token, func(user User) error {
		actor = user
		a, e := s.rulesAuthority(ctx, token, key, user)
		if e != nil {
			return e
		}
		if a.RepositoryId != id || a.OwnerId != owner {
			return errRepositoryAccessConflict
		}
		base, _ := repositoryPath(key)
		if _, e = s.forge(ctx, http.MethodGet, base, token, nil, &row); e != nil {
			return e
		}
		if strconv.FormatInt(row.ID, 10) != id || row.Mirror == nil || !*row.Mirror || row.Archived == nil || *row.Archived || !profileText(row.Interval, 100, false) {
			return errRepositoryAccessConflict
		}
		return nil
	})
	return
}
func mirrorFingerprint(m *golfv1.SubmitRepositoryMirrorOperationRequest) []byte {
	c := proto.Clone(m).(*golfv1.SubmitRepositoryMirrorOperationRequest)
	c.OperationId = ""
	b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(c)
	h := sha256.Sum256(b)
	return h[:]
}
func validateMirrorOperation(m *golfv1.SubmitRepositoryMirrorOperationRequest) error {
	if _, e := repositoryPath(keyFrom(m.Repository)); e != nil {
		return e
	}
	for _, id := range []string{m.RepositoryId, m.OwnerId} {
		if _, e := discussionID(id); e != nil {
			return e
		}
	}
	if !creationKey.MatchString(m.OperationId) || !validAccessRevision(m.ExpectedConfigurationRevision) || m.Kind < 1 || m.Kind > 2 {
		return invalid("Bind the original mirror operation and observed configuration.")
	}
	if m.Kind == 2 {
		if m.Interval != "" {
			return invalid("Synchronization cannot edit the interval.")
		}
		return nil
	}
	d, e := time.ParseDuration(m.Interval)
	if e != nil || d < time.Hour || d > 30*24*time.Hour || d%time.Minute != 0 || !ruleText(m.Interval, 100, false) {
		return invalid("Use a Go duration from1 hour to30 days in whole minutes.")
	}
	return nil
}

type mirrorRecord struct {
	ID, UserID, ActorID, RepoID, OwnerID                              int64
	Forge, Operation, Owner, Name, Revision, Interval, Phase, Failure string
	Kind                                                              int32
	Fingerprint                                                       []byte
	Accepted                                                          bool
}

const mirrorColumns = `id,user_id,forge_url,actor_id,operation_id,repository_owner,repository_name,repository_id,owner_id,expected_revision,kind,interval_value,input_fingerprint,phase,sync_accepted,failure_code`

func scanMirror(row interface{ Scan(...any) error }) (r mirrorRecord, e error) {
	e = row.Scan(&r.ID, &r.UserID, &r.Forge, &r.ActorID, &r.Operation, &r.Owner, &r.Name, &r.RepoID, &r.OwnerID, &r.Revision, &r.Kind, &r.Interval, &r.Fingerprint, &r.Phase, &r.Accepted, &r.Failure)
	return
}
func mirrorWire(r mirrorRecord) *golfv1.RepositoryMirrorOperation {
	return &golfv1.RepositoryMirrorOperation{Contract: "golf.repository.mirror-operation.v1", OperationId: r.Operation, ActorId: strconv.FormatInt(r.ActorID, 10), Repository: &golfv1.RepositoryKey{Owner: r.Owner, Name: r.Name}, RepositoryId: strconv.FormatInt(r.RepoID, 10), OwnerId: strconv.FormatInt(r.OwnerID, 10), ExpectedConfigurationRevision: r.Revision, Kind: golfv1.RepositoryMirrorOperationKind(r.Kind), Interval: r.Interval, InputSha256: hex.EncodeToString(r.Fingerprint), Phase: golfv1.RepositoryReleasePublicationPhase(golfv1.RepositoryReleasePublicationPhase_value["REPOSITORY_RELEASE_PUBLICATION_PHASE_"+r.Phase]), SynchronizationRequestAccepted: r.Accepted, FailureCode: r.Failure}
}
func (s *Server) mirrorRecordAuthority(ctx context.Context, session string, token forgeCredential, r mirrorRecord) error {
	actor, _, e := s.mirrorAuthority(ctx, session, token, repositoryKey{r.Owner, r.Name}, strconv.FormatInt(r.RepoID, 10), strconv.FormatInt(r.OwnerID, 10))
	if e == nil && actor.ID != r.ActorID {
		return errUnauthenticated
	}
	return e
}
func (s *Server) mirrorPreflight(ctx context.Context, session string, token forgeCredential, m *golfv1.SubmitRepositoryMirrorOperationRequest) error {
	_, row, e := s.mirrorAuthority(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId)
	if e != nil {
		return e
	}
	if mirrorRevision(row) != m.ExpectedConfigurationRevision {
		return errRepositoryAccessConflict
	}
	return nil
}
func mirrorNative(m *golfv1.SubmitRepositoryMirrorOperationRequest) (method, suffix string, payload any) {
	if m.Kind == 2 {
		return http.MethodPost, "/mirror-sync", nil
	}
	return http.MethodPatch, "", map[string]string{"mirror_interval": m.Interval}
}

type mirrorPermitKey struct{}
type mirrorPermit struct {
	record  mirrorRecord
	request *golfv1.SubmitRepositoryMirrorOperationRequest
}

func (s *Server) validateMirrorPermit(ctx context.Context, tx *sql.Tx, p mirrorPermit, repo lifecycleNativeRepository, key repositoryKey, method, path string, input any) error {
	r := p.record
	want, suffix, payload := mirrorNative(p.request)
	base, _ := repositoryPath(key)
	a, e := json.Marshal(input)
	b, f := json.Marshal(payload)
	if tx == nil || repo.ID != r.RepoID || key.Owner != r.Owner || key.Name != r.Name || method != want || path != base+suffix || e != nil || f != nil || !bytes.Equal(a, b) || !bytes.Equal(r.Fingerprint, mirrorFingerprint(p.request)) {
		return errLifecycleBlocked
	}
	row, e := scanMirror(tx.QueryRowContext(ctx, `SELECT `+mirrorColumns+` FROM golf_repository_mirror_operations WHERE id=$1 AND user_id=$2 AND forge_url=$3 AND phase='DISPATCH_UNKNOWN'`, r.ID, r.UserID, r.Forge))
	if e != nil || row.ActorID != r.ActorID || !bytes.Equal(row.Fingerprint, r.Fingerprint) {
		return errLifecycleBlocked
	}
	var blocked bool
	e = tx.QueryRowContext(ctx, `SELECT golf_repository_lifecycle_blocked_before_mirror_operation($1,$2) OR EXISTS(SELECT 1 FROM golf_standard_pull_merges WHERE forge_url=$1 AND (repository_id=$2 OR source_repository_id=$2) AND phase IN ('RESERVED','DISPATCH_UNKNOWN'))`, r.Forge, r.RepoID).Scan(&blocked)
	if e != nil {
		return errStorageUnavailable
	}
	if blocked {
		return errLifecycleBlocked
	}
	return nil
}
func (s *Server) GetRepositoryMirrorOperation(ctx context.Context, req *connect.Request[golfv1.GetRepositoryMirrorOperationRequest]) (*connect.Response[golfv1.GetRepositoryMirrorOperationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if _, e = repositoryPath(keyFrom(m.Repository)); e != nil {
		return nil, rpcError(e)
	}
	for _, id := range []string{m.RepositoryId, m.OwnerId} {
		if _, e = discussionID(id); e != nil {
			return nil, rpcError(e)
		}
	}
	if !creationKey.MatchString(m.OperationId) {
		return nil, rpcError(invalid("Inspect the original mirror operation."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var r mirrorRecord
	e = s.withManagedSession(ctx, session, token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		r, e = scanMirror(s.db.QueryRowContext(ctx, `SELECT `+mirrorColumns+` FROM golf_repository_mirror_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, m.OperationId))
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	if e == nil && (r.Owner != m.Repository.Owner || r.Name != m.Repository.Name || strconv.FormatInt(r.RepoID, 10) != m.RepositoryId || strconv.FormatInt(r.OwnerID, 10) != m.OwnerId) {
		e = errRepositoryAccessConflict
	}
	if e == nil {
		e = s.mirrorRecordAuthority(ctx, session, token, r)
	}
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.GetRepositoryMirrorOperationResponse{Operation: mirrorWire(r)}), nil
}
func (s *Server) SubmitRepositoryMirrorOperation(ctx context.Context, req *connect.Request[golfv1.SubmitRepositoryMirrorOperationRequest]) (*connect.Response[golfv1.SubmitRepositoryMirrorOperationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = validateMirrorOperation(m); e != nil {
		return nil, rpcError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	actor, _, e := s.mirrorAuthority(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId)
	if e != nil {
		return nil, rpcError(e)
	}
	repoID, _ := discussionID(m.RepositoryId)
	ownerID, _ := discussionID(m.OwnerId)
	fingerprint := mirrorFingerprint(m)
	var r mirrorRecord
	fresh := false
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		held, e := s.lockWikiOperation(ctx, tx, repoID)
		if e != nil {
			return e
		}
		r, e = scanMirror(tx.QueryRowContext(held, `SELECT `+mirrorColumns+` FROM golf_repository_mirror_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, m.OperationId))
		if e == nil {
			if !bytes.Equal(r.Fingerprint, fingerprint) {
				return errRepositoryAccessConflict
			}
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		r, e = scanMirror(tx.QueryRowContext(held, `INSERT INTO golf_repository_mirror_operations(user_id,forge_url,actor_id,operation_id,repository_owner,repository_name,repository_id,owner_id,expected_revision,kind,interval_value,input_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING `+mirrorColumns, c.UserID, s.config.GiteaURL, actor.ID, m.OperationId, m.Repository.Owner, m.Repository.Name, repoID, ownerID, m.ExpectedConfigurationRevision, int32(m.Kind), m.Interval, fingerprint))
		if e != nil {
			return errStorageUnavailable
		}
		fresh = true
		return nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	if fresh {
		phase := "DISPATCH_UNKNOWN"
		failure := ""
		if e = s.mirrorPreflight(ctx, session, token, m); e != nil {
			phase = "REJECTED"
			failure = "preflight_refused"
		}
		e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
			held, e := s.lockWikiOperation(ctx, tx, r.RepoID)
			if e != nil {
				return e
			}
			if c.UserID != r.UserID {
				return errUnauthenticated
			}
			if e = s.mirrorRecordAuthority(held, session, token, r); e != nil {
				return e
			}
			r, e = scanMirror(tx.QueryRowContext(held, `UPDATE golf_repository_mirror_operations SET phase=$1,failure_code=$2 WHERE id=$3 AND phase='RESERVED' RETURNING `+mirrorColumns, phase, failure, r.ID))
			if e != nil {
				return errStorageUnavailable
			}
			return nil
		})
		if e != nil {
			return nil, rpcError(e)
		}
		if phase == "DISPATCH_UNKNOWN" {
			e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
				held, e := s.lockWikiOperation(ctx, tx, r.RepoID)
				if e != nil {
					return e
				}
				if c.UserID != r.UserID {
					return errUnauthenticated
				}
				if e = s.mirrorPreflight(held, session, token, m); e != nil {
					return e
				}
				_, before, e := s.mirrorAuthority(held, session, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId)
				if e != nil || mirrorRevision(before) != m.ExpectedConfigurationRevision {
					return errRepositoryAccessConflict
				}
				held = context.WithValue(held, mirrorPermitKey{}, mirrorPermit{r, proto.Clone(m).(*golfv1.SubmitRepositoryMirrorOperationRequest)})
				method, suffix, payload := mirrorNative(m)
				base, _ := repositoryPath(keyFrom(m.Repository))
				if _, e = s.forgeJSON(held, method, base+suffix, token, payload, nil, http.StatusOK); e != nil {
					return nil
				}
				_, after, e := s.mirrorAuthority(held, session, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId)
				if e != nil {
					return nil
				}
				if m.Kind == 1 {
					before.Interval = m.Interval
				}
				if mirrorRevision(after) != mirrorRevision(before) {
					return nil
				}
				r, e = scanMirror(tx.QueryRowContext(held, `UPDATE golf_repository_mirror_operations SET phase='SUCCEEDED',sync_accepted=$1 WHERE id=$2 AND phase='DISPATCH_UNKNOWN' RETURNING `+mirrorColumns, m.Kind == 2, r.ID))
				if e != nil {
					return errStorageUnavailable
				}
				return nil
			})
			if e != nil {
				return nil, rpcError(e)
			}
		}
	}
	if e = s.mirrorRecordAuthority(ctx, session, token, r); e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.SubmitRepositoryMirrorOperationResponse{Operation: mirrorWire(r)}), nil
}
