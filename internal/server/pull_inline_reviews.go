package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
)

var errInlineReviewBlocked = errors.New("review publication domain blocked")

func reviewAdmissionError(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && (pg.Code == "23P01" || pg.Code == "23505") {
		return errInlineReviewBlocked
	}
	return err
}
func inlineDecision(state golfv1.PullRequestReviewState) string {
	switch state {
	case golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENT:
		return "COMMENT"
	case golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_APPROVED:
		return "APPROVED"
	case golfv1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_REQUEST_CHANGES:
		return "REQUEST_CHANGES"
	}
	return ""
}
func inlineRequestFingerprint(m *golfv1.PublishPullRequestReviewDraftRequest) []byte {
	raw, _ := proto.MarshalOptions{Deterministic: true}.Marshal(m)
	h := sha256.Sum256(raw)
	return h[:]
}
func inlinePayloadFingerprint(input reviewerPublicationInput) []byte {
	// Entry order is immutable intent, even though native child iteration is not.
	raw, _ := json.Marshal(input)
	h := sha256.Sum256(raw)
	return h[:]
}
func inlinePayload(draft *golfv1.PullReviewDraft, decision string) (reviewerPublicationInput, reviewComparison, error) {
	var c reviewComparison
	if draft == nil || draft.Comparison == nil || draft.Comparison.Capture == nil || draft.Comparison.Capture.Selection == nil || len(draft.Entries) == 0 || len(draft.Entries) > 20 || !discussionText(draft.Summary, 6000) || decision != "APPROVED" && strings.TrimSpace(draft.Summary) == "" {
		return reviewerPublicationInput{}, c, invalid("Publish 1–20 saved inline entries and a supported decision. Comment/change requests require a nonempty saved summary.")
	}
	if err := validateReviewDraftContents(draft.Summary, draft.Entries, draft.Comparison); err != nil {
		return reviewerPublicationInput{}, c, err
	}
	var err error
	c, err = parseReviewComparison(draft.Comparison.RawDiff)
	if err != nil {
		return reviewerPublicationInput{}, c, err
	}
	input := reviewerPublicationInput{Body: draft.Summary, Head: draft.Comparison.Capture.Selection.HeadCommitId, Event: decision, Comments: []reviewerPublicationComment{}}
	for _, entry := range draft.Entries {
		selected := entry.Coordinate
		old := selected.Side == golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_OLD
		if !c.allowsSide(selected.Path, int(selected.Line), old) {
			return input, c, invalid("Selected native context is not qualified for publication. Renamed/deleted files remain private-draft only.")
		}
		comment := reviewerPublicationComment{Path: selected.Path, Body: entry.Body}
		if old {
			comment.OldLine = int(selected.Line)
		} else {
			comment.NewLine = int(selected.Line)
		}
		input.Comments = append(input.Comments, comment)
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return input, c, errInvalidForgeResponse
	}
	budget := len(raw) + (len(input.Comments)+1)*(16<<10)
	for _, comment := range input.Comments {
		line, old := comment.NewLine, false
		if comment.OldLine > 0 {
			line, old = comment.OldLine, true
		}
		size, ok := c.nativeContextJSONBoundSide(comment.Path, line, old)
		if !ok || size > maxForgeResponse-budget {
			return input, c, invalid("Complete native review receipt would exceed the supported transport/context bound.")
		}
		budget += size
	}
	if budget > maxForgeResponse {
		return input, c, errForgeResponseTooLarge
	}
	return input, c, nil
}
func wireInlineReview(r database.GolfInlineReviewMutation) *golfv1.PullInlineReviewMutation {
	row := &golfv1.PullInlineReviewMutation{OperationId: r.OperationID.String(), Target: &golfv1.PullReviewDraftTarget{Repository: &golfv1.RepositoryKey{Owner: r.RepositoryOwner, Name: r.RepositoryName}, RepositoryId: strconv.FormatInt(r.RepositoryID, 10), PullRequestId: strconv.FormatInt(r.PullRequestID, 10), Number: uint32(r.PullNumber)}, DraftId: r.DraftID.String(), AcceptedVersion: strconv.FormatInt(r.DraftVersion, 10), AcceptedTargetGeneration: strconv.FormatInt(r.TargetGeneration, 10), ComparisonId: r.ComparisonID.String(), Decision: pullReviewState(r.Decision), Phase: golfv1.PullInlineReviewPhase(golfv1.PullInlineReviewPhase_value["PULL_INLINE_REVIEW_PHASE_"+r.Phase]), FailureCode: r.FailureCode, BaseTipCommitId: r.BaseTip, MergeBaseCommitId: r.MergeBase, HeadCommitId: r.HeadCommit, DiffSha256: r.DiffSha256, CreatedAt: r.CreatedAt.Format(time.RFC3339Nano), UpdatedAt: r.UpdatedAt.Format(time.RFC3339Nano)}
	if r.ObservedReviewID > 0 {
		row.ObservedReviewId = strconv.FormatInt(r.ObservedReviewID, 10)
	}
	var ids []int64
	_ = json.Unmarshal(r.VerifiedCommentIds, &ids)
	for _, id := range ids {
		row.VerifiedCommentIds = append(row.VerifiedCommentIds, strconv.FormatInt(id, 10))
	}
	return row
}
func inlineScopeMatches(r database.GolfInlineReviewMutation, scope reviewDraftScope, draft, forge string) bool {
	return r.ForgeURL == forge && r.RepositoryID == scope.repositoryID && r.PullRequestID == scope.pullID && r.PullNumber == scope.number && r.DraftID.String() == draft
}
func (s *Server) getInlineReview(ctx context.Context, session string, token forgeCredential, m *golfv1.GetPullRequestInlineReviewMutationRequest) (*golfv1.PullInlineReviewMutation, error) {
	scope, err := reviewDraftTarget(m.Target)
	if err != nil {
		return nil, err
	}
	if reviewDraftUUID(m.DraftId) != nil || reviewDraftUUID(m.OperationId) != nil {
		return nil, invalid("Inspect an exact draft and publication operation UUID.")
	}
	var result *golfv1.PullInlineReviewMutation
	err = s.withReviewDraftAuthority(ctx, session, token, m.Target, scope, func(_ string, _ Repository, _ forgePull) error {
		return s.withManagedSession(ctx, session, token, func(q *database.Queries, caller database.LockManagedSessionRow, _ []byte) error {
			actor, e := q.GetReviewDraftActor(ctx, database.GetReviewDraftActorParams{ID: caller.UserID, ForgeURL: s.config.GiteaURL})
			if e != nil {
				return errStorageUnavailable
			}
			r, e := q.GetInlineReviewMutation(ctx, database.GetInlineReviewMutationParams{UserID: caller.UserID, OperationID: uuid.MustParse(m.OperationId)})
			if errors.Is(e, sql.ErrNoRows) || e == nil && (!inlineScopeMatches(r, scope, m.DraftId, s.config.GiteaURL) || r.ActorID != actor) {
				return errResourceNotFound
			}
			if e != nil {
				return errStorageUnavailable
			}
			result = wireInlineReview(r)
			return nil
		})
	})
	return result, err
}
func (s *Server) GetPullRequestInlineReviewMutation(ctx context.Context, req *connect.Request[golfv1.GetPullRequestInlineReviewMutationRequest]) (*connect.Response[golfv1.GetPullRequestInlineReviewMutationResponse], error) {
	token, session, err := s.reviewDraftCaller(ctx, req.Header())
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	result, err := s.getInlineReview(ctx, session, token, req.Msg)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.GetPullRequestInlineReviewMutationResponse{Mutation: result}), nil
}

func (s *Server) reserveInlineReview(ctx context.Context, session string, token forgeCredential, m *golfv1.PublishPullRequestReviewDraftRequest, scope reviewDraftScope, version, generation int64) (database.GolfInlineReviewMutation, *golfv1.PullReviewDraft, reviewerPublicationInput, reviewComparison, bool, error) {
	var r database.GolfInlineReviewMutation
	var draft *golfv1.PullReviewDraft
	var input reviewerPublicationInput
	var parsed reviewComparison
	owned := false
	err := s.withManagedSession(ctx, session, token, func(q *database.Queries, caller database.LockManagedSessionRow, _ []byte) error {
		actor, e := q.GetReviewDraftActor(ctx, database.GetReviewDraftActorParams{ID: caller.UserID, ForgeURL: s.config.GiteaURL})
		if e != nil {
			return errStorageUnavailable
		}
		existing, e := q.GetInlineReviewMutation(ctx, database.GetInlineReviewMutationParams{UserID: caller.UserID, OperationID: uuid.MustParse(m.OperationId)})
		if e == nil {
			if !inlineScopeMatches(existing, scope, m.DraftId, s.config.GiteaURL) || existing.ActorID != actor || !bytes.Equal(existing.RequestFingerprint, inlineRequestFingerprint(m)) {
				return errReviewDraftIntent
			}
			r = existing
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		d, e := q.GetReviewDraft(ctx, database.GetReviewDraftParams{ID: uuid.MustParse(m.DraftId), UserID: caller.UserID, ForgeURL: s.config.GiteaURL, RepositoryID: scope.repositoryID, PullRequestID: scope.pullID})
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if e != nil {
			return errStorageUnavailable
		}
		slot, e := q.GetReviewDraftTarget(ctx, database.GetReviewDraftTargetParams{UserID: caller.UserID, ForgeURL: s.config.GiteaURL, RepositoryID: scope.repositoryID, PullRequestID: scope.pullID})
		if e != nil {
			return errStorageUnavailable
		}
		if d.Deleted || d.CurrentVersion != version || d.ComparisonID.String() != m.ComparisonId || slot.Generation != generation || d.PullNumber != scope.number || slot.PullNumber != scope.number {
			return errReviewDraftConflict
		}
		draft, e = s.wireReviewDraft(ctx, q, d, m.Target)
		if e != nil {
			return e
		}
		input, parsed, e = inlinePayload(draft, inlineDecision(m.Decision))
		if e != nil {
			return e
		}
		if e = q.LockReviewContentQuota(ctx); e != nil {
			return errStorageUnavailable
		}
		quota, e := q.InlineReviewQuota(ctx, caller.UserID)
		if e != nil {
			return errStorageUnavailable
		}
		if quota.OwnerRecords >= 1000 || quota.InstanceRecords >= 10000 {
			return errReviewDraftQuota
		}
		c := draft.Comparison.Capture
		r, e = q.ReserveInlineReviewMutation(ctx, database.ReserveInlineReviewMutationParams{OperationID: uuid.MustParse(m.OperationId), UserID: caller.UserID, ForgeURL: s.config.GiteaURL, ActorID: actor, RepositoryID: scope.repositoryID, PullRequestID: scope.pullID, PullNumber: scope.number, RepositoryOwner: m.Target.Repository.Owner, RepositoryName: m.Target.Repository.Name, DraftID: d.ID, DraftVersion: version, TargetGeneration: generation, ComparisonID: d.ComparisonID, RequestFingerprint: inlineRequestFingerprint(m), PayloadFingerprint: inlinePayloadFingerprint(input), ExpectedRevision: c.ExpectedPullRevision, BaseTip: c.Selection.BaseCommitId, MergeBase: c.MergeBaseCommitId, HeadCommit: c.Selection.HeadCommitId, DiffSha256: c.DiffSha256, Decision: input.Event, EntryCount: int32(len(input.Comments))})
		if e != nil {
			if errors.Is(reviewAdmissionError(e), errInlineReviewBlocked) {
				return errInlineReviewBlocked
			}
			return errStorageUnavailable
		}
		if e = q.AppendInlineReviewEvent(ctx, database.AppendInlineReviewEventParams{UserID: caller.UserID, OperationID: r.OperationID, Phase: "RESERVED"}); e != nil {
			return errStorageUnavailable
		}
		owned = true
		return nil
	})
	return r, draft, input, parsed, owned, err
}
func mustInlineCommentIDs(ids []int64) []byte {
	raw, _ := json.Marshal(ids)
	return raw
}

func (s *Server) advanceInlineReview(ctx context.Context, r database.GolfInlineReviewMutation, phase, event, reason string, receipt int64, children []int64) (database.GolfInlineReviewMutation, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return r, errStorageUnavailable
	}
	defer tx.Rollback()
	q := database.New(s.db).WithTx(tx)
	if children == nil {
		children = []int64{}
	}
	updated, err := q.AdvanceInlineReviewMutation(ctx, database.AdvanceInlineReviewMutationParams{UserID: r.UserID, OperationID: r.OperationID, Phase: phase, ObservedReviewID: receipt, VerifiedCommentIds: mustInlineCommentIDs(children), FailureCode: reason})
	if err != nil {
		return r, errStorageUnavailable
	}
	if err = q.AppendInlineReviewEvent(ctx, database.AppendInlineReviewEventParams{UserID: r.UserID, OperationID: r.OperationID, Phase: event, ObservedReviewID: receipt, FailureCode: reason}); err != nil {
		return r, errStorageUnavailable
	}
	if err = tx.Commit(); err != nil {
		return r, errStorageUnavailable
	}
	return updated, nil
}
func inlineHeaderMatches(row forgePullReview, r database.GolfInlineReviewMutation, pull forgePull, input reviewerPublicationInput) bool {
	return row.ID > 0 && (r.ObservedReviewID == 0 || row.ID == r.ObservedReviewID) && validPullUser(row.User) && row.User != nil && row.User.ID == r.ActorID && row.PullRequestURL == pull.HTMLURL && row.State == r.Decision && row.CommitID == r.HeadCommit && !row.Dismissed && row.Body == input.Body && row.CommentsCount != nil && *row.CommentsCount == int64(len(input.Comments)) && validPullTime(row.SubmittedAt) && validPullTime(row.UpdatedAt)
}
func (s *Server) verifyInlineReview(ctx context.Context, token forgeCredential, base string, repo Repository, pull forgePull, r database.GolfInlineReviewMutation, input reviewerPublicationInput, c reviewComparison) ([]int64, error) {
	if !bytes.Equal(r.PayloadFingerprint, inlinePayloadFingerprint(input)) || r.EntryCount != int32(len(input.Comments)) {
		return nil, errInvalidForgeResponse
	}
	route := base + "/pulls/" + strconv.FormatInt(int64(r.PullNumber), 10) + "/reviews/" + strconv.FormatInt(r.ObservedReviewID, 10)
	read := func() (forgePullReview, error) {
		var row forgePullReview
		_, err := s.forge(ctx, http.MethodGet, route, token, nil, &row)
		if err == nil && !inlineHeaderMatches(row, r, pull, input) {
			err = errInvalidForgeResponse
		}
		return row, err
	}
	before, err := read()
	if err != nil {
		return nil, err
	}
	var rows []forgePullReviewComment
	if _, err = s.forge(ctx, http.MethodGet, route+"/comments", token, nil, &rows); err != nil {
		return nil, err
	}
	if rows == nil || len(rows) != len(input.Comments) {
		return nil, errInvalidForgeResponse
	}
	ids := make([]int64, len(input.Comments))
	seen := map[int64]bool{}
	for _, row := range rows {
		if row.ID <= 0 || seen[row.ID] || row.User == nil || !validPullUser(row.User) || row.User.ID != r.ActorID || !validPullUser(row.Resolver) || row.ReviewID != r.ObservedReviewID || row.PullRequestURL != pull.HTMLURL || !validSourcePath(row.Path) || row.Path == "" || (row.Position == 0) == (row.OriginalPosition == 0) || row.Position > 2147483647 || row.OriginalPosition > 2147483647 || !discussionText(row.Body, 6000) || !discussionText(row.DiffHunk, 64<<10) || !validPullTime(row.CreatedAt) || !validPullTime(row.UpdatedAt) || row.CommitID != "" && (!objectID.MatchString(row.CommitID) || len(row.CommitID) != len(r.HeadCommit)) || row.OriginalCommitID != "" && (!objectID.MatchString(row.OriginalCommitID) || len(row.OriginalCommitID) != len(r.HeadCommit)) {
			return nil, errInvalidForgeResponse
		}
		if !discussionURL(row.HTMLURL, repo.HTMLURL, "/pulls/"+strconv.FormatInt(int64(r.PullNumber), 10), "issuecomment-"+strconv.FormatInt(row.ID, 10)) && !discussionURL(row.HTMLURL, repo.HTMLURL, "/pulls/"+strconv.FormatInt(int64(r.PullNumber), 10)+"/files", "issuecomment-"+strconv.FormatInt(row.ID, 10)) {
			return nil, errInvalidForgeResponse
		}
		seen[row.ID] = true
		at := -1
		for i, comment := range input.Comments {
			if ids[i] == 0 && comment.Path == row.Path && uint64(comment.NewLine) == row.Position && uint64(comment.OldLine) == row.OriginalPosition && comment.Body == row.Body {
				at = i
				break
			}
		}
		if at < 0 {
			return nil, errInvalidForgeResponse
		}
		line, old := int(row.Position), false
		if row.OriginalPosition > 0 {
			line, old = int(row.OriginalPosition), true
		}
		if !c.matchesNativeContextSide(row.Path, line, old, row.DiffHunk) {
			return nil, errInvalidForgeResponse
		}
		ids[at] = row.ID
	}
	after, err := read()
	if err != nil {
		return nil, err
	}
	if !reflect.DeepEqual(before, after) {
		return nil, errPullSnapshotChanged
	}
	return ids, nil
}
func (s *Server) inlinePreflight(ctx context.Context, session string, token forgeCredential, target *golfv1.PullReviewDraftTarget, scope reviewDraftScope, r database.GolfInlineReviewMutation, draft *golfv1.PullReviewDraft) (string, Repository, forgePull, error) {
	var base string
	var repo Repository
	var pull forgePull
	err := s.withReviewDraftAuthority(ctx, session, token, target, scope, func(b string, rp Repository, p forgePull) error {
		base, repo, pull = b, rp, p
		if pullRevision(p) != r.ExpectedRevision || p.Base.SHA != r.BaseTip || p.Head.SHA != r.HeadCommit || p.MergeBase != r.MergeBase || p.State != "open" || *p.Draft || *p.Merged || r.Decision != "COMMENT" && p.User != nil && p.User.ID == r.ActorID {
			return errPullSnapshotChanged
		}
		captured := proto.Clone(draft.Comparison.Capture).(*golfv1.PullReviewDraftCapture)
		captured.Selection.Repository = proto.Clone(target.Repository).(*golfv1.RepositoryKey)
		current, e := s.captureReviewDraft(ctx, session, token, captured)
		if e != nil {
			return e
		}
		if current.RawDiff != draft.Comparison.RawDiff {
			return errPullSnapshotChanged
		}
		return nil
	})
	return base, repo, pull, err
}

// Review submission can change the native PR timestamp. Matching this bounded
// semantic observation does not attribute that change or lock external writers.
func inlinePullSemanticsMatch(original, current forgePull) bool {
	current.UpdatedAt = original.UpdatedAt
	return current.MergeBase == original.MergeBase && pullRevision(current) == pullRevision(original)
}
func (s *Server) inlinePostflight(ctx context.Context, session string, token forgeCredential, target *golfv1.PullReviewDraftTarget, r database.GolfInlineReviewMutation, draft *golfv1.PullReviewDraft, original forgePull) error {
	selection := proto.Clone(draft.Comparison.Capture.Selection).(*golfv1.PullRequestSelection)
	selection.Repository = proto.Clone(target.Repository).(*golfv1.RepositoryKey)
	return s.withPullSelection(ctx, session, token, selection, func(base string, repo Repository, current forgePull) error {
		if repo.ID != r.RepositoryID || current.ID != r.PullRequestID || !inlinePullSemanticsMatch(original, current) {
			return errPullSnapshotChanged
		}
		raw, err := s.readCommitDiff(ctx, base+"/pulls/"+strconv.FormatInt(int64(r.PullNumber), 10)+".diff", token)
		if err != nil {
			return err
		}
		if raw != draft.Comparison.RawDiff {
			return errPullSnapshotChanged
		}
		after, err := s.readPull(ctx, token, base, repo, uint32(r.PullNumber))
		if err != nil {
			return err
		}
		if !inlinePullSemanticsMatch(original, after) {
			return errPullSnapshotChanged
		}
		return nil
	})
}

func (s *Server) PublishPullRequestReviewDraft(ctx context.Context, req *connect.Request[golfv1.PublishPullRequestReviewDraftRequest]) (*connect.Response[golfv1.PublishPullRequestReviewDraftResponse], error) {
	token, session, err := s.reviewDraftCaller(ctx, req.Header())
	if err != nil {
		return nil, err
	}
	m := req.Msg
	scope, err := reviewDraftTarget(m.Target)
	if err != nil {
		return nil, rpcError(err)
	}
	version, err := reviewDraftCounter(m.ExpectedVersion, false)
	if err != nil {
		return nil, rpcError(err)
	}
	generation, err := reviewDraftCounter(m.ExpectedTargetGeneration, false)
	if err != nil {
		return nil, rpcError(err)
	}
	if reviewDraftUUID(m.DraftId) != nil || reviewDraftUUID(m.ComparisonId) != nil || reviewDraftUUID(m.OperationId) != nil || inlineDecision(m.Decision) == "" {
		return nil, rpcError(invalid("Publish an exact saved draft version/comparison with canonical operation UUID and supported decision."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var r database.GolfInlineReviewMutation
	var draft *golfv1.PullReviewDraft
	var input reviewerPublicationInput
	var parsed reviewComparison
	var owned bool
	err = s.withReviewDraftAuthority(ctx, session, token, m.Target, scope, func(_ string, _ Repository, _ forgePull) error {
		var e error
		r, draft, input, parsed, owned, e = s.reserveInlineReview(ctx, session, token, m, scope, version, generation)
		return e
	})
	if err != nil {
		// This invocation has issued no POST. A reservation that committed
		// before the outer authority observation failed can be refused safely.
		if owned && r.Phase == "RESERVED" {
			clean, done := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			_, finishErr := s.advanceInlineReview(clean, r, "REJECTED", "REJECTED", "preflight_refused", 0, nil)
			done()
			if finishErr != nil {
				return nil, rpcError(finishErr)
			}
		}
		return nil, rpcError(err)
	}
	if owned {
		finish := func(phase, event, reason string, receipt int64, ids []int64) error {
			clean, done := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer done()
			updated, e := s.advanceInlineReview(clean, r, phase, event, reason, receipt, ids)
			if e == nil {
				r = updated
			}
			return e
		}
		base, repo, pull, e := s.inlinePreflight(ctx, session, token, m.Target, scope, r, draft)
		if e == nil {
			pending, pe := s.ownPendingReview(ctx, session, token, database.GolfPullReviewMutation{RepositoryOwner: m.Target.Repository.Owner, RepositoryName: m.Target.Repository.Name, RepositoryID: r.RepositoryID, PullRequestID: r.PullRequestID, Number: int64(r.PullNumber), ActorForgeUserID: r.ActorID})
			e = pe
			if pending {
				e = errInlineReviewBlocked
			}
		}
		if e == nil {
			base, repo, pull, e = s.inlinePreflight(ctx, session, token, m.Target, scope, r, draft)
		}
		if e != nil {
			if err = finish("REJECTED", "REJECTED", "preflight_refused", 0, nil); err != nil {
				return nil, rpcError(err)
			}
		} else {
			// Once dispatch intent is committed, even a failed commit acknowledgement
			// keeps a durable blocker. Only this invocation owns the single POST.
			r, err = s.advanceInlineReview(ctx, r, "DISPATCH_UNKNOWN", "DISPATCH_UNKNOWN", "", 0, nil)
			if err != nil {
				return nil, rpcError(err)
			}
			var receipt forgePullReview
			_, e = s.forgeJSON(ctx, http.MethodPost, base+"/pulls/"+strconv.FormatInt(int64(r.PullNumber), 10)+"/reviews", token, input, &receipt, http.StatusOK)
			if receipt.ID > 0 {
				if err = finish("DISPATCH_UNKNOWN", "RECEIPT", "", receipt.ID, nil); err != nil {
					return nil, rpcError(err)
				}
			}
			if e == nil && !inlineHeaderMatches(receipt, r, pull, input) {
				e = errInvalidForgeResponse
			}
			var ids []int64
			if e == nil {
				ids, e = s.verifyInlineReview(ctx, token, base, repo, pull, r, input, parsed)
			}
			if e == nil {
				e = s.inlinePostflight(ctx, session, token, m.Target, r, draft, pull)
			}
			if e != nil {
				err = finish("DISPATCH_UNKNOWN", "UNCERTAIN", "native_effect_unverified", r.ObservedReviewID, nil)
			} else {
				err = finish("SUCCEEDED", "SUCCEEDED", "", r.ObservedReviewID, ids)
			}
			if err != nil {
				return nil, rpcError(err)
			}
		}
	}
	// No replay/status call promotes unknown by observing similar native content.
	result, err := s.getInlineReview(ctx, session, token, &golfv1.GetPullRequestInlineReviewMutationRequest{Target: m.Target, DraftId: m.DraftId, OperationId: m.OperationId})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.PublishPullRequestReviewDraftResponse{Mutation: result}), nil
}
