package server

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

var errOrganizationCreationPolicyConflict = errors.New("organization creation policy changed")

func organizationCreationMode(mode golfv1.OrganizationCreationMode) string {
	switch mode {
	case golfv1.OrganizationCreationMode_ORGANIZATION_CREATION_MODE_ADMINISTRATORS_ONLY:
		return "administrators_only"
	case golfv1.OrganizationCreationMode_ORGANIZATION_CREATION_MODE_SELECTED_USERS:
		return "selected_users"
	case golfv1.OrganizationCreationMode_ORGANIZATION_CREATION_MODE_ALL_USERS:
		return "all_users"
	}
	return ""
}
func organizationCreationWireMode(mode string) golfv1.OrganizationCreationMode {
	switch mode {
	case "all_users":
		return golfv1.OrganizationCreationMode_ORGANIZATION_CREATION_MODE_ALL_USERS
	case "selected_users":
		return golfv1.OrganizationCreationMode_ORGANIZATION_CREATION_MODE_SELECTED_USERS
	}
	return golfv1.OrganizationCreationMode_ORGANIZATION_CREATION_MODE_ADMINISTRATORS_ONLY
}
func organizationCreationPermits(mode string, selected []int64, isAdmin bool, userID int64) bool {
	if userID <= 0 || (mode != "administrators_only" && mode != "selected_users" && mode != "all_users") {
		return false
	}
	if isAdmin {
		return true
	}
	if mode == "all_users" {
		return true
	}
	if mode == "selected_users" {
		for _, id := range selected {
			if id == userID {
				return true
			}
		}
	}
	return false
}
func (s *Server) organizationCreationPolicy(ctx context.Context, q *database.Queries, actor database.LockManagedSessionRow, hash []byte) (*golfv1.OrganizationCreationPolicy, error) {
	row, err := q.LockOrganizationCreationPolicy(ctx, s.config.ForgeURL)
	missing := errors.Is(err, sql.ErrNoRows)
	if missing {
		row = database.GolfOrganizationCreationPolicy{ForgeURL: s.config.ForgeURL, Mode: "administrators_only"}
	} else if err != nil {
		return nil, errStorageUnavailable
	}
	var selected []int64
	if !missing {
		selected, err = q.ListOrganizationCreationSelections(ctx, s.config.ForgeURL)
		if err != nil {
			return nil, errStorageUnavailable
		}
	}
	admin := false
	if actor.CredentialKind == "local" {
		_, err = q.GetAdminPasswordConfirmation(ctx, database.GetAdminPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.ForgeURL})
		if err == nil {
			admin = true
		} else if !errors.Is(err, sql.ErrNoRows) {
			return nil, errStorageUnavailable
		}
	}
	result := &golfv1.OrganizationCreationPolicy{Mode: organizationCreationWireMode(row.Mode), Revision: strconv.FormatInt(row.Revision, 10), RevocationEpoch: strconv.FormatInt(row.RevocationEpoch, 10), CanEdit: admin, CanCreate: organizationCreationPermits(row.Mode, selected, admin, actor.UserID), EnforcementScope: "Golf API", NativeAuthorityKnown: false}
	if admin {
		for _, id := range selected {
			result.SelectedGolfUserIds = append(result.SelectedGolfUserIds, strconv.FormatInt(id, 10))
		}
	}
	return result, nil
}
func (s *Server) readOrganizationCreationPolicy(ctx context.Context, value string, token forgeCredential) (*golfv1.OrganizationCreationPolicy, error) {
	var policy *golfv1.OrganizationCreationPolicy
	err := s.withManagedSession(ctx, value, token, func(q *database.Queries, actor database.LockManagedSessionRow, hash []byte) error {
		var err error
		policy, err = s.organizationCreationPolicy(ctx, q, actor, hash)
		return err
	})
	return policy, err
}
func (s *Server) GetOrganizationCreationPolicy(ctx context.Context, req *connect.Request[golfv1.GetOrganizationCreationPolicyRequest]) (*connect.Response[golfv1.GetOrganizationCreationPolicyResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	value := s.cookieValue(req.Header())
	var policy *golfv1.OrganizationCreationPolicy
	err = s.withForgeCaller(ctx, value, token, func(User) error {
		var err error
		policy, err = s.readOrganizationCreationPolicy(ctx, value, token)
		return err
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.GetOrganizationCreationPolicyResponse{Policy: policy}), nil
}
func (s *Server) UpdateOrganizationCreationPolicy(ctx context.Context, req *connect.Request[golfv1.UpdateOrganizationCreationPolicyRequest]) (*connect.Response[golfv1.UpdateOrganizationCreationPolicyResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	value := s.cookieValue(req.Header())
	if err = s.requireInstanceAdmin(ctx, value, token); err != nil {
		return nil, err
	}
	m := req.Msg
	mode := organizationCreationMode(m.Mode)
	expected, err := strconv.ParseInt(m.ExpectedRevision, 10, 64)
	if err != nil || expected < 0 || strconv.FormatInt(expected, 10) != m.ExpectedRevision || mode == "" || len(m.SelectedGolfUserIds) > 100 || mode != "selected_users" && len(m.SelectedGolfUserIds) > 0 {
		return nil, rpcError(invalid("Provide a current revision, supported mode and up to 100 selected user IDs."))
	}
	selected := map[int64]bool{}
	for _, raw := range m.SelectedGolfUserIds {
		id, err := discussionID(raw)
		if err != nil || selected[id] {
			return nil, rpcError(invalid("Selected Golf user IDs must be unique canonical identifiers."))
		}
		selected[id] = true
	}
	var result *golfv1.OrganizationCreationPolicy
	err = s.withManagedSession(ctx, value, token, func(q *database.Queries, actor database.LockManagedSessionRow, hash []byte) error {
		if _, err := q.GetAdminPasswordConfirmation(ctx, database.GetAdminPasswordConfirmationParams{TokenHash: hash, ForgeURL: s.config.ForgeURL}); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return errUnauthenticated
			}
			return errStorageUnavailable
		}
		if err := q.EnsureOrganizationCreationPolicy(ctx, s.config.ForgeURL); err != nil {
			return errStorageUnavailable
		}
		current, err := q.LockOrganizationCreationPolicy(ctx, s.config.ForgeURL)
		if err != nil {
			return errStorageUnavailable
		}
		if current.Revision != expected {
			return errOrganizationCreationPolicyConflict
		}
		for id := range selected {
			if _, err := q.GetOrganizationCreationCandidate(ctx, database.GetOrganizationCreationCandidateParams{ID: id, ForgeURL: s.config.ForgeURL}); err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					return invalid("Selected user IDs must belong to this Golf forge.")
				}
				return errStorageUnavailable
			}
		}
		updated, err := q.UpdateOrganizationCreationPolicy(ctx, database.UpdateOrganizationCreationPolicyParams{ForgeURL: s.config.ForgeURL, Mode: mode, Revision: expected})
		if err != nil {
			return errStorageUnavailable
		}
		if err = q.DeleteOrganizationCreationSelections(ctx, s.config.ForgeURL); err != nil {
			return errStorageUnavailable
		}
		for id := range selected {
			if err = q.AddOrganizationCreationSelection(ctx, database.AddOrganizationCreationSelectionParams{ForgeURL: s.config.ForgeURL, UserID: id}); err != nil {
				return errStorageUnavailable
			}
		}
		if err = q.AppendOrganizationCreationPolicyEvent(ctx, database.AppendOrganizationCreationPolicyEventParams{ForgeURL: s.config.ForgeURL, Revision: updated.Revision, RevocationEpoch: updated.RevocationEpoch, ActorUserID: actor.UserID, ActorSessionID: actor.SessionID, Mode: mode, SelectedUserCount: int32(len(selected))}); err != nil {
			return errStorageUnavailable
		}
		result, err = s.organizationCreationPolicy(ctx, q, actor, hash)
		return err
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.UpdateOrganizationCreationPolicyResponse{Policy: result}), nil
}
func (s *Server) CreateOrganization(ctx context.Context, req *connect.Request[golfv1.CreateOrganizationRequest]) (*connect.Response[golfv1.CreateOrganizationResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	m := req.Msg
	value := s.cookieValue(req.Header())
	expected, err := strconv.ParseInt(m.ExpectedPolicyRevision, 10, 64)
	if err != nil || expected < 0 || strconv.FormatInt(expected, 10) != m.ExpectedPolicyRevision || !validOrganizationName(m.Username) || len(m.Username) > 40 || !discussionText(m.FullName, 100) || !discussionText(m.Description, 255) || (m.Visibility != "private" && m.Visibility != "limited" && m.Visibility != "public") {
		return nil, rpcError(invalid("Provide a valid organization name, metadata, visibility and current policy revision."))
	}
	result := &golfv1.CreateOrganizationResponse{}
	err = s.withForgeCaller(ctx, value, token, func(caller User) error {
		check := func() error {
			policy, err := s.readOrganizationCreationPolicy(ctx, value, token)
			if err != nil {
				return err
			}
			if !policy.CanCreate {
				return forgeError{http.StatusForbidden}
			}
			if policy.Revision != m.ExpectedPolicyRevision {
				return errOrganizationCreationPolicyConflict
			}
			return nil
		}
		if err := check(); err != nil {
			return err
		}
		// Recheck native identity and Golf eligibility immediately before one POST.
		fresh, err := s.currentUser(ctx, token)
		if err != nil {
			return err
		}
		if fresh.ID != caller.ID {
			return errUnauthenticated
		}
		if err = check(); err != nil {
			return err
		}
		var receipt forgeOrganization
		_, err = s.forgeJSON(ctx, http.MethodPost, "/orgs", token, map[string]any{"username": m.Username, "full_name": m.FullName, "description": m.Description, "visibility": m.Visibility, "repo_admin_change_team_access": false}, &receipt, http.StatusCreated)
		if err != nil {
			return err
		}
		if !validOrganization(receipt) || !strings.EqualFold(receipt.Name, m.Username) || receipt.FullName != m.FullName || receipt.Description != m.Description || receipt.Visibility != m.Visibility {
			return errInvalidForgeResponse
		}
		var observed forgeOrganization
		if _, err = s.forgeJSON(ctx, http.MethodGet, "/orgs/"+receipt.Name, token, nil, &observed, http.StatusOK); err != nil {
			return err
		}
		if observed.ID != receipt.ID || !validOrganization(observed) || observed.Name != receipt.Name || observed.FullName != m.FullName || observed.Description != m.Description || observed.Visibility != m.Visibility {
			return errInvalidForgeResponse
		}
		owner, err := s.organizationOwner(ctx, token, observed, caller)
		if err != nil {
			return err
		}
		if !owner {
			return errInvalidForgeResponse
		}
		if err = check(); err != nil {
			return err
		}
		result.Organization = wireOrganization(observed)
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
