package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"net/http"
	"net/mail"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/mjtechguy/golf-git/internal/server/database"
	"golang.org/x/crypto/argon2"
)

const localAccountDomain = "local-account"
const localPasswordPrefix = "$argon2id$v=19$m=19456,t=2,p=1$"

var localUsername = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{2,63}$`)

// Argon2 cannot be interrupted mid-computation. Slots are released only after
// it returns, even when the requesting context is cancelled. This caps each
// process at four concurrent 19 MiB KDFs; DB counters span every replica.
var localKDFSlots = make(chan struct{}, 4)

type LocalAccountInput struct {
	Username        string `json:"username"`
	Email           string `json:"email,omitempty"`
	Password        string `json:"password"`
	ForgeToken      string `json:"forge_token"`
	IsInstanceAdmin bool   `json:"is_instance_admin"`
}
type LocalAccountResult struct {
	ID                string `json:"id"`
	Username          string `json:"username"`
	Email             string `json:"email,omitempty"`
	UserID            string `json:"user_id"`
	IsInstanceAdmin   bool   `json:"is_instance_admin"`
	Disabled          bool   `json:"disabled"`
	CredentialVersion string `json:"credential_version"`
	SessionsRevoked   uint64 `json:"sessions_revoked"`
}
type localLoginBinding struct {
	accountID, userID, version int64
	mfaChallenge               []byte
	mfaVersion                 int64
	mfaCode                    string
	background                 bool
}

// Login addresses are case-insensitive ASCII mailboxes; display names, Unicode,
// whitespace and provider-specific dot/plus rewriting are deliberately rejected.
func canonicalLocalEmail(value string) (string, bool) {
	value = strings.ToLower(value)
	if len(value) > 254 || len(value) < 3 || strings.ContainsAny(value, " \t\r\n") {
		return "", false
	}
	for _, c := range value {
		if c > 127 {
			return "", false
		}
	}
	parsed, err := mail.ParseAddress(value)
	if err != nil || parsed.Address != value || parsed.Name != "" {
		return "", false
	}
	parts := strings.Split(value, "@")
	if len(parts) != 2 || len(parts[0]) > 64 || !localEmailSyntax.MatchString(value) {
		return "", false
	}
	for _, label := range strings.Split(parts[1], ".") {
		if len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return "", false
		}
	}
	return value, true
}

var localEmailSyntax = regexp.MustCompile("^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(\\.[a-z0-9-]+)+$")

func validLocalPassword(password string) bool {
	return len(password) <= 1024 && utf8.ValidString(password) && utf8.RuneCountInString(password) >= 15
}
func deriveLocalPassword(ctx context.Context, password string, salt []byte) ([]byte, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	select {
	case localKDFSlots <- struct{}{}:
	default:
		return nil, errLocalRateLimited
	}
	defer func() { <-localKDFSlots }()
	result := argon2.IDKey([]byte(password), salt, 2, 19456, 1, 32)
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return result, nil
}
func hashLocalPassword(ctx context.Context, password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", errCredentialUnavailable
	}
	hash, err := deriveLocalPassword(ctx, password, salt)
	if err != nil {
		return "", err
	}
	return localPasswordPrefix + base64.RawStdEncoding.EncodeToString(salt) + "$" + base64.RawStdEncoding.EncodeToString(hash), nil
}
func verifyLocalPassword(ctx context.Context, password, encoded string) (bool, error) {
	// Unknown/disabled/malformed records perform exactly the same fixed-cost KDF.
	salt, expected := make([]byte, 16), make([]byte, 32)
	valid := false
	if strings.HasPrefix(encoded, localPasswordPrefix) {
		fields := strings.Split(strings.TrimPrefix(encoded, localPasswordPrefix), "$")
		if len(fields) == 2 {
			s, e1 := base64.RawStdEncoding.DecodeString(fields[0])
			h, e2 := base64.RawStdEncoding.DecodeString(fields[1])
			if e1 == nil && e2 == nil && len(s) == 16 && len(h) == 32 && base64.RawStdEncoding.EncodeToString(s) == fields[0] && base64.RawStdEncoding.EncodeToString(h) == fields[1] {
				salt, expected, valid = s, h, true
			}
		}
	}
	actual, err := deriveLocalPassword(ctx, password, salt)
	if err != nil {
		return false, err
	}
	return subtle.ConstantTimeCompare(actual, expected) == 1 && valid, nil
}
func localLoginBucket(username string) int16 {
	digest := sha256.Sum256([]byte(username))
	return int16(binary.BigEndian.Uint16(digest[:2])%1024) + 1
}
func (s *Server) loginLocalSession(ctx context.Context, username, password, oldValue string) (loginResult, error) {
	username = strings.ToLower(strings.TrimSpace(username))
	email, isEmail := canonicalLocalEmail(username)
	if (!localUsername.MatchString(username) && !isEmail) || !validLocalPassword(password) {
		return loginResult{}, errLocalCredentials
	}
	if s.db == nil {
		return loginResult{}, errStorageUnavailable
	}
	// Resolve the alias before charging the fixed account bucket so email and
	// username cannot each receive an independent password-guess allowance.
	q := database.New(s.db)
	var row database.GetLocalAccountRow
	var err error
	if isEmail {
		alias, lookupErr := q.GetLocalAccountByEmail(ctx, database.GetLocalAccountByEmailParams{Email: sql.NullString{String: email, Valid: true}, ForgeURL: s.config.GiteaURL})
		err = lookupErr
		row = database.GetLocalAccountRow(alias)
	} else {
		row, err = q.GetLocalAccount(ctx, database.GetLocalAccountParams{Username: username, ForgeURL: s.config.GiteaURL})
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return loginResult{}, errStorageUnavailable
	}
	bucketName := username
	if err == nil {
		bucketName = row.Username
	}
	reservation, limitErr := s.reserveLocalPasswordAttempt(ctx, bucketName)
	if limitErr != nil {
		return loginResult{}, limitErr
	}
	exists := err == nil
	ok, err := verifyLocalPassword(ctx, password, row.PasswordHash)
	if err != nil {
		return loginResult{}, err
	}
	if !exists || !ok || row.DisabledAt.Valid {
		return loginResult{}, errLocalCredentials
	}
	token, err := s.keyring.open(row.CredentialKeyID, localAccountDomain, row.EncryptedForgeToken, row.CredentialBinding)
	if err != nil {
		return loginResult{}, errCredentialUnavailable
	}
	user, err := s.currentUser(ctx, forgeCredential{Kind: "pat", Token: token})
	if err != nil {
		var upstream forgeError
		if errors.As(err, &upstream) && (upstream.status == 401 || upstream.status == 403 || upstream.status == 404) {
			return loginResult{}, errLocalCredentials
		}
		return loginResult{}, err
	}
	if user.ID != row.ForgeUserID {
		return loginResult{}, errLocalCredentials
	}
	user.IsInstanceAdmin = row.IsInstanceAdmin
	challenge, expires, required, err := s.beginMFALogin(ctx, row)
	if err != nil {
		return loginResult{}, err
	}
	if required {
		_ = s.releaseLocalPasswordAttempt(ctx, reservation)
		return loginResult{MFAChallenge: challenge, Expires: expires}, nil
	}
	result, err := s.createSessionBound(ctx, user, "local", token, oldValue, &localLoginBinding{accountID: row.ID, userID: row.UserID, version: row.CredentialVersion})
	if err != nil {
		return loginResult{}, err
	}
	// Session binding already committed. Counter housekeeping cannot turn that
	// sign-in into a false failure or create an unacknowledged replacement.
	// Release is once-only; SQL/cancellation failure gets no refund retry.
	_ = s.releaseLocalPasswordAttempt(ctx, reservation)
	return result, nil
}

// Every successful local-authenticated RPC rechecks this after provider work.
// A deleted session is a denial, never a fallback to a native PAT identity.
func (s *Server) localSessionUser(ctx context.Context, value string, user User) (User, error) {
	user.IsInstanceAdmin = false
	hash, err := s.authSessionHash(ctx, value, nil)
	if err != nil {
		return User{}, err
	}
	if s.db == nil {
		return User{}, errStorageUnavailable
	}
	row, err := database.New(s.db).LocalSessionAuthority(ctx, database.LocalSessionAuthorityParams{TokenHash: hash, ForgeURL: s.config.GiteaURL})
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, errUnauthenticated
	}
	if err != nil {
		return User{}, errStorageUnavailable
	}
	if row.ForgeUserID != user.ID || !row.ExpiresAt.After(time.Now()) {
		return User{}, errUnauthenticated
	}
	if row.LocalAccountID.Valid {
		if row.DisabledAt.Valid || !row.CredentialVersion.Valid || row.CredentialVersion.Int64 != row.LocalCredentialVersion.Int64 || !row.LocalCredentialVersion.Valid {
			return User{}, errUnauthenticated
		}
		user.IsInstanceAdmin = row.IsInstanceAdmin.Valid && row.IsInstanceAdmin.Bool
	}
	return user, nil
}

// ManageLocalAccount is the operator entry point. Browser lifecycle handlers
// separately enforce actor confirmation and target revisions; native passwords
// are never accepted.
func ManageLocalAccount(ctx context.Context, db *sql.DB, keys *Keyring, forgeURL, action string, input LocalAccountInput) (LocalAccountResult, error) {
	bad := errors.New("Local account input is invalid; use a canonical username and a 15-character minimum password of at most 1024 UTF-8 bytes.")
	if !localUsername.MatchString(input.Username) {
		return LocalAccountResult{}, bad
	}
	if input.Email != "" {
		email, valid := canonicalLocalEmail(input.Email)
		if !valid || (action != "create" && action != "set-email") {
			return LocalAccountResult{}, bad
		}
		input.Email = email
	}
	switch action {
	case "set-email":
		if input.Email == "" || input.Password != "" || input.ForgeToken != "" || input.IsInstanceAdmin {
			return LocalAccountResult{}, bad
		}
	case "create", "enable":
		if !validLocalPassword(input.Password) || len(input.ForgeToken) < 8 || len(input.ForgeToken) > 512 || strings.ContainsAny(input.ForgeToken, " \t\r\n") || action == "enable" && input.IsInstanceAdmin {
			return LocalAccountResult{}, bad
		}
	case "reset-password":
		if !validLocalPassword(input.Password) || input.ForgeToken != "" || input.IsInstanceAdmin {
			return LocalAccountResult{}, bad
		}
	case "disable":
		if input.Password != "" || input.ForgeToken != "" || input.IsInstanceAdmin {
			return LocalAccountResult{}, bad
		}
	default:
		return LocalAccountResult{}, bad
	}
	parsed, err := url.Parse(forgeURL)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return LocalAccountResult{}, errors.New("Forge configuration is invalid.")
	}
	forgeURL = strings.TrimRight(forgeURL, "/")
	if db == nil {
		return LocalAccountResult{}, errStorageUnavailable
	}
	if err := checkRuntimeKeys(ctx, db, keys); err != nil {
		return LocalAccountResult{}, err
	}
	var native User
	if action == "create" || action == "enable" {
		s := &Server{config: Config{GiteaURL: forgeURL}, client: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
		native, err = s.currentUser(ctx, forgeCredential{Kind: "pat", Token: input.ForgeToken})
		if err != nil {
			return LocalAccountResult{}, errors.New("The mapped forge token could not be verified.")
		}
	}
	passwordHash := ""
	if action != "disable" && action != "set-email" {
		passwordHash, err = hashLocalPassword(ctx, input.Password)
		if err != nil {
			return LocalAccountResult{}, err
		}
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return LocalAccountResult{}, errStorageUnavailable
	}
	defer tx.Rollback()
	q := database.New(db).WithTx(tx)
	operation, err := newAuditOperation()
	if err != nil {
		return LocalAccountResult{}, err
	}
	var row database.GolfLocalAccount
	var revoked int64
	event := "CREATED"
	if action == "create" {
		if err := q.EnsureLoginUser(ctx, database.EnsureLoginUserParams{ForgeURL: forgeURL, ForgeUserID: native.ID, Login: native.Login, FullName: native.FullName, AvatarURL: native.AvatarURL}); err != nil {
			return LocalAccountResult{}, errStorageUnavailable
		}
		if _, err := q.LockLoginUsers(ctx, database.LockLoginUsersParams{ForgeURL: forgeURL, ForgeUserID: native.ID}); err != nil {
			return LocalAccountResult{}, errStorageUnavailable
		}
		userID, err := q.UpsertUser(ctx, database.UpsertUserParams{ForgeURL: forgeURL, ForgeUserID: native.ID, Login: native.Login, FullName: native.FullName, AvatarURL: native.AvatarURL})
		if err != nil {
			return LocalAccountResult{}, errStorageUnavailable
		}
		binding := make([]byte, 32)
		if _, err := rand.Read(binding); err != nil {
			return LocalAccountResult{}, errCredentialUnavailable
		}
		encrypted, keyID, err := keys.seal(localAccountDomain, input.ForgeToken, binding)
		if err != nil {
			return LocalAccountResult{}, err
		}
		row, err = q.CreateLocalAccount(ctx, database.CreateLocalAccountParams{UserID: userID, Username: input.Username, PasswordHash: passwordHash, EncryptedForgeToken: encrypted, CredentialBinding: binding, CredentialKeyID: keyID, IsInstanceAdmin: input.IsInstanceAdmin, Email: sql.NullString{String: input.Email, Valid: input.Email != ""}})
		if err != nil {
			var pg *pgconn.PgError
			if errors.As(err, &pg) && pg.Code == "23505" {
				return LocalAccountResult{}, errors.New("The local username, email or immutable forge identity is already enrolled.")
			}
			return LocalAccountResult{}, errStorageUnavailable
		}
	} else {
		userID, err := q.LockLocalAccountUser(ctx, database.LockLocalAccountUserParams{Username: input.Username, ForgeURL: forgeURL})
		if errors.Is(err, sql.ErrNoRows) {
			return LocalAccountResult{}, errors.New("The local account does not exist for this forge.")
		}
		if err != nil {
			return LocalAccountResult{}, errStorageUnavailable
		}
		account, err := q.GetLocalAccount(ctx, database.GetLocalAccountParams{Username: input.Username, ForgeURL: forgeURL})
		if err != nil {
			return LocalAccountResult{}, errStorageUnavailable
		}
		row, err = q.LockLocalAccount(ctx, database.LockLocalAccountParams{ID: account.ID, UserID: userID})
		if err != nil {
			return LocalAccountResult{}, errStorageUnavailable
		}
		switch action {
		case "set-email":
			event = "EMAIL_CHANGED"
			err = q.ChangeLocalEmail(ctx, database.ChangeLocalEmailParams{ID: row.ID, Email: sql.NullString{String: input.Email, Valid: true}})
			if err != nil {
				var pg *pgconn.PgError
				if errors.As(err, &pg) && pg.Code == "23505" {
					return LocalAccountResult{}, errors.New("The local email is already enrolled.")
				}
			}
			row.Email = sql.NullString{String: input.Email, Valid: true}
		case "reset-password":
			event = "PASSWORD_RESET"
			err = q.ChangeLocalPassword(ctx, database.ChangeLocalPasswordParams{ID: row.ID, PasswordHash: passwordHash})
		case "disable":
			if row.DisabledAt.Valid {
				return localAccountResult(row, 0), nil
			}
			event = "DISABLED"
			err = q.DisableLocalAccount(ctx, row.ID)
			row.DisabledAt = sql.NullTime{Time: time.Now(), Valid: true}
		case "enable":
			if native.ID != account.ForgeUserID {
				return LocalAccountResult{}, errors.New("The replacement token does not match the immutable forge identity.")
			}
			if !row.DisabledAt.Valid {
				return LocalAccountResult{}, errors.New("The local account is already enabled; disable it before replacing its forge credential.")
			}
			encrypted, keyID, sealErr := keys.seal(localAccountDomain, input.ForgeToken, row.CredentialBinding)
			if sealErr != nil {
				return LocalAccountResult{}, sealErr
			}
			event = "ENABLED"
			err = q.EnableLocalAccount(ctx, database.EnableLocalAccountParams{ID: row.ID, PasswordHash: passwordHash, EncryptedForgeToken: encrypted, CredentialKeyID: keyID})
			row.DisabledAt = sql.NullTime{}
		}
		if err != nil {
			return LocalAccountResult{}, errStorageUnavailable
		}
		row.CredentialVersion++
		revoked, err = q.DeleteLocalAccountSessions(ctx, sql.NullInt64{Int64: row.ID, Valid: true})
		if err != nil {
			return LocalAccountResult{}, errStorageUnavailable
		}
		if action != "disable" {
			if err := q.ResetLocalLoginLimit(ctx, localLoginBucket(input.Username)); err != nil {
				return LocalAccountResult{}, errStorageUnavailable
			}
		}
	}
	if err := q.AppendLocalAccountEvent(ctx, database.AppendLocalAccountEventParams{AccountID: row.ID, OperationID: operation, Action: event, CredentialVersion: row.CredentialVersion, SessionsRevoked: revoked}); err != nil {
		return LocalAccountResult{}, errStorageUnavailable
	}
	if err := tx.Commit(); err != nil {
		return LocalAccountResult{}, errStorageUnavailable
	}
	return localAccountResult(row, revoked), nil
}
func localAccountResult(row database.GolfLocalAccount, revoked int64) LocalAccountResult {
	return LocalAccountResult{ID: strconv.FormatInt(row.ID, 10), Username: row.Username, Email: row.Email.String, UserID: strconv.FormatInt(row.UserID, 10), IsInstanceAdmin: row.IsInstanceAdmin, Disabled: row.DisabledAt.Valid, CredentialVersion: strconv.FormatInt(row.CredentialVersion, 10), SessionsRevoked: uint64(revoked)}
}
