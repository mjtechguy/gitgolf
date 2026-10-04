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
	"time"
	"unicode"
	"unicode/utf8"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// ID identifies the repository association, KeyID the potentially shared public
// key. Only the association's Mode-derived read_only value describes its grant.
type forgeRepositoryDeployKey struct {
	ID          int64       `json:"id"`
	KeyID       int64       `json:"key_id"`
	Title       string      `json:"title"`
	Key         string      `json:"key"`
	Fingerprint string      `json:"fingerprint"`
	CreatedAt   string      `json:"created_at"`
	ReadOnly    *bool       `json:"read_only"`
	Repository  *Repository `json:"repository"`
}

func wireRepositoryDeployKey(row forgeRepositoryDeployKey, repoID string) (*golfv1.RepositoryDeployKey, error) {
	key, fingerprint, err := normalizeSSHKey(row.Key)
	if err != nil || row.ID <= 0 || row.KeyID <= 0 || row.ReadOnly == nil || (strings.TrimSpace(row.Title) == "" || len(row.Title) > 1024 || !utf8.ValidString(row.Title) || strings.ContainsFunc(row.Title, unicode.IsControl)) || row.Fingerprint != fingerprint || row.CreatedAt == "" || !validPullTime(row.CreatedAt) || (row.Repository != nil && strconv.FormatInt(row.Repository.ID, 10) != repoID) {
		return nil, errInvalidForgeResponse
	}
	wire := &golfv1.RepositoryDeployKey{Id: strconv.FormatInt(row.ID, 10), PublicKeyId: strconv.FormatInt(row.KeyID, 10), Title: row.Title, PublicKey: key, Fingerprint: fingerprint, CreatedAt: row.CreatedAt, ReadOnly: *row.ReadOnly}
	data, _ := json.Marshal(struct {
		RepositoryID, ID, KeyID, Title, Key, Created string
		ReadOnly                                     bool
	}{repoID, wire.Id, wire.PublicKeyId, wire.Title, wire.PublicKey, wire.CreatedAt, wire.ReadOnly})
	digest := sha256.Sum256(data)
	wire.Revision = hex.EncodeToString(digest[:])
	return wire, nil
}
func (s *Server) readRepositoryDeployKey(ctx context.Context, token forgeCredential, base, repoID, id string) (*golfv1.RepositoryDeployKey, error) {
	var row forgeRepositoryDeployKey
	_, err := s.forge(ctx, http.MethodGet, base+"/keys/"+id, token, nil, &row)
	if err != nil {
		return nil, err
	}
	if strconv.FormatInt(row.ID, 10) != id {
		return nil, errInvalidForgeResponse
	}
	return wireRepositoryDeployKey(row, repoID)
}
func (s *Server) ListRepositoryDeployKeys(ctx context.Context, req *connect.Request[golfv1.ListRepositoryDeployKeysRequest]) (*connect.Response[golfv1.ListRepositoryDeployKeysResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	key := keyFrom(req.Msg.Repository)
	if err = validateRepositoryAccess(key, req.Msg.RepositoryId, req.Msg.OwnerId, req.Msg.ExpectedRevision, ""); err != nil {
		return nil, rpcError(err)
	}
	page, limit, err := pagination(pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	result := &golfv1.ListRepositoryDeployKeysResponse{RepositoryId: req.Msg.RepositoryId, OwnerId: req.Msg.OwnerId, AccessRevision: req.Msg.ExpectedRevision}
	err = s.withRepositoryAccess(ctx, s.cookieValue(req.Header()), token, key, req.Msg.RepositoryId, req.Msg.OwnerId, req.Msg.ExpectedRevision, func(_ User, _ *golfv1.RepositoryAccess) error {
		return s.withNativePageSize(ctx, token, limit, func(limit uint32) error {
			base, _ := repositoryPath(key)
			var rows []forgeRepositoryDeployKey
			headers, e := s.forge(ctx, http.MethodGet, base+"/keys?"+pageQuery(page, limit).Encode(), token, nil, &rows)
			if e != nil {
				return e
			}
			next, e := repositoryCollaboratorNextPage(headers, page, limit)
			if e != nil {
				return e
			}
			total, _ := strconv.ParseUint(headers.Get("X-Total-Count"), 10, 63)
			start := (uint64(page) - 1) * uint64(limit)
			expected := uint64(0)
			if start < total {
				expected = min(uint64(limit), total-start)
			}
			if rows == nil || uint64(len(rows)) != expected {
				return errInvalidForgeResponse
			}
			seen := map[int64]bool{}
			for _, row := range rows {
				if seen[row.ID] {
					return errInvalidForgeResponse
				}
				seen[row.ID] = true
				wire, e := wireRepositoryDeployKey(row, req.Msg.RepositoryId)
				if e != nil {
					return e
				}
				result.Keys = append(result.Keys, wire)
			}
			result.Page = wirePage(next)
			return nil
		})
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
func (s *Server) AddRepositoryDeployKey(ctx context.Context, req *connect.Request[golfv1.AddRepositoryDeployKeyRequest]) (*connect.Response[golfv1.AddRepositoryDeployKeyResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	target := keyFrom(req.Msg.Repository)
	if err = validateRepositoryAccess(target, req.Msg.RepositoryId, req.Msg.OwnerId, req.Msg.ExpectedRevision, ""); err != nil {
		return nil, rpcError(err)
	}
	if !validApiCredentialLabel(req.Msg.Title) || req.Msg.ReadOnly == nil {
		return nil, rpcError(invalid("Choose a trimmed title of 1..64 UTF-8 bytes and explicit read-only or read/write access."))
	}
	key, fingerprint, err := normalizeSSHKey(req.Msg.PublicKey)
	if err != nil {
		return nil, rpcError(err)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	result := &golfv1.AddRepositoryDeployKeyResponse{RepositoryId: req.Msg.RepositoryId, OwnerId: req.Msg.OwnerId, AccessRevision: req.Msg.ExpectedRevision}
	err = s.withRepositoryAccess(ctx, s.cookieValue(req.Header()), token, target, req.Msg.RepositoryId, req.Msg.OwnerId, req.Msg.ExpectedRevision, func(_ User, _ *golfv1.RepositoryAccess) error {
		base, _ := repositoryPath(target)
		var row forgeRepositoryDeployKey
		_, e := s.forgeJSON(ctx, http.MethodPost, base+"/keys", token, map[string]any{"title": req.Msg.Title, "key": key, "read_only": *req.Msg.ReadOnly}, &row, http.StatusCreated)
		var upstream forgeError
		if errors.As(e, &upstream) && upstream.status == 422 {
			return errSSHKeyRejected
		}
		if e != nil {
			return e
		}
		receipt, e := wireRepositoryDeployKey(row, req.Msg.RepositoryId)
		if e != nil {
			return e
		}
		if receipt.PublicKey != key || receipt.Fingerprint != fingerprint || receipt.Title != req.Msg.Title || receipt.ReadOnly != *req.Msg.ReadOnly {
			return errInvalidForgeResponse
		}
		observed, e := s.readRepositoryDeployKey(ctx, token, base, req.Msg.RepositoryId, receipt.Id)
		if e != nil {
			return e
		}
		if observed.Revision != receipt.Revision {
			return errInvalidForgeResponse
		}
		result.Key = observed
		return nil
	})
	// One dispatch only. A failed readback/authority check can follow an accepted
	// native write; neither an error nor a refreshed inventory proves attribution.
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
func (s *Server) DeleteRepositoryDeployKey(ctx context.Context, req *connect.Request[golfv1.DeleteRepositoryDeployKeyRequest]) (*connect.Response[golfv1.DeleteRepositoryDeployKeyResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	key := keyFrom(req.Msg.Repository)
	if err = validateRepositoryAccess(key, req.Msg.RepositoryId, req.Msg.OwnerId, req.Msg.ExpectedRevision, ""); err != nil {
		return nil, rpcError(err)
	}
	if _, err = discussionID(req.Msg.KeyId); err != nil || !validAccessRevision(req.Msg.ExpectedKeyRevision) {
		return nil, rpcError(invalid("Provide the current association ID and deploy-key revision."))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	err = s.withRepositoryAccess(ctx, s.cookieValue(req.Header()), token, key, req.Msg.RepositoryId, req.Msg.OwnerId, req.Msg.ExpectedRevision, func(_ User, _ *golfv1.RepositoryAccess) error {
		base, _ := repositoryPath(key)
		before, e := s.readRepositoryDeployKey(ctx, token, base, req.Msg.RepositoryId, req.Msg.KeyId)
		if e != nil {
			return e
		}
		if before.Revision != req.Msg.ExpectedKeyRevision {
			return errRepositoryAccessConflict
		}
		_, e = s.forgeJSON(ctx, http.MethodDelete, base+"/keys/"+req.Msg.KeyId, token, nil, nil, http.StatusNoContent)
		if e != nil {
			return e
		}
		_, e = s.readRepositoryDeployKey(ctx, token, base, req.Msg.RepositoryId, req.Msg.KeyId)
		var upstream forgeError
		if errors.As(e, &upstream) && upstream.status == 404 {
			return nil
		}
		if e != nil {
			return e
		}
		return errInvalidForgeResponse
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.DeleteRepositoryDeployKeyResponse{KeyId: req.Msg.KeyId, RepositoryId: req.Msg.RepositoryId, OwnerId: req.Msg.OwnerId, AccessRevision: req.Msg.ExpectedRevision}), nil
}
