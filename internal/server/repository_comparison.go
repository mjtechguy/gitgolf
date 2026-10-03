package server

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"google.golang.org/protobuf/proto"
)

// Compare through the supported native API, with independent authority for
// both repositories and named-branch observations around both native reads.
// This never establishes mergeability, locks refs, or reserves a future write.
func (s *Server) GetRepositoryComparison(ctx context.Context, req *connect.Request[golfv1.GetRepositoryComparisonRequest]) (*connect.Response[golfv1.GetRepositoryComparisonResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	selected := req.Msg.GetSelection()
	target, source := keyFrom(selected.GetRepository()), keyFrom(selected.GetSourceRepository())
	targetID, err := discussionID(selected.GetRepositoryId())
	if err != nil {
		return nil, rpcError(err)
	}
	sourceID, err := discussionID(selected.GetSourceRepositoryId())
	if err != nil {
		return nil, rpcError(err)
	}
	baseID, headID := selected.GetBaseCommitId(), selected.GetHeadCommitId()
	if !objectID.MatchString(baseID) || !objectID.MatchString(headID) || len(baseID) != len(headID) || selected.BaseBranch == "" || selected.HeadBranch == "" || !validRef(selected.BaseBranch) || !validRef(selected.HeadBranch) || strings.HasPrefix(selected.BaseBranch, "refs/") || strings.HasPrefix(selected.HeadBranch, "refs/") {
		return nil, rpcError(invalid("Select existing named branches and their full lowercase commit IDs."))
	}
	session := s.cookieValue(req.Header())
	input := issueMutationInput{Owner: target.Owner, Repository: target.Name, RepositoryID: targetID, SourceOwner: source.Owner, SourceRepository: source.Name, SourceRepositoryID: sourceID, BaseBranch: selected.BaseBranch, HeadBranch: selected.HeadBranch, BaseCommitID: baseID, HeadCommitID: headID}
	result := &golfv1.GetRepositoryComparisonResponse{Selection: proto.Clone(selected).(*golfv1.RepositoryComparisonSelection)}
	err = s.withRepositoryRead(ctx, session, token, target, func(base string, repo Repository) error {
		if repo.ID != targetID {
			return errIssueTargetChanged
		}
		if repo.Empty {
			return errEmptyRepository
		}
		return s.withRepositoryRead(ctx, session, token, source, func(_ string, headRepo Repository) error {
			if headRepo.ID != sourceID {
				return errIssueTargetChanged
			}
			if headRepo.Empty {
				return errEmptyRepository
			}
			if err := s.observePullCreationBranches(ctx, session, token, input); err != nil {
				return err
			}
			head := headID
			if targetID != sourceID {
				head = source.Owner + "/" + source.Name + ":" + headID
			}
			path := base + "/compare/" + url.PathEscape(baseID+"..."+head)
			var comparison struct {
				Total   *int              `json:"total_commits"`
				Commits []forgePullCommit `json:"commits"`
			}
			if _, err := s.forge(ctx, http.MethodGet, path+"?files=false&verification=false", token, nil, &comparison); err != nil {
				return err
			}
			if len(comparison.Commits) > 500 {
				return errForgeResponseTooLarge
			}
			if comparison.Total == nil || comparison.Commits == nil || *comparison.Total != len(comparison.Commits) {
				return errInvalidForgeResponse
			}
			seen := map[string]bool{}
			for _, row := range comparison.Commits {
				if !objectID.MatchString(row.SHA) || len(row.SHA) != len(headID) || seen[row.SHA] || !validCommitURL(row.HTMLURL, headRepo.HTMLURL, row.SHA) || !validPullTime(row.Commit.Author.Date) || !discussionText(row.Commit.Message, 256<<10) || !utf8.ValidString(row.Commit.Author.Name) || len(row.Commit.Author.Name) > 1024 || strings.IndexFunc(row.Commit.Author.Name, unicode.IsControl) >= 0 {
					return errInvalidForgeResponse
				}
				seen[row.SHA] = true
				result.Commits = append(result.Commits, &golfv1.Commit{Sha: row.SHA, Message: row.Commit.Message, AuthorName: row.Commit.Author.Name, AuthoredAt: row.Commit.Author.Date})
			}
			var err error
			result.RawDiff, err = s.readCommitDiff(ctx, path+"?output=diff", token)
			if err != nil {
				return err
			}
			result.ByteSize = uint32(len(result.RawDiff))
			return s.observePullCreationBranches(ctx, session, token, input)
		})
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
