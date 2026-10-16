package server

import (
	"context"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/go-chi/chi/v5"
)

const repositoryReleaseAssetMaxBytes = 10 << 20

// UUID is native transport identity only; no URL or credential leaves this reader.
type forgeReleaseDownloadAsset struct {
	forgeReleaseAsset
	UUID string `json:"uuid"`
}

func validReleaseDownloadAsset(row forgeReleaseDownloadAsset, id int64) bool {
	return row.ID == id && row.ID > 0 && creationKey.MatchString(row.UUID) && row.Name != "" && profileText(row.Name, 1024, false) && row.Size != nil && *row.Size >= 0 && row.DownloadCount != nil && *row.DownloadCount >= 0 && validRuleTime(row.CreatedAt)
}

func sameReleaseDownloadAsset(a, b forgeReleaseDownloadAsset) bool {
	// Native increments download_count before delivering bytes. It is not identity.
	return a.ID == b.ID && a.UUID == b.UUID && a.Name == b.Name && a.Size != nil && b.Size != nil && *a.Size == *b.Size && a.CreatedAt == b.CreatedAt
}

func (s *Server) readReleaseDownloadAsset(ctx context.Context, token forgeCredential, base string, releaseID, assetID int64) (forgeReleaseDownloadAsset, error) {
	var row forgeReleaseDownloadAsset
	_, err := s.forgeJSON(ctx, http.MethodGet, base+"/releases/"+strconv.FormatInt(releaseID, 10)+"/assets/"+strconv.FormatInt(assetID, 10), token, nil, &row, http.StatusOK)
	if err == nil && !validReleaseDownloadAsset(row, assetID) {
		err = errInvalidForgeResponse
	}
	return row, err
}

func (s *Server) releaseAssetBytes(ctx context.Context, token forgeCredential, key repositoryKey, row forgeReleaseDownloadAsset) ([]byte, error) {
	if *row.Size > repositoryReleaseAssetMaxBytes {
		return nil, errForgeResponseTooLarge
	}
	if token.Token == "" || (token.Kind != "pat" && token.Kind != "oauth") {
		return nil, errUnauthenticated
	}
	// Pinned native web AllowOAuth2 accepts PAT as Bearer. The API's PAT "token"
	// scheme does not authenticate this route. Never follow ServeDirect redirects.
	endpoint := s.config.ForgeURL + "/" + url.PathEscape(key.Owner) + "/" + url.PathEscape(key.Name) + "/releases/attachments/" + row.UUID
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, errInvalidForgeResponse
	}
	request.Header.Set("Authorization", "Bearer "+token.Token)
	request.Header.Set("Accept", "application/octet-stream")
	response, err := s.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, forgeError{status: response.StatusCode}
	}
	if response.ContentLength > repositoryReleaseAssetMaxBytes {
		return nil, errForgeResponseTooLarge
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, repositoryReleaseAssetMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > repositoryReleaseAssetMaxBytes {
		return nil, errForgeResponseTooLarge
	}
	if int64(len(data)) != *row.Size {
		return nil, errInvalidForgeResponse
	}
	return data, nil
}

func (s *Server) readRepositoryReleaseAsset(ctx context.Context, cookie string, token forgeCredential, key repositoryKey, repositoryID, releaseID, assetID int64) (forgeReleaseDownloadAsset, []byte, error) {
	var asset forgeReleaseDownloadAsset
	var data []byte
	err := s.withRepositoryRead(ctx, cookie, token, key, func(base string, repo Repository) error {
		if repo.ID != repositoryID {
			return errIssueTargetChanged
		}
		before, err := s.readStarRepository(ctx, token, key, repositoryID)
		if err != nil {
			return err
		}
		asset, err = s.readReleaseDownloadAsset(ctx, token, base, releaseID, assetID)
		if err != nil {
			return err
		}
		canonical := repositoryKey{Owner: before.Owner.Login, Name: before.Name}
		data, err = s.releaseAssetBytes(ctx, token, canonical, asset)
		if err != nil {
			return err
		}
		afterAsset, err := s.readReleaseDownloadAsset(ctx, token, base, releaseID, assetID)
		if err != nil {
			return err
		}
		if !sameReleaseDownloadAsset(asset, afterAsset) {
			return errIssueTargetChanged
		}
		after, err := s.readStarRepository(ctx, token, key, repositoryID)
		if err != nil {
			return err
		}
		if before.Owner.ID != after.Owner.ID || before.Owner.Login != after.Owner.Login || before.Name != after.Name {
			return errIssueTargetChanged
		}
		return nil
	})
	if err != nil {
		return forgeReleaseDownloadAsset{}, nil, err
	}
	return asset, data, nil
}

func (s *Server) RepositoryReleaseAssetDownloadHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
		fail := func(status int) { http.Error(w, "Release asset unavailable.", status) }
		if r.Method != http.MethodGet || len(r.Header.Values("Authorization")) != 0 || r.URL.RawQuery != "" || r.Header.Get("Sec-Fetch-Site") == "cross-site" || (r.Header.Get("Origin") != "" && r.Header.Get("Origin") != s.config.PublicURL) {
			fail(http.StatusForbidden)
			return
		}
		key := repositoryKey{Owner: chi.URLParam(r, "owner"), Name: chi.URLParam(r, "name")}
		_, pathErr := repositoryPath(key)
		repoID, repoErr := discussionID(chi.URLParam(r, "repositoryId"))
		releaseID, releaseErr := discussionID(chi.URLParam(r, "releaseId"))
		assetID, assetErr := discussionID(chi.URLParam(r, "assetId"))
		if pathErr != nil || repoErr != nil || releaseErr != nil || assetErr != nil {
			fail(http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		cookie := s.cookieValue(r.Header)
		token, err := s.sessionCredential(ctx, cookie)
		if err != nil {
			fail(http.StatusUnauthorized)
			return
		}
		asset, data, err := s.readRepositoryReleaseAsset(ctx, cookie, token, key, repoID, releaseID, assetID)
		if err != nil {
			status := http.StatusServiceUnavailable
			switch connect.CodeOf(rpcError(err)) {
			case connect.CodeUnauthenticated:
				status = http.StatusUnauthorized
			case connect.CodePermissionDenied, connect.CodeNotFound:
				status = http.StatusNotFound
			}
			if errors.Is(err, errIssueTargetChanged) {
				status = http.StatusNotFound
			}
			if errors.Is(err, errForgeResponseTooLarge) {
				status = http.StatusRequestEntityTooLarge
			}
			fail(status)
			return
		}
		name := path.Base(strings.ReplaceAll(asset.Name, "\\", "/"))
		if name == "." || name == "/" || name == "" {
			name = "release-asset"
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}
}
