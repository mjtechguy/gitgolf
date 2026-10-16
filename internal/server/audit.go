package server

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"strconv"

	"github.com/mjtechguy/golf-git/internal/server/database"
)

func newAuditOperation() (string, error) {
	var random [24]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", errStorageUnavailable
	}
	return base64.RawURLEncoding.EncodeToString(random[:]), nil
}

func appendAudit(ctx context.Context, queries *database.Queries, event database.AppendAuditEventParams) error {
	if event.OperationID == "" {
		operation, err := newAuditOperation()
		if err != nil {
			return err
		}
		event.OperationID = operation
	}
	if err := queries.AppendAuditEvent(ctx, event); err != nil {
		return errStorageUnavailable
	}
	return nil
}

func auditCursor(value string) (int64, error) {
	if value == "" {
		return 0, nil
	}
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id <= 0 || strconv.FormatInt(id, 10) != value {
		return 0, invalid("Audit cursors must be positive decimal identifiers.")
	}
	return id, nil
}

func (s *Server) listAuditEvents(ctx context.Context, value string, credential forgeCredential, limit uint32, beforeValue, snapshotValue string) ([]database.ListAuditEventsRow, string, string, error) {
	if limit == 0 {
		limit = 20
	}
	if limit > 100 {
		return nil, "", "", invalid("Audit page size must be 1–100.")
	}
	before, err := auditCursor(beforeValue)
	if err != nil {
		return nil, "", "", err
	}
	snapshot, err := auditCursor(snapshotValue)
	if err != nil {
		return nil, "", "", err
	}
	if before != 0 && (snapshot == 0 || before > snapshot) {
		return nil, "", "", invalid("Audit before_id requires snapshot_id and must not exceed it.")
	}
	var rows []database.ListAuditEventsRow
	err = s.withManagedSession(ctx, value, credential, func(queries *database.Queries, caller database.LockManagedSessionRow, hash []byte) error {
		// Validate opaque cursors in the same immutable account scope as the
		// listing. A guessed future bound must never admit later insertions.
		for _, cursor := range []int64{snapshot, before} {
			if cursor == 0 {
				continue
			}
			own, err := queries.OwnAuditCursor(ctx, database.OwnAuditCursorParams{EventID: cursor, UserID: caller.UserID, ForgeURL: s.config.ForgeURL, CallerTokenHash: hash})
			if err != nil {
				return errStorageUnavailable
			}
			if !own {
				return invalid("Audit cursor does not identify an event in this account.")
			}
		}
		var err error
		if snapshot == 0 {
			snapshot, err = queries.GetAuditSnapshot(ctx, database.GetAuditSnapshotParams{UserID: caller.UserID, ForgeURL: s.config.ForgeURL, CallerTokenHash: hash})
			if err != nil {
				return errStorageUnavailable
			}
		}
		rows, err = queries.ListAuditEvents(ctx, database.ListAuditEventsParams{UserID: caller.UserID, ForgeURL: s.config.ForgeURL, CallerTokenHash: hash, SnapshotID: snapshot, BeforeID: before, RowLimit: int32(limit + 1)})
		if err != nil {
			return errStorageUnavailable
		}
		return nil
	})
	if err != nil {
		return nil, "", "", err
	}
	next := ""
	if len(rows) > int(limit) {
		rows = rows[:limit]
		next = strconv.FormatInt(rows[len(rows)-1].ID, 10)
	}
	upper := ""
	if snapshot != 0 {
		upper = strconv.FormatInt(snapshot, 10)
	}
	return rows, next, upper, nil
}

func auditTarget(id int64) sql.NullInt64 { return sql.NullInt64{Int64: id, Valid: true} }
