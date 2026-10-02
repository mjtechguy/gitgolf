package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

var errProfileConflict = errors.New("profile changed")

// Native self-settings projection. Presence is required even for empty values;
// absent provider data must never become a fabricated editable empty profile.
type forgeProfileSettings struct {
	FullName *string `json:"full_name"`
	Bio      *string `json:"description"`
	Location *string `json:"location"`
	Website  *string `json:"website"`
}

func profileText(value string, limit int, multiline bool) bool {
	return discussionText(value, limit) && (multiline || strings.IndexFunc(value, unicode.IsControl) < 0)
}
func profileWebsite(value string) bool {
	if !profileText(value, 255, false) {
		return false
	}
	if value == "" {
		return true
	}
	parsed, err := url.ParseRequestURI(value)
	return err == nil && (parsed.Scheme == "https" || parsed.Scheme == "http") && parsed.Hostname() != "" && parsed.User == nil
}
func wireProfile(row forgeProfileSettings, caller User) (*golfv1.Profile, error) {
	if caller.ID <= 0 || !validOrganizationName(caller.Login) || row.FullName == nil || row.Bio == nil || row.Location == nil || row.Website == nil ||
		!profileText(*row.FullName, 100, false) || !profileText(*row.Bio, 255, true) || !profileText(*row.Location, 50, false) || !profileText(*row.Website, 255, false) {
		return nil, errInvalidForgeResponse
	}
	p := &golfv1.Profile{UserId: strconv.FormatInt(caller.ID, 10), Login: caller.Login, FullName: *row.FullName, Bio: *row.Bio, Location: *row.Location, Website: *row.Website, CanEdit: true}
	// A stale-form observation, never native atomic CAS or credential authority.
	data, _ := json.Marshal(struct {
		ID                                      int64
		Login, FullName, Bio, Location, Website string
	}{caller.ID, caller.Login, p.FullName, p.Bio, p.Location, p.Website})
	digest := sha256.Sum256(data)
	p.Revision = hex.EncodeToString(digest[:])
	return p, nil
}
func (s *Server) readProfile(ctx context.Context, token forgeCredential, caller User) (*golfv1.Profile, error) {
	var row forgeProfileSettings
	if _, err := s.forge(ctx, http.MethodGet, "/user/settings", token, nil, &row); err != nil {
		return nil, err
	}
	latest, err := s.currentUser(ctx, token)
	if err != nil {
		return nil, err
	}
	if latest.ID != caller.ID || latest.Login != caller.Login {
		return nil, errUnauthenticated
	}
	return wireProfile(row, latest)
}
func (s *Server) GetProfile(ctx context.Context, req *connect.Request[golfv1.GetProfileRequest]) (*connect.Response[golfv1.GetProfileResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	result := &golfv1.GetProfileResponse{}
	err = s.withForgeCaller(ctx, s.cookieValue(req.Header()), token, func(caller User) error {
		p, err := s.readProfile(ctx, token, caller)
		if err != nil {
			return err
		}
		result.Profile = p
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
func profilePatch(req *golfv1.UpdateProfileRequest) (map[string]any, error) {
	if _, err := discussionID(req.UserId); err != nil {
		return nil, invalid("Provide your immutable account ID.")
	}
	if len(req.ExpectedRevision) != 64 {
		return nil, invalid("Provide the observed profile revision.")
	}
	if _, err := hex.DecodeString(req.ExpectedRevision); err != nil || strings.ToLower(req.ExpectedRevision) != req.ExpectedRevision {
		return nil, invalid("Provide the observed profile revision.")
	}
	patch := map[string]any{}
	for _, field := range []struct {
		key       string
		value     *string
		limit     int
		multiline bool
	}{{"full_name", req.FullName, 100, false}, {"description", req.Bio, 255, true}, {"location", req.Location, 50, false}, {"website", req.Website, 255, false}} {
		if field.value == nil {
			continue
		}
		if !profileText(*field.value, field.limit, field.multiline) || (field.key == "website" && !profileWebsite(*field.value)) {
			return nil, invalid("Profile fields must fit their UTF-8 bounds, without unsupported controls; website must be empty or an HTTP(S) URL without credentials.")
		}
		patch[field.key] = *field.value
	}
	if len(patch) == 0 {
		return nil, invalid("Choose at least one profile field to change.")
	}
	return patch, nil
}
func profileMatchesUpdate(p *golfv1.Profile, req *golfv1.UpdateProfileRequest) bool {
	return p.UserId == req.UserId && (req.FullName == nil || p.FullName == *req.FullName) && (req.Bio == nil || p.Bio == *req.Bio) && (req.Location == nil || p.Location == *req.Location) && (req.Website == nil || p.Website == *req.Website)
}
func (s *Server) UpdateProfile(ctx context.Context, req *connect.Request[golfv1.UpdateProfileRequest]) (*connect.Response[golfv1.UpdateProfileResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	patch, err := profilePatch(req.Msg)
	if err != nil {
		return nil, rpcError(err)
	}
	value := s.cookieValue(req.Header())
	result := &golfv1.UpdateProfileResponse{}
	err = s.withForgeCaller(ctx, value, token, func(caller User) error {
		if strconv.FormatInt(caller.ID, 10) != req.Msg.UserId {
			return forgeError{http.StatusForbidden}
		}
		before, err := s.readProfile(ctx, token, caller)
		if err != nil {
			return err
		}
		if before.Revision != req.Msg.ExpectedRevision {
			return errProfileConflict
		}
		// Reobserve after provider waits and recheck local revocation immediately
		// before dispatch. No local lock is held during the provider operation.
		current, err := s.readProfile(ctx, token, caller)
		if err != nil {
			return err
		}
		if current.Revision != before.Revision {
			return errProfileConflict
		}
		if _, err := s.localSessionUser(ctx, value, caller); err != nil {
			return err
		}
		var receipt forgeProfileSettings
		if _, err := s.forgeJSON(ctx, http.MethodPatch, "/user/settings", token, patch, &receipt, http.StatusOK); err != nil {
			return err
		}
		received, err := wireProfile(receipt, caller)
		if err != nil || !profileMatchesUpdate(received, req.Msg) {
			return errInvalidForgeResponse
		}
		observed, err := s.readProfile(ctx, token, caller)
		if err != nil {
			return err
		}
		if !profileMatchesUpdate(observed, req.Msg) || observed.Revision != received.Revision {
			return errInvalidForgeResponse
		}
		result.Profile = observed
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
