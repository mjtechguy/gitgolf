# Managed agents088

This packet connects ACP to the existing managed task worker, private conversation, account owner and ordinary Actions coordinator. AI remains optional. No provider inference, execution job, new service/capacity or Cloudflare resource is attributed to its qualification.

## Managed conversation

`AgentControlService` is cookie-session-only. A global `GetAgentControl({})` returns a fresh configured worker/image/version receipt, never execution authority. Selected reads and commands bind the original task/attempt and current owner/repository identity. Only the original still-current browser session can reply, decide permission, cancel a turn, resume or finish; repository administration and inspection credentials acquire no other user's conversation authority.

The worker uses the existing approved image allowlist, source normalization, labeled cleanup, resource ceilings, seccomp profile and isolated workspace. ACP pins native1.18.34 from the actual configured no-model receipt and requires the exact task-image qualification, the native `golf-workspace` mode and selected native model before the first prompt. Native mode/model changes fail closed. Sequential replies and negotiated `session/resume` stay inside the original live process/container and native cache. Neither transcript loading nor a worker restart restores a lost workspace. Restart, timeout, lease loss, account/policy/source-authority change or unknown transport acknowledgement ends the attempt without replay.

New durable command metadata references the existing encrypted conversation content inventory and binding, so key rotation and accounting retain the existing domain. A command UUID is immutable; it transitions once from queued to claimed before handoff. Re-reading its original receipt never sends it again. A separate immutable native-send digest is committed before every prompt/reply/cancel/resume/permission dispatch. Failed/lost acknowledgements stop the adapter. No command text, reasoning, tool arguments or credentials enters shared Actions logs.

Completed ACP text is projected only after an actual native-cache checkpoint and credential screening. The final journal retains its existing whole-attempt screening. ACP `usage_update` measures context-window occupancy, so it is never invented as cumulative token usage. Supported native `opencode export SESSION` supplies completed assistant usage, bound to the exact session/model and checked against the inherited token budget. Missing/malformed usage fails closed. A completed provider turn can exceed its budget before that receipt arrives; positive monetary limits remain refused. Unnegotiated reasoning variants are refused.

File requests are limited by native policy to the workspace; shell, external files, Git/configuration paths, plugins, MCP and subagents are denied. Native file-tool qualification is independently recorded and stays false in production startup. Real pending requests can be rejected/cancelled. With a separate accepted file-tool receipt, only an exact native `allow_once` option is eligible; persistent permission is never granted. The UI exposes safe request/tool IDs without private file bodies or arguments. Native file-tool/sandbox execution qualification is a separate release gate from initialized protocol and resolved policy observations.

## Ordinary Actions steps

The new explicit catalog `golf.workflow.act.v0.2.89.linux.agents088.v1` accepts one built-in literal action:

```yaml
- id: advice
  uses: golf/agent@v1
  with:
    prompt: Inspect the original source and propose a small improvement.
```

The existing catalogs retain their refusal. The prompt is bounded to2048 bytes; provider/account overrides, expressions, composite nesting and push admission are unavailable. The coordinator additionally requires `GOLF_RUNNER_ACTIONS_AGENTS088=1`, verified TLS and the new catalog. Current selected native account/model, manual usage at every required scope, connection use grants, budgets and worker capability are independently required; Actions authorization does not grant agent authority.

The maintained native step producer emits `agent_requested` only after the exact native job and step start receipts. Source stdout remains a log and cannot manufacture that frame. The coordinator blocks that step until the original parent-bound private child succeeds. Failure/lost acknowledgement cancels execution and never acknowledges a successful step. No enrollment key, attempt capability or provider cache enters its ordinary job shell.

The immutable child link binds original parent attempt/job/step, source archive digest, commit, repository, owner and initiating user/session. Admission, worker lease/observations and result publication recheck current parent policy, resource/source approval, lease/cancellation and agent authority. Repeated polls inspect the same original child. This initial step prepares a separately reviewed proposal from the original pinned source; it does not consume previous job workspace changes or apply a patch. Current-source value approval/broker catalogs and typed inputs are not widened by this catalog. Own-user child links lead from the workflow's shared inventory to its private task. Other parent readers cannot inspect those children.

## Recovery and qualification

Recovery retains commands, encrypted content, native send receipts and child links. Before workers resume, close every nonclosed control (increment revision), clear permission IDs/options, mark every queued command claimed and clear copied ACP worker presence (`acp_image`, `acp_version`, `acp_file_tools`). Existing task/lease/provider/session quarantine also applies. Closure and claims cannot be reopened. Fresh reenrollment does not revive an old attempt or dispatch a retained command.

Runnable source checks:

```sh
go test ./...
go -C engines/act test ./...
GOLF_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:45472/postgres?sslmode=disable go test -race ./internal/server -run 'TestAgentControl|TestAgentConversation|TestWorkflowAgent088'
npm --prefix web run build
cd web && ./node_modules/.bin/playwright test --config playwright.agent088.config.ts agent-controls088.spec.ts agent-task-events.spec.ts agent-tasks.spec.ts --workers=1
```

The deterministic test runs a real credential-free duplex subprocess through the managed command/journal consumer. It proves reply, permission decisions, native resume, finish, one-shot claims, credential screening, closure and authority denial; it is not provider inference. Real PostgreSQL tests bind a genuine parent/child journal, reject changed source/job identity, revoke native account use independently of Actions and deny a cancelled parent. The agent catalog explicitly refuses every retained execution-value broker binding at preparation and publication before taking any approver lock; the outer agent guard owns the initiator lock. Its child publication fence uses the ordinary placement→worker→pool lock order; a real worker-lock wait and concurrent versioned pool edit must refuse the child after release. Final private child reads also recheck both native repository and owner identity against the original run. Browser tests run under StrictMode and verify no duplicate commands, unknown acknowledgements, current authority loss, late receipts and320px permissions.

Run `python3 scripts/agent-acp088-initialize-proof.py --managed-policy --output /absolute/receipt.json` to repeat the existing-worker probe.

The separate existing-worker no-model native probe observes actual protocol-v1 initialization/session negotiation under cleared environment and removed own scratch. Current worker image `sha256:c33ee151ca443f691c74568d1459c5768f32a5c5fad49b4606cfd4ee0414be72` reports native1.18.34. Its configured probe actually resolves the file-only policy and advertises `golf-workspace` plus the locally selected exact native Go model. This worker image is distinct from the configured task/review image; neither receipt establishes native task resource/sandbox/file-tool execution, real provider usage/renewal, full recovery, served deployment or all-harness acceptance. The original2-GiB execution reserve and separate qualified-image release gates remain.

Primary protocol references: [ACP session setup/configuration](https://agentclientprotocol.com/protocol/v1/session-config-options), [ACP schema and usage semantics](https://agentclientprotocol.com/protocol/v1/schema), [native OpenCode CLI](https://opencode.ai/docs/cli/), [native permission policy](https://opencode.ai/docs/permissions/).

Follow-up local validation: focused PostgreSQL controls/conversation/parent authority checks passed (23.693s); final focused workflow/control authority race checks passed (9.550s), including retained broker refusal and changed connection/image generations; browser controls and legacy manual tasks passed nine cases (15.3s), including unqualified file requests exposing rejection only.

The schema091 local rollout now repeats qualification in the actual approved task image under network-none, with no model prompt: native1.18.34 initializes a session and resolves the configured policy. The [runtime profile receipt](../.tmp/priority091-final/resource-and-agent-profile.json) records its digest and `acp_file_tools=false`. Production Allow once remains withheld; this is not file-tool execution or provider inference. The retained runner/engine is unchanged and the first-party agent Actions catalog remains disabled. [Matching source/runtime/served evidence](IMPLEMENTATION_STATUS.md#portable-priorities087091-deployed-bounded-consumers-2026-10-06) qualifies deployed handlers and metadata boundaries separately from these release gates.
