# Execution policy ceilings

Policies are durable Golf authorization ceilings, independent of native repository permissions, registered capacity and supported workflow syntax. An allow result does not provision a worker, obtain a credential or execute a job. Current runnable proof belongs in [implementation status](IMPLEMENTATION_STATUS.md).

## Scope and event

Each scope stores repository eligibility (`disabled`, `all`, or selected immutable repository/owner bindings where supported), exact workflow paths or explicit all-workflows, independent `manual_dispatch_enabled` and `push_allowed` switches, and revision/revocation epoch. Repository scope cannot use the selected-repositories mode. Missing policies and empty explicit workflow selections deny.

Personal repositories require both instance and repository ceilings; organization repositories also require the organization ceiling. Every required scope must allow the exact repository, owner, workflow and event. A lower scope cannot expand a higher ceiling. Owner transfer, selected-owner mismatch, missing/duplicate scope, disabled mode and unknown event kinds deny. Only exact `manual` and `push` event kinds are recognized.

`manual_dispatch_enabled=true` never implies push permission; `push_allowed=true` never implies manual permission. Both default false for new scopes. Migration018 adds false to existing policies and historical events because those older policies never granted push execution. No bootstrap or UI initial state enables automatic execution.

Native repository read/write/admin observation and immutable owner/organization binding remain separate admission requirements. Instance administrator status does not impersonate native repository authority. Policy changes are authorized by current Golf instance administrator, native organization owner, or native repository administrator at their corresponding scope; exact current authority and immutable scope observations are revalidated around native waits. Native edits can race Golf transactions; this is not cross-provider atomic CAS.

## Mutation and fences

`GetExecutionPolicy` returns the current `push_allowed` value alongside policy/authority revisions. `UpdateExecutionPolicy` includes explicit `push_allowed`; omission is false, never inheritance. Settings must send their reviewed current value on every full policy update. Policy writes retain cookie/Origin authorization and deny read-only bearer credentials.

The existing update transaction locks the current caller and policy, requires expected policy/authority revision, replaces selections, increments revision and revocation epoch, and appends an actor event including both event switches. Failure to append the event rolls back the switch, selection, revision and epoch. Concurrent same-revision writes admit one winner. Historical push permission cannot be silently lost on downgrade: migration018 down refuses when any current policy or historical event has `push_allowed=true`.

`readEffectiveExecutionPolicy` remains a manual-only compatibility helper. Automatic admission and every automatic runner/result fence must use `readEffectiveExecutionPolicyForEvent(..., "push", workflowPath)` explicitly. It reads required scopes in fixed instance/organization/repository order inside the caller's transaction and returns exact policy revision/epoch stamps. Captured stamps must match at later fences; a switch edit cannot leave earlier automatic grants silently valid.

## Implementation and qualification bounds

This slice implements the independent durable switch, wire field, actor audit and event-aware ceiling calculation. It does not by itself implement push parsing, webhook processing, durable automation credentials, queue materialization, automatic worker authority or real coding agents. Those integrations follow [local automation implementation](LOCAL_AUTOMATION_IMPLEMENTATION.md). Native event receipt and manual worker readiness are not automatic execution readiness.

Local checks cover default deny, independent switches, per-scope denial, unsupported events, exact paths and immutable selected-owner bindings. PostgreSQL checks cover default columns, event-specific admission and revocation stamps, real policy RPC persistence/receipt, same-revision concurrency, stale/native/session denial and actor-event rollback. Record actual command/image/native results in the implementation ledger before marking automatic execution qualified.
