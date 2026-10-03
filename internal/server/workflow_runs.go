package server

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

const maxWorkflowSource = 16 << 20
const maxWorkflowSourceEntries = 4096
const maxWorkflowSourceFile = 8 << 20

var errWorkflowRunConflict = errors.New("workflow run intent or version changed")
var errWorkflowSource = errors.New("source archive is outside the safe ordinary-source snapshot contract")
var errWorkflowPolicyDenied = errors.New("manual workflow execution is disabled by current policy")

// No command/source payload is loaded by status/list/log queries.
type workflowRunRecord struct {
	SourceStorage, SourceKey, SourceFingerprint                                                   string
	SourceProfileID                                                                               sql.NullString
	SourceProfileVersion                                                                          sql.NullInt64
	ID, ForgeURL                                                                                  string
	RepositoryID, OwnerID                                                                         int64
	RepositoryOwner, RepositoryName                                                               string
	OrganizationOwned                                                                             bool
	UserID                                                                                        int64
	SessionHash                                                                                   []byte
	Origin, EventRef                                                                              string
	AutomationGrantID                                                                             sql.NullString
	AutomationGrantRevision, AutomationGrantEpoch, AutomationCredentialVersion, RepositoryEventID sql.NullInt64
	CommitID, WorkflowPath, BlobID                                                                string
	Format                                                                                        int32
	Plan, SourceArchive                                                                           []byte
	PolicyEpochs                                                                                  []byte
	IdempotencyKey                                                                                string
	InputHash                                                                                     []byte
	State                                                                                         string
	Version                                                                                       int64
	CreatedAt                                                                                     time.Time
	StartedAt, FinishedAt                                                                         sql.NullTime
	ExitCode                                                                                      sql.NullInt32
	Reason, RunnerID, AttemptID                                                                   string
	LeaseTokenHash                                                                                []byte
	LeaseExpiresAt                                                                                sql.NullTime
	CancelRequested, LogsTruncated                                                                bool
	SourceSHA256                                                                                  string
	LogBytes, LogSequence                                                                         int64
}

const workflowRunColumns = `id::text,forge_url,repository_id,owner_id,repository_owner,repository_name,organization_owned,user_id,session_hash,commit_id,workflow_path,blob_id,format,policy_epochs,idempotency_key::text,input_hash,state,version,created_at,started_at,finished_at,exit_code,reason,runner_id,attempt_id,lease_token_hash,lease_expires_at,cancel_requested,logs_truncated,source_sha256,log_bytes,log_sequence,source_storage,source_key,source_fingerprint,source_profile_id::text,source_profile_version,origin,automation_grant_id::text,automation_grant_revision,automation_grant_epoch,automation_credential_version,repository_event_id,event_ref`

type workflowRunScanner interface{ Scan(...any) error }

func scanWorkflowRun(row workflowRunScanner) (workflowRunRecord, error) {
	var r workflowRunRecord
	err := row.Scan(&r.ID, &r.ForgeURL, &r.RepositoryID, &r.OwnerID, &r.RepositoryOwner, &r.RepositoryName, &r.OrganizationOwned, &r.UserID, &r.SessionHash, &r.CommitID, &r.WorkflowPath, &r.BlobID, &r.Format, &r.PolicyEpochs, &r.IdempotencyKey, &r.InputHash, &r.State, &r.Version, &r.CreatedAt, &r.StartedAt, &r.FinishedAt, &r.ExitCode, &r.Reason, &r.RunnerID, &r.AttemptID, &r.LeaseTokenHash, &r.LeaseExpiresAt, &r.CancelRequested, &r.LogsTruncated, &r.SourceSHA256, &r.LogBytes, &r.LogSequence, &r.SourceStorage, &r.SourceKey, &r.SourceFingerprint, &r.SourceProfileID, &r.SourceProfileVersion, &r.Origin, &r.AutomationGrantID, &r.AutomationGrantRevision, &r.AutomationGrantEpoch, &r.AutomationCredentialVersion, &r.RepositoryEventID, &r.EventRef)
	return r, err
}
func (s *Server) loadWorkflowRun(ctx context.Context, id string) (workflowRunRecord, error) {
	if !creationKey.MatchString(id) {
		return workflowRunRecord{}, invalid("Workflow run ID must be a canonical lowercase UUID v4.")
	}
	if s.db == nil {
		return workflowRunRecord{}, errStorageUnavailable
	}
	r, err := scanWorkflowRun(s.db.QueryRowContext(ctx, "SELECT "+workflowRunColumns+" FROM golf_workflow_runs WHERE id=$1 AND forge_url=$2", id, s.config.GiteaURL))
	if errors.Is(err, sql.ErrNoRows) {
		return r, errResourceNotFound
	}
	if err != nil {
		return r, errStorageUnavailable
	}
	return r, nil
}
func wireWorkflowRun(r workflowRunRecord, canCancel bool) *golfv1.WorkflowRun {
	w := &golfv1.WorkflowRun{Id: r.ID, RepositoryId: strconv.FormatInt(r.RepositoryID, 10), OwnerId: strconv.FormatInt(r.OwnerID, 10), CommitId: r.CommitID, WorkflowPath: r.WorkflowPath, WorkflowBlobId: r.BlobID, Format: golfv1.WorkflowFormat(r.Format), State: golfv1.WorkflowRunState(golfv1.WorkflowRunState_value["WORKFLOW_RUN_STATE_"+strings.ToUpper(r.State)]), Version: strconv.FormatInt(r.Version, 10), CreatedAt: r.CreatedAt.Format(time.RFC3339Nano), Reason: r.Reason, RunnerId: r.RunnerID, SourceSha256: r.SourceSHA256, LogsTruncated: r.LogsTruncated, CanCancel: canCancel && (r.State == "queued" || r.State == "running")}
	if r.StartedAt.Valid {
		v := r.StartedAt.Time.Format(time.RFC3339Nano)
		w.StartedAt = &v
	}
	if r.FinishedAt.Valid {
		v := r.FinishedAt.Time.Format(time.RFC3339Nano)
		w.FinishedAt = &v
	}
	if r.ExitCode.Valid {
		v := r.ExitCode.Int32
		w.ExitCode = &v
	}
	return w
}
func workflowWritable(a *golfv1.RepositoryAccess) bool {
	return a.CurrentPermission == "write" || a.CurrentPermission == "admin" || a.CurrentPermission == "owner"
}
func workflowBrowserToken(ctx context.Context) (forgeCredential, error) {
	if _, delegated := ctx.Value(apiAuthKey{}).(apiAuth); delegated {
		return forgeCredential{}, errApiCredentialReadOnly
	}
	return rpcToken(ctx)
}

// Provider checks remain observations, never calls under local transaction locks.
func (s *Server) withWorkflowRepository(ctx context.Context, session string, credential forgeCredential, key repositoryKey, repoID, ownerID int64, write bool, operation func(User, *golfv1.RepositoryAccess) error) error {
	return s.withForgeCaller(ctx, session, credential, func(user User) error {
		before, err := s.readRepositoryAccess(ctx, credential, key, user)
		if err != nil {
			return err
		}
		check := func(a *golfv1.RepositoryAccess) error {
			if repoID > 0 && (a.RepositoryId != strconv.FormatInt(repoID, 10) || a.OwnerId != strconv.FormatInt(ownerID, 10)) {
				return errResourceNotFound
			}
			if write && !workflowWritable(a) {
				return forgeError{http.StatusForbidden}
			}
			return nil
		}
		if err = check(before); err != nil {
			return err
		}
		if err = operation(user, before); err != nil {
			return err
		}
		after, err := s.readRepositoryAccess(ctx, credential, key, user)
		if err != nil {
			return err
		}
		if after.RepositoryId != before.RepositoryId || after.OwnerId != before.OwnerId || after.OrganizationOwned != before.OrganizationOwned {
			return errResourceNotFound
		}
		return check(after)
	})
}

// Lock order matches session lifecycle: Golf user, source session, policy, run.
func (s *Server) workflowTransaction(ctx context.Context, session string, nativeID int64, operation func(*sql.Tx, database.LockManagedSessionRow, []byte) error) error {
	hash, err := s.authSessionHash(ctx, session, nil)
	if err != nil {
		return err
	}
	if s.db == nil {
		return errStorageUnavailable
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return errStorageUnavailable
	}
	defer tx.Rollback()
	q := database.New(s.db).WithTx(tx)
	identity, err := q.LockSessionUser(ctx, database.LockSessionUserParams{CallerTokenHash: hash, ForgeURL: s.config.GiteaURL})
	if errors.Is(err, sql.ErrNoRows) {
		return errUnauthenticated
	}
	if err != nil {
		return errStorageUnavailable
	}
	if identity.ForgeUserID != nativeID {
		return errUnauthenticated
	}
	actor, err := q.LockManagedSession(ctx, database.LockManagedSessionParams{CallerTokenHash: hash, UserID: identity.ID, ForgeURL: s.config.GiteaURL})
	if errors.Is(err, sql.ErrNoRows) {
		return errUnauthenticated
	}
	if err != nil {
		return errStorageUnavailable
	}
	if !actor.ExpiresAt.After(time.Now()) {
		return errUnauthenticated
	}
	if _, err = s.authSessionHash(ctx, session, q); err != nil {
		return err
	}
	if err = operation(tx, actor, hash); err != nil {
		return err
	}
	if !actor.ExpiresAt.After(time.Now()) {
		return errUnauthenticated
	}
	if _, err = s.authSessionHash(ctx, session, q); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return errStorageUnavailable
	}
	return nil
}
func workflowIntentHash(key repositoryKey, ref, file string, repoID, ownerID int64) []byte {
	data, _ := json.Marshal(struct {
		Owner, Name, Ref, Path string
		RepositoryID, OwnerID  int64
	}{strings.ToLower(key.Owner), strings.ToLower(key.Name), ref, file, repoID, ownerID})
	sum := sha256.Sum256(data)
	return sum[:]
}

func validWorkflowSnapshotPath(name string) bool {
	if len(name) > 4096 || name == "" || name == "." || strings.HasPrefix(name, "/") || path.Clean(name) != name || strings.Contains(name, "\\") || !utf8.ValidString(name) || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == ".." || part == ".git" {
			return false
		}
	}
	return true
}

// Never extracts native paths on the server. Rewrites a fresh, metadata-free tar.
func normalizeWorkflowSource(reader io.Reader, commit, file, blob string, workflow []byte) ([]byte, error) {
	tr := tar.NewReader(reader)
	var out bytes.Buffer
	tw := tar.NewWriter(&out)
	seen := map[string]byte{}
	root := ""
	entries := 0
	payload := int64(0)
	found := false
	headers := 0
	globalSeen, rootSeen := false, false
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, errWorkflowSource
		}
		headers++
		if headers > maxWorkflowSourceEntries+2 {
			return nil, errWorkflowSource
		}
		if h.Typeflag == tar.TypeXGlobalHeader {
			if len(h.PAXRecords) != 1 || h.PAXRecords["comment"] != commit || entries != 0 || globalSeen {
				return nil, errWorkflowSource
			}
			globalSeen = true
			continue
		}
		if strings.HasSuffix(h.Name, "/") && h.Typeflag != tar.TypeDir {
			return nil, errWorkflowSource
		}
		raw := strings.TrimSuffix(h.Name, "/")
		if !validWorkflowSnapshotPath(raw) {
			return nil, errWorkflowSource
		}
		parts := strings.SplitN(raw, "/", 2)
		if root == "" {
			root = parts[0]
		}
		if parts[0] != root {
			return nil, errWorkflowSource
		}
		if len(parts) == 1 {
			if h.Typeflag != tar.TypeDir || entries != 0 || rootSeen {
				return nil, errWorkflowSource
			}
			rootSeen = true
			continue
		}
		name := parts[1]
		if !validWorkflowSnapshotPath(name) {
			return nil, errWorkflowSource
		}
		entries++
		if entries > maxWorkflowSourceEntries || h.Size < 0 || h.Size > maxWorkflowSourceFile || h.Linkname != "" || h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeRegA && h.Typeflag != tar.TypeDir {
			return nil, errWorkflowSource
		}
		if _, ok := seen[name]; ok {
			return nil, errWorkflowSource
		}
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if kind, ok := seen[parent]; ok && kind != tar.TypeDir {
				return nil, errWorkflowSource
			}
		}
		if h.Typeflag != tar.TypeDir {
			for child := range seen {
				if strings.HasPrefix(child, name+"/") {
					return nil, errWorkflowSource
				}
			}
		}
		seen[name] = h.Typeflag
		payload += h.Size
		if payload > maxWorkflowSource {
			return nil, errWorkflowSource
		}
		data, err := io.ReadAll(io.LimitReader(tr, h.Size+1))
		if err != nil || int64(len(data)) != h.Size {
			return nil, errWorkflowSource
		}
		if h.Typeflag == tar.TypeDir && h.Size != 0 {
			return nil, errWorkflowSource
		}
		if name == file {
			if h.Typeflag == tar.TypeDir || !bytes.Equal(data, workflow) || !workflowBlobMatches(data, blob) {
				return nil, errWorkflowSource
			}
			found = true
		}
		mode := int64(0644)
		kind := byte(tar.TypeReg)
		if h.Typeflag == tar.TypeDir {
			mode = 0755
			kind = tar.TypeDir
		} else if h.Mode&0111 != 0 {
			mode = 0755
		}
		if err = tw.WriteHeader(&tar.Header{Name: name, Typeflag: kind, Mode: mode, Size: h.Size, Format: tar.FormatPAX}); err != nil {
			return nil, errWorkflowSource
		}
		if _, err = tw.Write(data); err != nil || out.Len() > maxWorkflowSource {
			return nil, errWorkflowSource
		}
	}
	// Only zero tar padding may follow the end marker; reject concatenated archives.
	trailer := &io.LimitedReader{R: reader, N: maxWorkflowSource + 1}
	var padding [4096]byte
	for {
		n, e := trailer.Read(padding[:])
		for _, b := range padding[:n] {
			if b != 0 {
				return nil, errWorkflowSource
			}
		}
		if e == io.EOF {
			break
		}
		if e != nil || trailer.N <= 0 {
			return nil, errWorkflowSource
		}
	}
	if !found {
		return nil, errWorkflowSource
	}
	if err := tw.Close(); err != nil || out.Len() > maxWorkflowSource {
		return nil, errWorkflowSource
	}
	return out.Bytes(), nil
}
func (s *Server) workflowSource(ctx context.Context, credential forgeCredential, base, commit, file, blob string, workflow []byte) ([]byte, error) {
	res, err := s.forgeRequest(ctx, http.MethodGet, base+"/archive/"+commit+".tar.gz", "application/octet-stream", credential, nil)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	compressed := &io.LimitedReader{R: res.Body, N: maxWorkflowSource + 1}
	gz, err := gzip.NewReader(compressed)
	if err != nil {
		return nil, errWorkflowSource
	}
	defer gz.Close()
	decoded := &io.LimitedReader{R: gz, N: 2*maxWorkflowSource + 1}
	data, err := normalizeWorkflowSource(decoded, commit, file, blob, workflow)
	if err != nil {
		return nil, err
	}
	if _, err = io.Copy(io.Discard, decoded); err != nil || decoded.N <= 0 {
		return nil, errWorkflowSource
	}
	if _, err = io.Copy(io.Discard, compressed); err != nil || compressed.N <= 0 {
		return nil, errWorkflowSource
	}
	return data, nil
}
func (s *Server) prepareWorkflowRun(ctx context.Context, credential forgeCredential, key repositoryKey, ref, file string) (string, string, *workflowExecutionPlan, []byte, error) {
	base, _ := repositoryPath(key)
	commits, _, err := s.readCommits(ctx, base, credential, ref, 1, 1)
	if err != nil {
		return "", "", nil, nil, err
	}
	if len(commits) == 0 {
		return "", "", nil, nil, errEmptyRepository
	}
	if len(commits) != 1 || objectID.MatchString(ref) && commits[0].SHA != ref {
		return "", "", nil, nil, errInvalidForgeResponse
	}
	commit := commits[0].SHA
	metadata, err := s.workflowContents(ctx, credential, base, commit, file, false)
	if err != nil {
		return "", "", nil, nil, err
	}
	expected := metadata.File
	if expected == nil || expected.Type != "file" || expected.Path != file || expected.LFSOID != "" || expected.Size > maxWorkflowBytes {
		return "", "", nil, nil, errWorkflowExecutionUnsupported
	}
	content, err := s.workflowContents(ctx, credential, base, commit, file, true)
	if err != nil {
		return "", "", nil, nil, err
	}
	candidate := content.File
	if candidate == nil || candidate.sourceEntry != expected.sourceEntry || candidate.Type != "file" || candidate.Path != file || candidate.LFSOID != "" || candidate.Size > maxWorkflowBytes || candidate.Encoding != "base64" || len(candidate.Content) > base64.StdEncoding.EncodedLen(maxWorkflowBytes)+2048 {
		return "", "", nil, nil, errWorkflowExecutionUnsupported
	}
	data, err := base64.StdEncoding.DecodeString(candidate.Content)
	if err != nil || int64(len(data)) != candidate.Size || !workflowBlobMatches(data, candidate.SHA) {
		return "", "", nil, nil, errInvalidForgeResponse
	}
	format := golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITHUB_ACTIONS
	if file == ".gitlab-ci.yml" {
		format = golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITLAB_CI
	}
	plan, err := compileWorkflowExecution(format, data)
	if err != nil {
		return "", "", nil, nil, err
	}
	source, err := s.workflowSource(ctx, credential, base, commit, file, candidate.SHA, data)
	return commit, candidate.SHA, plan, source, err
}

func (s *Server) DispatchWorkflow(ctx context.Context, req *connect.Request[golfv1.DispatchWorkflowRequest]) (*connect.Response[golfv1.DispatchWorkflowResponse], error) {
	credential, err := workflowBrowserToken(ctx)
	if err != nil {
		return nil, rpcError(err)
	}
	m := req.Msg
	key := keyFrom(m.Repository)
	if _, err = repositoryPath(key); err != nil {
		return nil, rpcError(err)
	}
	if !creationKey.MatchString(m.IdempotencyKey) || !validRef(m.Ref) || !executionWorkflowPath(m.WorkflowPath) {
		return nil, rpcError(invalid("Provide a canonical UUID v4, supported workflow path and plain ref."))
	}
	var result workflowRunRecord
	err = s.withWorkflowRepository(ctx, s.cookieValue(req.Header()), credential, key, 0, 0, true, func(user User, access *golfv1.RepositoryAccess) error {
		repoID, _ := strconv.ParseInt(access.RepositoryId, 10, 64)
		ownerID, _ := strconv.ParseInt(access.OwnerId, 10, 64)
		inputHash := workflowIntentHash(key, m.Ref, m.WorkflowPath, repoID, ownerID)
		checkEditable := func() error {
			row, _, e := s.readRepositorySettings(ctx, credential, key)
			if e != nil {
				return e
			}
			if row.ID != repoID || row.Owner.ID != ownerID {
				return errResourceNotFound
			}
			if *row.Archived || *row.Mirror {
				return forgeError{http.StatusForbidden}
			}
			return nil
		}
		if e := checkEditable(); e != nil {
			return e
		}
		existing := false
		e := s.workflowTransaction(ctx, s.cookieValue(req.Header()), user.ID, func(tx *sql.Tx, actor database.LockManagedSessionRow, _ []byte) error {
			r, e := scanWorkflowRun(tx.QueryRowContext(ctx, "SELECT "+workflowRunColumns+" FROM golf_workflow_runs WHERE forge_url=$1 AND user_id=$2 AND origin='manual' AND idempotency_key=$3", s.config.GiteaURL, actor.UserID, m.IdempotencyKey))
			if e == nil {
				if !bytes.Equal(r.InputHash, inputHash) {
					return errWorkflowRunConflict
				}
				result = r
				existing = true
				return nil
			}
			if !errors.Is(e, sql.ErrNoRows) {
				return errStorageUnavailable
			}
			admission, e := s.readEffectiveExecutionPolicy(ctx, tx, repoID, ownerID, access.OrganizationOwned, m.WorkflowPath)
			if e != nil {
				return e
			}
			if !admission.Allowed {
				return errWorkflowPolicyDenied
			}
			return nil
		})
		if e != nil || existing {
			return e
		}
		commit, blob, plan, source, e := s.prepareWorkflowRun(ctx, credential, key, m.Ref, m.WorkflowPath)
		if e != nil {
			return e
		}
		image, e := s.executionImage(plan)
		if e != nil {
			return e
		}
		plan.ImageDigest = image
		sourceBinding, e := s.storeWorkflowSource(ctx, source)
		if e != nil {
			return e
		}
		if e = checkEditable(); e != nil {
			return e
		}
		latest, e := s.readRepositoryAccess(ctx, credential, key, user)
		if e != nil {
			return e
		}
		if latest.RepositoryId != access.RepositoryId || latest.OwnerId != access.OwnerId || latest.OrganizationOwned != access.OrganizationOwned {
			return errResourceNotFound
		}
		if !workflowWritable(latest) {
			return forgeError{http.StatusForbidden}
		}
		id, e := repositoryCreationKey("")
		if e != nil {
			return e
		}
		planJSON, e := json.Marshal(plan)
		if e != nil {
			return errStorageUnavailable
		}
		sum := sha256.Sum256(source)
		return s.workflowTransaction(ctx, s.cookieValue(req.Header()), user.ID, func(tx *sql.Tx, actor database.LockManagedSessionRow, hash []byte) error {
			admission, e := s.readEffectiveExecutionPolicy(ctx, tx, repoID, ownerID, access.OrganizationOwned, m.WorkflowPath)
			if e != nil {
				return e
			}
			if !admission.Allowed {
				return errWorkflowPolicyDenied
			}
			epochs, e := json.Marshal(admission.Epochs)
			if e != nil {
				return errStorageUnavailable
			}
			_, e = tx.ExecContext(ctx, `INSERT INTO golf_workflow_runs(id,forge_url,repository_id,owner_id,repository_owner,repository_name,organization_owned,user_id,session_hash,commit_id,workflow_path,blob_id,format,plan,source_archive,source_sha256,policy_epochs,idempotency_key,input_hash,source_storage,source_key,source_fingerprint,source_profile_id,source_profile_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) ON CONFLICT(forge_url,user_id,origin,idempotency_key) DO NOTHING`, id, s.config.GiteaURL, repoID, ownerID, key.Owner, key.Name, access.OrganizationOwned, actor.UserID, hash, commit, m.WorkflowPath, blob, int32(plan.Format), planJSON, sourceBinding.Archive, hex.EncodeToString(sum[:]), epochs, m.IdempotencyKey, inputHash, sourceBinding.Storage, sourceBinding.Key, sourceBinding.Fingerprint, sourceBinding.ProfileID, sourceBinding.ProfileVersion)
			if e != nil {
				return errStorageUnavailable
			}
			result, e = scanWorkflowRun(tx.QueryRowContext(ctx, "SELECT "+workflowRunColumns+" FROM golf_workflow_runs WHERE forge_url=$1 AND user_id=$2 AND origin='manual' AND idempotency_key=$3", s.config.GiteaURL, actor.UserID, m.IdempotencyKey))
			if e != nil {
				return errStorageUnavailable
			}
			if !bytes.Equal(result.InputHash, inputHash) {
				return errWorkflowRunConflict
			}
			return nil
		})
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.DispatchWorkflowResponse{Run: wireWorkflowRun(result, true)}), nil
}

func (s *Server) GetWorkflowRun(ctx context.Context, req *connect.Request[golfv1.GetWorkflowRunRequest]) (*connect.Response[golfv1.GetWorkflowRunResponse], error) {
	credential, err := workflowBrowserToken(ctx)
	if err != nil {
		return nil, rpcError(err)
	}
	record, err := s.loadWorkflowRun(ctx, req.Msg.RunId)
	if err != nil {
		return nil, rpcError(err)
	}
	var result *golfv1.WorkflowRun
	err = s.withWorkflowRepository(ctx, s.cookieValue(req.Header()), credential, repositoryKey{record.RepositoryOwner, record.RepositoryName}, record.RepositoryID, record.OwnerID, false, func(_ User, a *golfv1.RepositoryAccess) error {
		var e error
		record, e = s.loadWorkflowRun(ctx, record.ID)
		if e != nil {
			return e
		}
		result = wireWorkflowRun(record, workflowWritable(a))
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.GetWorkflowRunResponse{Run: result}), nil
}
func (s *Server) ListWorkflowRuns(ctx context.Context, req *connect.Request[golfv1.ListWorkflowRunsRequest]) (*connect.Response[golfv1.ListWorkflowRunsResponse], error) {
	credential, err := workflowBrowserToken(ctx)
	if err != nil {
		return nil, rpcError(err)
	}
	key := keyFrom(req.Msg.Repository)
	return s.listWorkflowRuns(ctx, req, credential, key)
}
func (s *Server) listWorkflowRuns(ctx context.Context, req *connect.Request[golfv1.ListWorkflowRunsRequest], credential forgeCredential, key repositoryKey) (*connect.Response[golfv1.ListWorkflowRunsResponse], error) {
	page, limit, err := pagination(pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	result := &golfv1.ListWorkflowRunsResponse{Page: &golfv1.PageResponse{}}
	err = s.withWorkflowRepository(ctx, s.cookieValue(req.Header()), credential, key, 0, 0, false, func(_ User, a *golfv1.RepositoryAccess) error {
		if s.db == nil {
			return errStorageUnavailable
		}
		repoID, _ := strconv.ParseInt(a.RepositoryId, 10, 64)
		ownerID, _ := strconv.ParseInt(a.OwnerId, 10, 64)
		rows, e := s.db.QueryContext(ctx, "SELECT "+workflowRunColumns+" FROM golf_workflow_runs WHERE forge_url=$1 AND repository_id=$2 AND owner_id=$3 ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5", s.config.GiteaURL, repoID, ownerID, limit+1, (page-1)*limit)
		if e != nil {
			return errStorageUnavailable
		}
		defer rows.Close()
		records := []workflowRunRecord{}
		for rows.Next() {
			r, e := scanWorkflowRun(rows)
			if e != nil {
				return errStorageUnavailable
			}
			records = append(records, r)
		}
		if rows.Err() != nil {
			return errStorageUnavailable
		}
		if len(records) > int(limit) {
			if page == 10000 {
				return invalid("Workflow run listing exceeds the 10000-page limit.")
			}
			records = records[:limit]
			result.Page.NextPage = page + 1
		}
		for _, r := range records {
			result.Runs = append(result.Runs, wireWorkflowRun(r, workflowWritable(a)))
		}
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
func (s *Server) CancelWorkflowRun(ctx context.Context, req *connect.Request[golfv1.CancelWorkflowRunRequest]) (*connect.Response[golfv1.CancelWorkflowRunResponse], error) {
	credential, err := workflowBrowserToken(ctx)
	if err != nil {
		return nil, rpcError(err)
	}
	version, err := discussionID(req.Msg.ExpectedVersion)
	if err != nil {
		return nil, rpcError(invalid("Provide the observed positive workflow run version."))
	}
	record, err := s.loadWorkflowRun(ctx, req.Msg.RunId)
	if err != nil {
		return nil, rpcError(err)
	}
	err = s.withWorkflowRepository(ctx, s.cookieValue(req.Header()), credential, repositoryKey{record.RepositoryOwner, record.RepositoryName}, record.RepositoryID, record.OwnerID, true, func(user User, _ *golfv1.RepositoryAccess) error {
		return s.workflowTransaction(ctx, s.cookieValue(req.Header()), user.ID, func(tx *sql.Tx, _ database.LockManagedSessionRow, _ []byte) error {
			var e error
			record, e = scanWorkflowRun(tx.QueryRowContext(ctx, "UPDATE golf_workflow_runs SET state='cancelled',version=version+1,finished_at=clock_timestamp(),reason='Cancelled by repository writer.',cancel_requested=true,lease_token_hash=NULL WHERE id=$1 AND forge_url=$2 AND version=$3 AND state IN ('queued','running') RETURNING "+workflowRunColumns, record.ID, s.config.GiteaURL, version))
			if errors.Is(e, sql.ErrNoRows) {
				return errWorkflowRunConflict
			}
			if e != nil {
				return errStorageUnavailable
			}
			return nil
		})
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.CancelWorkflowRunResponse{Run: wireWorkflowRun(record, false)}), nil
}
func (s *Server) GetWorkflowRunLogs(ctx context.Context, req *connect.Request[golfv1.GetWorkflowRunLogsRequest]) (*connect.Response[golfv1.GetWorkflowRunLogsResponse], error) {
	credential, err := workflowBrowserToken(ctx)
	if err != nil {
		return nil, rpcError(err)
	}
	if req.Msg.AfterSequence > 1<<63-1 {
		return nil, rpcError(invalid("Log sequence is outside the supported bound."))
	}
	record, err := s.loadWorkflowRun(ctx, req.Msg.RunId)
	if err != nil {
		return nil, rpcError(err)
	}
	result := &golfv1.GetWorkflowRunLogsResponse{}
	err = s.withWorkflowRepository(ctx, s.cookieValue(req.Header()), credential, repositoryKey{record.RepositoryOwner, record.RepositoryName}, record.RepositoryID, record.OwnerID, false, func(_ User, _ *golfv1.RepositoryAccess) error {
		rows, e := s.db.QueryContext(ctx, `SELECT sequence,text FROM golf_workflow_run_logs WHERE run_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 17`, record.ID, int64(req.Msg.AfterSequence))
		if e != nil {
			return errStorageUnavailable
		}
		defer rows.Close()
		for rows.Next() {
			var seq int64
			var text string
			if e = rows.Scan(&seq, &text); e != nil {
				return errStorageUnavailable
			}
			result.Logs = append(result.Logs, &golfv1.WorkflowRunLog{Sequence: uint64(seq), Text: text})
		}
		if rows.Err() != nil {
			return errStorageUnavailable
		}
		if len(result.Logs) > 16 {
			result.HasMore = true
			result.Logs = result.Logs[:16]
		}
		record, e = s.loadWorkflowRun(ctx, record.ID)
		if e != nil {
			return e
		}
		result.Truncated = record.LogsTruncated
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
