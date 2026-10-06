package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
)

// This permit exists only in the original confirmed rule dispatcher. It grants
// no protection bypass: only its exact already-journaled native request may pass
// its own uncertainty fence. Native/SSH/background writers remain independent.
type protectionDispatchPermit struct {
	id, user, actor, repository int64
	forge, method, path         string
	payload                     [32]byte
}
type protectionDispatchPermitKey struct{}

func protectionPayloadHash(input any) ([32]byte, error) {
	data, err := json.Marshal(input)
	return sha256.Sum256(data), err
}

func (s *Server) protectionDispatchAllowed(ctx context.Context, db workflowQueryer, repository int64) error {
	var id, user, actor int64
	var phase string
	err := db.QueryRowContext(ctx, `SELECT id,user_id,actor_id,phase FROM golf_repository_rule_mutations WHERE forge_url=$1 AND repository_id=$2 AND phase IN ('RESERVED','DISPATCH_UNKNOWN')`, s.config.GiteaURL, repository).Scan(&id, &user, &actor, &phase)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return errStorageUnavailable
	}
	permit, ok := ctx.Value(protectionDispatchPermitKey{}).(protectionDispatchPermit)
	if !ok || permit.id != id || permit.user != user || permit.actor != actor || permit.repository != repository || permit.forge != s.config.GiteaURL || phase != "DISPATCH_UNKNOWN" {
		return errLifecycleBlocked
	}
	return nil
}

func validateProtectionDispatchRequest(ctx context.Context, method, path string, input any) error {
	permit, ok := ctx.Value(protectionDispatchPermitKey{}).(protectionDispatchPermit)
	if !ok {
		return nil
	}
	digest, err := protectionPayloadHash(input)
	if err != nil || method != permit.method || path != permit.path || digest != permit.payload {
		return errLifecycleBlocked
	}
	return nil
}
