package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

var errRepositorySettingsConflict = errors.New("repository settings changed")

// General native repository features only. CI, visibility, protection and merge
// authority are deliberately absent from this projection and PATCH allowlist.
type forgeRepositorySettings struct {
	Repository
	Owner       *User `json:"owner"`
	Permissions *struct {
		Admin bool `json:"admin"`
	} `json:"permissions"`
	Website         string                `json:"website"`
	Topics          *[]string             `json:"topics"`
	InternalTracker *forgeInternalTracker `json:"internal_tracker"`
	ExternalTracker *forgeExternalTracker `json:"external_tracker"`
	ExternalWiki    *forgeExternalWiki    `json:"external_wiki"`
	HasIssues       *bool                 `json:"has_issues"`
	HasWiki         *bool                 `json:"has_wiki"`
	HasPullRequests *bool                 `json:"has_pull_requests"`
	Archived        *bool                 `json:"archived"`
	Mirror          *bool                 `json:"mirror"`
}

func wireRepositorySettings(row forgeRepositorySettings, key repositoryKey) (*golfv1.RepositorySettings, error) {
	if !validRepository(row.Repository) || !strings.EqualFold(row.FullName, key.Owner+"/"+key.Name) || !strings.EqualFold(row.Name, key.Name) ||
		row.Owner == nil || row.Owner.ID <= 0 || !strings.EqualFold(row.Owner.Login, key.Owner) || row.Permissions == nil ||
		row.HasIssues == nil || row.HasWiki == nil || row.HasPullRequests == nil || row.Archived == nil || row.Mirror == nil ||
		!discussionText(row.Description, 2048) || row.DefaultBranch == "" || !validRef(row.DefaultBranch) {
		return nil, errInvalidForgeResponse
	}
	settings := &golfv1.RepositorySettings{RepositoryId: strconv.FormatInt(row.ID, 10), OwnerId: strconv.FormatInt(row.Owner.ID, 10), Description: row.Description, DefaultBranch: row.DefaultBranch,
		HasIssues: *row.HasIssues, HasWiki: *row.HasWiki, HasPullRequests: *row.HasPullRequests, CanEdit: row.Permissions.Admin && !*row.Archived && !*row.Mirror}
	if err := projectGeneralSettings(row, settings); err != nil {
		return nil, err
	}
	// This detects stale forms before dispatch; Gitea PATCH does not provide a
	// qualified atomic compare-and-swap. Never use this hash as a security lock.
	data, _ := json.Marshal(struct {
		ID, OwnerID                                  int64
		Name, Description, DefaultBranch             string
		Issues, Wiki, PullRequests, Archived, Mirror bool
	}{
		row.ID, row.Owner.ID, strings.ToLower(row.FullName), row.Description, row.DefaultBranch, *row.HasIssues, *row.HasWiki, *row.HasPullRequests, *row.Archived, *row.Mirror})
	data = append(data, generalRevisionData(row)...)
	digest := sha256.Sum256(data)
	settings.Revision = hex.EncodeToString(digest[:])
	return settings, nil
}

func (s *Server) readRepositorySettings(ctx context.Context, token forgeCredential, key repositoryKey) (forgeRepositorySettings, *golfv1.RepositorySettings, error) {
	var row forgeRepositorySettings
	base, err := repositoryPath(key)
	if err != nil {
		return row, nil, err
	}
	_, err = s.forge(ctx, http.MethodGet, base, token, nil, &row)
	if err != nil {
		return row, nil, err
	}
	settings, err := wireRepositorySettings(row, key)
	return row, settings, err
}

func (s *Server) GetRepositorySettings(ctx context.Context, req *connect.Request[golfv1.GetRepositorySettingsRequest]) (*connect.Response[golfv1.GetRepositorySettingsResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	key := keyFrom(req.Msg.Repository)
	if req.Msg.RepositoryId != "" {
		if _, err := discussionID(req.Msg.RepositoryId); err != nil {
			return nil, rpcError(invalid("Provide the current canonical repository identity."))
		}
	}
	if _, err := repositoryPath(key); err != nil {
		return nil, rpcError(err)
	}
	result := &golfv1.GetRepositorySettingsResponse{}
	err = s.withForgeCaller(ctx, s.cookieValue(req.Header()), token, func(User) error {
		_, settings, err := s.readRepositorySettings(ctx, token, key)
		if err != nil {
			return err
		}
		if req.Msg.RepositoryId != "" && settings.RepositoryId != req.Msg.RepositoryId {
			return errRepositorySettingsConflict
		}
		result.Settings = settings
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}

func repositorySettingsPatch(req *golfv1.UpdateRepositorySettingsRequest) (map[string]any, error) {
	if _, err := discussionID(req.RepositoryId); err != nil {
		return nil, invalid("Expected repository and owner IDs must be canonical positive decimal identifiers.")
	}
	if _, err := discussionID(req.OwnerId); err != nil {
		return nil, invalid("Expected repository and owner IDs must be canonical positive decimal identifiers.")
	}
	digest, err := hex.DecodeString(req.ExpectedRevision)
	if err != nil || len(digest) != sha256.Size || hex.EncodeToString(digest) != req.ExpectedRevision {
		return nil, invalid("Provide the current repository settings revision.")
	}
	patch := map[string]any{}
	if req.Description != nil {
		if !discussionText(*req.Description, 2048) {
			return nil, invalid("Description must be UTF-8 text of at most 2048 bytes without unsupported control characters.")
		}
		patch["description"] = *req.Description
	}
	if req.DefaultBranch != nil {
		if *req.DefaultBranch == "" || !validRef(*req.DefaultBranch) {
			return nil, invalid("Default branch must be a valid existing branch name.")
		}
		patch["default_branch"] = *req.DefaultBranch
	}
	if req.HasIssues != nil {
		patch["has_issues"] = *req.HasIssues
	}
	if req.HasWiki != nil {
		patch["has_wiki"] = *req.HasWiki
	}
	if req.HasPullRequests != nil {
		patch["has_pull_requests"] = *req.HasPullRequests
	}
	if err := generalFeaturePatch(req, patch); err != nil {
		return nil, err
	}
	if len(patch) == 0 {
		return nil, invalid("Choose at least one repository setting to change.")
	}
	return patch, nil
}

func settingsMatchUpdate(settings *golfv1.RepositorySettings, req *golfv1.UpdateRepositorySettingsRequest) bool {
	return settings.RepositoryId == req.RepositoryId && settings.OwnerId == req.OwnerId && settings.CanEdit &&
		(req.Description == nil || settings.Description == *req.Description) && (req.DefaultBranch == nil || settings.DefaultBranch == *req.DefaultBranch) &&
		(req.HasIssues == nil || settings.HasIssues == *req.HasIssues) && (req.HasWiki == nil || settings.HasWiki == *req.HasWiki) &&
		(req.HasPullRequests == nil || settings.HasPullRequests == *req.HasPullRequests) && generalSettingsMatch(settings, req)
}

func (s *Server) UpdateRepositorySettings(ctx context.Context, req *connect.Request[golfv1.UpdateRepositorySettingsRequest]) (*connect.Response[golfv1.UpdateRepositorySettingsResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	key := keyFrom(req.Msg.Repository)
	base, err := repositoryPath(key)
	if err != nil {
		return nil, rpcError(err)
	}
	patch, err := repositorySettingsPatch(req.Msg)
	if err != nil {
		return nil, rpcError(err)
	}
	result := &golfv1.UpdateRepositorySettingsResponse{}
	value := s.cookieValue(req.Header())
	err = s.withForgeCaller(ctx, value, token, func(caller User) error {
		_, before, err := s.readRepositorySettings(ctx, token, key)
		if err != nil {
			return err
		}
		if !before.CanEdit {
			return forgeError{http.StatusForbidden}
		}
		if before.RepositoryId != req.Msg.RepositoryId || before.OwnerId != req.Msg.OwnerId || before.Revision != req.Msg.ExpectedRevision {
			return errRepositorySettingsConflict
		}
		if req.Msg.DefaultBranch != nil && *req.Msg.DefaultBranch != before.DefaultBranch {
			if _, err := s.exactSourceBranch(ctx, base, token, *req.Msg.DefaultBranch); err != nil {
				return err
			}
		}
		// Legacy enabling must never silently replace an external unit.
		if req.Msg.HasIssues != nil && *req.Msg.HasIssues && before.IssuesMode == golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_EXTERNAL {
			return invalid("Use an explicit issues mode to change external tracker configuration.")
		}
		if req.Msg.HasWiki != nil && *req.Msg.HasWiki && before.WikiMode == golfv1.RepositoryFeatureMode_REPOSITORY_FEATURE_MODE_EXTERNAL {
			return invalid("Use an explicit wiki mode to change external wiki configuration.")
		}
		// Re-read native administration and local authority after branch/provider waits.
		_, current, err := s.readRepositorySettings(ctx, token, key)
		if err != nil {
			return err
		}
		if !current.CanEdit {
			return forgeError{http.StatusForbidden}
		}
		if current.Revision != before.Revision || current.RepositoryId != before.RepositoryId || current.OwnerId != before.OwnerId {
			return errRepositorySettingsConflict
		}
		if _, err := s.localSessionUser(ctx, value, caller); err != nil {
			return err
		}
		var receipt forgeRepositorySettings
		_, err = s.forgeJSON(ctx, http.MethodPatch, base, token, patch, &receipt, http.StatusOK)
		if err != nil {
			return err
		}
		received, err := wireRepositorySettings(receipt, key)
		if err != nil || !settingsMatchUpdate(received, req.Msg) {
			return errInvalidForgeResponse
		}
		_, observed, err := s.readRepositorySettings(ctx, token, key)
		if err != nil {
			return err
		}
		if !settingsMatchUpdate(observed, req.Msg) || observed.Revision != received.Revision {
			return errInvalidForgeResponse
		}
		result.Settings = observed
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
