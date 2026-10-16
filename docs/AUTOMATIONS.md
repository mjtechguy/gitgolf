# Automations (Cloudflare native)

Status: phase 2b of [AGENTS_AND_AUTOMATIONS_PLAN.md](AGENTS_AND_AUTOMATIONS_PLAN.md), verified locally (node tests and a real
workerd/D1/Durable Object/Workflows check). On hosted (2026-10-15), all four built-in tools ran on real events:
- issue triage on Clef;
- the PR reviewer on GLM 5.3, both `default` and named;
- Issue → PR with Claude Code on an agent host;
- the CI fixer with Claude Code on an agent host.

Custom automations and provider-model engines are not yet hosted-verified. See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md). Schema 46 (`migrations/0046_automations.sql`). Code:
`cloudflare/forge/src/automations.mjs`, `src/automation-engines.mjs`, `src/automation-tools/`.

An automation is a built-in tool or a custom one, pointed at a scope, run by events, a schedule or a person, on an engine, with an
output policy and limits. Its output is untrusted: Golf neutralizes it, labels it as automated, writes it only through the existing
contracts (comments, labels, private review drafts, issues, draft pull requests, agent tasks) and never merges anything.

## Definitions

| Field | Meaning |
| --- | --- |
| scope | `repository` (managed by its administrators), `organization` (its owners) or `installation` (operations administrators). Writers of a repository, and organization members, read their scope's inventory. |
| tool | `pr-reviewer`, `issue-triage`, `issue-to-pr`, `ci-fixer` or `custom`. Creating from a tool copies its defaults; every field can then be changed. |
| enabled | Off when created. Turning it on needs at least one event or a schedule. Run now works while it is off. |
| kill switch | An emergency stop with no version check: queued runs are skipped, running agent tasks are cancelled, work in flight is discarded, and no new run starts until it is released. |
| trigger | `{ events: [...], schedule?: { everyMinutes: 15–10080 } }`. Events: `pull_request.opened`, `pull_request.updated`, `pull_request.review_requested`, `issue.opened`, `pipeline.failed`, `push`. Each tool accepts a subset. |
| target | Organization and installation automations list repositories (`owner/name`, none = every repository in scope). `branches` and `paths` are glob patterns (the agentic-mode matcher): a pull request's base branch, the pushed branch, or the branch an Actions run ran on; paths match the files a pull request or push changed. |
| engine | `default` (AI runs: the engine selection for the use case, by default the Workers AI model in AI models), an engine id from [Engines](ENGINES.md), or a coding CLI (`codex`, `claude`, `opencode`, `grok`). |
| place | `cloud` for model engines; `agent-host` (with a host) for coding CLIs. SSH hosts are agent hosts, so they are chosen as an `agent-host` too. `cloud` for a CLI is refused: cloud sandboxes are phase 3. |
| instructions | Up to 4,000 bytes, versioned (`automation_instructions`); every change is a new version and old versions stay readable. |
| output | `comment`, `review` (a private review draft), `labels`, `issue`, `draft-pr`, `report` (kept on the run). |
| limits | `perDay` 1–500 started runs, `concurrency` 1–10 running at once (the rest wait), `maxOpenPRs` 1–50 open draft pull requests (for `draft-pr`), `dedupeWindow` 0–10080 minutes (0: a dedupe key runs once forever; otherwise once per window). |
| approvals | Always draft pull requests. `allowLanding` (off by default) opens them ready for review only where agentic mode is on, so that the repository's landing policy decides; a draft always needs a person. |

**Who an automation acts as:** the person who last saved or turned it on. A manual run acts as the person who pressed Run now. That
person's grant, the `automations` feature policy and the limits are checked again when each run starts and again before its result is
applied; a person who lost access makes the run `REFUSED`, and nothing is written.

## API

`POST /native/automations/read` (concurrent reads) and `POST /native/automations` (changes). Every body names
`scope` plus `repository` and `repositoryId`, or `organization`.

| Action | Route | Fields | Answer |
| --- | --- | --- | --- |
| `list` | read | — | `{ scope, canManage, featureOn, featureReason, automations, inherited, inheritedTruncated, tools, engines, enginesRegistered, hosts, places }`. `inherited`: the organization and installation automations reaching a repository (targets every repository in scope or names this one, filtered before the limit), read-only, by scope then name; `inheritedTruncated` when more than both scopes' bound (200) match. |
| `get` | read | `id` | `{ automation (with instructions), instructionVersions }` |
| `instructions` | read | `id`, `version` | `{ version, text, createdBy, createdAt, current }` |
| `runs` | read | `automationId?` | `{ runs, truncated }`, newest 50. A repository sees every run on it. |
| `create` | change | `tool` and any definition field | `{ automation }` |
| `update` | change | `id`, `expectedVersion`, changed fields | `{ automation }` |
| `setEnabled` | change | `id`, `expectedVersion`, `enabled` | `{ automation }` |
| `killSwitch` | change | `id`, `engaged` | `{ automation }` |
| `delete` | change | `id` | `{ ok }` |
| `run` | change | `id`, `target: { repository?, kind: issue / pull_request / pipeline_run / repository, number? / runId? }` | `{ run }` |

A run is `{ id, automationId, automationName, tool, repository, trigger, target: { kind, number, commit, url }, state, phase, reason,
engine, place, instructionsVersion, requestedBy, usage, outputs, createdAt, startedAt, finishedAt }`. States: `QUEUED`, `RUNNING`,
`SUCCEEDED`, `FAILED`, `SKIPPED`, `REFUSED`, each with a reason. `usage` holds token counts and cost exactly as the model or the agent
host reported them, or null. `outputs` holds references (AI run, agent task, comment, pull request and issue numbers with links, labels)
and bounded, neutralized text (the review summary and findings, the report).

**Audit:** category **Automations**: `automation.create`, `.update`, `.delete`, `.enable`, `.disable`, `.kill_switch`,
`.release_kill_switch`, `.run`, at the scope the request names. Rows hold the tool, name, events, engine, place, outputs and limits, and
whether the instructions changed, never their text. Runs are their own record (`automation_runs`).

**Feature policy:** `automations` ("Automations", group Automation), in the installation → organization → repository hierarchy, allowed
by default. Off: no event queues a run, creating, turning on and running are refused with the policy's reason, and queued runs are
refused when they start. It is the installation-wide kill switch.

**Capability:** `automations`, ready at schema 46.

## Events and schedules

`emitAutomationEvent(env, event)` is called where Golf records each event, and queues one run per matching automation. It never fails
the request that caused it; in the Workspace it runs after the response (`waitUntil`) and asks for a pass.

| Event | Recorded at |
| --- | --- |
| `issue.opened`, `pull_request.opened` | `core.mjs`, after `CreateIssue` / `CreatePullRequest` |
| `pull_request.review_requested` | `core.mjs`, after a `SubmitPullReviewRequest` that took effect |
| `push` | `core.mjs` (a confirmed Git push) and `source-api.mjs` (Source API commits and branches, landings and reverts) |
| `pull_request.updated` | derived from a push to the head branch of open pull requests (at most 10) |
| `pipeline.failed` | `pipelines.mjs`, when a run finishes `FAILURE` (in the PipelineRun object) |

- **Dedupe:** each run has a unique `dedupe_key`: the automation, the tool's key (a pull request head, an issue, an Actions run, a
  push) and, with a dedupe window, the window. A replayed request, the same head pushed again or a schedule meeting an event finds
  the run already queued.
- **No loops:** what automations write never emits events, so one automation's output never triggers another. The CI fixer also skips
  failures on agent proposal branches (`golf-agent/…`).
- **Schedules:** Cron Triggers do not fire on this account, so the Workspace's maintenance alarm (every 5 minutes, the `indexes` stage)
  sweeps due automations: one run per target repository (at most 50) per due slot, then the next slot. A scheduled PR reviewer queues
  reviews of open pull request heads it has not reviewed (five per run); a scheduled triage queues open issues without labels; a custom
  automation reads the repository's open work. The sweep also skips runs not started within a day and fails waits that never end (AI
  runs 20 minutes, engine calls 15 minutes, agent tasks 3 hours).

## Runs

1. **Start** (Workspace write queue, `processAutomations`, ten per pass): the checks above, then the tool's `start`. A model tool on
   `default` admits an AI run as the acting person (quotas, gateway, usage and the engine selection of ai-workflow.mjs). A registry
   engine stores the prepared input. A CLI tool creates an agent task on the automation's host with the automation's instructions,
   through `/native/agent-tasks`' own admission rules and prompt.
2. **Wait:** a settled AI run, or a finished agent task, triggers another pass (and the maintenance alarm catches anything left).
   Registry engine calls run outside the queue (`inferAutomationRuns`, one `runChat` each).
3. **Apply:** the tool writes its outputs as the acting person, with operation keys derived from the run so a retried pass never
   writes twice.

## Built-in tools

| Tool | Events | Engines | Outputs |
| --- | --- | --- | --- |
| PR reviewer | `pull_request.opened`, `.updated`, `.review_requested`, schedule | model or coding CLI | `review`: the AI review-draft contract (ai-review.mjs). On `default` it is the acting person's AI review draft on the pull request, which they edit and publish as their own pending review; the run keeps the summary and findings. `comment`: the neutralized review text. One run per head; a head that moved on is skipped. **On a coding CLI** (for example Claude Code under its own OAuth sign-in on an agent host or SSH host) it is a read-only review task ([AGENT_HOSTS.md](AGENT_HOSTS.md#review-tasks-schema-48)). The tool's final text is posted as the `comment`, the only output for a CLI, because there are no structured findings for a draft. |
| Issue triage | `issue.opened`, schedule | model (Clef on `default`) | `labels`: only the single label Clef chose with a probability of at least 0.5 (or a registry engine's first label). `comment`: suggestions, possible duplicates from semantic search when the repository has a served index (score ≥ 0.82, at most 3; otherwise it says the check is unavailable) and a request for details when the description has fewer than 30 characters (a rule, not a model judgement). Needs an admin as acting person, as AI triage does. |
| Issue → PR | `issue.opened` | coding CLI on an agent host | `draft-pr` from the task's proposal branch into the default branch (origin `agent-task`), `comment` on the issue. No changes or a failed task opens nothing. |
| CI fixer | `pipeline.failed` | coding CLI on an agent host | The tail of each failed job's log (stored with secrets masked; Golf credentials masked again) goes into the task instructions. A failure on an open pull request's head (a run the pull request started, or a push or manual run on its head branch) is fixed against that branch (`comment` posts the excerpt); one on the default branch first opens an `issue` with the excerpt (the agent task needs an issue). Other branches are skipped. Then `draft-pr`. |
| Custom | any | any | Model: `report`, `comment` or `issue` from the instructions and the event's issue or pull request (or the repository's open work), through the AI kind `automation` on `default`. CLI: `draft-pr` from an agent task on the event's issue or pull request. |

All model input from repositories is wrapped in untrusted markers; all output is neutralized (no links, images, HTML or mentions)
and headed "Automation **name** (tool) wrote this. It is automated and unverified". Log excerpts are shown in a code fence longer
than any backtick run in them.

## UI

Repository Settings → Automations, Organization settings → Automations, Admin → Automations: the inventory first (shared DataTable)
with the enable toggle and the kill switch, New automation from a built-in tool (TanStack Form), Edit with the instructions history,
Run now, and the runs table with outcomes, tokens and costs as reported. Automation output is shown as plain text.

## Deploy changes needed

None. Schema 46 must be applied (`migrations/0046_automations.sql`, replay-safe). Automations use the existing Workspace alarm, AI
workflow, agent hosts and pipeline bucket; no new bindings.

## Not done

- Hosted evidence for custom automations and for provider-model engines (OpenAI, Anthropic, xAI, Google).
- Coding CLIs in cloud sandboxes (phase 3). SSH hosts take automation tasks as agent hosts; the separate `ssh-host` place value is still refused.
- Stored `coding-cli` engines from the engines registry are not offered; CLI automations name the tool and the agent host.
- Inline review comments: the native forge has no inline review comments, so findings are `path:line` bullets, as in AI review drafts.
- Learning from dismissed comments, the rest of the library (phase 4), inbound webhook and release triggers.
- Installation administrators without a grant on a repository cannot be the acting person there: runs are refused with the reason.
