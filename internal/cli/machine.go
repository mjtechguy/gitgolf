package cli

import (
	"context"
	"errors"
	"net/http"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/gen/golf/v1/golfv1connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// Fixed typed catalogue only: the request cannot choose an RPC, origin or token.
func newMachineReadRequest(name string) proto.Message {
	switch name {
	case "repo access":
		return &golfv1.GetRepositoryAccessRequest{}
	case "source access":
		return &golfv1.GetRepositoryFileMutationAccessRequest{}
	case "source operation":
		return &golfv1.GetRepositoryFileMutationOperationRequest{}
	case "ref operation":
		return &golfv1.GetRepositoryRefMutationOperationRequest{}
	case "actions list":
		return &golfv1.ListWorkflowRunsRequest{}
	case "actions view":
		return &golfv1.GetWorkflowRunRequest{}
	case "actions logs":
		return &golfv1.GetWorkflowRunLogsRequest{}
	case "agent list":
		return &golfv1.ListAgentTasksRequest{}
	case "agent view":
		return &golfv1.GetAgentTaskRequest{}
	case "agent events":
		return &golfv1.ListAgentTaskEventsRequest{}
	}
	return nil
}
func newTypedRequest(name string) proto.Message {
	if request := newWriteRequest(name); request != nil {
		return request
	}
	return newMachineReadRequest(name)
}
func requestBytes(name string) int {
	if name == "source file" {
		return 384 << 10
	}
	return 16384
}
func typedCall[Request, Response any](ctx context.Context, httpClient *http.Client, origin, procedure string, request *Request, options ...connect.ClientOption) (proto.Message, error) {
	response, err := connect.NewClient[Request, Response](httpClient, origin+"/rpc"+procedure, options...).CallUnary(ctx, connect.NewRequest(request))
	if err != nil {
		return nil, err
	}
	message, ok := any(response.Msg).(proto.Message)
	if !ok {
		return nil, errors.New("Invalid typed response")
	}
	return message, nil
}
func (c command) machine(ctx context.Context, client *http.Client, origin string, options ...connect.ClientOption) (proto.Message, error) {
	switch input := c.writeRequest.(type) {
	case *golfv1.GetRepositoryAccessRequest:
		return typedCall[golfv1.GetRepositoryAccessRequest, golfv1.GetRepositoryAccessResponse](ctx, client, origin, golfv1connect.RepositoryAccessServiceGetRepositoryAccessProcedure, input, options...)
	case *golfv1.GetRepositoryFileMutationAccessRequest:
		return typedCall[golfv1.GetRepositoryFileMutationAccessRequest, golfv1.GetRepositoryFileMutationAccessResponse](ctx, client, origin, golfv1connect.RepositoryFileMutationServiceGetRepositoryFileMutationAccessProcedure, input, options...)
	case *golfv1.SubmitRepositoryFileMutationRequest:
		return typedCall[golfv1.SubmitRepositoryFileMutationRequest, golfv1.SubmitRepositoryFileMutationResponse](ctx, client, origin, golfv1connect.RepositoryFileMutationServiceSubmitRepositoryFileMutationProcedure, input, options...)
	case *golfv1.GetRepositoryFileMutationOperationRequest:
		return typedCall[golfv1.GetRepositoryFileMutationOperationRequest, golfv1.GetRepositoryFileMutationOperationResponse](ctx, client, origin, golfv1connect.RepositoryFileMutationServiceGetRepositoryFileMutationOperationProcedure, input, options...)
	case *golfv1.SubmitRepositoryRefMutationRequest:
		return typedCall[golfv1.SubmitRepositoryRefMutationRequest, golfv1.SubmitRepositoryRefMutationResponse](ctx, client, origin, golfv1connect.RepositoryRefMutationServiceSubmitRepositoryRefMutationProcedure, input, options...)
	case *golfv1.GetRepositoryRefMutationOperationRequest:
		return typedCall[golfv1.GetRepositoryRefMutationOperationRequest, golfv1.GetRepositoryRefMutationOperationResponse](ctx, client, origin, golfv1connect.RepositoryRefMutationServiceGetRepositoryRefMutationOperationProcedure, input, options...)
	case *golfv1.ListWorkflowRunsRequest:
		return typedCall[golfv1.ListWorkflowRunsRequest, golfv1.ListWorkflowRunsResponse](ctx, client, origin, golfv1connect.WorkflowRunServiceListWorkflowRunsProcedure, input, options...)
	case *golfv1.GetWorkflowRunRequest:
		return typedCall[golfv1.GetWorkflowRunRequest, golfv1.GetWorkflowRunResponse](ctx, client, origin, golfv1connect.WorkflowRunServiceGetWorkflowRunProcedure, input, options...)
	case *golfv1.GetWorkflowRunLogsRequest:
		return typedCall[golfv1.GetWorkflowRunLogsRequest, golfv1.GetWorkflowRunLogsResponse](ctx, client, origin, golfv1connect.WorkflowRunServiceGetWorkflowRunLogsProcedure, input, options...)
	case *golfv1.ListAgentTasksRequest:
		return typedCall[golfv1.ListAgentTasksRequest, golfv1.ListAgentTasksResponse](ctx, client, origin, golfv1connect.AgentTaskServiceListAgentTasksProcedure, input, options...)
	case *golfv1.GetAgentTaskRequest:
		return typedCall[golfv1.GetAgentTaskRequest, golfv1.GetAgentTaskResponse](ctx, client, origin, golfv1connect.AgentTaskServiceGetAgentTaskProcedure, input, options...)
	case *golfv1.ListAgentTaskEventsRequest:
		return typedCall[golfv1.ListAgentTaskEventsRequest, golfv1.ListAgentTaskEventsResponse](ctx, client, origin, golfv1connect.AgentTaskServiceListAgentTaskEventsProcedure, input, options...)
	}
	return nil, errors.New("Unsupported machine request")
}

var mcpMachineReads = []mcpRead{
	{"golf_repo_access", "Inspect current repository authority and exact IDs before proposing an operation; no permission changes.", "repo access", nil, nil},
	{"golf_source_access", "Inspect exact branch/source write eligibility under source:write. Protected branches remain unavailable.", "source access", nil, nil},
	{"golf_source_operation", "Inspect your original file operation under source:write; never repeats dispatch.", "source operation", nil, nil},
	{"golf_ref_operation", "Inspect your original branch/tag operation under source:write; never repeats dispatch.", "ref operation", nil, nil},
	{"golf_actions_list", "Inspect explicitly paged workflow runs under actions:read for one exact repository grant.", "actions list", nil, nil},
	{"golf_actions_view", "Inspect current job/step progress under actions:read; does not dispatch or cancel a run.", "actions view", nil, nil},
	{"golf_actions_logs", "Read bounded retained terminal log chunks under actions:read with explicit job/step/sequence coordinates.", "actions logs", nil, nil},
	{"golf_agent_list", "List your own private coding tasks under agents:read for one exact repository grant.", "agent list", nil, nil},
	{"golf_agent_view", "Inspect your own coding task summary/proposed patch under agents:read. Does not execute or apply it.", "agent view", nil, nil},
	{"golf_agent_events", "Read your own retained encrypted coding-task journal under agents:read and exact attempt. Unavailable/withheld bodies remain explicit; not interactive ACP.", "agent events", nil, nil},
}

func validateMachineRead(request proto.Message) error {
	fields := request.ProtoReflect()
	descriptors := fields.Descriptor().Fields()
	if field := descriptors.ByName("repository"); field != nil {
		repository := fields.Get(field).Message()
		if !repository.IsValid() {
			return errors.New("Select an exact repository")
		}
		for _, key := range []string{"owner", "name"} {
			value := repository.Get(repository.Descriptor().Fields().ByName(protoreflect.Name(key))).String()
			if !organizationName.MatchString(value) || value == "." || value == ".." {
				return errors.New("Invalid repository identity")
			}
		}
	}
	for _, name := range []string{"repository_id", "owner_id"} {
		if field := descriptors.ByName(protoreflect.Name(name)); field != nil && !canonicalNativeID(fields.Get(field).String()) {
			return errors.New("Exact canonical native IDs are required")
		}
	}
	for _, name := range []string{"run_id", "task_id", "operation_id"} {
		if field := descriptors.ByName(protoreflect.Name(name)); field != nil && !creationKey.MatchString(fields.Get(field).String()) {
			return errors.New("An original canonical UUID is required")
		}
	}
	return nil
}
