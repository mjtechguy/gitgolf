package actionsengine

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"sync/atomic"
	"time"

	protocol "github.com/mjtechguy/golf-git/internal/runner"
	"github.com/nektos/act/pkg/common"
	"github.com/nektos/act/pkg/model"
	act "github.com/nektos/act/pkg/runner"
	"github.com/sirupsen/logrus"
)

// Execute the maintained public job executor, not a reimplementation of steps,
// composites or expressions. The admitted profile has no reusable-workflow
// caller, dynamic matrix, fail-fast cancellation or matrix outputs.
func nativeInstanceExecutor(ctx context.Context, rc *act.RunContext) error {
	executor, err := rc.Executor()
	if err != nil {
		return classifyExecution("engine_native_executor_init", err)
	}
	return classifyExecution("engine_native_executor_return", executor(ctx))
}

// Native Plan stages and GetMatrixes remain the planning authority. Serial
// variants avoid shared native Job.Result/output races; independent stage jobs
// retain parallelism <=2. Terminal receipts use each own error container, never
// native aggregate Job.Result or an inference from successful step messages.
func executeNativePlan(ctx context.Context, plan *model.Plan, config *act.Config, eventJSON string, observer *engineObserver, execute func(context.Context, *act.RunContext) error) error {
	var failed atomic.Bool
	for _, stage := range plan.Stages {
		var jobs []common.Executor
		for _, run := range stage.Runs {
			jobs = append(jobs, func(ctx context.Context) error {
				variants, err := run.Job().GetMatrixes()
				if err != nil || len(variants) == 0 || len(variants) > 12 {
					return ErrExecution
				}
				sort.Slice(variants, func(i, j int) bool {
					a, _ := json.Marshal(variants[i])
					b, _ := json.Marshal(variants[j])
					return string(a) < string(b)
				})
				aggregate := "skipped"
				for index, matrix := range variants {
					if ctx.Err() != nil {
						return ErrExecution
					}
					// Do not leak the earlier variant's aggregate into this instance's
					// job/status context. Publish the completed aggregate before next stage.
					run.Job().Result = ""
					jobConfig := *config
					jobConfig.Secrets = make(map[string]string, len(config.Secrets))
					for k, v := range config.Secrets {
						jobConfig.Secrets[k] = v
					}
					rc := &act.RunContext{Config: &jobConfig, Run: run, EventJSON: eventJSON, Matrix: matrix, StepResults: make(map[string]*model.StepResult), Name: run.String(), JobName: run.String()}
					if len(variants) > 1 {
						rc.Name += "-" + strconv.Itoa(index+1)
					}
					instance, ok := observer.identify(&logrus.Entry{Data: logrus.Fields{"jobID": run.JobID, "matrix": matrix}})
					if !ok {
						return ErrExecution
					}
					if observer.jobGit != nil {
						observer.mu.Lock()
						observer.contexts[instance.InstanceID] = rc
						observer.mu.Unlock()
						rc.BeforeStep = func(ctx context.Context) error {
							if err := ctx.Err(); err != nil {
								return err
							}
							observer.mu.Lock()
							defer observer.mu.Unlock()
							if err := observer.renewJobGit(instance.InstanceID); err != nil {
								observer.fail()
								return err
							}
							rc.ExprEval = rc.NewExpressionEvaluator(ctx)
							return nil
						}
					}
					jobCtx := ctx
					stop := func() {}
					if instance.TimeoutSeconds != 0 {
						jobCtx, stop = context.WithTimeout(ctx, time.Duration(instance.TimeoutSeconds)*time.Second)
					}
					own := common.WithJobErrorContainer(jobCtx)
					own = act.WithJobLogger(own, run.JobID, rc.String(), config, &rc.Masks, matrix)
					rc.ExprEval = rc.NewExpressionEvaluator(own)
					executionErr := execute(own, rc)
					state, err := observer.completeInstance(instance, executionErr, common.JobError(own))
					stop()
					if err != nil {
						return err
					}
					if state == "failure" {
						aggregate = "failure"
						failed.Store(true)
					} else if state == "success" && aggregate != "failure" {
						aggregate = "success"
					}
				}
				run.Job().Result = aggregate
				return nil
			})
		}
		if err := common.NewParallelExecutor(2, jobs...)(ctx); err != nil {
			return classifyExecution("engine_native_execution", err)
		}
	}
	if failed.Load() {
		return errors.New("native job executor failed")
	}
	return nil
}

func (o *engineObserver) completeInstance(job protocol.ActionJob, executionErr, jobErr error) (string, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	native := o.nativeResults[job.InstanceID]
	if o.err != nil {
		return "", o.err
	}
	if o.ctx.Err() != nil {
		return "", classifyExecution("engine_native_execution", ErrExecution)
	}
	if native == "" {
		if executionErr != nil {
			return "", classifyExecution("engine_native_result_missing", executionErr)
		}
		return "", classifyExecution("engine_native_result_missing", ErrExecution)
	}
	if o.finished[job.InstanceID] {
		return "", classifyExecution("engine_native_result_conflict", ErrExecution)
	}
	state := "success"
	if executionErr != nil || jobErr != nil {
		state = "failure"
	}
	if native == "skipped" {
		if state == "failure" || o.started[job.InstanceID] {
			return "", classifyExecution("engine_native_result_conflict", ErrExecution)
		}
		state = "skipped"
	} else if !o.started[job.InstanceID] {
		return "", classifyExecution("engine_native_setup_missing", ErrExecution)
	}
	if o.emit(protocol.ActionFrame{Kind: "job_finished", InstanceID: job.InstanceID, State: state}) != nil {
		return "", ErrExecution
	}
	o.finished[job.InstanceID] = true
	return state, nil
}
