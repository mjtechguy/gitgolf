# Actions run metadata and progress contract

Design and source audit: 2026-10-03. Pipeline runs, standalone coding-agent runs and PR reviews belong in one Actions workspace with distinct kind badges and canonical detail URLs. An agent invocation can also be a real child step of a pipeline. A shared inventory does not imply those execution relationships already exist.

This extends [Actions compatibility](ACTIONS_COMPATIBILITY_IMPLEMENTATION.md), [pipeline execution](PIPELINE_EXECUTION_COMPATIBILITY.md), [runner isolation](RUNNER_ISOLATION_CONTRACT.md), [automation grants](AUTOMATION_GRANTS_CONTRACT.md) and Phase4/5 of the [implementation plan](../GOLF_IMPLEMENTATION_PLAN.md). Both tracks implement the same contract; AI and Cloudflare remain optional. The new mixed read service is in progress, not deployed evidence at this checkpoint.

## What is recorded today

Audited sources: `workflow_runs.go`, `workflow_progress.go`, `agent_tasks.go`, `agent_worker.go`, `reviewers.go`, `internal/runner/agent.go`, `internal/runner/review.go`, generated protobuf and migrations011/020/026/027/031/035/037.

| Area | Persisted current evidence | Exposed / remaining gap |
| --- | --- | --- |
| Pipeline identity | UUID, exact repository/owner IDs, original names, full source commit, workflow path/blob, source archive digest/storage binding, policy epochs, idempotency/input identity | Most source receipts are exposed. Attempt ID and initiating principal are persisted but absent from the existing run wire. Workflow display title/number/commit subject are not durable admission snapshots |
| Pipeline trigger | Manual versus push; exact event ref, durable repository-event ID and independent grant/version/epoch for push | Exposed trigger/ref/event/grant metadata. Sponsor and event actor are distinct; do not infer the triggering actor from the grant sponsor |
| Pipeline lifecycle | State/version, creation/start/finish, worker/attempt/lease, exit code, reason, cancellation flag | Existing run page shows state/timing/worker/results. There is one current attempt, not a qualified rerun history or persisted multi-job graph |
| Pipeline progress/logs | Append-only worker start/finish events, ordered sequence, step index, worker-associated attempt, observed exit, log-sequence boundaries and occurrence time; bounded ordered log chunks | Named single-job steps/timings and snapshot-bound selected-step logs exist. Multi-job/matrix timelines, durable structured annotations/groups/artifacts and timestamped individual log lines remain unimplemented |
| Coding-agent identity | Repository/owner/native initiating user, Golf user, full commit, source archive, selected connection/version, model/reasoning/config and policy fingerprint, original intent | Current wire exposes model/connection/source and worker, but not the attempt or complete admission receipt. Do not put instructions, prompt contents, source archives or credentials in a mixed list query |
| Coding-agent lifecycle/results | State/version, worker/attempt/lease, created/start/finish, bounded final summary/patch/reason, aggregate token integer | No persisted agent tool/event or terminal-log journal exists. The Codex adapter deliberately retains final assistant text and usage rather than raw protocol/command output/reasoning; the reviewer parses its final findings/aggregate usage. Zero in the default token column does not establish a provider reported zero usage |
| PR review | Exact repository/PR/comparison/publication identity, trigger, reviewer revision, task reference, state/reason, findings and native review/publication receipts | Current review wire has creation time, not its own persisted start/finish timeline. A linked private task stays private to its initiator/current writer. Published findings do not grant access to that task's workspace or provider account |
| Live delivery | Authorized repository stream with durable cursor and scoped invalidation; current per-run reads/log continuation; worker lease/presence | Stream invalidation is not an agent log stream. Persisted resumable per-run events, typed child/job identities and an explicit retention/gap contract are required for the expanded experience |

The answer to “is this robust enough?” is **not yet for the full target**. Existing source and authority receipts are useful, but missing structured agent progress, job/attempt history, usage presence and embedded-agent relationships must be implemented and tested rather than filled with UI guesses.

## Common run model

### Identity, display and causality

Every run records an immutable typed identity and repository/owner identity, kind, schema/catalog version and request/trace correlation. Keep the admission identity separate from current display metadata. Capture a safe human title, workflow display name/path and commit subject at admission; retain source blob/tree/archive digests as distinct receipts. Assign human-friendly workflow/run numbers durably if exposed, with explicit scope and rerun-attempt semantics. A current query row position or UUID prefix is not a run number.

Record the requester, native event actor, execution sponsor, assigned worker and publication actor separately, with immutable IDs and bounded display snapshots. A system-triggered run has an explicit system/event principal. Include event/delivery identity, original trigger/ref/full commit, PR/issue IDs and exact candidate/source relationship where applicable. Record policy/grant/credential *version identifiers* and capabilities exercised; never log credential contents or hashed bearer material as public audit metadata.

GitHub's current run API exposes distinctions such as workflow name/display title, branch/commit, event, actor/triggering actor, run number/attempt and timestamps. Golf should preserve useful equivalent concepts through its own admission model, not manufacture GitHub IDs or claim an incompatible API is Octokit-compatible. [GitHub run reference](https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2026-03-10).

### Hierarchy and execution

Persist `run → job instance → step → agent invocation` only when the actual executor creates that relationship. Jobs retain source job key, matrix values, dependency keys and immutable instance identity. Steps retain source ID/index/name/action digest and execution attempt. Standalone agents and PR reviews are top-level typed runs. Existing reviewer-to-task links are genuine relationships; unrelated runs with the same commit are only related observations.

An embedded agent gets an actual parent run/job/step/attempt, exact source binding and separate connection/model/usage policy. Cancellation and revoked admission stop the child; its final result cannot bypass the parent's attempt/result fence. A child result feeds the parent through an explicit contract: review findings, proposal artifact or approved output. Creating a patch does not automatically authorize commit, push, review publication, merge or deployment. Do not silently migrate existing standalone tasks into invented historical job graphs.

Record engine/version, operator runner image digest/tool profile, pool/worker and actual resource/instance identity. Record requested and enforced resource/time/egress ceilings separately from observed use. For Cloudflare, retain provider/resource/attempt IDs only from actual API receipts; the same run identity survives a provider adapter. Worker configuration is not worker liveness, and liveness is not successful execution.

### State, timing and outcomes

Distinguish queued, preparing, running, waiting for a policy approval, finalizing and terminal phases when recorded. Preserve outcome versus effective conclusion (for example `continue-on-error`), explicit failure/refusal/cancellation/timeout/lost/unknown effects, who requested cancellation and whether execution was actually observed stopped. Queue/start/finish times are server observations; retain provider/worker timestamps separately rather than pretending synchronized clocks.

Reruns create explicitly linked immutable attempts and restamp current authority. Worker loss is not automatically retried where a tool, provider or external deployment may already have had an effect. Preserve original intent and unknown outcome; reconnecting a browser only reads/replays observations. Job/step start/finish and status data are also available in GitHub's job reference, but the Golf record requires its own exact worker provenance. [GitHub job reference](https://docs.github.com/en/rest/actions/workflow-jobs).

## Durable progress and logs

Use a versioned append-only event journal with an immutable event key, run/kind/attempt, optional job/step/tool identity, monotonically ordered server sequence, observed timestamp, bounded event type and origin. A retry of the same event must match its content; conflicting duplicates fail. Old attempts and workers cannot update a newer attempt. Current lease/session/sponsor/native policy is checked at event admission and private read/delivery boundaries.

Record lifecycle transitions, engine job/step transitions, safe tool-call start/update/end, approval requested/resolved, bounded plan-status updates, output/artifact references, usage observations and final outcome. Treat engine/harness text and tool payloads as untrusted content. Raw stdout that resembles JSON, an Actions command or a worker event cannot become a trusted lifecycle event. Render Markdown/annotations/diffs through existing safe renderers; no executable HTML or secret-bearing URLs.

Logs have scoped source/channel, ordered chunks, original byte-range or line/timestamp receipts where actually available, explicit truncation and authorized resume cursors. Persist before acknowledging delivery, cap event/log sizes and rate, handle backpressure without blocking execution indefinitely, and expose a retention-gap result rather than pretending expired chunks can be recovered. Private source/task logs retain their original visibility even if a parent run's public status is visible. Do not move private task logs into a repository-wide stream just to make the UI simpler.

ACP can report identified tool-call creation and updates, safe progress/status, file locations, permission requests and terminal references. Map a pinned protocol version into this journal; do not equate a reported tool name with granted capability. Store bounded sanitized tool/terminal observations when enabled, not raw provider payloads, credentials or hidden reasoning. Permission decisions are explicit, scoped and cancellable; replay/resume cannot carry expired approval into a new attempt. [ACP v1 tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls).

The UI offers summary, jobs/steps, live logs and recorded results. Preserve deep links/reload, selected step/job, follow-tail versus paused reading, search of loaded output, safe download and visible reconnection/gap/truncation state. Use actual completed/known step counts; do not invent an overall percentage or ETA for open-ended agent work.

## Usage, outputs and retention

Usage observations identify provider, model, connection/version and invocation/attempt. Represent reporting presence explicitly; aggregate input/output/reasoning/cache tokens only using the provider's declared units and avoid summing already aggregated totals twice. Keep subscription limits/reset observations separate from actual run token use and API billing. Costs are either provider-reported charges or labeled estimates with pricing/version/time/currency; unknown is not zero. Admin policies control budgets, access to shared accounts and allowed models. User/organization/provider details are visible only to their authorized scope.

Retain versioned proposal patches, sanitized review findings, summaries/annotations and artifact manifests with real IDs/digests/size/storage/retention. Distinguish inference success, test success and successful native publication. Link published reviews/checks/deployments only after verified receipts; preserve unknown publication effects without replay. Audit metadata survives configured log/output expiry; expired content is visibly unavailable. Backups/restores include journal/attempt/relationship/object references and invalidate execution/credential/session authority as required by the recovery contract.

## Implementation packets and exit evidence

| Packet | Concrete work | Required qualification |
| --- | --- | --- |
| AM-1 Unified Actions read/navigation | Typed mixed chronological feed, cursor-bound server kind/workflow filters, exact native repository/owner receipts, canonical pipeline/task/review drilldowns and full-page results | Mixed tied timestamps/keyset paging, wrong kind/UUID/ID, route reload, privacy/current-writer denial and late access loss. No expanded private task visibility or write grant |
| AM-2 Complete admission metadata | Persist title/name/number/actor/event/source/catalog snapshots, expose existing attempt IDs, explicit usage presence and metadata-only inventory projections | Real manual and configured push plus user/admin-shared agents; actor versus sponsor difference, rename/recreation, source movement, nullable historical metadata and no secrets/source payload in inventory |
| AM-3 Durable agent progress | Add journal and approved per-harness/ACP adapters, bounded tool/terminal events, resumable delivery, per-channel visibility and redaction | Controlled provider-free protocol fixtures, duplicate/conflicting/out-of-order events, spoofed stdout, split secret redaction, paused reader/backpressure, reconnect/restart/revocation/gaps and attempt fencing; real provider execution only in a separately authorized bounded test |
| AM-4 Engine job/step graph | Integrate qualified maintained engine with durable jobs/matrix/attempt records and structured trusted progress | AC-0–AC-4 graph/conditions/failure/skip/cancel/unknown corpus, independent actual effects and private step-scoped logs; no parser-only compatibility claim |
| AM-5 Embedded agent steps | Explicit first-class agent action/step contract, policy/account/model/budget selection, real parent/child IDs and outputs | A real ordinary workflow with an agent child, policy/fork/credential denials, parent cancel/revoke/worker loss, scoped artifact output and no unauthorized publication. Shell access to an ambient provider token is not this integration |
| AM-6 Retention, scale and recovery | Object-backed outputs, quotas/fairness, event indexes/cursor limits, observability/metrics and coordinated latest-schema recovery | Multiple workers/replicas, bounded fanout/cold start, load/backpressure, retention expiry, exact backup/restore and both portable/qualified CF-hybrid profiles |

Begin with the mixed read/drilldown packet to fix the user's immediate visibility problem. Continue metadata/progress and embedded execution as real implementation work. Shipping the read packet does not close the remaining packets or the overall plan.
