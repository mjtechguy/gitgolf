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
}

type forgeError struct{ status int }

func (e forgeError) Error() string { return fmt.Sprintf("forge returned HTTP %d", e.status) }

func (s *Server) forge(ctx context.Context, method, path, token string, input, output any) (http.Header, error) {
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
	req.Header.Set("Accept", "application/json")
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "token "+token)
	}
	res, err := s.client.Do(req)
	if err != nil {
		return nil, errors.New("forge unavailable")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, forgeError{res.StatusCode}
	}
	if output != nil {
		if err := json.NewDecoder(io.LimitReader(res.Body, 2<<20)).Decode(output); err != nil {
			return nil, errors.New("invalid forge response")
		}
	}
	return res.Header, nil
}

func (s *Server) currentUser(ctx context.Context, token string) (User, error) {
	var user User
	_, err := s.forge(ctx, http.MethodGet, "/user", token, nil, &user)
	if err == nil && (user.ID <= 0 || strings.TrimSpace(user.Login) == "") {
		err = errors.New("invalid forge identity")
	}
	return user, err
}
