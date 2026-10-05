package server

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// No native attachment URL/UUID is decoded or exposed. These are current
// metadata observations, not a commit snapshot or permission to download.
type forgeReleaseAsset struct {
	ID            int64  `json:"id"`
	Name          string `json:"name"`
	Size          *int64 `json:"size"`
	DownloadCount *int64 `json:"download_count"`
	CreatedAt     string `json:"created_at"`
}
type forgeRepositoryRelease struct {
	ID              int64               `json:"id"`
	Title           string              `json:"name"`
	TagName         string              `json:"tag_name"`
	TargetCommitish string              `json:"target_commitish"`
	Body            string              `json:"body"`
	Draft           *bool               `json:"draft"`
	Prerelease      *bool               `json:"prerelease"`
	CreatedAt       string              `json:"created_at"`
	PublishedAt     string              `json:"published_at"`
	Author          *User               `json:"author"`
	Assets          []forgeReleaseAsset `json:"assets"`
}

func wireRepositoryRelease(row forgeRepositoryRelease) (*golfv1.RepositoryRelease, error) {
	if row.ID <= 0 || !profileText(row.Title, 1024, false) || row.TagName == "" || !validRef(row.TagName) || len(row.TagName) > 1024 || !profileText(row.TargetCommitish, 4096, false) || !discussionText(row.Body, 128<<10) || row.Draft == nil || row.Prerelease == nil || !validRuleTime(row.CreatedAt) || !validRuleTime(row.PublishedAt) || !validPullUser(row.Author) || row.Assets == nil || len(row.Assets) > 100 {
		return nil, errInvalidForgeResponse
	}
	if row.Author != nil && (!profileText(row.Author.FullName, 1024, false) || !profileText(row.Author.AvatarURL, 4096, false)) {
		return nil, errInvalidForgeResponse
	}
	result := &golfv1.RepositoryRelease{Id: strconv.FormatInt(row.ID, 10), Title: row.Title, TagName: row.TagName, TargetCommitish: row.TargetCommitish, BodyMarkdown: row.Body, Draft: *row.Draft, Prerelease: *row.Prerelease, CreatedAt: row.CreatedAt, PublishedAt: row.PublishedAt, Author: wirePullUser(row.Author), Assets: []*golfv1.RepositoryReleaseAsset{}, AssetCount: strconv.Itoa(len(row.Assets)), Revision: releaseRevision(row)}
	seen := map[int64]bool{}
	for _, asset := range row.Assets {
		if asset.ID <= 0 || seen[asset.ID] || asset.Name == "" || !profileText(asset.Name, 1024, false) || asset.Size == nil || *asset.Size < 0 || asset.DownloadCount == nil || *asset.DownloadCount < 0 || !validRuleTime(asset.CreatedAt) {
			return nil, errInvalidForgeResponse
		}
		seen[asset.ID] = true
		result.Assets = append(result.Assets, &golfv1.RepositoryReleaseAsset{Id: strconv.FormatInt(asset.ID, 10), Name: asset.Name, SizeBytes: strconv.FormatInt(*asset.Size, 10), DownloadCount: strconv.FormatInt(*asset.DownloadCount, 10), CreatedAt: asset.CreatedAt})
	}
	return result, nil
}

// A native count and rows are independently read. Refuse inconsistent or
// incomplete pages rather than silently claiming a complete inventory.
func repositoryReleasePage(rows []forgeRepositoryRelease, headers http.Header, page, limit uint32) ([]*golfv1.RepositoryRelease, string, uint32, error) {
	values := headers.Values("X-Total-Count")
	if rows == nil || len(values) != 1 || page == 0 || limit == 0 || limit > 50 {
		return nil, "", 0, errInvalidForgeResponse
	}
	total, err := strconv.ParseUint(values[0], 10, 63)
	if err != nil || strconv.FormatUint(total, 10) != values[0] {
		return nil, "", 0, errInvalidForgeResponse
	}
	offset := uint64(page-1) * uint64(limit)
	expected := uint64(0)
	if offset < total {
		expected = min(uint64(limit), total-offset)
	}
	if uint64(len(rows)) != expected {
		return nil, "", 0, errInvalidForgeResponse
	}
	result := make([]*golfv1.RepositoryRelease, 0, len(rows))
	seen := map[int64]bool{}
	assets := map[string]bool{}
	notes := 0
	for _, row := range rows {
		if seen[row.ID] {
			return nil, "", 0, errInvalidForgeResponse
		}
		seen[row.ID] = true
		release, err := wireRepositoryRelease(row)
		if err != nil {
			return nil, "", 0, err
		}
		notes += len(row.Body)
		if notes > 512<<10 || len(assets)+len(release.Assets) > 500 {
			return nil, "", 0, errForgeResponseTooLarge
		}
		for _, asset := range release.Assets {
			if assets[asset.Id] {
				return nil, "", 0, errInvalidForgeResponse
			}
			assets[asset.Id] = true
		}
		result = append(result, release)
	}
	next := uint32(0)
	if offset+uint64(len(rows)) < total {
		if page >= 10000 {
			return nil, "", 0, errForgeResponseTooLarge
		}
		next = page + 1
	}
	return result, values[0], next, nil
}

func releaseRepositoryKey(repo Repository) *golfv1.RepositoryKey {
	owner, name, _ := strings.Cut(repo.FullName, "/")
	return &golfv1.RepositoryKey{Owner: owner, Name: name}
}
func (s *Server) ListRepositoryReleases(ctx context.Context, req *connect.Request[golfv1.ListRepositoryReleasesRequest]) (*connect.Response[golfv1.ListRepositoryReleasesResponse], error) {
	id, err := discussionID(req.Msg.RepositoryId)
	if err != nil {
		return nil, rpcError(err)
	}
	key := keyFrom(req.Msg.Repository)
	if _, err = repositoryPath(key); err != nil {
		return nil, rpcError(err)
	}
	page, limit, err := pagination(pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	if limit > 50 {
		return nil, rpcError(invalid("Release page size must be at most 50."))
	}
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var result *golfv1.ListRepositoryReleasesResponse
	err = s.withRepositoryRead(ctx, s.cookieValue(req.Header()), token, key, func(base string, repo Repository) error {
		if repo.ID != id {
			return errIssueTargetChanged
		}
		return s.withNativePageSize(ctx, token, limit, func(effective uint32) error {
			var rows []forgeRepositoryRelease
			headers, err := s.forge(ctx, http.MethodGet, base+"/releases?"+pageQuery(page, effective).Encode(), token, nil, &rows)
			if err != nil {
				return err
			}
			releases, total, next, err := repositoryReleasePage(rows, headers, page, effective)
			if err != nil {
				return err
			}
			result = &golfv1.ListRepositoryReleasesResponse{Repository: releaseRepositoryKey(repo), RepositoryId: strconv.FormatInt(repo.ID, 10), Releases: releases, Page: &golfv1.PageResponse{NextPage: next}, TotalCount: total}
			return nil
		})
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
func (s *Server) GetRepositoryRelease(ctx context.Context, req *connect.Request[golfv1.GetRepositoryReleaseRequest]) (*connect.Response[golfv1.GetRepositoryReleaseResponse], error) {
	id, err := discussionID(req.Msg.RepositoryId)
	if err != nil {
		return nil, rpcError(err)
	}
	releaseID, err := discussionID(req.Msg.ReleaseId)
	if err != nil {
		return nil, rpcError(err)
	}
	key := keyFrom(req.Msg.Repository)
	if _, err = repositoryPath(key); err != nil {
		return nil, rpcError(err)
	}
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var result *golfv1.GetRepositoryReleaseResponse
	err = s.withRepositoryRead(ctx, s.cookieValue(req.Header()), token, key, func(base string, repo Repository) error {
		if repo.ID != id {
			return errIssueTargetChanged
		}
		var row forgeRepositoryRelease
		if _, err := s.forge(ctx, http.MethodGet, base+"/releases/"+strconv.FormatInt(releaseID, 10), token, nil, &row); err != nil {
			return err
		}
		if row.ID != releaseID {
			return errInvalidForgeResponse
		}
		release, err := wireRepositoryRelease(row)
		if err != nil {
			return err
		}
		result = &golfv1.GetRepositoryReleaseResponse{Repository: releaseRepositoryKey(repo), RepositoryId: strconv.FormatInt(repo.ID, 10), Release: release}
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
