package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// This is a read projection over existing writers, not a new execution engine.
// Metadata stays separate from prompts, archives, plans, patches and findings.
const actionInventorySQL = `WITH inventory AS (
 SELECT 1 AS kind,id,created_at,workflow_path AS title,state,commit_id,started_at,finished_at,
 workflow_path,origin AS trigger,'' AS child_task,0::bigint AS pull_number,'' AS model_id,
 runner_id AS worker_id,attempt_id,blob_id AS workflow_blob_id,source_sha256,event_ref,
 COALESCE(repository_event_id::text,'') AS repository_event_id,COALESCE(automation_grant_id::text,'') AS automation_grant_id
 FROM golf_workflow_runs WHERE forge_url=$1 AND repository_id=$2 AND owner_id=$3
 UNION ALL
 SELECT 2,id,created_at,'Coding task',state,commit_id,started_at,finished_at,'','','',0,
 COALESCE(config->>'model_id',''),worker_id,attempt_id,'','','','',''
 FROM golf_agent_tasks t WHERE forge_url=$1 AND repository_id=$2 AND owner_id=$3 AND user_id=$4 AND $5
 AND NOT EXISTS(SELECT 1 FROM golf_reviewer_runs rr WHERE rr.task_id=t.id)
 UNION ALL
 SELECT 3,rr.id,rr.created_at,'Review PR #'||pull_number::text,rr.state,head_commit,NULL::timestamptz,NULL::timestamptz,
 '',rr.trigger,CASE WHEN $5 AND t.user_id=$4 AND t.forge_url=$1 AND t.repository_id=$2 AND t.owner_id=$3 THEN t.id::text ELSE '' END,
 pull_number,'','','','','','','',''
 FROM golf_reviewer_runs rr JOIN golf_reviewers r ON r.id=rr.reviewer_id LEFT JOIN golf_agent_tasks t ON t.id=rr.task_id
 WHERE r.forge_url=$1 AND r.repository_id=$2 AND r.owner_id=$3 AND (rr.repository_id IS NULL OR rr.repository_id=$2)
) SELECT kind,id::text,created_at,title,state,commit_id,started_at,finished_at,workflow_path,trigger,child_task,pull_number,model_id,
 worker_id,attempt_id,workflow_blob_id,source_sha256,event_ref,repository_event_id,automation_grant_id FROM inventory `

type actionCursor struct {
	Version                 int `json:"v"`
	Repository, Owner, User int64
	Limit                   uint32
	Filter                  int32
	Path                    string
	At                      int64
	Kind                    int32
	ID                      string
}

func actionKind(kind golfv1.ActionRunKind) bool { return kind >= 1 && kind <= 3 }
func actionAttempt(id string) string {
	if attemptIdentifier.MatchString(id) {
		return id
	}
	return ""
}
func encodeActionCursor(c actionCursor) string {
	data, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(data)
}
func decodeActionCursor(raw string) (actionCursor, error) {
	var c actionCursor
	if len(raw) > 2048 {
		return c, invalid("Invalid Actions cursor.")
	}
	data, e := base64.RawURLEncoding.Strict().DecodeString(raw)
	if e != nil {
		return c, invalid("Invalid Actions cursor.")
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if e = d.Decode(&c); e != nil {
		return c, invalid("Invalid Actions cursor.")
	}
	var extra any
	if d.Decode(&extra) != io.EOF || c.Version != 1 || !actionKind(golfv1.ActionRunKind(c.Kind)) || !creationKey.MatchString(c.ID) ||
		c.At < time.Date(1, 1, 1, 0, 0, 0, 0, time.UTC).UnixMicro() || c.At > time.Date(9999, 12, 31, 23, 59, 59, 999999000, time.UTC).UnixMicro() {
		return c, invalid("Invalid Actions cursor.")
	}
	return c, nil
}

func scanActionSummary(row workflowRunScanner, repositoryID, ownerID int64) (*golfv1.ActionRunSummary, time.Time, error) {
	v := &golfv1.ActionRunSummary{RepositoryId: strconv.FormatInt(repositoryID, 10), OwnerId: strconv.FormatInt(ownerID, 10), Ref: &golfv1.ActionRunRef{}}
	var kind int32
	var at time.Time
	var start, finish sql.NullTime
	var child string
	var pull int64
	e := row.Scan(&kind, &v.Ref.Id, &at, &v.Title, &v.State, &v.CommitId, &start, &finish, &v.WorkflowPath, &v.Trigger, &child, &pull, &v.ModelId,
		&v.WorkerId, &v.AttemptId, &v.WorkflowBlobId, &v.SourceSha256, &v.EventRef, &v.RepositoryEventId, &v.AutomationGrantId)
	if e != nil {
		return nil, at, e
	}
	v.Ref.Kind = golfv1.ActionRunKind(kind)
	if !actionKind(v.Ref.Kind) || !creationKey.MatchString(v.Ref.Id) || !objectID.MatchString(v.CommitId) || len(v.CommitId) != 40 && len(v.CommitId) != 64 || pull < 0 || pull > 2147483647 {
		return nil, at, errStorageUnavailable
	}
	v.CreatedAt = at.UTC().Format(time.RFC3339Nano)
	if start.Valid {
		x := start.Time.UTC().Format(time.RFC3339Nano)
		v.StartedAt = &x
	}
	if finish.Valid {
		x := finish.Time.UTC().Format(time.RFC3339Nano)
		v.FinishedAt = &x
	}
	v.PullNumber = uint32(pull)
	v.AttemptId = actionAttempt(v.AttemptId)
	if child != "" {
		if !creationKey.MatchString(child) {
			return nil, at, errStorageUnavailable
		}
		v.ChildTask = &golfv1.ActionRunRef{Kind: golfv1.ActionRunKind_ACTION_RUN_KIND_CODING_TASK, Id: child}
	}
	return v, at, nil
}

// Native authority is checked around the complete observation. Task-bearing
// results additionally require writer permission on the final observation.
func (s *Server) withActionRepository(ctx context.Context, h http.Header, a codexActor, key repositoryKey, id int64, operation func(*golfv1.RepositoryAccess) (bool, error)) error {
	if e := s.machineInspectionTarget(ctx, key, id, "agents:read"); e != nil {
		return e
	}
	e := s.withForgeCaller(ctx, s.cookieValue(h), a.Credential, func(user User) error {
		before, e := s.readRepositoryAccess(ctx, a.Credential, key, user)
		if e != nil {
			return e
		}
		if before.RepositoryId != strconv.FormatInt(id, 10) {
			return errResourceNotFound
		}
		private, e := operation(before)
		if e != nil {
			return e
		}
		after, e := s.readRepositoryAccess(ctx, a.Credential, key, user)
		if e != nil {
			return e
		}
		if after.RepositoryId != before.RepositoryId || after.OwnerId != before.OwnerId || after.OrganizationOwned != before.OrganizationOwned {
			return errResourceNotFound
		}
		if private && !workflowWritable(after) {
			return forgeError{http.StatusForbidden}
		}
		return nil
	})
	if e != nil {
		return e
	}
	return s.inspectionGuard(ctx, a)
}

func (s *Server) ListActionRuns(ctx context.Context, req *connect.Request[golfv1.ListActionRunsRequest]) (*connect.Response[golfv1.ListActionRunsResponse], error) {
	a, e := s.codexIdentity(ctx, req.Header())
	if e != nil {
		return nil, rpcError(e)
	}
	id, e := discussionID(req.Msg.RepositoryId)
	if e != nil {
		return nil, rpcError(invalid("Select the exact repository ID."))
	}
	key := keyFrom(req.Msg.Repository)
	if _, e = repositoryPath(key); e != nil {
		return nil, rpcError(e)
	}
	limit := req.Msg.Limit
	if limit == 0 {
		limit = 25
	}
	if limit > 100 {
		return nil, rpcError(invalid("Actions page size must be at most 100."))
	}
	filter := req.Msg.KindFilter
	if filter < 0 || filter > 3 || req.Msg.WorkflowPath != "" && (filter != 1 || !validSourcePath(req.Msg.WorkflowPath) || len(req.Msg.WorkflowPath) > 4096) {
		return nil, rpcError(invalid("Select a supported run kind and workflow path."))
	}
	var cursor actionCursor
	if req.Msg.Cursor != "" {
		cursor, e = decodeActionCursor(req.Msg.Cursor)
		if e != nil {
			return nil, rpcError(e)
		}
	}
	result := &golfv1.ListActionRunsResponse{RepositoryId: req.Msg.RepositoryId}
	e = s.withActionRepository(ctx, req.Header(), a, key, id, func(access *golfv1.RepositoryAccess) (bool, error) {
		owner, e := discussionID(access.OwnerId)
		if e != nil {
			return false, errInvalidForgeResponse
		}
		expected := actionCursor{Version: 1, Repository: id, Owner: owner, User: a.UserID, Limit: limit, Filter: int32(filter), Path: req.Msg.WorkflowPath}
		if req.Msg.Cursor != "" && (cursor.Repository != id || cursor.Owner != owner || cursor.User != a.UserID || cursor.Limit != limit || cursor.Filter != int32(filter) || cursor.Path != req.Msg.WorkflowPath) {
			return false, invalid("Actions cursor does not match this selection.")
		}
		where := ` WHERE ($6=0 OR kind=$6) AND ($7='' OR workflow_path=$7)`
		args := []any{s.config.GiteaURL, id, owner, a.UserID, workflowWritable(access), int32(filter), req.Msg.WorkflowPath}
		if req.Msg.Cursor != "" {
			where += ` AND (created_at,kind,id)<($8::timestamptz,$9::integer,$10::uuid)`
			args = append(args, time.UnixMicro(cursor.At).UTC(), cursor.Kind, cursor.ID)
		}
		args = append(args, limit+1)
		rows, e := s.db.QueryContext(ctx, actionInventorySQL+where+` ORDER BY created_at DESC,kind DESC,id DESC LIMIT $`+strconv.Itoa(len(args)), args...)
		if e != nil {
			return false, errStorageUnavailable
		}
		defer rows.Close()
		var private bool
		var lastAt time.Time
		for rows.Next() {
			v, at, e := scanActionSummary(rows, id, owner)
			if e != nil {
				return false, errStorageUnavailable
			}
			if len(result.Runs) == int(limit) {
				last := result.Runs[len(result.Runs)-1]
				expected.At = lastAt.UnixMicro()
				expected.Kind = int32(last.Ref.Kind)
				expected.ID = last.Ref.Id
				result.NextCursor = encodeActionCursor(expected)
				break
			}
			lastAt = at
			result.Runs = append(result.Runs, v)
			private = private || v.Ref.Kind == 2 || v.ChildTask != nil
		}
		return private, rows.Err()
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(result), nil
}

func (s *Server) GetActionRun(ctx context.Context, req *connect.Request[golfv1.GetActionRunRequest]) (*connect.Response[golfv1.GetActionRunResponse], error) {
	a, e := s.codexIdentity(ctx, req.Header())
	if e != nil {
		return nil, rpcError(e)
	}
	id, e := discussionID(req.Msg.RepositoryId)
	if e != nil {
		return nil, rpcError(invalid("Select the exact repository ID."))
	}
	key := keyFrom(req.Msg.Repository)
	if _, e = repositoryPath(key); e != nil {
		return nil, rpcError(e)
	}
	ref := req.Msg.Ref
	if ref == nil || !actionKind(ref.Kind) || !creationKey.MatchString(ref.Id) {
		return nil, rpcError(invalid("Select an explicit run kind and canonical run ID."))
	}
	result := &golfv1.GetActionRunResponse{RepositoryId: req.Msg.RepositoryId}
	e = s.withActionRepository(ctx, req.Header(), a, key, id, func(access *golfv1.RepositoryAccess) (bool, error) {
		owner, e := discussionID(access.OwnerId)
		if e != nil {
			return false, errInvalidForgeResponse
		}
		// Linked reviewer tasks are available only through their explicit child route.
		query := actionInventorySQL + ` WHERE kind=$6 AND id=$7::uuid`
		if ref.Kind == 2 {
			query = `SELECT 2,id::text,created_at,'Coding task',state,commit_id,started_at,finished_at,'','','',0::bigint,COALESCE(config->>'model_id',''),worker_id,attempt_id,'','','','','' FROM golf_agent_tasks WHERE forge_url=$1 AND repository_id=$2 AND owner_id=$3 AND user_id=$4 AND $5 AND 2=$6 AND id=$7::uuid`
		}
		summary, _, e := scanActionSummary(s.db.QueryRowContext(ctx, query, s.config.GiteaURL, id, owner, a.UserID, workflowWritable(access), int32(ref.Kind), ref.Id), id, owner)
		if errors.Is(e, sql.ErrNoRows) {
			return false, errResourceNotFound
		}
		if e != nil {
			return false, errStorageUnavailable
		}
		result.Summary = summary
		switch ref.Kind {
		case 1:
			r, p, e := s.workflowRunDetail(ctx, ref.Id)
			if e != nil {
				return false, e
			}
			if r.RepositoryID != id || r.OwnerID != owner || r.ForgeURL != s.config.GiteaURL {
				return false, errResourceNotFound
			}
			v := wireWorkflowRun(r, workflowWritable(access))
			v.Progress = p
			summary.State = r.State
			summary.CreatedAt = v.CreatedAt
			summary.StartedAt = v.StartedAt
			summary.FinishedAt = v.FinishedAt
			summary.WorkerId = v.RunnerId
			summary.AttemptId = actionAttempt(r.AttemptID)
			result.Detail = &golfv1.GetActionRunResponse_Workflow{Workflow: v}
		case 2:
			r, e := s.taskRecord(ctx, ref.Id)
			if e != nil {
				return false, e
			}
			if r.RepositoryID != id || r.OwnerID != owner || r.UserID != a.UserID {
				return false, errResourceNotFound
			}
			// The selected current key is native-bound above; historical names
			// must not become authority after a supported native rename.
			v := r.wire(true)
			v.Repository = &golfv1.RepositoryKey{Owner: access.Owner.Login, Name: key.Name}
			summary.State = r.State
			summary.CreatedAt = v.CreatedAt
			summary.StartedAt = nil
			summary.FinishedAt = nil
			if v.StartedAt != "" {
				summary.StartedAt = &v.StartedAt
			}
			if v.FinishedAt != "" {
				summary.FinishedAt = &v.FinishedAt
			}
			summary.WorkerId = r.Worker
			summary.AttemptId = actionAttempt(r.Attempt)
			result.Detail = &golfv1.GetActionRunResponse_Task{Task: v}
		case 3:
			r, e := scanReviewRun(s.db.QueryRowContext(ctx, `SELECT `+reviewRunColumns+` FROM golf_reviewer_runs WHERE id=$1 AND reviewer_id IN(SELECT id FROM golf_reviewers WHERE forge_url=$2 AND repository_id=$3 AND owner_id=$4)`, ref.Id, s.config.GiteaURL, id, owner))
			if errors.Is(e, sql.ErrNoRows) {
				return false, errResourceNotFound
			}
			if e != nil {
				return false, errStorageUnavailable
			}
			if r.RepositoryID != 0 && r.RepositoryID != id {
				return false, errResourceNotFound
			}
			if !objectID.MatchString(r.Base) || !objectID.MatchString(r.Head) || len(r.Base) != len(r.Head) {
				return false, errStorageUnavailable
			}
			summary.State = r.State
			summary.CreatedAt = r.Created.UTC().Format(time.RFC3339Nano)
			if summary.ChildTask != nil && summary.ChildTask.Id != r.Task {
				summary.ChildTask = nil
			}
			v := r.wire()
			if summary.ChildTask == nil {
				v.TaskId = ""
			}
			result.Detail = &golfv1.GetActionRunResponse_Review{Review: v}
		}
		return ref.Kind == 2 || summary.ChildTask != nil, nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(result), nil
}
