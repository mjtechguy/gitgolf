package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
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

func resourceKind(k golfv1.DiscussionResourceOperationKind) string {
	return strings.TrimPrefix(k.String(), "DISCUSSION_RESOURCE_OPERATION_KIND_")
}
func resourceHash(v any) string {
	b, _ := json.Marshal(v)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func labelRevision(v *golfv1.DiscussionLabel) string {
	return resourceHash([]any{v.Id, v.Name, v.Color, v.Description, v.Exclusive, v.Archived})
}
func milestoneRevision(v *golfv1.DiscussionMilestone) string {
	return resourceHash([]any{v.Id, v.Title, v.Description, v.State, milestoneDay(v.DueOn)})
}
func milestoneDay(v string) string {
	if v == "" {
		return ""
	}
	t, e := time.Parse(time.RFC3339Nano, v)
	if e != nil {
		return "invalid"
	}
	return t.UTC().Format("2006-01-02")
}
func commentRevision(v forgeIssueComment) string {
	id := int64(0)
	if v.User != nil {
		id = v.User.ID
	}
	return resourceHash([]any{v.ID, id, v.Body, v.CreatedAt, v.UpdatedAt})
}
func resourceFingerprint(m *golfv1.SubmitDiscussionResourceOperationRequest) []byte {
	c := proto.Clone(m).(*golfv1.SubmitDiscussionResourceOperationRequest)
	c.OperationId = ""
	b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(c)
	h := sha256.Sum256(b)
	return h[:]
}
func validateResourceRequest(m *golfv1.SubmitDiscussionResourceOperationRequest) error {
	if _, e := repositoryPath(keyFrom(m.Repository)); e != nil {
		return e
	}
	if _, e := discussionID(m.RepositoryId); e != nil {
		return e
	}
	k := resourceKind(m.Kind)
	if !creationKey.MatchString(m.OperationId) {
		return invalid("Use an original UUID operation key.")
	}
	create := strings.HasPrefix(k, "CREATE_")
	comment := k == "UPDATE_COMMENT" || k == "DELETE_COMMENT"
	if create {
		if m.ResourceId != "" || m.ExpectedRevision != "" {
			return invalid("Creation cannot adopt an existing resource.")
		}
	} else {
		if _, e := discussionID(m.ResourceId); e != nil {
			return e
		}
		if len(m.ExpectedRevision) != 64 || strings.IndexFunc(m.ExpectedRevision, func(r rune) bool { return !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') }) >= 0 {
			return invalid("Bind the original resource revision.")
		}
	}
	if comment {
		if _, e := discussionID(m.IssueId); e != nil {
			return e
		}
		if e := pullNumber(m.Number); e != nil {
			return e
		}
	} else if m.IssueId != "" || m.Number != 0 || m.PullRequest {
		return invalid("Only comments accept a discussion identity.")
	}
	switch k {
	case "CREATE_LABEL", "UPDATE_LABEL":
		v, ok := m.Change.(*golfv1.SubmitDiscussionResourceOperationRequest_Label)
		if !ok || v.Label == nil {
			return invalid("Provide a complete label draft.")
		}
		d := v.Label
		if !discussionMetadataName(d.Name) || len(d.Name) > 255 || strings.TrimSpace(d.Name) != d.Name || !discussionText(d.Description, 4096) || len(d.Color) != 6 || strings.IndexFunc(d.Color, func(r rune) bool { return !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') }) >= 0 {
			return invalid("Use a trimmed name of 1–255 UTF-8 bytes, six lowercase hexadecimal color digits and a bounded description.")
		}
	case "CREATE_MILESTONE", "UPDATE_MILESTONE":
		v, ok := m.Change.(*golfv1.SubmitDiscussionResourceOperationRequest_Milestone)
		if !ok || v.Milestone == nil {
			return invalid("Provide a complete milestone draft.")
		}
		d := v.Milestone
		if !discussionMetadataName(d.Title) || len(d.Title) > 255 || strings.TrimSpace(d.Title) != d.Title || !discussionText(d.Description, 64<<10) || (d.State != golfv1.IssueState_ISSUE_STATE_OPEN && d.State != golfv1.IssueState_ISSUE_STATE_CLOSED) {
			return invalid("Use an open or closed milestone with a trimmed title of 1–255 UTF-8 bytes and a bounded description.")
		}
		if d.DueDate != "" {
			t, e := time.Parse("2006-01-02", d.DueDate)
			if e != nil || t.Format("2006-01-02") != d.DueDate || t.Year() < 1970 {
				return invalid("Use a UTC calendar date from 1970 onward.")
			}
		}
	case "UPDATE_COMMENT":
		v, ok := m.Change.(*golfv1.SubmitDiscussionResourceOperationRequest_CommentBody)
		if !ok || strings.TrimSpace(v.CommentBody) == "" || !discussionText(v.CommentBody, 256<<10) {
			return invalid("Provide a nonempty bounded comment.")
		}
	case "DELETE_LABEL", "DELETE_MILESTONE", "DELETE_COMMENT":
		if m.Change != nil {
			return invalid("Deletion cannot accept replacement content.")
		}
	default:
		return invalid("Select a supported discussion resource operation.")
	}
	return nil
}

// Repository labels and milestones use the native issues OR pulls writer rule.
// Neither native code push permission nor Golf instance administration substitutes.
func (s *Server) discussionAdministrationAuthority(ctx context.Context, token forgeCredential, base string, repo Repository) (bool, error) {
	a, e := s.milestoneEditAuthority(context.WithValue(ctx, pullDiscussionKey{}, false), token, base, repo)
	if e != nil || a {
		return a, e
	}
	return s.milestoneEditAuthority(context.WithValue(ctx, pullDiscussionKey{}, true), token, base, repo)
}

func (s *Server) activeDiscussionUnit(ctx context.Context, token forgeCredential, base string, repo Repository, pull bool) (bool, error) {
	var unit struct {
		ID       int64 `json:"id"`
		Archived *bool `json:"archived"`
		Issues   *bool `json:"has_issues"`
		Pulls    *bool `json:"has_pull_requests"`
	}
	if _, e := s.forge(ctx, http.MethodGet, base, token, nil, &unit); e != nil {
		return false, e
	}
	enabled := unit.Issues
	if pull {
		enabled = unit.Pulls
	}
	if unit.ID != repo.ID || unit.Archived == nil || enabled == nil {
		return false, errInvalidForgeResponse
	}
	return !*unit.Archived && *enabled, nil
}

type discussionResourceRecord struct {
	ID, UserID, ActorID, RepositoryID, ResourceID, ObservedID, IssueID, Number, CommentAuthorID int64
	ForgeURL, OperationID, Owner, Name, Kind, Revision, Phase, Failure                          string
	Pull                                                                                        bool
	Fingerprint                                                                                 []byte
	Created, Updated                                                                            time.Time
}

const discussionResourceColumns = `id,user_id,forge_url,actor_id,operation_id,repository_id,repository_owner,repository_name,kind,resource_id,observed_resource_id,expected_revision,issue_id,issue_number,pull_request,comment_author_id,input_fingerprint,phase,failure_code,created_at,updated_at`

func scanDiscussionResource(row interface{ Scan(...any) error }) (r discussionResourceRecord, e error) {
	e = row.Scan(&r.ID, &r.UserID, &r.ForgeURL, &r.ActorID, &r.OperationID, &r.RepositoryID, &r.Owner, &r.Name, &r.Kind, &r.ResourceID, &r.ObservedID, &r.Revision, &r.IssueID, &r.Number, &r.Pull, &r.CommentAuthorID, &r.Fingerprint, &r.Phase, &r.Failure, &r.Created, &r.Updated)
	return
}
func wireDiscussionResource(r discussionResourceRecord) *golfv1.DiscussionResourceOperation {
	v := &golfv1.DiscussionResourceOperation{OperationId: r.OperationID, Kind: golfv1.DiscussionResourceOperationKind(golfv1.DiscussionResourceOperationKind_value["DISCUSSION_RESOURCE_OPERATION_KIND_"+r.Kind]), Phase: golfv1.DiscussionResourceOperationPhase(golfv1.DiscussionResourceOperationPhase_value["DISCUSSION_RESOURCE_OPERATION_PHASE_"+r.Phase]), Repository: &golfv1.RepositoryKey{Owner: r.Owner, Name: r.Name}, RepositoryId: strconv.FormatInt(r.RepositoryID, 10), ExpectedRevision: r.Revision, Number: uint32(r.Number), PullRequest: r.Pull, FailureCode: r.Failure, CreatedAt: r.Created.UTC().Format(time.RFC3339Nano), UpdatedAt: r.Updated.UTC().Format(time.RFC3339Nano)}
	if r.ResourceID > 0 {
		v.ResourceId = strconv.FormatInt(r.ResourceID, 10)
	}
	if r.ObservedID > 0 {
		v.ObservedResourceId = strconv.FormatInt(r.ObservedID, 10)
	}
	if r.IssueID > 0 {
		v.IssueId = strconv.FormatInt(r.IssueID, 10)
	}
	return v
}
func (s *Server) lockDiscussionResource(ctx context.Context, tx *sql.Tx, id int64) (context.Context, error) {
	if _, e := tx.ExecContext(ctx, `SELECT golf_discussion_resource_lock($1,$2)`, s.config.GiteaURL, id); e != nil {
		return nil, errStorageUnavailable
	}
	return context.WithValue(ctx, repositoryLifecycleTransactionKey{}, repositoryLifecycleTransaction{s.config.GiteaURL, id, tx}), nil
}
func (s *Server) readResourceMilestone(ctx context.Context, token forgeCredential, base string, id int64) (*golfv1.DiscussionMilestone, error) {
	var raw json.RawMessage
	if _, e := s.forge(ctx, http.MethodGet, base+"/milestones/"+strconv.FormatInt(id, 10), token, nil, &raw); e != nil {
		return nil, e
	}
	v, e := nativeMilestone(raw)
	if e == nil && v.Id != strconv.FormatInt(id, 10) {
		e = errInvalidForgeResponse
	}
	return v, e
}

func (s *Server) resourceAuthority(ctx context.Context, session string, token forgeCredential, r discussionResourceRecord) (err error) {
	return s.withRepositoryRead(ctx, session, token, repositoryKey{r.Owner, r.Name}, func(base string, repo Repository) error {
		if repo.ID != r.RepositoryID {
			return errIssueTargetChanged
		}
		allowed, e := s.discussionAdministrationAuthority(ctx, token, base, repo)
		if e != nil {
			return e
		}
		if strings.HasSuffix(r.Kind, "_COMMENT") {
			var unit struct {
				ID       int64 `json:"id"`
				Archived *bool `json:"archived"`
				Issues   *bool `json:"has_issues"`
				Pulls    *bool `json:"has_pull_requests"`
			}
			if _, e := s.forge(ctx, http.MethodGet, base, token, nil, &unit); e != nil {
				return e
			}
			enabled := unit.Issues
			if r.Pull {
				enabled = unit.Pulls
			}
			if unit.ID != r.RepositoryID || unit.Archived == nil || *unit.Archived || enabled == nil || !*enabled {
				return forgeError{status: http.StatusForbidden}
			}
			dc := context.WithValue(ctx, pullDiscussionKey{}, r.Pull)
			issue, e := s.readDiscussionIssue(dc, token, base, repo, uint32(r.Number))
			if e != nil {
				return e
			}
			if issue.ID != r.IssueID {
				return errIssueTargetChanged
			}
			allowed, e = s.milestoneEditAuthority(dc, token, base, repo)
			if e != nil {
				return e
			}
			if !allowed {
				allowed = r.CommentAuthorID > 0 && r.CommentAuthorID == r.ActorID
			}
		}
		if !allowed {
			return forgeError{status: http.StatusForbidden}
		}
		return nil
	})
}
func (s *Server) preflightDiscussionResource(ctx context.Context, session string, token forgeCredential, r discussionResourceRecord) error {
	if e := s.resourceAuthority(ctx, session, token, r); e != nil {
		return e
	}
	return s.withRepositoryRead(ctx, session, token, repositoryKey{r.Owner, r.Name}, func(base string, repo Repository) error {
		if repo.ID != r.RepositoryID {
			return errIssueTargetChanged
		}
		if strings.HasPrefix(r.Kind, "CREATE_") {
			return nil
		}
		revision := ""
		var e error
		switch {
		case strings.HasSuffix(r.Kind, "_LABEL"):
			var v *golfv1.DiscussionLabel
			v, e = s.readRepositoryLabel(ctx, token, base, r.ResourceID)
			if e == nil {
				revision = labelRevision(v)
			}
		case strings.HasSuffix(r.Kind, "_MILESTONE"):
			var v *golfv1.DiscussionMilestone
			v, e = s.readResourceMilestone(ctx, token, base, r.ResourceID)
			if e == nil {
				revision = milestoneRevision(v)
			}
		default:
			var v forgeIssueComment
			v, e = s.readDiscussionComment(context.WithValue(ctx, pullDiscussionKey{}, r.Pull), token, base, repo, uint32(r.Number), r.ResourceID)
			if e == nil {
				if v.User == nil || v.User.ID != r.CommentAuthorID {
					return errIssueTargetChanged
				}
				revision = commentRevision(v)
			}
		}
		if e != nil {
			return e
		}
		if revision != r.Revision {
			return errIssueRevisionChanged
		}
		return nil
	})
}
func resourceNative(m *golfv1.SubmitDiscussionResourceOperationRequest) (method, suffix string, payload any) {
	k := resourceKind(m.Kind)
	collection := "/labels"
	if strings.HasSuffix(k, "_MILESTONE") {
		collection = "/milestones"
	}
	if strings.HasSuffix(k, "_COMMENT") {
		collection = "/issues/comments"
	}
	method = http.MethodPatch
	suffix = collection + "/" + m.ResourceId
	if strings.HasPrefix(k, "CREATE_") {
		method = http.MethodPost
		suffix = collection
	}
	if strings.HasPrefix(k, "DELETE_") {
		return http.MethodDelete, suffix, nil
	}
	if d := m.GetLabel(); d != nil {
		return method, suffix, map[string]any{"name": d.Name, "color": d.Color, "description": d.Description, "exclusive": d.Exclusive, "is_archived": d.Archived}
	}
	if d := m.GetMilestone(); d != nil {
		state := "open"
		if d.State == golfv1.IssueState_ISSUE_STATE_CLOSED {
			state = "closed"
		}
		var due any
		if d.DueDate != "" {
			// Native creation treats Unix zero as unset; edits already use end-of-day.
			due = d.DueDate + "T23:59:59Z"
		}
		return method, suffix, map[string]any{"title": d.Title, "description": d.Description, "state": state, "due_on": due}
	}
	return method, suffix, map[string]string{"body": m.GetCommentBody()}
}

type discussionResourcePermitKey struct{}
type discussionResourcePermit struct {
	record  discussionResourceRecord
	request *golfv1.SubmitDiscussionResourceOperationRequest
}

func (s *Server) validateDiscussionResourcePermit(ctx context.Context, tx *sql.Tx, p discussionResourcePermit, repo lifecycleNativeRepository, key repositoryKey, method, path string, input any) error {
	r := p.record
	base, _ := repositoryPath(key)
	want, suffix, payload := resourceNative(p.request)
	if tx == nil || repo.ID != r.RepositoryID || key.Owner != r.Owner || key.Name != r.Name || method != want || path != base+suffix || !bytes.Equal(resourceFingerprint(p.request), r.Fingerprint) {
		return errLifecycleBlocked
	}
	a, e := json.Marshal(input)
	if e != nil {
		return errLifecycleBlocked
	}
	b, e := json.Marshal(payload)
	if e != nil || !bytes.Equal(a, b) {
		return errLifecycleBlocked
	}
	row, e := scanDiscussionResource(tx.QueryRowContext(ctx, `SELECT `+discussionResourceColumns+` FROM golf_discussion_resource_operations WHERE id=$1 AND user_id=$2 AND forge_url=$3 AND phase='DISPATCH_UNKNOWN'`, r.ID, r.UserID, r.ForgeURL))
	if e != nil || row.ActorID != r.ActorID || !bytes.Equal(row.Fingerprint, r.Fingerprint) {
		return errLifecycleBlocked
	}
	var blocked bool
	e = tx.QueryRowContext(ctx, `SELECT golf_repository_lifecycle_blocked_before_discussion_resource($1,$2) OR EXISTS(SELECT 1 FROM golf_standard_pull_merges WHERE forge_url=$1 AND (repository_id=$2 OR source_repository_id=$2) AND phase IN ('RESERVED','DISPATCH_UNKNOWN'))`, r.ForgeURL, r.RepositoryID).Scan(&blocked)
	if e != nil {
		return errStorageUnavailable
	}
	if blocked {
		return errLifecycleBlocked
	}
	return nil
}
func (s *Server) advanceDiscussionResource(ctx context.Context, session string, token forgeCredential, r discussionResourceRecord, phase string, observed int64, request *golfv1.SubmitDiscussionResourceOperationRequest) (next discussionResourceRecord, e error) {
	e = s.workflowTransaction(ctx, session, r.ActorID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		if c.UserID != r.UserID {
			return errUnauthenticated
		}
		held, e := s.lockDiscussionResource(ctx, tx, r.RepositoryID)
		if e != nil {
			return e
		}
		if phase == "SUCCEEDED" {
			if request == nil {
				return errInvalidForgeResponse
			}
			if e = s.confirmDiscussionResource(held, session, token, r, request, observed); e != nil {
				return e
			}
		}
		failure := ""
		if phase == "REJECTED" {
			failure = "preflight_refused"
		}
		next, e = scanDiscussionResource(tx.QueryRowContext(held, `UPDATE golf_discussion_resource_operations SET phase=$1,failure_code=$2,observed_resource_id=$3 WHERE id=$4 AND user_id=$5 AND forge_url=$6 AND phase=$7 RETURNING `+discussionResourceColumns, phase, failure, observed, r.ID, r.UserID, r.ForgeURL, r.Phase))
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	return
}

// Inspection is historical, metadata-only and never replays or adopts an uncertain
// native effect. Require the current source and exact repository/discussion access.
func (s *Server) GetDiscussionResourceOperation(ctx context.Context, req *connect.Request[golfv1.GetDiscussionResourceOperationRequest]) (*connect.Response[golfv1.GetDiscussionResourceOperationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	if !creationKey.MatchString(req.Msg.OperationId) {
		return nil, rpcError(invalid("Inspect the original operation UUID."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return nil, rpcError(e)
	}
	var r discussionResourceRecord
	e = s.withManagedSession(ctx, session, token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		r, e = scanDiscussionResource(s.db.QueryRowContext(ctx, `SELECT `+discussionResourceColumns+` FROM golf_discussion_resource_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, req.Msg.OperationId))
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if e != nil {
			return errStorageUnavailable
		}
		if r.ActorID != actor.ID {
			return errUnauthenticated
		}
		return nil
	})
	if e == nil {
		e = s.resourceAuthority(ctx, session, token, r)
	}
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(&golfv1.GetDiscussionResourceOperationResponse{Operation: wireDiscussionResource(r)}), nil
}
func (s *Server) SubmitDiscussionResourceOperation(ctx context.Context, req *connect.Request[golfv1.SubmitDiscussionResourceOperationRequest]) (*connect.Response[golfv1.SubmitDiscussionResourceOperationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = validateResourceRequest(m); e != nil {
		return nil, rpcError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return nil, rpcError(e)
	}
	repoID, _ := discussionID(m.RepositoryId)
	targetID, _ := discussionID(m.ResourceId)
	issueID, _ := discussionID(m.IssueId)
	k := keyFrom(m.Repository)
	r := discussionResourceRecord{ActorID: actor.ID, RepositoryID: repoID, Owner: k.Owner, Name: k.Name, Kind: resourceKind(m.Kind), ResourceID: targetID, IssueID: issueID, Number: int64(m.Number), Pull: m.PullRequest, Revision: m.ExpectedRevision, OperationID: m.OperationId, Fingerprint: resourceFingerprint(m), ForgeURL: s.config.GiteaURL}
	fresh := false
	var previous discussionResourceRecord
	exists := false
	e = s.withManagedSession(ctx, session, token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		previous, e = scanDiscussionResource(s.db.QueryRowContext(ctx, `SELECT `+discussionResourceColumns+` FROM golf_discussion_resource_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, m.OperationId))
		if errors.Is(e, sql.ErrNoRows) {
			return nil
		}
		if e != nil {
			return errStorageUnavailable
		}
		exists = true
		return nil
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if exists {
		if previous.ActorID != actor.ID || !bytes.Equal(previous.Fingerprint, r.Fingerprint) {
			return nil, lifecycleRPCError(errRepositoryAccessConflict)
		}
		if e = s.resourceAuthority(ctx, session, token, previous); e != nil {
			return nil, lifecycleRPCError(e)
		}
		return connect.NewResponse(&golfv1.SubmitDiscussionResourceOperationResponse{Operation: wireDiscussionResource(previous)}), nil
	}
	if strings.HasSuffix(r.Kind, "_COMMENT") {
		e = s.withRepositoryRead(ctx, session, token, k, func(base string, repo Repository) error {
			if repo.ID != repoID {
				return errIssueTargetChanged
			}
			v, e := s.readDiscussionComment(context.WithValue(ctx, pullDiscussionKey{}, r.Pull), token, base, repo, m.Number, targetID)
			if e != nil {
				return e
			}
			if v.User == nil || v.User.ID <= 0 {
				return errInvalidForgeResponse
			}
			r.CommentAuthorID = v.User.ID
			return nil
		})
		if e != nil {
			return nil, lifecycleRPCError(e)
		}
	}
	// A caller must have current native authority before even reserving a new key.
	if e = s.resourceAuthority(ctx, session, token, r); e != nil {
		return nil, lifecycleRPCError(e)
	}
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		held, e := s.lockDiscussionResource(ctx, tx, repoID)
		if e != nil {
			return e
		}
		old, e := scanDiscussionResource(tx.QueryRowContext(held, `SELECT `+discussionResourceColumns+` FROM golf_discussion_resource_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, m.OperationId))
		if e == nil {
			if !bytes.Equal(old.Fingerprint, r.Fingerprint) {
				return errRepositoryAccessConflict
			}
			r = old
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		r, e = scanDiscussionResource(tx.QueryRowContext(held, `INSERT INTO golf_discussion_resource_operations(user_id,forge_url,actor_id,operation_id,repository_id,repository_owner,repository_name,kind,resource_id,expected_revision,issue_id,issue_number,pull_request,comment_author_id,input_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING `+discussionResourceColumns, c.UserID, r.ForgeURL, r.ActorID, r.OperationID, r.RepositoryID, r.Owner, r.Name, r.Kind, r.ResourceID, r.Revision, r.IssueID, r.Number, r.Pull, r.CommentAuthorID, r.Fingerprint))
		if e != nil {
			return errStorageUnavailable
		}
		fresh = true
		return nil
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	result := &golfv1.SubmitDiscussionResourceOperationResponse{}
	if fresh {
		if e = s.preflightDiscussionResource(ctx, session, token, r); e != nil {
			r, e = s.advanceDiscussionResource(ctx, session, token, r, "REJECTED", 0, nil)
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
		} else {
			r, e = s.advanceDiscussionResource(ctx, session, token, r, "DISPATCH_UNKNOWN", 0, nil)
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
			var nativeErr error
			observed := int64(0)
			e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
				if c.UserID != r.UserID {
					return errUnauthenticated
				}
				held, e := s.lockDiscussionResource(ctx, tx, repoID)
				if e != nil {
					return e
				}
				if e = s.preflightDiscussionResource(held, session, token, r); e != nil {
					return e
				}
				held = context.WithValue(held, discussionResourcePermitKey{}, discussionResourcePermit{r, proto.Clone(m).(*golfv1.SubmitDiscussionResourceOperationRequest)})
				observed, nativeErr = s.dispatchDiscussionResource(held, session, token, r, m, result)
				return nil
			})
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
			if nativeErr == nil {
				r, e = s.advanceDiscussionResource(ctx, session, token, r, "SUCCEEDED", observed, m)
				if e != nil {
					return nil, lifecycleRPCError(e)
				}
			} else {
				result.Label = nil
				result.Milestone = nil
				result.Comment = nil
			}
		}
	}
	// Never return historical content on repeated submissions.
	if e = s.withManagedSession(ctx, session, token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		if c.UserID != r.UserID || actor.ID != r.ActorID {
			return errUnauthenticated
		}
		return nil
	}); e != nil {
		return nil, rpcError(e)
	}
	result.Operation = wireDiscussionResource(r)
	return connect.NewResponse(result), nil
}
func (s *Server) dispatchDiscussionResource(ctx context.Context, session string, token forgeCredential, r discussionResourceRecord, m *golfv1.SubmitDiscussionResourceOperationRequest, out *golfv1.SubmitDiscussionResourceOperationResponse) (id int64, e error) {
	base, _ := repositoryPath(repositoryKey{r.Owner, r.Name})
	method, suffix, payload := resourceNative(m)
	create := strings.HasPrefix(r.Kind, "CREATE_")
	del := method == http.MethodDelete
	var raw json.RawMessage
	status := http.StatusOK
	if create {
		status = http.StatusCreated
	}
	if del {
		status = http.StatusNoContent
	}
	var output any = &raw
	if del {
		output = nil
	}
	if _, e = s.forgeJSON(ctx, method, base+suffix, token, payload, output, status); e != nil {
		return 0, e
	}
	if del {
		// A witnessed native 204 and current, separately authorized absence are both
		// required. Later inspection never converts an UNKNOWN delete into success.
		if e = s.resourceAuthority(ctx, session, token, r); e != nil {
			return 0, e
		}
		switch {
		case strings.HasSuffix(r.Kind, "_LABEL"):
			_, e = s.readRepositoryLabel(ctx, token, base, r.ResourceID)
		case strings.HasSuffix(r.Kind, "_MILESTONE"):
			_, e = s.readResourceMilestone(ctx, token, base, r.ResourceID)
		default:
			e = s.withRepositoryRead(ctx, session, token, repositoryKey{r.Owner, r.Name}, func(base string, repo Repository) error {
				_, e := s.readDiscussionComment(context.WithValue(ctx, pullDiscussionKey{}, r.Pull), token, base, repo, uint32(r.Number), r.ResourceID)
				return e
			})
		}
		if !sourceNotFound(e) {
			if e == nil {
				e = errInvalidForgeResponse
			}
			return 0, e
		}
		return r.ResourceID, nil
	}
	switch {
	case strings.HasSuffix(r.Kind, "_LABEL"):
		v, e := nativeLabel(raw)
		if e != nil {
			return 0, e
		}
		id, e = discussionID(v.Id)
		if e != nil || !create && id != r.ResourceID {
			return 0, errInvalidForgeResponse
		}
		d := m.GetLabel()
		if v.Name != d.Name || v.Color != d.Color || v.Description != d.Description || v.Exclusive != d.Exclusive || v.Archived != d.Archived {
			return 0, errInvalidForgeResponse
		}
		fresh, e := s.readRepositoryLabel(ctx, token, base, id)
		if e != nil || labelRevision(fresh) != labelRevision(v) {
			if e == nil {
				e = errInvalidForgeResponse
			}
			return 0, e
		}
		out.Label = fresh
	case strings.HasSuffix(r.Kind, "_MILESTONE"):
		v, e := nativeMilestone(raw)
		if e != nil {
			return 0, e
		}
		id, e = discussionID(v.Id)
		if e != nil || !create && id != r.ResourceID {
			return 0, errInvalidForgeResponse
		}
		d := m.GetMilestone()
		if v.Title != d.Title || v.Description != d.Description || v.State != d.State || milestoneDay(v.DueOn) != d.DueDate {
			return 0, errInvalidForgeResponse
		}
		fresh, e := s.readResourceMilestone(ctx, token, base, id)
		if e != nil || milestoneRevision(fresh) != milestoneRevision(v) {
			if e == nil {
				e = errInvalidForgeResponse
			}
			return 0, e
		}
		out.Milestone = fresh
	default:
		var v forgeIssueComment
		if json.Unmarshal(raw, &v) != nil || v.ID != r.ResourceID || v.User == nil || v.User.ID != r.CommentAuthorID || v.Body != m.GetCommentBody() {
			return 0, errInvalidForgeResponse
		}
		e = s.withRepositoryRead(ctx, session, token, repositoryKey{r.Owner, r.Name}, func(base string, repo Repository) error {
			if repo.ID != r.RepositoryID || !validIssueComment(v, repo, uint32(r.Number), r.Pull) {
				return errInvalidForgeResponse
			}
			fresh, e := s.readDiscussionComment(context.WithValue(ctx, pullDiscussionKey{}, r.Pull), token, base, repo, uint32(r.Number), r.ResourceID)
			if e != nil {
				return e
			}
			if commentRevision(fresh) != commentRevision(v) {
				return errInvalidForgeResponse
			}
			out.Comment = wireIssueComment(fresh)
			return nil
		})
		if e != nil {
			return 0, e
		}
		id = v.ID
	}
	if e = s.resourceAuthority(ctx, session, token, r); e != nil {
		return 0, e
	}
	return id, nil
}

// Reobserve the exact target and current source after waiting for the completion
// transaction too. This is observational; the native APIs have no external CAS.
func (s *Server) confirmDiscussionResource(ctx context.Context, session string, token forgeCredential, r discussionResourceRecord, m *golfv1.SubmitDiscussionResourceOperationRequest, id int64) error {
	if e := s.resourceAuthority(ctx, session, token, r); e != nil {
		return e
	}
	return s.withRepositoryRead(ctx, session, token, repositoryKey{r.Owner, r.Name}, func(base string, repo Repository) error {
		if repo.ID != r.RepositoryID || id <= 0 || !strings.HasPrefix(r.Kind, "CREATE_") && id != r.ResourceID {
			return errIssueTargetChanged
		}
		deleted := strings.HasPrefix(r.Kind, "DELETE_")
		var e error
		switch {
		case strings.HasSuffix(r.Kind, "_LABEL"):
			var row *golfv1.DiscussionLabel
			row, e = s.readRepositoryLabel(ctx, token, base, id)
			if e == nil && !deleted {
				d := m.GetLabel()
				if row.Name != d.Name || row.Description != d.Description || row.Color != d.Color || row.Exclusive != d.Exclusive || row.Archived != d.Archived {
					return errInvalidForgeResponse
				}
			}
		case strings.HasSuffix(r.Kind, "_MILESTONE"):
			var row *golfv1.DiscussionMilestone
			row, e = s.readResourceMilestone(ctx, token, base, id)
			if e == nil && !deleted {
				d := m.GetMilestone()
				if row.Title != d.Title || row.Description != d.Description || row.State != d.State || milestoneDay(row.DueOn) != d.DueDate {
					return errInvalidForgeResponse
				}
			}
		default:
			var row forgeIssueComment
			row, e = s.readDiscussionComment(context.WithValue(ctx, pullDiscussionKey{}, r.Pull), token, base, repo, uint32(r.Number), id)
			if e == nil && !deleted && (row.Body != m.GetCommentBody() || row.User == nil || row.User.ID != r.CommentAuthorID) {
				return errInvalidForgeResponse
			}
		}
		if deleted {
			if sourceNotFound(e) {
				return nil
			}
			if e == nil {
				return errInvalidForgeResponse
			}
		}
		return e
	})
}
