package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

type webhookPrivate struct{ Endpoint, SigningSecret string }

func webhookBinding(id string, version int64) []byte {
	h := sha256.Sum256([]byte("golf:webhook:v1\x00" + id + "\x00" + strconv.FormatInt(version, 10)))
	return h[:]
}
func webhookTopics(values []string) ([]string, error) {
	if len(values) < 1 || len(values) > 4 {
		return nil, invalid("Select one to four supported repository change topics.")
	}
	seen := map[string]bool{}
	for _, v := range values {
		if seen[v] || v != "source" && v != "issues" && v != "pulls" && v != "actions" {
			return nil, invalid("Select distinct source, issues, pulls or actions topics.")
		}
		seen[v] = true
	}
	out := append([]string(nil), values...)
	sort.Strings(out)
	return out, nil
}
func webhookKey(value string) bool {
	if len(value) < 32 || len(value) > 128 {
		return false
	}
	for _, r := range value {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("_-/+=", r)) {
			return false
		}
	}
	return true
}
func webhookTarget(t *golfv1.RepositoryWebhookTarget) (repositoryKey, int64, int64, error) {
	if t == nil {
		return repositoryKey{}, 0, 0, invalid("Select an exact repository target.")
	}
	key := keyFrom(t.Repository)
	if _, e := repositoryPath(key); e != nil {
		return key, 0, 0, e
	}
	repo, e := discussionID(t.RepositoryId)
	if e != nil {
		return key, 0, 0, e
	}
	owner, e := discussionID(t.OwnerId)
	return key, repo, owner, e
}
func wireWebhook(r database.GolfWebhookSubscription, host string) *golfv1.RepositoryWebhookSubscription {
	var topics []string
	_ = json.Unmarshal(r.EventTopics, &topics)
	return &golfv1.RepositoryWebhookSubscription{Id: r.ID.String(), Version: strconv.FormatInt(r.Version, 10), Name: r.Name, WorkflowNotifications: golfv1.WorkflowNotificationMode(r.WorkflowNotifications), DestinationHost: host, EventTopics: topics, Enabled: r.Enabled, AuthorizationState: r.AuthorizationState, HasSigningSecret: true, SponsorUserId: strconv.FormatInt(r.SponsorUserID, 10), CreatedAt: r.CreatedAt.UTC().Format(time.RFC3339Nano), UpdatedAt: r.UpdatedAt.UTC().Format(time.RFC3339Nano)}
}
func wireWebhookDelivery(r database.GolfWebhookDelivery) *golfv1.RepositoryWebhookDelivery {
	out := &golfv1.RepositoryWebhookDelivery{Id: r.ID.String(), SubscriptionId: r.SubscriptionID.String(), SubscriptionVersion: strconv.FormatInt(r.SubscriptionVersion, 10), EventId: r.EventID, EventTopic: r.EventTopic, State: r.State, Attempts: uint32(r.Attempts), ResponseStatus: uint32(r.ResponseStatus), FailureCode: r.FailureCode, PossibleDuplicate: r.PossibleDuplicate, CreatedAt: r.CreatedAt.UTC().Format(time.RFC3339Nano)}
	if r.State == "queued" || r.State == "retrying" {
		out.NextAttemptAt = r.NextAttemptAt.UTC().Format(time.RFC3339Nano)
	}
	if r.CompletedAt.Valid {
		out.CompletedAt = r.CompletedAt.Time.UTC().Format(time.RFC3339Nano)
	}
	return out
}
func (s *Server) withWebhookAdmin(ctx context.Context, header http.Header, t *golfv1.RepositoryWebhookTarget, fn func(forgeCredential, User, *golfv1.RepositoryAccess) error) error {
	key, repo, owner, e := webhookTarget(t)
	if e != nil {
		return e
	}
	token, e := rpcToken(ctx)
	if e != nil {
		return e
	}
	return s.withAutomationRepository(ctx, s.cookieValue(header), token, key, repo, owner, true, func(u User, a *golfv1.RepositoryAccess) error { return fn(token, u, a) })
}

func (s *Server) webhookSecret(ctx context.Context, q *database.Queries, id uuid.UUID, version int64) (webhookPrivate, database.GolfWebhookCredential, error) {
	row, e := q.GetWebhookCredential(ctx, database.GetWebhookCredentialParams{SubscriptionID: id, Version: version})
	if e != nil {
		return webhookPrivate{}, row, e
	}
	if !bytes.Equal(row.CredentialBinding, webhookBinding(id.String(), version)) {
		return webhookPrivate{}, row, errCredentialUnavailable
	}
	plain, e := s.keyring.open(row.CredentialKeyID, webhookCredentialDomain, row.EncryptedCredential, row.CredentialBinding)
	if e != nil {
		return webhookPrivate{}, row, e
	}
	var secret webhookPrivate
	if json.Unmarshal([]byte(plain), &secret) != nil || !webhookKey(secret.SigningSecret) {
		return secret, row, errCredentialUnavailable
	}
	return secret, row, nil
}
func (s *Server) ListRepositoryWebhooks(ctx context.Context, req *connect.Request[golfv1.ListRepositoryWebhooksRequest]) (*connect.Response[golfv1.ListRepositoryWebhooksResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	_, repo, owner, e := webhookTarget(req.Msg.Target)
	if e != nil {
		return nil, rpcError(e)
	}
	page, limit, e := pagination(pageFrom(req.Msg.Page))
	if e != nil {
		return nil, rpcError(e)
	}
	out := &golfv1.ListRepositoryWebhooksResponse{Target: req.Msg.Target, Page: &golfv1.PageResponse{}}
	e = s.withWebhookAdmin(ctx, req.Header(), req.Msg.Target, func(_ forgeCredential, _ User, _ *golfv1.RepositoryAccess) error {
		q := database.New(s.db)
		rows, e := q.ListWebhookSubscriptions(ctx, database.ListWebhookSubscriptionsParams{ForgeURL: s.config.GiteaURL, RepositoryID: repo, OwnerID: owner, RowLimit: int32(limit + 1), RowOffset: int32((page - 1) * limit)})
		if e != nil {
			return errStorageUnavailable
		}
		if len(rows) > int(limit) {
			out.Page.NextPage = page + 1
			rows = rows[:limit]
		}
		for _, r := range rows {
			credential, e := q.GetWebhookCredential(ctx, database.GetWebhookCredentialParams{SubscriptionID: r.ID, Version: r.Version})
			if e != nil {
				return errStorageUnavailable
			}
			out.Subscriptions = append(out.Subscriptions, wireWebhook(r, credential.DestinationHost))
		}
		hash, e := s.authSessionHash(ctx, s.cookieValue(req.Header()), nil)
		if e != nil {
			return e
		}
		_, e = q.GetWebhookLocalAuthority(ctx, database.GetWebhookLocalAuthorityParams{TokenHash: hash, ForgeURL: s.config.GiteaURL})
		out.BackgroundAuthorizationSupported = e == nil
		if e != nil && !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		return nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(out), nil
}
func (s *Server) SaveRepositoryWebhook(ctx context.Context, req *connect.Request[golfv1.SaveRepositoryWebhookRequest]) (*connect.Response[golfv1.SaveRepositoryWebhookResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	m := req.Msg
	key, repo, owner, e := webhookTarget(m.Target)
	if e != nil {
		return nil, rpcError(e)
	}
	if !creationKey.MatchString(m.Id) {
		return nil, rpcError(invalid("Select a canonical subscription ID."))
	}
	version, e := strconv.ParseInt(m.ExpectedVersion, 10, 64)
	if e != nil || version < 0 || version == 9223372036854775807 || strconv.FormatInt(version, 10) != m.ExpectedVersion || m.Name == "" || strings.TrimSpace(m.Name) != m.Name || !discussionText(m.Name, 120) {
		return nil, rpcError(invalid("Provide a subscription name and exact saved version."))
	}
	topics, e := webhookTopics(m.EventTopics)
	if e != nil {
		return nil, rpcError(e)
	}
	if _, e = workflowNotificationMode(m.WorkflowNotifications, 0); e != nil {
		return nil, rpcError(e)
	}
	encodedTopics, _ := json.Marshal(topics)
	if m.Enabled && !m.AuthorizeBackground {
		return nil, rpcError(invalid("Explicitly authorize background delivery for an enabled subscription."))
	}
	if m.SigningSecret != "" && !webhookKey(m.SigningSecret) {
		return nil, rpcError(invalid("Use a signing secret of 32–128 ASCII key characters."))
	}
	out := &golfv1.SaveRepositoryWebhookResponse{Target: m.Target}
	e = s.withWebhookAdmin(ctx, req.Header(), m.Target, func(token forgeCredential, actor User, _ *golfv1.RepositoryAccess) error {
		return s.withManagedSession(ctx, s.cookieValue(req.Header()), token, func(q *database.Queries, caller database.LockManagedSessionRow, hash []byte) error {
			authority, e := q.GetWebhookLocalAuthority(ctx, database.GetWebhookLocalAuthorityParams{TokenHash: hash, ForgeURL: s.config.GiteaURL})
			if errors.Is(e, sql.ErrNoRows) {
				return invalid("Background webhook authorization currently requires a local Golf account.")
			}
			if e != nil {
				return errStorageUnavailable
			}
			if authority.ForgeUserID != actor.ID {
				return errUnauthenticated
			}
			if e = q.LockWebhookConfiguration(ctx); e != nil {
				return errStorageUnavailable
			}
			id := uuid.MustParse(m.Id)
			row, e := q.LockWebhookSubscription(ctx, database.LockWebhookSubscriptionParams{ID: id, ForgeURL: s.config.GiteaURL, RepositoryID: repo})
			exists := e == nil
			if e != nil && !errors.Is(e, sql.ErrNoRows) {
				return errStorageUnavailable
			}
			if exists && (version == 0 || row.Version != version || row.OwnerID != owner) || !exists && version != 0 {
				return errRepositorySettingsConflict
			}
			mode, e := workflowNotificationMode(m.WorkflowNotifications, row.WorkflowNotifications)
			if e != nil {
				return e
			}
			secret := webhookPrivate{Endpoint: m.Endpoint, SigningSecret: m.SigningSecret}
			if exists {
				prior, _, e := s.webhookSecret(ctx, q, id, version)
				if e != nil {
					return errCredentialUnavailable
				}
				if secret.Endpoint == "" {
					secret.Endpoint = prior.Endpoint
				}
				if secret.SigningSecret == "" {
					secret.SigningSecret = prior.SigningSecret
				}
			}
			u, e := s.webhookNet().url(secret.Endpoint)
			if e != nil {
				return e
			}
			if !webhookKey(secret.SigningSecret) {
				return invalid("A new subscription requires a signing secret.")
			}
			lookup, cancel := context.WithTimeout(ctx, 5*time.Second)
			_, e = s.webhookNet().addresses(lookup, u)
			cancel()
			if e != nil {
				return e
			}
			next := version + 1
			if !exists {
				count, e := q.CountWebhookSubscriptions(ctx, database.CountWebhookSubscriptionsParams{ForgeURL: s.config.GiteaURL, RepositoryID: repo})
				if e != nil {
					return errStorageUnavailable
				}
				if count.RepositoryCount >= 20 || count.InstanceCount >= 5000 {
					return connect.NewError(connect.CodeResourceExhausted, errors.New("Webhook subscription limit reached."))
				}
				e = q.CreateWebhookSubscription(ctx, database.CreateWebhookSubscriptionParams{ID: id, ForgeURL: s.config.GiteaURL, RepositoryID: repo, OwnerID: owner, RepositoryOwner: key.Owner, RepositoryName: key.Name, Name: m.Name, EventTopics: encodedTopics, WorkflowNotifications: mode, SponsorUserID: caller.UserID, SponsorNativeID: actor.ID, LocalAccountID: authority.ID, CredentialVersion: authority.CredentialVersion})
				if e != nil {
					return errStorageUnavailable
				}
			}
			plain, _ := json.Marshal(secret)
			binding := webhookBinding(m.Id, next)
			cipher, keyID, e := s.keyring.seal(webhookCredentialDomain, string(plain), binding)
			if e != nil {
				return e
			}
			if e = q.CreateWebhookCredential(ctx, database.CreateWebhookCredentialParams{SubscriptionID: id, Version: next, DestinationHost: u.Hostname(), EncryptedCredential: cipher, CredentialBinding: binding, CredentialKeyID: keyID}); e != nil {
				return errStorageUnavailable
			}
			if e = q.CancelPreviousWebhookDeliveries(ctx, id); e != nil {
				return errStorageUnavailable
			}
			state := "disabled"
			if m.Enabled {
				state = "authorized"
			}
			expected := version
			if !exists {
				expected = 1
			}
			count, e := q.UpdateWebhookSubscription(ctx, database.UpdateWebhookSubscriptionParams{ID: id, RepositoryOwner: key.Owner, RepositoryName: key.Name, Name: m.Name, Version: next, EventTopics: encodedTopics, WorkflowNotifications: mode, Enabled: m.Enabled, AuthorizationState: state, SponsorUserID: caller.UserID, SponsorNativeID: actor.ID, LocalAccountID: authority.ID, CredentialVersion: authority.CredentialVersion, ExpectedVersion: expected})
			if e != nil || count != 1 {
				return errStorageUnavailable
			}
			saved, e := q.LockWebhookSubscription(ctx, database.LockWebhookSubscriptionParams{ID: id, ForgeURL: s.config.GiteaURL, RepositoryID: repo})
			if e != nil {
				return errStorageUnavailable
			}
			if e = q.RecordWebhookConfiguration(ctx, database.RecordWebhookConfigurationParams{SubscriptionID: id, Version: next, SponsorUserID: caller.UserID, Enabled: m.Enabled, EventTopics: encodedTopics, WorkflowNotifications: mode}); e != nil {
				return errStorageUnavailable
			}
			out.Subscription = wireWebhook(saved, u.Hostname())
			return nil
		})
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(out), nil
}
func (s *Server) ListRepositoryWebhookDeliveries(ctx context.Context, req *connect.Request[golfv1.ListRepositoryWebhookDeliveriesRequest]) (*connect.Response[golfv1.ListRepositoryWebhookDeliveriesResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	_, repo, owner, e := webhookTarget(req.Msg.Target)
	if e != nil {
		return nil, rpcError(e)
	}
	if !creationKey.MatchString(req.Msg.SubscriptionId) {
		return nil, rpcError(invalid("Select a canonical subscription ID."))
	}
	page, limit, e := pagination(pageFrom(req.Msg.Page))
	if e != nil {
		return nil, rpcError(e)
	}
	out := &golfv1.ListRepositoryWebhookDeliveriesResponse{Target: req.Msg.Target, Page: &golfv1.PageResponse{}}
	e = s.withWebhookAdmin(ctx, req.Header(), req.Msg.Target, func(_ forgeCredential, _ User, _ *golfv1.RepositoryAccess) error {
		q := database.New(s.db)
		id := uuid.MustParse(req.Msg.SubscriptionId)
		sub, e := q.LockWebhookSubscription(ctx, database.LockWebhookSubscriptionParams{ID: id, ForgeURL: s.config.GiteaURL, RepositoryID: repo})
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if e != nil {
			return errStorageUnavailable
		}
		if sub.OwnerID != owner {
			return errResourceNotFound
		}
		rows, e := q.ListWebhookDeliveries(ctx, database.ListWebhookDeliveriesParams{SubscriptionID: id, RowLimit: int32(limit + 1), RowOffset: int32((page - 1) * limit)})
		if e != nil {
			return errStorageUnavailable
		}
		if len(rows) > int(limit) {
			out.Page.NextPage = page + 1
			rows = rows[:limit]
		}
		for _, r := range rows {
			out.Deliveries = append(out.Deliveries, wireWebhookDelivery(r))
		}
		return nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(out), nil
}

func (s *Server) queueWebhook(ctx context.Context, header http.Header, target *golfv1.RepositoryWebhookTarget, subscriptionID, deliveryID, expectedVersion, operation string) (*golfv1.RepositoryWebhookDelivery, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	_, repo, owner, e := webhookTarget(target)
	if e != nil {
		return nil, e
	}
	version, e := discussionID(expectedVersion)
	if e != nil {
		return nil, e
	}
	if !creationKey.MatchString(operation) || subscriptionID != "" && !creationKey.MatchString(subscriptionID) || deliveryID != "" && !creationKey.MatchString(deliveryID) {
		return nil, invalid("Select canonical subscription, delivery and operation identities.")
	}
	kind := "test"
	selected := subscriptionID
	if deliveryID != "" {
		kind = "redeliver"
		selected = deliveryID
	}
	h := sha256.Sum256([]byte(kind + "/" + target.RepositoryId + "/" + selected + "/" + expectedVersion))
	var out *golfv1.RepositoryWebhookDelivery
	e = s.withWebhookAdmin(ctx, header, target, func(token forgeCredential, _ User, _ *golfv1.RepositoryAccess) error {
		return s.withManagedSession(ctx, s.cookieValue(header), token, func(q *database.Queries, caller database.LockManagedSessionRow, _ []byte) error {
			op := uuid.MustParse(operation)
			existing, e := q.GetExplicitWebhookOperation(ctx, database.GetExplicitWebhookOperationParams{RequestedBy: sql.NullInt64{Int64: caller.UserID, Valid: true}, OperationID: uuid.NullUUID{UUID: op, Valid: true}})
			if e == nil {
				if !bytes.Equal(existing.OperationFingerprint, h[:]) {
					return invalid("This operation identity belongs to a different webhook action.")
				}
				sub, e := q.LockWebhookSubscription(ctx, database.LockWebhookSubscriptionParams{ID: existing.SubscriptionID, ForgeURL: s.config.GiteaURL, RepositoryID: repo})
				if e != nil || sub.OwnerID != owner {
					return errResourceNotFound
				}
				out = wireWebhookDelivery(existing)
				return nil
			}
			if !errors.Is(e, sql.ErrNoRows) {
				return errStorageUnavailable
			}
			eventID := "test:" + operation
			topic := "test"
			body, _ := json.Marshal(map[string]string{"schema": "golf.webhook.v1", "event": "golf.webhook.test", "event_id": eventID})
			if deliveryID != "" {
				prior, e := q.GetWebhookDelivery(ctx, uuid.MustParse(deliveryID))
				if e != nil {
					return errResourceNotFound
				}
				subscriptionID = prior.SubscriptionID.String()
				eventID = prior.EventID
				topic = prior.EventTopic
				body = prior.Payload
			}
			// Queue capacity and subscription locks use the same order as the
			// transactional activity outbox, avoiding an FK/advisory deadlock.
			if e = q.LockWebhookQueue(ctx, uuid.MustParse(subscriptionID)); e != nil {
				return errStorageUnavailable
			}
			sub, e := q.LockWebhookSubscription(ctx, database.LockWebhookSubscriptionParams{ID: uuid.MustParse(subscriptionID), ForgeURL: s.config.GiteaURL, RepositoryID: repo})
			if errors.Is(e, sql.ErrNoRows) {
				return errResourceNotFound
			}
			if e != nil {
				return errStorageUnavailable
			}
			if sub.OwnerID != owner {
				return errResourceNotFound
			}
			if sub.Version != version {
				return errRepositorySettingsConflict
			}
			if !sub.Enabled || sub.AuthorizationState != "authorized" {
				return invalid("Enable and explicitly authorize this subscription before queueing delivery.")
			}
			// Retrying is an explicit new delivery, preserving the original immutable
			// event and payload. Receiver acceptance is not exactly-once human receipt.
			e = q.CreateExplicitWebhookDelivery(ctx, database.CreateExplicitWebhookDeliveryParams{ID: op, SubscriptionID: sub.ID, SubscriptionVersion: sub.Version, Epoch: sub.Epoch, EventID: eventID, EventTopic: topic, Payload: body, OperationID: uuid.NullUUID{UUID: op, Valid: true}, OperationFingerprint: h[:], RequestedBy: sql.NullInt64{Int64: caller.UserID, Valid: true}})
			if e != nil {
				return errStorageUnavailable
			}
			row, e := q.GetWebhookDelivery(ctx, op)
			if e != nil {
				return errStorageUnavailable
			}
			out = wireWebhookDelivery(row)
			return nil
		})
	})
	return out, e
}
func (s *Server) TestRepositoryWebhook(ctx context.Context, req *connect.Request[golfv1.TestRepositoryWebhookRequest]) (*connect.Response[golfv1.TestRepositoryWebhookResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	m := req.Msg
	out, e := s.queueWebhook(ctx, req.Header(), m.Target, m.SubscriptionId, "", m.ExpectedVersion, m.OperationId)
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.TestRepositoryWebhookResponse{Target: m.Target, Delivery: out}), nil
}
func (s *Server) RedeliverRepositoryWebhook(ctx context.Context, req *connect.Request[golfv1.RedeliverRepositoryWebhookRequest]) (*connect.Response[golfv1.RedeliverRepositoryWebhookResponse], error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	m := req.Msg
	out, e := s.queueWebhook(ctx, req.Header(), m.Target, "", m.DeliveryId, m.ExpectedVersion, m.OperationId)
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(&golfv1.RedeliverRepositoryWebhookResponse{Target: m.Target, Delivery: out}), nil
}
