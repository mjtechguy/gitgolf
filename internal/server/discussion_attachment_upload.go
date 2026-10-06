package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
)

const attachmentUploadContract = "golf.discussion.attachment-upload.v1"

type attachmentUploadRecord struct {
	ID, UserID, ActorID, RepositoryID     int64
	ForgeURL, OperationID, Phase, Failure string
	Original, Fingerprint, Result         []byte
	Created, Updated                      time.Time
}

const attachmentUploadColumns = `id,user_id,actor_id,repository_id,forge_url,operation_id,phase,failure_code,original,input_fingerprint,result,created_at,updated_at`

func scanAttachmentUpload(row interface{ Scan(...any) error }) (r attachmentUploadRecord, e error) {
	e = row.Scan(&r.ID, &r.UserID, &r.ActorID, &r.RepositoryID, &r.ForgeURL, &r.OperationID, &r.Phase, &r.Failure, &r.Original, &r.Fingerprint, &r.Result, &r.Created, &r.Updated)
	return
}
func validateAttachmentUpload(m *golfv1.SubmitDiscussionAttachmentUploadRequest, retained bool) error {
	if e := validateDiscussionTarget(m.Target); e != nil {
		return e
	}
	if !creationKey.MatchString(m.OperationId) || !issueRevisionPattern.MatchString(m.ExpectedTargetRevision) || !issueRevisionPattern.MatchString(m.ExpectedAttachmentsRevision) || !releaseAssetName(m.Name) || !issueRevisionPattern.MatchString(m.ContentSha256) || m.ContentSizeBytes > maxPreviewBytes || retained && len(m.Content) > 0 || !retained && (uint64(len(m.Content)) != m.ContentSizeBytes || fileMutationHash(m.Content) != m.ContentSha256) {
		return invalid("Bind the original target, attachment inventory, safe filename and exact bytes up to256 KiB.")
	}
	return nil
}
func retainedAttachmentUpload(m *golfv1.SubmitDiscussionAttachmentUploadRequest) *golfv1.SubmitDiscussionAttachmentUploadRequest {
	c := proto.Clone(m).(*golfv1.SubmitDiscussionAttachmentUploadRequest)
	c.Content = nil
	return c
}
func attachmentUploadOriginalBytes(m *golfv1.SubmitDiscussionAttachmentUploadRequest) []byte {
	b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(retainedAttachmentUpload(m))
	return b
}
func attachmentUploadFingerprint(m *golfv1.SubmitDiscussionAttachmentUploadRequest) []byte {
	c := retainedAttachmentUpload(m)
	c.OperationId = ""
	h := sha256.Sum256(attachmentUploadOriginalBytes(c))
	return h[:]
}
func attachmentUploadOriginal(r attachmentUploadRecord) (*golfv1.SubmitDiscussionAttachmentUploadRequest, error) {
	m := new(golfv1.SubmitDiscussionAttachmentUploadRequest)
	if proto.Unmarshal(r.Original, m) != nil || validateAttachmentUpload(m, true) != nil || m.OperationId != r.OperationID || m.Target.RepositoryId != strconv.FormatInt(r.RepositoryID, 10) || !bytes.Equal(attachmentUploadFingerprint(m), r.Fingerprint) {
		return nil, errStorageUnavailable
	}
	return m, nil
}
func attachmentUploadWire(r attachmentUploadRecord) (*golfv1.DiscussionAttachmentUploadOperation, error) {
	m, e := attachmentUploadOriginal(r)
	if e != nil {
		return nil, e
	}
	out := &golfv1.DiscussionAttachmentUploadOperation{Contract: attachmentUploadContract, Original: m, ActorId: strconv.FormatInt(r.ActorID, 10), Phase: golfv1.DiscussionResourceOperationPhase(golfv1.DiscussionResourceOperationPhase_value["DISCUSSION_RESOURCE_OPERATION_PHASE_"+r.Phase]), FailureCode: r.Failure, CreatedAt: r.Created.UTC().Format(time.RFC3339Nano), UpdatedAt: r.Updated.UTC().Format(time.RFC3339Nano)}
	if r.Phase == "SUCCEEDED" {
		a := new(golfv1.DiscussionAttachment)
		if proto.Unmarshal(r.Result, a) != nil || !issueRevisionPattern.MatchString(a.Revision) || a.Name != m.Name || a.SizeBytes != m.ContentSizeBytes || !validPullTime(a.CreatedAt) {
			return nil, errStorageUnavailable
		}
		if _, e := discussionID(a.Id); e != nil {
			return nil, errStorageUnavailable
		}
		out.Attachment = a
	} else if len(r.Result) > 0 {
		return nil, errStorageUnavailable
	}
	return out, nil
}
func (s *Server) lockAttachmentUpload(ctx context.Context, tx *sql.Tx, id int64) (context.Context, error) {
	if _, e := tx.ExecContext(ctx, `SELECT golf_attachment_upload_lock($1,$2)`, s.config.GiteaURL, id); e != nil {
		return nil, errStorageUnavailable
	}
	if e := s.protectionDispatchAllowed(ctx, tx, id); e != nil {
		return nil, e
	}
	return context.WithValue(ctx, repositoryLifecycleTransactionKey{}, repositoryLifecycleTransaction{s.config.GiteaURL, id, tx}), nil
}

type attachmentUploadSnapshot struct {
	wire    *golfv1.GetDiscussionAttachmentUploadStateResponse
	issue   discussionIssue
	comment *forgeIssueComment
	assets  []*golfv1.DiscussionAttachment
	actor   User
	allowed bool
}

func attachmentIssueIdentity(i discussionIssue) any {
	author := i.User.ID
	return []any{i.ID, i.Number, author, i.Title, i.Body, i.State}
}
func attachmentTargetRevision(i discussionIssue, c *forgeIssueComment, actor int64) string {
	return resourceHash([]any{attachmentIssueIdentity(i), i.ContentVersion, i.UpdatedAt, c, actor})
}
func (s *Server) attachmentUploadSnapshot(ctx context.Context, session string, token forgeCredential, target *golfv1.DiscussionTarget) (snap attachmentUploadSnapshot, e error) {
	e = s.withDiscussionTarget(ctx, session, token, target, func(base string, repo Repository, issue discussionIssue) error {
		actor, e := s.currentUser(ctx, token)
		if e != nil {
			return e
		}
		enabled, e := s.activeDiscussionUnit(context.WithValue(ctx, pullDiscussionKey{}, target.PullRequest), token, base, repo, target.PullRequest)
		if e != nil {
			return e
		}
		var site struct {
			User
			SiteAdmin *bool `json:"is_admin"`
		}
		if _, e = s.forge(ctx, http.MethodGet, "/user", token, nil, &site); e != nil {
			return e
		}
		if site.ID != actor.ID || site.SiteAdmin == nil {
			return errInvalidForgeResponse
		}
		admin, writer := false, false
		if *site.SiteAdmin {
			access, e := s.readRepositoryAccess(ctx, token, keyFrom(target.Repository), actor)
			if e != nil && !mergeReadUnavailable(e) {
				return e
			}
			admin = e == nil && access.CanManage
			writer = admin
		} else {
			writer, e = s.milestoneEditAuthority(context.WithValue(ctx, pullDiscussionKey{}, target.PullRequest), token, base, repo)
			if e != nil {
				return e
			}
			access, e := s.readRepositoryAccess(ctx, token, keyFrom(target.Repository), actor)
			if e != nil && !mergeReadUnavailable(e) {
				return e
			}
			admin = e == nil && access.CanManage
		}
		allowed := enabled && (writer || issue.User.ID > 0 && issue.User.ID == actor.ID)
		var comment *forgeIssueComment
		if target.CommentId != "" {
			row, e := s.readDiscussionComment(context.WithValue(ctx, pullDiscussionKey{}, target.PullRequest), token, base, repo, target.Number, mustDiscussionID(target.CommentId))
			if e != nil {
				return e
			}
			comment = &row
			allowed = enabled && writer && row.User != nil && (row.User.ID == actor.ID || admin)
		}
		assets, e := s.discussionAttachments(ctx, session, token, target)
		if e != nil {
			return e
		}
		var settings struct {
			Enabled      *bool  `json:"enabled"`
			AllowedTypes string `json:"allowed_types"`
			MaxSize      *int64 `json:"max_size"`
		}
		if _, e = s.forge(ctx, http.MethodGet, "/settings/attachment", token, nil, &settings); e != nil {
			return e
		}
		if settings.Enabled == nil || settings.MaxSize == nil || *settings.MaxSize < 0 || !discussionText(settings.AllowedTypes, 4096) {
			return errInvalidForgeResponse
		}
		allowed = allowed && *settings.Enabled && *settings.MaxSize > 0
		out := &golfv1.GetDiscussionAttachmentUploadStateResponse{Target: proto.Clone(target).(*golfv1.DiscussionTarget), ActorId: strconv.FormatInt(actor.ID, 10), CanUpload: allowed && len(assets.Attachments) < 100, AllowedTypes: settings.AllowedTypes, MaxSizeBytes: maxPreviewBytes, TargetRevision: attachmentTargetRevision(issue, comment, actor.ID), AttachmentsRevision: assets.SnapshotRevision}
		// Check the observable target once more; neither native upload route exposes expected-version CAS.
		again, e := s.readDiscussionIssue(context.WithValue(ctx, pullDiscussionKey{}, target.PullRequest), token, base, repo, target.Number)
		if e != nil {
			return e
		}
		var after *forgeIssueComment
		if comment != nil {
			row, e := s.readDiscussionComment(context.WithValue(ctx, pullDiscussionKey{}, target.PullRequest), token, base, repo, target.Number, mustDiscussionID(target.CommentId))
			if e != nil {
				return e
			}
			after = &row
		}
		if attachmentTargetRevision(again, after, actor.ID) != out.TargetRevision {
			return errRepositoryAccessConflict
		}
		snap = attachmentUploadSnapshot{wire: out, issue: issue, comment: comment, assets: assets.Attachments, actor: actor, allowed: allowed}
		return nil
	})
	return
}
func (s *Server) attachmentUploadPreflight(ctx context.Context, session string, token forgeCredential, m *golfv1.SubmitDiscussionAttachmentUploadRequest) (attachmentUploadSnapshot, error) {
	snap, e := s.attachmentUploadSnapshot(ctx, session, token, m.Target)
	if e != nil {
		return snap, e
	}
	if !snap.wire.CanUpload {
		return snap, errResourceNotFound
	}
	if snap.wire.TargetRevision != m.ExpectedTargetRevision || snap.wire.AttachmentsRevision != m.ExpectedAttachmentsRevision {
		return snap, errRepositoryAccessConflict
	}
	for _, a := range snap.assets {
		if a.Name == m.Name {
			return snap, errRepositoryAccessConflict
		}
	}
	return snap, nil
}
func (s *Server) GetDiscussionAttachmentUploadState(ctx context.Context, req *connect.Request[golfv1.GetDiscussionAttachmentUploadStateRequest]) (*connect.Response[golfv1.GetDiscussionAttachmentUploadStateResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	snap, e := s.attachmentUploadSnapshot(ctx, session, token, req.Msg.Target)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(snap.wire), nil
}

type attachmentUploadPermit struct {
	record  attachmentUploadRecord
	request *golfv1.SubmitDiscussionAttachmentUploadRequest
}

func attachmentUploadManifest(m *golfv1.SubmitDiscussionAttachmentUploadRequest) any {
	return map[string]any{"name": m.Name, "size": m.ContentSizeBytes, "sha256": m.ContentSha256}
}
func (s *Server) validateAttachmentUploadPermit(ctx context.Context, tx *sql.Tx, p attachmentUploadPermit, repo lifecycleNativeRepository, key repositoryKey, method, path string, input any) error {
	m := p.request
	r := p.record
	base, _ := repositoryPath(key)
	if tx == nil || m == nil || validateAttachmentUpload(m, false) != nil || repo.ID != r.RepositoryID || key != keyFrom(m.Target.Repository) || method != http.MethodPost || path != discussionAttachmentRoute(base, m.Target) || !bytes.Equal(attachmentUploadOriginalBytes(m), r.Original) {
		return errLifecycleBlocked
	}
	a, e := json.Marshal(input)
	b, _ := json.Marshal(attachmentUploadManifest(m))
	if e != nil || !bytes.Equal(a, b) {
		return errLifecycleBlocked
	}
	stored, e := scanAttachmentUpload(tx.QueryRowContext(ctx, `SELECT `+attachmentUploadColumns+` FROM golf_attachment_upload_operations WHERE id=$1 AND user_id=$2 AND forge_url=$3 AND phase='DISPATCH_UNKNOWN'`, r.ID, r.UserID, r.ForgeURL))
	if e != nil || stored.ActorID != r.ActorID || !bytes.Equal(stored.Fingerprint, r.Fingerprint) || !bytes.Equal(stored.Original, r.Original) {
		return errLifecycleBlocked
	}
	var blocked bool
	if e = tx.QueryRowContext(ctx, `SELECT golf_repository_lifecycle_active($1,$2)<>1 OR EXISTS(SELECT 1 FROM golf_standard_pull_merges WHERE forge_url=$1 AND source_repository_id=$2 AND phase IN ('RESERVED','DISPATCH_UNKNOWN'))`, r.ForgeURL, r.RepositoryID).Scan(&blocked); e != nil {
		return errStorageUnavailable
	}
	if blocked {
		return errLifecycleBlocked
	}
	return nil
}
func (s *Server) attachmentUploadPostflight(ctx context.Context, session string, token forgeCredential, m *golfv1.SubmitDiscussionAttachmentUploadRequest, before attachmentUploadSnapshot, receipt forgeReleaseDownloadAsset) (*golfv1.DiscussionAttachment, error) {
	if discussionAttachmentRevision(receipt) == "" || receipt.Name != m.Name || uint64(*receipt.Size) != m.ContentSizeBytes {
		return nil, errInvalidForgeResponse
	}
	base, _ := repositoryPath(keyFrom(m.Target.Repository))
	var exact forgeReleaseDownloadAsset
	if _, e := s.forgeJSON(ctx, http.MethodGet, discussionAttachmentRoute(base, m.Target)+"/"+strconv.FormatInt(receipt.ID, 10), token, nil, &exact, http.StatusOK); e != nil {
		return nil, e
	}
	if !sameReleaseDownloadAsset(receipt, exact) {
		return nil, errInvalidForgeResponse
	}
	data, e := s.discussionAttachmentBytes(ctx, token, exact)
	if e != nil {
		return nil, e
	}
	if fileMutationHash(data) != m.ContentSha256 || uint64(len(data)) != m.ContentSizeBytes {
		return nil, errInvalidForgeResponse
	}
	after, e := s.attachmentUploadSnapshot(ctx, session, token, m.Target)
	if e != nil {
		return nil, e
	}
	if !after.allowed {
		return nil, errResourceNotFound
	}
	if resourceHash(attachmentIssueIdentity(before.issue)) != resourceHash(attachmentIssueIdentity(after.issue)) {
		return nil, errIssueTargetChanged
	}
	if before.comment == nil && before.issue.ContentVersion != nil {
		if after.issue.ContentVersion == nil || *after.issue.ContentVersion != *before.issue.ContentVersion+1 {
			return nil, errIssueTargetChanged
		}
	}
	if before.comment != nil {
		old := *before.comment
		now := after.comment
		if now == nil {
			return nil, errIssueTargetChanged
		}
		old.UpdatedAt = now.UpdatedAt
		if resourceHash(old) != resourceHash(now) {
			return nil, errIssueTargetChanged
		}
	}
	var expected []*golfv1.DiscussionAttachment
	found := false
	for _, a := range after.assets {
		if a.Id == strconv.FormatInt(receipt.ID, 10) {
			if found || !proto.Equal(a, discussionAttachmentWire(exact)) {
				return nil, errInvalidForgeResponse
			}
			found = true
		} else {
			expected = append(expected, a)
		}
	}
	if !found || resourceHash(expected) != resourceHash(before.assets) {
		return nil, errInvalidForgeResponse
	}
	return discussionAttachmentWire(exact), nil
}
func (s *Server) advanceAttachmentUpload(ctx context.Context, session string, token forgeCredential, r attachmentUploadRecord, phase string, result *golfv1.DiscussionAttachment) (out attachmentUploadRecord, e error) {
	e = s.workflowTransaction(ctx, session, r.ActorID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		if c.UserID != r.UserID {
			return errUnauthenticated
		}
		held, e := s.lockAttachmentUpload(ctx, tx, r.RepositoryID)
		if e != nil {
			return e
		}
		failure := ""
		if phase == "REJECTED" {
			failure = "preflight_refused"
		}
		raw := []byte{}
		if result != nil {
			raw, _ = proto.Marshal(result)
		}
		out, e = scanAttachmentUpload(tx.QueryRowContext(held, `UPDATE golf_attachment_upload_operations SET phase=$1,failure_code=$2,result=$3 WHERE id=$4 AND user_id=$5 AND forge_url=$6 AND phase=$7 RETURNING `+attachmentUploadColumns, phase, failure, raw, r.ID, r.UserID, r.ForgeURL, r.Phase))
		if e != nil {
			return e
		}
		if phase == "SUCCEEDED" {
			m, e := attachmentUploadOriginal(r)
			if e != nil {
				return e
			}
			final, readErr := s.attachmentUploadSnapshot(held, session, token, m.Target)
			if readErr != nil {
				return readErr
			}
			if !final.allowed {
				return errResourceNotFound
			}
			topic := "issues"
			if m.Target.PullRequest {
				topic = "pulls"
			}
			_, e = tx.ExecContext(held, `SELECT golf_append_repository_activity($1,$2,0,$3)`, r.ForgeURL, r.RepositoryID, topic)
		}
		return e
	})
	return
}
func (s *Server) GetDiscussionAttachmentUploadOperation(ctx context.Context, req *connect.Request[golfv1.GetDiscussionAttachmentUploadOperationRequest]) (*connect.Response[golfv1.GetDiscussionAttachmentUploadOperationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = validateDiscussionTarget(m.Target); e != nil {
		return nil, rpcError(e)
	}
	if !creationKey.MatchString(m.OperationId) {
		return nil, rpcError(invalid("Inspect the original upload UUID."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var r attachmentUploadRecord
	e = s.withManagedSession(ctx, session, token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		r, e = scanAttachmentUpload(s.db.QueryRowContext(ctx, `SELECT `+attachmentUploadColumns+` FROM golf_attachment_upload_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, m.OperationId))
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		return e
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	original, e := attachmentUploadOriginal(r)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if !proto.Equal(original.Target, m.Target) {
		return nil, lifecycleRPCError(errResourceNotFound)
	}
	e = s.withDiscussionTarget(ctx, session, token, m.Target, func(_ string, _ Repository, _ discussionIssue) error {
		actor, e := s.currentUser(ctx, token)
		if e != nil {
			return e
		}
		if actor.ID != r.ActorID {
			return errResourceNotFound
		}
		return nil
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	wire, e := attachmentUploadWire(r)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(&golfv1.GetDiscussionAttachmentUploadOperationResponse{Operation: wire}), nil
}
func (s *Server) SubmitDiscussionAttachmentUpload(ctx context.Context, req *connect.Request[golfv1.SubmitDiscussionAttachmentUploadRequest]) (*connect.Response[golfv1.SubmitDiscussionAttachmentUploadResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = validateAttachmentUpload(m, false); e != nil {
		return nil, rpcError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	id, _ := discussionID(m.Target.RepositoryId)
	fp := attachmentUploadFingerprint(m)
	var r attachmentUploadRecord
	fresh := false
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		held, e := s.lockAttachmentUpload(ctx, tx, id)
		if e != nil {
			return e
		}
		r, e = scanAttachmentUpload(tx.QueryRowContext(held, `SELECT `+attachmentUploadColumns+` FROM golf_attachment_upload_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, m.OperationId))
		if e == nil {
			if !bytes.Equal(fp, r.Fingerprint) {
				return errRepositoryAccessConflict
			}
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		if _, e = s.attachmentUploadPreflight(held, session, token, m); e != nil {
			return e
		}
		r, e = scanAttachmentUpload(tx.QueryRowContext(held, `INSERT INTO golf_attachment_upload_operations(user_id,forge_url,actor_id,operation_id,repository_id,original,input_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING `+attachmentUploadColumns, c.UserID, s.config.GiteaURL, actor.ID, m.OperationId, id, attachmentUploadOriginalBytes(m), fp))
		fresh = e == nil
		return e
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if fresh {
		if _, e = s.attachmentUploadPreflight(ctx, session, token, m); e != nil {
			r, e = s.advanceAttachmentUpload(ctx, session, token, r, "REJECTED", nil)
		} else {
			r, e = s.advanceAttachmentUpload(ctx, session, token, r, "DISPATCH_UNKNOWN", nil)
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
			var nativeErr error
			var result *golfv1.DiscussionAttachment
			e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, _ database.LockManagedSessionRow, _ []byte) error {
				held, e := s.lockAttachmentUpload(ctx, tx, id)
				if e != nil {
					return e
				}
				before, e := s.attachmentUploadPreflight(held, session, token, m)
				if e != nil {
					return e
				}
				held = context.WithValue(held, discussionResourcePermitKey{}, discussionResourcePermit{upload: &attachmentUploadPermit{r, m}})
				base, _ := repositoryPath(keyFrom(m.Target.Repository))
				receipt, e := s.uploadNativeAttachment(held, token, discussionAttachmentRoute(base, m.Target), m.Name, m.Content, attachmentUploadManifest(m))
				nativeErr = e
				if nativeErr == nil {
					result, nativeErr = s.attachmentUploadPostflight(held, session, token, m, before, receipt)
				}
				return nil
			})
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
			if nativeErr == nil {
				r, e = s.advanceAttachmentUpload(ctx, session, token, r, "SUCCEEDED", result)
			}
		}
		if e != nil {
			return nil, lifecycleRPCError(e)
		}
	}
	inspect := connect.NewRequest(&golfv1.GetDiscussionAttachmentUploadOperationRequest{Target: m.Target, OperationId: m.OperationId})
	inspect.Header().Set("Cookie", req.Header().Get("Cookie"))
	inspect.Header().Set("Origin", req.Header().Get("Origin"))
	out, e := s.GetDiscussionAttachmentUploadOperation(ctx, inspect)
	if e != nil {
		return nil, e
	}
	return connect.NewResponse(&golfv1.SubmitDiscussionAttachmentUploadResponse{Operation: out.Msg.Operation}), nil
}
