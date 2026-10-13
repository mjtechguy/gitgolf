package server

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"time"
)

var forgeInstanceID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)

// A destination must enroll against a fresh Golf database. Existing current-state
// identities need a verified transfer, never an automatic URL/ID rewrite.
func BindForgeInstallation(ctx context.Context, db *sql.DB, c Config) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if db == nil {
		return nil
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(719083529)"); err != nil {
		return err
	}
	var kind, origin, identity, directories string
	err = tx.QueryRowContext(ctx, "SELECT kind, origin, instance_id, workflow_directories FROM golf_forge_installation WHERE singleton=true").Scan(&kind, &origin, &identity, &directories)
	if errors.Is(err, sql.ErrNoRows) {
		var occupied bool
		if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM golf_users)").Scan(&occupied); err != nil {
			return err
		}
		if occupied {
			return errors.New("forge installation requires a fresh destination database")
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO golf_forge_installation(singleton,kind,origin,instance_id,workflow_directories) VALUES(true,$1,$2,$3,$4)", c.ForgeKind, c.GiteaURL, c.ForgeInstanceID, c.GiteaWorkflowDirs)
	} else if err == nil && (kind != c.ForgeKind || origin != c.GiteaURL || identity != c.ForgeInstanceID || directories != c.GiteaWorkflowDirs) {
		return errors.New("forge installation or workflow selection changed; migration and workflow re-admission required")
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}
