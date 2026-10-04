package server

import (
	"context"
	"database/sql"
	"strconv"

	"connectrpc.com/connect"
	golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"
	"github.com/mjtechguy/golf-git/internal/server/database"
)

const workflowManualInputsContract = "golf.workflow.dispatch.inputs.v1"

func workflowDispatchWireValues(schema workflowDispatchInputSchema, submitted []*golfv1.WorkflowDispatchInputValue) (workflowDispatchInputValues, error) {
	if len(submitted) > maxWorkflowDispatchInputs {
		return workflowDispatchInputValues{}, errWorkflowDispatchInputValues
	}
	definitions := map[string]workflowDispatchInputDefinition{}
	for _, d := range schema.Definitions {
		definitions[d.Name] = d
	}
	values := make([]workflowDispatchInputValue, 0, len(submitted))
	for _, v := range submitted {
		if v == nil || len(v.ProtoReflect().GetUnknown()) != 0 {
			return workflowDispatchInputValues{}, errWorkflowDispatchInputValues
		}
		d, exists := definitions[v.Name]
		if !exists {
			return workflowDispatchInputValues{}, errWorkflowDispatchInputValues
		}
		value := workflowDispatchInputValue{Name: v.Name, Type: d.Type}
		switch v := v.Value.(type) {
		case *golfv1.WorkflowDispatchInputValue_StringValue:
			if d.Type != workflowDispatchString && d.Type != workflowDispatchChoice {
				return workflowDispatchInputValues{}, errWorkflowDispatchInputValues
			}
			value.String = v.StringValue
		case *golfv1.WorkflowDispatchInputValue_BooleanValue:
			if d.Type != workflowDispatchBoolean {
				return workflowDispatchInputValues{}, errWorkflowDispatchInputValues
			}
			value.Boolean = v.BooleanValue
		case *golfv1.WorkflowDispatchInputValue_NumberValue:
			if d.Type != workflowDispatchNumber {
				return workflowDispatchInputValues{}, errWorkflowDispatchInputValues
			}
			value.Number = v.NumberValue
		default:
			return workflowDispatchInputValues{}, errWorkflowDispatchInputValues
		}
		values = append(values, value)
	}
	return validateWorkflowDispatchInputs(schema, values)
}

func workflowDispatchValueWire(v workflowDispatchInputValue) *golfv1.WorkflowDispatchInputValue {
	w := &golfv1.WorkflowDispatchInputValue{Name: v.Name}
	switch v.Type {
	case workflowDispatchString, workflowDispatchChoice:
		w.Value = &golfv1.WorkflowDispatchInputValue_StringValue{StringValue: v.String}
	case workflowDispatchBoolean:
		w.Value = &golfv1.WorkflowDispatchInputValue_BooleanValue{BooleanValue: v.Boolean}
	case workflowDispatchNumber:
		w.Value = &golfv1.WorkflowDispatchInputValue_NumberValue{NumberValue: v.Number}
	}
	return w
}

func workflowDispatchDefinitionsWire(schema workflowDispatchInputSchema) []*golfv1.WorkflowDispatchInputDefinition {
	definitions := make([]*golfv1.WorkflowDispatchInputDefinition, 0, len(schema.Definitions))
	for _, d := range schema.Definitions {
		w := &golfv1.WorkflowDispatchInputDefinition{Name: d.Name, Description: d.Description, Required: d.Required, Options: d.Options}
		switch d.Type {
		case workflowDispatchString:
			w.Type = golfv1.WorkflowDispatchInputType_WORKFLOW_DISPATCH_INPUT_TYPE_STRING
		case workflowDispatchBoolean:
			w.Type = golfv1.WorkflowDispatchInputType_WORKFLOW_DISPATCH_INPUT_TYPE_BOOLEAN
		case workflowDispatchNumber:
			w.Type = golfv1.WorkflowDispatchInputType_WORKFLOW_DISPATCH_INPUT_TYPE_NUMBER
		case workflowDispatchChoice:
			w.Type = golfv1.WorkflowDispatchInputType_WORKFLOW_DISPATCH_INPUT_TYPE_CHOICE
		}
		if d.Default != nil {
			w.DefaultValue = workflowDispatchValueWire(*d.Default)
		}
		definitions = append(definitions, w)
	}
	return definitions
}

// PrepareWorkflowDispatch returns only exact-source declarations and digests.
// Values never leave this request in a response, journal, browser storage or log.
// This is not an execution preflight, admission receipt or idempotency reservation.
func (s *Server) PrepareWorkflowDispatch(ctx context.Context, req *connect.Request[golfv1.PrepareWorkflowDispatchRequest]) (*connect.Response[golfv1.PrepareWorkflowDispatchResponse], error) {
	credential, err := workflowBrowserToken(ctx)
	if err != nil {
		return nil, rpcError(err)
	}
	m := req.Msg
	key := keyFrom(m.Repository)
	if _, err = repositoryPath(key); err != nil {
		return nil, rpcError(err)
	}
	repo, err := discussionID(m.RepositoryId)
	if err != nil {
		return nil, rpcError(err)
	}
	owner, err := discussionID(m.OwnerId)
	if err != nil {
		return nil, rpcError(err)
	}
	if len(m.ProtoReflect().GetUnknown()) != 0 || !objectID.MatchString(m.CommitId) || !executionWorkflowPath(m.WorkflowPath) || m.WorkflowPath == ".gitlab-ci.yml" || len(m.Inputs) > maxWorkflowDispatchInputs {
		return nil, rpcError(invalid("Prepare parameters using exact repository IDs, a full commit and an Actions workflow path."))
	}
	out := &golfv1.PrepareWorkflowDispatchResponse{}
	err = s.withWorkflowRepository(ctx, s.cookieValue(req.Header()), credential, key, repo, owner, true, func(user User, _ *golfv1.RepositoryAccess) error {
		commit, blob, data, e := s.readWorkflowDefinition(ctx, credential, key, m.CommitId, m.WorkflowPath)
		if e != nil {
			return e
		}
		schema, e := parseWorkflowDispatchInputs(data)
		if e != nil {
			return invalid(errWorkflowDispatchInputDeclaration.Error())
		}
		values, e := workflowDispatchWireValues(schema, m.Inputs)
		if e != nil {
			return invalid(errWorkflowDispatchInputValues.Error())
		}
		// Revalidate the managed session after the native reads and canonicalization.
		// No source, parameter payload or run row is stored by this transaction.
		return s.workflowTransaction(ctx, s.cookieValue(req.Header()), user.ID, func(_ *sql.Tx, _ database.LockManagedSessionRow, _ []byte) error {
			out = &golfv1.PrepareWorkflowDispatchResponse{Repository: &golfv1.RepositoryKey{Owner: key.Owner, Name: key.Name}, RepositoryId: strconv.FormatInt(repo, 10), OwnerId: strconv.FormatInt(owner, 10), NativeActorId: strconv.FormatInt(user.ID, 10), CommitId: commit, WorkflowPath: m.WorkflowPath, WorkflowBlobId: blob, SchemaSha256: schema.SHA256, SubmittedSha256: values.SubmittedSHA256, EffectiveSha256: values.EffectiveSHA256, Definitions: workflowDispatchDefinitionsWire(schema), InputContract: workflowManualInputsContract}
			return nil
		})
	})
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(out), nil
}
