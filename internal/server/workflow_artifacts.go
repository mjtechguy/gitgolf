package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"
	"time"

	"connectrpc.com/connect"
	"github.com/go-chi/chi/v5"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
)

// Called only under runnerAttempt's current authority/policy/resource/placement,
// worker and exact running lease locks. Upload alone never publishes an output.
func storeWorkflowArtifact(ctx context.Context, tx *sql.Tx, run workflowRunRecord, data []byte) error {
	plan, err := workflowStoredPlan(ctx, tx, run.ID)
	if err != nil {
		return err
	}
	if run.EngineCatalog != workflowExecutionCatalog || run.Format != int32(golfv1.WorkflowFormat_WORKFLOW_FORMAT_GITLAB_CI) || run.InputContract != "" || runner.ValidateArtifactPaths(plan.ArtifactPaths) != nil {
		return runner.ErrArtifacts
	}
	var binding bool
	if tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_workflow_execution_bindings WHERE run_id=$1)`, run.ID).Scan(&binding) != nil {
		return errStorageUnavailable
	}
	if binding {
		return runner.ErrArtifacts
	}
	canonical, files, fileBytes, err := runner.NormalizeArtifactArchive(data, plan.ArtifactPaths)
	if err != nil || !bytes.Equal(canonical, data) {
		return runner.ErrArtifacts
	}
	// All maintained shell step receipts must have completed before collection.
	var count int
	if tx.QueryRowContext(ctx, `SELECT count(*) FROM golf_workflow_run_progress WHERE run_id=$1 AND attempt_id=$2`, run.ID, run.AttemptID).Scan(&count) != nil {
		return errStorageUnavailable
	}
	if count != len(plan.Steps)*2 {
		return errWorkflowRunConflict
	}
	if err = checkWorkflowProgressFinish(ctx, tx, run, 0); err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	digest := hex.EncodeToString(sum[:])
	var existing []byte
	err = tx.QueryRowContext(ctx, `SELECT archive FROM golf_workflow_artifacts WHERE run_id=$1 AND attempt_id=$2`, run.ID, run.AttemptID).Scan(&existing)
	if err == nil {
		if !bytes.Equal(existing, data) {
			return errWorkflowRunConflict
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return errStorageUnavailable
	}
	// This explicitly small PG profile has a bounded retained budget. The short
	// admission lock covers counts+INSERT only, never a provider or object read.
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('golf.artifacts.pg.v1',0))`); err != nil {
		return errStorageUnavailable
	}
	var total, repository int
	if tx.QueryRowContext(ctx, `SELECT count(*),count(*) FILTER(WHERE forge_url=$1 AND repository_id=$2) FROM golf_workflow_artifacts`, run.ForgeURL, run.RepositoryID).Scan(&total, &repository) != nil {
		return errStorageUnavailable
	}
	if total >= 200 || repository >= 20 {
		return runner.ErrArtifacts
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO golf_workflow_artifacts(run_id,attempt_id,forge_url,repository_id,owner_id,commit_id,workflow_path,blob_id,source_sha256,archive_sha256,file_count,file_bytes,archive) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, run.ID, run.AttemptID, run.ForgeURL, run.RepositoryID, run.OwnerID, run.CommitID, run.WorkflowPath, run.BlobID, run.SourceSHA256, digest, files, fileBytes, data)
	if err != nil {
		return errStorageUnavailable
	}
	return nil
}

func requireWorkflowArtifact(ctx context.Context, tx *sql.Tx, run workflowRunRecord) error {
	plan, err := workflowStoredPlan(ctx, tx, run.ID)
	if err != nil {
		return err
	}
	if len(plan.ArtifactPaths) == 0 {
		return nil
	}
	var exists bool
	if tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM golf_workflow_artifacts WHERE run_id=$1 AND attempt_id=$2 AND commit_id=$3 AND source_sha256=$4)`, run.ID, run.AttemptID, run.CommitID, run.SourceSHA256).Scan(&exists) != nil {
		return errStorageUnavailable
	}
	if !exists {
		return errWorkflowRunConflict
	}
	return nil
}

func (s *Server) readWorkflowArtifact(ctx context.Context, cookie string, credential forgeCredential, id string) (*golfv1.WorkflowArtifact, []byte, error) {
	run, err := s.loadWorkflowRun(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	var result *golfv1.WorkflowArtifact
	var archive []byte
	err = s.withWorkflowRepository(ctx, cookie, credential, repositoryKey{run.RepositoryOwner, run.RepositoryName}, run.RepositoryID, run.OwnerID, false, func(_ User, _ *golfv1.RepositoryAccess) error {
		// Terminal status is joined at each read; unconfirmed/lost/cancelled uploads
		// are retained privately but never made downloadable.
		var digest, attempt string
		var files uint32
		var fileBytes int64
		var at time.Time
		e := s.db.QueryRowContext(ctx, `SELECT a.archive,a.archive_sha256,a.file_count,a.file_bytes,a.created_at,a.attempt_id FROM golf_workflow_artifacts a JOIN golf_workflow_runs r ON r.id=a.run_id AND r.attempt_id=a.attempt_id AND r.forge_url=a.forge_url AND r.repository_id=a.repository_id AND r.owner_id=a.owner_id AND r.commit_id=a.commit_id AND r.source_sha256=a.source_sha256 AND r.workflow_path=a.workflow_path AND r.blob_id=a.blob_id WHERE a.run_id=$1 AND r.state='succeeded' AND r.input_contract='' AND NOT EXISTS(SELECT 1 FROM golf_workflow_execution_bindings WHERE run_id=r.id)`, id).Scan(&archive, &digest, &files, &fileBytes, &at, &attempt)
		if errors.Is(e, sql.ErrNoRows) {
			return nil
		}
		if e != nil {
			return errStorageUnavailable
		}
		sum := sha256.Sum256(archive)
		if len(archive) > runner.MaxArtifactArchive || hex.EncodeToString(sum[:]) != digest {
			return errStorageUnavailable
		}
		result = &golfv1.WorkflowArtifact{RunId: id, AttemptId: attempt, RepositoryId: strconv.FormatInt(run.RepositoryID, 10), OwnerId: strconv.FormatInt(run.OwnerID, 10), CommitId: run.CommitID, WorkflowPath: run.WorkflowPath, BlobId: run.BlobID, SourceSha256: run.SourceSHA256, ArchiveSha256: digest, FileCount: files, FileBytes: strconv.FormatInt(fileBytes, 10), ArchiveBytes: strconv.Itoa(len(archive)), CreatedAt: at.UTC().Format(time.RFC3339Nano), DownloadPath: "/api/workflow-runs/" + id + "/artifact"}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return result, archive, nil
}

func (s *Server) GetWorkflowArtifact(ctx context.Context, req *connect.Request[golfv1.GetWorkflowArtifactRequest]) (*connect.Response[golfv1.GetWorkflowArtifactResponse], error) {
	credential, err := workflowBrowserToken(ctx)
	if err != nil {
		return nil, rpcError(err)
	}
	artifact, _, err := s.readWorkflowArtifact(ctx, s.cookieValue(req.Header()), credential, req.Msg.RunId)
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&golfv1.GetWorkflowArtifactResponse{Artifact: artifact}), nil
}

// Root registration: GET /api/workflow-runs/{id}/artifact. Readonly managed-cookie
// authentication; no capability URL, query credential, redirect or inline preview.
func (s *Server) WorkflowArtifactDownloadHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
		if r.Method != http.MethodGet || len(r.Header.Values("Authorization")) != 0 || r.URL.RawQuery != "" || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			http.Error(w, "Artifact unavailable.", 403)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && origin != s.config.PublicURL {
			http.Error(w, "Artifact unavailable.", 403)
			return
		}
		if !creationKey.MatchString(chi.URLParam(r, "id")) {
			http.Error(w, "Artifact unavailable.", 400)
			return
		}
		credential, err := s.sessionCredential(r.Context(), s.cookieValue(r.Header))
		if err != nil {
			http.Error(w, "Artifact unavailable.", 401)
			return
		}
		metadata, data, err := s.readWorkflowArtifact(r.Context(), s.cookieValue(r.Header), credential, chi.URLParam(r, "id"))
		if err != nil || metadata == nil {
			status := 404
			if err != nil && !isRunnerAuthorityDenied(err) && !errors.Is(err, errResourceNotFound) && !errors.Is(err, errUnauthenticated) {
				status = 503
			}
			http.Error(w, "Artifact unavailable.", status)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", `attachment; filename="build-artifacts.tar"`)
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}
}
