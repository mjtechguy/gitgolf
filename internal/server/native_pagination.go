package server

import (
	"context"
	"net/http"
)

// Forgejo clamps requested limits before paging and may filter rows afterwards.
// Returned length therefore cannot establish the native page span. Observe the
// supported setting around the read; this detects observed drift, not an ABA
// change or a lock on native configuration.
func (s *Server) withNativePageSize(ctx context.Context, token forgeCredential, requested uint32, read func(uint32) error) error {
	settings := func() (int64, error) {
		var result struct {
			Maximum int64 `json:"max_response_items"`
		}
		_, err := s.forge(ctx, http.MethodGet, "/settings/api", token, nil, &result)
		if err != nil {
			return 0, err
		}
		if result.Maximum < 1 || result.Maximum > 2147483647 {
			return 0, errInvalidForgeResponse
		}
		return result.Maximum, nil
	}
	before, err := settings()
	if err != nil {
		return err
	}
	limit := min(requested, uint32(before))
	if err := read(limit); err != nil {
		return err
	}
	after, err := settings()
	if err != nil {
		return err
	}
	if before != after {
		return errInvalidForgeResponse
	}
	return nil
}
