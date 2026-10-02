package server

import (
	"context"
	"crypto/rsa"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"golang.org/x/crypto/ssh"
)

// Only public authentication keys cross this boundary. The existing SSH parser
// validates the wire key; explicit bounds/types reject options, certs and DSA.
func normalizeSSHKey(value string) (string, string, error) {
	if len(value) == 0 || len(value) > 8192 || strings.ContainsAny(strings.TrimSpace(value), "\r\n") {
		return "", "", invalid("Provide one OpenSSH public key, at most 8192 bytes.")
	}
	key, _, options, rest, err := ssh.ParseAuthorizedKey([]byte(value))
	if err != nil || len(options) != 0 || len(strings.TrimSpace(string(rest))) != 0 {
		return "", "", invalid("Provide an OpenSSH public key without options. Never paste a private key.")
	}
	switch key.Type() {
	case ssh.KeyAlgoED25519, ssh.KeyAlgoECDSA256, ssh.KeyAlgoECDSA384, ssh.KeyAlgoECDSA521, ssh.KeyAlgoSKED25519, ssh.KeyAlgoSKECDSA256:
	case ssh.KeyAlgoRSA:
		cryptoKey, ok := key.(ssh.CryptoPublicKey)
		if !ok {
			return "", "", invalid("Unsupported SSH public key.")
		}
		rsaKey, ok := cryptoKey.CryptoPublicKey().(*rsa.PublicKey)
		if !ok || rsaKey.N.BitLen() < 2048 {
			return "", "", invalid("RSA SSH keys must contain at least 2048 bits.")
		}
	default:
		return "", "", invalid("Use an Ed25519, ECDSA, security-key or RSA authentication key. Certificates and DSA are not supported.")
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))), ssh.FingerprintSHA256(key), nil
}

type forgeSSHKey struct {
	ID          int64  `json:"id"`
	Title       string `json:"title"`
	Key         string `json:"key"`
	Fingerprint string `json:"fingerprint"`
	CreatedAt   string `json:"created_at"`
	LastUsedAt  string `json:"last_used_at"`
	ReadOnly    bool   `json:"read_only"`
	KeyType     string `json:"key_type"`
	User        *User  `json:"user"`
}

func wireSSHKey(row forgeSSHKey, caller User) (*golfv1.SSHKey, error) {
	key, fingerprint, err := normalizeSSHKey(row.Key)
	if err != nil || row.ID <= 0 || row.User == nil || row.User.ID != caller.ID || row.KeyType != "user" ||
		(row.Title == "" || !discussionText(row.Title, 1024)) || row.Fingerprint != fingerprint || !validPullTime(row.CreatedAt) || !validPullTime(row.LastUsedAt) {
		return nil, errInvalidForgeResponse
	}
	return &golfv1.SSHKey{Id: strconv.FormatInt(row.ID, 10), Title: row.Title, PublicKey: key, Fingerprint: fingerprint,
		CreatedAt: row.CreatedAt, LastUsedAt: row.LastUsedAt}, nil
}

func (s *Server) readSSHKey(ctx context.Context, token forgeCredential, caller User, id string) (*golfv1.SSHKey, error) {
	var row forgeSSHKey
	_, err := s.forge(ctx, http.MethodGet, "/user/keys/"+id, token, nil, &row)
	if err != nil {
		return nil, err
	}
	if strconv.FormatInt(row.ID, 10) != id {
		return nil, errInvalidForgeResponse
	}
	// Even if the provider exposes another user's public key, never authorize
	// its deletion through this own-account service.
	if row.User == nil || row.User.ID != caller.ID {
		return nil, errResourceNotFound
	}
	return wireSSHKey(row, caller)
}

func (s *Server) ListSSHKeys(ctx context.Context, req *connect.Request[golfv1.ListSSHKeysRequest]) (*connect.Response[golfv1.ListSSHKeysResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	page, limit, err := pagination(pageFrom(req.Msg.Page))
	if err != nil {
		return nil, rpcError(err)
	}
	result := &golfv1.ListSSHKeysResponse{Page: wirePage(0)}
	err = s.withForgeCaller(ctx, s.cookieValue(req.Header()), token, func(caller User) error {
		var rows []forgeSSHKey
		headers, err := s.forge(ctx, http.MethodGet, "/user/keys?"+pageQuery(page, limit).Encode(), token, nil, &rows)
		if err != nil {
			return err
		}
		if rows == nil || len(rows) > int(limit) {
			return errInvalidForgeResponse
		}
		seen := map[int64]bool{}
		for _, row := range rows {
			if seen[row.ID] {
				return errInvalidForgeResponse
			}
			seen[row.ID] = true
			key, err := wireSSHKey(row, caller)
			if err != nil {
				return err
			}
			result.Keys = append(result.Keys, key)
		}
		next, err := organizationNextPage(headers, page)
		result.Page = wirePage(next)
		return err
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}

func (s *Server) AddSSHKey(ctx context.Context, req *connect.Request[golfv1.AddSSHKeyRequest]) (*connect.Response[golfv1.AddSSHKeyResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	if !validApiCredentialLabel(req.Msg.Title) {
		return nil, rpcError(invalid("SSH key title must be trimmed nonempty UTF-8, at most 64 bytes, without controls."))
	}
	key, fingerprint, err := normalizeSSHKey(req.Msg.PublicKey)
	if err != nil {
		return nil, rpcError(err)
	}
	result := &golfv1.AddSSHKeyResponse{}
	err = s.withForgeCaller(ctx, s.cookieValue(req.Header()), token, func(caller User) error {
		var row forgeSSHKey
		_, err := s.forgeJSON(ctx, http.MethodPost, "/user/keys", token, map[string]any{"title": req.Msg.Title, "key": key, "read_only": false}, &row, http.StatusCreated)
		var upstream forgeError
		if errors.As(err, &upstream) && upstream.status == 422 {
			return errSSHKeyRejected
		}
		if err != nil {
			return err
		}
		receipt, err := wireSSHKey(row, caller)
		if err != nil || receipt.PublicKey != key || receipt.Fingerprint != fingerprint || receipt.Title != req.Msg.Title || row.ReadOnly {
			return errInvalidForgeResponse
		}
		observed, err := s.readSSHKey(ctx, token, caller, receipt.Id)
		if err != nil {
			return err
		}
		if observed.PublicKey != key || observed.Title != req.Msg.Title {
			return errInvalidForgeResponse
		}
		result.Key = observed
		return nil
	})
	// No automatic retry after a lost POST receipt: the key may already exist.
	// The caller must refresh the key list before attempting another addition.
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(result), nil
}

func (s *Server) DeleteSSHKey(ctx context.Context, req *connect.Request[golfv1.DeleteSSHKeyRequest]) (*connect.Response[golfv1.DeleteSSHKeyResponse], error) {
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, err
	}
	id, err := strconv.ParseInt(req.Msg.KeyId, 10, 64)
	if err != nil || id <= 0 || strconv.FormatInt(id, 10) != req.Msg.KeyId {
		return nil, rpcError(invalid("SSH key ID must be a positive decimal identifier."))
	}
	err = s.withForgeCaller(ctx, s.cookieValue(req.Header()), token, func(caller User) error {
		if _, err := s.readSSHKey(ctx, token, caller, req.Msg.KeyId); err != nil {
			return err
		}
		_, err := s.forgeJSON(ctx, http.MethodDelete, "/user/keys/"+req.Msg.KeyId, token, nil, nil, http.StatusNoContent)
		if err != nil {
			return err
		}
		_, err = s.readSSHKey(ctx, token, caller, req.Msg.KeyId)
		var upstream forgeError
		if errors.As(err, &upstream) && upstream.status == 404 {
			return nil
		}
		if err != nil {
			return err
		}
		return errInvalidForgeResponse
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.DeleteSSHKeyResponse{}), nil
}
