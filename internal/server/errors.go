package server

import (
	"context"
	"errors"

	"connectrpc.com/connect"
)

var (
	errRepositoryCreationConflict = errors.New("repository creation key has different inputs")
	errOAuthClientRejected        = errors.New("OAuth application credentials rejected")
	errOAuthDisabled              = errors.New("OAuth unavailable")
	errInvalidForgeResponse       = errors.New("invalid forge response")
	errForgeUnavailable           = errors.New("forge unavailable")
	errEmptyRepository            = errors.New("repository has no commits")
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
		code, message = connect.CodeUnavailable, "Gitea rejected Golf's OAuth application credentials. Ask your administrator to check the OAuth configuration."
	case errors.Is(err, errOAuthDisabled):
		code, message = connect.CodeFailedPrecondition, "Gitea OAuth sign-in is not currently available."
	case errors.Is(err, errEmptyRepository):
		code, message = connect.CodeFailedPrecondition, "This repository has no commits yet."
	case errors.Is(err, errDiffTextUnsupported):
		code, message = connect.CodeFailedPrecondition, "This diff contains unsupported text encoding or control characters. Read it with a local Git client."
	case errors.Is(err, errForgeResponseTooLarge):
		code, message = connect.CodeResourceExhausted, "Gitea's response exceeds this browser's size limit. Open the resource in Gitea."
	case errors.Is(err, errInvalidForgeResponse), errors.Is(err, errForgeUnavailable):
		code, message = connect.CodeUnavailable, "Gitea is unavailable or returned an unexpected response."
	case errors.Is(err, context.Canceled):
		code, message = connect.CodeCanceled, "The operation was cancelled."
	case errors.Is(err, context.DeadlineExceeded):
		code, message = connect.CodeDeadlineExceeded, "The operation exceeded its deadline."
	case errors.As(err, &upstream):
		switch upstream.status {
		case 401:
			code, message = connect.CodeUnauthenticated, "Gitea rejected this credential. Sign in with a current token."
		case 403:
			code, message = connect.CodePermissionDenied, "Gitea denied this operation. Check token scopes and account permissions."
		case 404:
			code, message = connect.CodeNotFound, "This resource does not exist or is not accessible."
		case 409, 422:
			code, message = connect.CodeAlreadyExists, "Gitea could not create this repository. Check its name and your permissions."
		case 429:
			code, message = connect.CodeResourceExhausted, "Gitea rate limit reached. Retry later."
		default:
			code, message = connect.CodeUnavailable, "Gitea is unavailable or returned an unexpected response."
		}
	}
	return connect.NewError(code, errors.New(message))
}
