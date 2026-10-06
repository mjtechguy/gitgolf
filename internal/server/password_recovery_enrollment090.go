package server

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

type recoveryEnrollment90 struct {
	Account, Native, Credential, Contact, Version int64
	Enabled                                       bool
}

func recoveryEnrollmentCurrent90(v recoveryEnrollment90, a emailAccount, contact int64) bool {
	return v.Account == a.LocalID && v.Native == a.NativeID && v.Credential == a.CredentialVersion && v.Contact == contact
}

func (s *Server) recoveryEnrollmentState90(ctx context.Context, tx database.DBTX, a emailAccount) (*golfv1.PasswordRecoveryEnrollment, error) {
	out := &golfv1.PasswordRecoveryEnrollment{UserId: strconv.FormatInt(a.UserID, 10), NativeUserId: strconv.FormatInt(a.NativeID, 10), LocalAccountId: strconv.FormatInt(a.LocalID, 10), CredentialVersion: strconv.FormatInt(a.CredentialVersion, 10), ContactVersion: "0", Version: "0", LoginEmail: a.Email}
	contact, e := loadEmailContact(ctx, tx, a.UserID, false)
	if e != nil && !errors.Is(e, sql.ErrNoRows) {
		return nil, errStorageUnavailable
	}
	if e == nil {
		out.ContactVersion = strconv.FormatInt(contact.Version, 10)
		out.EmailVerified = emailContactCurrent(contact, a) && contact.VerifiedAt.Valid && contact.Suppression == ""
	}
	mfa, e := loadLocalMFA(ctx, tx, a.LocalID, false)
	if e != nil && !errors.Is(e, sql.ErrNoRows) {
		return nil, errStorageUnavailable
	}
	out.MfaEnabled = e == nil && mfa.Enabled
	var saved recoveryEnrollment90
	e = tx.QueryRowContext(ctx, `SELECT local_account_id,native_user_id,credential_version,contact_version,version,enabled FROM golf_password_recovery_enrollments WHERE user_id=$1`, a.UserID).Scan(&saved.Account, &saved.Native, &saved.Credential, &saved.Contact, &saved.Version, &saved.Enabled)
	if e != nil && !errors.Is(e, sql.ErrNoRows) {
		return nil, errStorageUnavailable
	}
	if e == nil {
		out.Version = strconv.FormatInt(saved.Version, 10)
		out.EnrollmentCurrent = recoveryEnrollmentCurrent90(saved, a, contact.Version)
		out.Enabled = saved.Enabled && out.EnrollmentCurrent && out.EmailVerified
	}
	return out, nil
}

func (s *Server) GetOwnPasswordRecoveryEnrollment(ctx context.Context, req *connect.Request[golfv1.GetOwnPasswordRecoveryEnrollmentRequest]) (*connect.Response[golfv1.GetOwnPasswordRecoveryEnrollmentResponse], error) {
	ctx, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	var out *golfv1.PasswordRecoveryEnrollment
	e := s.withEmailAccount(ctx, req.Header(), func(tx *sql.Tx, a emailAccount) error {
		var e error
		out, e = s.recoveryEnrollmentState90(ctx, tx, a)
		return e
	})
	if e != nil {
		return nil, notificationRPCError(e)
	}
	return connect.NewResponse(&golfv1.GetOwnPasswordRecoveryEnrollmentResponse{Enrollment: out}), nil
}

func (s *Server) SaveOwnPasswordRecoveryEnrollment(ctx context.Context, req *connect.Request[golfv1.SaveOwnPasswordRecoveryEnrollmentRequest]) (*connect.Response[golfv1.SaveOwnPasswordRecoveryEnrollmentResponse], error) {
	ctx, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	m := req.Msg
	account, e := discussionID(m.LocalAccountId)
	if e != nil {
		return nil, notificationRPCError(invalid("Select your current local account."))
	}
	native, e := discussionID(m.NativeUserId)
	if e != nil {
		return nil, notificationRPCError(invalid("Select your current local account."))
	}
	credential, e := emailVersion(m.ExpectedCredentialVersion, false)
	contact, cErr := emailVersion(m.ExpectedContactVersion, true)
	version, vErr := emailVersion(m.ExpectedVersion, true)
	if e != nil || cErr != nil || vErr != nil || len(m.MfaCode) > 27 {
		return nil, notificationRPCError(invalid("Select exact saved recovery versions."))
	}
	var out *golfv1.PasswordRecoveryEnrollment
	e = s.withOwnMFA(ctx, req.Header(), m.PasswordConfirmation, func(tx *sql.Tx, row database.GetOwnPasswordConfirmationRow) error {
		if row.ID != account || row.ForgeUserID != native || row.CredentialVersion != credential {
			return errRepositorySettingsConflict
		}
		mfa, e := loadLocalMFA(ctx, tx, account, true)
		if e != nil && !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		// Match the existing user/account/MFA order before contact/enrollment.
		if _, e = loadEmailContact(ctx, tx, row.UserID, true); e != nil && !errors.Is(e, sql.ErrNoRows) {
			return errStorageUnavailable
		}
		a := emailAccount{UserID: row.UserID, NativeID: row.ForgeUserID, LocalID: row.ID, CredentialVersion: row.CredentialVersion, Email: row.Email.String}
		state, e := s.recoveryEnrollmentState90(ctx, tx, a)
		if e != nil {
			return e
		}
		if state.Version != m.ExpectedVersion || state.ContactVersion != m.ExpectedContactVersion || m.Enabled && !state.EmailVerified || state.EnrollmentCurrent && state.Enabled == m.Enabled {
			return errRepositorySettingsConflict
		}
		if mfa.Enabled {
			recovery, e := s.consumeMFA(ctx, tx, mfa, m.MfaCode)
			if e != nil {
				return e
			}
			if recovery {
				if _, e = tx.ExecContext(ctx, `INSERT INTO golf_mfa_events(account_id,user_id,action,version) VALUES($1,$2,'recovery_used',$3)`, account, row.UserID, mfa.Version); e != nil {
					return errStorageUnavailable
				}
			}
		} else if m.MfaCode != "" {
			return invalid("No authenticator confirmation is required for this account.")
		}
		_, e = tx.ExecContext(ctx, `INSERT INTO golf_password_recovery_enrollments(user_id,local_account_id,native_user_id,credential_version,contact_version,version,enabled) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id) DO UPDATE SET local_account_id=EXCLUDED.local_account_id,native_user_id=EXCLUDED.native_user_id,credential_version=EXCLUDED.credential_version,contact_version=EXCLUDED.contact_version,version=EXCLUDED.version,enabled=EXCLUDED.enabled,updated_at=clock_timestamp()`, row.UserID, account, native, credential, contact, version+1, m.Enabled)
		if e != nil {
			return errStorageUnavailable
		}
		if _, e = tx.ExecContext(ctx, `INSERT INTO golf_password_recovery_enrollment_events(user_id,local_account_id,native_user_id,credential_version,contact_version,version,enabled,actor_session_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, row.UserID, account, native, credential, contact, version+1, m.Enabled, row.SessionID); e != nil {
			return errStorageUnavailable
		}
		out, e = s.recoveryEnrollmentState90(ctx, tx, a)
		return e
	})
	if e != nil {
		return nil, notificationRPCError(e)
	}
	return connect.NewResponse(&golfv1.SaveOwnPasswordRecoveryEnrollmentResponse{Enrollment: out}), nil
}
