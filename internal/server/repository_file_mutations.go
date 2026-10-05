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
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"google.golang.org/protobuf/proto"
)

const fileMutationContract = "golf.repository.file-mutation.v1"

func fileMutationKind(k golfv1.RepositoryFileMutationKind) string {
	return strings.TrimPrefix(k.String(), "REPOSITORY_FILE_MUTATION_KIND_")
}
func fileMutationHash(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func validateFileMutation(m *golfv1.SubmitRepositoryFileMutationRequest) error {
	if e := validateRepositoryAccess(keyFrom(m.Repository), m.RepositoryId, m.OwnerId, m.AccessRevision, ""); e != nil {
		return e
	}
	k := fileMutationKind(m.Kind)
	if !creationKey.MatchString(m.OperationId) || !(k == "CREATE" || k == "UPDATE" || k == "DELETE") || m.Branch == "" || !validRef(m.Branch) || len(m.Branch) > 100 || strings.HasPrefix(m.Branch, "refs/") || !objectID.MatchString(m.ExpectedCommitId) || m.Path == "" || !validSourcePath(m.Path) || len(m.Path) > 500 {
		return invalid("Select an original operation, exact branch, commit and literal file path.")
	}
	for _, p := range strings.Split(m.Path, "/") {
		if strings.EqualFold(p, ".git") {
			return invalid("The Git metadata path cannot be edited.")
		}
	}
	if k == "CREATE" && m.ExpectedBlobId != "" || k != "CREATE" && (!objectID.MatchString(m.ExpectedBlobId) || len(m.ExpectedBlobId) != len(m.ExpectedCommitId)) {
		return invalid("Bind the original file object, or an absent new path.")
	}
	if len(m.Content) > maxPreviewBytes || k == "DELETE" && len(m.Content) > 0 {
		return invalid("File changes support at most 256 KiB; deletion accepts no content.")
	}
	if len(m.CommitMessage) == 0 || len(m.CommitMessage) > 4096 || !utf8.ValidString(m.CommitMessage) || strings.ContainsAny(m.CommitMessage, "\x00\r") || strings.TrimSpace(m.CommitMessage) == "" {
		return invalid("Supply a UTF-8 commit message of at most 4096 bytes.")
	}
	return nil
}
func fileMutationFingerprint(m *golfv1.SubmitRepositoryFileMutationRequest) []byte {
	c := proto.Clone(m).(*golfv1.SubmitRepositoryFileMutationRequest)
	c.OperationId = ""
	b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(c)
	h := sha256.Sum256(b)
	return h[:]
}

type fileMutationRecord struct {
	ID, UserID, ActorID, RepositoryID, OwnerID, Size                                                                                                             int64
	ForgeURL, OperationID, Owner, Name, AccessRevision, Kind, Branch, ExpectedCommit, Path, ExpectedBlob, ContentHash, MessageHash, Commit, Blob, Phase, Failure string
	Fingerprint                                                                                                                                                  []byte
	Created, Updated                                                                                                                                             time.Time
}

const fileMutationColumns = `id,user_id,forge_url,actor_id,operation_id,repository_id,owner_id,repository_owner,repository_name,access_revision,kind,branch_name,expected_commit_id,file_path,expected_blob_id,content_sha256,content_size_bytes,message_sha256,result_commit_id,result_blob_id,input_fingerprint,phase,failure_code,created_at,updated_at`

func scanFileMutation(row interface{ Scan(...any) error }) (r fileMutationRecord, e error) {
	e = row.Scan(&r.ID, &r.UserID, &r.ForgeURL, &r.ActorID, &r.OperationID, &r.RepositoryID, &r.OwnerID, &r.Owner, &r.Name, &r.AccessRevision, &r.Kind, &r.Branch, &r.ExpectedCommit, &r.Path, &r.ExpectedBlob, &r.ContentHash, &r.Size, &r.MessageHash, &r.Commit, &r.Blob, &r.Fingerprint, &r.Phase, &r.Failure, &r.Created, &r.Updated)
	return
}
func fileMutationWire(r fileMutationRecord) *golfv1.RepositoryFileMutationOperation {
	return &golfv1.RepositoryFileMutationOperation{Contract: fileMutationContract, OperationId: r.OperationID, ActorId: strconv.FormatInt(r.ActorID, 10), Repository: &golfv1.RepositoryKey{Owner: r.Owner, Name: r.Name}, RepositoryId: strconv.FormatInt(r.RepositoryID, 10), OwnerId: strconv.FormatInt(r.OwnerID, 10), AccessRevision: r.AccessRevision, Kind: golfv1.RepositoryFileMutationKind(golfv1.RepositoryFileMutationKind_value["REPOSITORY_FILE_MUTATION_KIND_"+r.Kind]), Branch: r.Branch, ExpectedCommitId: r.ExpectedCommit, Path: r.Path, ExpectedBlobId: r.ExpectedBlob, ContentSha256: r.ContentHash, ContentSizeBytes: uint64(r.Size), CommitMessageSha256: r.MessageHash, Phase: golfv1.RepositoryFileMutationPhase(golfv1.RepositoryFileMutationPhase_value["REPOSITORY_FILE_MUTATION_PHASE_"+r.Phase]), CommitId: r.Commit, BlobId: r.Blob, FailureCode: r.Failure, CreatedAt: r.Created.UTC().Format(time.RFC3339Nano), UpdatedAt: r.Updated.UTC().Format(time.RFC3339Nano)}
}
func (s *Server) lockFileMutation(ctx context.Context, tx *sql.Tx, id int64) (context.Context, error) {
	if _, e := tx.ExecContext(ctx, `SELECT golf_file_mutation_lock($1,$2)`, s.config.GiteaURL, id); e != nil {
		return nil, errStorageUnavailable
	}
	return context.WithValue(ctx, repositoryLifecycleTransactionKey{}, repositoryLifecycleTransaction{s.config.GiteaURL, id, tx}), nil
}

// The native API supports expected blob SHA, not last_commit_id or atomic branch
// HEAD compare-and-swap. HEAD/parent checks are observations; uncertain effects
// retain DISPATCH_UNKNOWN and are never replayed. The native branch-specific
// effective protection projection is required; protected/unknown branches refuse.
func (s *Server) fileMutationPreflight(ctx context.Context, session string, token forgeCredential, m *golfv1.SubmitRepositoryFileMutationRequest) error {
	actor, e := s.standardMergeAuthority(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId)
	if e != nil {
		return e
	}
	e = s.withRepositoryRead(ctx, session, token, keyFrom(m.Repository), func(base string, repo Repository) error {
		access, e := s.readRepositoryAccess(ctx, token, keyFrom(m.Repository), actor)
		if e != nil {
			return e
		}
		if e = fileAccessMatches(access, m.RepositoryId, m.OwnerId, m.AccessRevision); e != nil {
			return e
		}
		if repo.Empty {
			return errRefMutationUnavailable
		}
		branch, e := s.readMergeBranch(ctx, token, base, m.Branch)
		if e != nil {
			return e
		}
		if *branch.Protected {
			return errRefMutationUnavailable
		}
		head := branch.Commit.ID
		if head != m.ExpectedCommitId {
			return errRepositoryAccessConflict
		}
		// An absent leaf must not hide a symlink/submodule/file ancestor.
		parts := strings.Split(m.Path, "/")
		for i := 1; i < len(parts); i++ {
			parent, _, pe := s.sourceObjectAtPath(ctx, base, token, head, strings.Join(parts[:i], "/"))
			if sourceNotFound(pe) {
				break
			}
			if pe != nil {
				return pe
			}
			if parent.Type != "" && parent.Type != "dir" {
				return errRefMutationUnavailable
			}
		}
		entry, _, e := s.sourceObjectAtPath(ctx, base, token, head, m.Path)
		if fileMutationKind(m.Kind) == "CREATE" {
			if e == nil {
				return errRepositoryAccessConflict
			}
			if !sourceNotFound(e) {
				return e
			}
			return nil
		}
		if e != nil {
			return e
		}
		if entry.Type != "file" || entry.SHA != m.ExpectedBlobId || entry.Size > maxPreviewBytes {
			return errRepositoryAccessConflict
		}
		data, e := s.sourceBlob(ctx, base, token, entry)
		if e != nil {
			return e
		}
		if fileMutationLFS(data) {
			return errRefMutationUnavailable
		}
		return nil
	})
	if e != nil {
		return e
	}
	_, e = s.standardMergeAuthority(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId)
	return e
}
func fileMutationLFS(data []byte) bool {
	return bytes.HasPrefix(data, []byte("version https://git-lfs.github.com/spec/v1\n")) || bytes.HasPrefix(data, []byte("version https://git-lfs.github.com/spec/v1\r\n"))
}
func fileMutationNative(r fileMutationRecord, content []byte, message string) (string, string, any) {
	method := http.MethodPost
	payload := map[string]string{"branch": r.Branch, "message": message}
	if r.Kind != "DELETE" {
		payload["content"] = base64.StdEncoding.EncodeToString(content)
	}
	if r.Kind != "CREATE" {
		payload["sha"] = r.ExpectedBlob
	}
	if r.Kind == "UPDATE" {
		method = http.MethodPut
	}
	if r.Kind == "DELETE" {
		method = http.MethodDelete
	}
	return method, "/contents/" + escapedSourcePath(r.Path), payload
}

type fileMutationReceipt struct {
	Content *struct {
		Path string `json:"path"`
		SHA  string `json:"sha"`
		Type string `json:"type"`
		Size int64  `json:"size"`
	} `json:"content"`
	Commit *struct {
		SHA     string `json:"sha"`
		Parents []struct {
			SHA string `json:"sha"`
		} `json:"parents"`
		Message string `json:"message"`
	} `json:"commit"`
}

func fileMutationNativeReceipt(row fileMutationReceipt, r fileMutationRecord, content []byte, message string) (fileMutationRecord, error) {
	if row.Commit == nil || !objectID.MatchString(row.Commit.SHA) || len(row.Commit.SHA) != len(r.ExpectedCommit) || row.Commit.SHA == r.ExpectedCommit || len(row.Commit.Parents) != 1 || row.Commit.Parents[0].SHA != r.ExpectedCommit || row.Commit.Message != strings.TrimSpace(message)+"\n" {
		return r, errInvalidForgeResponse
	}
	r.Commit = row.Commit.SHA
	if r.Kind == "DELETE" {
		if row.Content != nil {
			return r, errInvalidForgeResponse
		}
		return r, nil
	}
	if row.Content == nil || row.Content.Path != r.Path || row.Content.Type != "file" || row.Content.Size != r.Size || row.Content.SHA != sourceBlobHash(content, len(r.ExpectedCommit)) {
		return r, errInvalidForgeResponse
	}
	r.Blob = row.Content.SHA
	return r, nil
}
func (s *Server) fileMutationAuthority(ctx context.Context, session string, token forgeCredential, r fileMutationRecord) (repositoryKey, error) {
	selected, e := s.executionSelectedRepository(ctx, token, r.RepositoryID)
	if e != nil {
		return repositoryKey{}, errResourceNotFound
	}
	if selected.Owner.ID != r.OwnerID {
		return repositoryKey{}, errResourceNotFound
	}
	key := repositoryKey{selected.Owner.Login, selected.Name}
	if _, e = s.standardMergeAuthority(ctx, session, token, key, strconv.FormatInt(r.RepositoryID, 10), strconv.FormatInt(r.OwnerID, 10)); e != nil {
		return repositoryKey{}, errResourceNotFound
	}
	return key, nil
}
func (s *Server) fileMutationReadback(ctx context.Context, session string, token forgeCredential, r fileMutationRecord) error {
	key, e := s.fileMutationAuthority(ctx, session, token, r)
	if e != nil {
		return e
	}
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return e
	}
	return s.withRepositoryRead(ctx, session, token, key, func(base string, repo Repository) error {
		access, e := s.readRepositoryAccess(ctx, token, key, actor)
		if e != nil {
			return e
		}
		if e = fileAccessMatches(access, strconv.FormatInt(r.RepositoryID, 10), strconv.FormatInt(r.OwnerID, 10), r.AccessRevision); e != nil {
			return e
		}
		head, e := s.exactSourceBranch(ctx, base, token, r.Branch)
		if e != nil {
			return e
		}
		if head != r.Commit {
			return errRepositoryAccessConflict
		}
		entry, _, e := s.sourceObjectAtPath(ctx, base, token, r.Commit, r.Path)
		if r.Kind == "DELETE" {
			if sourceNotFound(e) {
				return nil
			}
			if e != nil {
				return e
			}
			return errRepositoryAccessConflict
		}
		if e != nil {
			return e
		}
		if entry.Type != "file" || entry.SHA != r.Blob || entry.Size != r.Size {
			return errInvalidForgeResponse
		}
		data, e := s.sourceBlob(ctx, base, token, entry)
		if e != nil {
			return e
		}
		if fileMutationHash(data) != r.ContentHash {
			return errInvalidForgeResponse
		}
		return nil
	})
}

type fileMutationPermitKey struct{}
type fileMutationPermit struct {
	record  fileMutationRecord
	content []byte
	message string
}

func (s *Server) validateFileMutationPermit(ctx context.Context, tx *sql.Tx, p fileMutationPermit, repo lifecycleNativeRepository, key repositoryKey, method, path string, input any) error {
	r := p.record
	base, _ := repositoryPath(key)
	want, suffix, payload := fileMutationNative(r, p.content, p.message)
	if tx == nil || repo.ID != r.RepositoryID || key.Owner != r.Owner || key.Name != r.Name || method != want || path != base+suffix || fileMutationHash(p.content) != r.ContentHash || int64(len(p.content)) != r.Size || fileMutationHash([]byte(p.message)) != r.MessageHash {
		return errLifecycleBlocked
	}
	row, e := scanFileMutation(tx.QueryRowContext(ctx, `SELECT `+fileMutationColumns+` FROM golf_repository_file_mutations WHERE id=$1 AND user_id=$2 AND forge_url=$3 AND phase='DISPATCH_UNKNOWN'`, r.ID, r.UserID, s.config.GiteaURL))
	if e != nil || row.ActorID != r.ActorID || !bytes.Equal(row.Fingerprint, r.Fingerprint) {
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
	var blocked bool
	if e = tx.QueryRowContext(ctx, `SELECT golf_repository_lifecycle_blocked_before_file_mutation($1,$2) OR EXISTS(SELECT 1 FROM golf_standard_pull_merges WHERE forge_url=$1 AND (repository_id=$2 OR source_repository_id=$2) AND phase IN ('RESERVED','DISPATCH_UNKNOWN'))`, r.ForgeURL, r.RepositoryID).Scan(&blocked); e != nil {
		return errStorageUnavailable
	}
	if blocked {
		return errLifecycleBlocked
	}
	return nil
}
func (s *Server) advanceFileMutation(ctx context.Context, session string, token forgeCredential, r fileMutationRecord, phase string) (updated fileMutationRecord, e error) {
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return r, e
	}
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		if c.UserID != r.UserID || actor.ID != r.ActorID {
			return errUnauthenticated
		}
		held, e := s.lockFileMutation(ctx, tx, r.RepositoryID)
		if e != nil {
			return e
		}
		if phase == "SUCCEEDED" {
			if e = s.fileMutationReadback(held, session, token, r); e != nil {
				return e
			}
		}
		failure := ""
		if phase == "REJECTED" {
			failure = "preflight_refused"
		}
		updated, e = scanFileMutation(tx.QueryRowContext(held, `UPDATE golf_repository_file_mutations SET phase=$1,failure_code=$2,result_commit_id=$3,result_blob_id=$4 WHERE id=$5 AND user_id=$6 AND forge_url=$7 AND phase=$8 RETURNING `+fileMutationColumns, phase, failure, r.Commit, r.Blob, r.ID, r.UserID, r.ForgeURL, r.Phase))
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	return
}
func (s *Server) GetRepositoryFileMutationOperation(ctx context.Context, req *connect.Request[golfv1.GetRepositoryFileMutationOperationRequest]) (*connect.Response[golfv1.GetRepositoryFileMutationOperationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if _, e = repositoryPath(keyFrom(m.Repository)); e != nil {
		return nil, lifecycleRPCError(e)
	}
	for _, id := range []string{m.RepositoryId, m.OwnerId} {
		if _, e = discussionID(id); e != nil {
			return nil, lifecycleRPCError(e)
		}
	}
	if !creationKey.MatchString(m.OperationId) {
		return nil, rpcError(invalid("Inspect the original file operation."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var r fileMutationRecord
	e = s.withManagedSession(ctx, session, token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		r, e = scanFileMutation(s.db.QueryRowContext(ctx, `SELECT `+fileMutationColumns+` FROM golf_repository_file_mutations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, m.OperationId))
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if r.Owner != m.Repository.Owner || r.Name != m.Repository.Name || strconv.FormatInt(r.RepositoryID, 10) != m.RepositoryId || strconv.FormatInt(r.OwnerID, 10) != m.OwnerId {
		return nil, lifecycleRPCError(errRepositoryAccessConflict)
	}
	if _, e = s.fileMutationAuthority(ctx, session, token, r); e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(&golfv1.GetRepositoryFileMutationOperationResponse{Operation: fileMutationWire(r)}), nil
}
func (s *Server) SubmitRepositoryFileMutation(ctx context.Context, req *connect.Request[golfv1.SubmitRepositoryFileMutationRequest]) (*connect.Response[golfv1.SubmitRepositoryFileMutationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = validateFileMutation(m); e != nil {
		return nil, lifecycleRPCError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	key := keyFrom(m.Repository)
	actor, e := s.standardMergeAuthority(ctx, session, token, key, m.RepositoryId, m.OwnerId)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	repoID, _ := discussionID(m.RepositoryId)
	ownerID, _ := discussionID(m.OwnerId)
	fingerprint := fileMutationFingerprint(m)
	var r fileMutationRecord
	fresh := false
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		held, e := s.lockFileMutation(ctx, tx, repoID)
		if e != nil {
			return e
		}
		r, e = scanFileMutation(tx.QueryRowContext(held, `SELECT `+fileMutationColumns+` FROM golf_repository_file_mutations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.GiteaURL, m.OperationId))
		if e == nil {
			if !bytes.Equal(r.Fingerprint, fingerprint) {
				return errRepositoryAccessConflict
			}
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		r, e = scanFileMutation(tx.QueryRowContext(held, `INSERT INTO golf_repository_file_mutations(user_id,forge_url,actor_id,operation_id,repository_id,owner_id,repository_owner,repository_name,access_revision,kind,branch_name,expected_commit_id,file_path,expected_blob_id,content_sha256,content_size_bytes,message_sha256,input_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING `+fileMutationColumns, c.UserID, s.config.GiteaURL, actor.ID, m.OperationId, repoID, ownerID, key.Owner, key.Name, m.AccessRevision, fileMutationKind(m.Kind), m.Branch, m.ExpectedCommitId, m.Path, m.ExpectedBlobId, fileMutationHash(m.Content), len(m.Content), fileMutationHash([]byte(m.CommitMessage)), fingerprint))
		if e != nil {
			return errStorageUnavailable
		}
		fresh = true
		return nil
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if fresh {
		if e = s.fileMutationPreflight(ctx, session, token, m); e != nil {
			if _, e = s.advanceFileMutation(ctx, session, token, r, "REJECTED"); e != nil {
				return nil, lifecycleRPCError(e)
			}
		} else {
			r, e = s.advanceFileMutation(ctx, session, token, r, "DISPATCH_UNKNOWN")
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
			var nativeErr error
			e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
				if c.UserID != r.UserID {
					return errUnauthenticated
				}
				held, e := s.lockFileMutation(ctx, tx, repoID)
				if e != nil {
					return e
				}
				if e = s.fileMutationPreflight(held, session, token, m); e != nil {
					return e
				}
				held = context.WithValue(held, fileMutationPermitKey{}, fileMutationPermit{r, m.Content, m.CommitMessage})
				base, _ := repositoryPath(key)
				method, suffix, payload := fileMutationNative(r, m.Content, m.CommitMessage)
				var row fileMutationReceipt
				status := http.StatusOK
				if r.Kind == "CREATE" {
					status = http.StatusCreated
				}
				_, nativeErr = s.forgeJSON(held, method, base+suffix, token, payload, &row, status)
				if nativeErr == nil {
					r, nativeErr = fileMutationNativeReceipt(row, r, m.Content, m.CommitMessage)
				}
				if nativeErr == nil {
					nativeErr = s.fileMutationReadback(held, session, token, r)
				}
				return nil
			})
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
			if nativeErr == nil {
				if _, e = s.advanceFileMutation(ctx, session, token, r, "SUCCEEDED"); e != nil {
					return nil, lifecycleRPCError(e)
				}
			}
		}
	}
	status := connect.NewRequest(&golfv1.GetRepositoryFileMutationOperationRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, OperationId: m.OperationId})
	status.Header().Set("Cookie", req.Header().Get("Cookie"))
	status.Header().Set("Origin", req.Header().Get("Origin"))
	result, e := s.GetRepositoryFileMutationOperation(ctx, status)
	if e != nil {
		return nil, e
	}
	return connect.NewResponse(&golfv1.SubmitRepositoryFileMutationResponse{Operation: result.Msg.Operation}), nil
}

// Ordinary code writers need not enumerate administration-only protection rules.
// Resolve the effective native branch projection and exact ref namespace instead.
func (s *Server) GetRepositoryFileMutationAccess(ctx context.Context, req *connect.Request[golfv1.GetRepositoryFileMutationAccessRequest]) (*connect.Response[golfv1.GetRepositoryFileMutationAccessResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = validateRepositoryAccess(keyFrom(m.Repository), m.RepositoryId, m.OwnerId, m.AccessRevision, ""); e != nil {
		return nil, lifecycleRPCError(e)
	}
	if m.Branch == "" || !validRef(m.Branch) || strings.HasPrefix(m.Branch, "refs/") || len(m.Branch) > 100 {
		return nil, rpcError(invalid("Select an exact branch."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var result *golfv1.GetRepositoryFileMutationAccessResponse
	e = s.withRepositoryRead(ctx, session, token, keyFrom(m.Repository), func(base string, repo Repository) error {
		native, actor, e := s.gitCurrentTarget(ctx, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId, false)
		if e != nil {
			return e
		}
		access, e := s.readRepositoryAccess(ctx, token, keyFrom(m.Repository), actor)
		if e != nil {
			return e
		}
		if e = fileAccessMatches(access, m.RepositoryId, m.OwnerId, m.AccessRevision); e != nil {
			return e
		}
		branch, e := s.readMergeBranch(ctx, token, base, m.Branch)
		if e != nil {
			return e
		}
		result = &golfv1.GetRepositoryFileMutationAccessResponse{RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, AccessRevision: access.Revision, Branch: branch.Name, CommitId: branch.Commit.ID, Protected: *branch.Protected, CanWrite: native.Permissions.Push != nil && *native.Permissions.Push && !*native.Archived && !*native.Mirror}
		return nil
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(result), nil
}

// Identity/revision fence only; standardMergeAuthority independently proves
// current ordinary code-write permission. Administrative delegation is separate.
func fileAccessMatches(access *golfv1.RepositoryAccess, repoID, ownerID, revision string) error {
	if access.RepositoryId != repoID || access.OwnerId != ownerID || access.Revision != revision {
		return errRepositoryAccessConflict
	}
	return nil
}
