package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
)

type workflowProgressEvent struct {
	Sequence, Index int32
	Kind            string
	ExitCode        sql.NullInt32
	LogSequence     int64
	At              time.Time
}

func workflowStoredPlan(ctx context.Context, tx *sql.Tx, id string) (workflowExecutionPlan, error) {
	var data []byte
	var plan workflowExecutionPlan
	if tx.QueryRowContext(ctx, `SELECT plan FROM golf_workflow_runs WHERE id=$1`, id).Scan(&data) != nil || json.Unmarshal(data, &plan) != nil || len(plan.Steps) < 1 || len(plan.Steps) > 50 {
		return plan, errStorageUnavailable
	}
	return plan, nil
}
func scanProgress(row interface{ Scan(...any) error }) (workflowProgressEvent, error) {
	var e workflowProgressEvent
	err := row.Scan(&e.Sequence, &e.Index, &e.Kind, &e.ExitCode, &e.LogSequence, &e.At)
	return e, err
}

const progressColumns = `sequence,step_index,kind,exit_code,log_sequence,occurred_at`

// The caller already holds the run lock, lease/session and effective-policy
// fences. Events originate in the enrolled worker, never in untrusted stdout.
func recordWorkflowProgress(ctx context.Context, tx *sql.Tx, run workflowRunRecord, sequence, index int32, kind string, exit int32) error {
	plan, err := workflowStoredPlan(ctx, tx, run.ID)
	if err != nil {
		return err
	}
	if index < 0 || int(index) >= len(plan.Steps) || sequence < 1 || sequence > 100 || exit < 0 || exit > 255 || (kind != "started" && kind != "finished") || sequence != index*2+1+map[string]int32{"started": 0, "finished": 1}[kind] || kind == "started" && exit != 0 {
		return errWorkflowProgressInput
	}
	var code any
	if kind == "finished" {
		code = exit
	}
	previous, err := scanProgress(tx.QueryRowContext(ctx, `SELECT `+progressColumns+` FROM golf_workflow_run_progress WHERE run_id=$1 ORDER BY sequence DESC LIMIT 1`, run.ID))
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return errStorageUnavailable
	}
	if sequence <= previous.Sequence {
		old, e := scanProgress(tx.QueryRowContext(ctx, `SELECT `+progressColumns+` FROM golf_workflow_run_progress WHERE run_id=$1 AND sequence=$2 AND attempt_id=$3`, run.ID, sequence, run.AttemptID))
		if e != nil || old.Index != index || old.Kind != kind || kind == "finished" && (!old.ExitCode.Valid || old.ExitCode.Int32 != exit) {
			return errWorkflowRunConflict
		}
		return nil
	}
	if sequence != previous.Sequence+1 || kind == "started" && previous.Sequence > 0 && (!previous.ExitCode.Valid || previous.ExitCode.Int32 != 0) {
		return errWorkflowRunConflict
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO golf_workflow_run_progress(run_id,attempt_id,sequence,step_index,kind,exit_code,log_sequence) SELECT id,attempt_id,$2,$3,$4,$5,log_sequence FROM golf_workflow_runs WHERE id=$1`, run.ID, sequence, index, kind, code); err != nil {
		return errStorageUnavailable
	}
	// Version updates produce the existing transactional Actions invalidation.
	if _, err = tx.ExecContext(ctx, `UPDATE golf_workflow_runs SET version=version+1 WHERE id=$1`, run.ID); err != nil {
		return errStorageUnavailable
	}
	return nil
}

var errWorkflowProgressInput = errors.New("invalid workflow progress event")

func checkWorkflowProgressFinish(ctx context.Context, tx *sql.Tx, run workflowRunRecord, exit int32) error {
	last, err := scanProgress(tx.QueryRowContext(ctx, `SELECT `+progressColumns+` FROM golf_workflow_run_progress WHERE run_id=$1 ORDER BY sequence DESC LIMIT 1`, run.ID))
	// Older enrolled workers/runs can finish without instrumentation. Their step
	// outcomes remain explicitly unrecorded rather than inheriting job success.
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return errStorageUnavailable
	}
	plan, err := workflowStoredPlan(ctx, tx, run.ID)
	if err != nil {
		return err
	}
	if last.Kind != "finished" || !last.ExitCode.Valid || last.ExitCode.Int32 != exit || exit == 0 && int(last.Index) != len(plan.Steps)-1 {
		return errWorkflowRunConflict
	}
	return nil
}

func (s *Server) workflowRunDetail(ctx context.Context, id string) (workflowRunRecord, *golfv1.WorkflowJobProgress, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return workflowRunRecord{}, nil, errStorageUnavailable
	}
	defer tx.Rollback()
	run, err := scanWorkflowRun(tx.QueryRowContext(ctx, "SELECT "+workflowRunColumns+" FROM golf_workflow_runs WHERE id=$1 AND forge_url=$2", id, s.config.ForgeURL))
	if err != nil {
		return run, nil, errStorageUnavailable
	}
	run.OutputState, run.ExecutionBindingID, run.ExecutionBindingVersion, err = observeExecutionOutput(ctx, tx, run.ID)
	if err != nil {
		return run, nil, err
	}
	if runner.IsActionsCatalog(run.EngineCatalog) {
		run.ActionJobs, err = actionGraphDetail(ctx, tx, run)
		if err != nil {
			return run, nil, err
		}
		if err = tx.Commit(); err != nil {
			return run, nil, errStorageUnavailable
		}
		return run, nil, nil
	}
	plan, err := workflowStoredPlan(ctx, tx, id)
	if err != nil {
		return run, nil, err
	}
	result := &golfv1.WorkflowJobProgress{JobId: plan.JobID, Name: plan.JobName, Stage: plan.Stage}
	terminal := run.State != "queued" && run.State != "running"
	for index, step := range plan.Steps {
		state := golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_PENDING
		if terminal {
			state = golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_UNRECORDED
		}
		name := step.Name
		if name == "" {
			name = "Step " + strconv.Itoa(index+1)
		}
		result.Steps = append(result.Steps, &golfv1.WorkflowStepProgress{Index: uint32(index), Name: name, State: state})
	}
	rows, err := tx.QueryContext(ctx, `SELECT `+progressColumns+` FROM golf_workflow_run_progress WHERE run_id=$1 ORDER BY sequence`, id)
	if err != nil {
		return run, nil, errStorageUnavailable
	}
	defer rows.Close()
	var last int32
	for rows.Next() {
		e, err := scanProgress(rows)
		if err != nil || e.Sequence != last+1 || e.Index < 0 || int(e.Index) >= len(result.Steps) {
			return run, nil, errStorageUnavailable
		}
		last = e.Sequence
		result.EventsRecorded = true
		step := result.Steps[e.Index]
		at := e.At.Format(time.RFC3339Nano)
		if e.Kind == "started" {
			step.StartedAt = &at
			step.State = golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_RUNNING
			if terminal {
				step.State = golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_INTERRUPTED
			}
		}
		if e.Kind == "finished" {
			step.FinishedAt = &at
			code := e.ExitCode.Int32
			step.ExitCode = &code
			step.State = golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_SUCCEEDED
			if code != 0 {
				step.State = golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_FAILED
			}
		}
	}
	if rows.Err() != nil {
		return run, nil, errStorageUnavailable
	}
	if result.EventsRecorded && terminal {
		for _, step := range result.Steps {
			if step.StartedAt == nil {
				step.State = golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_SKIPPED
			}
		}
	}
	if err = tx.Commit(); err != nil {
		return run, nil, errStorageUnavailable
	}
	return run, result, nil
}

// A single repeatable-read snapshot prevents a running step's open boundary
// from accidentally including a later step that commits during this read.
func workflowStepLogRange(ctx context.Context, tx *sql.Tx, id string, index uint32) (int64, *int64, error) {
	plan, err := workflowStoredPlan(ctx, tx, id)
	if err != nil {
		return 0, nil, err
	}
	if index >= uint32(len(plan.Steps)) {
		return 0, nil, invalid("Select a step from this run.")
	}
	start, err := scanProgress(tx.QueryRowContext(ctx, `SELECT `+progressColumns+` FROM golf_workflow_run_progress WHERE run_id=$1 AND step_index=$2 AND kind='started'`, id, index))
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil, errWorkflowStepUnrecorded
	}
	if err != nil {
		return 0, nil, errStorageUnavailable
	}
	end, err := scanProgress(tx.QueryRowContext(ctx, `SELECT `+progressColumns+` FROM golf_workflow_run_progress WHERE run_id=$1 AND step_index=$2 AND kind='finished'`, id, index))
	if errors.Is(err, sql.ErrNoRows) {
		return start.LogSequence, nil, nil
	}
	if err != nil {
		return 0, nil, errStorageUnavailable
	}
	return start.LogSequence, &end.LogSequence, nil
}

var errWorkflowStepUnrecorded = errors.New("The selected step has no recorded log boundaries.")
