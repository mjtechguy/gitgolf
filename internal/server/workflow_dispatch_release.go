package server

import (
	"archive/tar"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"strconv"

	"github.com/mjtechguy/golf-git/internal/runner"
)

// Only the admitted, digest-verified normalized archive is inspected here. Native
// archive normalization remains the admission boundary; no paths are extracted.
func workflowDispatchStoredSourceSchema(run workflowRunRecord, source []byte) (workflowDispatchInputSchema, error) {
	fail := func() (workflowDispatchInputSchema, error) {
		return workflowDispatchInputSchema{}, errCredentialUnavailable
	}
	if run.InputContract != runner.ManualInputsCapability || run.EngineCatalog != runner.ActionsInputsCatalog || len(source) == 0 || len(source) > maxWorkflowSource || sourceArchiveHash(source) != run.SourceSHA256 {
		return fail()
	}
	reader := tar.NewReader(bytes.NewReader(source))
	var workflow []byte
	found := false
	for n := 0; ; n++ {
		h, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil || n >= maxWorkflowSourceEntries {
			return fail()
		}
		if h.Name != run.WorkflowPath {
			continue
		}
		if found || h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeRegA || h.Linkname != "" || h.Size < 0 || h.Size > maxWorkflowBytes {
			return fail()
		}
		workflow, err = io.ReadAll(io.LimitReader(reader, maxWorkflowBytes+1))
		if err != nil || int64(len(workflow)) != h.Size || !workflowBlobMatches(workflow, run.BlobID) || workflowLFSPointer(workflow) {
			return fail()
		}
		found = true
	}
	if !found {
		return fail()
	}
	schema, err := parseWorkflowDispatchInputs(workflow)
	if err != nil || schema.SHA256 != run.SchemaSHA256 {
		return fail()
	}
	return schema, nil
}

// Metadata and inputs are constructed once with canonical Go JSON. The same
// exact bytes and typed envelope are independently checked by worker and engine.
func workflowActionEventJSON(run workflowRunRecord, plan runner.ActionPlan, inputs *runner.ActionManualInputs) ([]byte, error) {
	event := map[string]any{"ref": plan.Ref, "after": run.CommitID, "repository": map[string]any{"id": run.RepositoryID, "name": run.RepositoryName, "full_name": run.RepositoryOwner + "/" + run.RepositoryName, "owner": map[string]any{"id": run.OwnerID, "login": run.RepositoryOwner}}}
	if inputs != nil {
		values := map[string]string{}
		for _, v := range inputs.Effective {
			value := v.String
			if v.Type == workflowDispatchBoolean {
				value = strconv.FormatBool(v.Boolean)
			}
			if v.Type == workflowDispatchNumber {
				value = v.Number
			}
			values[v.Name] = value
		}
		event["inputs"] = values
	}
	body, err := json.Marshal(event)
	if err != nil || len(body) > 16<<10 || runner.ValidateActionManualInputs(plan, inputs, body, run.CommitID) != nil {
		return nil, errCredentialUnavailable
	}
	return body, nil
}

// Repeat current native/session/policy/placement/attempt observations after the
// claim commits and immediately before returning private parameters. Native
// reads stay outside SQL locks. This does not claim atomic native revocation.
func (s *Server) runnerManualInputReleaseFence(ctx context.Context, run workflowRunRecord, worker, attempt string, leaseHash []byte) error {
	if err := s.runnerRunAuthority(ctx, run); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return errStorageUnavailable
	}
	defer tx.Rollback()
	if err = s.runnerPolicyFence(ctx, tx, run); err != nil {
		return err
	}
	if err = s.lockRunnerPlacement(ctx, tx, run.RepositoryID); err != nil {
		return err
	}
	if err = s.lockRunnerControl(ctx, tx, worker); err != nil {
		return err
	}
	control, _, err := s.runnerControl(ctx, tx, worker)
	if err != nil {
		return err
	}
	if control == "revoked" {
		return errWorkflowRunConflict
	}
	if run.RunnerPlacement.PoolID.Valid {
		if err = s.lockRunnerPool(ctx, tx, run.RunnerPlacement.PoolID.String); err != nil {
			return err
		}
	}
	var pool sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT pool_id::text FROM golf_runner_pool_workers WHERE forge_url=$1 AND runner_id=$2`, run.ForgeURL, worker).Scan(&pool)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return errStorageUnavailable
	}
	if pool != run.RunnerPlacement.PoolID {
		return errRunnerPoolStale
	}
	if err = s.runnerResourceFence(ctx, tx, run); err != nil {
		return err
	}
	var valid bool
	err = tx.QueryRowContext(ctx, `SELECT state='running' AND NOT cancel_requested AND lease_expires_at>clock_timestamp() AND input_contract=$6 AND input_schema_sha256=$7 AND submitted_inputs_sha256=$8 AND effective_inputs_sha256=$9 FROM golf_workflow_runs WHERE id=$1 AND forge_url=$2 AND runner_id=$3 AND attempt_id=$4 AND lease_token_hash=$5 FOR UPDATE`, run.ID, run.ForgeURL, worker, attempt, leaseHash, run.InputContract, run.SchemaSHA256, run.SubmittedSHA256, run.EffectiveSHA256).Scan(&valid)
	if errors.Is(err, sql.ErrNoRows) || err == nil && !valid {
		return errWorkflowRunConflict
	}
	if err != nil {
		return errStorageUnavailable
	}
	if err = tx.Commit(); err != nil {
		return errStorageUnavailable
	}
	return nil
}
