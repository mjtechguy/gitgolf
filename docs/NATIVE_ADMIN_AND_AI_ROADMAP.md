# Cloudflare-native administration, AI features and remaining work

Agreed with the owner on 2026-10-14. This is the working roadmap for the
Cloudflare-native backend after the day's feature work; `docs/IMPLEMENTATION_STATUS.md`
records what has actually shipped and been verified. Nothing here is complete until
its entry there says so.

The goal behind it, in the owner's words: the hosted demo should have "everything
on" and "integrate as many Cloudflare services as possible to show the power".
Capability states stay honest; nothing is mocked.

## 1. Administration: a GitHub-style policy hierarchy

### Decisions

- Policy flows down: **operator allocation ∩ installation policy ∩ organization
  policy ∩ repository choice ∩ dependencies**. Every refusal names the level that
  decided.
- An installation administrator chooses, per feature, **Disabled everywhere**,
  **Allowed** (organizations and repositories may enable it) or **Enforced** (on
  everywhere; repositories cannot turn it off). Organizations can only narrow the
  installation's choice. Public repositories can never be enforced.
- Repository administrators turn features on or off in a **Features** section on
  repository settings, like GitHub's Settings → General → Features. A disabled
  feature disappears from the repository's tabs and settings, and the server
  refuses its requests and background work. Turning a feature off keeps its data.
- **Deploy-time operator approvals become editable in the product** for the policy
  that lives inside infrastructure the deployment already created. Creating
  infrastructure stays a deploy step. The deployed value is the default and, where
  it is a security or cost bound, the ceiling.
- The admin pages must look very good: a summary band and grouped cards first,
  human labels instead of capability ids, one heading per page, long tables last.

### Editable approvals

| Approval | Stays a deploy step | Editable in the product | Bound |
| --- | --- | --- | --- |
| Webhooks | encryption key | destination origins; daily limit | origins re-validated; never the installation's own hosts, Access or private hosts; ≤ 32 origins; ≤ 5,000 a day |
| Email | send binding, sending subdomain, sender | on/off; daily limit | sender fixed; ≤ 5,000 a day |
| AI review advice | AI binding, AI Gateway caps | on/off | only where AI was admitted at deploy |
| Agent proposals | container, approved file path | on/off | — |
| Agent and workflow paths | stay a deploy step (they are part of the signed execution policy) | — | — |
| Previews | preview Worker, origin, Access app | default lifetime; concurrency | ≤ operator lifetime; ≤ 4 slots |
| Anonymous rate limiting | binding with fixed numbers | on/off | — |
| Daily run admissions | queue and workflow | lower only | deploy value is the ceiling |

Guardrails: changes need an operations administrator signed in through Access (API
and service tokens can read, never change); writes are revision-fenced with
receipts; widening changes need a typed confirmation and a recent sign-in; every
change is written to an append-only installation audit log; a deploy-time
`policy_editing: false` returns all authority to deploy steps. Each setting states
whether a change affects queued, in-flight or only new work.

What a stolen installation-admin session newly allows: adding a webhook
destination, enabling AI or agents (sending private source to Workers AI up to the
gateway caps), raising email and webhook limits, turning rate limiting off, and
switching features off everywhere. It cannot exceed provisioned infrastructure,
enforce public repositories, read secrets or erase the audit log.

### Slices

| # | Slice | State on 2026-10-14 |
| --- | --- | --- |
| 1 | Installation overview for administrators: every allocated service and setting with current values (never secrets), operations fixes, dead admin links removed | shipped |
| 2 | Editable installation approvals and the installation audit log | shipped |
| 3 | Feature policy model at installation scope, enforcement at every gate, `/admin/features` | shipped (hosted acceptance pending) |
| 4 | Repository Features section; issues, pull requests and merge gates | shipped (hosted acceptance pending) |
| 5 | Organization policies (narrow only) | planned |
| 6 | Organization secrets inherited by selected repositories | planned |
| 7 | Organization webhooks (no contract exists in either runtime) | deferred |

## 2. Workers AI features

All AI runs through the installation's private AI Gateway (authentication required,
no prompt logging or cache, 60 requests a minute, a 500-cent daily spend limit).
AI output is advisory and treated as untrusted: nothing is published, merged or
labelled without a person acting. Each feature sits under the feature policies
above and the editable "AI on/off" approval.

| Feature | Cloudflare product | State on 2026-10-14 |
| --- | --- | --- |
| Agent proposals: OpenCode in a container edits the approved file and runs its tests | Workers AI `@cf/zai-org/glm-5.3-flash`, Containers, Artifacts forks | shipped (moved from `glm-4.7-flash` to `glm-5.3`, then `glm-5.3-flash`, on 2026-10-14) |
| Review advice: one constrained question about the next review step | Workers AI `@cf/cloudflare/clef` | shipped |
| Clef recommendation card on the pull request page | existing stored advice | shipped (hosted acceptance pending) |
| Pull request summary and review draft from the bounded diff, edited and published by a person through the existing review contracts | Workers AI text generation | shipped (hosted acceptance pending) |
| Issue triage: label suggestions from the repository's own labels | Workers AI `@cf/cloudflare/clef` | shipped (hosted acceptance pending) |
| Release notes draft from merged pull requests since the previous tag | Workers AI text generation | shipped (hosted acceptance pending) |
| Semantic search over code and issues, filtered by the reader's current access | Workers AI embeddings, Vectorize | shipped (hosted acceptance pending) |
| AI usage in the admin portal (`/admin/ai-usage`): Golf's own run ledger by feature, model and day against the daily AI limit; AI Gateway analytics (requests, tokens, cost estimate, last 24 h) as a separate panel that stays degraded, with its reason, until a live read succeeds; no claim about remaining allowance | Golf ledger in D1, AI Gateway analytics (GraphQL) | shipped (gateway dataset unverified live; hosted acceptance pending) |
| Model selection per AI use case (`/admin/ai`, repository settings): an administrator picks the default and the allowed models for agents, summaries and review drafts, release notes and search embeddings from a dropdown fed by the account's Workers AI catalog, inside the deploy list `AI_MODELS`; advice and triage keep Clef; repositories choose from the allowed list only where the administrator allows overrides; every AI run and agent proposal records the model used | Workers AI model catalog | shipped (catalog property ids unverified live; hosted acceptance pending) |
| AI run foundation (`ai_runs`, `AiWorkflow`, `/native/ai`): one gateway call per run, gated and rate-limited, shared by the features below | Workers AI, AI Gateway, Workflows | shipped (no feature uses it yet) |
| Further candidates to evaluate: test failure explanation from the masked log, merge commit message suggestion, documentation Q&A | Workers AI, AI Search | candidates |

### Choosing the model in a new AI kind

Every AI kind reads its model through one helper, `aiModel(db, env, use, repositoryId)` in
`cloudflare/forge/src/ai-models.mjs`. It returns `{ model, source, note }`, where source is
`fixed` (Clef), `repository`, `installation` or `deploy`, and throws a 412 when nothing usable is
allowed. A kind in `aiKinds` names its use case (`use: 'review-drafts'`, `'release-notes'`,
`'search'`; `'agents'` is bound into the agent policy identity by `withAgentModel`) instead of a
fixed `model`; `/native/ai` then records the effective model on the run, and prepare and infer
refuse, unbilled, a run whose model is no longer allowed (`aiModelStillAllowed`). The search
index treats a stored model that differs from `aiModel(..., 'search', ...)` as a rebuild and keeps
serving the old generation until the new one completes. New use cases are added to `aiUses` and
to the deploy list `ai_models` in `forge.json`.

Coding agents on Cloudflare sandboxes and on machines users connect (agent hosts, SSH,
Tailscale, Workers VPC), the credential vault and the built-in automation library
(PR reviewer, triage, Issue → PR, CI fixer, improvement loops and more) are planned
in [AGENTS_AND_AUTOMATIONS_PLAN.md](AGENTS_AND_AUTOMATIONS_PLAN.md). Model selection
per use case becomes engine selection there; phase 2a built it ([ENGINES.md](ENGINES.md)).

## 3. Remaining capability work

From the second scoping pass, still to build on the native backend:

- **Browser writes**: branch and tag create/delete, then file create/edit/delete and
  batches, reusing the Worker-built pack path the merge slice proved on Artifacts.
- **Repository lifecycle**: archive first, then delete (Artifacts deletion from a
  Worker is unverified). Rename and transfer have no contract and are not planned.
- **Wiki** (a second Artifacts repository, after browser writes), **protected
  merge** (branch rules that require approvals), **advanced reviews** (inline and
  draft reviews), **teams**, **API credentials**.
- Inbound email (Email Routing) for replies; Queues as email/webhook transport.
- Not possible honestly: SSH deploy keys (Workers accept no inbound SSH).

## 4. Known open problems

- Cloudflare delivers no Cron Trigger events to this account (a throwaway Worker
  with its own one-minute trigger received none in 25 minutes). Maintenance runs
  from the workspace Durable Object's alarm instead; the cause is Cloudflare's to
  diagnose.
- Resolved 2026-10-14: the Operations analytics feed failed inside the Worker because
  Workers reject `fetch` with `redirect: 'error'`. With `manual` it reports live Worker
  requests, errors and subrequests on the retained installation (#51).
- `mj/merge-probe` is a scratch repository on the retained installation and stays
  until repository deletion exists.
