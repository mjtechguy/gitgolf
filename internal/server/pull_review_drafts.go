package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
)

var errReviewDraftConflict = errors.New("private draft CAS conflict")
var errReviewDraftIntent = errors.New("private draft operation intent changed")
var errReviewDraftQuota = errors.New("private draft retention quota")

const reviewDraftParserVersion = "golf-strict-diff-v1"
const maxReviewDraftEntries = 20
const maxReviewDraftVersions = 100
const maxReviewOwnerRecords = 1000
const maxReviewInstanceRecords = 10000
const maxReviewOwnerBytes = 128 << 20
const maxReviewInstanceBytes = 1 << 30

// Versions and generations are explicit canonical signed64 strings. A missing
// value is never an implicit zero: clients must first inspect the target slot.
func reviewDraftCounter(value string, allowZero bool) (int64, error) {
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n < 0 || !allowZero && n == 0 || strconv.FormatInt(n, 10) != value {
		return 0, invalid("Draft versions and target generations require canonical signed64 decimal strings.")
	}
	return n, nil
}
func reviewDraftUUID(value string) error {
	if !creationKey.MatchString(value) {
		return invalid("Draft, entry, comparison and operation IDs require canonical UUIDv4 strings.")
	}
	return nil
}

type reviewDraftScope struct {
	repositoryID, pullID int64
	number               int32
}

func reviewDraftTarget(value *golfv1.PullReviewDraftTarget) (reviewDraftScope, error) {
	if value == nil || value.Repository == nil {
		return reviewDraftScope{}, invalid("Select an exact repository and pull request.")
	}
	if _, err := repositoryPath(keyFrom(value.Repository)); err != nil {
		return reviewDraftScope{}, err
	}
	rid, e := discussionID(value.RepositoryId)
	pid, e2 := discussionID(value.PullRequestId)
	if e != nil {
		return reviewDraftScope{}, e
	}
	if e2 != nil {
		return reviewDraftScope{}, e2
	}
	if err := pullNumber(value.Number); err != nil {
		return reviewDraftScope{}, err
	}
	return reviewDraftScope{rid, pid, int32(value.Number)}, nil
}
func sameReviewDraftIdentity(a, b *golfv1.PullReviewDraftTarget) bool {
	return a != nil && b != nil && a.RepositoryId == b.RepositoryId && a.PullRequestId == b.PullRequestId && a.Number == b.Number
}
func captureReviewDraftTarget(c *golfv1.PullReviewDraftCapture) *golfv1.PullReviewDraftTarget {
	s := c.GetSelection()
	return &golfv1.PullReviewDraftTarget{Repository: s.GetRepository(), RepositoryId: s.GetRepositoryId(), PullRequestId: s.GetPullRequestId(), Number: s.GetNumber()}
}
func validateReviewDraftCapture(target *golfv1.PullReviewDraftTarget, c *golfv1.PullReviewDraftCapture) error {
	if c == nil || c.Selection == nil || !proto.Equal(target, captureReviewDraftTarget(c)) || !issueRevisionPattern.MatchString(c.ExpectedPullRevision) || !issueRevisionPattern.MatchString(c.DiffSha256) || !objectID.MatchString(c.MergeBaseCommitId) || !objectID.MatchString(c.Selection.BaseCommitId) || !objectID.MatchString(c.Selection.HeadCommitId) || len(c.MergeBaseCommitId) != len(c.Selection.HeadCommitId) || len(c.Selection.HeadCommitId) != len(c.Selection.BaseCommitId) {
		return invalid("Capture must bind the exact target, displayed revision, actual merge base, branch tip, head and diff SHA-256.")
	}
	return nil
}
func validateReviewDraftContents(summary string, entries []*golfv1.PullReviewDraftEntry, comparison *golfv1.PullReviewDraftComparison) error {
	if !discussionText(summary, 6000) || len(entries) > maxReviewDraftEntries {
		return invalid("Draft summary is limited to 6000 UTF-8 bytes and drafts to 20 entries.")
	}
	total := len(summary)
	ids := map[string]bool{}
	coordinates := map[string]bool{}
	var parsed reviewComparison
	if comparison != nil {
		var err error
		parsed, err = parseReviewComparison(comparison.RawDiff)
		if err != nil {
			return invalid("This comparison cannot safely retain inline coordinates.")
		}
	}
	for _, entry := range entries {
		if entry == nil || reviewDraftUUID(entry.Id) != nil || ids[entry.Id] || strings.TrimSpace(entry.Body) == "" || !discussionText(entry.Body, 6000) || entry.Coordinate == nil {
			return invalid("Each entry requires a unique UUID, selected coordinate and nonempty text up to 6000 UTF-8 bytes.")
		}
		ids[entry.Id] = true
		c := entry.Coordinate
		if c.Line == 0 || c.Line > math.MaxInt32 || c.Path == "" || len(c.Path) > 4096 || !validSourcePath(c.Path) || c.Side != golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_OLD && c.Side != golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_NEW {
			return invalid("Select an ordinary old/new file line and safe literal path.")
		}
		key := strconv.FormatUint(uint64(c.FileIndex), 10) + ":" + strconv.FormatUint(uint64(c.HunkIndex), 10) + ":" + c.Side.String() + ":" + strconv.FormatUint(uint64(c.Line), 10)
		if coordinates[key] {
			return invalid("Only one draft entry is allowed per exact coordinate.")
		}
		coordinates[key] = true
		total += len(entry.Body) + len(c.Path)
		if comparison == nil {
			continue
		}
		if uint64(c.FileIndex) >= uint64(len(parsed.files)) {
			return invalid("Draft file coordinate is outside its saved comparison.")
		}
		f := parsed.files[c.FileIndex]
		if f.unsupported || uint64(c.HunkIndex) >= uint64(len(f.hunks)) {
			return invalid("This file/hunk is not supported for private draft coordinates.")
		}
		h := f.hunks[c.HunkIndex]
		if h.unsupported {
			return invalid("This hunk is not supported for private draft coordinates.")
		}
		path := f.newPath
		missing := f.newMissing
		if c.Side == golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_OLD {
			path = f.oldPath
			missing = f.oldMissing
		}
		if missing || c.Path != path {
			return invalid("Draft path does not match its selected old/new side.")
		}
		matches := 0
		for _, row := range h.rows {
			line := row.newLine
			if c.Side == golfv1.PullReviewDraftSide_PULL_REVIEW_DRAFT_SIDE_OLD {
				line = row.oldLine
			}
			if line == int(c.Line) && row.kind != '\\' {
				matches++
			}
		}
		if matches != 1 {
			return invalid("Draft coordinate requires exactly one ordinary row on its selected side.")
		}
	}
	if total > 256<<10 {
		return invalid("Decoded private draft content exceeds 256 KiB.")
	}
	return nil
}

// All three procedures remain browser-only, even when invoked directly rather
// than through the pre-decode HTTP boundary. No delegated/admin draft access.
func (s *Server) reviewDraftCaller(ctx context.Context, h http.Header) (forgeCredential, string, error) {
	if h.Get("Origin") != s.config.PublicURL || h.Get("Sec-Fetch-Site") == "cross-site" {
		return forgeCredential{}, "", connect.NewError(connect.CodePermissionDenied, errors.New("Use the configured Golf browser origin."))
	}
	if _, ok := ctx.Value(apiAuthKey{}).(apiAuth); ok || h.Get("Authorization") != "" {
		return forgeCredential{}, "", rpcError(errApiCredentialReadOnly)
	}
	token, err := rpcToken(ctx)
	if err != nil {
		return forgeCredential{}, "", err
	}
	session := s.cookieValue(h)
	if session == "" {
		return forgeCredential{}, "", rpcError(errUnauthenticated)
	}
	return token, session, nil
}
func (s *Server) withReviewDraftAuthority(ctx context.Context, session string, token forgeCredential, target *golfv1.PullReviewDraftTarget, scope reviewDraftScope, fn func(string, Repository, forgePull) error) error {
	return s.withRepositoryRead(ctx, session, token, keyFrom(target.Repository), func(base string, repo Repository) error {
		if repo.ID != scope.repositoryID {
			return errPullSnapshotChanged
		}
		before, err := s.readPull(ctx, token, base, repo, target.Number)
		if err != nil {
			return err
		}
		if before.ID != scope.pullID {
			return errPullSnapshotChanged
		}
		if err = fn(base, repo, before); err != nil {
			return err
		}
		after, err := s.readPull(ctx, token, base, repo, target.Number)
		if err != nil {
			return err
		}
		if after.ID != scope.pullID {
			return errPullSnapshotChanged
		}
		return nil
	})
}
func reviewContentBinding(row database.GolfReviewContent) []byte {
	// JSON is only a deterministic typed framing, never stored plaintext.
	data, _ := json.Marshal(struct {
		ID, Draft, Kind, Forge           string
		Owner, Repository, Pull, Version int64
	}{row.ID.String(), row.DraftID.String(), row.Kind, row.ForgeURL, row.UserID, row.RepositoryID, row.PullRequestID, row.Version})
	sum := sha256.Sum256(data)
	return sum[:]
}
func (s *Server) storeReviewContent(ctx context.Context, q *database.Queries, d database.GolfReviewDraft, version int64, kind string, id uuid.UUID, m proto.Message) error {
	raw, err := proto.MarshalOptions{Deterministic: true}.Marshal(m)
	if err != nil {
		return errCredentialUnavailable
	}
	row := database.GolfReviewContent{ID: id, DraftID: d.ID, UserID: d.UserID, ForgeURL: d.ForgeURL, RepositoryID: d.RepositoryID, PullRequestID: d.PullRequestID, Version: version, Kind: kind}
	binding := reviewContentBinding(row)
	encrypted, key, err := s.keyring.seal(reviewContentDomain, base64.StdEncoding.EncodeToString(raw), binding)
	if err != nil {
		return err
	}
	if len(encrypted) > 2<<20 {
		return errReviewDraftQuota
	}
	return q.InsertReviewContent(ctx, database.InsertReviewContentParams{ID: id, UserID: d.UserID, ForgeURL: d.ForgeURL, RepositoryID: d.RepositoryID, PullRequestID: d.PullRequestID, DraftID: d.ID, Version: version, Kind: kind, EncryptedContent: encrypted, ContentBinding: binding, CredentialKeyID: key})
}
func (s *Server) openReviewContent(ctx context.Context, q *database.Queries, d database.GolfReviewDraft, id uuid.UUID, kind string, version int64, m proto.Message) error {
	row, err := q.GetReviewContent(ctx, database.GetReviewContentParams{ID: id, UserID: d.UserID, ForgeURL: d.ForgeURL, RepositoryID: d.RepositoryID, PullRequestID: d.PullRequestID, DraftID: d.ID})
	if err != nil {
		return errCredentialUnavailable
	}
	if row.Kind != kind || row.Version != version || !bytes.Equal(row.ContentBinding, reviewContentBinding(row)) {
		return errCredentialUnavailable
	}
	plain, err := s.keyring.open(row.CredentialKeyID, reviewContentDomain, row.EncryptedContent, row.ContentBinding)
	if err != nil {
		return err
	}
	raw, err := base64.StdEncoding.DecodeString(plain)
	if err != nil || proto.Unmarshal(raw, m) != nil {
		return errCredentialUnavailable
	}
	return nil
}
func (s *Server) loadReviewComparison(ctx context.Context, q *database.Queries, d database.GolfReviewDraft) (*golfv1.PullReviewDraftComparison, error) {
	c := new(golfv1.PullReviewDraftComparison)
	if err := s.openReviewContent(ctx, q, d, d.ComparisonID, "comparison", 0, c); err != nil {
		return nil, err
	}
	if c.Id != d.ComparisonID.String() || c.ParserVersion != reviewDraftParserVersion || c.ByteSize != uint32(len(c.RawDiff)) || len(c.RawDiff) > maxCommitDiffBytes || c.Capture == nil {
		return nil, errCredentialUnavailable
	}
	t := captureReviewDraftTarget(c.Capture)
	scope, err := reviewDraftTarget(t)
	digest := sha256.Sum256([]byte(c.RawDiff))
	if err != nil || validateReviewDraftCapture(t, c.Capture) != nil || scope.repositoryID != d.RepositoryID || scope.pullID != d.PullRequestID || scope.number != d.PullNumber || hex.EncodeToString(digest[:]) != c.Capture.DiffSha256 {
		return nil, errCredentialUnavailable
	}
	if _, err := parseReviewComparison(c.RawDiff); err != nil {
		return nil, errCredentialUnavailable
	}
	return c, nil
}
func (s *Server) loadReviewOperation(ctx context.Context, q *database.Queries, d database.GolfReviewDraft, v database.GolfReviewDraftVersion) (*golfv1.PullReviewDraftReceipt, proto.Message, error) {
	if v.DraftID != d.ID || v.UserID != d.UserID || v.ForgeURL != d.ForgeURL || v.RepositoryID != d.RepositoryID || v.PullRequestID != d.PullRequestID || v.Version != v.ExpectedVersion+1 || v.AcceptedGeneration != v.ExpectedGeneration+1 {
		return nil, nil, errCredentialUnavailable
	}
	var input proto.Message
	var target *golfv1.PullReviewDraftTarget
	var op, draft, expected, generation string
	var kind golfv1.PullReviewDraftOperationKind
	switch v.Kind {
	case "SAVE":
		m := new(golfv1.SavePullRequestReviewDraftRequest)
		input = m
		if err := s.openReviewContent(ctx, q, d, v.ContentID, "operation", v.Version, m); err != nil {
			return nil, nil, err
		}
		target, op, draft, expected, generation = m.Target, m.OperationId, m.DraftId, m.ExpectedVersion, m.ExpectedTargetGeneration
		kind = golfv1.PullReviewDraftOperationKind_PULL_REVIEW_DRAFT_OPERATION_KIND_SAVE
	case "DELETE":
		m := new(golfv1.DeletePullRequestReviewDraftRequest)
		input = m
		if err := s.openReviewContent(ctx, q, d, v.ContentID, "operation", v.Version, m); err != nil {
			return nil, nil, err
		}
		target, op, draft, expected, generation = m.Target, m.OperationId, m.DraftId, m.ExpectedVersion, m.ExpectedTargetGeneration
		kind = golfv1.PullReviewDraftOperationKind_PULL_REVIEW_DRAFT_OPERATION_KIND_DELETE
	default:
		return nil, nil, errCredentialUnavailable
	}
	scope, err := reviewDraftTarget(target)
	if err != nil || scope.repositoryID != d.RepositoryID || scope.pullID != d.PullRequestID || scope.number != d.PullNumber || op != v.OperationID.String() || draft != d.ID.String() || expected != strconv.FormatInt(v.ExpectedVersion, 10) || generation != strconv.FormatInt(v.ExpectedGeneration, 10) {
		return nil, nil, errCredentialUnavailable
	}
	receipt := &golfv1.PullReviewDraftReceipt{OperationId: op, DraftId: draft, Target: target, Kind: kind, ExpectedVersion: expected, AcceptedVersion: strconv.FormatInt(v.Version, 10), ComparisonId: d.ComparisonID.String(), ExpectedTargetGeneration: generation, AcceptedTargetGeneration: strconv.FormatInt(v.AcceptedGeneration, 10)}
	return receipt, input, nil
}
func (s *Server) wireReviewDraft(ctx context.Context, q *database.Queries, d database.GolfReviewDraft, target *golfv1.PullReviewDraftTarget) (*golfv1.PullReviewDraft, error) {
	if d.Deleted {
		return nil, nil
	}
	c, err := s.loadReviewComparison(ctx, q, d)
	if err != nil {
		return nil, err
	}
	v, err := q.GetReviewDraftVersion(ctx, database.GetReviewDraftVersionParams{DraftID: d.ID, Version: d.CurrentVersion, UserID: d.UserID})
	if err != nil {
		return nil, errCredentialUnavailable
	}
	_, input, err := s.loadReviewOperation(ctx, q, d, v)
	if err != nil {
		return nil, err
	}
	save, ok := input.(*golfv1.SavePullRequestReviewDraftRequest)
	if !ok || validateReviewDraftContents(save.Summary, save.Entries, c) != nil {
		return nil, errCredentialUnavailable
	}
	if save.ExpectedVersion == "0" {
		if !proto.Equal(save.GetCapture(), c.Capture) {
			return nil, errCredentialUnavailable
		}
	} else if save.GetComparisonId() != c.Id {
		return nil, errCredentialUnavailable
	}
	actor, err := q.GetReviewDraftActor(ctx, database.GetReviewDraftActorParams{ID: d.UserID, ForgeURL: d.ForgeURL})
	if err != nil {
		return nil, errStorageUnavailable
	}
	return &golfv1.PullReviewDraft{Id: d.ID.String(), Target: target, UserId: strconv.FormatInt(actor, 10), Version: strconv.FormatInt(d.CurrentVersion, 10), Comparison: c, Summary: save.Summary, Entries: save.Entries, CreatedAt: d.CreatedAt.Format(time.RFC3339Nano), UpdatedAt: d.UpdatedAt.Format(time.RFC3339Nano)}, nil
}
func (s *Server) getReviewDraftState(ctx context.Context, q *database.Queries, user int64, target *golfv1.PullReviewDraftTarget, scope reviewDraftScope, draftID, operationID string) (*golfv1.GetPullRequestReviewDraftResponse, error) {
	result := &golfv1.GetPullRequestReviewDraftResponse{TargetGeneration: "0", CurrentVersion: "0"}
	slot, err := q.GetReviewDraftTarget(ctx, database.GetReviewDraftTargetParams{UserID: user, ForgeURL: s.config.ForgeURL, RepositoryID: scope.repositoryID, PullRequestID: scope.pullID})
	if err == nil {
		if slot.PullNumber != scope.number {
			return nil, errPullSnapshotChanged
		}
		result.TargetGeneration = strconv.FormatInt(slot.Generation, 10)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, errStorageUnavailable
	}
	var d database.GolfReviewDraft
	if draftID == "" {
		d, err = q.GetActiveReviewDraft(ctx, database.GetActiveReviewDraftParams{UserID: user, ForgeURL: s.config.ForgeURL, RepositoryID: scope.repositoryID, PullRequestID: scope.pullID})
	} else {
		d, err = q.GetReviewDraft(ctx, database.GetReviewDraftParams{ID: uuid.MustParse(draftID), UserID: user, ForgeURL: s.config.ForgeURL, RepositoryID: scope.repositoryID, PullRequestID: scope.pullID})
	}
	if errors.Is(err, sql.ErrNoRows) {
		if draftID == "" {
			return result, nil
		}
		return nil, errResourceNotFound
	}
	if err != nil {
		return nil, errStorageUnavailable
	}
	if d.PullNumber != scope.number {
		return nil, errResourceNotFound
	}
	result.CurrentVersion = strconv.FormatInt(d.CurrentVersion, 10)
	result.Deleted = d.Deleted
	if operationID != "" {
		v, err := q.GetReviewDraftOperation(ctx, database.GetReviewDraftOperationParams{UserID: user, OperationID: uuid.MustParse(operationID)})
		if errors.Is(err, sql.ErrNoRows) || err == nil && (v.DraftID != d.ID || v.ForgeURL != d.ForgeURL || v.RepositoryID != scope.repositoryID || v.PullRequestID != scope.pullID) {
			return nil, errResourceNotFound
		}
		if err != nil {
			return nil, errStorageUnavailable
		}
		result.Receipt, _, err = s.loadReviewOperation(ctx, q, d, v)
		if err != nil {
			return nil, err
		}
	}
	result.Draft, err = s.wireReviewDraft(ctx, q, d, target)
	return result, err
}
func (s *Server) GetPullRequestReviewDraft(ctx context.Context, req *connect.Request[golfv1.GetPullRequestReviewDraftRequest]) (*connect.Response[golfv1.GetPullRequestReviewDraftResponse], error) {
	token, session, err := s.reviewDraftCaller(ctx, req.Header())
	if err != nil {
		return nil, err
	}
	m := req.Msg
	scope, err := reviewDraftTarget(m.Target)
	if err != nil {
		return nil, rpcError(err)
	}
	if m.DraftId != "" {
		if err = reviewDraftUUID(m.DraftId); err != nil {
			return nil, rpcError(err)
		}
	}
	if m.OperationId != "" {
		if m.DraftId == "" {
			return nil, rpcError(invalid("Operation inspection requires its original draft ID."))
		}
		if err = reviewDraftUUID(m.OperationId); err != nil {
			return nil, rpcError(err)
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var result *golfv1.GetPullRequestReviewDraftResponse
	err = s.withReviewDraftAuthority(ctx, session, token, m.Target, scope, func(_ string, _ Repository, _ forgePull) error {
		return s.withManagedSession(ctx, session, token, func(q *database.Queries, caller database.LockManagedSessionRow, _ []byte) error {
			var err error
			result, err = s.getReviewDraftState(ctx, q, caller.UserID, m.Target, scope, m.DraftId, m.OperationId)
			return err
		})
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
func (s *Server) reviewDraftReplay(ctx context.Context, q *database.Queries, user int64, target *golfv1.PullReviewDraftTarget, scope reviewDraftScope, draftID, op string, input proto.Message) (*golfv1.GetPullRequestReviewDraftResponse, error) {
	v, err := q.GetReviewDraftOperation(ctx, database.GetReviewDraftOperationParams{UserID: user, OperationID: uuid.MustParse(op)})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, errStorageUnavailable
	}
	if v.DraftID.String() != draftID || v.ForgeURL != s.config.ForgeURL || v.RepositoryID != scope.repositoryID || v.PullRequestID != scope.pullID {
		return nil, errReviewDraftIntent
	}
	d, err := q.GetReviewDraft(ctx, database.GetReviewDraftParams{ID: v.DraftID, UserID: user, ForgeURL: s.config.ForgeURL, RepositoryID: scope.repositoryID, PullRequestID: scope.pullID})
	if err != nil {
		return nil, errStorageUnavailable
	}
	_, original, err := s.loadReviewOperation(ctx, q, d, v)
	if err != nil {
		return nil, err
	}
	if !proto.Equal(original, input) {
		return nil, errReviewDraftIntent
	}
	return s.getReviewDraftState(ctx, q, user, target, scope, draftID, op)
}
func (s *Server) checkReviewDraftQuota(ctx context.Context, q *database.Queries, user int64, additional, additionalRecords int64, deleting bool) error {
	if err := q.LockReviewContentQuota(ctx); err != nil {
		return errStorageUnavailable
	}
	owner, err := q.ReviewContentQuota(ctx, user)
	if err != nil {
		return errStorageUnavailable
	}
	instance, err := q.ReviewContentInstanceQuota(ctx)
	if err != nil {
		return errStorageUnavailable
	}
	records, bytes, globalRecords, globalBytes := int64(maxReviewOwnerRecords), int64(maxReviewOwnerBytes), int64(maxReviewInstanceRecords), int64(maxReviewInstanceBytes)
	// Reserved metadata-only capacity makes a tombstone possible at the save
	// quota. A deleted UUID cannot consume this reserve twice.
	if deleting {
		records += 500
		bytes += 8 << 20
		globalRecords += 5000
		globalBytes += 64 << 20
	}
	if owner.Records+additionalRecords > records || owner.Bytes+additional > bytes || instance.Records+additionalRecords > globalRecords || instance.Bytes+additional > globalBytes {
		return errReviewDraftQuota
	}
	return nil
}
func (s *Server) captureReviewDraft(ctx context.Context, session string, token forgeCredential, c *golfv1.PullReviewDraftCapture) (*golfv1.PullReviewDraftComparison, error) {
	var result *golfv1.PullReviewDraftComparison
	err := s.withPullSelection(ctx, session, token, c.Selection, func(base string, repo Repository, pull forgePull) error {
		if pullRevision(pull) != c.ExpectedPullRevision || pull.MergeBase != c.MergeBaseCommitId {
			return errPullSnapshotChanged
		}
		raw, err := s.readCommitDiff(ctx, base+"/pulls/"+strconv.FormatUint(uint64(c.Selection.Number), 10)+".diff", token)
		if err != nil {
			return err
		}
		digest := sha256.Sum256([]byte(raw))
		if hex.EncodeToString(digest[:]) != c.DiffSha256 {
			return errPullSnapshotChanged
		}
		if _, err := parseReviewComparison(raw); err != nil {
			return invalid("This comparison cannot safely retain inline coordinates.")
		}
		after, err := s.readPull(ctx, token, base, repo, c.Selection.Number)
		if err != nil {
			return err
		}
		if pullRevision(after) != c.ExpectedPullRevision || after.MergeBase != c.MergeBaseCommitId {
			return errPullSnapshotChanged
		}
		result = &golfv1.PullReviewDraftComparison{Id: uuid.NewString(), Capture: proto.Clone(c).(*golfv1.PullReviewDraftCapture), ParserVersion: reviewDraftParserVersion, RawDiff: raw, ByteSize: uint32(len(raw))}
		return nil
	})
	return result, err
}

func reviewDraftMutationError(err error, committed bool) error {
	if committed && errors.Is(err, errPullSnapshotChanged) {
		return connect.NewError(connect.CodeUnavailable, errors.New("Private draft acknowledgement could not be revalidated. Inspect its exact operation before continuing."))
	}
	wire := rpcError(err)
	var input inputError
	if !committed && (errors.Is(err, errReviewDraftConflict) || errors.Is(err, errReviewDraftQuota) || errors.Is(err, errPullSnapshotChanged) || errors.As(err, &input)) {
		var ce *connect.Error
		if errors.As(wire, &ce) {
			ce.Meta().Set("Golf-Draft-Effect", "none")
		}
	}
	return wire
}

func (s *Server) SavePullRequestReviewDraft(ctx context.Context, req *connect.Request[golfv1.SavePullRequestReviewDraftRequest]) (*connect.Response[golfv1.SavePullRequestReviewDraftResponse], error) {
	token, session, err := s.reviewDraftCaller(ctx, req.Header())
	if err != nil {
		return nil, err
	}
	m := req.Msg
	scope, err := reviewDraftTarget(m.Target)
	if err != nil {
		return nil, rpcError(err)
	}
	expected, err := reviewDraftCounter(m.ExpectedVersion, true)
	if err != nil {
		return nil, rpcError(err)
	}
	generation, err := reviewDraftCounter(m.ExpectedTargetGeneration, true)
	if err != nil {
		return nil, rpcError(err)
	}
	if expected == math.MaxInt64 || generation == math.MaxInt64 {
		return nil, rpcError(errReviewDraftConflict)
	}
	if reviewDraftUUID(m.DraftId) != nil || reviewDraftUUID(m.OperationId) != nil {
		return nil, rpcError(invalid("Select canonical draft and operation UUIDs."))
	}
	if expected == 0 {
		if m.GetCapture() == nil || validateReviewDraftCapture(m.Target, m.GetCapture()) != nil {
			return nil, rpcError(invalid("Creation requires the exact first capture and expected version 0."))
		}
	} else if m.GetComparisonId() == "" || reviewDraftUUID(m.GetComparisonId()) != nil {
		return nil, rpcError(invalid("Editing requires the immutable comparison ID and positive expected version."))
	}
	if err = validateReviewDraftContents(m.Summary, m.Entries, nil); err != nil {
		return nil, rpcError(err)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var result *golfv1.GetPullRequestReviewDraftResponse
	var comparison *golfv1.PullReviewDraftComparison
	committed := false
	err = s.withReviewDraftAuthority(ctx, session, token, m.Target, scope, func(_ string, _ Repository, _ forgePull) error {
		// Receipt lookup precedes today's capture: exact accepted intent can be
		// inspected after head movement without fetching/rebinding old source.
		err := s.withManagedSession(ctx, session, token, func(q *database.Queries, caller database.LockManagedSessionRow, _ []byte) error {
			var err error
			result, err = s.reviewDraftReplay(ctx, q, caller.UserID, m.Target, scope, m.DraftId, m.OperationId, m)
			if err != nil || result != nil {
				return err
			}
			if expected > 0 {
				d, err := q.GetReviewDraft(ctx, database.GetReviewDraftParams{ID: uuid.MustParse(m.DraftId), UserID: caller.UserID, ForgeURL: s.config.ForgeURL, RepositoryID: scope.repositoryID, PullRequestID: scope.pullID})
				if errors.Is(err, sql.ErrNoRows) {
					return errResourceNotFound
				}
				if err != nil {
					return errStorageUnavailable
				}
				if d.Deleted || d.CurrentVersion != expected || d.ComparisonID.String() != m.GetComparisonId() {
					return errReviewDraftConflict
				}
				comparison, err = s.loadReviewComparison(ctx, q, d)
				return err
			}
			return nil
		})
		if result != nil {
			committed = true
		}
		if err != nil || result != nil {
			return err
		}
		if expected == 0 {
			comparison, err = s.captureReviewDraft(ctx, session, token, m.GetCapture())
			if err != nil {
				return err
			}
		}
		if err = validateReviewDraftContents(m.Summary, m.Entries, comparison); err != nil {
			return err
		}
		txErr := s.withManagedSession(ctx, session, token, func(q *database.Queries, caller database.LockManagedSessionRow, _ []byte) error {
			var err error
			result, err = s.reviewDraftReplay(ctx, q, caller.UserID, m.Target, scope, m.DraftId, m.OperationId, m)
			if err != nil || result != nil {
				return err
			}
			if err = q.EnsureReviewDraftTarget(ctx, database.EnsureReviewDraftTargetParams{UserID: caller.UserID, ForgeURL: s.config.ForgeURL, RepositoryID: scope.repositoryID, PullRequestID: scope.pullID, PullNumber: scope.number}); err != nil {
				return errStorageUnavailable
			}
			slot, err := q.GetReviewDraftTarget(ctx, database.GetReviewDraftTargetParams{UserID: caller.UserID, ForgeURL: s.config.ForgeURL, RepositoryID: scope.repositoryID, PullRequestID: scope.pullID})
			if err != nil {
				return errStorageUnavailable
			}
			if slot.Generation != generation || slot.PullNumber != scope.number {
				return errReviewDraftConflict
			}
			d := database.GolfReviewDraft{ID: uuid.MustParse(m.DraftId), UserID: caller.UserID, ForgeURL: s.config.ForgeURL, RepositoryID: scope.repositoryID, PullRequestID: scope.pullID, PullNumber: scope.number, ComparisonID: uuid.MustParse(comparison.Id)}
			if expected == 0 {
				_, err = q.GetActiveReviewDraft(ctx, database.GetActiveReviewDraftParams{UserID: caller.UserID, ForgeURL: s.config.ForgeURL, RepositoryID: scope.repositoryID, PullRequestID: scope.pullID})
				if err == nil {
					return errReviewDraftConflict
				}
				if !errors.Is(err, sql.ErrNoRows) {
					return errStorageUnavailable
				}
			} else {
				d, err = q.GetReviewDraft(ctx, database.GetReviewDraftParams{ID: d.ID, UserID: caller.UserID, ForgeURL: d.ForgeURL, RepositoryID: d.RepositoryID, PullRequestID: d.PullRequestID})
				if errors.Is(err, sql.ErrNoRows) {
					return errResourceNotFound
				}
				if err != nil {
					return errStorageUnavailable
				}
				if d.Deleted || d.CurrentVersion != expected || d.ComparisonID.String() != comparison.Id {
					return errReviewDraftConflict
				}
			}
			if expected >= maxReviewDraftVersions {
				return errReviewDraftQuota
			}
			// Binary protobuf plus base64 avoids JSON escape growth inside the
			// ciphertext. This conservative quota estimate includes both records.
			additional := int64(base64.StdEncoding.EncodedLen(proto.Size(m)) + 28)
			additionalRecords := int64(1)
			if expected == 0 {
				additional += int64(base64.StdEncoding.EncodedLen(proto.Size(comparison)) + 28)
				additionalRecords++
			}
			if err = s.checkReviewDraftQuota(ctx, q, caller.UserID, additional, additionalRecords, false); err != nil {
				return err
			}
			if expected == 0 {
				if err = s.storeReviewContent(ctx, q, d, 0, "comparison", d.ComparisonID, comparison); err != nil {
					return err
				}
				if err = q.InsertReviewDraft(ctx, database.InsertReviewDraftParams{ID: d.ID, UserID: d.UserID, ForgeURL: d.ForgeURL, RepositoryID: d.RepositoryID, PullRequestID: d.PullRequestID, PullNumber: d.PullNumber, ComparisonID: d.ComparisonID}); err != nil {
					return errReviewDraftConflict
				}
			}
			return s.acceptReviewDraftOperation(ctx, q, d, m.Target, scope, m.OperationId, expected, generation, "SAVE", m, &result)
		})
		if txErr == nil {
			committed = true
		}
		return txErr
	})
	if err != nil {
		return nil, reviewDraftMutationError(err, committed)
	}
	return connect.NewResponse(&golfv1.SavePullRequestReviewDraftResponse{Receipt: result.Receipt, Draft: result.Draft, CurrentVersion: result.CurrentVersion, TargetGeneration: result.TargetGeneration}), nil
}
func (s *Server) acceptReviewDraftOperation(ctx context.Context, q *database.Queries, d database.GolfReviewDraft, target *golfv1.PullReviewDraftTarget, scope reviewDraftScope, operation string, expected, generation int64, kind string, input proto.Message, result **golfv1.GetPullRequestReviewDraftResponse) error {
	contentID := uuid.New()
	if err := s.storeReviewContent(ctx, q, d, expected+1, "operation", contentID, input); err != nil {
		return err
	}
	if err := q.InsertReviewDraftVersion(ctx, database.InsertReviewDraftVersionParams{DraftID: d.ID, UserID: d.UserID, ForgeURL: d.ForgeURL, RepositoryID: d.RepositoryID, PullRequestID: d.PullRequestID, Version: expected + 1, OperationID: uuid.MustParse(operation), Kind: kind, ExpectedVersion: expected, ExpectedGeneration: generation, AcceptedGeneration: generation + 1, ContentID: contentID}); err != nil {
		return errStorageUnavailable
	}
	if err := q.AdvanceReviewDraft(ctx, database.AdvanceReviewDraftParams{ID: d.ID, Deleted: kind == "DELETE"}); err != nil {
		return errStorageUnavailable
	}
	if err := q.AdvanceReviewDraftTarget(ctx, database.AdvanceReviewDraftTargetParams{UserID: d.UserID, ForgeURL: d.ForgeURL, RepositoryID: d.RepositoryID, PullRequestID: d.PullRequestID}); err != nil {
		return errStorageUnavailable
	}
	state, err := s.getReviewDraftState(ctx, q, d.UserID, target, scope, d.ID.String(), operation)
	if err != nil {
		return err
	}
	*result = state
	return nil
}
func (s *Server) DeletePullRequestReviewDraft(ctx context.Context, req *connect.Request[golfv1.DeletePullRequestReviewDraftRequest]) (*connect.Response[golfv1.DeletePullRequestReviewDraftResponse], error) {
	token, session, err := s.reviewDraftCaller(ctx, req.Header())
	if err != nil {
		return nil, err
	}
	m := req.Msg
	scope, err := reviewDraftTarget(m.Target)
	if err != nil {
		return nil, rpcError(err)
	}
	expected, err := reviewDraftCounter(m.ExpectedVersion, false)
	if err != nil {
		return nil, rpcError(err)
	}
	generation, err := reviewDraftCounter(m.ExpectedTargetGeneration, true)
	if err != nil {
		return nil, rpcError(err)
	}
	if expected == math.MaxInt64 || generation == math.MaxInt64 {
		return nil, rpcError(errReviewDraftConflict)
	}
	if reviewDraftUUID(m.DraftId) != nil || reviewDraftUUID(m.OperationId) != nil {
		return nil, rpcError(invalid("Select canonical draft and operation UUIDs."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var result *golfv1.GetPullRequestReviewDraftResponse
	committed := false
	err = s.withReviewDraftAuthority(ctx, session, token, m.Target, scope, func(_ string, _ Repository, _ forgePull) error {
		txErr := s.withManagedSession(ctx, session, token, func(q *database.Queries, caller database.LockManagedSessionRow, _ []byte) error {
			var err error
			result, err = s.reviewDraftReplay(ctx, q, caller.UserID, m.Target, scope, m.DraftId, m.OperationId, m)
			if err != nil || result != nil {
				return err
			}
			slot, err := q.GetReviewDraftTarget(ctx, database.GetReviewDraftTargetParams{UserID: caller.UserID, ForgeURL: s.config.ForgeURL, RepositoryID: scope.repositoryID, PullRequestID: scope.pullID})
			if errors.Is(err, sql.ErrNoRows) {
				return errResourceNotFound
			}
			if err != nil {
				return errStorageUnavailable
			}
			d, err := q.GetReviewDraft(ctx, database.GetReviewDraftParams{ID: uuid.MustParse(m.DraftId), UserID: caller.UserID, ForgeURL: s.config.ForgeURL, RepositoryID: scope.repositoryID, PullRequestID: scope.pullID})
			if errors.Is(err, sql.ErrNoRows) {
				return errResourceNotFound
			}
			if err != nil {
				return errStorageUnavailable
			}
			if slot.Generation != generation || slot.PullNumber != scope.number || d.CurrentVersion != expected || d.Deleted {
				return errReviewDraftConflict
			}
			if err = s.checkReviewDraftQuota(ctx, q, caller.UserID, int64(base64.StdEncoding.EncodedLen(proto.Size(m))+28), 1, true); err != nil {
				return err
			}
			return s.acceptReviewDraftOperation(ctx, q, d, m.Target, scope, m.OperationId, expected, generation, "DELETE", m, &result)
		})
		if txErr == nil {
			committed = true
		}
		return txErr
	})
	if err != nil {
		return nil, reviewDraftMutationError(err, committed)
	}
	return connect.NewResponse(&golfv1.DeletePullRequestReviewDraftResponse{Receipt: result.Receipt, CurrentVersion: result.CurrentVersion, TargetGeneration: result.TargetGeneration, Deleted: result.Deleted}), nil
}
