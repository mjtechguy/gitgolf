package server

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

type emailDelivery struct {
	ID                         string
	UserID                     int64
	Kind                       string
	ContactVersion             int64
	SubscriptionID             sql.NullString
	SubscriptionVersion, Epoch int64
	ChallengeID                sql.NullString
	EventID, Topic             string
	TransportID                sql.NullString
	TransportVersion           sql.NullInt64
	ActivationGeneration       int64
	ContentID                  sql.NullString
	State                      string
	Attempts                   int32
	NextAt                     time.Time
	LeaseID                    sql.NullString
	LeaseUntil                 sql.NullTime
	SMTPStatus                 int
	Failure                    string
	Duplicate                  bool
	RedeliveryOf               sql.NullString
	CreatedAt                  time.Time
	CompletedAt                sql.NullTime
}

const emailDeliveryColumns = "id::text,user_id,kind,contact_version,subscription_id::text,subscription_version,epoch,challenge_id::text,event_id,event_topic,transport_id::text,transport_version,activation_generation,content_id::text,state,attempts,next_attempt_at,lease_id::text,lease_until,smtp_status,failure_code,possible_duplicate,redelivery_of::text,created_at,completed_at"

func scanEmailDelivery(row interface{ Scan(...any) error }) (emailDelivery, error) {
	var d emailDelivery
	e := row.Scan(&d.ID, &d.UserID, &d.Kind, &d.ContactVersion, &d.SubscriptionID, &d.SubscriptionVersion, &d.Epoch, &d.ChallengeID, &d.EventID, &d.Topic, &d.TransportID, &d.TransportVersion, &d.ActivationGeneration, &d.ContentID, &d.State, &d.Attempts, &d.NextAt, &d.LeaseID, &d.LeaseUntil, &d.SMTPStatus, &d.Failure, &d.Duplicate, &d.RedeliveryOf, &d.CreatedAt, &d.CompletedAt)
	return d, e
}
func wireEmailDelivery(d emailDelivery) *golfv1.EmailDelivery {
	out := &golfv1.EmailDelivery{Id: d.ID, Kind: d.Kind, EventId: d.EventID, EventTopic: d.Topic, State: d.State, Attempts: uint32(d.Attempts), SmtpStatus: uint32(d.SMTPStatus), FailureCode: d.Failure, PossibleDuplicate: d.Duplicate, CreatedAt: d.CreatedAt.UTC().Format(time.RFC3339Nano), SubscriptionId: d.SubscriptionID.String, SubscriptionVersion: strconv.FormatInt(d.SubscriptionVersion, 10), ContactVersion: strconv.FormatInt(d.ContactVersion, 10), TransportId: d.TransportID.String, TransportVersion: strconv.FormatInt(d.TransportVersion.Int64, 10)}
	if d.State == "queued" || d.State == "retrying" {
		out.NextAttemptAt = d.NextAt.UTC().Format(time.RFC3339Nano)
	}
	if d.CompletedAt.Valid {
		out.CompletedAt = d.CompletedAt.Time.UTC().Format(time.RFC3339Nano)
	}
	return out
}
func (s *Server) emailAuthority(ctx context.Context, d emailDelivery) (emailAccount, error) {
	var a emailAccount
	var cipher, binding []byte
	var key string
	e := s.db.QueryRowContext(ctx, `SELECT c.user_id,c.native_user_id,c.local_account_id,c.credential_version,COALESCE(a.email,''),a.encrypted_forge_token,a.credential_binding,a.credential_key_id
 FROM golf_email_contacts c JOIN golf_local_accounts a ON a.id=c.local_account_id AND a.user_id=c.user_id JOIN golf_users u ON u.id=c.user_id
 WHERE c.user_id=$1 AND c.version=$2 AND u.forge_url=$3 AND u.forge_user_id=c.native_user_id AND a.disabled_at IS NULL AND a.credential_version=c.credential_version AND NOT EXISTS(SELECT 1 FROM golf_user_access ga WHERE ga.user_id=u.id AND ga.suspended)
 AND (( $4='verification' AND EXISTS(SELECT 1 FROM golf_email_challenges ch WHERE ch.id=$5::uuid AND ch.user_id=c.user_id AND ch.contact_version=c.version AND ch.confirmed_at IS NULL AND ch.expires_at>clock_timestamp() AND ch.attempts<5))
 OR ($4='activity' AND c.enabled AND c.verified_at IS NOT NULL AND c.suppression='' AND EXISTS(SELECT 1 FROM golf_email_subscriptions ss WHERE ss.id=$6::uuid AND ss.user_id=c.user_id AND ss.version=$7 AND ss.epoch=$8 AND ss.contact_version=c.version AND ss.local_account_id=c.local_account_id AND ss.native_user_id=c.native_user_id AND ss.credential_version=c.credential_version AND ss.enabled AND ss.authorization_state='authorized')))`, d.UserID, d.ContactVersion, s.config.GiteaURL, d.Kind, d.ChallengeID, d.SubscriptionID, d.SubscriptionVersion, d.Epoch).Scan(&a.UserID, &a.NativeID, &a.LocalID, &a.CredentialVersion, &a.Email, &cipher, &binding, &key)
	if errors.Is(e, sql.ErrNoRows) {
		return a, errEmailRevoked
	}
	if e != nil {
		return a, errStorageUnavailable
	}
	if !emailAddress(a.Email) {
		return a, errEmailRevoked
	}
	contact, e := loadEmailContact(ctx, s.db, a.UserID, false)
	if e != nil || !emailContactCurrent(contact, a) {
		return a, errEmailRevoked
	}
	var secret emailContactSecret
	if e = s.notificationLoad(ctx, s.db, contact.ContentID, "contact", &secret); e != nil {
		return a, e
	}
	if secret.Email != a.Email {
		return a, errEmailRevoked
	}
	credential, e := s.keyring.open(key, localAccountDomain, cipher, binding)
	if e != nil {
		return a, e
	}
	token := forgeCredential{Kind: "pat", Token: credential, Local: true}
	actor, e := s.currentUser(ctx, token)
	if e != nil {
		return a, e
	}
	if actor.ID != a.NativeID {
		return a, errEmailRevoked
	}
	if d.Kind == "activity" {
		var ownerName, name, forge string
		var repo, owner int64
		e = s.db.QueryRowContext(ctx, `SELECT forge_url,repository_owner,repository_name,repository_id,owner_id FROM golf_email_subscriptions WHERE id=$1 AND user_id=$2`, d.SubscriptionID, a.UserID).Scan(&forge, &ownerName, &name, &repo, &owner)
		if e != nil || forge != s.config.GiteaURL {
			return a, errEmailRevoked
		}
		access, e := s.readRepositoryAccess(ctx, token, repositoryKey{ownerName, name}, actor)
		if e != nil {
			return a, e
		}
		if access.RepositoryId != strconv.FormatInt(repo, 10) || access.OwnerId != strconv.FormatInt(owner, 10) || access.CurrentPermission == "none" {
			return a, errEmailRevoked
		}
	}
	if e := s.requireGolfUserAccess(ctx, s.db, a.UserID); e != nil {
		if errors.Is(e, errUnauthenticated) {
			return emailAccount{}, errEmailRevoked
		}
		return emailAccount{}, e
	}
	return a, nil
}
func (s *Server) emailDeliveryLive(ctx context.Context, d emailDelivery) error {
	var leaseLive, configurationLive, accessAllowed bool
	e := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_email_deliveries WHERE id=$1 AND lease_id=$2::uuid AND state='sending' AND lease_until>clock_timestamp()),EXISTS(SELECT 1 FROM golf_email_configuration WHERE transport_id=$3::uuid AND transport_version=$4 AND generation=$5),NOT EXISTS(SELECT 1 FROM golf_user_access WHERE user_id=$6 AND suspended)`, d.ID, d.LeaseID, d.TransportID, d.TransportVersion, d.ActivationGeneration, d.UserID).Scan(&leaseLive, &configurationLive, &accessAllowed)
	if e != nil {
		return errStorageUnavailable
	}
	if !leaseLive {
		return errEmailLeaseLost
	}
	if !configurationLive || !accessAllowed {
		return errEmailRevoked
	}
	return nil
}

func (s *Server) claimEmail(ctx context.Context) (emailDelivery, error) {
	var d emailDelivery
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return d, errStorageUnavailable
	}
	defer tx.Rollback()
	_, e = tx.ExecContext(ctx, `WITH expired AS (SELECT d.id,d.lease_id FROM golf_email_deliveries d JOIN golf_users u ON u.id=d.user_id WHERE u.forge_url=$1 AND d.state='sending' AND lease_until<=clock_timestamp() ORDER BY d.lease_until,d.id LIMIT 100 FOR UPDATE OF d SKIP LOCKED),finished AS (
 UPDATE golf_email_attempts a SET completed_at=clock_timestamp(),outcome='lease_expired_uncertain' FROM expired x WHERE a.delivery_id=x.id AND a.lease_id=x.lease_id AND a.completed_at IS NULL RETURNING a.delivery_id)
 UPDATE golf_email_deliveries d SET state=CASE WHEN attempts>=6 THEN 'failed' ELSE 'retrying' END,possible_duplicate=true,failure_code='lease_expired_uncertain',next_attempt_at=clock_timestamp(),completed_at=CASE WHEN attempts>=6 THEN clock_timestamp() ELSE NULL END FROM expired x WHERE d.id=x.id`, s.config.GiteaURL)
	if e != nil {
		return d, e
	}
	_, e = tx.ExecContext(ctx, `WITH obsolete AS (
 SELECT d.id FROM golf_email_deliveries d JOIN golf_users u ON u.id=d.user_id JOIN golf_email_contacts c ON c.user_id=d.user_id JOIN golf_local_accounts a ON a.id=c.local_account_id CROSS JOIN golf_email_configuration cfg
 LEFT JOIN golf_email_subscriptions ss ON ss.id=d.subscription_id LEFT JOIN golf_email_challenges ch ON ch.id=d.challenge_id
 WHERE u.forge_url=$1 AND d.state IN ('queued','retrying') AND (a.disabled_at IS NOT NULL OR a.credential_version<>c.credential_version OR c.version<>d.contact_version OR cfg.transport_id IS DISTINCT FROM d.transport_id OR cfg.transport_version IS DISTINCT FROM d.transport_version OR cfg.generation<>d.activation_generation
 OR (d.kind='verification' AND (ch.confirmed_at IS NOT NULL OR ch.expires_at<=clock_timestamp() OR ch.attempts>=5))
 OR (d.kind='activity' AND (NOT c.enabled OR c.verified_at IS NULL OR c.suppression<>'' OR NOT ss.enabled OR ss.authorization_state<>'authorized' OR ss.version<>d.subscription_version OR ss.epoch<>d.epoch OR ss.contact_version<>c.version OR ss.credential_version<>c.credential_version)))
 ORDER BY d.id LIMIT 100 FOR UPDATE OF d SKIP LOCKED)
 UPDATE golf_email_deliveries d SET state='cancelled',failure_code='authorization_or_configuration_changed',completed_at=clock_timestamp() FROM obsolete x WHERE d.id=x.id`, s.config.GiteaURL)
	if e != nil {
		return d, e
	}
	var id string
	e = tx.QueryRowContext(ctx, `SELECT d.id::text FROM golf_email_deliveries d JOIN golf_users u ON u.id=d.user_id WHERE u.forge_url=$1 AND d.state IN ('queued','retrying') AND d.attempts<6 AND d.next_attempt_at<=clock_timestamp() ORDER BY d.next_attempt_at,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED`, s.config.GiteaURL).Scan(&id)
	if e != nil {
		if errors.Is(e, sql.ErrNoRows) {
			_ = tx.Commit()
		}
		return d, e
	}
	lease := uuid.NewString()
	if _, e = tx.ExecContext(ctx, `UPDATE golf_email_deliveries SET state='sending',attempts=attempts+1,lease_id=$2,lease_until=clock_timestamp()+interval '30 seconds' WHERE id=$1`, id, lease); e != nil {
		return d, e
	}
	d, e = scanEmailDelivery(tx.QueryRowContext(ctx, `SELECT `+emailDeliveryColumns+` FROM golf_email_deliveries WHERE id=$1`, id))
	if e != nil {
		return d, e
	}
	if _, e = tx.ExecContext(ctx, `INSERT INTO golf_email_attempts(delivery_id,attempt,lease_id) VALUES($1,$2,$3)`, id, d.Attempts, lease); e != nil {
		return d, e
	}
	return d, tx.Commit()
}
func (s *Server) prepareEmail(ctx context.Context, d emailDelivery, a emailAccount, p emailSMTPProfile, secret emailSMTPSecret) (emailMailSecret, error) {
	var payload emailMailSecret
	if d.ContentID.Valid {
		e := s.notificationLoad(ctx, s.db, d.ContentID.String, "mail", &payload)
		if e != nil || payload.Recipient != a.Email {
			return payload, errCredentialUnavailable
		}
		return payload, nil
	}
	if d.Kind != "activity" {
		return payload, errCredentialUnavailable
	}
	var owner, name, contentID string
	e := s.db.QueryRowContext(ctx, `SELECT repository_owner,repository_name,content_id::text FROM golf_email_subscriptions WHERE id=$1 AND version=$2 AND epoch=$3`, d.SubscriptionID, d.SubscriptionVersion, d.Epoch).Scan(&owner, &name, &contentID)
	if e != nil {
		return payload, errEmailRevoked
	}
	var sub emailSubscriptionSecret
	if e = s.notificationLoad(ctx, s.db, contentID, "subscription", &sub); e != nil {
		return payload, e
	}
	if len(sub.UnsubscribeToken) != 43 {
		return payload, errCredentialUnavailable
	}
	if _, pathErr := repositoryPath(repositoryKey{owner, name}); pathErr != nil {
		return payload, errEmailRevoked
	}
	link := s.config.PublicURL + "/" + url.PathEscape(owner) + "/" + url.PathEscape(name)
	text := "Golf observed a repository " + d.Topic + " change.\nObserved at: " + d.CreatedAt.UTC().Format(time.RFC3339) + "\n\nView the repository after signing in:\n" + link + "\n\nManage this email subscription:\n" + s.emailUnsubscribeURL(sub.UnsubscribeToken) + "\n\nThis is a committed activity observation, not a guarantee that a pipeline or deployment completed. No source, issue body or execution logs are included."
	subject := "Golf repository activity"
	if strings.HasPrefix(d.EventID, "workflow-terminal:") {
		event, err := s.workflowEmailEvent(ctx, d)
		if err != nil {
			return payload, err
		}
		subject = "Golf workflow outcome"
		text, err = workflowOutcomeEmailText(event, link+"/actions/runs/"+event.RunID, s.emailUnsubscribeURL(sub.UnsubscribeToken))
		if err != nil {
			return payload, err
		}
	}
	body, e := emailMessage(secret.Sender, a.Email, d.ID, subject, text)
	if e != nil {
		return payload, e
	}
	payload = emailMailSecret{a.Email, body}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return payload, e
	}
	defer tx.Rollback()
	var existing sql.NullString
	e = tx.QueryRowContext(ctx, `SELECT content_id::text FROM golf_email_deliveries WHERE id=$1 AND state='sending' AND lease_id=$2::uuid AND lease_until>clock_timestamp() FOR UPDATE`, d.ID, d.LeaseID).Scan(&existing)
	if e != nil {
		return payload, errEmailLeaseLost
	}
	if existing.Valid {
		if e = s.notificationLoad(ctx, tx, existing.String, "mail", &payload); e != nil {
			return payload, e
		}
		return payload, tx.Commit()
	}
	id := uuid.NewString()
	if e = s.notificationStore(ctx, tx, id, "mail", payload); e != nil {
		return payload, e
	}
	if _, e = tx.ExecContext(ctx, `UPDATE golf_email_deliveries SET content_id=$2 WHERE id=$1`, d.ID, id); e != nil {
		return payload, e
	}
	return payload, tx.Commit()
}
func (s *Server) attemptEmail(ctx context.Context, d emailDelivery, n emailNetwork, owner func(context.Context) error) {
	ctx, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	a, e := s.emailAuthority(ctx, d)
	result := emailSMTPResult{Failure: "authority_unavailable"}
	var p emailSMTPProfile
	var secret emailSMTPSecret
	var payload emailMailSecret
	if e == nil {
		p, e = scanEmailProfile(s.db.QueryRowContext(ctx, `SELECT `+emailProfileColumns+` FROM golf_email_transports WHERE id=$1 AND version=$2`, d.TransportID, d.TransportVersion))
	}
	if e == nil {
		e = s.notificationLoad(ctx, s.db, p.ContentID, "transport", &secret)
	}
	if e == nil {
		e = s.emailDeliveryLive(ctx, d)
	}
	if e == nil {
		payload, e = s.prepareEmail(ctx, d, a, p, secret)
	}
	if e == nil {
		result = n.deliver(ctx, p, secret, payload.Recipient, []byte(payload.Body), func(c context.Context) error {
			if owner != nil {
				if e := owner(c); e != nil {
					return e
				}
			}
			if e := s.emailDeliveryLive(c, d); e != nil {
				return e
			}
			_, e := s.emailAuthority(c, d)
			return e
		})
	} else {
		result = emailSMTPError(e, "authority", false)
	}
	if errors.Is(e, errEmailLeaseLost) {
		return
	}
	state, failure := "failed", result.Failure
	next := time.Now()
	if result.Code == 250 && failure == "" {
		state = "accepted"
	} else if result.Suppress {
		state = "suppressed"
	} else if result.Failure == "authority_unavailable" {
		state = "cancelled"
	} else if result.Uncertain || result.Code >= 400 && result.Code < 500 || result.Failure == "smtp_unavailable" {
		state = "retrying"
		next = next.Add(webhookRetryDelay(d.Attempts, "", next))
		if d.Attempts >= 6 {
			state = "failed"
			failure = "retry_budget_exhausted"
		}
	}
	finish, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	tx, e := s.db.BeginTx(finish, nil)
	if e != nil {
		return
	}
	defer tx.Rollback()
	acknowledged, e := tx.ExecContext(finish, `UPDATE golf_email_deliveries SET state=$3,smtp_status=$4,failure_code=$5,possible_duplicate=possible_duplicate OR $6,next_attempt_at=$7,completed_at=CASE WHEN $3 IN ('accepted','failed','cancelled','suppressed') THEN clock_timestamp() ELSE NULL END WHERE id=$1 AND lease_id=$2::uuid AND state='sending' AND lease_until>clock_timestamp()`, d.ID, d.LeaseID, state, result.Code, failure, result.Uncertain, next)
	if e != nil {
		return
	}
	count, e := acknowledged.RowsAffected()
	if e != nil || count != 1 {
		return
	}
	if _, e = tx.ExecContext(finish, `UPDATE golf_email_attempts SET completed_at=clock_timestamp(),smtp_status=$3,outcome=$4 WHERE delivery_id=$1 AND lease_id=$2::uuid AND completed_at IS NULL`, d.ID, d.LeaseID, result.Code, failure); e != nil {
		return
	}
	if result.Suppress {
		if _, e = tx.ExecContext(finish, `UPDATE golf_email_contacts SET enabled=false,suppression='recipient_rejected',preference_version=preference_version+1,updated_at=clock_timestamp() WHERE user_id=$1 AND version=$2`, d.UserID, d.ContactVersion); e != nil {
			return
		}
		if _, e = tx.ExecContext(finish, `UPDATE golf_email_subscriptions SET enabled=false,authorization_state='authority_unavailable',epoch=epoch+1,updated_at=clock_timestamp() WHERE user_id=$1 AND contact_version=$2 AND enabled`, d.UserID, d.ContactVersion); e != nil {
			return
		}
	}
	if state == "cancelled" && d.SubscriptionID.Valid {
		if _, e = tx.ExecContext(finish, `UPDATE golf_email_subscriptions SET enabled=false,authorization_state='authority_unavailable',epoch=epoch+1,updated_at=clock_timestamp() WHERE id=$1 AND version=$2 AND epoch=$3 AND enabled`, d.SubscriptionID, d.SubscriptionVersion, d.Epoch); e != nil {
			return
		}
	}
	_ = tx.Commit()
}

// Two durable instance worker slots are a development bound, not a fanout-scale
// claim. No database transaction spans SMTP. Cancellation closes the TCP session.
func (s *Server) RunEmailWorker(ctx context.Context) error {
	network, e := defaultEmailNetwork()
	if e != nil {
		return e
	}
	owner, e := s.db.Conn(ctx)
	if e != nil {
		return errStorageUnavailable
	}
	defer owner.Close()
	slot := int64(0)
	for _, v := range []int64{74191526730404300, 74191526730404301} {
		var ok bool
		if e = owner.QueryRowContext(ctx, `SELECT pg_try_advisory_lock($1)`, v).Scan(&ok); e != nil {
			return errStorageUnavailable
		}
		if ok {
			slot = v
			break
		}
	}
	if slot == 0 {
		return errors.New("Email delivery worker capacity is already owned.")
	}
	defer func() {
		release, stop := context.WithTimeout(context.Background(), time.Second)
		defer stop()
		_, _ = owner.ExecContext(release, `SELECT pg_advisory_unlock($1)`, slot)
	}()
	timer := time.NewTicker(500 * time.Millisecond)
	defer timer.Stop()
	for {
		if ctx.Err() != nil {
			return nil
		}
		var one int
		probe, stop := context.WithTimeout(ctx, time.Second)
		e = owner.QueryRowContext(probe, `SELECT 1`).Scan(&one)
		stop()
		if e != nil {
			return errStorageUnavailable
		}
		d, e := s.claimEmail(ctx)
		if e == nil {
			s.attemptEmail(ctx, d, network, func(c context.Context) error {
				var one int
				if owner.QueryRowContext(c, `SELECT 1`).Scan(&one) != nil {
					return errEmailLeaseLost
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
func (s *Server) ListOwnEmailDeliveries(ctx context.Context, req *connect.Request[golfv1.ListOwnEmailDeliveriesRequest]) (*connect.Response[golfv1.ListOwnEmailDeliveriesResponse], error) {
	ctx, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	page, limit, e := pagination(pageFrom(req.Msg.Page))
	if e != nil {
		return nil, notificationRPCError(e)
	}
	out := &golfv1.ListOwnEmailDeliveriesResponse{Page: &golfv1.PageResponse{}, Target: req.Msg.Target}
	inspect := func() error {
		return s.withEmailAccount(ctx, req.Header(), func(tx *sql.Tx, a emailAccount) error {
			out.UserId = strconv.FormatInt(a.UserID, 10)
			var repo, owner int64
			if req.Msg.Target != nil {
				_, repo, owner, e = emailTarget(req.Msg.Target)
				if e != nil {
					return e
				}
			}
			rows, e := tx.QueryContext(ctx, `SELECT `+prefixedEmailColumns("d")+` FROM golf_email_deliveries d LEFT JOIN golf_email_subscriptions ss ON ss.id=d.subscription_id WHERE d.user_id=$1 AND (($2::bigint=0 AND d.kind='verification') OR ($2>0 AND ss.repository_id=$2 AND ss.owner_id=$3 AND ss.forge_url=$4)) ORDER BY d.created_at DESC,d.id DESC LIMIT $5 OFFSET $6`, a.UserID, repo, owner, s.config.GiteaURL, int(limit)+1, int((page-1)*limit))
			if e != nil {
				return e
			}
			defer rows.Close()
			for rows.Next() {
				d, e := scanEmailDelivery(rows)
				if e != nil {
					return e
				}
				out.Deliveries = append(out.Deliveries, wireEmailDelivery(d))
			}
			if e = rows.Err(); e != nil {
				return e
			}
			if len(out.Deliveries) > int(limit) {
				if page == 10000 {
					return invalid("Email history exceeds the page bound.")
				}
				out.Page.NextPage = page + 1
				out.Deliveries = out.Deliveries[:limit]
			}
			return nil
		})
	}
	if req.Msg.Target != nil {
		e = s.withEmailRepository(ctx, req.Header(), req.Msg.Target, inspect)
	} else {
		e = inspect()
	}
	if e != nil {
		return nil, notificationRPCError(e)
	}
	return connect.NewResponse(out), nil
}
func prefixedEmailColumns(prefix string) string {
	cols := strings.Split(emailDeliveryColumns, ",")
	for i, c := range cols {
		cols[i] = prefix + "." + c
	}
	return strings.Join(cols, ",")
}
func (s *Server) RedeliverOwnEmail(ctx context.Context, req *connect.Request[golfv1.RedeliverOwnEmailRequest]) (*connect.Response[golfv1.RedeliverOwnEmailResponse], error) {
	ctx, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	m := req.Msg
	contact, e := emailVersion(m.ExpectedContactVersion, false)
	if e != nil || !creationKey.MatchString(m.DeliveryId) || !creationKey.MatchString(m.OperationId) {
		return nil, notificationRPCError(invalid("Select an exact event/mailbox and redelivery operation."))
	}
	out := &golfv1.RedeliverOwnEmailResponse{}
	e = s.withEmailAccount(ctx, req.Header(), func(tx *sql.Tx, a emailAccount) error {
		prior, e := scanEmailDelivery(tx.QueryRowContext(ctx, `SELECT `+emailDeliveryColumns+` FROM golf_email_deliveries WHERE id=$1 AND user_id=$2`, m.OperationId, a.UserID))
		if e == nil {
			if prior.RedeliveryOf.String != m.DeliveryId || prior.ContactVersion != contact {
				return errRepositorySettingsConflict
			}
			if _, e = s.emailAuthority(ctx, prior); e != nil {
				return e
			}
			out.UserId = strconv.FormatInt(a.UserID, 10)
			out.Delivery = wireEmailDelivery(prior)
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return e
		}
		original, e := scanEmailDelivery(tx.QueryRowContext(ctx, `SELECT `+emailDeliveryColumns+` FROM golf_email_deliveries WHERE id=$1 AND user_id=$2 FOR UPDATE`, m.DeliveryId, a.UserID))
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if e != nil {
			return e
		}
		if original.Kind != "activity" || original.ContactVersion != contact || original.State == "queued" || original.State == "sending" || original.State == "retrying" {
			return invalid("Only a completed current subscription event can be explicitly redelivered.")
		}
		if _, e = s.emailAuthority(ctx, original); e != nil {
			return e
		}
		var generation int64
		var id sql.NullString
		var version sql.NullInt64
		e = tx.QueryRowContext(ctx, `SELECT transport_id::text,transport_version,generation FROM golf_email_configuration WHERE singleton`).Scan(&id, &version, &generation)
		if e != nil {
			return e
		}
		if !id.Valid {
			return invalid("Activate an SMTP transport first.")
		}
		if _, e = tx.ExecContext(ctx, `INSERT INTO golf_email_deliveries(id,user_id,kind,contact_version,subscription_id,subscription_version,epoch,event_id,event_topic,transport_id,transport_version,activation_generation,redelivery_of,possible_duplicate) VALUES($1,$2,'activity',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)`, m.OperationId, a.UserID, contact, original.SubscriptionID, original.SubscriptionVersion, original.Epoch, original.EventID, original.Topic, id, version, generation, original.ID); e != nil {
			return e
		}
		if _, e = s.emailAuthority(ctx, original); e != nil {
			return e
		}
		saved, e := scanEmailDelivery(tx.QueryRowContext(ctx, `SELECT `+emailDeliveryColumns+` FROM golf_email_deliveries WHERE id=$1`, m.OperationId))
		out.UserId = strconv.FormatInt(a.UserID, 10)
		out.Delivery = wireEmailDelivery(saved)
		return e
	})
	if e != nil {
		return nil, notificationRPCError(e)
	}
	return connect.NewResponse(out), nil
}
