package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
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

const fileBatchContract = "golf.repository.file-batch.v1"

func fileBatchSingle(m *golfv1.SubmitRepositoryFileBatchRequest, c *golfv1.RepositoryFileBatchChange) *golfv1.SubmitRepositoryFileMutationRequest {
	path := c.Path
	if c.FromPath != "" {
		path = c.FromPath
	}
	return &golfv1.SubmitRepositoryFileMutationRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, AccessRevision: m.AccessRevision, OperationId: m.OperationId, Kind: c.Kind, Branch: m.Branch, ExpectedCommitId: m.ExpectedCommitId, Path: path, ExpectedBlobId: c.ExpectedBlobId, Content: c.Content, CommitMessage: m.CommitMessage}
}
func validateFileBatch(m *golfv1.SubmitRepositoryFileBatchRequest, retained bool) error {
	if len(m.Changes) < 1 || len(m.Changes) > 20 || !issueRevisionPattern.MatchString(m.CommitMessageSha256) || !retained && fileMutationHash([]byte(m.CommitMessage)) != m.CommitMessageSha256 || retained && m.CommitMessage != "" {
		return invalid("Bind 1–20 file changes and the exact commit message.")
	}
	paths := map[string]bool{}
	size := 0
	for _, c := range m.Changes {
		if c == nil || !issueRevisionPattern.MatchString(c.ContentSha256) || !retained && fileMutationHash(c.Content) != c.ContentSha256 || retained && len(c.Content) > 0 {
			return invalid("Bind exact file bytes.")
		}
		single := fileBatchSingle(m, c)
		if retained {
			single.CommitMessage = "Retained original"
		}
		if e := validateFileMutation(single); e != nil {
			return e
		}
		if c.FromPath != "" {
			destination := proto.Clone(single).(*golfv1.SubmitRepositoryFileMutationRequest)
			destination.Path = c.Path
			destination.Kind = golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_CREATE
			destination.ExpectedBlobId = ""
			if c.Kind != golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_UPDATE || c.FromPath == c.Path || validateFileMutation(destination) != nil {
				return invalid("Rename selects an original file and a different absent destination.")
			}
		}
		for _, path := range []string{c.Path, c.FromPath} {
			if path == "" {
				continue
			}
			if paths[path] {
				return invalid("A batch cannot touch a path twice.")
			}
			paths[path] = true
		}
		size += len(c.Content)
	}
	if size > maxPreviewBytes {
		return invalid("A batch supports at most 256 KiB total.")
	}
	for path := range paths {
		for parent := range paths {
			if strings.HasPrefix(path, parent+"/") {
				return invalid("A batch cannot replace an ancestor of another change.")
			}
		}
	}
	return nil
}
func fileBatchOriginal(m *golfv1.SubmitRepositoryFileBatchRequest) []byte {
	c := proto.Clone(m).(*golfv1.SubmitRepositoryFileBatchRequest)
	c.CommitMessage = ""
	for _, f := range c.Changes {
		f.Content = nil
	}
	b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(c)
	return b
}
func fileBatchFingerprint(m *golfv1.SubmitRepositoryFileBatchRequest) []byte {
	c := proto.Clone(m).(*golfv1.SubmitRepositoryFileBatchRequest)
	c.OperationId = ""
	h := sha256.Sum256(fileBatchOriginal(c))
	return h[:]
}
func decodeFileBatch(r fileMutationRecord) (*golfv1.SubmitRepositoryFileBatchRequest, error) {
	m := new(golfv1.SubmitRepositoryFileBatchRequest)
	if r.Kind != "BATCH" || proto.Unmarshal(r.BatchOriginal, m) != nil || validateFileBatch(m, true) != nil || m.OperationId != r.OperationID || m.RepositoryId != strconv.FormatInt(r.RepositoryID, 10) || m.OwnerId != strconv.FormatInt(r.OwnerID, 10) || m.Repository.Owner != r.Owner || m.Repository.Name != r.Name || m.AccessRevision != r.AccessRevision || m.ExpectedCommitId != r.ExpectedCommit || m.Branch != r.Branch || m.CommitMessageSha256 != r.MessageHash {
		return nil, errStorageUnavailable
	}
	h := fileBatchFingerprint(m)
	if !bytes.Equal(h, r.Fingerprint) {
		return nil, errStorageUnavailable
	}
	return m, nil
}
func fileBatchWire(r fileMutationRecord) (*golfv1.RepositoryFileBatchOperation, error) {
	m, e := decodeFileBatch(r)
	if e != nil {
		return nil, e
	}
	return &golfv1.RepositoryFileBatchOperation{Contract: fileBatchContract, Original: m, ActorId: strconv.FormatInt(r.ActorID, 10), Phase: fileMutationWire(r).Phase, CommitId: r.Commit, CreatedAt: r.Created.UTC().Format(time.RFC3339Nano), UpdatedAt: r.Updated.UTC().Format(time.RFC3339Nano), FailureCode: r.Failure}, nil
}
func (s *Server) fileBatchPreflight(ctx context.Context, session string, token forgeCredential, m *golfv1.SubmitRepositoryFileBatchRequest) error {
	for _, c := range m.Changes {
		if e := s.fileMutationPreflight(ctx, session, token, fileBatchSingle(m, c)); e != nil {
			return e
		}
		if c.FromPath != "" {
			n := proto.Clone(c).(*golfv1.RepositoryFileBatchChange)
			n.Kind = golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_CREATE
			n.FromPath = ""
			n.ExpectedBlobId = ""
			if e := s.fileMutationPreflight(ctx, session, token, fileBatchSingle(m, n)); e != nil {
				return e
			}
		}
	}
	return nil
}
func fileBatchNative(m *golfv1.SubmitRepositoryFileBatchRequest) any {
	files := make([]map[string]string, 0, len(m.Changes))
	for _, c := range m.Changes {
		f := map[string]string{"operation": strings.ToLower(fileMutationKind(c.Kind)), "path": c.Path, "content": base64.StdEncoding.EncodeToString(c.Content)}
		if c.ExpectedBlobId != "" {
			f["sha"] = c.ExpectedBlobId
		}
		if c.FromPath != "" {
			f["from_path"] = c.FromPath
		}
		files = append(files, f)
	}
	return map[string]any{"branch": m.Branch, "message": m.CommitMessage, "files": files}
}
func (s *Server) validateFileBatchPermit(ctx context.Context, tx *sql.Tx, p fileMutationPermit, repo lifecycleNativeRepository, key repositoryKey, method, path string, input any) error {
	r := p.record
	base, _ := repositoryPath(key)
	if tx == nil || p.batch == nil || validateFileBatch(p.batch, false) != nil || repo.ID != r.RepositoryID || key.Owner != r.Owner || key.Name != r.Name || method != http.MethodPost || path != base+"/contents" || !bytes.Equal(fileBatchOriginal(p.batch), r.BatchOriginal) {
		return errLifecycleBlocked
	}
	a, e := json.Marshal(input)
	b, _ := json.Marshal(fileBatchNative(p.batch))
	if e != nil || !bytes.Equal(a, b) {
		return errLifecycleBlocked
	}
	row, e := scanFileMutation(tx.QueryRowContext(ctx, `SELECT `+fileMutationColumns+` FROM golf_repository_file_mutations WHERE id=$1 AND user_id=$2 AND forge_url=$3 AND phase='DISPATCH_UNKNOWN'`, r.ID, r.UserID, r.ForgeURL))
	if e != nil || row.ActorID != r.ActorID || !bytes.Equal(row.Fingerprint, r.Fingerprint) || !bytes.Equal(row.BatchOriginal, r.BatchOriginal) {
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
func (s *Server) fileBatchReadback(ctx context.Context, session string, token forgeCredential, r fileMutationRecord) error {
	m, e := decodeFileBatch(r)
	if e != nil {
		return e
	}
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
		if e = fileAccessMatches(access, m.RepositoryId, m.OwnerId, m.AccessRevision); e != nil {
			return e
		}
		head, e := s.exactSourceBranch(ctx, base, token, m.Branch)
		if e != nil {
			return e
		}
		if head != r.Commit {
			return errRepositoryAccessConflict
		}
		for _, c := range m.Changes {
			entry, _, e := s.sourceObjectAtPath(ctx, base, token, r.Commit, c.Path)
			if c.Kind == golfv1.RepositoryFileMutationKind_REPOSITORY_FILE_MUTATION_KIND_DELETE {
				if !sourceNotFound(e) {
					return errInvalidForgeResponse
				}
			} else {
				if e != nil {
					return e
				}
				if entry.Type != "file" {
					return errInvalidForgeResponse
				}
				data, e := s.sourceBlob(ctx, base, token, entry)
				if e != nil {
					return e
				}
				if fileMutationHash(data) != c.ContentSha256 {
					return errInvalidForgeResponse
				}
			}
			if c.FromPath != "" {
				_, _, e = s.sourceObjectAtPath(ctx, base, token, r.Commit, c.FromPath)
				if !sourceNotFound(e) {
					return errInvalidForgeResponse
				}
			}
		}
		after, e := s.exactSourceBranch(ctx, base, token, m.Branch)
		if e != nil {
			return e
		}
		if after != r.Commit {
			return errRepositoryAccessConflict
		}
		return nil
	})
}
func (s *Server) GetRepositoryFileBatchOperation(ctx context.Context, req *connect.Request[golfv1.GetRepositoryFileBatchOperationRequest]) (*connect.Response[golfv1.GetRepositoryFileBatchOperationResponse], error) {
	single := connect.NewRequest(&golfv1.GetRepositoryFileMutationOperationRequest{Repository: req.Msg.Repository, RepositoryId: req.Msg.RepositoryId, OwnerId: req.Msg.OwnerId, OperationId: req.Msg.OperationId})
	single.Header().Set("Cookie", req.Header().Get("Cookie"))
	single.Header().Set("Origin", req.Header().Get("Origin"))
	out, e := s.GetRepositoryFileMutationOperation(ctx, single)
	if e != nil {
		return nil, e
	}
	if out.Msg.Operation.Kind != 0 {
		return nil, rpcError(errResourceNotFound)
	}
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, e
	}
	var r fileMutationRecord
	e = s.withManagedSession(ctx, s.cookieValue(req.Header()), token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		r, e = scanFileMutation(s.db.QueryRowContext(ctx, `SELECT `+fileMutationColumns+` FROM golf_repository_file_mutations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.ForgeURL, req.Msg.OperationId))
		return e
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	wire, e := fileBatchWire(r)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	return connect.NewResponse(&golfv1.GetRepositoryFileBatchOperationResponse{Operation: wire}), nil
}
func (s *Server) SubmitRepositoryFileBatch(ctx context.Context, req *connect.Request[golfv1.SubmitRepositoryFileBatchRequest]) (*connect.Response[golfv1.SubmitRepositoryFileBatchResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if e = validateFileBatch(m, false); e != nil {
		return nil, rpcError(e)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	fingerprint := fileBatchFingerprint(m)
	repoID, _ := discussionID(m.RepositoryId)
	ownerID, _ := discussionID(m.OwnerId)
	var r fileMutationRecord
	fresh := false
	e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, c database.LockManagedSessionRow, _ []byte) error {
		held, e := s.lockFileMutation(ctx, tx, repoID)
		if e != nil {
			return e
		}
		r, e = scanFileMutation(tx.QueryRowContext(held, `SELECT `+fileMutationColumns+` FROM golf_repository_file_mutations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.ForgeURL, m.OperationId))
		if e == nil {
			if r.Kind != "BATCH" || !bytes.Equal(r.Fingerprint, fingerprint) || !bytes.Equal(r.BatchOriginal, fileBatchOriginal(m)) {
				return errRepositoryAccessConflict
			}
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		if e = s.fileBatchPreflight(held, session, token, m); e != nil {
			return e
		}
		size := 0
		for _, f := range m.Changes {
			size += len(f.Content)
		}
		r, e = scanFileMutation(tx.QueryRowContext(held, `INSERT INTO golf_repository_file_mutations(user_id,forge_url,actor_id,operation_id,repository_id,owner_id,repository_owner,repository_name,access_revision,kind,branch_name,expected_commit_id,file_path,expected_blob_id,content_sha256,content_size_bytes,message_sha256,input_fingerprint,batch_original) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'BATCH',$10,$11,$12,'',$13,$14,$15,$16,$17) RETURNING `+fileMutationColumns, c.UserID, s.config.ForgeURL, actor.ID, m.OperationId, repoID, ownerID, m.Repository.Owner, m.Repository.Name, m.AccessRevision, m.Branch, m.ExpectedCommitId, m.Changes[0].Path, fileMutationHash(fileBatchOriginal(m)), size, m.CommitMessageSha256, fingerprint, fileBatchOriginal(m)))
		fresh = e == nil
		return e
	})
	if e != nil {
		return nil, lifecycleRPCError(e)
	}
	if fresh {
		if e = s.fileBatchPreflight(ctx, session, token, m); e != nil {
			r, e = s.advanceFileMutation(ctx, session, token, r, "REJECTED")
		} else {
			r, e = s.advanceFileMutation(ctx, session, token, r, "DISPATCH_UNKNOWN")
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
			var nativeErr error
			e = s.workflowTransaction(ctx, session, actor.ID, func(tx *sql.Tx, _ database.LockManagedSessionRow, _ []byte) error {
				held, e := s.lockFileMutation(ctx, tx, repoID)
				if e != nil {
					return e
				}
				if e = s.fileBatchPreflight(held, session, token, m); e != nil {
					return e
				}
				held = context.WithValue(held, fileMutationPermitKey{}, fileMutationPermit{record: r, batch: m})
				base, _ := repositoryPath(keyFrom(m.Repository))
				var receipt struct {
					Commit *struct {
						SHA, Message string
						Parents      []struct{ SHA string }
					} `json:"commit"`
				}
				_, nativeErr = s.forgeJSON(held, http.MethodPost, base+"/contents", token, fileBatchNative(m), &receipt, http.StatusCreated)
				if nativeErr == nil {
					if receipt.Commit == nil || !objectID.MatchString(receipt.Commit.SHA) || len(receipt.Commit.SHA) != len(m.ExpectedCommitId) || receipt.Commit.SHA == m.ExpectedCommitId || len(receipt.Commit.Parents) != 1 || receipt.Commit.Parents[0].SHA != m.ExpectedCommitId || receipt.Commit.Message != strings.TrimSpace(m.CommitMessage)+"\n" {
						nativeErr = errInvalidForgeResponse
					} else {
						r.Commit = receipt.Commit.SHA
						nativeErr = s.fileBatchReadback(held, session, token, r)
					}
				}
				return nil
			})
			if e != nil {
				return nil, lifecycleRPCError(e)
			}
			if nativeErr == nil {
				r, e = s.advanceFileMutation(ctx, session, token, r, "SUCCEEDED")
			}
		}
		if e != nil {
			return nil, lifecycleRPCError(e)
		}
	}
	inspect := connect.NewRequest(&golfv1.GetRepositoryFileBatchOperationRequest{Repository: m.Repository, RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, OperationId: m.OperationId})
	inspect.Header().Set("Cookie", req.Header().Get("Cookie"))
	inspect.Header().Set("Origin", req.Header().Get("Origin"))
	out, e := s.GetRepositoryFileBatchOperation(ctx, inspect)
	if e != nil {
		return nil, e
	}
	return connect.NewResponse(&golfv1.SubmitRepositoryFileBatchResponse{Operation: out.Msg.Operation}), nil
}
