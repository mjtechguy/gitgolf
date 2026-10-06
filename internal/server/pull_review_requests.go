package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
)

const reviewRequestContract = "golf.pull.review-request.v1"

func reviewRequestTarget(key repositoryKey, repoID, pullID string, number uint32) error {
	if _, e := repositoryPath(key); e != nil {
		return e
	}
	for _, v := range []string{repoID, pullID} {
		if _, e := discussionID(v); e != nil {
			return e
		}
	}
	return pullNumber(number)
}
func validateReviewRequest(m *golfv1.SubmitPullReviewRequestRequest) error {
	if e := reviewRequestTarget(keyFrom(m.Repository), m.RepositoryId, m.PullRequestId, m.Number); e != nil {
		return e
	}
	if _, e := discussionID(m.ReviewerId); e != nil {
		return e
	}
	if !validOrganizationName(m.ReviewerLogin) || !creationKey.MatchString(m.OperationId) || !issueRevisionPattern.MatchString(m.ExpectedPullRevision) || !issueRevisionPattern.MatchString(m.ExpectedRequestsRevision) {
		return invalid("Select an exact reviewer, original PR/request revisions and operation.")
	}
	return nil
}
func reviewRequestBytes(m *golfv1.SubmitPullReviewRequestRequest) []byte {
	b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(m)
	return b
}
func reviewRequestFingerprint(m *golfv1.SubmitPullReviewRequestRequest) []byte {
	c := proto.Clone(m).(*golfv1.SubmitPullReviewRequestRequest)
	c.OperationId = ""
	h := sha256.Sum256(reviewRequestBytes(c))
	return h[:]
}

// Exact individual users or organization teams are changed. Review requests
// are collaboration state, not eligible approval or protected merge authority.
func (s *Server) reviewRequestSnapshot(ctx context.Context, session string, token forgeCredential, key repositoryKey, repoID, pullID string, number uint32) (*golfv1.GetPullReviewRequestsResponse, error) {
	var result *golfv1.GetPullReviewRequestsResponse
	e := s.withRepositoryRead(ctx, session, token, key, func(base string, repo Repository) error {
		if strconv.FormatInt(repo.ID, 10) != repoID {
			return errIssueTargetChanged
		}
		var row struct {
			forgePull
			Requested json.RawMessage `json:"requested_reviewers"`
			Teams     json.RawMessage `json:"requested_reviewers_teams"`
		}
		if _, e := s.forge(ctx, http.MethodGet, base+"/pulls/"+strconv.FormatUint(uint64(number), 10), token, nil, &row); e != nil {
			return e
		}
		if !validPull(row.forgePull, repo) || strconv.FormatInt(row.ID, 10) != pullID || row.Number != int64(number) || pullRevision(row.forgePull) == "" || len(row.Requested) == 0 {
			return errInvalidForgeResponse
		}
		var users []*User
		if string(row.Requested) != "null" && json.Unmarshal(row.Requested, &users) != nil {
			return errInvalidForgeResponse
		}
		if len(users) > 200 {
			return errForgeResponseTooLarge
		}
		seen := map[int64]bool{}
		seenLogin := map[string]bool{}
		for _, u := range users {
			if u == nil || u.ID <= 0 || !validOrganizationName(u.Login) || !validPullUser(u) || seen[u.ID] || seenLogin[u.Login] {
				return errInvalidForgeResponse
			}
			seen[u.ID] = true
			seenLogin[u.Login] = true
		}
		var teams []forgeOrganizationTeam
		if len(row.Teams) > 0 && string(row.Teams) != "null" && json.Unmarshal(row.Teams, &teams) != nil {
			return errInvalidForgeResponse
		}
		if len(teams) > 200 {
			return errForgeResponseTooLarge
		}
		teamIDs := map[int64]bool{}
		for _, team := range teams {
			if !validOrganizationTeam(team) || !validOrganizationName(team.Name) || teamIDs[team.ID] {
				return errInvalidForgeResponse
			}
			teamIDs[team.ID] = true
		}
		sort.Slice(teams, func(i, j int) bool { return teams[i].ID < teams[j].ID })
		sort.Slice(users, func(i, j int) bool { return users[i].ID < users[j].ID })
		identities := make([][]any, 0, len(users))
		wire := make([]*golfv1.User, 0, len(users))
		for _, u := range users {
			identities = append(identities, []any{u.ID, u.Login})
			wire = append(wire, wireUser(*u))
		}
		var caller struct {
			User
			SiteAdmin *bool `json:"is_admin"`
		}
		if _, e := s.forge(ctx, http.MethodGet, "/user", token, nil, &caller); e != nil {
			return e
		}
		if caller.ID <= 0 || caller.SiteAdmin == nil {
			return errInvalidForgeResponse
		}
		enabled, e := s.activeDiscussionUnit(ctx, token, base, repo, true)
		if e != nil {
			return e
		}
		manage := false
		if enabled && row.State == "open" && !*row.Merged {
			if row.User != nil && row.User.ID == caller.ID {
				manage = true
			} else if *caller.SiteAdmin {
				access, e := s.readRepositoryAccess(ctx, token, key, caller.User)
				if e != nil {
					return e
				}
				manage = access.CanManage
			} else {
				manage, e = s.milestoneEditAuthority(context.WithValue(ctx, pullDiscussionKey{}, true), token, base, repo)
				if e != nil {
					return e
				}
			}
		}
		var after struct {
			forgePull
			Requested json.RawMessage `json:"requested_reviewers"`
			Teams     json.RawMessage `json:"requested_reviewers_teams"`
		}
		if _, e = s.forge(ctx, http.MethodGet, base+"/pulls/"+strconv.FormatUint(uint64(number), 10), token, nil, &after); e != nil {
			return e
		}
		if !validPull(after.forgePull, repo) || after.ID != row.ID || after.Number != row.Number || pullRevision(after.forgePull) != pullRevision(row.forgePull) || !bytes.Equal(after.Requested, row.Requested) || !bytes.Equal(after.Teams, row.Teams) {
			return errPullSnapshotChanged
		}
		requestRevision := resourceHash(identities)
		if len(teams) > 0 {
			requestRevision = resourceHash(struct {
				Users [][]any
				Teams []forgeOrganizationTeam
			}{identities, teams})
		}
		result = &golfv1.GetPullReviewRequestsResponse{RepositoryId: repoID, PullRequestId: pullID, Number: number, PullRevision: pullRevision(row.forgePull), RequestsRevision: requestRevision, Reviewers: wire, CanManage: manage}
		for _, team := range teams {
			result.Teams = append(result.Teams, wireOrganizationTeam(team))
		}
		return nil
	})
	return result, e
}
func (s *Server) GetPullReviewRequests(ctx context.Context, req *connect.Request[golfv1.GetPullReviewRequestsRequest]) (*connect.Response[golfv1.GetPullReviewRequestsResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = reviewRequestTarget(keyFrom(m.Repository), m.RepositoryId, m.PullRequestId, m.Number); e != nil {
		return nil, rpcError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	r, e := s.reviewRequestSnapshot(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.PullRequestId, m.Number)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(r), nil
}
func (s *Server) reviewRequestPreflight(ctx context.Context, session string, token forgeCredential, m *golfv1.SubmitPullReviewRequestRequest) error {
	snap, e := s.reviewRequestSnapshot(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.PullRequestId, m.Number)
	if e != nil {
		return e
	}
	if !snap.CanManage {
		return errResourceNotFound
	}
	if snap.PullRevision != m.ExpectedPullRevision || snap.RequestsRevision != m.ExpectedRequestsRevision {
		return errPullSnapshotChanged
	}
	if m.ReviewerTeam {
		return s.reviewTeamPreflight(ctx, token, m, snap)
	}
	present := false
	for _, u := range snap.Reviewers {
		if u.Id == m.ReviewerId {
			if u.Login != m.ReviewerLogin {
				return errRepositoryAccessConflict
			}
			present = true
		}
	}
	if present == m.RequestReview {
		return errRepositoryAccessConflict
	}
	var user User
	if _, e = s.forge(ctx, http.MethodGet, "/users/"+m.ReviewerLogin, token, nil, &user); e != nil {
		return e
	}
	if strconv.FormatInt(user.ID, 10) != m.ReviewerId || user.Login != m.ReviewerLogin {
		return errRepositoryAccessConflict
	}
	base, _ := repositoryPath(keyFrom(m.Repository))
	permission, e := s.repositoryPermission(ctx, token, base, user)
	if e != nil {
		return e
	}
	if permission == "none" {
		return errResourceNotFound
	}
	return nil
}

type reviewRequestRecord struct {
	ID, UserID, ActorID, RepositoryID     int64
	ForgeURL, OperationID, Phase, Failure string
	Original, Fingerprint                 []byte
	Created, Updated                      time.Time
}

const reviewRequestColumns = `id,user_id,actor_id,repository_id,forge_url,operation_id,phase,failure_code,original,input_fingerprint,created_at,updated_at`

func scanReviewRequest(row interface{ Scan(...any) error }) (r reviewRequestRecord, e error) {
	e = row.Scan(&r.ID, &r.UserID, &r.ActorID, &r.RepositoryID, &r.ForgeURL, &r.OperationID, &r.Phase, &r.Failure, &r.Original, &r.Fingerprint, &r.Created, &r.Updated)
	return
}
func reviewRequestOriginal(r reviewRequestRecord) (*golfv1.SubmitPullReviewRequestRequest, error) {
	m := new(golfv1.SubmitPullReviewRequestRequest)
	if proto.Unmarshal(r.Original, m) != nil || validateReviewRequest(m) != nil || m.OperationId != r.OperationID || m.RepositoryId != strconv.FormatInt(r.RepositoryID, 10) || !bytes.Equal(reviewRequestFingerprint(m), r.Fingerprint) {
		return nil, errStorageUnavailable
	}
	return m, nil
}
func reviewRequestWire(r reviewRequestRecord) (*golfv1.PullReviewRequestOperation, error) {
	m, e := reviewRequestOriginal(r)
	if e != nil {
		return nil, e
	}
	return &golfv1.PullReviewRequestOperation{Contract: reviewRequestContract, Original: m, ActorId: strconv.FormatInt(r.ActorID, 10), Phase: golfv1.DiscussionResourceOperationPhase(golfv1.DiscussionResourceOperationPhase_value["DISCUSSION_RESOURCE_OPERATION_PHASE_"+r.Phase]), FailureCode: r.Failure, CreatedAt: r.Created.UTC().Format(time.RFC3339Nano), UpdatedAt: r.Updated.UTC().Format(time.RFC3339Nano)}, nil
}
func (s *Server) lockReviewRequest(ctx context.Context, tx *sql.Tx, id int64) (context.Context, error) {
	if _, e := tx.ExecContext(ctx, `SELECT golf_review_request_lock($1,$2)`, s.config.GiteaURL, id); e != nil {
		return nil, errStorageUnavailable
	}
	return context.WithValue(ctx, repositoryLifecycleTransactionKey{}, repositoryLifecycleTransaction{s.config.GiteaURL, id, tx}), nil
}
func (s *Server) advanceReviewRequest(ctx context.Context, session string, token forgeCredential, r reviewRequestRecord, phase string) (reviewRequestRecord, error) {
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return r, e
	}
	var updated reviewRequestRecord
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		if c.UserID != r.UserID || actor.ID != r.ActorID {
			return errUnauthenticated
		}
		held, e := s.lockReviewRequest(ctx, tx, r.RepositoryID)
		if e != nil {
			return e
		}
		failure := ""
		if phase == "REJECTED" {
			failure = "preflight_refused"
		}
		updated, e = scanReviewRequest(tx.QueryRowContext(held, `UPDATE golf_pull_review_request_operations SET phase=$1,failure_code=$2 WHERE id=$3 AND user_id=$4 AND forge_url=$5 AND phase=$6 RETURNING `+reviewRequestColumns, phase, failure, r.ID, r.UserID, r.ForgeURL, r.Phase))
		return e
	})
	return updated, e
}

type reviewRequestPermitKey struct{}
type reviewRequestPermit struct{ record reviewRequestRecord }

func (s *Server) validateReviewRequestPermit(ctx context.Context, tx *sql.Tx, p reviewRequestPermit, repo lifecycleNativeRepository, key repositoryKey, method, path string, input any) error {
	r := p.record
	m, e := reviewRequestOriginal(r)
	if e != nil {
		return e
	}
	base, _ := repositoryPath(key)
	want := "DELETE"
	if m.RequestReview {
		want = "POST"
	}
	if tx == nil || repo.ID != r.RepositoryID || key != keyFrom(m.Repository) || method != want || path != base+"/pulls/"+strconv.FormatUint(uint64(m.Number), 10)+"/requested_reviewers" {
		return errLifecycleBlocked
	}
	a, _ := json.Marshal(input)
	b, _ := json.Marshal(reviewRequestPayload(m))
	if !bytes.Equal(a, b) {
		return errLifecycleBlocked
	}
	stored, e := scanReviewRequest(tx.QueryRowContext(ctx, `SELECT `+reviewRequestColumns+` FROM golf_pull_review_request_operations WHERE id=$1 AND user_id=$2 AND forge_url=$3 AND phase='DISPATCH_UNKNOWN'`, r.ID, r.UserID, r.ForgeURL))
	if e != nil || stored.ActorID != r.ActorID || !bytes.Equal(stored.Fingerprint, r.Fingerprint) {
		return errLifecycleBlocked
	}
	var blocked bool
	if e = tx.QueryRowContext(ctx, `SELECT golf_repository_lifecycle_blocked_before_review_request($1,$2) OR EXISTS(SELECT 1 FROM golf_standard_pull_merges WHERE forge_url=$1 AND (repository_id=$2 OR source_repository_id=$2) AND phase IN ('RESERVED','DISPATCH_UNKNOWN'))`, r.ForgeURL, r.RepositoryID).Scan(&blocked); e != nil {
		return errStorageUnavailable
	}
	if blocked {
		return errLifecycleBlocked
	}
	return nil
}
func (s *Server) GetPullReviewRequestOperation(ctx context.Context, req *connect.Request[golfv1.GetPullReviewRequestOperationRequest]) (*connect.Response[golfv1.GetPullReviewRequestOperationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = reviewRequestTarget(keyFrom(m.Repository), m.RepositoryId, m.PullRequestId, m.Number); e != nil {
		return nil, rpcError(e)
	}
	if !creationKey.MatchString(m.OperationId) {
		return nil, rpcError(invalid("Inspect the original operation."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var r reviewRequestRecord
	e = s.withManagedSession(ctx, session, token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		r, e = scanReviewRequest(s.db.QueryRowContext(ctx, `SELECT `+reviewRequestColumns+` FROM golf_pull_review_request_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, m.OperationId))
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		return e
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	original, e := reviewRequestOriginal(r)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if !proto.Equal(original.Repository, m.Repository) || original.RepositoryId != m.RepositoryId || original.PullRequestId != m.PullRequestId || original.Number != m.Number {
		return nil, lifecycleRPCError(errResourceNotFound)
	}
	snap, e := s.reviewRequestSnapshot(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.PullRequestId, m.Number)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if !snap.CanManage {
		return nil, lifecycleRPCError(errResourceNotFound)
	}
	wire, e := reviewRequestWire(r)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(&golfv1.GetPullReviewRequestOperationResponse{Operation: wire}), nil
}
func (s *Server) SubmitPullReviewRequest(ctx context.Context, req *connect.Request[golfv1.SubmitPullReviewRequestRequest]) (*connect.Response[golfv1.SubmitPullReviewRequestResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = validateReviewRequest(m); e != nil {
		return nil, rpcError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	snap, e := s.reviewRequestSnapshot(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.PullRequestId, m.Number)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if !snap.CanManage {
		return nil, lifecycleRPCError(errResourceNotFound)
	}
	repoID, _ := discussionID(m.RepositoryId)
	fingerprint := reviewRequestFingerprint(m)
	var r reviewRequestRecord
	fresh := false
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		held, e := s.lockReviewRequest(ctx, tx, repoID)
		if e != nil {
			return e
		}
		r, e = scanReviewRequest(tx.QueryRowContext(held, `SELECT `+reviewRequestColumns+` FROM golf_pull_review_request_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, m.OperationId))
		if e == nil {
			if !bytes.Equal(fingerprint, r.Fingerprint) {
				return errRepositoryAccessConflict
			}
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		r, e = scanReviewRequest(tx.QueryRowContext(held, `INSERT INTO golf_pull_review_request_operations(user_id,forge_url,actor_id,operation_id,repository_id,original,input_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING `+reviewRequestColumns, c.UserID, s.config.GiteaURL, actor.ID, m.OperationId, repoID, reviewRequestBytes(m), fingerprint))
		fresh = e == nil
		return e
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if fresh {
		if e = s.reviewRequestPreflight(ctx, session, token, m); e != nil {
			r, e = s.advanceReviewRequest(ctx, session, token, r, "REJECTED")
		} else {
			r, e = s.advanceReviewRequest(ctx, session, token, r, "DISPATCH_UNKNOWN")
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
			var nativeErr error
			e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
				held, e := s.lockReviewRequest(ctx, tx, repoID)
				if e != nil {
					return e
				}
				if e = s.reviewRequestPreflight(held, session, token, m); e != nil {
					return e
				}
				held = context.WithValue(held, reviewRequestPermitKey{}, reviewRequestPermit{r})
				base, _ := repositoryPath(keyFrom(m.Repository))
				method, status := "DELETE", http.StatusNoContent
				if m.RequestReview {
					method, status = "POST", http.StatusCreated
				}
				_, nativeErr = s.forgeJSON(held, method, base+"/pulls/"+strconv.FormatUint(uint64(m.Number), 10)+"/requested_reviewers", token, reviewRequestPayload(m), nil, status)
				if nativeErr == nil {
					current, e := s.reviewRequestSnapshot(held, session, token, keyFrom(m.Repository), m.RepositoryId, m.PullRequestId, m.Number)
					nativeErr = e
					if e == nil {
						found := false
						for _, u := range current.Reviewers {
							if m.ReviewerTeam {
								continue
							}
							if u.Id == m.ReviewerId && u.Login == m.ReviewerLogin {
								found = true
							}
						}
						if m.ReviewerTeam {
							for _, team := range current.Teams {
								if team.Id == m.ReviewerId && team.Name == m.ReviewerLogin {
									found = true
								}
							}
						}
						if found != m.RequestReview || !current.CanManage {
							nativeErr = errPullSnapshotChanged
						}
					}
				}
				return nil
			})
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
			if nativeErr == nil {
				r, e = s.advanceReviewRequest(ctx, session, token, r, "SUCCEEDED")
			}
		}
		if e != nil {
			return nil, lifecycleRPCError(e)
		}
	}
	status := connect.NewRequest(&golfv1.GetPullReviewRequestOperationRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, PullRequestId: m.PullRequestId, Number: m.Number, OperationId: m.OperationId})
	status.Header().Set("Cookie", req.Header().Get("Cookie"))
	status.Header().Set("Origin", req.Header().Get("Origin"))
	out, e := s.GetPullReviewRequestOperation(ctx, status)
	if e != nil {
		return nil, e
	}
	return connect.NewResponse(&golfv1.SubmitPullReviewRequestResponse{Operation: out.Msg.Operation}), nil
}

func reviewRequestPayload(m *golfv1.SubmitPullReviewRequestRequest) any {
	if m.ReviewerTeam {
		return map[string]any{"team_reviewers": []string{m.ReviewerLogin}}
	}
	return map[string]any{"reviewers": []string{m.ReviewerLogin}}
}
func (s *Server) reviewTeamPreflight(ctx context.Context, token forgeCredential, m *golfv1.SubmitPullReviewRequestRequest, snap *golfv1.GetPullReviewRequestsResponse) error {
	present := false
	for _, team := range snap.Teams {
		if team.Id == m.ReviewerId {
			if team.Name != m.ReviewerLogin {
				return errRepositoryAccessConflict
			}
			present = true
		}
	}
	if present == m.RequestReview {
		return errRepositoryAccessConflict
	}
	id, _ := discussionID(m.ReviewerId)
	var team repositoryNativeTeam
	if _, e := s.forge(ctx, http.MethodGet, "/teams/"+m.ReviewerId, token, nil, &team); e != nil {
		return e
	}
	if team.ID != id || team.Name != m.ReviewerLogin || team.Organization == nil || !validOrganization(*team.Organization) || !strings.EqualFold(team.Organization.Name, m.Repository.Owner) {
		return errRepositoryAccessConflict
	}
	// Exact repository association and pull unit, never code-only privileges.
	attached, e := s.repositoryTeamAssociations(ctx, token, keyFrom(m.Repository), *team.Organization)
	if e != nil {
		return e
	}
	if !attached[id] || team.UnitPermissions["repo.pulls"] == "" || team.UnitPermissions["repo.pulls"] == "none" {
		return errResourceNotFound
	}
	return nil
}
func (s *Server) GetPullReviewTeamCandidates(ctx context.Context, req *connect.Request[golfv1.GetPullReviewTeamCandidatesRequest]) (*connect.Response[golfv1.GetPullReviewTeamCandidatesResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = reviewRequestTarget(keyFrom(m.Repository), m.RepositoryId, m.PullRequestId, m.Number); e != nil {
		return nil, rpcError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	snap, e := s.reviewRequestSnapshot(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.PullRequestId, m.Number)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if !snap.CanManage {
		return nil, lifecycleRPCError(errResourceNotFound)
	}
	out := &golfv1.GetPullReviewTeamCandidatesResponse{}
	e = s.withRepositoryRead(ctx, session, token, keyFrom(m.Repository), func(base string, repo Repository) error {
		if strconv.FormatInt(repo.ID, 10) != m.RepositoryId {
			return errIssueTargetChanged
		}
		var rows []repositoryNativeTeam
		headers, e := s.forge(ctx, http.MethodGet, base+"/teams", token, nil, &rows)
		if e != nil {
			return e
		}
		if rows == nil || headers.Get("Link") != "" {
			return errInvalidForgeResponse
		}
		if len(rows) > 200 {
			return errForgeResponseTooLarge
		}
		seen := map[int64]bool{}
		for _, candidate := range rows {
			if seen[candidate.ID] {
				return errInvalidForgeResponse
			}
			seen[candidate.ID] = true
			if !validOrganizationName(candidate.Name) || candidate.UnitPermissions["repo.pulls"] == "" || candidate.UnitPermissions["repo.pulls"] == "none" {
				continue
			}
			var team repositoryNativeTeam
			if _, e = s.forge(ctx, http.MethodGet, "/teams/"+strconv.FormatInt(candidate.ID, 10), token, nil, &team); e != nil {
				return e
			}
			if team.ID != candidate.ID || team.Name != candidate.Name || team.Organization == nil || !validOrganization(*team.Organization) || !strings.EqualFold(team.Organization.Name, m.Repository.Owner) || repositoryTeamConfiguration(*team.Organization, team.forgeOrganizationTeam) != repositoryTeamConfiguration(*team.Organization, candidate.forgeOrganizationTeam) {
				return errRepositoryAccessConflict
			}
			out.Teams = append(out.Teams, wireOrganizationTeam(team.forgeOrganizationTeam))
		}
		return nil
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	sort.Slice(out.Teams, func(i, j int) bool { return out.Teams[i].Name < out.Teams[j].Name })
	return connect.NewResponse(out), nil
}
