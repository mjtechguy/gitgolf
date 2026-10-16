package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

const maxRepositoryEventBytes = 1 << 20

var repositoryEventSecret = regexp.MustCompile(`^[A-Za-z0-9_-]{32,256}$`)
var repositoryEventSignature = regexp.MustCompile(`^[0-9a-f]{64}$`)

type repositoryEventConnection struct {
	ID           string `json:"id"`
	RepositoryID string `json:"repositoryId"`
	OwnerID      string `json:"ownerId"`
	Repository   string `json:"repository"`
	Secret       string `json:"secret"`
	repoID       int64
	ownerID      int64
}

func canonicalEventUUID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id != uuid.Nil && id.String() == value
}

// Binding IDs survive restart and secret rotation, but cannot silently be
// repurposed for another repository, owner, name or configured forge.
func (s *Server) configureRepositoryEvents() error {
	s.repositoryEventConnections = map[string]repositoryEventConnection{}
	if s.config.RepositoryEventConnectionsJSON == "" {
		return nil
	}
	bad := errors.New("repository event configuration must be a bounded array of unique immutable repository bindings and distinct random signing secrets")
	raw := []byte(s.config.RepositoryEventConnectionsJSON)
	if len(raw) > 128<<10 || !boundedRepositoryEventJSON(raw) {
		return bad
	}
	var connections []repositoryEventConnection
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&connections); err != nil || connections == nil || len(connections) > 128 {
		return bad
	}
	repositories, secrets := map[int64]bool{}, map[string]bool{}
	for _, connection := range connections {
		var err error
		connection.repoID, err = discussionID(connection.RepositoryID)
		if err != nil {
			return bad
		}
		connection.ownerID, err = discussionID(connection.OwnerID)
		if err != nil {
			return bad
		}
		parts := strings.Split(connection.Repository, "/")
		if !canonicalEventUUID(connection.ID) || !repositoryEventSecret.MatchString(connection.Secret) || len(parts) != 2 {
			return bad
		}
		if _, err := repositoryPath(repositoryKey{Owner: parts[0], Name: parts[1]}); err != nil {
			return bad
		}
		if _, exists := s.repositoryEventConnections[connection.ID]; exists || repositories[connection.repoID] || secrets[connection.Secret] {
			return bad
		}
		s.repositoryEventConnections[connection.ID], repositories[connection.repoID], secrets[connection.Secret] = connection, true, true
	}
	if len(connections) == 0 {
		return nil
	}
	if s.db == nil {
		// serve validates configuration once before opening PostgreSQL. The
		// real server repeats registration with its DB; intake itself fails503
		// if no durable store is attached.
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return errStorageUnavailable
	}
	defer tx.Rollback()
	// Startup replicas acquire conflicting connection keys in the same order,
	// even when their JSON arrays list the same binding set differently.
	slices.SortFunc(connections, func(a, b repositoryEventConnection) int { return strings.Compare(a.ID, b.ID) })
	for _, input := range connections {
		connection := s.repositoryEventConnections[input.ID]
		_, err = tx.ExecContext(ctx, `INSERT INTO golf_repository_event_connections(id,forge_url,repository_id,owner_id,repository) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`, connection.ID, s.config.ForgeURL, connection.repoID, connection.ownerID, connection.Repository)
		if err != nil {
			return errStorageUnavailable
		}
		var forge, repository string
		var repositoryID, ownerID int64
		if err := tx.QueryRowContext(ctx, `SELECT forge_url,repository_id,owner_id,repository FROM golf_repository_event_connections WHERE id=$1`, connection.ID).Scan(&forge, &repositoryID, &ownerID, &repository); err != nil {
			return errStorageUnavailable
		}
		if forge != s.config.ForgeURL || repositoryID != connection.repoID || ownerID != connection.ownerID || repository != connection.Repository {
			return errors.New("repository event connection ID is already bound to a different immutable resource")
		}
	}
	if tx.Commit() != nil {
		return errStorageUnavailable
	}
	return nil
}

// Reject duplicate object keys and bound nesting/token work before selecting
// fields. Native payload extensions are allowed; private payloads are never
// retained, interpreted as source, followed as URLs or echoed in responses.
func boundedRepositoryEventJSON(raw []byte) bool {
	if !utf8.Valid(raw) {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	nodes := 0
	var value func(int) bool
	value = func(depth int) bool {
		nodes++
		if depth > 32 || nodes > 65536 {
			return false
		}
		token, err := decoder.Token()
		if err != nil {
			return false
		}
		delim, compound := token.(json.Delim)
		if !compound {
			return true
		}
		if delim != '{' && delim != '[' {
			return false
		}
		keys := map[string]bool{}
		for decoder.More() {
			if delim == '{' {
				nodes++
				key, err := decoder.Token()
				name, ok := key.(string)
				if err != nil || !ok || keys[name] {
					return false
				}
				keys[name] = true
			}
			if !value(depth + 1) {
				return false
			}
		}
		end, err := decoder.Token()
		return err == nil && (delim == '{' && end == json.Delim('}') || delim == '[' && end == json.Delim(']'))
	}
	if !value(0) {
		return false
	}
	_, err := decoder.Token()
	return errors.Is(err, io.EOF)
}

type repositoryPushEvent struct {
	Ref        string `json:"ref"`
	Before     string `json:"before"`
	After      string `json:"after"`
	Repository struct {
		ID       int64  `json:"id"`
		Name     string `json:"name"`
		FullName string `json:"full_name"`
		Owner    struct {
			ID    int64  `json:"id"`
			Login string `json:"login"`
		} `json:"owner"`
	} `json:"repository"`
	Sender struct {
		ID int64 `json:"id"`
	} `json:"sender"`
}

func (s *Server) repositoryEventWebhook(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	fail := func(status int) { respond(w, status, map[string]string{"status": "rejected"}) }
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		fail(http.StatusMethodNotAllowed)
		return
	}
	connection, configured := s.repositoryEventConnections[chi.URLParam(r, "connectionID")]
	if !configured {
		fail(http.StatusNotFound)
		return
	}
	headerBytes := len(r.Host)
	for key, values := range r.Header {
		headerBytes += len(key)
		for _, value := range values {
			headerBytes += len(value)
		}
	}
	if headerBytes > 16<<10 || len(r.Header) > 64 {
		fail(http.StatusRequestHeaderFieldsTooLarge)
		return
	}
	if r.URL.RawQuery != "" || r.URL.EscapedPath() != "/hooks/forgejo/"+connection.ID || len(r.Header.Values("Cookie")) != 0 || len(r.Header.Values("Authorization")) != 0 || len(r.Header.Values("Content-Encoding")) != 0 {
		fail(http.StatusBadRequest)
		return
	}
	// Forgejo 15 signs and labels deliveries with these headers; each must appear exactly once.
	for _, header := range []string{"Content-Type", "X-Forgejo-Delivery", "X-Forgejo-Event", "X-Forgejo-Event-Type", "X-Forgejo-Signature"} {
		if len(r.Header.Values(header)) != 1 {
			fail(http.StatusBadRequest)
			return
		}
	}
	mediaType, parameters, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" || len(parameters) > 1 || (len(parameters) == 1 && !strings.EqualFold(parameters["charset"], "utf-8")) {
		fail(http.StatusUnsupportedMediaType)
		return
	}
	delivery := r.Header.Get("X-Forgejo-Delivery")
	if !canonicalEventUUID(delivery) || r.Header.Get("X-Forgejo-Event") != "push" || r.Header.Get("X-Forgejo-Event-Type") != "push" {
		fail(http.StatusBadRequest)
		return
	}
	signature := r.Header.Get("X-Forgejo-Signature")
	if !repositoryEventSignature.MatchString(signature) {
		fail(http.StatusUnauthorized)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRepositoryEventBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			fail(http.StatusRequestEntityTooLarge)
		} else {
			fail(http.StatusBadRequest)
		}
		return
	}
	wanted := hmac.New(sha256.New, []byte(connection.Secret))
	wanted.Write(body)
	provided, _ := hex.DecodeString(signature)
	if !hmac.Equal(wanted.Sum(nil), provided) {
		fail(http.StatusUnauthorized)
		return
	}
	var payload repositoryPushEvent
	if !boundedRepositoryEventJSON(body) || json.Unmarshal(body, &payload) != nil ||
		payload.Repository.ID != connection.repoID || payload.Repository.Owner.ID != connection.ownerID ||
		payload.Repository.FullName != connection.Repository || payload.Repository.Owner.Login+"/"+payload.Repository.Name != connection.Repository ||
		payload.Sender.ID <= 0 || !validRef(payload.Ref) ||
		!(strings.HasPrefix(payload.Ref, "refs/heads/") || strings.HasPrefix(payload.Ref, "refs/tags/")) ||
		!objectID.MatchString(payload.Before) || !objectID.MatchString(payload.After) || len(payload.Before) != len(payload.After) ||
		(strings.Trim(payload.Before, "0") == "" && strings.Trim(payload.After, "0") == "") {
		fail(http.StatusBadRequest)
		return
	}
	if s.db == nil {
		fail(http.StatusServiceUnavailable)
		return
	}
	digest := sha256.Sum256(body)
	payloadHash := hex.EncodeToString(digest[:])
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(http.StatusServiceUnavailable)
		return
	}
	defer tx.Rollback()
	var id int64
	err = tx.QueryRowContext(r.Context(), `INSERT INTO golf_repository_events(connection_id,delivery_id,payload_sha256,payload_bytes,event_type,ref,before_commit_id,after_commit_id,sender_id) VALUES($1,$2,$3,$4,'push',$5,$6,$7,$8) ON CONFLICT(connection_id,delivery_id) DO NOTHING RETURNING id`, connection.ID, delivery, payloadHash, len(body), payload.Ref, payload.Before, payload.After, payload.Sender.ID).Scan(&id)
	status := http.StatusAccepted
	if errors.Is(err, sql.ErrNoRows) {
		var recorded string
		err = tx.QueryRowContext(r.Context(), `SELECT payload_sha256 FROM golf_repository_events WHERE connection_id=$1 AND delivery_id=$2`, connection.ID, delivery).Scan(&recorded)
		if err == nil && recorded != payloadHash {
			fail(http.StatusConflict)
			return
		}
		status = http.StatusNoContent
	}
	if err == nil && status != http.StatusNoContent {
		var canonical int64
		err = tx.QueryRowContext(r.Context(), `INSERT INTO golf_repository_event_payloads(connection_id,payload_sha256,event_id,push_admission_requested) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_id`, connection.ID, payloadHash, id, s.config.PushCIEnabled).Scan(&canonical)
		if errors.Is(err, sql.ErrNoRows) {
			// A relabeled native redelivery is the same signed payload. Roll back
			// this extra receipt rather than manufacture another admission.
			_ = tx.Rollback()
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	if err != nil || tx.Commit() != nil {
		fail(http.StatusServiceUnavailable)
		return
	}
	if status == http.StatusNoContent {
		w.WriteHeader(status)
		return
	}
	respond(w, status, map[string]string{"status": "recorded", "execution": "unavailable"})
}
