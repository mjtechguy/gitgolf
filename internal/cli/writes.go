package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func newWriteRequest(name string) proto.Message {
	switch name {
	case "source file":
		return &golfv1.SubmitRepositoryFileMutationRequest{}
	case "source ref":
		return &golfv1.SubmitRepositoryRefMutationRequest{}
	case "issue create":
		return &golfv1.CreateIssueRequest{}
	case "issue comment":
		return &golfv1.CreateIssueCommentRequest{}
	case "issue update":
		return &golfv1.UpdateIssueRequest{}
	case "pr create":
		return &golfv1.CreatePullRequestRequest{}
	case "pr update":
		return &golfv1.UpdatePullRequestRequest{}
	case "pr review":
		return &golfv1.CreatePullRequestReviewRequest{}
	}
	return nil
}
func parseWriteCommand(c command, args []string) (command, error) {
	flags := flag.NewFlagSet(c.name, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&c.writeInput, "input", "", "versioned JSON request file")
	if err := flags.Parse(args); err != nil {
		return c, err
	}
	if flags.NArg() != 0 || c.writeInput == "" || c.writeInput == "-" {
		return c, errors.New("An explicit request file is required")
	}
	return c, nil
}
func decodeWriteRequest(c *command, raw []byte) error {
	request := newTypedRequest(c.name)
	if request == nil || len(raw) > requestBytes(c.name) || protojson.Unmarshal(raw, request) != nil {
		return errors.New("Invalid typed write request")
	}
	if newMachineReadRequest(c.name) != nil {
		if err := validateMachineRead(request); err != nil {
			return err
		}
		c.writeRequest = request
		return nil
	}
	fields := request.ProtoReflect()
	descriptors := fields.Descriptor().Fields()
	keyField := descriptors.ByName("idempotency_key")
	if keyField == nil {
		keyField = descriptors.ByName("operation_id")
	}
	key := fields.Get(keyField).String()
	id := fields.Get(descriptors.ByName("repository_id")).String()
	repository := fields.Get(descriptors.ByName("repository")).Message()
	if !creationKey.MatchString(key) || !canonicalNativeID(id) || !repository.IsValid() {
		return errors.New("An exact repository and original UUID v4 are required")
	}
	owner := repository.Get(repository.Descriptor().Fields().ByName("owner")).String()
	name := repository.Get(repository.Descriptor().Fields().ByName("name")).String()
	if !organizationName.MatchString(owner) || !organizationName.MatchString(name) || owner == "." || owner == ".." || name == "." || name == ".." {
		return errors.New("Invalid repository identity")
	}
	c.writeRequest = request
	return nil
}
func (c command) write(ctx context.Context, client golfv1connect.RepositoryServiceClient) (proto.Message, error) {
	switch input := c.writeRequest.(type) {
	case *golfv1.CreateIssueRequest:
		r, e := client.CreateIssue(ctx, connect.NewRequest(input))
		if e != nil {
			return nil, e
		}
		return r.Msg, nil
	case *golfv1.CreateIssueCommentRequest:
		r, e := client.CreateIssueComment(ctx, connect.NewRequest(input))
		if e != nil {
			return nil, e
		}
		return r.Msg, nil
	case *golfv1.UpdateIssueRequest:
		r, e := client.UpdateIssue(ctx, connect.NewRequest(input))
		if e != nil {
			return nil, e
		}
		return r.Msg, nil
	case *golfv1.CreatePullRequestRequest:
		r, e := client.CreatePullRequest(ctx, connect.NewRequest(input))
		if e != nil {
			return nil, e
		}
		return r.Msg, nil
	case *golfv1.UpdatePullRequestRequest:
		r, e := client.UpdatePullRequest(ctx, connect.NewRequest(input))
		if e != nil {
			return nil, e
		}
		return r.Msg, nil
	case *golfv1.CreatePullRequestReviewRequest:
		r, e := client.CreatePullRequestReview(ctx, connect.NewRequest(input))
		if e != nil {
			return nil, e
		}
		return r.Msg, nil
	}
	return nil, errors.New("Unsupported write request")
}

func (c command) operationError(err error) error {
	safe := operationError(err)
	if c.writeRequest == nil || newWriteRequest(c.name) == nil {
		return safe
	}
	fields := c.writeRequest.ProtoReflect()
	keyField := fields.Descriptor().Fields().ByName("idempotency_key")
	if keyField == nil {
		keyField = fields.Descriptor().Fields().ByName("operation_id")
	}
	key := fields.Get(keyField).String()
	inspect := "issue operation"
	if c.name == "source file" {
		inspect = "source operation --input ORIGINAL_INSPECTION_JSON"
	}
	if c.name == "source ref" {
		inspect = "ref operation --input ORIGINAL_INSPECTION_JSON"
	}
	if c.name == "pr review" {
		inspect = "pr review-operation"
	}
	if c.name == "source file" || c.name == "source ref" {
		return fmt.Errorf("%v. Write outcome may be unknown; inspect the original key %s with golf %s before any separate operation", safe, key, inspect)
	}
	return fmt.Errorf("%v. Write outcome may be unknown; inspect the original key with golf %s %s before any separate operation", safe, inspect, key)
}
