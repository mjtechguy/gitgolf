package server

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
)

// An omitted edit retains consent; an omitted new subscription preserves legacy
// activity delivery. UNSPECIFIED is never a saved or explicitly requested mode.
func workflowNotificationMode(requested *golfv1.WorkflowNotificationMode, prior int32) (int32, error) {
	if requested != nil {
		prior = int32(*requested)
	}
	if requested == nil && prior == 0 {
		prior = int32(golfv1.WorkflowNotificationMode_WORKFLOW_NOTIFICATION_MODE_ACTIVITY)
	}
	if prior < 1 || prior > 3 {
		return 0, invalid("Select activity, terminal outcomes, or failures and timeouts.")
	}
	return prior, nil
}

type workflowNotificationEvent struct {
	RunID, EventID, ForgeURL, AttemptID, State string
	RepositoryID, OwnerID                      int64
	ObservedAt                                 time.Time
}

func workflowOutcomeLabel(state string) (string, error) {
	switch state {
	case "succeeded":
		return "Succeeded", nil
	case "failed":
		return "Failed", nil
	case "timed_out":
		return "Timed out", nil
	case "cancelled":
		return "Cancelled", nil
	case "lost":
		return "Outcome unconfirmed (lost)", nil
	default:
		return "", errors.New("Unsupported workflow outcome")
	}
}

// This reads the immutable journal, never mutable run state, logs or source.
// A delivery must bind the exact still-authorized subscription repository/owner.
func (s *Server) workflowEmailEvent(ctx context.Context, d emailDelivery) (workflowNotificationEvent, error) {
	var e workflowNotificationEvent
	if d.Topic != "actions" || !strings.HasPrefix(d.EventID, "workflow-terminal:") {
		return e, errCredentialUnavailable
	}
	err := s.db.QueryRowContext(ctx, `SELECT e.run_id::text,e.event_id,e.forge_url,e.repository_id,e.owner_id,e.attempt_id,e.state,e.observed_at
 FROM golf_workflow_notification_events e JOIN golf_email_subscriptions ss ON ss.id=$2::uuid
 WHERE e.event_id=$1 AND e.forge_url=ss.forge_url AND e.repository_id=ss.repository_id AND e.owner_id=ss.owner_id
 AND ss.user_id=$3 AND ss.version=$4 AND ss.epoch=$5`, d.EventID, d.SubscriptionID, d.UserID, d.SubscriptionVersion, d.Epoch).Scan(&e.RunID, &e.EventID, &e.ForgeURL, &e.RepositoryID, &e.OwnerID, &e.AttemptID, &e.State, &e.ObservedAt)
	if err != nil || e.ForgeURL != s.config.GiteaURL || !creationKey.MatchString(e.RunID) || e.EventID != "workflow-terminal:"+e.RunID || e.RepositoryID <= 0 || e.OwnerID <= 0 || e.AttemptID != "" && !attemptIdentifier.MatchString(e.AttemptID) {
		return e, errCredentialUnavailable
	}
	if _, err = workflowOutcomeLabel(e.State); err != nil {
		return e, errCredentialUnavailable
	}
	return e, nil
}

func workflowOutcomeEmailText(e workflowNotificationEvent, link, unsubscribe string) (string, error) {
	label, err := workflowOutcomeLabel(e.State)
	if err != nil {
		return "", err
	}
	attempt := "Not assigned"
	if e.AttemptID != "" {
		attempt = e.AttemptID
	}
	return "Golf workflow outcome: " + label + "\nRun: " + e.RunID + "\nAttempt: " + attempt + "\nRepository ID: " + strconv.FormatInt(e.RepositoryID, 10) + "\nOwner ID: " + strconv.FormatInt(e.OwnerID, 10) + "\nObserved at: " + e.ObservedAt.UTC().Format(time.RFC3339) + "\n\nView the workflow after signing in:\n" + link + "\n\nManage this email subscription:\n" + unsubscribe + "\n\nThis is a recorded terminal workflow state. Lost means the execution outcome is unconfirmed; cancelled does not prove immediate process cleanup. No source, logs, prompts or agent content are included. SMTP acceptance does not establish inbox delivery.", nil
}
