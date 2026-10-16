package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/mjtechguy/golf-git/internal/server/database"
)

var creationKey = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// Fixed field order and no omitted fields give exact input fingerprints. The
// description is sent to Forgejo but only its digest remains in operation storage.
type repositoryCreationInput struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Private     bool   `json:"private"`
	SourceURL   string `json:"source_url,omitempty"`
	PullMirror  bool   `json:"pull_mirror,omitempty"`
}

func repositoryCreationKey(value string) (string, error) {
	if value == "" {
		var random [16]byte
		if _, err := rand.Read(random[:]); err != nil {
			return "", errStorageUnavailable
		}
		random[6] = random[6]&0x0f | 0x40
		random[8] = random[8]&0x3f | 0x80
		value = fmt.Sprintf("%x-%x-%x-%x-%x", random[:4], random[4:6], random[6:8], random[8:10], random[10:])
	}
	if !creationKey.MatchString(value) {
		return "", invalid("Repository creation key must be a canonical lowercase UUID v4.")
	}
	return value, nil
}

func (s *Server) createRepository(ctx context.Context, session string, credential forgeCredential, name, description string, private *bool, key string, source string, pullMirror bool) (database.GolfRepositoryCreation, *Repository, error) {
	var record database.GolfRepositoryCreation
	if !repositoryName.MatchString(name) || len(description) > 2000 || !utf8.ValidString(description) || private == nil {
		return record, nil, invalid("Provide a 1–100 character repository name, description up to 2000 bytes, and explicit private boolean.")
	}
	keyed := key != ""
	key, err := repositoryCreationKey(key)
	if err != nil {
		return record, nil, err
	}
	canonicalSource, _, err := publicImportURL(source)
	if err != nil {
		return record, nil, err
	}
	if pullMirror && canonicalSource == "" {
		return record, nil, invalid("A pull mirror requires a public source project.")
	}
	input := repositoryCreationInput{Name: name, Description: description, Private: *private, SourceURL: canonicalSource, PullMirror: pullMirror}
	canonical, _ := json.Marshal(input)
	fingerprint := sha256.Sum256(canonical)
	owner, err := s.currentUser(ctx, credential)
	if err != nil {
		return record, nil, err
	}
	if _, err := repositoryPath(repositoryKey{owner.Login, name}); err != nil {
		return record, nil, errInvalidForgeResponse
	}
	dispatch := false
	err = s.withManagedSession(ctx, session, credential, func(queries *database.Queries, caller database.LockManagedSessionRow, _ []byte) error {
		var err error
		record, err = queries.ReserveRepositoryCreation(ctx, database.ReserveRepositoryCreationParams{
			UserID: caller.UserID, ForgeURL: s.config.ForgeURL, IdempotencyKey: key,
			PayloadFingerprint: fingerprint[:], RequestedName: name, Private: *private,
		})
		if errors.Is(err, sql.ErrNoRows) {
			record, err = queries.GetRepositoryCreation(ctx, database.GetRepositoryCreationParams{UserID: caller.UserID, ForgeURL: s.config.ForgeURL, IdempotencyKey: key})
			if err != nil {
				return errStorageUnavailable
			}
			if !bytes.Equal(record.PayloadFingerprint, fingerprint[:]) {
				return errRepositoryCreationConflict
			}
			return nil
		}
		if err != nil {
			return errStorageUnavailable
		}
		if err := queries.AppendRepositoryCreationEvent(ctx, database.AppendRepositoryCreationEventParams{CreationID: record.ID, State: record.State}); err != nil {
			return errStorageUnavailable
		}
		dispatch = true
		return nil
	})
	if err != nil {
		return database.GolfRepositoryCreation{}, nil, err
	}
	var providerErr error
	if dispatch {
		// OUTCOME_UNKNOWN is committed before any provider write. Neither this
		// path nor a replay retries the POST, including after process failure.
		var response struct {
			Repository
			Visibility *bool `json:"private"`
		}
		if canonicalSource == "" {
			_, providerErr = s.forge(ctx, "POST", "/user/repos", credential, input, &response)
		} else {
			providerErr = s.verifyPublicImport(ctx, canonicalSource)
			if providerErr == nil {
				_, providerErr = s.forgeJSON(ctx, "POST", "/repos/migrate", credential, map[string]any{"clone_addr": canonicalSource, "repo_name": name, "repo_owner": owner.Login, "description": description, "private": *private, "mirror": pullMirror}, &response, 201)
			}
		}
		if providerErr == nil {
			if response.Visibility == nil || response.ID <= 0 || response.Name != name || response.FullName != owner.Login+"/"+name || *response.Visibility != *private {
				providerErr = errInvalidForgeResponse
			} else {
				response.Repository.Private = *response.Visibility
			}
		}
		state, failure := "", ""
		if providerErr == nil {
			state = "SUCCEEDED"
		} else {
			var upstream forgeError
			if errors.As(providerErr, &upstream) {
				switch upstream.status {
				case 400, 401, 403, 404, 409, 422:
					state, failure = "REJECTED", "provider_http_"+strconv.Itoa(upstream.status)
				}
			}
		}
		if state != "" {
			// Persist an observed result despite client disconnect/revocation.
			// This is synchronous, bounded bookkeeping, never a provider retry.
			completion, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			err = s.completeRepositoryCreation(completion, record, state, failure, response.Repository)
			cancel()
			if err != nil {
				return database.GolfRepositoryCreation{}, nil, err
			}
		}
	}
	record, repo, err := s.getRepositoryCreation(ctx, session, credential, key)
	if err != nil {
		return database.GolfRepositoryCreation{}, nil, err
	}
	// Legacy callers require a repository on success and the original safe RPC
	// error on failure. Explicit-key callers inspect the durable state instead.
	if !keyed {
		if providerErr != nil {
			return database.GolfRepositoryCreation{}, nil, providerErr
		}
		if repo == nil {
			return database.GolfRepositoryCreation{}, nil, errResourceNotFound
		}
	}
	return record, repo, nil
}

func (s *Server) completeRepositoryCreation(ctx context.Context, record database.GolfRepositoryCreation, state, failure string, repo Repository) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return errStorageUnavailable
	}
	defer tx.Rollback()
	queries := database.New(s.db).WithTx(tx)
	params := database.CompleteRepositoryCreationParams{CreationID: record.ID, UserID: record.UserID, ForgeURL: s.config.ForgeURL, State: state, FailureCode: failure}
	if state == "SUCCEEDED" {
		params.RepositoryID = sql.NullInt64{Int64: repo.ID, Valid: true}
		params.RepositoryFullName = sql.NullString{String: repo.FullName, Valid: true}
	}
	updated, err := queries.CompleteRepositoryCreation(ctx, params)
	if err != nil {
		return errStorageUnavailable
	}
	if err := queries.AppendRepositoryCreationEvent(ctx, database.AppendRepositoryCreationEventParams{CreationID: updated.ID, State: updated.State}); err != nil {
		return errStorageUnavailable
	}
	if err := tx.Commit(); err != nil {
		return errStorageUnavailable
	}
	return nil
}

func (s *Server) getRepositoryCreation(ctx context.Context, session string, credential forgeCredential, key string) (database.GolfRepositoryCreation, *Repository, error) {
	var record database.GolfRepositoryCreation
	if !creationKey.MatchString(key) {
		return record, nil, invalid("Repository creation key must be a canonical lowercase UUID v4.")
	}
	read := func(queries *database.Queries, caller database.LockManagedSessionRow, _ []byte) error {
		var err error
		record, err = queries.GetRepositoryCreation(ctx, database.GetRepositoryCreationParams{UserID: caller.UserID, ForgeURL: s.config.ForgeURL, IdempotencyKey: key})
		if errors.Is(err, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if err != nil {
			return errStorageUnavailable
		}
		return nil
	}
	if err := s.withManagedSession(ctx, session, credential, read); err != nil {
		return database.GolfRepositoryCreation{}, nil, err
	}
	var repo *Repository
	if record.State == "SUCCEEDED" {
		parts := strings.Split(record.RepositoryFullName.String, "/")
		if len(parts) != 2 {
			return database.GolfRepositoryCreation{}, nil, errStorageUnavailable
		}
		current, err := s.getRepository(ctx, credential, repositoryKey{parts[0], parts[1]})
		if err == nil && current.ID == record.RepositoryID.Int64 && current.FullName == record.RepositoryFullName.String && current.Name == parts[1] {
			repo = &current
		}
		// An operation record is evidence, not access. Missing/renamed/replaced
		// native repositories expose no cached private snapshot.
		// A final provider identity and local session check still must succeed.
		if err := s.withManagedSession(ctx, session, credential, func(*database.Queries, database.LockManagedSessionRow, []byte) error { return nil }); err != nil {
			return database.GolfRepositoryCreation{}, nil, err
		}
		if err != nil {
			var upstream forgeError
			if !errors.As(err, &upstream) || (upstream.status != 401 && upstream.status != 403 && upstream.status != 404) {
				return database.GolfRepositoryCreation{}, nil, err
			}
		}
	}
	return record, repo, nil
}
