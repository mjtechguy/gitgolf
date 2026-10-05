package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// Public imports use only canonical HTTPS GitHub/GitLab project paths. Neither
// credentials, query strings, arbitrary origins nor provider redirects are admitted.
func publicImportURL(raw string) (canonical, metadata string, e error) {
	if raw == "" {
		return "", "", nil
	}
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" || u.RawPath != "" || u.Port() != "" || (u.Host != "github.com" && u.Host != "gitlab.com") || len(raw) > 1024 {
		return "", "", invalid("Import a public HTTPS github.com or gitlab.com project URL without credentials or query parameters.")
	}
	path := strings.TrimSuffix(strings.TrimSuffix(u.Path, "/"), ".git")
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(parts) < 2 || len(parts) > 10 || (u.Host == "github.com" && len(parts) != 2) {
		return "", "", invalid("Use a canonical public project URL.")
	}
	for _, part := range parts {
		if !repositoryName.MatchString(part) || part == "." || part == ".." || strings.HasPrefix(part, "-") {
			return "", "", invalid("Use a canonical public project path.")
		}
	}
	canonical = "https://" + u.Host + "/" + strings.Join(parts, "/") + ".git"
	if u.Host == "github.com" {
		metadata = "https://api.github.com/repos/" + strings.Join(parts, "/")
	} else {
		metadata = "https://gitlab.com/api/v4/projects/" + url.PathEscape(strings.Join(parts, "/"))
	}
	return
}

// Provider metadata is fetched without any native/user credential. A public
// response and exact clone URL are required before native migration admission.
func (s *Server) verifyPublicImport(ctx context.Context, source string) error {
	canonical, endpoint, e := publicImportURL(source)
	if e != nil || canonical == "" {
		return e
	}
	request, e := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if e != nil {
		return invalid("Invalid public project metadata address.")
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "Golf-public-import")
	response, e := s.client.Do(request)
	if e != nil {
		return errForgeUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return forgeError{http.StatusForbidden}
	}
	if response.ContentLength > 256<<10 {
		return errForgeResponseTooLarge
	}
	data, e := io.ReadAll(io.LimitReader(response.Body, (256<<10)+1))
	if e != nil || len(data) > 256<<10 {
		return errInvalidForgeResponse
	}
	if strings.HasPrefix(canonical, "https://github.com/") {
		var info struct {
			Private  *bool  `json:"private"`
			CloneURL string `json:"clone_url"`
		}
		if json.Unmarshal(data, &info) != nil || info.Private == nil || *info.Private || info.CloneURL != canonical {
			return forgeError{http.StatusForbidden}
		}
	} else {
		var info struct {
			Visibility string `json:"visibility"`
			CloneURL   string `json:"http_url_to_repo"`
		}
		if json.Unmarshal(data, &info) != nil || info.Visibility != "public" || info.CloneURL != canonical {
			return forgeError{http.StatusForbidden}
		}
	}
	return nil
}
