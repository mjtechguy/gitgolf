package server

import (
	"context"
	"errors"

	"connectrpc.com/connect"
)

var (
	errSSHKeyRejected             = errors.New("SSH key rejected")
	errLocalCredentials           = errors.New("local credentials rejected")
	errLocalRateLimited           = errors.New("local login rate limit")
	errIssueTargetChanged         = errors.New("issue target identity changed")
	errIssueMutationConflict      = errors.New("issue mutation key has different inputs")
	errApiCredentialReadOnly      = errors.New("API credential procedure denied")
	errApiCredentialLimit         = errors.New("active API credential limit")
	errRepositoryCreationConflict = errors.New("repository creation key has different inputs")
	errOAuthClientRejected        = errors.New("OAuth application credentials rejected")
	errOAuthDisabled              = errors.New("OAuth unavailable")
	errInvalidForgeResponse       = errors.New("invalid forge response")
	errForgeUnavailable           = errors.New("forge unavailable")
	errEmptyRepository            = errors.New("repository has no commits")
	errPullSnapshotChanged        = errors.New("pull comparison changed")
	errDiffTextUnsupported        = errors.New("commit diff cannot be represented as supported text")
	errResourceNotFound           = errors.New("resource not found")
	errUnauthenticated            = errors.New("session missing or expired")
	errStorageUnavailable         = errors.New("session storage unavailable")
	errCredentialUnavailable      = errors.New("session credential unavailable")
)

type inputError string

func (e inputError) Error() string { return string(e) }
func invalid(message string) error { return inputError(message) }

// rpcError is the closed domain-to-wire mapping. Unknown errors are never
// copied to clients: SQL, transport errors and credentials stay server-side.
func rpcError(err error) error {
	if err == nil {
		return nil
	}
	code, message := connect.CodeInternal, "The operation could not be completed."
	var input inputError
	var upstream forgeError
	switch {
	case errors.Is(err, errReviewDraftConflict):
		code, message = connect.CodeAborted, "The private draft version or target generation changed. Refresh and inspect the accepted operation before saving again."
	case errors.Is(err, errReviewDraftIntent):
		code, message = connect.CodeFailedPrecondition, "This private draft operation ID is bound to a different intent. Inspect its receipt."
	case errors.Is(err, errReviewDraftQuota):
		code, message = connect.CodeResourceExhausted, "Private review draft retention quota reached. Contact your instance operator."
	case errors.Is(err, errCodexPermission):
		code, message = connect.CodePermissionDenied, "You do not have permission to manage this Codex connection."
	case errors.Is(err, errCodexBrowserOnly):
		code, message = connect.CodePermissionDenied, "Use your Golf browser account to manage Codex authentication."
	case errors.Is(err, errCodexConflict):
		code, message = connect.CodeFailedPrecondition, "Codex connection changed. Refresh before retrying."
	case errors.Is(err, errCodexUnavailable):
		code, message = connect.CodeUnavailable, "Codex account service is unavailable."
	case errors.Is(err, errAutomationGrantConflict):
		code, message = connect.CodeFailedPrecondition, "Automation grant revision or intent changed. Refresh and review before continuing."
	case errors.Is(err, errAutomationGrantLimit):
		code, message = connect.CodeResourceExhausted, "Revoke an active grant before creating another."
	case errors.Is(err, errInfrastructureConflict):
		code, message = connect.CodeFailedPrecondition, "Infrastructure connection changed or its source binding is unavailable. Refresh and review before continuing."
	case errors.Is(err, errOrganizationCreationPolicyConflict):
		code, message = connect.CodeFailedPrecondition, "Organization creation policy changed. Refresh before continuing."
	case errors.Is(err, errWorkflowStepUnrecorded):
		code, message = connect.CodeFailedPrecondition, "The selected step has no recorded log boundaries."
	case errors.Is(err, errWorkflowRunConflict):
		code, message = connect.CodeFailedPrecondition, "Workflow run intent or version changed. Inspect the recorded run before continuing."
	case errors.Is(err, errWorkflowPolicyDenied):
		code, message = connect.CodePermissionDenied, "Manual workflow execution is disabled by the applicable execution policy."
	case errors.Is(err, errWorkflowSource):
		code, message = connect.CodeFailedPrecondition, "Repository source is outside the bounded safe source archive catalog."
	case errors.Is(err, errWorkflowExecutionUnsupported):
		code, message = connect.CodeFailedPrecondition, "Workflow is outside the bounded manual Linux shell catalog."
	case errors.Is(err, errRunnerUnavailable):
		code, message = connect.CodeFailedPrecondition, "No operator-enrolled worker image supports this workflow. Ask your instance administrator to configure a worker and approved image."
	case errors.Is(err, errExecutionPolicyConflict):
		code, message = connect.CodeFailedPrecondition, "Execution policy or authority changed. Refresh and review it before continuing."
	case errors.Is(err, errAdminAccountConflict):
		code, message = connect.CodeFailedPrecondition, "The account state changed. Refresh and inspect it before continuing."
	case errors.Is(err, errPasswordConfirmation):
		code, message = connect.CodePermissionDenied, "Password confirmation failed. Check your Golf password and try again."
	case errors.Is(err, errRepositoryAccessConflict):
		code, message = connect.CodeFailedPrecondition, "Repository access changed. Refresh and review the current grants before continuing."
	case errors.Is(err, errOrganizationAdminConflict):
		code, message = connect.CodeFailedPrecondition, "Organization or team membership changed. Refresh before continuing."
	case errors.Is(err, errProfileConflict):
		code, message = connect.CodeFailedPrecondition, "Your profile changed. Refresh and review the current values before editing."
	case errors.Is(err, errRepositorySettingsConflict):
		code, message = connect.CodeFailedPrecondition, "Repository settings changed. Refresh before editing again."
	case errors.Is(err, errSSHKeyRejected):
		code, message = connect.CodeFailedPrecondition, "The SSH key was rejected or already exists. Refresh your keys and check the public key before trying again."
	case errors.Is(err, errLocalCredentials):
		code, message = connect.CodeUnauthenticated, "Sign-in could not be completed. Check your Golf username and password and try again."
	case errors.Is(err, errLocalRateLimited):
		code, message = connect.CodeResourceExhausted, "Too many sign-in attempts. Wait before trying again."
	case errors.Is(err, errIssueTargetChanged):
		code, message = connect.CodeFailedPrecondition, "The repository or issue identity changed. Refresh the discussion before continuing."
	case errors.Is(err, errIssueMutationConflict):
		code, message = connect.CodeFailedPrecondition, "This issue mutation key is already bound to different inputs. Inspect its recorded outcome; use a new key only for a new operation."
	case errors.Is(err, errApiCredentialReadOnly):
		code, message = connect.CodePermissionDenied, "API credentials allow only the documented read procedures. Use a browser session for this operation."
	case errors.Is(err, errApiCredentialLimit):
		code, message = connect.CodeResourceExhausted, "This account already has 100 active API credentials. Revoke a credential before creating another."
	case errors.Is(err, errRepositoryCreationConflict):
		code, message = connect.CodeFailedPrecondition, "This repository creation key is already bound to different inputs. Use its original inputs or a new key for a new operation."
	case errors.As(err, &input):
		code, message = connect.CodeInvalidArgument, string(input)
	case errors.Is(err, errUnauthenticated):
		code, message = connect.CodeUnauthenticated, "Session expired or missing. Sign in to Golf."
	case errors.Is(err, errStorageUnavailable):
		code, message = connect.CodeUnavailable, "Session storage is unavailable."
	case errors.Is(err, errCredentialUnavailable):
		code, message = connect.CodeUnavailable, "Session credential cannot be decrypted. Sign in again."
	case errors.Is(err, errResourceNotFound):
		code, message = connect.CodeNotFound, "This resource does not exist or is not accessible."
	case errors.Is(err, errOAuthClientRejected):
		code, message = connect.CodeUnavailable, "The identity provider rejected Golf's application credentials. Ask your administrator to check the OAuth configuration."
	case errors.Is(err, errOAuthDisabled):
		code, message = connect.CodeFailedPrecondition, "Provider sign-in is not currently available."
	case errors.Is(err, errEmptyRepository):
		code, message = connect.CodeFailedPrecondition, "This repository has no commits yet."
	case errors.Is(err, errPullSnapshotChanged):
		code, message = connect.CodeFailedPrecondition, "The pull request comparison changed. Refresh the pull request before reading its new files."
	case errors.Is(err, errDiffTextUnsupported):
		code, message = connect.CodeFailedPrecondition, "This diff contains unsupported text encoding or control characters. Read it with a local Git client."
	case errors.Is(err, errForgeResponseTooLarge):
		code, message = connect.CodeResourceExhausted, "The repository response exceeds this browser's size limit. Open the original resource."
	case errors.Is(err, errInvalidForgeResponse), errors.Is(err, errForgeUnavailable):
		code, message = connect.CodeUnavailable, "The repository service is unavailable or returned an unexpected response."
	case errors.Is(err, context.Canceled):
		code, message = connect.CodeCanceled, "The operation was cancelled."
	case errors.Is(err, context.DeadlineExceeded):
		code, message = connect.CodeDeadlineExceeded, "The operation exceeded its deadline."
	case errors.As(err, &upstream):
		switch upstream.status {
		case 401:
			code, message = connect.CodeUnauthenticated, "Your account credential is no longer accepted. Sign in again."
		case 403:
			code, message = connect.CodePermissionDenied, "Your account does not have permission for this operation."
		case 404:
			code, message = connect.CodeNotFound, "This resource does not exist or is not accessible."
		case 409, 422:
			code, message = connect.CodeAlreadyExists, "Golf could not create this repository. Check its name and your permissions."
		case 429:
			code, message = connect.CodeResourceExhausted, "The repository service rate limit was reached. Retry later."
		default:
			code, message = connect.CodeUnavailable, "The repository service is unavailable or returned an unexpected response."
		}
	}
	return connect.NewError(code, errors.New(message))
}
