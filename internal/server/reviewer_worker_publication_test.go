package server

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

func TestReviewerWorkerPublicationAdmissionPostgres(t *testing.T) {
	f := newReviewerPublicationFixture(t)
	for _, admission := range []string{"escaped-body", "encoded-receipt", "malformed-comparison"} {
		t.Run(admission, func(t *testing.T) {
			diff, result := reviewerTestDiff, reviewerTestResult()
			switch admission {
			case "escaped-body":
				result.Findings[0].Evidence = strings.Repeat("<", 2000)
				result.Findings[0].Suggestion = strings.Repeat("<", 2000)
			case "encoded-receipt":
				diff = "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1 +1 @@\n-keep\n+" + strings.Repeat("<>&", 15000) + "\n"
				result.Findings = nil
				for i := 0; i < 10; i++ {
					finding := reviewerTestResult().Findings[0]
					finding.Line, finding.Title = 1, fmt.Sprintf("Defect %d", i)
					result.Findings = append(result.Findings, finding)
				}
			case "malformed-comparison":
				diff = strings.Replace(reviewerTestDiff, "+1,2", "+1,3", 1)
			}
			if admission != "malformed-comparison" {
				raw, _ := json.Marshal(result)
				if _, err := validateReviewResult(string(raw), diff); err != nil {
					t.Fatal("raw result must pass the earlier worker validation", err)
				}
			}
			r := f.runWithDiff(t, "manual/"+uuid.NewString(), diff)
			if admission == "encoded-receipt" {
				if _, err := f.s.db.Exec(`UPDATE golf_reviewer_runs SET state='running' WHERE id=$1`, r.ID); err != nil {
					t.Fatal(err)
				}
			}
			if err := f.s.publishReviewer(t.Context(), f.p, r, result, func(context.Context) error { return nil }); err == nil {
				t.Fatal("known admission refusal accepted")
			}
			const reason = "Review publication was refused before dispatch; inspect before explicitly retrying."
			if !f.s.failReviewerRun(t.Context(), r.ID, reason) {
				t.Fatal("completed task run was not terminated")
			}
			f.state(t, r, "failed")
			if f.s.failReviewerRun(t.Context(), r.ID, "replacement reason") {
				t.Fatal("repeated poll changed a terminal run")
			}
			var actual string
			var reservations, candidates int
			if err := f.s.db.QueryRow(`SELECT reason FROM golf_reviewer_runs WHERE id=$1`, r.ID).Scan(&actual); err != nil || actual != reason {
				t.Fatal("visible refusal reason lost", err)
			}
			if err := f.s.db.QueryRow(`SELECT count(*) FROM golf_reviewer_publications WHERE run_id=$1`, r.ID).Scan(&reservations); err != nil || reservations != 0 {
				t.Fatal("refusal created a publication journal", err)
			}
			if err := f.s.db.QueryRow(`SELECT count(*) FROM golf_reviewer_runs WHERE id=$1 AND state IN ('queued','running')`, r.ID).Scan(&candidates); err != nil || candidates != 0 {
				t.Fatal("terminal run remains a publication polling candidate", err)
			}
			if f.posts.Load() != 0 {
				t.Fatal("refusal posted a native review")
			}
		})
	}
}

func TestReviewerWorkerMigratedBlockerVisibilityPostgres(t *testing.T) {
	dsn := os.Getenv("GOLF_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set GOLF_TEST_DATABASE_URL for real PostgreSQL integration")
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	admin := stdlib.OpenDB(*config)
	t.Cleanup(func() { admin.Close() })
	schema := "golf_worker_upgrade_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := admin.Exec(`CREATE SCHEMA ` + schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(`DROP SCHEMA ` + schema + ` CASCADE`) })
	config.RuntimeParams["search_path"] = schema
	db := stdlib.OpenDB(*config)
	t.Cleanup(func() { db.Close() })
	provider, err := goose.NewProvider(goose.DialectPostgres, db, os.DirFS("database/migrations"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.UpTo(t.Context(), 202610030034); err != nil {
		t.Fatal(err)
	}
	f := newReviewerPublicationFixtureOnDatabase(t, db)
	ids := map[string]string{}
	for _, state := range []string{"publishing", "publication_unknown", "outdated", "published"} {
		id := uuid.NewString()
		ids[state] = id
		var receipt any
		if state == "published" {
			receipt = int64(91)
		}
		if _, err := db.Exec(`INSERT INTO golf_reviewer_runs(id,reviewer_id,reviewer_revision,pull_number,base_commit,head_commit,trigger,intent,diff,publisher_id,state,reason,review_id) VALUES($1,$2,1,7,$3,$4,'push',$5,'',43,$6,'Historical reason',$7)`, id, f.p.ID, strings.Repeat("b", 40), strings.Repeat("a", 40), "migration/"+state, state, receipt); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := provider.Up(t.Context()); err != nil {
		t.Fatal(err)
	}
	for state, id := range ids {
		r, err := scanReviewRun(db.QueryRow(`SELECT `+reviewRunColumns+` FROM golf_reviewer_runs WHERE id=$1`, id))
		if err != nil {
			t.Fatal(err)
		}
		wire := r.wire()
		blocked := state != "published"
		if r.LegacyEffectBlock != blocked || wire.State != state || wire.Outdated != (state == "outdated") || !strings.Contains(wire.Reason, "Historical reason") || strings.Contains(wire.Reason, "cannot be reconstructed") != blocked {
			t.Fatal("migrated visibility lost original state or uncertainty", state)
		}
		if (state == "published" && r.ReviewID != 91) || (blocked && r.ReviewID != 0) {
			t.Fatal("migration lost or invented native receipt", state)
		}
	}
}

func TestReviewerWorkerPublicationFailureGuardPostgres(t *testing.T) {
	for _, phase := range []string{"reserved", "publication_unknown", "published"} {
		t.Run(phase, func(t *testing.T) {
			f := newReviewerPublicationFixture(t)
			r, result := f.run(t, "manual/"+uuid.NewString()), reviewerTestResult()
			if phase == "reserved" {
				owned, err := f.s.reserveReviewerPublication(t.Context(), f.p, r, result, reviewerPublicationPayload(f.p, r, result))
				if err != nil || !owned {
					t.Fatal("reservation setup failed", err)
				}
			} else {
				if phase == "publication_unknown" {
					f.mode.Store("http500")
				}
				err := f.s.publishReviewer(t.Context(), f.p, r, result, func(context.Context) error { return nil })
				if (err != nil) != (phase == "publication_unknown") {
					t.Fatal("unexpected publication setup outcome", err)
				}
			}
			var beforeState, beforeReason string
			if err := f.s.db.QueryRow(`SELECT state,reason FROM golf_reviewer_runs WHERE id=$1`, r.ID).Scan(&beforeState, &beforeReason); err != nil {
				t.Fatal(err)
			}
			posts := f.posts.Load()
			if f.s.failReviewerRun(t.Context(), r.ID, "losing publisher refusal") {
				t.Fatal("loser erased reserved or terminal publication")
			}
			var afterState, afterReason string
			if err := f.s.db.QueryRow(`SELECT state,reason FROM golf_reviewer_runs WHERE id=$1`, r.ID).Scan(&afterState, &afterReason); err != nil || afterState != beforeState || afterReason != beforeReason {
				t.Fatal("publication state or reason changed", err)
			}
			cancelled, cancel := context.WithCancel(t.Context())
			cancel()
			if f.s.failReviewerRun(cancelled, r.ID, "cancelled loser") || f.posts.Load() != posts {
				t.Fatal("failure handling created a native effect")
			}
		})
	}
}
