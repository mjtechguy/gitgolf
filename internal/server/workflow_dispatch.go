package server

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

func workflowDispatchTarget(m *golfv1.GetWorkflowDispatchRequest) (repositoryKey, int64, int64, error) {
	key := keyFrom(m.Repository)
	if _, e := repositoryPath(key); e != nil {
		return key, 0, 0, e
	}
	repo, e := discussionID(m.RepositoryId)
	if e != nil {
		return key, 0, 0, e
	}
	owner, e := discussionID(m.OwnerId)
	if e != nil {
		return key, 0, 0, e
	}
	if len(m.ProtoReflect().GetUnknown()) != 0 || !validWorkflowTypedInspection(m) || !objectID.MatchString(m.CommitId) || !executionWorkflowPath(m.WorkflowPath) || !creationKey.MatchString(m.IdempotencyKey) {
		return key, 0, 0, invalid("Inspect the original dispatch using its exact commit, workflow path and UUID v4 key.")
	}
	return key, repo, owner, nil
}

func validWorkflowTypedInspection(m *golfv1.GetWorkflowDispatchRequest) bool {
	any := m.InputContract != nil || m.SubmittedSha256 != nil || m.SchemaSha256 != nil || m.WorkflowBlobId != nil || m.EffectiveSha256 != nil
	if !any {
		return true
	}
	return m.InputContract != nil && m.GetInputContract() == workflowManualInputsContract && m.SubmittedSha256 != nil && m.SchemaSha256 != nil && m.WorkflowBlobId != nil && m.EffectiveSha256 != nil && workflowDispatchSHA256(m.GetSubmittedSha256()) && workflowDispatchSHA256(m.GetSchemaSha256()) && workflowDispatchSHA256(m.GetEffectiveSha256()) && objectID.MatchString(m.GetWorkflowBlobId())
}

func workflowDispatchMatches(r workflowRunRecord, key repositoryKey, repo, owner, actor int64, m *golfv1.GetWorkflowDispatchRequest) bool {
	if r.Origin != "manual" || r.UserID != actor || r.RepositoryID != repo || r.OwnerID != owner || !strings.EqualFold(r.RepositoryOwner, key.Owner) || !strings.EqualFold(r.RepositoryName, key.Name) || r.CommitID != m.CommitId || r.WorkflowPath != m.WorkflowPath || r.IdempotencyKey != m.IdempotencyKey {
		return false
	}
	if r.InputContract == "" {
		return m.InputContract == nil && bytes.Equal(r.InputHash, workflowIntentHash(key, m.CommitId, m.WorkflowPath, repo, owner))
	}
	return m.InputContract != nil && r.InputContract == m.GetInputContract() && r.BlobID == m.GetWorkflowBlobId() && r.SchemaSHA256 == m.GetSchemaSha256() && r.SubmittedSHA256 == m.GetSubmittedSha256() && r.EffectiveSHA256 == m.GetEffectiveSha256() && bytes.Equal(r.InputHash, workflowTypedIntentHash(key, m.CommitId, m.WorkflowPath, repo, owner, m.GetWorkflowBlobId(), m.GetSchemaSha256(), m.GetSubmittedSha256(), m.GetEffectiveSha256(), m.GetInputContract()))
}

// GetWorkflowDispatch inspects only the caller's original manual key. A missing
// row never proves that a potentially admitted request had no effect. Only an
// originally full-SHA Ref is inspectable here: a named Ref has a different
// immutable intent hash, even when its resolved commit is unchanged. This read
// neither compiles source nor invokes dispatch, secret release or runner work.
func (s *Server) GetWorkflowDispatch(ctx context.Context, req *connect.Request[golfv1.GetWorkflowDispatchRequest]) (*connect.Response[golfv1.GetWorkflowDispatchResponse], error) {
	credential, e := workflowBrowserToken(ctx)
	if e != nil {
		return nil, rpcError(e)
	}
	m := req.Msg
	key, repo, owner, e := workflowDispatchTarget(m)
	if e != nil {
		return nil, rpcError(e)
	}
	out := &golfv1.GetWorkflowDispatchResponse{}
	e = s.withWorkflowRepository(ctx, s.cookieValue(req.Header()), credential, key, repo, owner, true, func(user User, access *golfv1.RepositoryAccess) error {
		return s.workflowTransaction(ctx, s.cookieValue(req.Header()), user.ID, func(tx *sql.Tx, actor database.LockManagedSessionRow, _ []byte) error {
			// Existing unique(forge_url,user_id,origin,idempotency_key) provides an
			// exact indexed lookup. No other actor or key inventory is loaded.
			r, err := scanWorkflowRun(tx.QueryRowContext(ctx, "SELECT "+workflowRunColumns+" FROM golf_workflow_runs WHERE forge_url=$1 AND user_id=$2 AND origin='manual' AND idempotency_key=$3", s.config.ForgeURL, actor.UserID, m.IdempotencyKey))
			if errors.Is(err, sql.ErrNoRows) {
				return errResourceNotFound
			}
			if err != nil {
				return errStorageUnavailable
			}
			if !workflowDispatchMatches(r, key, repo, owner, actor.UserID, m) || r.OrganizationOwned != access.OrganizationOwned {
				return errWorkflowRunConflict
			}
			r.OutputState, r.ExecutionBindingID, r.ExecutionBindingVersion, err = observeExecutionOutput(ctx, tx, r.ID)
			if err != nil {
				return err
			}
			out.Repository = &golfv1.RepositoryKey{Owner: r.RepositoryOwner, Name: r.RepositoryName}
			out.RepositoryId, out.OwnerId = strconv.FormatInt(r.RepositoryID, 10), strconv.FormatInt(r.OwnerID, 10)
			out.NativeActorId, out.IdempotencyKey = strconv.FormatInt(user.ID, 10), r.IdempotencyKey
			// Historical execution-policy changes do not conceal an admitted
			// outcome. This receipt grants no execution or cancellation action.
			out.SubmittedSha256, out.EffectiveSha256, out.SchemaSha256, out.InputContract = r.SubmittedSHA256, r.EffectiveSHA256, r.SchemaSHA256, r.InputContract
			out.Run = wireWorkflowRun(r, false)
			return nil
		})
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(out), nil
}
