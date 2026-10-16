package server

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/binary"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

var errWebhookLeaseLost = errors.New("Webhook delivery lease is no longer current.")

var errWebhookRevoked = errors.New("Webhook background authorization is unavailable.")

func (s *Server) webhookAuthority(ctx context.Context, id uuid.UUID, version, epoch int64) (forgeCredential, error) {
	var user, native, repo, owner, account, currentVersion, savedVersion int64
	var key, keyID, ownerName, repoName string
	var cipher, binding []byte
	e := s.db.QueryRowContext(ctx, `SELECT s.sponsor_user_id,s.sponsor_native_id,s.repository_id,s.owner_id,s.local_account_id,a.credential_version,s.credential_version,a.encrypted_forge_token,a.credential_binding,a.credential_key_id,s.repository_owner,s.repository_name
 FROM golf_webhook_subscriptions s JOIN golf_local_accounts a ON a.id=s.local_account_id AND a.user_id=s.sponsor_user_id JOIN golf_users u ON u.id=a.user_id
 WHERE s.id=$1 AND s.forge_url=$2 AND u.forge_url=s.forge_url AND u.forge_user_id=s.sponsor_native_id AND s.version=$3 AND s.epoch=$4 AND s.enabled AND s.authorization_state='authorized' AND a.disabled_at IS NULL AND NOT EXISTS(SELECT 1 FROM golf_user_access ga WHERE ga.user_id=u.id AND ga.suspended)`, id, s.config.ForgeURL, version, epoch).Scan(&user, &native, &repo, &owner, &account, &currentVersion, &savedVersion, &cipher, &binding, &keyID, &ownerName, &repoName)
	_ = account
	if errors.Is(e, sql.ErrNoRows) || e == nil && currentVersion != savedVersion {
		return forgeCredential{}, errWebhookRevoked
	}
	if e != nil {
		return forgeCredential{}, errStorageUnavailable
	}
	key, e = s.keyring.open(keyID, localAccountDomain, cipher, binding)
	if e != nil {
		return forgeCredential{}, errWebhookRevoked
	}
	token := forgeCredential{Kind: "pat", Token: key, Local: true}
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return token, e
	}
	if actor.ID != native {
		return token, errWebhookRevoked
	}
	access, e := s.readRepositoryAccess(ctx, token, repositoryKey{ownerName, repoName}, actor)
	if e != nil {
		return token, e
	}
	if access.RepositoryId != strconv.FormatInt(repo, 10) || access.OwnerId != strconv.FormatInt(owner, 10) || !automationGrantAdmin(access) {
		return token, errWebhookRevoked
	}
	if e := s.requireGolfUserAccess(ctx, s.db, user); e != nil {
		if errors.Is(e, errUnauthenticated) {
			return forgeCredential{}, errWebhookRevoked
		}
		return forgeCredential{}, e
	}
	return token, nil
}
func (s *Server) webhookDeliveryLive(ctx context.Context, d database.GolfWebhookDelivery) error {
	var ok, accessAllowed bool
	e := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_webhook_deliveries d JOIN golf_webhook_subscriptions s ON s.id=d.subscription_id JOIN golf_local_accounts a ON a.id=s.local_account_id AND a.user_id=s.sponsor_user_id WHERE d.id=$1 AND d.lease_id=$2 AND d.state='sending' AND d.lease_until>clock_timestamp() AND s.version=d.subscription_version AND s.epoch=d.epoch AND s.enabled AND s.authorization_state='authorized' AND a.disabled_at IS NULL AND a.credential_version=s.credential_version),NOT EXISTS(SELECT 1 FROM golf_webhook_subscriptions s JOIN golf_user_access ga ON ga.user_id=s.sponsor_user_id WHERE s.id=$3 AND ga.suspended)`, d.ID, d.LeaseID, d.SubscriptionID).Scan(&ok, &accessAllowed)
	if e != nil {
		return errStorageUnavailable
	}
	if !ok {
		return errWebhookLeaseLost
	}
	if !accessAllowed {
		return errWebhookRevoked
	}
	return nil
}
func (s *Server) claimWebhook(ctx context.Context) (database.GolfWebhookDelivery, error) {
	var out database.GolfWebhookDelivery
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return out, errStorageUnavailable
	}
	defer tx.Rollback()
	// A previously issued request may have been accepted. The original stable
	// delivery/event ID survives recovery, and the next attempt is explicitly at-least-once.
	if _, e = tx.ExecContext(ctx, `WITH expired AS (
 SELECT d.id,d.lease_id FROM golf_webhook_deliveries d JOIN golf_webhook_subscriptions s ON s.id=d.subscription_id WHERE s.forge_url=$1 AND d.state='sending' AND d.lease_until<=clock_timestamp() ORDER BY d.lease_until,d.id LIMIT 100 FOR UPDATE OF d SKIP LOCKED
 ), finished AS (
 UPDATE golf_webhook_attempts a SET completed_at=clock_timestamp(),outcome='lease_expired_uncertain' FROM expired x WHERE a.delivery_id=x.id AND a.lease_id=x.lease_id AND a.completed_at IS NULL RETURNING a.delivery_id
 ) UPDATE golf_webhook_deliveries d SET state=CASE WHEN d.attempts>=6 THEN 'failed' ELSE 'retrying' END,possible_duplicate=true,failure_code='lease_expired_uncertain',next_attempt_at=clock_timestamp(),completed_at=CASE WHEN d.attempts>=6 THEN clock_timestamp() ELSE NULL END FROM expired x WHERE d.id=x.id`, s.config.ForgeURL); e != nil {
		return out, errStorageUnavailable
	}
	if _, e = tx.ExecContext(ctx, `WITH obsolete AS (
 SELECT d.id FROM golf_webhook_deliveries d JOIN golf_webhook_subscriptions s ON s.id=d.subscription_id WHERE s.forge_url=$1 AND d.state IN ('queued','retrying') AND (NOT s.enabled OR s.authorization_state<>'authorized' OR s.version<>d.subscription_version OR s.epoch<>d.epoch) ORDER BY d.id LIMIT 100 FOR UPDATE OF d SKIP LOCKED
 ) UPDATE golf_webhook_deliveries d SET state='cancelled',failure_code='authorization_or_configuration_changed',completed_at=clock_timestamp() FROM obsolete x WHERE d.id=x.id`, s.config.ForgeURL); e != nil {
		return out, errStorageUnavailable
	}
	var id uuid.UUID
	e = tx.QueryRowContext(ctx, `SELECT d.id FROM golf_webhook_deliveries d JOIN golf_webhook_subscriptions s ON s.id=d.subscription_id WHERE s.forge_url=$1 AND d.state IN ('queued','retrying') AND d.attempts<6 AND d.next_attempt_at<=clock_timestamp() ORDER BY d.next_attempt_at,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED`, s.config.ForgeURL).Scan(&id)
	if errors.Is(e, sql.ErrNoRows) {
		if tx.Commit() != nil {
			return out, errStorageUnavailable
		}
		return out, sql.ErrNoRows
	}
	if e != nil {
		return out, e
	}
	lease := uuid.New()
	if _, e = tx.ExecContext(ctx, `UPDATE golf_webhook_deliveries SET state='sending',attempts=attempts+1,lease_id=$2,lease_until=clock_timestamp()+interval '30 seconds' WHERE id=$1`, id, lease); e != nil {
		return out, errStorageUnavailable
	}
	q := database.New(s.db).WithTx(tx)
	out, e = q.GetWebhookDelivery(ctx, id)
	if e != nil {
		return out, errStorageUnavailable
	}
	if _, e = tx.ExecContext(ctx, `INSERT INTO golf_webhook_attempts(delivery_id,attempt,lease_id) VALUES($1,$2,$3)`, id, out.Attempts, lease); e != nil {
		return out, errStorageUnavailable
	}
	if e = tx.Commit(); e != nil {
		return out, errStorageUnavailable
	}
	return out, nil
}
func webhookRetryDelay(attempt int32, retryAfter string, now time.Time) time.Duration {
	delay := time.Duration(5<<min(max(attempt-1, 0), 5)) * time.Second
	if seconds, e := strconv.ParseInt(retryAfter, 10, 64); e == nil && seconds >= 0 && seconds <= 3600 {
		delay = max(delay, time.Duration(seconds)*time.Second)
	} else if at, e := http.ParseTime(retryAfter); e == nil && at.After(now) && at.Before(now.Add(time.Hour)) {
		delay = max(delay, at.Sub(now))
	}
	// Positive bounded jitter avoids synchronized receivers after an outage; never
	// shortens the receiver's requested Retry-After interval.
	var sample [8]byte
	if _, e := rand.Read(sample[:]); e == nil {
		delay += time.Duration(binary.LittleEndian.Uint64(sample[:])%1000) * time.Millisecond
	}
	return min(delay, time.Hour)
}
func (s *Server) attemptWebhook(ctx context.Context, d database.GolfWebhookDelivery) {
	s.attemptWebhookOwned(ctx, d, nil)
}
func (s *Server) attemptWebhookOwned(ctx context.Context, d database.GolfWebhookDelivery, owner func(context.Context) error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	_, e := s.webhookAuthority(ctx, d.SubscriptionID, d.SubscriptionVersion, d.Epoch)
	secret, _, loadErr := s.webhookSecret(ctx, database.New(s.db), d.SubscriptionID, d.SubscriptionVersion)
	if e == nil {
		e = loadErr
	}
	status, reason := 0, "authority_unavailable"
	if e == nil {
		status, reason, e = s.webhookNet().deliver(ctx, secret.Endpoint, d.Payload, d.EventID, d.ID.String(), secret.SigningSecret, func(c context.Context) error {
			if owner != nil {
				if e := owner(c); e != nil {
					return e
				}
			}
			if e := s.webhookDeliveryLive(c, d); e != nil {
				return e
			}
			_, e := s.webhookAuthority(c, d.SubscriptionID, d.SubscriptionVersion, d.Epoch)
			return e
		})
	}
	if errors.Is(e, errWebhookLeaseLost) {
		return
	}
	state := "failed"
	failure := "receiver_rejected"
	duplicate := e != nil
	next := time.Now()
	if e == nil && status >= 200 && status < 300 {
		state = "accepted"
		failure = ""
	} else if e != nil || status == 408 || status == 429 || status >= 500 {
		state = "retrying"
		failure = "transport_uncertain"
		if e == nil {
			failure = "receiver_transient"
		}
		next = next.Add(webhookRetryDelay(d.Attempts, reason, time.Now()))
		if d.Attempts >= 6 {
			state = "failed"
			failure = "retry_budget_exhausted"
		}
	}
	// Destination validation refuses the URL/address/payload before HTTP bytes.
	// It is a terminal denial, not an uncertain receiver acknowledgment.
	if errors.Is(e, errWebhookDestination) {
		state = "failed"
		failure = "destination_denied"
		duplicate = false
	}
	if errors.Is(e, errWebhookRevoked) || errors.Is(e, errUnauthenticated) || webhookDenied(e) || sourceNotFound(e) {
		state = "cancelled"
		failure = "background_authority_revoked"
		pause, release := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
		_, _ = s.db.ExecContext(pause, `UPDATE golf_webhook_subscriptions SET enabled=false,authorization_state='authority_unavailable',epoch=epoch+1,updated_at=clock_timestamp() WHERE id=$1 AND version=$2 AND epoch=$3`, d.SubscriptionID, d.SubscriptionVersion, d.Epoch)
		release()
	}
	if e != nil && (reason == "destination_denied" || reason == "invalid_payload") {
		state = "failed"
		failure = reason
		duplicate = false
	}
	// Finalization uses a fresh bounded context and the exact claimed lease. A
	// late worker cannot overwrite a newer owner, and a lost SQL ACK is not success.
	finish, stop := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer stop()
	tx, e := s.db.BeginTx(finish, nil)
	if e != nil {
		return
	}
	defer tx.Rollback()
	result, e := tx.ExecContext(finish, `UPDATE golf_webhook_deliveries SET state=$3,response_status=$4,failure_code=$5,possible_duplicate=possible_duplicate OR $6,next_attempt_at=$7,completed_at=CASE WHEN $3 IN ('accepted','failed','cancelled') THEN clock_timestamp() ELSE NULL END WHERE id=$1 AND lease_id=$2 AND state='sending' AND lease_until>clock_timestamp()`, d.ID, d.LeaseID, state, status, failure, duplicate, next)
	if e != nil {
		return
	}
	count, e := result.RowsAffected()
	if e != nil || count != 1 {
		return
	}
	if _, e = tx.ExecContext(finish, `UPDATE golf_webhook_attempts SET completed_at=clock_timestamp(),response_status=$3,outcome=$4 WHERE delivery_id=$1 AND lease_id=$2`, d.ID, d.LeaseID, status, failure); e != nil {
		return
	}
	_ = tx.Commit()
}

// RunWebhookWorker is an actual PostgreSQL outbox consumer with two instance
// slots, short leases and bounded HTTP attempts. No transaction spans HTTP I/O.
func (s *Server) RunWebhookWorker(ctx context.Context) error {
	owner, e := s.db.Conn(ctx)
	if e != nil {
		return errStorageUnavailable
	}
	defer owner.Close()
	slot := int64(0)
	for _, candidate := range []int64{74191526730404000, 74191526730404001} {
		var ok bool
		if e = owner.QueryRowContext(ctx, `SELECT pg_try_advisory_lock($1)`, candidate).Scan(&ok); e != nil {
			return errStorageUnavailable
		}
		if ok {
			slot = candidate
			break
		}
	}
	if slot == 0 {
		return errors.New("Webhook delivery worker capacity is already owned.")
	}
	defer func() {
		release, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_, _ = owner.ExecContext(release, `SELECT pg_advisory_unlock($1)`, slot)
	}()
	timer := time.NewTicker(500 * time.Millisecond)
	defer timer.Stop()
	for {
		if ctx.Err() != nil {
			return nil
		}
		probe, cancel := context.WithTimeout(ctx, time.Second)
		var one int
		e = owner.QueryRowContext(probe, `SELECT 1`).Scan(&one)
		cancel()
		if e != nil {
			return errStorageUnavailable
		}
		d, e := s.claimWebhook(ctx)
		if e == nil {
			s.attemptWebhookOwned(ctx, d, func(c context.Context) error {
				var one int
				if owner.QueryRowContext(c, `SELECT 1`).Scan(&one) != nil {
					return errWebhookLeaseLost
				}
				return nil
			})
		} else if !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		select {
		case <-ctx.Done():
			return nil
		case <-timer.C:
		}
	}
}

func webhookDenied(e error) bool {
	var f forgeError
	return errors.As(e, &f) && (f.status == http.StatusUnauthorized || f.status == http.StatusForbidden)
}
