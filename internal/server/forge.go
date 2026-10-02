package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type forgeCredential struct{ Kind, Token string }

type User struct {
	ID        int64  `json:"id"`
	Login     string `json:"login"`
	FullName  string `json:"full_name"`
	AvatarURL string `json:"avatar_url"`
}

type Repository struct {
	ID            int64     `json:"id"`
	Name          string    `json:"name"`
	FullName      string    `json:"full_name"`
	Description   string    `json:"description"`
	Private       bool      `json:"private"`
	HTMLURL       string    `json:"html_url"`
	DefaultBranch string    `json:"default_branch"`
	UpdatedAt     time.Time `json:"updated_at"`
	Empty         bool      `json:"empty"`
	CloneURL      string    `json:"clone_url"`
	SSHURL        string    `json:"ssh_url"`
}

type forgeError struct{ status int }

const maxForgeResponse = 2 << 20

var errForgeResponseTooLarge = errors.New("forge response exceeds the size limit")

func (e forgeError) Error() string { return fmt.Sprintf("forge returned HTTP %d", e.status) }

// forgeRequest is shared by JSON and raw diff reads. Callers close successful
// responses and enforce the appropriate payload bound before returning data.
func (s *Server) forgeRequest(ctx context.Context, method, path, accept string, token forgeCredential, input any) (*http.Response, error) {
	var body io.Reader
	if input != nil {
		b, err := json.Marshal(input)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.config.GiteaURL+"/api/v1"+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", accept)
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token.Token != "" {
		scheme := "token"
		if token.Kind == "oauth" {
			scheme = "Bearer"
		} else if token.Kind != "pat" {
			return nil, errCredentialUnavailable
		}
		req.Header.Set("Authorization", scheme+" "+token.Token)
	}
	res, err := s.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, errForgeUnavailable
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		res.Body.Close()
		return nil, forgeError{res.StatusCode}
	}
	return res, nil
}

func (s *Server) forge(ctx context.Context, method, path string, token forgeCredential, input, output any) (http.Header, error) {
	res, err := s.forgeRequest(ctx, method, path, "application/json", token, input)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if output != nil {
		if res.ContentLength > maxForgeResponse {
			return nil, errForgeResponseTooLarge
		}
		data, err := io.ReadAll(io.LimitReader(res.Body, maxForgeResponse+1))
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, errInvalidForgeResponse
		}
		if len(data) > maxForgeResponse {
			return nil, errForgeResponseTooLarge
		}
		if err := json.Unmarshal(data, output); err != nil {
			return nil, errInvalidForgeResponse
		}
	}
	return res.Header, nil
}

func (s *Server) currentUser(ctx context.Context, token forgeCredential) (User, error) {
	var user User
	_, err := s.forge(ctx, http.MethodGet, "/user", token, nil, &user)
	if err == nil && (user.ID <= 0 || strings.TrimSpace(user.Login) == "") {
		err = errInvalidForgeResponse
	}
	return user, err
}
