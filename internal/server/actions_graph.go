package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"reflect"
	"time"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
)

type actionEvent struct {
	Sequence                        int
	InstanceID, StepID, Kind, State string
}

func actionGraphDetail(ctx context.Context, tx *sql.Tx, run workflowRunRecord) ([]*golfv1.WorkflowJobInstance, error) {
	plan, err := loadActionPlan(ctx, tx, run.ID)
	if err != nil {
		return nil, err
	}
	result := make([]*golfv1.WorkflowJobInstance, 0, len(plan.Jobs))
	jobs := map[string]*golfv1.WorkflowJobInstance{}
	terminal := run.State != "queued" && run.State != "running"
	for _, j := range plan.Jobs {
		state := golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_PENDING
		if terminal {
			state = golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_UNRECORDED
		}
		out := &golfv1.WorkflowJobInstance{InstanceId: j.InstanceID, JobId: j.JobID, Name: j.Name, Needs: j.Needs, State: state, ImageDigest: j.Image}
		for _, v := range j.Matrix {
			out.Matrix = append(out.Matrix, &golfv1.WorkflowMatrixEntry{Name: v.Name, ValueJson: v.Value})
		}
		for _, s := range j.Steps {
			out.Steps = append(out.Steps, &golfv1.WorkflowEngineStep{Id: s.ID, Name: s.Name, State: state})
		}
		jobs[j.InstanceID] = out
		result = append(result, out)
	}
	rows, err := tx.QueryContext(ctx, `SELECT instance_id,step_id,kind,state,occurred_at FROM golf_workflow_graph_events WHERE run_id=$1 AND attempt_id=$2 ORDER BY sequence`, run.ID, run.AttemptID)
	if err != nil {
		return nil, errStorageUnavailable
	}
	defer rows.Close()
	for rows.Next() {
		var id, sid, kind, state string
		var at time.Time
		if rows.Scan(&id, &sid, &kind, &state, &at) != nil {
			return nil, errStorageUnavailable
		}
		if kind == "complete" {
			continue
		}
		j := jobs[id]
		if j == nil {
			return nil, errStorageUnavailable
		}
		stamp := at.Format(time.RFC3339Nano)
		j.EventsRecorded = true
		switch kind {
		case "job_started":
			j.StartedAt = &stamp
			j.State = golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_RUNNING
			if terminal {
				j.State = golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_INTERRUPTED
			}
		case "job_finished":
			j.FinishedAt = &stamp
			j.State = actionWireState(state)
			if state == "skipped" {
				for _, s := range j.Steps {
					s.State = golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_SKIPPED
				}
			}
		case "step_started", "step_finished":
			found := false
			for _, s := range j.Steps {
				if s.Id == sid {
					found = true
					if kind == "step_started" {
						s.StartedAt = &stamp
						s.State = golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_RUNNING
						if terminal {
							s.State = golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_INTERRUPTED
						}
					} else {
						s.FinishedAt = &stamp
						s.State = actionWireState(state)
					}
				}
			}
			if !found {
				return nil, errStorageUnavailable
			}
		}
	}
	if rows.Err() != nil {
		return nil, errStorageUnavailable
	}
	return result, nil
}
func actionWireState(state string) golfv1.WorkflowStepState {
	switch state {
	case "success":
		return golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_SUCCEEDED
	case "failure":
		return golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_FAILED
	case "skipped":
		return golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_SKIPPED
	}
	return golfv1.WorkflowStepState_WORKFLOW_STEP_STATE_UNRECORDED
}

func loadActionPlan(ctx context.Context, tx *sql.Tx, id string) (runner.ActionPlan, error) {
	var data []byte
	var plan workflowExecutionPlan
	if tx.QueryRowContext(ctx, `SELECT plan FROM golf_workflow_runs WHERE id=$1`, id).Scan(&data) != nil || json.Unmarshal(data, &plan) != nil || plan.Actions == nil || !runner.IsActionsCatalog(plan.Actions.Catalog) || len(plan.Actions.Jobs) < 1 || len(plan.Actions.Jobs) > 12 {
		return runner.ActionPlan{}, errStorageUnavailable
	}
	return *plan.Actions, nil
}
func readActionEvents(ctx context.Context, tx *sql.Tx, run workflowRunRecord) ([]actionEvent, error) {
	rows, err := tx.QueryContext(ctx, `SELECT sequence,instance_id,step_id,kind,state FROM golf_workflow_graph_events WHERE run_id=$1 AND attempt_id=$2 ORDER BY sequence`, run.ID, run.AttemptID)
	if err != nil {
		return nil, errStorageUnavailable
	}
	defer rows.Close()
	var events []actionEvent
	for rows.Next() {
		var e actionEvent
		if rows.Scan(&e.Sequence, &e.InstanceID, &e.StepID, &e.Kind, &e.State) != nil || e.Sequence != len(events)+1 || len(events) >= 512 {
			return nil, errStorageUnavailable
		}
		events = append(events, e)
	}
	if rows.Err() != nil {
		return nil, errStorageUnavailable
	}
	return events, nil
}
func admittedActionJob(plan runner.ActionPlan, id, step string) bool {
	for _, job := range plan.Jobs {
		if job.InstanceID == id {
			if step == "" {
				return true
			}
			for _, s := range job.Steps {
				if s.ID == step {
					return true
				}
			}
		}
	}
	return false
}

// Called only while the current run/lease and all existing session/native/
// policy or sponsor fences are held. Unknown names and missing conclusions
// refuse; an engine completion message alone is not a success receipt.
func recordActionEvent(ctx context.Context, tx *sql.Tx, run workflowRunRecord, e actionEvent) error {
	plan, err := loadActionPlan(ctx, tx, run.ID)
	if err != nil {
		return err
	}
	events, err := readActionEvents(ctx, tx, run)
	if err != nil {
		return err
	}
	if e.Sequence < 1 || e.Sequence > 512 {
		return errWorkflowProgressInput
	}
	if e.Sequence <= len(events) {
		if !reflect.DeepEqual(events[e.Sequence-1], e) {
			return errWorkflowRunConflict
		}
		return nil
	}
	if e.Sequence != len(events)+1 {
		return errWorkflowRunConflict
	}
	if err = validateActionEvent(plan, events, e); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO golf_workflow_graph_events(run_id,attempt_id,sequence,instance_id,step_id,kind,state) VALUES($1,$2,$3,$4,$5,$6,$7)`, run.ID, run.AttemptID, e.Sequence, e.InstanceID, e.StepID, e.Kind, e.State)
	if err != nil {
		return errStorageUnavailable
	}
	_, err = tx.ExecContext(ctx, `UPDATE golf_workflow_runs SET version=version+1 WHERE id=$1`, run.ID)
	if err != nil {
		return errStorageUnavailable
	}
	return nil
}
func validateActionEvent(plan runner.ActionPlan, events []actionEvent, e actionEvent) error {
	if len(events) > 0 && events[len(events)-1].Kind == "complete" {
		return errWorkflowRunConflict
	}
	starts, finishes := map[string]bool{}, map[string]string{}
	stepStarts, stepFinishes := map[string]bool{}, map[string]string{}
	for _, old := range events {
		key := old.InstanceID + "/" + old.StepID
		switch old.Kind {
		case "job_started":
			starts[old.InstanceID] = true
		case "job_finished":
			finishes[old.InstanceID] = old.State
		case "step_started":
			stepStarts[key] = true
		case "step_finished":
			stepFinishes[key] = old.State
		}
	}
	if e.Kind == "complete" {
		if e.InstanceID != "" || e.StepID != "" || (e.State != "success" && e.State != "failure") {
			return errWorkflowProgressInput
		}
		failure := false
		for _, job := range plan.Jobs {
			state := finishes[job.InstanceID]
			if state == "" {
				return errWorkflowRunConflict
			}
			failure = failure || state == "failure"
		}
		if failure != (e.State == "failure") {
			return errWorkflowRunConflict
		}
		return nil
	}
	if !admittedActionJob(plan, e.InstanceID, e.StepID) {
		return errWorkflowProgressInput
	}
	if finishes[e.InstanceID] != "" {
		return errWorkflowRunConflict
	}
	var job runner.ActionJob
	for _, j := range plan.Jobs {
		if j.InstanceID == e.InstanceID {
			job = j
		}
	}
	key := e.InstanceID + "/" + e.StepID
	switch e.Kind {
	case "job_started":
		if e.StepID != "" || e.State != "" {
			return errWorkflowProgressInput
		}
		if starts[e.InstanceID] {
			return errWorkflowRunConflict
		}
		for _, need := range job.Needs {
			for _, j := range plan.Jobs {
				if j.JobID == need && finishes[j.InstanceID] == "" {
					return errWorkflowRunConflict
				}
			}
		}
	case "job_finished":
		if e.StepID != "" || (e.State != "success" && e.State != "failure" && e.State != "skipped") {
			return errWorkflowProgressInput
		}
		if e.State == "skipped" {
			for _, need := range job.Needs {
				for _, other := range plan.Jobs {
					if other.JobID == need && finishes[other.InstanceID] == "" {
						return errWorkflowRunConflict
					}
				}
			}
			if starts[e.InstanceID] {
				return errWorkflowRunConflict
			}
			return nil
		}
		if !starts[e.InstanceID] {
			return errWorkflowRunConflict
		}
		failed := false
		for _, s := range job.Steps {
			state := stepFinishes[e.InstanceID+"/"+s.ID]
			if state == "" {
				return errWorkflowRunConflict
			}
			failed = failed || state == "failure"
		}
		// Native job failure can also arise while evaluating declared outputs;
		// successful jobs still require every exact step receipt non-failed.
		if failed && e.State == "success" {
			return errWorkflowRunConflict
		}
	case "step_started", "step_finished":
		if e.StepID == "" || !starts[e.InstanceID] {
			return errWorkflowRunConflict
		}
		if stepFinishes[key] != "" {
			return errWorkflowRunConflict
		}
		for _, s := range job.Steps {
			if s.ID == e.StepID {
				break
			}
			if stepFinishes[e.InstanceID+"/"+s.ID] == "" {
				return errWorkflowRunConflict
			}
		}
		if e.Kind == "step_started" {
			if e.State != "" {
				return errWorkflowProgressInput
			}
			if stepStarts[key] {
				return errWorkflowRunConflict
			}
		} else {
			if e.State != "success" && e.State != "failure" && e.State != "skipped" {
				return errWorkflowProgressInput
			}
			if (e.State == "skipped") == stepStarts[key] {
				return errWorkflowRunConflict
			}
		}
	default:
		return errWorkflowProgressInput
	}
	return nil
}
func checkActionsFinish(ctx context.Context, tx *sql.Tx, run workflowRunRecord, exit int32) error {
	plan, err := loadActionPlan(ctx, tx, run.ID)
	if err != nil {
		return err
	}
	events, err := readActionEvents(ctx, tx, run)
	if err != nil {
		return err
	}
	if len(events) == 0 {
		return errWorkflowRunConflict
	}
	last := events[len(events)-1]
	if last.Kind != "complete" || (exit == 0) != (last.State == "success") {
		return errWorkflowRunConflict
	}
	// Revalidate the complete retained stream independently, including each
	// graph coordinate, rather than trusting just the final event.
	for index, e := range events {
		if e.Sequence != index+1 {
			return errStorageUnavailable
		}
		if err = validateActionEvent(plan, events[:index], e); err != nil {
			return err
		}
	}
	return nil
}
