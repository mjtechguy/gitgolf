package server

import (
	"context"
	"database/sql"
	"strconv"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

func emailPauseBinding(m *golfv1.DeactivateEmailTransportRequest) (int64, int64, error) {
	version, err := emailVersion(m.Version, false)
	generation, generationErr := emailVersion(m.ExpectedActivationGeneration, false)
	if err != nil || generationErr != nil || !creationKey.MatchString(m.Id) {
		return 0, 0, invalid("Select the exact active SMTP transport and activation generation.")
	}
	return version, generation, nil
}

// Pausing changes configuration only. The existing consumer's generation fence
// cancels older queued/retrying attempts and checks live attempts before DATA.
// SMTP may already have accepted a message; this control never recalls it.
func (s *Server) DeactivateEmailTransport(ctx context.Context, req *connect.Request[golfv1.DeactivateEmailTransportRequest]) (*connect.Response[golfv1.DeactivateEmailTransportResponse], error) {
	ctx, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	m := req.Msg
	version, generation, err := emailPauseBinding(m)
	if err != nil {
		return nil, notificationRPCError(err)
	}
	token, err := rpcToken(ctx)
	if err != nil {
		return nil, notificationRPCError(err)
	}
	confirmation, err := s.confirmInfrastructureAdmin(ctx, s.cookieValue(req.Header()), token, m.CurrentPassword)
	if err != nil {
		return nil, notificationRPCError(err)
	}
	var profile emailSMTPProfile
	err = s.infrastructureAdminTransaction(ctx, s.cookieValue(req.Header()), confirmation, func(tx *sql.Tx) error {
		var id sql.NullString
		var activeVersion sql.NullInt64
		var currentGeneration int64
		if err := tx.QueryRowContext(ctx, `SELECT transport_id::text,transport_version,generation FROM golf_email_configuration WHERE singleton FOR UPDATE`).Scan(&id, &activeVersion, &currentGeneration); err != nil {
			return err
		}
		if !id.Valid || !activeVersion.Valid || id.String != m.Id || activeVersion.Int64 != version || currentGeneration != generation {
			return errRepositorySettingsConflict
		}
		var err error
		profile, err = scanEmailProfile(tx.QueryRowContext(ctx, `SELECT `+emailProfileColumns+` FROM golf_email_transports WHERE id=$1 AND version=$2`, m.Id, version))
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `UPDATE golf_email_configuration SET transport_id=NULL,transport_version=NULL,generation=generation+1 WHERE singleton`); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO golf_email_events(user_id,action,object_id,version) VALUES($1,'transport_deactivated',$2,$3)`, confirmation.UserID, m.Id, version)
		return err
	})
	if err != nil {
		return nil, notificationRPCError(err)
	}
	return connect.NewResponse(&golfv1.DeactivateEmailTransportResponse{Transport: wireEmailProfile(profile, false), ActivationGeneration: strconv.FormatInt(generation+1, 10)}), nil
}
