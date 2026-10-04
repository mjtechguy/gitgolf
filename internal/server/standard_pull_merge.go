package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
)

const standardMergeContract = "golf.pull.standard-native-merge.v1"

var errStandardMergeUnavailable = errors.New("standard native merge requires a current unprotected same-repository pull request")
var errStandardMergeUnresolved = errors.New("original standard native merge outcome is unresolved")

func standardMergeRPCError(e error) error {
	if errors.Is(e, errRepositoryAccessConflict) {
		return connect.NewError(connect.CodeFailedPrecondition, errors.New("The original merge operation has a different intent. Inspect its original outcome."))
	}
	if errors.Is(e, errStandardMergeUnavailable) {
		return connect.NewError(connect.CodeFailedPrecondition, errors.New("Standard merge is available only for a current unprotected same-repository pull request."))
	}
	if errors.Is(e, errStandardMergeUnresolved) {
		return connect.NewError(connect.CodeFailedPrecondition, errors.New("Inspect the original merge operation; an unresolved operation cannot be retried or replaced."))
	}
	return lifecycleRPCError(e)
}

func validateStandardMerge(m *golfv1.SubmitStandardPullMergeRequest) error {
	if m.Selection == nil {
		return invalid("Select the original pull request comparison.")
	}
	key := keyFrom(m.Selection.Repository)
	if _, e := repositoryPath(key); e != nil {
		return e
	}
	for _, id := range []string{m.Selection.RepositoryId, m.Selection.PullRequestId, m.OwnerId} {
		if _, e := discussionID(id); e != nil {
			return e
		}
	}
	if e := pullNumber(m.Selection.Number); e != nil {
		return e
	}
	if !creationKey.MatchString(m.OperationId) || !issueRevisionPattern.MatchString(m.ExpectedPullRevision) || !objectID.MatchString(m.Selection.HeadCommitId) || !objectID.MatchString(m.Selection.BaseCommitId) || len(m.Selection.HeadCommitId) != len(m.Selection.BaseCommitId) {
		return invalid("Bind the original operation, revision and full head/base commits.")
	}
	for _, ref := range []string{m.SourceRef, m.TargetRef} {
		if len(ref) > 1024 || !validRef(ref) || strings.HasPrefix(ref, "refs/") {
			return invalid("Select current named source and target branches.")
		}
	}
	if m.SourceRef == m.TargetRef || !discussionText(m.CommitTitle, 255) || !discussionText(m.CommitMessage, 6000) || m.CommitTitle != "" && !pullTitle(m.CommitTitle) {
		return invalid("Choose different branches and a bounded trimmed merge title/message.")
	}
	return nil
}
func standardMergeFingerprint(m *golfv1.SubmitStandardPullMergeRequest) []byte {
	c := proto.Clone(m).(*golfv1.SubmitStandardPullMergeRequest)
	c.OperationId = ""
	encoded, _ := proto.MarshalOptions{Deterministic: true}.Marshal(c)
	h := sha256.Sum256(encoded)
	return h[:]
}

type standardMergeRecord struct {
	ID, UserID, ActorID, RepositoryID, OwnerID, PullID, Number                                                              int64
	ForgeURL, OperationID, Owner, Name, Revision, Head, Base, SourceRef, TargetRef, Phase, MergeCommit, ActualBase, Failure string
	Fingerprint                                                                                                             []byte
	Created, Updated                                                                                                        time.Time
}

const standardMergeColumns = `id,user_id,forge_url,actor_id,operation_id,repository_id,owner_id,repository_owner,repository_name,pull_request_id,number,expected_pull_revision,head_commit_id,observed_base_commit_id,source_ref,target_ref,input_fingerprint,phase,merge_commit_id,actual_base_commit_id,failure_code,created_at,updated_at`

func scanStandardMerge(row interface{ Scan(...any) error }) (r standardMergeRecord, e error) {
	e = row.Scan(&r.ID, &r.UserID, &r.ForgeURL, &r.ActorID, &r.OperationID, &r.RepositoryID, &r.OwnerID, &r.Owner, &r.Name, &r.PullID, &r.Number, &r.Revision, &r.Head, &r.Base, &r.SourceRef, &r.TargetRef, &r.Fingerprint, &r.Phase, &r.MergeCommit, &r.ActualBase, &r.Failure, &r.Created, &r.Updated)
	return
}
func standardMergeWire(r standardMergeRecord) *golfv1.StandardPullMergeOperation {
	return &golfv1.StandardPullMergeOperation{OperationId: r.OperationID, ActorId: strconv.FormatInt(r.ActorID, 10), Repository: &golfv1.RepositoryKey{Owner: r.Owner, Name: r.Name}, RepositoryId: strconv.FormatInt(r.RepositoryID, 10), OwnerId: strconv.FormatInt(r.OwnerID, 10), PullRequestId: strconv.FormatInt(r.PullID, 10), Number: uint32(r.Number), ExpectedPullRevision: r.Revision, HeadCommitId: r.Head, ObservedBaseCommitId: r.Base, SourceRef: r.SourceRef, TargetRef: r.TargetRef, Phase: golfv1.StandardPullMergePhase(golfv1.StandardPullMergePhase_value["STANDARD_PULL_MERGE_PHASE_"+r.Phase]), MergeCommitId: r.MergeCommit, ActualBaseCommitId: r.ActualBase, FailureCode: r.Failure, CreatedAt: r.Created.UTC().Format(time.RFC3339Nano), UpdatedAt: r.Updated.UTC().Format(time.RFC3339Nano), Method: "merge", Contract: standardMergeContract}
}
func standardMergeTarget(r standardMergeRecord, m *golfv1.GetStandardPullMergeOperationRequest) bool {
	return r.Owner == m.Repository.GetOwner() && r.Name == m.Repository.GetName() && strconv.FormatInt(r.RepositoryID, 10) == m.RepositoryId && strconv.FormatInt(r.OwnerID, 10) == m.OwnerId && strconv.FormatInt(r.PullID, 10) == m.PullRequestId && uint32(r.Number) == m.Number
}
func standardMergeStatusRequest(m *golfv1.SubmitStandardPullMergeRequest) *golfv1.GetStandardPullMergeOperationRequest {
	return &golfv1.GetStandardPullMergeOperationRequest{Repository: m.Selection.Repository, RepositoryId: m.Selection.RepositoryId, OwnerId: m.OwnerId, PullRequestId: m.Selection.PullRequestId, Number: m.Selection.Number, OperationId: m.OperationId}
}
func (s *Server) standardMergeAuthority(ctx context.Context, session string, token forgeCredential, key repositoryKey, repoID, ownerID string) (actor User, e error) {
	e = s.withForgeCaller(ctx, session, token, func(caller User) error {
		_, current, e := s.gitCurrentTarget(ctx, token, key, repoID, ownerID, true)
		if e != nil {
			return e
		}
		if current.ID != caller.ID {
			return errUnauthenticated
		}
		actor = current
		return nil
	})
	return
}
func (s *Server) ownStandardMerge(ctx context.Context, session string, token forgeCredential, id string) (r standardMergeRecord, e error) {
	e = s.withManagedSession(ctx, session, token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		r, e = scanStandardMerge(s.db.QueryRowContext(ctx, `SELECT `+standardMergeColumns+` FROM golf_standard_pull_merges WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, id))
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	return
}

// B is an observed preflight context, not a native expected-base argument. These
// reads do not lock external/native writers or authorize protected integration.
func (s *Server) standardMergePreflight(ctx context.Context, session string, token forgeCredential, m *golfv1.SubmitStandardPullMergeRequest) error {
	key := keyFrom(m.Selection.Repository)
	if _, e := s.standardMergeAuthority(ctx, session, token, key, m.Selection.RepositoryId, m.OwnerId); e != nil {
		return e
	}
	e := s.withPullSelection(ctx, session, token, m.Selection, func(base string, repo Repository, pull forgePull) error {
		if pullRevision(pull) != m.ExpectedPullRevision {
			return errPullSnapshotChanged
		}
		if pull.State != "open" || pull.Draft == nil || *pull.Draft || pull.Merged == nil || *pull.Merged || pull.Head.RepositoryID != repo.ID || pull.Head.Ref != m.SourceRef || pull.Base.Ref != m.TargetRef || strings.HasPrefix(pull.Head.Ref, "refs/") {
			return errStandardMergeUnavailable
		}
		source, e := s.exactSourceBranch(ctx, base, token, m.SourceRef)
		if e != nil {
			return e
		}
		if source != m.Selection.HeadCommitId {
			return errPullSnapshotChanged
		}
		target, e := s.readMergeBranch(ctx, token, base, m.TargetRef)
		if e != nil {
			return e
		}
		if *target.Protected || !*target.UserCanMerge {
			return errStandardMergeUnavailable
		}
		if target.Commit.ID != m.Selection.BaseCommitId {
			return errPullSnapshotChanged
		}
		var raw forgeRulesRepository
		if _, e = s.forge(ctx, http.MethodGet, base, token, nil, &raw); e != nil {
			return e
		}
		config, e := wireMergeConfiguration(raw)
		if e != nil {
			return e
		}
		if raw.ID != repo.ID || raw.Owner == nil || strconv.FormatInt(raw.Owner.ID, 10) != m.OwnerId || !config.AllowMergeCommits {
			return errStandardMergeUnavailable
		}
		latest, e := s.readPull(ctx, token, base, repo, m.Selection.Number)
		if e != nil {
			return e
		}
		if pullRevision(latest) != m.ExpectedPullRevision {
			return errPullSnapshotChanged
		}
		return nil
	})
	if e != nil {
		return e
	}
	_, e = s.standardMergeAuthority(ctx, session, token, key, m.Selection.RepositoryId, m.OwnerId)
	return e
}

// The native merge API returns no immutable commit receipt. Acknowledged
// success must be checked independently; failures never adopt a later merge.
func (s *Server) standardMergeReceipt(ctx context.Context, session string, token forgeCredential, r standardMergeRecord) (commit, actualBase string, e error) {
	key := repositoryKey{r.Owner, r.Name}
	if _, e = s.standardMergeAuthority(ctx, session, token, key, strconv.FormatInt(r.RepositoryID, 10), strconv.FormatInt(r.OwnerID, 10)); e != nil {
		return
	}
	e = s.withRepositoryRead(ctx, session, token, key, func(base string, repo Repository) error {
		if repo.ID != r.RepositoryID {
			return errPullSnapshotChanged
		}
		p, e := s.readPull(ctx, token, base, repo, uint32(r.Number))
		if e != nil {
			return e
		}
		if p.ID != r.PullID || p.Merged == nil || !*p.Merged || p.State != "closed" || p.MergeCommitID == nil || !objectID.MatchString(*p.MergeCommitID) || len(*p.MergeCommitID) != len(r.Head) || p.Head.SHA != r.Head || p.Head.RepositoryID != r.RepositoryID || p.Base.Ref != r.TargetRef || p.Head.Ref != r.SourceRef {
			return errInvalidForgeResponse
		}
		var object struct {
			SHA     string `json:"sha"`
			Parents []struct {
				SHA string `json:"sha"`
			} `json:"parents"`
		}
		if _, e = s.forge(ctx, http.MethodGet, base+"/git/commits/"+*p.MergeCommitID, token, nil, &object); e != nil {
			return e
		}
		if object.SHA != *p.MergeCommitID || len(object.Parents) != 2 || object.Parents[1].SHA != r.Head || !objectID.MatchString(object.Parents[0].SHA) || len(object.Parents[0].SHA) != len(r.Head) {
			return errInvalidForgeResponse
		}
		target, e := s.exactSourceBranch(ctx, base, token, r.TargetRef)
		if e != nil {
			return e
		}
		if target != object.SHA {
			return errPullSnapshotChanged
		}
		commit, actualBase = object.SHA, object.Parents[0].SHA
		return nil
	})
	if e != nil {
		return
	}
	_, e = s.standardMergeAuthority(ctx, session, token, key, strconv.FormatInt(r.RepositoryID, 10), strconv.FormatInt(r.OwnerID, 10))
	return
}

func (s *Server) advanceStandardMerge(ctx context.Context, session string, token forgeCredential, r standardMergeRecord, phase, commit, base string) (updated standardMergeRecord, e error) {
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return r, e
	}
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		if c.UserID != r.UserID || actor.ID != r.ActorID {
			return errUnauthenticated
		}
		if _, e := tx.ExecContext(ctx, `SELECT golf_standard_pull_merge_lock($1,$2,$3)`, r.ForgeURL, r.RepositoryID, r.PullID); e != nil {
			return errStorageUnavailable
		}
		if phase == "SUCCEEDED" {
			currentCommit, currentBase, proofErr := s.standardMergeReceipt(ctx, session, token, r)
			if proofErr != nil {
				return proofErr
			}
			if currentCommit != commit || currentBase != base {
				return errPullSnapshotChanged
			}
		}
		failure := ""
		if phase == "REJECTED" {
			failure = "preflight_refused"
		}
		var e error
		updated, e = scanStandardMerge(tx.QueryRowContext(ctx, `UPDATE golf_standard_pull_merges SET phase=$1,merge_commit_id=$2,actual_base_commit_id=$3,failure_code=$4 WHERE id=$5 AND user_id=$6 AND forge_url=$7 AND phase=$8 RETURNING `+standardMergeColumns, phase, commit, base, failure, r.ID, r.UserID, r.ForgeURL, r.Phase))
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	return
}

func (s *Server) GetStandardPullMergeOperation(ctx context.Context, req *connect.Request[golfv1.GetStandardPullMergeOperationRequest]) (*connect.Response[golfv1.GetStandardPullMergeOperationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if _, e := repositoryPath(keyFrom(m.Repository)); e != nil {
		return nil, standardMergeRPCError(e)
	}
	for _, id := range []string{m.RepositoryId, m.OwnerId, m.PullRequestId} {
		if _, e := discussionID(id); e != nil {
			return nil, standardMergeRPCError(e)
		}
	}
	if !creationKey.MatchString(m.OperationId) || pullNumber(m.Number) != nil {
		return nil, standardMergeRPCError(invalid("Select the original merge operation and exact native target."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if _, e = s.standardMergeAuthority(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId); e != nil {
		return nil, standardMergeRPCError(e)
	}
	r, e := s.ownStandardMerge(ctx, session, token, m.OperationId)
	if e != nil {
		return nil, standardMergeRPCError(e)
	}
	if !standardMergeTarget(r, m) {
		return nil, standardMergeRPCError(errPullSnapshotChanged)
	}
	if _, e = s.standardMergeAuthority(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId); e != nil {
		return nil, standardMergeRPCError(e)
	}
	return connect.NewResponse(&golfv1.GetStandardPullMergeOperationResponse{Operation: standardMergeWire(r)}), nil
}

func (s *Server) SubmitStandardPullMerge(ctx context.Context, req *connect.Request[golfv1.SubmitStandardPullMergeRequest]) (*connect.Response[golfv1.SubmitStandardPullMergeResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = validateStandardMerge(m); e != nil {
		return nil, standardMergeRPCError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	key := keyFrom(m.Selection.Repository)
	actor, e := s.standardMergeAuthority(ctx, session, token, key, m.Selection.RepositoryId, m.OwnerId)
	if e != nil {
		return nil, standardMergeRPCError(e)
	}
	repoID, _ := discussionID(m.Selection.RepositoryId)
	ownerID, _ := discussionID(m.OwnerId)
	pullID, _ := discussionID(m.Selection.PullRequestId)
	fingerprint := standardMergeFingerprint(m)
	var r standardMergeRecord
	fresh := false
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		held, e := s.lockRepositoryLifecycleTransaction(ctx, tx, repoID)
		if e != nil {
			return e
		}
		if _, e = tx.ExecContext(held, `SELECT golf_standard_pull_merge_lock($1,$2,$3)`, s.config.GiteaURL, repoID, pullID); e != nil {
			return errStorageUnavailable
		}
		r, e = scanStandardMerge(tx.QueryRowContext(held, `SELECT `+standardMergeColumns+` FROM golf_standard_pull_merges WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, m.OperationId))
		if e == nil {
			if !bytes.Equal(r.Fingerprint, fingerprint) {
				return errRepositoryAccessConflict
			}
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		r, e = scanStandardMerge(tx.QueryRowContext(held, `INSERT INTO golf_standard_pull_merges(user_id,forge_url,actor_id,operation_id,repository_id,owner_id,repository_owner,repository_name,pull_request_id,number,expected_pull_revision,head_commit_id,observed_base_commit_id,source_ref,target_ref,input_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING `+standardMergeColumns, c.UserID, s.config.GiteaURL, actor.ID, m.OperationId, repoID, ownerID, key.Owner, key.Name, pullID, m.Selection.Number, m.ExpectedPullRevision, m.Selection.HeadCommitId, m.Selection.BaseCommitId, m.SourceRef, m.TargetRef, fingerprint))
		if e != nil {
			var state interface{ SQLState() string }
			if errors.As(e, &state) && state.SQLState() == "55000" {
				return errStandardMergeUnresolved
			}
			return errStorageUnavailable
		}
		fresh = true
		return nil
	})
	if e != nil {
		return nil, standardMergeRPCError(e)
	}
	if !fresh {
		return s.standardMergeSubmitStatus(ctx, session, token, m)
	}
	if e = s.standardMergePreflight(ctx, session, token, m); e != nil {
		var reject error
		r, reject = s.advanceStandardMerge(ctx, session, token, r, "REJECTED", "", "")
		if reject != nil {
			return nil, standardMergeRPCError(reject)
		}
		// No provider request was forwarded. Recheck private current authority before
		// returning even a no-effect receipt; loss of authority never reveals it.
		return s.standardMergeSubmitStatus(ctx, session, token, m)
	}
	r, e = s.advanceStandardMerge(ctx, session, token, r, "DISPATCH_UNKNOWN", "", "")
	if e != nil {
		return nil, standardMergeRPCError(e)
	}
	// Unknown is committed before the potentially effective native request. A
	// post-commit fence refusal remains unknown and is never reversed/replayed.
	dispatched := false
	var nativeErr error
	var commit, actualBase string
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		if c.UserID != r.UserID {
			return errUnauthenticated
		}
		held, e := s.lockRepositoryLifecycleTransaction(ctx, tx, repoID)
		if e != nil {
			return e
		}
		if _, e = tx.ExecContext(held, `SELECT golf_standard_pull_merge_lock($1,$2,$3)`, s.config.GiteaURL, repoID, pullID); e != nil {
			return errStorageUnavailable
		}
		if e = s.standardMergePreflight(held, session, token, m); e != nil {
			return e
		}
		path, _ := repositoryPath(key)
		dispatched = true
		_, nativeErr = s.forgeJSON(held, http.MethodPost, path+"/pulls/"+strconv.FormatUint(uint64(m.Selection.Number), 10)+"/merge", token, map[string]any{"do": "merge", "head_commit_id": m.Selection.HeadCommitId, "merge_title_field": m.CommitTitle, "merge_message_field": m.CommitMessage, "force_merge": false, "merge_when_checks_succeed": false, "delete_branch_after_merge": false}, nil, http.StatusOK)
		if nativeErr == nil {
			commit, actualBase, nativeErr = s.standardMergeReceipt(held, session, token, r)
		}
		return nil
	})
	if e != nil {
		return nil, standardMergeRPCError(e)
	}
	if dispatched && nativeErr == nil {
		// Final managed/current native authority fences apply again at persistence.
		if _, e = s.standardMergeAuthority(ctx, session, token, key, m.Selection.RepositoryId, m.OwnerId); e != nil {
			return nil, standardMergeRPCError(e)
		}
		r, e = s.advanceStandardMerge(ctx, session, token, r, "SUCCEEDED", commit, actualBase)
		if e != nil {
			return nil, standardMergeRPCError(e)
		}
	}
	// HTTP rejection, lost response, bad receipt or timeout stays unknown. Status
	// inspection does not adopt another actor's later matching merge.
	return s.standardMergeSubmitStatus(ctx, session, token, m)
}
func (s *Server) standardMergeSubmitStatus(ctx context.Context, session string, token forgeCredential, m *golfv1.SubmitStandardPullMergeRequest) (*connect.Response[golfv1.SubmitStandardPullMergeResponse], error) {
	if _, e := s.standardMergeAuthority(ctx, session, token, keyFrom(m.Selection.Repository), m.Selection.RepositoryId, m.OwnerId); e != nil {
		return nil, standardMergeRPCError(e)
	}
	r, e := s.ownStandardMerge(ctx, session, token, m.OperationId)
	if e != nil {
		return nil, standardMergeRPCError(e)
	}
	if !standardMergeTarget(r, standardMergeStatusRequest(m)) || !bytes.Equal(r.Fingerprint, standardMergeFingerprint(m)) {
		return nil, standardMergeRPCError(errRepositoryAccessConflict)
	}
	if _, e = s.standardMergeAuthority(ctx, session, token, keyFrom(m.Selection.Repository), m.Selection.RepositoryId, m.OwnerId); e != nil {
		return nil, standardMergeRPCError(e)
	}
	return connect.NewResponse(&golfv1.SubmitStandardPullMergeResponse{Operation: standardMergeWire(r)}), nil
}
