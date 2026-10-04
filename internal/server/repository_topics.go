package server

import (
	"context"
	"google.golang.org/protobuf/proto"
	"net/http"
	"slices"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// Topics use a distinct supported native write, never a second hidden effect in
// a general-settings save. Revision checks detect stale forms, not native CAS.
func (s *Server) UpdateRepositoryTopics(ctx context.Context, req *connect.Request[golfv1.UpdateRepositoryTopicsRequest]) (*connect.Response[golfv1.UpdateRepositoryTopicsResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	m := req.Msg
	key := keyFrom(m.Repository)
	base, err := repositoryPath(key)
	if err != nil {
		return nil, rpcError(err)
	}
	if _, err = repositorySettingsPatch(&golfv1.UpdateRepositorySettingsRequest{RepositoryId: m.RepositoryId, OwnerId: m.OwnerId, ExpectedRevision: m.ExpectedRevision, Description: new(string)}); err != nil {
		return nil, rpcError(err)
	}
	if !validRepositoryTopics(m.Topics) {
		return nil, rpcError(invalid("Use at most 25 unique lowercase topics of 1–35 characters: letters, digits, dots and hyphens, starting with a letter or digit."))
	}
	topics := append([]string{}, m.Topics...)
	slices.Sort(topics)
	result := &golfv1.UpdateRepositoryTopicsResponse{}
	value := s.cookieValue(req.Header())
	err = s.withForgeCaller(ctx, value, token, func(caller User) error {
		_, before, err := s.readRepositorySettings(ctx, token, key)
		if err != nil {
			return err
		}
		if !before.CanEdit {
			return forgeError{http.StatusForbidden}
		}
		if before.RepositoryId != m.RepositoryId || before.OwnerId != m.OwnerId || before.Revision != m.ExpectedRevision {
			return errRepositorySettingsConflict
		}
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
		if _, err = s.localSessionUser(ctx, value, caller); err != nil {
			return err
		}
		if _, err = s.forgeJSON(ctx, http.MethodPut, base+"/topics", token, map[string]any{"topics": topics}, nil, http.StatusNoContent); err != nil {
			return err
		}
		_, observed, err := s.readRepositorySettings(ctx, token, key)
		if err != nil {
			return err
		}
		if observed.RepositoryId != m.RepositoryId || observed.OwnerId != m.OwnerId || !observed.CanEdit || !slices.Equal(observed.Topics, topics) {
			return errInvalidForgeResponse
		}
		// Independent readback must preserve every unrelated General value.
		oldRevision := before.Revision
		before.Revision = ""
		observedRevision := observed.Revision
		observed.Revision = ""
		before.Topics = topics
		if !proto.Equal(before, observed) {
			return errInvalidForgeResponse
		}
		before.Revision = oldRevision
		observed.Revision = observedRevision
		result.Settings = observed
		return nil
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}
