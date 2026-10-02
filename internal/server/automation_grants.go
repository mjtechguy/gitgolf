package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

const automationRepositoryDomain = "automation_repository"

var errAutomationGrantLimit = errors.New("automation grant active limit")

var errAutomationGrantConflict = errors.New("automation grant changed")

type automationGrantRecord struct {
	ID, ForgeURL, RepositoryOwner, RepositoryName                                        string
	RepositoryID, OwnerID, SponsorUserID, SponsorNativeUserID, Revision, RevocationEpoch int64
	OrganizationOwned, Enabled                                                           bool
	ExpiresAt, CreatedAt                                                                 time.Time
	Branches, WorkflowPaths                                                              []string
}

const automationGrantColumns = `id::text,forge_url,repository_id,owner_id,repository_owner,repository_name,organization_owned,sponsor_user_id,sponsor_native_user_id,revision,revocation_epoch,enabled,expires_at,created_at,branches,workflow_paths`

func scanAutomationGrant(row workflowRunScanner) (automationGrantRecord, error) {
	var g automationGrantRecord
	var branches, paths []byte
	err := row.Scan(&g.ID, &g.ForgeURL, &g.RepositoryID, &g.OwnerID, &g.RepositoryOwner, &g.RepositoryName, &g.OrganizationOwned, &g.SponsorUserID, &g.SponsorNativeUserID, &g.Revision, &g.RevocationEpoch, &g.Enabled, &g.ExpiresAt, &g.CreatedAt, &branches, &paths)
	if err == nil && (json.Unmarshal(branches, &g.Branches) != nil || json.Unmarshal(paths, &g.WorkflowPaths) != nil) {
		err = errStorageUnavailable
	}
	return g, err
}
func wireAutomationGrant(g automationGrantRecord) *golfv1.AutomationGrant {
	return &golfv1.AutomationGrant{Id: g.ID, RepositoryId: strconv.FormatInt(g.RepositoryID, 10), OwnerId: strconv.FormatInt(g.OwnerID, 10), SponsorNativeUserId: strconv.FormatInt(g.SponsorNativeUserID, 10), Revision: strconv.FormatInt(g.Revision, 10), RevocationEpoch: strconv.FormatInt(g.RevocationEpoch, 10), Enabled: g.Enabled, ExpiresAt: g.ExpiresAt.UTC().Format(time.RFC3339Nano), CreatedAt: g.CreatedAt.UTC().Format(time.RFC3339Nano), Branches: g.Branches, WorkflowPaths: g.WorkflowPaths, ExecutionState: "unavailable"}
}
func automationCredentialBinding(id, forge string, nativeID int64) []byte {
	raw, _ := json.Marshal([]string{automationRepositoryDomain, id, "1", forge, strconv.FormatInt(nativeID, 10)})
	hash := sha256.Sum256(raw)
	return hash[:]
}
func validateAutomationGrant(m *golfv1.CreateAutomationGrantRequest, now time.Time) (int64, int64, time.Time, error) {
	repoID, e := discussionID(m.ExpectedRepositoryId)
	ownerID, e2 := discussionID(m.ExpectedOwnerId)
	expiry, e3 := time.Parse(time.RFC3339Nano, m.ExpiresAt)
	if !creationKey.MatchString(m.IdempotencyKey) || e != nil || e2 != nil || e3 != nil || !expiry.After(now.Add(time.Minute)) || expiry.After(now.Add(30*24*time.Hour)) {
		return 0, 0, time.Time{}, invalid("Provide immutable repository/owner IDs and an expiry between one minute and 30 days.")
	}
	if len(m.NativeToken) < 8 || len(m.NativeToken) > 512 || strings.ContainsAny(m.NativeToken, " \t\r\n\x00") || len(m.Branches) < 1 || len(m.Branches) > 20 || len(m.WorkflowPaths) < 1 || len(m.WorkflowPaths) > 20 {
		return 0, 0, time.Time{}, invalid("Provide a separately authorized native token and 1–20 exact branches and workflow paths.")
	}
	seen := map[string]bool{}
	for _, branch := range m.Branches {
		if len(branch) > 255 || !validRef("refs/heads/"+branch) || branch == "" || strings.ContainsAny(branch, "*?[]{}!+\\") || seen[branch] {
			return 0, 0, time.Time{}, invalid("Branches must be unique exact names without patterns.")
		}
		seen[branch] = true
	}
	seen = map[string]bool{}
	for _, path := range m.WorkflowPaths {
		if !executionWorkflowPath(path) || seen[path] {
			return 0, 0, time.Time{}, invalid("Select unique supported exact workflow paths.")
		}
		seen[path] = true
	}
	return repoID, ownerID, expiry, nil
}
func automationGrantAdmin(access *golfv1.RepositoryAccess) bool {
	return access.CurrentPermission == "admin" || access.CurrentPermission == "owner"
}

// Preserve the stricter repository-admin boundary on both observations. Native
// changes are independent of Golf SQL; this is not a cross-provider atomic grant.
func (s *Server) withAutomationRepository(ctx context.Context, session string, token forgeCredential, key repositoryKey, repoID, ownerID int64, _ bool, operation func(User, *golfv1.RepositoryAccess) error) error {
	return s.withForgeCaller(ctx, session, token, func(user User) error {
		a, err := s.readRepositoryAccess(ctx, token, key, user)
		if err != nil {
			return err
		}
		if repoID > 0 && (a.RepositoryId != strconv.FormatInt(repoID, 10) || a.OwnerId != strconv.FormatInt(ownerID, 10)) {
			return errResourceNotFound
		}
		if !automationGrantAdmin(a) {
			return forgeError{http.StatusForbidden}
		}
		if err = operation(user, a); err != nil {
			return err
		}
		return s.checkAutomationAdmin(ctx, token, key, user, a)
	})
}

func (s *Server) checkAutomationAdmin(ctx context.Context, token forgeCredential, key repositoryKey, user User, expected *golfv1.RepositoryAccess) error {
	a, err := s.readRepositoryAccess(ctx, token, key, user)
	if err != nil {
		return err
	}
	if a.RepositoryId != expected.RepositoryId || a.OwnerId != expected.OwnerId || a.OrganizationOwned != expected.OrganizationOwned {
		return errResourceNotFound
	}
	if !automationGrantAdmin(a) {
		return forgeError{http.StatusForbidden}
	}
	return nil
}

// The supplied personal PAT must independently resolve to the sponsor. Browser
// credentials authorize this edit only; they are never copied into the grant.
func (s *Server) verifyAutomationDelegation(ctx context.Context, g automationGrantRecord, token forgeCredential) error {
	caller, err := s.currentUser(ctx, token)
	if err != nil {
		return err
	}
	if caller.ID != g.SponsorNativeUserID {
		return forgeError{http.StatusForbidden}
	}
	repo, err := s.executionSelectedRepository(ctx, token, g.RepositoryID)
	if err != nil {
		return err
	}
	if repo.Owner.ID != g.OwnerID || repo.Owner.Login != g.RepositoryOwner || repo.Name != g.RepositoryName || *repo.Archived || *repo.Mirror {
		return errResourceNotFound
	}
	base, _ := repositoryPath(repositoryKey{repo.Owner.Login, repo.Name})
	permission, err := s.repositoryPermission(ctx, token, base, caller)
	if err != nil {
		return err
	}
	if permission != "owner" && permission != "admin" && permission != "write" {
		return forgeError{http.StatusForbidden}
	}
	org, err := s.repositoryOwnerKind(ctx, token, *repo.Owner)
	if err != nil {
		return err
	}
	if org != g.OrganizationOwned {
		return errResourceNotFound
	}
	return nil
}
func (s *Server) ListAutomationGrants(ctx context.Context, req *connect.Request[golfv1.ListAutomationGrantsRequest]) (*connect.Response[golfv1.ListAutomationGrantsResponse], error) {
	token, err := workflowBrowserToken(ctx)
	if err != nil {
		return nil, rpcError(err)
	}
	key := keyFrom(req.Msg.Repository)
	if _, err = repositoryPath(key); err != nil {
		return nil, rpcError(err)
	}
	cursor := req.Msg.AfterId
	if cursor != "" && !creationKey.MatchString(cursor) {
		return nil, rpcError(invalid("Provide a canonical grant cursor."))
	}
	result := &golfv1.ListAutomationGrantsResponse{}
	err = s.withAutomationRepository(ctx, s.cookieValue(req.Header()), token, key, 0, 0, false, func(_ User, a *golfv1.RepositoryAccess) error {
		if !automationGrantAdmin(a) {
			return forgeError{http.StatusForbidden}
		}
		if s.db == nil {
			return errStorageUnavailable
		}
		rows, e := s.db.QueryContext(ctx, `SELECT `+automationGrantColumns+` FROM golf_automation_grants WHERE forge_url=$1 AND repository_id=$2 AND owner_id=$3 AND ($4='' OR id::text>$4) ORDER BY id LIMIT 26`, s.config.GiteaURL, a.RepositoryId, a.OwnerId, cursor)
		if e != nil {
			return errStorageUnavailable
		}
		defer rows.Close()
		for rows.Next() {
			g, e := scanAutomationGrant(rows)
			if e != nil {
				return errStorageUnavailable
			}
			if len(result.Grants) == 25 {
				result.NextAfterId = result.Grants[24].Id
				break
			}
			result.Grants = append(result.Grants, wireAutomationGrant(g))
		}
		if rows.Err() != nil {
			return errStorageUnavailable
		}
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
func (s *Server) CreateAutomationGrant(ctx context.Context, req *connect.Request[golfv1.CreateAutomationGrantRequest]) (*connect.Response[golfv1.CreateAutomationGrantResponse], error) {
	token, err := workflowBrowserToken(ctx)
	if err != nil {
		return nil, rpcError(err)
	}
	m := req.Msg
	key := keyFrom(m.Repository)
	if _, err = repositoryPath(key); err != nil {
		return nil, rpcError(err)
	}
	repoID, ownerID, expiry, err := validateAutomationGrant(m, time.Now())
	if err != nil {
		return nil, rpcError(err)
	}
	var result automationGrantRecord
	err = s.withAutomationRepository(ctx, s.cookieValue(req.Header()), token, key, repoID, ownerID, true, func(user User, a *golfv1.RepositoryAccess) error {
		if !automationGrantAdmin(a) {
			return forgeError{http.StatusForbidden}
		}
		g := automationGrantRecord{ID: uuid.NewString(), ForgeURL: s.config.GiteaURL, RepositoryID: repoID, OwnerID: ownerID, RepositoryOwner: key.Owner, RepositoryName: key.Name, OrganizationOwned: a.OrganizationOwned, SponsorNativeUserID: user.ID, ExpiresAt: expiry, Branches: slices.Clone(m.Branches), WorkflowPaths: slices.Clone(m.WorkflowPaths)}
		delegated := forgeCredential{Kind: "pat", Token: m.NativeToken}
		if e := s.verifyAutomationDelegation(ctx, g, delegated); e != nil {
			return e
		}
		// Verify every selected workflow can be read by the independent token. Source
		// syntax and exact pushed commit remain separate admission gates.
		base, _ := repositoryPath(key)
		commits, _, e := s.readCommits(ctx, base, delegated, "", 1, 1)
		if e != nil {
			return e
		}
		if len(commits) != 1 {
			return errEmptyRepository
		}
		for _, file := range g.WorkflowPaths {
			content, e := s.workflowContents(ctx, delegated, base, commits[0].SHA, file, false)
			if e != nil {
				return e
			}
			if content.File == nil || content.File.Type != "file" || content.File.LFSOID != "" || content.File.Size > maxWorkflowBytes {
				return errWorkflowExecutionUnsupported
			}
		}
		binding := automationCredentialBinding(g.ID, g.ForgeURL, user.ID)
		encrypted, keyID, e := s.keyring.seal(automationRepositoryDomain, m.NativeToken, binding)
		if e != nil {
			return e
		}
		input, _ := json.Marshal(m)
		inputHash := sha256.Sum256(input)
		branches, _ := json.Marshal(g.Branches)
		paths, _ := json.Marshal(g.WorkflowPaths)
		if e := s.checkAutomationAdmin(ctx, token, key, user, a); e != nil {
			return e
		}
		return s.workflowTransaction(ctx, s.cookieValue(req.Header()), user.ID, func(tx *sql.Tx, actor database.LockManagedSessionRow, _ []byte) error {
			// Same sponsor-user lock as disable/revoke. A previously disabled local
			// identity cannot create a durable grant through an independent PAT session.
			var disabled bool
			if e := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_local_accounts WHERE user_id=$1 AND disabled_at IS NOT NULL)`, actor.UserID).Scan(&disabled); e != nil {
				return errStorageUnavailable
			}
			if disabled {
				return forgeError{http.StatusForbidden}
			}
			var previousID string
			var previousHash []byte
			e := tx.QueryRowContext(ctx, `SELECT id::text,input_hash FROM golf_automation_grants WHERE forge_url=$1 AND sponsor_user_id=$2 AND idempotency_key=$3`, g.ForgeURL, actor.UserID, m.IdempotencyKey).Scan(&previousID, &previousHash)
			if e == nil {
				if !slices.Equal(previousHash, inputHash[:]) {
					return errAutomationGrantConflict
				}
				result, e = scanAutomationGrant(tx.QueryRowContext(ctx, `SELECT `+automationGrantColumns+` FROM golf_automation_grants WHERE id=$1`, previousID))
				if e != nil {
					return errStorageUnavailable
				}
				return nil
			}
			if !errors.Is(e, sql.ErrNoRows) {
				return errStorageUnavailable
			}
			var active int
			if e := tx.QueryRowContext(ctx, `SELECT count(*) FROM golf_automation_grants WHERE forge_url=$1 AND repository_id=$2 AND sponsor_user_id=$3 AND enabled AND expires_at>clock_timestamp()`, g.ForgeURL, repoID, actor.UserID).Scan(&active); e != nil {
				return errStorageUnavailable
			}
			if active >= 8 {
				return errAutomationGrantLimit
			}
			row := tx.QueryRowContext(ctx, `INSERT INTO golf_automation_grants(id,forge_url,repository_id,owner_id,repository_owner,repository_name,organization_owned,sponsor_user_id,sponsor_native_user_id,expires_at,branches,workflow_paths,idempotency_key,input_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING `+automationGrantColumns, g.ID, g.ForgeURL, repoID, ownerID, g.RepositoryOwner, g.RepositoryName, g.OrganizationOwned, actor.UserID, user.ID, expiry, branches, paths, m.IdempotencyKey, inputHash[:])
			result, e = scanAutomationGrant(row)
			if e != nil {
				return errStorageUnavailable
			}
			if _, e = tx.ExecContext(ctx, `INSERT INTO golf_automation_credentials(grant_id,encrypted_credential,credential_binding,credential_key_id) VALUES($1,$2,$3,$4)`, g.ID, encrypted, binding, keyID); e != nil {
				return errStorageUnavailable
			}
			_, e = tx.ExecContext(ctx, `INSERT INTO golf_automation_grant_events(grant_id,revision,action,actor_user_id,actor_session_id) VALUES($1,1,'CREATED',$2,$3)`, g.ID, actor.UserID, actor.SessionID)
			if e != nil {
				return errStorageUnavailable
			}
			return nil
		})
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.CreateAutomationGrantResponse{Grant: wireAutomationGrant(result)}), nil
}
func (s *Server) RevokeAutomationGrant(ctx context.Context, req *connect.Request[golfv1.RevokeAutomationGrantRequest]) (*connect.Response[golfv1.RevokeAutomationGrantResponse], error) {
	token, err := workflowBrowserToken(ctx)
	if err != nil {
		return nil, rpcError(err)
	}
	m := req.Msg
	key := keyFrom(m.Repository)
	if _, err = repositoryPath(key); err != nil {
		return nil, rpcError(err)
	}
	revision, err := discussionID(m.ExpectedRevision)
	if err != nil || !creationKey.MatchString(m.GrantId) {
		return nil, rpcError(invalid("Provide the grant ID and expected revision."))
	}
	var result automationGrantRecord
	err = s.withAutomationRepository(ctx, s.cookieValue(req.Header()), token, key, 0, 0, true, func(user User, a *golfv1.RepositoryAccess) error {
		if !automationGrantAdmin(a) {
			return forgeError{http.StatusForbidden}
		}
		if e := s.checkAutomationAdmin(ctx, token, key, user, a); e != nil {
			return e
		}
		return s.workflowTransaction(ctx, s.cookieValue(req.Header()), user.ID, func(tx *sql.Tx, actor database.LockManagedSessionRow, _ []byte) error {
			g, e := scanAutomationGrant(tx.QueryRowContext(ctx, `SELECT `+automationGrantColumns+` FROM golf_automation_grants WHERE id=$1 AND forge_url=$2 AND repository_id=$3 AND owner_id=$4 FOR UPDATE`, m.GrantId, s.config.GiteaURL, a.RepositoryId, a.OwnerId))
			if errors.Is(e, sql.ErrNoRows) {
				return errResourceNotFound
			}
			if e != nil {
				return errStorageUnavailable
			}
			if g.Revision != revision {
				return errAutomationGrantConflict
			}
			if !g.Enabled {
				result = g
				return nil
			}
			result, e = scanAutomationGrant(tx.QueryRowContext(ctx, `UPDATE golf_automation_grants SET enabled=false,revision=revision+1,revocation_epoch=revocation_epoch+1 WHERE id=$1 RETURNING `+automationGrantColumns, g.ID))
			if e != nil {
				return errStorageUnavailable
			}
			_, e = tx.ExecContext(ctx, `INSERT INTO golf_automation_grant_events(grant_id,revision,action,actor_user_id,actor_session_id) VALUES($1,$2,'REVOKED',$3,$4)`, g.ID, result.Revision, actor.UserID, actor.SessionID)
			if e != nil {
				return errStorageUnavailable
			}
			return nil
		})
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.RevokeAutomationGrantResponse{Grant: wireAutomationGrant(result)}), nil
}
