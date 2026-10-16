package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

type mirrorNativeObservation086 struct {
	ID      int64  `json:"id"`
	Branch  string `json:"default_branch"`
	Updated string `json:"mirror_updated"`
	Head    string
}

func (s *Server) mirrorNativeObservation086(ctx context.Context, token forgeCredential, key repositoryKey) (r mirrorNativeObservation086, e error) {
	base, _ := repositoryPath(key)
	if _, e = s.forge(ctx, http.MethodGet, base, token, nil, &r); e != nil {
		return
	}
	if !validRef(r.Branch) || !validRuleTime(r.Updated) {
		return r, errInvalidForgeResponse
	}
	var branch struct {
		Name   string `json:"name"`
		Commit struct {
			ID string `json:"id"`
		} `json:"commit"`
	}
	if _, e = s.forge(ctx, http.MethodGet, base+"/branches/"+url.PathEscape(r.Branch), token, nil, &branch); e != nil {
		return
	}
	if branch.Name != r.Branch || !objectID.MatchString(branch.Commit.ID) {
		return r, errInvalidForgeResponse
	}
	r.Head = branch.Commit.ID
	return
}
func (s *Server) recordMirrorBaseline086(ctx context.Context, tx *sql.Tx, token forgeCredential, r mirrorRecord, configuration mirrorConfiguration) error {
	source, _, e := publicImportURL(configuration.OriginalURL)
	if e != nil || source == "" {
		return nil
	}
	native, e := s.mirrorNativeObservation086(ctx, token, repositoryKey{r.Owner, r.Name})
	if e != nil || native.ID != r.RepoID {
		return nil
	}
	_, e = tx.ExecContext(ctx, `INSERT INTO golf_mirror_sync_baselines(operation_id,source_url,default_branch,native_updated_at,native_head_commit_id) VALUES($1,$2,$3,$4,$5)`, r.ID, source, native.Branch, native.Updated, native.Head)
	if e != nil {
		return errStorageUnavailable
	}
	return nil
}

// Only canonical public metadata is followed. No user/native/provider credential
// is forwarded to this endpoint, and the shared HTTP client refuses redirects.
func (s *Server) mirrorPublicJSON086(ctx context.Context, endpoint string, v any) error {
	if !strings.HasPrefix(endpoint, "https://api.github.com/repos/") && !strings.HasPrefix(endpoint, "https://gitlab.com/api/v4/projects/") {
		return errInvalidForgeResponse
	}
	r, e := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if e != nil {
		return e
	}
	r.Header.Set("Accept", "application/json")
	r.Header.Set("User-Agent", "Golf-mirror-observation")
	response, e := s.client.Do(r)
	if e != nil {
		return errForgeUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return forgeError{http.StatusForbidden}
	}
	if response.ContentLength > 256<<10 {
		return errForgeResponseTooLarge
	}
	b, e := io.ReadAll(io.LimitReader(response.Body, (256<<10)+1))
	if e != nil || len(b) > 256<<10 || json.Unmarshal(b, v) != nil {
		return errInvalidForgeResponse
	}
	return nil
}
func (s *Server) mirrorPublicHead086(ctx context.Context, source string) (branch, head string, e error) {
	canonical, endpoint, e := publicImportURL(source)
	if e != nil || canonical == "" {
		return "", "", errInvalidForgeResponse
	}
	var info struct {
		ID         int64  `json:"id"`
		Private    *bool  `json:"private"`
		Visibility string `json:"visibility"`
		Clone      string `json:"clone_url"`
		HTTPClone  string `json:"http_url_to_repo"`
		Branch     string `json:"default_branch"`
	}
	if e = s.mirrorPublicJSON086(ctx, endpoint, &info); e != nil {
		return
	}
	github := strings.HasPrefix(source, "https://github.com/")
	if info.ID < 1 || !validRef(info.Branch) || github && (info.Private == nil || *info.Private || info.Clone != canonical) || !github && (info.Visibility != "public" || info.HTTPClone != canonical) {
		return "", "", errInvalidForgeResponse
	}
	path := endpoint + "/branches/" + url.PathEscape(info.Branch)
	if !github {
		path = endpoint + "/repository/branches/" + url.PathEscape(info.Branch)
	}
	var result struct {
		Name   string `json:"name"`
		Commit struct {
			SHA string `json:"sha"`
			ID  string `json:"id"`
		} `json:"commit"`
	}
	if e = s.mirrorPublicJSON086(ctx, path, &result); e != nil {
		return
	}
	head = result.Commit.SHA
	if !github {
		head = result.Commit.ID
	}
	if result.Name != info.Branch || !objectID.MatchString(head) {
		return "", "", errInvalidForgeResponse
	}
	return info.Branch, head, nil
}
func (s *Server) GetMirrorSyncObservation(ctx context.Context, req *connect.Request[golfv1.GetMirrorSyncObservationRequest]) (*connect.Response[golfv1.GetMirrorSyncObservationResponse], error) {
	token, session, e := s.reviewDraftCaller(ctx, req.Header())
	if e != nil {
		return nil, e
	}
	m := req.Msg
	if _, e = repositoryPath(keyFrom(m.Repository)); e != nil {
		return nil, rpcError(e)
	}
	for _, id := range []string{m.RepositoryId, m.OwnerId} {
		if _, e = discussionID(id); e != nil {
			return nil, rpcError(e)
		}
	}
	if !creationKey.MatchString(m.OperationId) {
		return nil, rpcError(invalid("Inspect the original mirror sync UUID."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var r mirrorRecord
	e = s.withManagedSession(ctx, session, token, func(_ *database.Queries, c database.LockManagedSessionRow, _ []byte) error {
		var e error
		r, e = scanMirror(s.db.QueryRowContext(ctx, `SELECT `+mirrorColumns+` FROM golf_repository_mirror_operations WHERE user_id=$1 AND forge_url=$2 AND operation_id=$3`, c.UserID, s.config.ForgeURL, m.OperationId))
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if e != nil {
			return errStorageUnavailable
		}
		return nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	if r.RepoID != mustID(m.RepositoryId) || r.OwnerID != mustID(m.OwnerId) || r.Owner != m.Repository.Owner || r.Name != m.Repository.Name {
		return nil, rpcError(errResourceNotFound)
	}
	if e = s.mirrorRecordAuthority(ctx, session, token, r); e != nil {
		return nil, rpcError(e)
	}
	result := &golfv1.GetMirrorSyncObservationResponse{Contract: "golf.mirror-default-branch-observation.v1", Operation: mirrorWire(r), Reason: "Native synchronization acceptance is not yet confirmed."}
	if r.Phase != "SUCCEEDED" || !r.Accepted || r.Kind != 2 {
		return connect.NewResponse(result), nil
	}
	var baselineHead string
	e = s.db.QueryRowContext(ctx, `SELECT source_url,default_branch,native_updated_at,native_head_commit_id FROM golf_mirror_sync_baselines WHERE operation_id=$1`, r.ID).Scan(&result.SourceUrl, &result.DefaultBranch, &result.BaselineNativeUpdatedAt, &baselineHead)
	if errors.Is(e, sql.ErrNoRows) {
		result.Reason = "Original sync has no qualified pre-dispatch native baseline; queue acceptance remains the only receipt."
		return connect.NewResponse(result), nil
	}
	if e != nil {
		return nil, rpcError(errStorageUnavailable)
	}
	_, configuration, e := s.mirrorAuthority(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId)
	if e != nil {
		return nil, rpcError(e)
	}
	if mirrorRevision(configuration) != r.Revision {
		return nil, rpcError(errRepositoryAccessConflict)
	}
	branch, head, e := s.mirrorPublicHead086(ctx, result.SourceUrl)
	if e != nil {
		return nil, rpcError(e)
	}
	native, e := s.mirrorNativeObservation086(ctx, token, keyFrom(m.Repository))
	if e != nil {
		return nil, rpcError(e)
	}
	if native.ID != r.RepoID || native.Branch != result.DefaultBranch || branch != native.Branch {
		return nil, rpcError(errRepositoryAccessConflict)
	}
	repeatBranch, repeatHead, e := s.mirrorPublicHead086(ctx, result.SourceUrl)
	if e != nil {
		return nil, rpcError(e)
	}
	if repeatBranch != branch || repeatHead != head {
		return nil, rpcError(errPullSnapshotChanged)
	}
	again, e := s.mirrorNativeObservation086(ctx, token, keyFrom(m.Repository))
	if e != nil || again != native {
		return nil, rpcError(errPullSnapshotChanged)
	}
	_, after, e := s.mirrorAuthority(ctx, session, token, keyFrom(m.Repository), m.RepositoryId, m.OwnerId)
	if e != nil {
		return nil, rpcError(e)
	}
	if mirrorRevision(after) != r.Revision {
		return nil, rpcError(errRepositoryAccessConflict)
	}
	if e = s.mirrorRecordAuthority(ctx, session, token, r); e != nil {
		return nil, rpcError(e)
	}
	result.NativeUpdatedAt = native.Updated
	result.NativeHeadCommitId = native.Head
	result.SourceHeadCommitId = head
	old, _ := time.Parse(time.RFC3339Nano, result.BaselineNativeUpdatedAt)
	updated, _ := time.Parse(time.RFC3339Nano, native.Updated)
	result.CompletionObserved = updated.After(old) && native.Head == head
	result.Reason = "Queue accepted; a subsequent native synchronization and current upstream default-branch equality are not both observed."
	if result.CompletionObserved {
		result.Reason = "Native sync timestamp advanced after the original baseline and default branch matches the repeatedly observed public upstream HEAD. This does not establish all refs/history or attribute the sync solely to this request."
	}
	return connect.NewResponse(result), nil
}
