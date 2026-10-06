package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/runner"
	"google.golang.org/protobuf/encoding/protojson"
)

const conversationContentDomain = "golf-agent-conversation-content-v1"
const conversationBytes = 256 << 10

type conversationPayload struct {
	Prompt      string                  `json:"prompt,omitempty"`
	Observation runner.AgentObservation `json:"observation"`
}

// Native [] means the plan was explicitly cleared. Preserve it through the
// runner projection's omitempty field so replay does not turn it into missing.
func (p conversationPayload) MarshalJSON() ([]byte, error) {
	type observation struct {
		runner.AgentObservation
		Plan *[]runner.AgentPlanStep `json:"plan,omitempty"`
	}
	value := observation{AgentObservation: p.Observation}
	if p.Observation.Kind == "plan_updated" && p.Observation.Plan != nil {
		value.Plan = &p.Observation.Plan
	}
	return json.Marshal(struct {
		Prompt      string      `json:"prompt,omitempty"`
		Observation observation `json:"observation"`
	}{p.Prompt, value})
}

type conversationEvent struct {
	Sequence           int64
	Kind, Status, Tool string
	Tokens             sql.NullInt64
	Bytes              int
	Created            time.Time
	ID, Key            string
	Cipher, Binding    []byte
}

func validConversationAuth(raw []byte) bool {
	var v map[string]json.RawMessage
	return len(raw) > 0 && len(raw) <= 65536 && json.Unmarshal(raw, &v) == nil && v != nil
}
func conversationBinding(t agentTaskRecord, forge, attempt string, sequence int64, payload []byte) []byte {
	digest := sha256.Sum256(payload)
	scope, _ := json.Marshal([]any{forge, t.UserID, t.NativeID, t.RepositoryID, t.OwnerID, t.ID, attempt, sequence, t.Commit, digest})
	b := sha256.Sum256(scope)
	return b[:]
}
func conversationText(v string, max int) bool {
	if len(v) > max || !utf8.ValidString(v) {
		return false
	}
	for _, c := range v {
		if unicode.IsControl(c) && c != '\n' && c != '\r' && c != '\t' {
			return false
		}
	}
	return true
}
func conversationNativeID(v string) bool {
	if v == "" || len(v) > 128 || !utf8.ValidString(v) {
		return false
	}
	for _, c := range v {
		if unicode.IsControl(c) || unicode.IsSpace(c) {
			return false
		}
	}
	return true
}
func conversationContainsCredential(p conversationPayload, auth []byte) bool {
	values := []string{p.Prompt, p.Observation.ThreadID, p.Observation.TurnID, p.Observation.ItemID, p.Observation.Text}
	for _, step := range p.Observation.Plan {
		values = append(values, step.Step)
	}
	for _, v := range values {
		if agentContainsCredential(v, auth) {
			return true
		}
	}
	return false
}
func conversationMetadata(p conversationPayload) (kind, status, tool string, tokens sql.NullInt64, e error) {
	bad := func() (string, string, string, sql.NullInt64, error) {
		return "", "", "", tokens, errStorageUnavailable
	}
	v := p.Observation
	if p.Prompt != "" {
		if !conversationText(p.Prompt, 16384) || v.Sequence != 0 || v.Kind != "" || v.ThreadID != "" || v.TurnID != "" || v.ItemID != "" || v.Text != "" || v.Phase != "" || v.Status != "" || v.ToolKind != "" || v.Plan != nil || v.TotalTokens != nil {
			return bad()
		}
		return "prompt", "", "", tokens, nil
	}
	if v.Sequence < 1 || v.Sequence > 512 || !conversationNativeID(v.ThreadID) {
		return bad()
	}
	kind, status, tool = v.Kind, v.Status, v.ToolKind
	if kind != "thread_started" && !conversationNativeID(v.TurnID) {
		return bad()
	}
	switch kind {
	case "thread_started":
		if v.TurnID != "" || v.ItemID != "" || status != "" {
			return bad()
		}
	case "turn_started":
		if status != "inProgress" || v.ItemID != "" {
			return bad()
		}
	case "tool_started", "tool_completed", "approval_declined":
		if !conversationNativeID(v.ItemID) || (tool != "commandExecution" && tool != "fileChange") {
			return bad()
		}
		if kind == "tool_started" && status != "inProgress" || kind == "tool_completed" && status != "completed" && status != "failed" && status != "declined" || kind == "approval_declined" && status != "declined" {
			return bad()
		}
	case "assistant_message", "user_message":
		if !conversationNativeID(v.ItemID) || !conversationText(v.Text, 65536) || (v.Phase != "" && v.Phase != "commentary" && v.Phase != "final_answer") || status != "" {
			return bad()
		}
	case "plan_updated":
		if v.Plan == nil || len(v.Plan) > 32 || v.ItemID != "" || status != "" {
			return bad()
		}
		size := 0
		for _, step := range v.Plan {
			size += len(step.Step)
			if strings.TrimSpace(step.Step) == "" || !conversationText(step.Step, 512) || (step.Status != "pending" && step.Status != "inProgress" && step.Status != "completed") {
				return bad()
			}
		}
		if size > 16384 {
			return bad()
		}
	case "usage_updated":
		if v.TotalTokens == nil || *v.TotalTokens < 0 || v.ItemID != "" || status != "" {
			return bad()
		}
		tokens = sql.NullInt64{Int64: *v.TotalTokens, Valid: true}
	case "turn_completed":
		if v.ItemID != "" || (status != "completed" && status != "failed" && status != "interrupted") {
			return bad()
		}
	default:
		return bad()
	}
	if kind != "assistant_message" && kind != "user_message" && (v.Text != "" || v.Phase != "") {
		return bad()
	}
	if kind != "plan_updated" && v.Plan != nil {
		return bad()
	}
	if kind != "usage_updated" && v.TotalTokens != nil {
		return bad()
	}
	if kind != "tool_started" && kind != "tool_completed" && kind != "approval_declined" && tool != "" {
		return bad()
	}
	return
}

// The lease and all original admission fences are rechecked for every durable
// acknowledgement. A failed/lost acknowledgement stops the native observer.
func (s *Server) conversationGuard(ctx context.Context, t agentTaskRecord, r codexRecord, worker, attempt string, operation func(*sql.Tx) error) error {
	a, e := s.taskActor(ctx, t)
	if e == nil {
		e = s.reviewTaskAccess(ctx, t)
	}
	if e != nil {
		return e
	}
	return s.codexGuard(ctx, a, func(tx *sql.Tx, _ int64) error {
		if e := s.agentAttemptFence(ctx, tx, a, r, t); e != nil {
			return e
		}
		var owns bool
		if e := tx.QueryRowContext(ctx, `SELECT state='running' AND worker_id=$3 AND lease_expires_at>clock_timestamp() FROM golf_agent_tasks WHERE id=$1 AND attempt_id=$2 FOR UPDATE`, t.ID, attempt, worker).Scan(&owns); e != nil || !owns {
			return errExecutionPolicyConflict
		}
		if e := operation(tx); e != nil {
			return e
		}
		if _, e := s.taskActor(ctx, t); e != nil {
			return e
		}
		return s.reviewTaskAccess(ctx, t)
	})
}
func (s *Server) startConversation(ctx context.Context, t agentTaskRecord, r codexRecord, worker, attempt, prompt string, auth []byte) error {
	if !validConversationAuth(auth) || agentContainsCredential(prompt, auth) {
		return errStorageUnavailable
	}
	return s.conversationGuard(ctx, t, r, worker, attempt, func(tx *sql.Tx) error {
		if _, e := tx.ExecContext(ctx, `INSERT INTO golf_agent_conversations(task_id,attempt_id,forge_url,repository_id,owner_id,user_id,native_user_id,worker_id,connection_id,connection_version,commit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, t.ID, attempt, s.config.GiteaURL, t.RepositoryID, t.OwnerID, t.UserID, t.NativeID, worker, t.Connection, t.ConnectionVersion, t.Commit); e != nil {
			return errStorageUnavailable
		}
		return s.appendConversationEvent(ctx, tx, t, attempt, 1, conversationPayload{Prompt: prompt})
	})
}
func (s *Server) observeConversation(ctx context.Context, t agentTaskRecord, r codexRecord, worker, attempt string, v runner.AgentObservation, initial []byte) error {
	if v.Sequence < 1 || v.Sequence > 512 {
		return errStorageUnavailable
	}
	payload := conversationPayload{Observation: v}
	if conversationContainsCredential(payload, initial) {
		return errStorageUnavailable
	}
	return s.conversationGuard(ctx, t, r, worker, attempt, func(tx *sql.Tx) error { return s.appendConversationEvent(ctx, tx, t, attempt, v.Sequence+1, payload) })
}
func (s *Server) appendConversationEvent(ctx context.Context, tx *sql.Tx, t agentTaskRecord, attempt string, sequence int64, p conversationPayload) error {
	raw, e := json.Marshal(p)
	if e != nil || len(raw) > conversationBytes {
		return errStorageUnavailable
	}
	kind, status, tool, tokens, e := conversationMetadata(p)
	if e != nil {
		return e
	}
	if p.Prompt != "" && sequence != 1 || p.Prompt == "" && p.Observation.Sequence+1 != sequence {
		return errExecutionPolicyConflict
	}
	binding := conversationBinding(t, s.config.GiteaURL, attempt, sequence, raw)
	var existing []byte
	e = tx.QueryRowContext(ctx, `SELECT c.content_binding FROM golf_agent_task_events e JOIN golf_agent_conversation_contents c ON c.id=e.content_id WHERE e.task_id=$1 AND e.attempt_id=$2 AND e.sequence=$3`, t.ID, attempt, sequence).Scan(&existing)
	if e == nil {
		if !bytes.Equal(binding, existing) {
			return errExecutionPolicyConflict
		}
		return nil
	}
	if !errors.Is(e, sql.ErrNoRows) {
		return errStorageUnavailable
	}
	id := uuid.NewString()
	cipher, key, e := s.keyring.seal(conversationContentDomain, string(raw), binding)
	if e != nil {
		return e
	}
	if _, e = tx.ExecContext(ctx, `INSERT INTO golf_agent_conversation_contents(id,task_id,attempt_id,forge_url,repository_id,user_id,sequence,encrypted_content,content_binding,credential_key_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, id, t.ID, attempt, s.config.GiteaURL, t.RepositoryID, t.UserID, sequence, cipher, binding, key); e != nil {
		return errStorageUnavailable
	}
	var tok any
	if tokens.Valid {
		tok = tokens.Int64
	}
	_, e = tx.ExecContext(ctx, `INSERT INTO golf_agent_task_events(task_id,attempt_id,sequence,content_id,kind,status,tool_kind,total_tokens,projected_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, t.ID, attempt, sequence, id, kind, status, tool, tok, len(raw))
	if e != nil {
		return errStorageUnavailable
	}
	return nil
}

const conversationEventColumns = `e.sequence,e.kind,e.status,e.tool_kind,e.total_tokens,e.projected_bytes,e.created_at,c.id::text,c.credential_key_id,c.encrypted_content,c.content_binding`

func scanConversationEvent(r workflowRunScanner) (v conversationEvent, e error) {
	e = r.Scan(&v.Sequence, &v.Kind, &v.Status, &v.Tool, &v.Tokens, &v.Bytes, &v.Created, &v.ID, &v.Key, &v.Cipher, &v.Binding)
	return
}
func (s *Server) openConversationEvent(t agentTaskRecord, attempt string, v conversationEvent) (p conversationPayload, e error) {
	raw, e := s.keyring.open(v.Key, conversationContentDomain, v.Cipher, v.Binding)
	if e != nil {
		return p, errStorageUnavailable
	}
	if len(raw) != v.Bytes || !bytes.Equal(v.Binding, conversationBinding(t, s.config.GiteaURL, attempt, v.Sequence, []byte(raw))) || json.Unmarshal([]byte(raw), &p) != nil {
		return p, errStorageUnavailable
	}
	kind, status, tool, tokens, e := conversationMetadata(p)
	if e != nil || (p.Prompt == "" && p.Observation.Sequence+1 != v.Sequence) || (p.Prompt != "" && v.Sequence != 1) || kind != v.Kind || status != v.Status || tool != v.Tool || tokens != v.Tokens {
		return p, errStorageUnavailable
	}
	return p, nil
}

// Called in the result transaction, before changing task state. Every stored
// private string is screened together; one unsafe row withholds the whole body.
func (s *Server) screenConversation(ctx context.Context, tx *sql.Tx, t agentTaskRecord, attempt string, initial, refreshed []byte) (bool, error) {
	if !validConversationAuth(initial) || !validConversationAuth(refreshed) {
		return false, nil
	}
	rows, e := tx.QueryContext(ctx, `SELECT `+conversationEventColumns+` FROM golf_agent_task_events e JOIN golf_agent_conversation_contents c ON c.id=e.content_id WHERE e.task_id=$1 AND e.attempt_id=$2 ORDER BY e.sequence LIMIT 514`, t.ID, attempt)
	if e != nil {
		return false, errStorageUnavailable
	}
	defer rows.Close()
	count, total := int64(0), 0
	safe := true
	for rows.Next() {
		v, e := scanConversationEvent(rows)
		if e != nil {
			return false, errStorageUnavailable
		}
		count++
		total += v.Bytes
		if count > 513 || v.Sequence != count || total > conversationBytes {
			return false, errStorageUnavailable
		}
		p, e := s.openConversationEvent(t, attempt, v)
		if e != nil {
			return false, e
		}
		if conversationContainsCredential(p, initial) || conversationContainsCredential(p, refreshed) {
			safe = false
		}
	}
	if e = rows.Err(); e != nil {
		return false, errStorageUnavailable
	}
	var expectedCount, expectedBytes int64
	if e = tx.QueryRowContext(ctx, `SELECT last_sequence,projected_bytes FROM golf_agent_conversations WHERE task_id=$1 AND attempt_id=$2 AND body_state='WITHHELD'`, t.ID, attempt).Scan(&expectedCount, &expectedBytes); e != nil || count != expectedCount || int64(total) != expectedBytes || count == 0 {
		return false, errStorageUnavailable
	}
	return safe, nil
}
func (s *Server) finalizeConversation(ctx context.Context, tx *sql.Tx, t agentTaskRecord, attempt string, available bool) error {
	state := "UNAVAILABLE"
	if available {
		state = "AVAILABLE"
	}
	result, e := tx.ExecContext(ctx, `UPDATE golf_agent_conversations SET body_state=$3 WHERE task_id=$1 AND attempt_id=$2 AND body_state='WITHHELD'`, t.ID, attempt, state)
	if e != nil {
		return errStorageUnavailable
	}
	n, _ := result.RowsAffected()
	if n != 1 {
		return errStorageUnavailable
	}
	return nil
}
func conversationBodyState(v string) golfv1.AgentEventBodyState {
	switch v {
	case "WITHHELD":
		return golfv1.AgentEventBodyState_AGENT_EVENT_BODY_STATE_WITHHELD
	case "AVAILABLE":
		return golfv1.AgentEventBodyState_AGENT_EVENT_BODY_STATE_AVAILABLE
	default:
		return golfv1.AgentEventBodyState_AGENT_EVENT_BODY_STATE_UNAVAILABLE
	}
}

func (s *Server) ListAgentTaskEvents(ctx context.Context, req *connect.Request[golfv1.ListAgentTaskEventsRequest]) (*connect.Response[golfv1.ListAgentTaskEventsResponse], error) {
	a, e := s.agentInspectionIdentity(ctx, req.Header())
	if e != nil {
		return nil, rpcError(e)
	}
	m := req.Msg
	key := keyFrom(m.Repository)
	_, e = repositoryPath(key)
	if e != nil {
		return nil, rpcError(e)
	}
	repoID, e := discussionID(m.RepositoryId)
	if e != nil {
		return nil, rpcError(e)
	}
	if !creationKey.MatchString(m.TaskId) || m.AttemptId != "" && !attemptIdentifier.MatchString(m.AttemptId) || m.Limit > 64 {
		return nil, rpcError(invalid("Select an exact task attempt and bounded event page."))
	}
	after := int64(0)
	if m.AfterSequence != "" {
		after, e = strconv.ParseInt(m.AfterSequence, 10, 64)
		if e != nil || after < 0 || after > 513 || strconv.FormatInt(after, 10) != m.AfterSequence {
			return nil, rpcError(invalid("Invalid private event cursor."))
		}
	}
	limit := int(m.Limit)
	if limit == 0 {
		limit = 32
	}
	out := &golfv1.ListAgentTaskEventsResponse{RepositoryId: m.RepositoryId, TaskId: m.TaskId, AttemptId: m.AttemptId, BodyState: conversationBodyState("UNAVAILABLE")}
	e = s.withActionRepository(ctx, req.Header(), a, key, repoID, func(access *golfv1.RepositoryAccess) (bool, error) {
		if !workflowWritable(access) {
			return true, errResourceNotFound
		}
		t, e := s.taskRecord(ctx, m.TaskId)
		if e != nil {
			return true, e
		}
		if t.RepositoryID != repoID || t.OwnerID != mustID(access.OwnerId) || t.UserID != a.UserID || t.NativeID != a.NativeID || actionAttempt(t.Attempt) != m.AttemptId {
			return true, errResourceNotFound
		}
		out.CommitId = t.Commit
		out.NativeInitiatorId = strconv.FormatInt(t.NativeID, 10)
		if m.AttemptId == "" {
			return true, nil
		}
		tx, e := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
		if e != nil {
			return true, errStorageUnavailable
		}
		defer tx.Rollback()
		var state string
		e = tx.QueryRowContext(ctx, `SELECT body_state FROM golf_agent_conversations WHERE task_id=$1 AND attempt_id=$2 AND forge_url=$3 AND repository_id=$4 AND owner_id=$5 AND user_id=$6 AND native_user_id=$7 AND commit_id=$8`, t.ID, t.Attempt, s.config.GiteaURL, t.RepositoryID, t.OwnerID, t.UserID, t.NativeID, t.Commit).Scan(&state)
		if errors.Is(e, sql.ErrNoRows) {
			return true, nil
		}
		if e != nil {
			return true, errStorageUnavailable
		}
		if state == "WITHHELD" && t.State != "running" {
			state = "UNAVAILABLE"
		}
		out.BodyState = conversationBodyState(state)
		rows, e := tx.QueryContext(ctx, `SELECT `+conversationEventColumns+` FROM golf_agent_task_events e JOIN golf_agent_conversation_contents c ON c.id=e.content_id WHERE e.task_id=$1 AND e.attempt_id=$2 AND e.sequence>$3 ORDER BY e.sequence LIMIT $4`, t.ID, t.Attempt, after, limit+1)
		if e != nil {
			return true, errStorageUnavailable
		}
		defer rows.Close()
		for rows.Next() {
			v, e := scanConversationEvent(rows)
			if e != nil {
				return true, errStorageUnavailable
			}
			if len(out.Events) == limit {
				out.NextSequence = out.Events[len(out.Events)-1].Sequence
				break
			}
			event := &golfv1.AgentTaskEvent{Sequence: strconv.FormatInt(v.Sequence, 10), Kind: v.Kind, CreatedAt: v.Created.UTC().Format(time.RFC3339Nano), Status: v.Status, ToolKind: v.Tool, BodyState: out.BodyState}
			if v.Tokens.Valid {
				x := strconv.FormatInt(v.Tokens.Int64, 10)
				event.TotalTokens = &x
			}
			if state == "AVAILABLE" {
				p, e := s.openConversationEvent(t, t.Attempt, v)
				if e != nil {
					return true, e
				}
				event.Text = p.Prompt
				if p.Prompt == "" {
					o := p.Observation
					event.Text = o.Text
					event.ThreadId = o.ThreadID
					event.TurnId = o.TurnID
					event.ItemId = o.ItemID
					event.Phase = o.Phase
					for _, step := range o.Plan {
						event.Plan = append(event.Plan, &golfv1.AgentEventPlanStep{Step: step.Step, Status: step.Status})
					}
				}
			}
			out.Events = append(out.Events, event)
			raw, e := protojson.Marshal(out)
			if e != nil {
				return true, errStorageUnavailable
			}
			if len(raw) > 512<<10 {
				out.Events = out.Events[:len(out.Events)-1]
				if len(out.Events) == 0 {
					return true, errStorageUnavailable
				}
				out.NextSequence = out.Events[len(out.Events)-1].Sequence
				break
			}
		}
		if e = rows.Err(); e != nil {
			return true, errStorageUnavailable
		}
		return true, nil
	})
	if e != nil {
		return nil, rpcError(e)
	}
	return connect.NewResponse(out), nil
}
