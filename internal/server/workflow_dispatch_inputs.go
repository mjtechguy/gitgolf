package server

import "github.com/mjtechguy/golf-git/internal/workflowinputs"

const (
	maxWorkflowDispatchInputs      = workflowinputs.MaxCount
	maxWorkflowDispatchInputBytes  = workflowinputs.MaxValueBytes
	maxWorkflowDispatchInputsBytes = workflowinputs.MaxMapBytes
	workflowDispatchString         = workflowinputs.String
	workflowDispatchBoolean        = workflowinputs.Boolean
	workflowDispatchNumber         = workflowinputs.Number
	workflowDispatchChoice         = workflowinputs.Choice
)

var (
	errWorkflowDispatchInputDeclaration = workflowinputs.ErrDeclaration
	errWorkflowDispatchInputValues      = workflowinputs.ErrValues
)

type workflowDispatchInputType = workflowinputs.Type
type workflowDispatchInputValue = workflowinputs.Value
type workflowDispatchInputDefinition = workflowinputs.Definition
type workflowDispatchInputSchema = workflowinputs.Schema
type workflowDispatchInputValues = workflowinputs.Values

func parseWorkflowDispatchInputs(data []byte) (workflowDispatchInputSchema, error) {
	return workflowinputs.Parse(data)
}
func validateWorkflowDispatchInputs(schema workflowDispatchInputSchema, values []workflowDispatchInputValue) (workflowDispatchInputValues, error) {
	return workflowinputs.Validate(schema, values)
}
func canonicalWorkflowDispatchNumber(value string) (string, error) {
	return workflowinputs.CanonicalNumber(value)
}
func workflowDispatchDigest(domain string, value any) string {
	return workflowinputs.Digest(domain, value)
}
