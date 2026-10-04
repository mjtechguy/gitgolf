package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"mime/quotedprintable"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

const notificationContentDomain = "notification_content"

type emailContactSecret struct{ Email string }
type emailSubscriptionSecret struct{ UnsubscribeToken string }
type emailMailSecret struct{ Recipient, Body string }
type emailAccount struct {
	UserID, NativeID, LocalID, CredentialVersion int64
	Email                                        string
}
type emailContact struct {
	UserID, LocalID, NativeID, CredentialVersion, Version, PreferenceVersion int64
	ContentID                                                                string
	MailboxHash                                                              []byte
	VerifiedAt                                                               sql.NullTime
	Enabled                                                                  bool
	Suppression                                                              string
}

// Preserve explicit bounded refusal codes; no SMTP response body is exposed.
func notificationRPCError(err error) error {
	var wire *connect.Error
	if errors.As(err, &wire) {
		return wire
	}
	if errors.Is(err, errEmailRevoked) {
		return connect.NewError(connect.CodePermissionDenied, errors.New("Email background authorization is unavailable."))
	}
	if errors.Is(err, errEmailDestination) {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("SMTP destination is outside the secure operator policy."))
	}
	return rpcError(err)
}

func notificationBinding(id, kind string) []byte {
	h := sha256.Sum256([]byte("golf:notification:v1\x00" + id + "\x00" + kind))
	return h[:]
}
func emailHash(value string) []byte { h := sha256.Sum256([]byte(value)); return h[:] }
func emailVersion(value string, zero bool) (int64, error) {
	v, e := strconv.ParseInt(value, 10, 64)
	if e != nil || v < 0 || (!zero && v == 0) || v == 9223372036854775807 || strconv.FormatInt(v, 10) != value {
		return 0, invalid("Provide an exact canonical saved version.")
	}
	return v, nil
}
func (s *Server) notificationStore(ctx context.Context, tx database.DBTX, id, kind string, value any) error {
	data, e := json.Marshal(value)
	if e != nil || len(data) > 16384 {
		return errStorageUnavailable
	}
	binding := notificationBinding(id, kind)
	cipher, key, e := s.keyring.seal(notificationContentDomain, string(data), binding)
	if e != nil {
		return e
	}
	_, e = tx.ExecContext(ctx, `INSERT INTO golf_notification_contents(id,kind,encrypted_content,content_binding,credential_key_id) VALUES($1,$2,$3,$4,$5)`, id, kind, cipher, binding, key)
	return e
}
func (s *Server) notificationLoad(ctx context.Context, tx database.DBTX, id, kind string, value any) error {
	var cipher, binding []byte
	var key, actualKind string
	e := tx.QueryRowContext(ctx, `SELECT kind,encrypted_content,content_binding,credential_key_id FROM golf_notification_contents WHERE id=$1`, id).Scan(&actualKind, &cipher, &binding, &key)
	if e != nil {
		return errCredentialUnavailable
	}
	if actualKind != kind || !bytes.Equal(binding, notificationBinding(id, kind)) {
		return errCredentialUnavailable
	}
	plain, e := s.keyring.open(key, notificationContentDomain, cipher, binding)
	if e != nil || len(plain) > 16384 {
		return errCredentialUnavailable
	}
	decoder := json.NewDecoder(strings.NewReader(plain))
	decoder.DisallowUnknownFields()
	if decoder.Decode(value) != nil {
		return errCredentialUnavailable
	}
	return nil
}
func scanEmailContact(row *sql.Row) (emailContact, error) {
	var c emailContact
	e := row.Scan(&c.UserID, &c.LocalID, &c.NativeID, &c.CredentialVersion, &c.Version, &c.PreferenceVersion, &c.ContentID, &c.MailboxHash, &c.VerifiedAt, &c.Enabled, &c.Suppression)
	return c, e
}

const emailContactColumns = "user_id,local_account_id,native_user_id,credential_version,version,preference_version,content_id::text,mailbox_hash,verified_at,enabled,suppression"

func loadEmailContact(ctx context.Context, tx database.DBTX, user int64, lock bool) (emailContact, error) {
	suffix := ""
	if lock {
		suffix = " FOR UPDATE"
	}
	return scanEmailContact(tx.QueryRowContext(ctx, `SELECT `+emailContactColumns+` FROM golf_email_contacts WHERE user_id=$1`+suffix, user))
}
func emailContactCurrent(c emailContact, a emailAccount) bool {
	return c.UserID == a.UserID && c.LocalID == a.LocalID && c.NativeID == a.NativeID && c.CredentialVersion == a.CredentialVersion && bytes.Equal(c.MailboxHash, emailHash(a.Email))
}
func (s *Server) emailState(ctx context.Context, tx database.DBTX, a emailAccount) (*golfv1.OwnEmailNotificationState, error) {
	state := &golfv1.OwnEmailNotificationState{UserId: strconv.FormatInt(a.UserID, 10), NativeUserId: strconv.FormatInt(a.NativeID, 10), LocalAccountId: strconv.FormatInt(a.LocalID, 10), CredentialVersion: strconv.FormatInt(a.CredentialVersion, 10), LoginEmail: a.Email, ContactVersion: "0", PreferenceVersion: "0"}
	c, e := loadEmailContact(ctx, tx, a.UserID, false)
	if e != nil && !errors.Is(e, sql.ErrNoRows) {
		return nil, errStorageUnavailable
	}
	if e == nil {
		state.ContactVersion = strconv.FormatInt(c.Version, 10)
		state.PreferenceVersion = strconv.FormatInt(c.PreferenceVersion, 10)
		state.Suppression = c.Suppression
		if emailContactCurrent(c, a) {
			state.Verified = c.VerifiedAt.Valid
			state.Enabled = c.Enabled
			if c.VerifiedAt.Valid {
				state.VerifiedAt = c.VerifiedAt.Time.UTC().Format(time.RFC3339Nano)
			}
		} else {
			state.Suppression = "credential_changed"
		}
	}
	if !state.Verified && emailContactCurrent(c, a) {
		var challengeID string
		var expires time.Time
		err := tx.QueryRowContext(ctx, `SELECT id::text,expires_at FROM golf_email_challenges WHERE user_id=$1 AND contact_version=$2 AND confirmed_at IS NULL AND expires_at>clock_timestamp() AND attempts<5 ORDER BY created_at DESC LIMIT 1`, a.UserID, c.Version).Scan(&challengeID, &expires)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, errStorageUnavailable
		}
		if err == nil {
			state.ChallengeId = challengeID
			state.ChallengeDeliveryId = challengeID
			state.ChallengeExpiresAt = expires.UTC().Format(time.RFC3339Nano)
		}
	}

	e = tx.QueryRowContext(ctx, `SELECT transport_id IS NOT NULL FROM golf_email_configuration WHERE singleton`).Scan(&state.TransportActive)
	return state, e
}

// Same lock order as local sessions: Golf actor, managed session, local account.
// Callers cannot use a raw PAT, native email or instance-admin impersonation.
func (s *Server) withEmailAccount(ctx context.Context, header http.Header, fn func(*sql.Tx, emailAccount) error) error {
	token, e := rpcToken(ctx)
	if e != nil {
		return e
	}
	if !token.Local {
		return forgeError{http.StatusForbidden}
	}
	value := s.cookieValue(header)
	hash, e := s.authSessionHash(ctx, value, nil)
	if e != nil {
		return e
	}
	return s.withForgeCaller(ctx, value, token, func(actor User) error {
		tx, e := s.db.BeginTx(ctx, nil)
		if e != nil {
			return errStorageUnavailable
		}
		defer tx.Rollback()
		q := database.New(s.db).WithTx(tx)
		identity, e := q.LockSessionUser(ctx, database.LockSessionUserParams{CallerTokenHash: hash, ForgeURL: s.config.GiteaURL})
		if errors.Is(e, sql.ErrNoRows) {
			return errUnauthenticated
		}
		if e != nil {
			return errStorageUnavailable
		}
		if identity.ForgeUserID != actor.ID {
			return errUnauthenticated
		}
		caller, e := q.LockManagedSession(ctx, database.LockManagedSessionParams{CallerTokenHash: hash, UserID: identity.ID, ForgeURL: s.config.GiteaURL})
		if e != nil {
			return errUnauthenticated
		}
		if _, e = s.authSessionHash(ctx, value, q); e != nil {
			return e
		}
		var a emailAccount
		a.UserID = identity.ID
		a.NativeID = actor.ID
		e = tx.QueryRowContext(ctx, `SELECT a.id,a.credential_version,COALESCE(a.email,'') FROM golf_local_accounts a JOIN golf_sessions ss ON ss.local_account_id=a.id AND ss.user_id=a.user_id WHERE a.user_id=$1 AND ss.token_hash=$2 AND a.disabled_at IS NULL AND ss.local_credential_version=a.credential_version FOR UPDATE OF a`, a.UserID, hash).Scan(&a.LocalID, &a.CredentialVersion, &a.Email)
		if errors.Is(e, sql.ErrNoRows) {
			return errUnauthenticated
		}
		if e != nil {
			return errStorageUnavailable
		}
		if !caller.ExpiresAt.After(time.Now()) {
			return errUnauthenticated
		}
		if e = fn(tx, a); e != nil {
			return e
		}
		if _, e = s.authSessionHash(ctx, value, q); e != nil {
			return e
		}
		if !caller.ExpiresAt.After(time.Now()) {
			return errUnauthenticated
		}
		return tx.Commit()
	})
}
func (s *Server) GetOwnEmailNotifications(ctx context.Context, req *connect.Request[golfv1.GetOwnEmailNotificationsRequest]) (*connect.Response[golfv1.GetOwnEmailNotificationsResponse], error) {
	ctx, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	out := &golfv1.GetOwnEmailNotificationsResponse{}
	e := s.withEmailAccount(ctx, req.Header(), func(tx *sql.Tx, a emailAccount) error { var e error; out.State, e = s.emailState(ctx, tx, a); return e })
	if e != nil {
		return nil, notificationRPCError(e)
	}
	return connect.NewResponse(out), nil
}
func scanEmailProfile(row interface{ Scan(...any) error }) (emailSMTPProfile, error) {
	var p emailSMTPProfile
	e := row.Scan(&p.ID, &p.Version, &p.Name, &p.Host, &p.Port, &p.TLSMode, &p.ContentID, &p.CreatedAt)
	return p, e
}

const emailProfileColumns = "id::text,version,name,host,port,tls_mode,content_id::text,created_at"

func wireEmailProfile(p emailSMTPProfile, active bool) *golfv1.EmailTransport {
	return &golfv1.EmailTransport{Id: p.ID, Version: strconv.FormatInt(p.Version, 10), Name: p.Name, Host: p.Host, Port: uint32(p.Port), TlsMode: p.TLSMode, HasCredential: true, Active: active, CreatedAt: p.CreatedAt.UTC().Format(time.RFC3339Nano)}
}
func (s *Server) ListEmailTransports(ctx context.Context, req *connect.Request[golfv1.ListEmailTransportsRequest]) (*connect.Response[golfv1.ListEmailTransportsResponse], error) {
	ctx, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, notificationRPCError(e)
	}
	out := &golfv1.ListEmailTransportsResponse{}
	e = s.withForgeCaller(ctx, s.cookieValue(req.Header()), token, func(User) error {
		if e := s.requireInstanceAdmin(ctx, s.cookieValue(req.Header()), token); e != nil {
			return e
		}
		var active sql.NullString
		var version sql.NullInt64
		var generation int64
		if e := s.db.QueryRowContext(ctx, `SELECT transport_id::text,transport_version,generation FROM golf_email_configuration WHERE singleton`).Scan(&active, &version, &generation); e != nil {
			return errStorageUnavailable
		}
		out.ActivationGeneration = strconv.FormatInt(generation, 10)
		rows, e := s.db.QueryContext(ctx, `SELECT `+emailProfileColumns+` FROM golf_email_transports t WHERE version=(SELECT max(version) FROM golf_email_transports WHERE id=t.id) OR (id=$1::uuid AND version=$2) ORDER BY name,id,version DESC LIMIT 65`, active, version)
		if e != nil {
			return errStorageUnavailable
		}
		defer rows.Close()
		for rows.Next() {
			p, e := scanEmailProfile(rows)
			if e != nil {
				return errStorageUnavailable
			}
			out.Transports = append(out.Transports, wireEmailProfile(p, active.Valid && p.ID == active.String && p.Version == version.Int64))
		}
		if len(out.Transports) > 64 {
			return errStorageUnavailable
		}
		if e = rows.Err(); e != nil {
			return errStorageUnavailable
		}
		rows.Close()
		observed, e := s.readEmailConfigurationStatus(ctx)
		if e != nil {
			return e
		}
		if observed.ActivationGeneration != generation || observed.Configured != active.Valid || observed.TransportID != active.String || observed.TransportVersion != version.Int64 {
			return errRepositorySettingsConflict
		}
		out.Observation = wireEmailConfigurationObservation(observed)
		return s.requireInstanceAdmin(ctx, s.cookieValue(req.Header()), token)
	})
	if e != nil {
		return nil, notificationRPCError(e)
	}
	return connect.NewResponse(out), nil
}
func (s *Server) SaveEmailTransport(ctx context.Context, req *connect.Request[golfv1.SaveEmailTransportRequest]) (*connect.Response[golfv1.SaveEmailTransportResponse], error) {
	ctx, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	m := req.Msg
	v, e := emailVersion(m.ExpectedVersion, true)
	p := emailSMTPProfile{ID: m.Id, Version: v + 1, Name: m.Name, Host: m.Host, Port: int(m.Port), TLSMode: m.TlsMode, ContentID: uuid.NewString()}
	if e != nil || !creationKey.MatchString(m.Id) || m.Name == "" || strings.TrimSpace(m.Name) != m.Name || !discussionText(m.Name, 120) || !emailProfileValid(p) {
		return nil, notificationRPCError(invalid("Provide a named SMTP transport with exact saved version and secure host/port."))
	}
	if m.RetainCredential && (m.Sender != "" || m.Username != "" || m.Password != "") {
		return nil, notificationRPCError(invalid("Retained credentials cannot be replaced in the same request."))
	}
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, notificationRPCError(e)
	}
	confirmation, e := s.confirmInfrastructureAdmin(ctx, s.cookieValue(req.Header()), token, m.CurrentPassword)
	if e != nil {
		return nil, notificationRPCError(e)
	}
	e = s.infrastructureAdminTransaction(ctx, s.cookieValue(req.Header()), confirmation, func(tx *sql.Tx) error {
		if _, e := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('golf-email-configuration',0))`); e != nil {
			return e
		}
		var latest int64
		if e := tx.QueryRowContext(ctx, `SELECT COALESCE(max(version),0) FROM golf_email_transports WHERE id=$1`, m.Id).Scan(&latest); e != nil {
			return e
		}
		if latest != v {
			return errRepositorySettingsConflict
		}
		var count int
		if e := tx.QueryRowContext(ctx, `SELECT count(DISTINCT id) FROM golf_email_transports`).Scan(&count); e != nil {
			return e
		}
		if v == 0 && count >= 32 {
			return invalid("The instance supports up to 32 SMTP transports.")
		}
		secret := emailSMTPSecret{Sender: m.Sender, Username: m.Username, Password: m.Password}
		if m.RetainCredential {
			if v == 0 {
				return invalid("A new transport requires a sender and explicit credential choice.")
			}
			prior, e := scanEmailProfile(tx.QueryRowContext(ctx, `SELECT `+emailProfileColumns+` FROM golf_email_transports WHERE id=$1 AND version=$2`, m.Id, v))
			if e != nil {
				return errResourceNotFound
			}
			if e = s.notificationLoad(ctx, tx, prior.ContentID, "transport", &secret); e != nil {
				return e
			}
		}
		if !emailSecretValid(secret) || p.TLSMode == "operator_plaintext" && secret.Username != "" {
			return invalid("Use one plain sender address and TLS-protected credentials only.")
		}
		network, e := defaultEmailNetwork()
		if e != nil {
			return e
		}
		if p.TLSMode == "operator_plaintext" {
			allowed := false
			for _, r := range network.approvals {
				allowed = allowed || r.Host == p.Host && r.Port == p.Port && r.TLSMode == p.TLSMode
			}
			if !allowed {
				return errEmailDestination
			}
		}
		if e = s.notificationStore(ctx, tx, p.ContentID, "transport", secret); e != nil {
			return e
		}
		if e = tx.QueryRowContext(ctx, `INSERT INTO golf_email_transports(id,version,name,host,port,tls_mode,content_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING created_at`, p.ID, p.Version, p.Name, p.Host, p.Port, p.TLSMode, p.ContentID).Scan(&p.CreatedAt); e != nil {
			return e
		}
		_, e = tx.ExecContext(ctx, `INSERT INTO golf_email_events(user_id,action,object_id,version) VALUES($1,'transport_saved',$2,$3)`, confirmation.UserID, p.ID, p.Version)
		return e
	})
	if e != nil {
		return nil, notificationRPCError(e)
	}
	return connect.NewResponse(&golfv1.SaveEmailTransportResponse{Transport: wireEmailProfile(p, false)}), nil
}
func (s *Server) ActivateEmailTransport(ctx context.Context, req *connect.Request[golfv1.ActivateEmailTransportRequest]) (*connect.Response[golfv1.ActivateEmailTransportResponse], error) {
	ctx, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	m := req.Msg
	v, e := emailVersion(m.Version, false)
	gen, gErr := emailVersion(m.ExpectedActivationGeneration, true)
	if e != nil || gErr != nil || !creationKey.MatchString(m.Id) {
		return nil, notificationRPCError(invalid("Select an exact saved SMTP transport and activation generation."))
	}
	token, e := rpcToken(ctx)
	if e != nil {
		return nil, notificationRPCError(e)
	}
	confirmation, e := s.confirmInfrastructureAdmin(ctx, s.cookieValue(req.Header()), token, m.CurrentPassword)
	if e != nil {
		return nil, notificationRPCError(e)
	}
	var p emailSMTPProfile
	e = s.infrastructureAdminTransaction(ctx, s.cookieValue(req.Header()), confirmation, func(tx *sql.Tx) error {
		var current int64
		if e := tx.QueryRowContext(ctx, `SELECT generation FROM golf_email_configuration WHERE singleton FOR UPDATE`).Scan(&current); e != nil {
			return e
		}
		if current != gen {
			return errRepositorySettingsConflict
		}
		var e error
		p, e = scanEmailProfile(tx.QueryRowContext(ctx, `SELECT `+emailProfileColumns+` FROM golf_email_transports WHERE id=$1 AND version=$2`, m.Id, v))
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if e != nil {
			return e
		}
		if !emailProfileValid(p) {
			return errEmailDestination
		}
		if p.TLSMode == "operator_plaintext" {
			network, err := defaultEmailNetwork()
			if err != nil || !network.profileApproved(p) {
				return errEmailDestination
			}
		}
		var secret emailSMTPSecret
		if e = s.notificationLoad(ctx, tx, p.ContentID, "transport", &secret); e != nil {
			return e
		}
		if !emailSecretValid(secret) {
			return errCredentialUnavailable
		}
		if _, e = tx.ExecContext(ctx, `UPDATE golf_email_configuration SET transport_id=$1,transport_version=$2,generation=generation+1 WHERE singleton`, p.ID, p.Version); e != nil {
			return e
		}
		_, e = tx.ExecContext(ctx, `INSERT INTO golf_email_events(user_id,action,object_id,version) VALUES($1,'transport_activated',$2,$3)`, confirmation.UserID, p.ID, p.Version)
		return e
	})
	if e != nil {
		return nil, notificationRPCError(e)
	}
	return connect.NewResponse(&golfv1.ActivateEmailTransportResponse{Transport: wireEmailProfile(p, true), ActivationGeneration: strconv.FormatInt(gen+1, 10)}), nil
}
func emailCode() (string, error) {
	var b [4]byte
	if _, e := rand.Read(b[:]); e != nil {
		return "", e
	}
	return fmt.Sprintf("%08d", binary.LittleEndian.Uint32(b[:])%100000000), nil
}
func emailToken() (string, error) {
	var b [32]byte
	if _, e := rand.Read(b[:]); e != nil {
		return "", e
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}
func emailCodeValid(code string) bool {
	if len(code) != 8 {
		return false
	}
	for _, r := range code {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
func emailCodeHash(id, code string) []byte {
	return emailHash("golf-email-code:v1\x00" + id + "\x00" + code)
}
func emailMessage(sender, to, id, subject, text string) (string, error) {
	if !emailAddress(sender) || !emailAddress(to) || !creationKey.MatchString(id) || len(subject) > 80 || strings.ContainsAny(subject, "\r\n") || len(text) > 12000 || strings.ContainsAny(text, "\r\x00") {
		return "", invalid("Email payload is unsupported.")
	}
	for _, line := range strings.Split(text, "\n") {
		if len(line) > 900 {
			return "", invalid("Email line exceeds its bound.")
		}
	}
	// Constant ASCII subjects and quoted-printable UTF-8 text do not require the
	// relay's 8BITMIME extension. No user header or attachment is admitted.
	var encoded bytes.Buffer
	writer := quotedprintable.NewWriter(&encoded)
	if _, e := writer.Write([]byte(text)); e != nil {
		return "", invalid("Email body is unsupported.")
	}
	if e := writer.Close(); e != nil {
		return "", invalid("Email body is unsupported.")
	}
	body := "From: " + sender + "\r\nTo: " + to + "\r\nSubject: " + subject + "\r\nMessage-ID: <" + id + "@golf.notifications>\r\nDate: " + time.Now().UTC().Format(time.RFC1123Z) + "\r\nAuto-Submitted: auto-generated\r\nX-Auto-Response-Suppress: All\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n" + encoded.String() + "\r\n"
	if len(body) > 16384 {
		return "", invalid("Email payload exceeds its bound.")
	}
	return body, nil
}
func (s *Server) emailActive(ctx context.Context, tx database.DBTX) (emailSMTPProfile, int64, emailSMTPSecret, error) {
	var id sql.NullString
	var version sql.NullInt64
	var generation int64
	e := tx.QueryRowContext(ctx, `SELECT transport_id::text,transport_version,generation FROM golf_email_configuration WHERE singleton`).Scan(&id, &version, &generation)
	if e != nil {
		return emailSMTPProfile{}, 0, emailSMTPSecret{}, e
	}
	if !id.Valid {
		return emailSMTPProfile{}, 0, emailSMTPSecret{}, invalid("Activate an SMTP transport before queuing verification.")
	}
	p, e := scanEmailProfile(tx.QueryRowContext(ctx, `SELECT `+emailProfileColumns+` FROM golf_email_transports WHERE id=$1 AND version=$2`, id, version))
	if e != nil {
		return p, 0, emailSMTPSecret{}, e
	}
	var secret emailSMTPSecret
	e = s.notificationLoad(ctx, tx, p.ContentID, "transport", &secret)
	return p, generation, secret, e
}
func (s *Server) RequestEmailVerification(ctx context.Context, req *connect.Request[golfv1.RequestEmailVerificationRequest]) (*connect.Response[golfv1.RequestEmailVerificationResponse], error) {
	ctx, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	m := req.Msg
	v, e := emailVersion(m.ExpectedContactVersion, true)
	if e != nil || !creationKey.MatchString(m.OperationId) {
		return nil, notificationRPCError(invalid("Provide an exact mailbox version and verification operation."))
	}
	out := &golfv1.RequestEmailVerificationResponse{}
	e = s.withEmailAccount(ctx, req.Header(), func(tx *sql.Tx, a emailAccount) error {
		if !emailAddress(a.Email) {
			return invalid("Your current Golf sign-in alias must be a plain email address.")
		}
		var originalVersion int64
		var expires time.Time
		var user int64
		e := tx.QueryRowContext(ctx, `SELECT user_id,contact_version,expires_at FROM golf_email_challenges WHERE id=$1`, m.OperationId).Scan(&user, &originalVersion, &expires)
		if e == nil {
			if user != a.UserID || originalVersion != v+1 {
				return errRepositorySettingsConflict
			}
			out.State, e = s.emailState(ctx, tx, a)
			out.AcceptedContactVersion = strconv.FormatInt(v+1, 10)
			out.ChallengeId = m.OperationId
			out.DeliveryId = m.OperationId
			out.ExpiresAt = expires.UTC().Format(time.RFC3339Nano)
			return e
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return e
		}
		c, e := loadEmailContact(ctx, tx, a.UserID, true)
		if !errors.Is(e, sql.ErrNoRows) && e != nil {
			return e
		}
		if e == nil && c.Version != v || errors.Is(e, sql.ErrNoRows) && v != 0 {
			return errRepositorySettingsConflict
		}
		var requests int
		if e = tx.QueryRowContext(ctx, `SELECT count(*) FROM golf_email_challenges WHERE user_id=$1 AND created_at>clock_timestamp()-interval '1 hour'`, a.UserID).Scan(&requests); e != nil {
			return e
		}
		if requests >= 3 {
			return connect.NewError(connect.CodeResourceExhausted, errors.New("Email verification is limited to three requests per hour."))
		}
		p, generation, secret, e := s.emailActive(ctx, tx)
		if e != nil {
			return e
		}
		code, e := emailCode()
		if e != nil {
			return e
		}
		contactID, mailID := uuid.NewString(), uuid.NewString()
		if e = s.notificationStore(ctx, tx, contactID, "contact", emailContactSecret{a.Email}); e != nil {
			return e
		}
		text := "Your Golf email verification code is " + code + ".\n\nEnter this code only in your signed-in Golf email settings. It expires in 30 minutes.\nThis verifies notification delivery only; it does not reset your password.\nIf you did not request this message, ignore it."
		body, e := emailMessage(secret.Sender, a.Email, m.OperationId, "Verify your Golf notification email", text)
		if e != nil {
			return e
		}
		if e = s.notificationStore(ctx, tx, mailID, "mail", emailMailSecret{a.Email, body}); e != nil {
			return e
		}
		_, e = tx.ExecContext(ctx, `INSERT INTO golf_email_contacts(user_id,local_account_id,native_user_id,credential_version,version,content_id,mailbox_hash) VALUES($1,$2,$3,$4,$5,$6,$7)
 ON CONFLICT(user_id) DO UPDATE SET local_account_id=EXCLUDED.local_account_id,native_user_id=EXCLUDED.native_user_id,credential_version=EXCLUDED.credential_version,version=EXCLUDED.version,content_id=EXCLUDED.content_id,mailbox_hash=EXCLUDED.mailbox_hash,verified_at=NULL,enabled=false,suppression='',preference_version=golf_email_contacts.preference_version+1,updated_at=clock_timestamp()`, a.UserID, a.LocalID, a.NativeID, a.CredentialVersion, v+1, contactID, emailHash(a.Email))
		if e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, `UPDATE golf_email_subscriptions SET enabled=false,authorization_state='authority_unavailable',epoch=epoch+1,updated_at=clock_timestamp() WHERE user_id=$1 AND enabled`, a.UserID); e != nil {
			return e
		}
		if e = tx.QueryRowContext(ctx, `INSERT INTO golf_email_challenges(id,user_id,contact_version,code_hash,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '30 minutes') RETURNING expires_at`, m.OperationId, a.UserID, v+1, emailCodeHash(m.OperationId, code)).Scan(&expires); e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, `INSERT INTO golf_email_deliveries(id,user_id,kind,contact_version,challenge_id,event_id,event_topic,transport_id,transport_version,activation_generation,content_id) VALUES($1,$2,'verification',$3,$1,$4,'verification',$5,$6,$7,$8)`, m.OperationId, a.UserID, v+1, "verification:"+m.OperationId, p.ID, p.Version, generation, mailID); e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, `INSERT INTO golf_email_events(user_id,action,object_id,version) VALUES($1,'verification_requested',$2,$3)`, a.UserID, m.OperationId, v+1); e != nil {
			return e
		}
		out.AcceptedContactVersion = strconv.FormatInt(v+1, 10)
		out.ChallengeId = m.OperationId
		out.DeliveryId = m.OperationId
		out.ExpiresAt = expires.UTC().Format(time.RFC3339Nano)
		out.State, e = s.emailState(ctx, tx, a)
		return e
	})
	if e != nil {
		return nil, notificationRPCError(e)
	}
	return connect.NewResponse(out), nil
}
func (s *Server) ConfirmEmailVerification(ctx context.Context, req *connect.Request[golfv1.ConfirmEmailVerificationRequest]) (*connect.Response[golfv1.ConfirmEmailVerificationResponse], error) {
	ctx, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	m := req.Msg
	v, e := emailVersion(m.ExpectedContactVersion, false)
	if e != nil || !creationKey.MatchString(m.ChallengeId) || !emailCodeValid(m.Code) {
		return nil, notificationRPCError(invalid("Provide the requested verification and eight-digit code."))
	}
	out := &golfv1.ConfirmEmailVerificationResponse{}
	incorrect := false
	e = s.withEmailAccount(ctx, req.Header(), func(tx *sql.Tx, a emailAccount) error {
		c, e := loadEmailContact(ctx, tx, a.UserID, true)
		if e != nil {
			return errResourceNotFound
		}
		if c.Version != v || !emailContactCurrent(c, a) {
			return errRepositorySettingsConflict
		}
		var expected []byte
		var attempts int
		var expires time.Time
		var confirmed sql.NullTime
		e = tx.QueryRowContext(ctx, `SELECT code_hash,attempts,expires_at,confirmed_at FROM golf_email_challenges WHERE id=$1 AND user_id=$2 AND contact_version=$3 FOR UPDATE`, m.ChallengeId, a.UserID, v).Scan(&expected, &attempts, &expires, &confirmed)
		if errors.Is(e, sql.ErrNoRows) {
			return errResourceNotFound
		}
		if e != nil {
			return e
		}
		if confirmed.Valid || !expires.After(time.Now()) || attempts >= 5 {
			return invalid("Verification is already used, expired or exhausted.")
		}
		if _, e = tx.ExecContext(ctx, `UPDATE golf_email_challenges SET attempts=attempts+1 WHERE id=$1`, m.ChallengeId); e != nil {
			return e
		}
		if subtle.ConstantTimeCompare(expected, emailCodeHash(m.ChallengeId, m.Code)) != 1 {
			incorrect = true
			return nil
		}
		if _, e = tx.ExecContext(ctx, `UPDATE golf_email_challenges SET confirmed_at=clock_timestamp() WHERE id=$1`, m.ChallengeId); e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, `UPDATE golf_email_contacts SET verified_at=clock_timestamp(),suppression='',updated_at=clock_timestamp() WHERE user_id=$1`, a.UserID); e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, `INSERT INTO golf_email_events(user_id,action,object_id,version) VALUES($1,'mailbox_verified',$2,$3)`, a.UserID, m.ChallengeId, v); e != nil {
			return e
		}
		out.State, e = s.emailState(ctx, tx, a)
		return e
	})
	if e != nil {
		return nil, notificationRPCError(e)
	}
	if incorrect {
		return nil, notificationRPCError(invalid("Verification code was not accepted."))
	}
	return connect.NewResponse(out), nil
}
func (s *Server) SaveOwnEmailPreference(ctx context.Context, req *connect.Request[golfv1.SaveOwnEmailPreferenceRequest]) (*connect.Response[golfv1.SaveOwnEmailPreferenceResponse], error) {
	ctx, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	m := req.Msg
	v, e := emailVersion(m.ExpectedContactVersion, false)
	pref, pErr := emailVersion(m.ExpectedPreferenceVersion, false)
	if e != nil || pErr != nil || m.Enabled && !m.AuthorizeBackground {
		return nil, notificationRPCError(invalid("Provide exact email preference versions and explicit background consent."))
	}
	out := &golfv1.SaveOwnEmailPreferenceResponse{}
	e = s.withEmailAccount(ctx, req.Header(), func(tx *sql.Tx, a emailAccount) error {
		c, e := loadEmailContact(ctx, tx, a.UserID, true)
		if e != nil {
			return errResourceNotFound
		}
		if c.Version != v || c.PreferenceVersion != pref || !emailContactCurrent(c, a) {
			return errRepositorySettingsConflict
		}
		if m.Enabled && (!c.VerifiedAt.Valid || c.Suppression != "") {
			return invalid("Verify your current notification email before enabling delivery.")
		}
		if _, e = tx.ExecContext(ctx, `UPDATE golf_email_contacts SET enabled=$2,preference_version=preference_version+1,updated_at=clock_timestamp() WHERE user_id=$1`, a.UserID, m.Enabled); e != nil {
			return e
		}
		if !m.Enabled {
			if _, e = tx.ExecContext(ctx, `UPDATE golf_email_subscriptions SET enabled=false,authorization_state='disabled',epoch=epoch+1,updated_at=clock_timestamp() WHERE user_id=$1 AND enabled`, a.UserID); e != nil {
				return e
			}
		}
		if _, e = tx.ExecContext(ctx, `INSERT INTO golf_email_events(user_id,action,version) VALUES($1,'email_preference_saved',$2)`, a.UserID, pref+1); e != nil {
			return e
		}
		out.State, e = s.emailState(ctx, tx, a)
		return e
	})
	if e != nil {
		return nil, notificationRPCError(e)
	}
	return connect.NewResponse(out), nil
}
func emailTarget(t *golfv1.RepositoryEmailTarget) (repositoryKey, int64, int64, error) {
	if t == nil {
		return repositoryKey{}, 0, 0, invalid("Select an exact repository.")
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
func (s *Server) withEmailRepository(ctx context.Context, header http.Header, t *golfv1.RepositoryEmailTarget, fn func() error) error {
	key, id, owner, e := emailTarget(t)
	if e != nil {
		return e
	}
	token, e := rpcToken(ctx)
	if e != nil {
		return e
	}
	return s.withForgeCaller(ctx, s.cookieValue(header), token, func(actor User) error {
		before, e := s.readRepositoryAccess(ctx, token, key, actor)
		if e != nil {
			return e
		}
		if before.RepositoryId != strconv.FormatInt(id, 10) || before.OwnerId != strconv.FormatInt(owner, 10) {
			return errResourceNotFound
		}
		if before.CurrentPermission == "none" {
			return forgeError{http.StatusForbidden}
		}
		if e = fn(); e != nil {
			return e
		}
		after, e := s.readRepositoryAccess(ctx, token, key, actor)
		if e != nil {
			return e
		}
		if after.RepositoryId != before.RepositoryId || after.OwnerId != before.OwnerId {
			return errResourceNotFound
		}
		if after.CurrentPermission == "none" {
			return forgeError{http.StatusForbidden}
		}
		return nil
	})
}

type emailSubscription struct {
	ID                                                      string
	UserID, RepoID, OwnerID, Version, Epoch, ContactVersion int64
	Topics                                                  []byte
	Enabled                                                 bool
	Authorization                                           string
	UpdatedAt                                               time.Time
	ContentID                                               string
}

const emailSubscriptionColumns = "id::text,user_id,repository_id,owner_id,version,epoch,contact_version,event_topics,enabled,authorization_state,updated_at,content_id::text"

func scanEmailSubscription(row interface{ Scan(...any) error }) (emailSubscription, error) {
	var s emailSubscription
	e := row.Scan(&s.ID, &s.UserID, &s.RepoID, &s.OwnerID, &s.Version, &s.Epoch, &s.ContactVersion, &s.Topics, &s.Enabled, &s.Authorization, &s.UpdatedAt, &s.ContentID)
	return s, e
}
func wireEmailSubscription(s emailSubscription) *golfv1.RepositoryEmailSubscription {
	var topics []string
	_ = json.Unmarshal(s.Topics, &topics)
	return &golfv1.RepositoryEmailSubscription{Id: s.ID, Version: strconv.FormatInt(s.Version, 10), ContactVersion: strconv.FormatInt(s.ContactVersion, 10), EventTopics: topics, Enabled: s.Enabled, AuthorizationState: s.Authorization, UpdatedAt: s.UpdatedAt.UTC().Format(time.RFC3339Nano)}
}
func (s *Server) GetRepositoryEmailSubscription(ctx context.Context, req *connect.Request[golfv1.GetRepositoryEmailSubscriptionRequest]) (*connect.Response[golfv1.GetRepositoryEmailSubscriptionResponse], error) {
	ctx, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	_, id, owner, e := emailTarget(req.Msg.Target)
	if e != nil {
		return nil, notificationRPCError(e)
	}
	out := &golfv1.GetRepositoryEmailSubscriptionResponse{Target: req.Msg.Target}
	e = s.withEmailRepository(ctx, req.Header(), req.Msg.Target, func() error {
		return s.withEmailAccount(ctx, req.Header(), func(tx *sql.Tx, a emailAccount) error {
			sub, e := scanEmailSubscription(tx.QueryRowContext(ctx, `SELECT `+emailSubscriptionColumns+` FROM golf_email_subscriptions WHERE user_id=$1 AND forge_url=$2 AND repository_id=$3 AND owner_id=$4`, a.UserID, s.config.GiteaURL, id, owner))
			if e != nil && !errors.Is(e, sql.ErrNoRows) {
				return e
			}
			if e == nil {
				out.Subscription = wireEmailSubscription(sub)
			}
			out.State, e = s.emailState(ctx, tx, a)
			return e
		})
	})
	if e != nil {
		return nil, notificationRPCError(e)
	}
	return connect.NewResponse(out), nil
}
func (s *Server) SaveRepositoryEmailSubscription(ctx context.Context, req *connect.Request[golfv1.SaveRepositoryEmailSubscriptionRequest]) (*connect.Response[golfv1.SaveRepositoryEmailSubscriptionResponse], error) {
	ctx, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	m := req.Msg
	key, repo, owner, e := emailTarget(m.Target)
	if e != nil {
		return nil, notificationRPCError(e)
	}
	v, e := emailVersion(m.ExpectedVersion, true)
	contact, cErr := emailVersion(m.ExpectedContactVersion, false)
	topics, tErr := webhookTopics(m.EventTopics)
	if e != nil || cErr != nil || tErr != nil || !creationKey.MatchString(m.Id) || m.Enabled && !m.AuthorizeBackground {
		return nil, notificationRPCError(invalid("Select exact subscription/mailbox versions, topics and explicit background consent."))
	}
	encoded, _ := json.Marshal(topics)
	out := &golfv1.SaveRepositoryEmailSubscriptionResponse{Target: m.Target}
	e = s.withEmailRepository(ctx, req.Header(), m.Target, func() error {
		return s.withEmailAccount(ctx, req.Header(), func(tx *sql.Tx, a emailAccount) error {
			c, e := loadEmailContact(ctx, tx, a.UserID, true)
			if e != nil {
				return errResourceNotFound
			}
			if c.Version != contact || !emailContactCurrent(c, a) {
				return errRepositorySettingsConflict
			}
			if m.Enabled && (!c.VerifiedAt.Valid || !c.Enabled || c.Suppression != "") {
				return invalid("Verify and enable your notification email first.")
			}
			old, e := scanEmailSubscription(tx.QueryRowContext(ctx, `SELECT `+emailSubscriptionColumns+` FROM golf_email_subscriptions WHERE user_id=$1 AND forge_url=$2 AND repository_id=$3 AND owner_id=$4 FOR UPDATE`, a.UserID, s.config.GiteaURL, repo, owner))
			exists := e == nil
			if e != nil && !errors.Is(e, sql.ErrNoRows) {
				return e
			}
			if exists && (old.ID != m.Id || old.Version != v || old.OwnerID != owner) || !exists && v != 0 {
				return errRepositorySettingsConflict
			}
			if !exists {
				// Bound transactional activity fanout across concurrent admissions.
				if _, e := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('golf-email-subscription-admission',0))`); e != nil {
					return e
				}
				var instanceCount, repositoryCount int
				if e := tx.QueryRowContext(ctx, `SELECT count(*),count(*) FILTER(WHERE forge_url=$1 AND repository_id=$2) FROM golf_email_subscriptions`, s.config.GiteaURL, repo).Scan(&instanceCount, &repositoryCount); e != nil {
					return e
				}
				if instanceCount >= 10000 || repositoryCount >= 500 {
					return connect.NewError(connect.CodeResourceExhausted, errors.New("Repository or instance email subscription capacity reached."))
				}
				var n int
				if e = tx.QueryRowContext(ctx, `SELECT count(*) FROM golf_email_subscriptions WHERE user_id=$1`, a.UserID).Scan(&n); e != nil {
					return e
				}
				if n >= 100 {
					return invalid("Up to 100 repository email subscriptions per account.")
				}
			}
			secret, e := emailToken()
			if e != nil {
				return e
			}
			contentID := uuid.NewString()
			if e = s.notificationStore(ctx, tx, contentID, "subscription", emailSubscriptionSecret{secret}); e != nil {
				return e
			}
			authorization := "disabled"
			if m.Enabled {
				authorization = "authorized"
			}
			if !exists {
				_, e = tx.ExecContext(ctx, `INSERT INTO golf_email_subscriptions(id,user_id,forge_url,repository_id,owner_id,repository_owner,repository_name,local_account_id,native_user_id,credential_version,contact_version,version,event_topics,enabled,authorization_state,unsubscribe_hash,content_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,$13,$14,$15,$16)`, m.Id, a.UserID, s.config.GiteaURL, repo, owner, key.Owner, key.Name, a.LocalID, a.NativeID, a.CredentialVersion, contact, encoded, m.Enabled, authorization, emailHash(secret), contentID)
			} else {
				_, e = tx.ExecContext(ctx, `UPDATE golf_email_subscriptions SET repository_owner=$2,repository_name=$3,credential_version=$4,contact_version=$5,version=version+1,epoch=epoch+1,event_topics=$6,enabled=$7,authorization_state=$8,unsubscribe_hash=$9,content_id=$10,updated_at=clock_timestamp() WHERE id=$1`, m.Id, key.Owner, key.Name, a.CredentialVersion, contact, encoded, m.Enabled, authorization, emailHash(secret), contentID)
			}
			if e != nil {
				return e
			}
			if _, e = tx.ExecContext(ctx, `INSERT INTO golf_email_events(user_id,action,object_id,version) VALUES($1,'subscription_saved',$2,$3)`, a.UserID, m.Id, v+1); e != nil {
				return e
			}
			saved, e := scanEmailSubscription(tx.QueryRowContext(ctx, `SELECT `+emailSubscriptionColumns+` FROM golf_email_subscriptions WHERE id=$1`, m.Id))
			out.Subscription = wireEmailSubscription(saved)
			return e
		})
	})
	if e != nil {
		return nil, notificationRPCError(e)
	}
	return connect.NewResponse(out), nil
}

// Opaque capability has no identity/repository output. GET never changes state;
// only a deliberate POST disables this exact current subscription version.
func (s *Server) EmailUnsubscribeHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "Method unavailable", 405)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1024)
		token := r.URL.Query().Get("token")
		if r.Method == http.MethodPost {
			if r.ParseForm() != nil {
				http.Error(w, "Invalid confirmation", 400)
				return
			}
			token = r.PostForm.Get("token")
		}
		if len(token) != 43 {
			http.Error(w, "Invalid confirmation", 400)
			return
		}
		raw, e := base64.RawURLEncoding.DecodeString(token)
		if e != nil || len(raw) != 32 || base64.RawURLEncoding.EncodeToString(raw) != token {
			http.Error(w, "Invalid confirmation", 400)
			return
		}
		if r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = fmt.Fprintf(w, `<!doctype html><html><meta name="viewport" content="width=device-width"><title>Golf email preference</title><h1>Stop these Golf emails?</h1><p>Confirm to disable this repository email subscription. Opening this page does not change your preferences.</p><form method="post" action="/notifications/unsubscribe"><input type="hidden" name="token" value="%s"><button>Unsubscribe</button></form></html>`, token)
			return
		}
		ctx, stop := context.WithTimeout(r.Context(), 5*time.Second)
		defer stop()
		tx, e := s.db.BeginTx(ctx, nil)
		if e != nil {
			http.Error(w, "Confirmation unavailable", 503)
			return
		}
		defer tx.Rollback()
		var id string
		var user, version int64
		e = tx.QueryRowContext(ctx, `UPDATE golf_email_subscriptions SET enabled=false,authorization_state='unsubscribed',epoch=epoch+1,updated_at=clock_timestamp() WHERE unsubscribe_hash=$1 AND enabled RETURNING id::text,user_id,version`, emailHash(token)).Scan(&id, &user, &version)
		if e != nil && !errors.Is(e, sql.ErrNoRows) {
			http.Error(w, "Confirmation unavailable", 503)
			return
		}
		if e == nil {
			if _, e = tx.ExecContext(ctx, `INSERT INTO golf_email_events(user_id,action,object_id,version) VALUES($1,'subscription_unsubscribed',$2,$3)`, user, id, version); e != nil {
				http.Error(w, "Confirmation unavailable", 503)
				return
			}
		}
		if tx.Commit() != nil {
			http.Error(w, "Confirmation unavailable", 503)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("This email subscription is disabled or no longer active. Other preferences are unchanged.\n"))
	})
}
func (s *Server) emailUnsubscribeURL(token string) string {
	return s.config.PublicURL + "/notifications/unsubscribe?token=" + url.QueryEscape(token)
}
