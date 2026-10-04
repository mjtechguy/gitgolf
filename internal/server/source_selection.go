package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// Native refs are an unpaged prefix collection, not an inventory page. Bound
// the transport and rows, then require the complete namespace/name. A failed
// lookup is unknown, never absence. Do not copy native short-ref precedence.
type forgeSourceRef struct {
	Ref    string `json:"ref"`
	Object struct {
		SHA  string `json:"sha"`
		Type string `json:"type"`
	} `json:"object"`
}

func sourceNotFound(err error) bool {
	var upstream forgeError
	return errors.Is(err, errResourceNotFound) || errors.As(err, &upstream) && upstream.status == 404
}
func (s *Server) exactSourceBranch(ctx context.Context, base string, token forgeCredential, name string) (string, error) {
	var raw json.RawMessage
	if _, err := s.forge(ctx, http.MethodGet, base+"/git/refs/heads/"+escapedSourcePath(name), token, nil, &raw); err != nil {
		return "", err
	}
	var rows []forgeSourceRef
	if len(raw) == 0 {
		return "", errInvalidForgeResponse
	}
	switch raw[0] {
	case '[':
		if json.Unmarshal(raw, &rows) != nil {
			return "", errInvalidForgeResponse
		}
	case '{':
		var row forgeSourceRef
		if json.Unmarshal(raw, &row) != nil {
			return "", errInvalidForgeResponse
		}
		rows = []forgeSourceRef{row}
	default:
		return "", errInvalidForgeResponse
	}
	if len(rows) > 2000 {
		return "", errForgeResponseTooLarge
	}
	full := "refs/heads/" + name
	seen := map[string]bool{}
	matched := ""
	for _, row := range rows {
		if !strings.HasPrefix(row.Ref, full) || !validRef(strings.TrimPrefix(row.Ref, "refs/heads/")) || seen[row.Ref] || row.Object.Type != "commit" || !objectID.MatchString(row.Object.SHA) {
			return "", errInvalidForgeResponse
		}
		seen[row.Ref] = true
		if row.Ref == full {
			matched = row.Object.SHA
		}
	}
	if matched == "" {
		return "", errResourceNotFound
	}
	return matched, nil
}
func (s *Server) exactSourceTag(ctx context.Context, base string, token forgeCredential, name string) (forgeTag, error) {
	var row forgeTag
	_, err := s.forge(ctx, http.MethodGet, base+"/tags/"+escapedSourcePath(name), token, nil, &row)
	if err == nil && (row.Name != name || !objectID.MatchString(row.ID) || !objectID.MatchString(row.Commit.SHA) || len(row.ID) != len(row.Commit.SHA) || !discussionText(row.Message, 256<<10)) {
		err = errInvalidForgeResponse
	}
	return row, err
}
func (s *Server) exactSourceCommit(ctx context.Context, base string, token forgeCredential, sha string) error {
	_, err := s.sourceCommitTree(ctx, base, token, sha)
	return err
}
func validateSourceSelector(selector *golfv1.RepositorySourceSelector) error {
	if selector == nil {
		return invalid("Select a typed default branch, branch, tag or full commit.")
	}
	switch selector.Kind {
	case golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_DEFAULT_BRANCH:
		if selector.Name != "" {
			return invalid("Default-branch selection requires an empty name.")
		}
	case golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_BRANCH, golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_TAG:
		if selector.Name == "" || !validRef(selector.Name) {
			return invalid("Select an exact valid branch or tag name.")
		}
	case golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_COMMIT:
		if !objectID.MatchString(selector.Name) {
			return invalid("Select a full lowercase commit ID.")
		}
	default:
		return invalid("Select a supported source ref kind.")
	}
	return nil
}
func (s *Server) sourceSelection(ctx context.Context, base string, repo Repository, token forgeCredential, selector *golfv1.RepositorySourceSelector) (*golfv1.RepositorySourceSelection, error) {
	if repo.Empty {
		return nil, errEmptyRepository
	}
	selection := &golfv1.RepositorySourceSelection{Kind: selector.Kind, Name: selector.Name}
	var err error
	switch selector.Kind {
	case golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_DEFAULT_BRANCH:
		selection.Name = repo.DefaultBranch
		if selection.Name == "" || !validRef(selection.Name) {
			return nil, errInvalidForgeResponse
		}
		fallthrough
	case golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_BRANCH:
		selection.CommitId, err = s.exactSourceBranch(ctx, base, token, selection.Name)
	case golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_TAG:
		var tag forgeTag
		tag, err = s.exactSourceTag(ctx, base, token, selection.Name)
		if err == nil {
			selection.CommitId = tag.Commit.SHA
			selection.TagObjectId = &tag.ID
		}
	case golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_COMMIT:
		selection.CommitId = selector.Name
	default:
		return nil, errInvalidForgeResponse
	}
	if err != nil {
		return nil, err
	}
	if err = s.exactSourceCommit(ctx, base, token, selection.CommitId); err != nil {
		return nil, err
	}
	// Re-observe named refs after commit resolution. Matching observations are not
	// atomic ref locks and do not detect move-away/move-back races.
	switch selection.Kind {
	case golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_DEFAULT_BRANCH:
		after, e := s.readRepository(ctx, base, token)
		if e != nil {
			return nil, e
		}
		if after.ID != repo.ID || after.DefaultBranch != selection.Name {
			return nil, errPullSnapshotChanged
		}
		fallthrough
	case golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_BRANCH:
		sha, e := s.exactSourceBranch(ctx, base, token, selection.Name)
		if e != nil {
			return nil, e
		}
		if sha != selection.CommitId {
			return nil, errPullSnapshotChanged
		}
	case golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_TAG:
		tag, e := s.exactSourceTag(ctx, base, token, selection.Name)
		if e != nil {
			return nil, e
		}
		if tag.Commit.SHA != selection.CommitId || tag.ID != selection.GetTagObjectId() {
			return nil, errPullSnapshotChanged
		}
	}
	return selection, nil
}
func (s *Server) ResolveRepositorySource(ctx context.Context, req *connect.Request[golfv1.ResolveRepositorySourceRequest]) (*connect.Response[golfv1.ResolveRepositorySourceResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	m := req.Msg
	id, err := discussionID(m.RepositoryId)
	if err != nil {
		return nil, rpcError(err)
	}
	var boundaries []sourceSuffixBoundary
	if m.Suffix != "" {
		if m.Selector != nil || m.Path != "" {
			return nil, rpcError(invalid("Readable suffix selection cannot include a typed selector or separate path."))
		}
		boundaries, err = sourceSuffixBoundaries(m.Suffix)
		if err != nil {
			return nil, rpcError(err)
		}
	} else {
		if err = validateSourceSelector(m.Selector); err != nil {
			return nil, rpcError(err)
		}
		if !validSourcePath(m.Path) {
			return nil, rpcError(invalid("Select a literal relative source path."))
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var result *golfv1.ResolveRepositorySourceResponse
	err = s.withRepositoryRead(ctx, s.cookieValue(req.Header()), token, keyFrom(m.Repository), func(base string, repo Repository) error {
		if repo.ID != id {
			return errIssueTargetChanged
		}
		owner, _, ok := strings.Cut(repo.FullName, "/")
		if !ok {
			return errInvalidForgeResponse
		}
		result = &golfv1.ResolveRepositorySourceResponse{RepositoryId: strconv.FormatInt(repo.ID, 10), Repository: &golfv1.RepositoryKey{Owner: owner, Name: repo.Name}, Resolution: golfv1.RepositorySourceResolution_REPOSITORY_SOURCE_RESOLUTION_RESOLVED}
		if m.Suffix != "" {
			candidates, e := s.resolveSourceSuffix(ctx, base, repo, token, boundaries)
			if e != nil {
				return e
			}
			result.Suffix, result.Candidates = m.Suffix, candidates
			if len(candidates) == 1 {
				result.Selection, result.Path = candidates[0].Selection, candidates[0].Path
			} else if len(candidates) > 1 {
				result.Resolution = golfv1.RepositorySourceResolution_REPOSITORY_SOURCE_RESOLUTION_AMBIGUOUS
			} else {
				// Recheck current repository/caller authority even for zero matches.
				// A private denial must not become namespace absence.
				result.Resolution = golfv1.RepositorySourceResolution_REPOSITORY_SOURCE_RESOLUTION_UNSPECIFIED
			}
			return nil
		}
		selection, e := s.sourceSelection(ctx, base, repo, token, m.Selector)
		if e != nil {
			return e
		}
		result.Selection, result.Path = selection, m.Path
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	if m.Suffix != "" && len(result.Candidates) == 0 {
		return nil, rpcError(errResourceNotFound)
	}
	return connect.NewResponse(result), nil
}
func (s *Server) legacySourceSelection(ctx context.Context, base string, repo Repository, token forgeCredential, ref string) (string, error) {
	if ref == "" {
		selection, err := s.sourceSelection(ctx, base, repo, token, &golfv1.RepositorySourceSelector{Kind: golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_DEFAULT_BRANCH})
		if err != nil {
			return "", err
		}
		return selection.CommitId, nil
	}
	if objectID.MatchString(ref) {
		if err := s.exactSourceCommit(ctx, base, token, ref); err != nil {
			return "", err
		}
		return ref, nil
	}
	branch, be := s.exactSourceBranch(ctx, base, token, ref)
	tag, te := s.exactSourceTag(ctx, base, token, ref)
	if be != nil && !sourceNotFound(be) {
		return "", be
	}
	if te != nil && !sourceNotFound(te) {
		return "", te
	}
	if be == nil && te == nil {
		return "", invalid("This ref exists as both branch and tag. Select its type explicitly.")
	}
	selector := &golfv1.RepositorySourceSelector{Name: ref}
	if be == nil {
		selector.Kind = golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_BRANCH
	} else if te == nil {
		selector.Kind = golfv1.RepositorySourceRefKind_REPOSITORY_SOURCE_REF_KIND_TAG
	} else {
		return "", errResourceNotFound
	}
	selected, err := s.sourceSelection(ctx, base, repo, token, selector)
	if err != nil {
		return "", err
	}
	if be == nil && selected.CommitId != branch || te == nil && (selected.CommitId != tag.Commit.SHA || selected.GetTagObjectId() != tag.ID) {
		return "", errPullSnapshotChanged
	}
	return selected.CommitId, nil
}
func (s *Server) getBoundContents(ctx context.Context, session string, token forgeCredential, key repositoryKey, id int64, ref, requestedPath string, includeLatestChanges bool) (sourceResult, error) {
	if !validRef(ref) || !validSourcePath(requestedPath) || id < 0 || id > 0 && !objectID.MatchString(ref) || includeLatestChanges && id == 0 {
		return sourceResult{}, invalid("Exact source reads require a positive repository ID, full lowercase commit ID and literal path.")
	}
	var result sourceResult
	err := s.withRepositoryRead(ctx, session, token, key, func(base string, repo Repository) error {
		if id > 0 && repo.ID != id {
			return errIssueTargetChanged
		}
		sha := ref
		var err error
		if id == 0 {
			sha, err = s.legacySourceSelection(ctx, base, repo, token, ref)
		} else {
			err = s.exactSourceCommit(ctx, base, token, sha)
		}
		if err != nil {
			return err
		}
		result, err = s.readContentsAtCommit(ctx, base, token, sha, requestedPath)
		result.RepositoryID = repo.ID
		if err == nil && includeLatestChanges && result.Kind == "dir" && len(result.Entries) > 0 {
			err = s.projectHeadChanges(ctx, base, token, sha, result.Entries)
		}
		return err
	})
	return result, err
}
