package server

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/mjtechguy/golf-git/internal/server/database"
)

type forgeOrganization struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	FullName    string `json:"full_name"`
	Description string `json:"description"`
	Visibility  string `json:"visibility"`
}

type forgeOrganizationTeam struct {
	ID                      int64              `json:"id"`
	Name                    string             `json:"name"`
	Description             string             `json:"description"`
	Permission              string             `json:"permission"`
	UnitPermissions         map[string]string  `json:"units_map"`
	IncludesAllRepositories bool               `json:"includes_all_repositories"`
	Visibility              string             `json:"visibility"`
	Organization            *forgeOrganization `json:"organization"`
}

func validOrganizationName(name string) bool {
	return repositoryComponent.MatchString(name) && name != "." && name != ".."
}

func knownVisibility(value string) bool {
	return value == "public" || value == "limited" || value == "private"
}

func knownTeamPermission(value string) bool {
	switch value {
	case "none", "read", "write", "admin", "owner":
		return true
	}
	return false
}

func validOrganization(org forgeOrganization) bool {
	return org.ID > 0 && validOrganizationName(org.Name) && knownVisibility(org.Visibility)
}

func validOrganizationTeam(team forgeOrganizationTeam) bool {
	if team.ID <= 0 || strings.TrimSpace(team.Name) == "" || len(team.Name) > 255 || !knownTeamPermission(team.Permission) || !knownVisibility(team.Visibility) {
		return false
	}
	for unit, permission := range team.UnitPermissions {
		// This is the pinned provider's unit vocabulary, not a Golf role map.
		switch unit {
		case "repo.code", "repo.issues", "repo.ext_issues", "repo.pulls", "repo.releases", "repo.wiki", "repo.ext_wiki", "repo.projects", "repo.packages", "repo.actions":
		default:
			return false
		}
		if !knownTeamPermission(permission) {
			return false
		}
	}
	return true
}

func organizationTeamID(value string) (int64, error) {
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id <= 0 || strconv.FormatInt(id, 10) != value {
		return 0, invalid("Team ID must be a positive decimal identifier.")
	}
	return id, nil
}

func organizationNextPage(headers http.Header, page uint32) (uint32, error) {
	if page == 10000 && strings.Contains(headers.Get("Link"), `rel="next"`) {
		return 0, invalid("Organization browsing exceeds the 10000-page limit. Increase the page size before continuing.")
	}
	return nextPage(headers, page), nil
}

// No account/session lock is held across provider calls. Verify the immutable
// session identity, then recheck native identity and local revocation/expiry after the last provider
// wait before returning private membership data. OAuth refresh was resolved by
// the RPC boundary; never recursively refresh here.
func (s *Server) withForgeCaller(ctx context.Context, value string, credential forgeCredential, operation func(User) error) error {
	user, err := s.currentUser(ctx, credential)
	if err != nil {
		return err
	}
	if !validOrganizationName(user.Login) {
		return errInvalidForgeResponse
	}
	check := func() error {
		hash, err := s.authSessionHash(ctx, value, nil)
		if err != nil {
			return err
		}
		if s.db == nil {
			return errStorageUnavailable
		}
		row, err := database.New(s.db).GetSessionCredential(ctx, database.GetSessionCredentialParams{TokenHash: hash, ForgeURL: s.config.ForgeURL})
		if errors.Is(err, sql.ErrNoRows) {
			return errUnauthenticated
		}
		if err != nil {
			return errStorageUnavailable
		}
		if row.ForgeUserID != user.ID || !row.ExpiresAt.After(time.Now()) {
			return errUnauthenticated
		}
		return nil
	}
	if err := check(); err != nil {
		return err
	}
	if err := operation(user); err != nil {
		return err
	}
	latest, err := s.currentUser(ctx, credential)
	if err != nil {
		return err
	}
	if latest.ID != user.ID {
		return errUnauthenticated
	}
	return check()
}

// The general forge helper deliberately hides successful HTTP status codes.
// This membership proof specifically requires 204; a public organization GET,
// unexpected 200, redirect or site-admin visibility is not proof of membership.
func (s *Server) requireOrganizationMember(ctx context.Context, credential forgeCredential, org, login string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.config.ForgeURL+"/api/v1/orgs/"+org+"/members/"+login, nil)
	if err != nil {
		return errInvalidForgeResponse
	}
	scheme := "token"
	if credential.Kind == "oauth" {
		scheme = "Bearer"
	} else if credential.Kind != "pat" {
		return errCredentialUnavailable
	}
	request.Header.Set("Authorization", scheme+" "+credential.Token)
	request.Header.Set("Accept", "application/json")
	response, err := s.client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errForgeUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent {
		return nil
	}
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return errInvalidForgeResponse
	}
	return forgeError{response.StatusCode}
}

func (s *Server) withOrganization(ctx context.Context, value string, credential forgeCredential, name string, operation func(forgeOrganization) error) error {
	if !validOrganizationName(name) {
		return invalid("Organization must be a valid name component.")
	}
	return s.withForgeCaller(ctx, value, credential, func(user User) error {
		if err := s.requireOrganizationMember(ctx, credential, name, user.Login); err != nil {
			return err
		}
		var org forgeOrganization
		if _, err := s.forge(ctx, http.MethodGet, "/orgs/"+name, credential, nil, &org); err != nil {
			return err
		}
		if !validOrganization(org) || !strings.EqualFold(org.Name, name) {
			return errInvalidForgeResponse
		}
		if err := operation(org); err != nil {
			return err
		}
		// Public metadata routes can remain readable after membership is removed.
		// Recheck membership after the provider read as well as before it.
		return s.requireOrganizationMember(ctx, credential, org.Name, user.Login)
	})
}

func (s *Server) listOrganizations(ctx context.Context, value string, credential forgeCredential, paging pageRequest) ([]forgeOrganization, uint32, error) {
	page, limit, err := pagination(paging)
	if err != nil {
		return nil, 0, err
	}
	var rows []forgeOrganization
	var next uint32
	err = s.withForgeCaller(ctx, value, credential, func(User) error {
		headers, err := s.forge(ctx, http.MethodGet, "/user/orgs?"+pageQuery(page, limit).Encode(), credential, nil, &rows)
		if err != nil {
			return err
		}
		if len(rows) > int(limit) {
			return errForgeResponseTooLarge
		}
		seen := map[int64]bool{}
		for _, row := range rows {
			if !validOrganization(row) || seen[row.ID] {
				return errInvalidForgeResponse
			}
			seen[row.ID] = true
		}
		next, err = organizationNextPage(headers, page)
		return err
	})
	if err != nil {
		return nil, 0, err
	}
	return rows, next, nil
}

func (s *Server) getOrganization(ctx context.Context, value string, credential forgeCredential, name string) (forgeOrganization, error) {
	var result forgeOrganization
	err := s.withOrganization(ctx, value, credential, name, func(org forgeOrganization) error { result = org; return nil })
	return result, err
}

func (s *Server) listOrganizationTeams(ctx context.Context, value string, credential forgeCredential, name string, paging pageRequest) ([]forgeOrganizationTeam, uint32, error) {
	page, limit, err := pagination(paging)
	if err != nil {
		return nil, 0, err
	}
	var rows []forgeOrganizationTeam
	var next uint32
	err = s.withOrganization(ctx, value, credential, name, func(org forgeOrganization) error {
		headers, err := s.forge(ctx, http.MethodGet, "/orgs/"+org.Name+"/teams?"+pageQuery(page, limit).Encode(), credential, nil, &rows)
		if err != nil {
			return err
		}
		if len(rows) > int(limit) {
			return errForgeResponseTooLarge
		}
		seen := map[int64]bool{}
		for _, row := range rows {
			if !validOrganizationTeam(row) || seen[row.ID] || row.Organization != nil && row.Organization.ID != org.ID {
				return errInvalidForgeResponse
			}
			seen[row.ID] = true
		}
		next, err = organizationNextPage(headers, page)
		return err
	})
	if err != nil {
		return nil, 0, err
	}
	return rows, next, nil
}

func (s *Server) readOrganizationTeam(ctx context.Context, credential forgeCredential, org forgeOrganization, id int64) (forgeOrganizationTeam, error) {
	var team forgeOrganizationTeam
	if _, err := s.forge(ctx, http.MethodGet, "/teams/"+strconv.FormatInt(id, 10), credential, nil, &team); err != nil {
		return team, err
	}
	if !validOrganizationTeam(team) || team.ID != id || team.Organization == nil || !validOrganization(*team.Organization) {
		return team, errInvalidForgeResponse
	}
	if team.Organization.ID != org.ID || !strings.EqualFold(team.Organization.Name, org.Name) {
		return team, errResourceNotFound
	}
	return team, nil
}

func (s *Server) getOrganizationTeam(ctx context.Context, value string, credential forgeCredential, name, teamID string) (forgeOrganizationTeam, error) {
	id, err := organizationTeamID(teamID)
	if err != nil {
		return forgeOrganizationTeam{}, err
	}
	var result forgeOrganizationTeam
	err = s.withOrganization(ctx, value, credential, name, func(org forgeOrganization) error {
		var err error
		result, err = s.readOrganizationTeam(ctx, credential, org, id)
		return err
	})
	return result, err
}

func (s *Server) listOrganizationTeamMembers(ctx context.Context, value string, credential forgeCredential, name, teamID string, paging pageRequest) ([]User, uint32, error) {
	id, err := organizationTeamID(teamID)
	if err != nil {
		return nil, 0, err
	}
	page, limit, err := pagination(paging)
	if err != nil {
		return nil, 0, err
	}
	var rows []User
	var next uint32
	err = s.withOrganization(ctx, value, credential, name, func(org forgeOrganization) error {
		if _, err := s.readOrganizationTeam(ctx, credential, org, id); err != nil {
			return err
		}
		headers, err := s.forge(ctx, http.MethodGet, "/teams/"+teamID+"/members?"+pageQuery(page, limit).Encode(), credential, nil, &rows)
		if err != nil {
			return err
		}
		if len(rows) > int(limit) {
			return errForgeResponseTooLarge
		}
		seen := map[int64]bool{}
		for _, row := range rows {
			if row.ID <= 0 || !validOrganizationName(row.Login) || seen[row.ID] {
				return errInvalidForgeResponse
			}
			seen[row.ID] = true
		}
		next, err = organizationNextPage(headers, page)
		return err
	})
	if err != nil {
		return nil, 0, err
	}
	return rows, next, nil
}

func (s *Server) listOrganizationTeamRepositories(ctx context.Context, value string, credential forgeCredential, name, teamID string, paging pageRequest) ([]Repository, uint32, error) {
	id, err := organizationTeamID(teamID)
	if err != nil {
		return nil, 0, err
	}
	page, limit, err := pagination(paging)
	if err != nil {
		return nil, 0, err
	}
	var rows []Repository
	var next uint32
	err = s.withOrganization(ctx, value, credential, name, func(org forgeOrganization) error {
		if _, err := s.readOrganizationTeam(ctx, credential, org, id); err != nil {
			return err
		}
		headers, err := s.forge(ctx, http.MethodGet, "/teams/"+teamID+"/repos?"+pageQuery(page, limit).Encode(), credential, nil, &rows)
		if err != nil {
			return err
		}
		if len(rows) > int(limit) {
			return errForgeResponseTooLarge
		}
		seen := map[int64]bool{}
		for _, row := range rows {
			if row.ID <= 0 || !validOrganizationName(row.Name) || !strings.EqualFold(row.FullName, org.Name+"/"+row.Name) || seen[row.ID] {
				return errInvalidForgeResponse
			}
			seen[row.ID] = true
		}
		// Forgejo trims inaccessible repositories after pagination. An empty page
		// may still have a next page; never expose its unfiltered total count.
		next, err = organizationNextPage(headers, page)
		return err
	})
	if err != nil {
		return nil, 0, err
	}
	return rows, next, nil
}
