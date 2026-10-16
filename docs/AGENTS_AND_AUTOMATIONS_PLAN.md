# Coding agents and automations: plan

Agreed with the owner on 2026-10-14. This plan covers running coding agents and AI
automations from Golf, on Cloudflare or on machines the user connects. Nothing here
is complete until `docs/IMPLEMENTATION_STATUS.md` says it has shipped and been
verified. The Workers AI features already underway (review drafts, triage, release
notes, search, model selection) are covered in `docs/NATIVE_ADMIN_AND_AI_ROADMAP.md`.
They become the "Cloudflare model" engine described below.

Order changed on 2026-10-14: after phase 1a, the agentic mode track in
[`AGENTIC_MODE_PLAN.md`](AGENTIC_MODE_PLAN.md) runs before phase 1b and phase 2,
which build on its Source API, API tokens and landing path.

The owner's goal is full flexibility. Golf ships many ready-made tools: code review
in the style of Greptile, issue triage, and loops that look for improvements and
open pull requests. Each tool can be pointed at any target and run on any engine,
whether that is a Cloudflare model or a coding CLI such as Codex.

## Decisions (owner, 2026-10-14)

1. Connected machines come first. They can be reached two ways: an outbound Golf
   host process, or SSH, which is secure without Tailscale. Tailscale is also
   wanted.
2. Users may use their own subscriptions (ChatGPT, Claude, SuperGrok and so on),
   signed in through OAuth or device code. Administrators can also provide API keys
   at installation level and at organization level.
3. A machine shared with other users may run their tasks under its owner's signed-in
   tools, but only if its owner chose to share it.
4. Each task gets its own working copy. Docker per task is not required.
5. Private-network reach supports both Tailscale and Cloudflare Workers VPC / Mesh.
6. Golf ships a library of built-in automation tools, each of which can be pointed
   at targets and engines.

## Concepts

**Engine** — what does the thinking:
- *Cloudflare model*: Workers AI models (GLM, Clef, embeddings) through the private
  AI Gateway.
- *Provider model*: OpenAI, Anthropic, xAI or Google APIs through AI Gateway, using
  a user, organization or installation key.
- *Coding CLI*: OpenCode, Codex, Claude Code, Grok Build, Antigravity (`agy`) or
  Muse Code, running headless (`opencode run`, `codex exec`, `claude -p`,
  `grok -p`, `agy -p`, `muse exec`), together with the credential it uses.

**Place** — where a coding CLI runs:
- *Cloud sandbox*: one Cloudflare Container per task (Containers / Sandbox SDK),
  built from an image with the CLIs installed.
- *Agent host*: a machine running the Golf host process (an agent mode of
  `cmd/golf-native-runner`). It polls Golf outbound and works behind NAT.
- *SSH host*: a machine Golf connects to over SSH. No Golf software is installed on
  it; the CLIs are already installed and signed in. It can be reached directly, or
  through Tailscale, or through Cloudflare Tunnel / Workers VPC / Mesh.

**Credential vault**:
- Each user's subscription sign-ins (token files) and API keys are encrypted with
  envelope encryption, using a key in Secrets Store.
- Organization and installation API keys are added by administrators.
- A policy controls who may use which credential, on which engine, and in which
  place.

**Automation** — a built-in tool or a custom one:
- **Trigger**: an event (pull request opened or updated, issue opened, CI failed,
  review requested, push, release), a schedule or loop, a manual request, or an
  inbound webhook.
- **Target**: repositories, an organization, or all repositories, filtered by
  branch and path.
- **Engine and place**: as defined above.
- **Instructions**: a versioned prompt, editable.
- **Output policy**: a comment, a review with inline comments, labels, an issue, a
  draft pull request, or a report.
- **Limits**: a budget per day, concurrency, maximum open pull requests,
  de-duplication, and a kill switch.
- **Approvals**: draft pull requests only, a person must publish, and the
  automation never merges unless the policy explicitly allows it.

**Task**: one run of a coding CLI in one place. It records its log stream, the
proposal branch, the cost and tokens, the tool version and model, and the
credential that was used (by label, never by value).

## Security

- **Cloud sandbox with API keys:** the sandbox never sees the key. Model calls leave
  through Golf's outbound proxy, which adds the key and routes through AI Gateway
  with per-user caps. Egress is allowlisted to the provider, the package registries
  and Golf.
- **Cloud sandbox with a subscription sign-in:** the token file is mounted for one
  task only and the refreshed token is written back afterwards. Each credential
  runs one task at a time, under a Durable Object lock, because refresh tokens
  rotate. Use is limited to the credential's owner, or to people its owner shared
  it with, and the UI labels it clearly.
- **Agent hosts and SSH hosts:**
  - The task uses a separate working copy.
  - It fetches source and pushes a proposal branch with a short-lived token scoped
    to the task.
  - The host's own credentials never leave the host.
  - For SSH, Golf generates one key pair per host. The private key is encrypted in
    the vault and the user installs the public key. Golf pins the host key and
    shows its fingerprint for confirmation, and a dedicated user account on the host
    is recommended.
- **Access control:** a host is personal, or shared at organization or installation
  scope with allowed users, teams, repositories and tools. Sharing a subscription
  through a shared host is the owner's explicit choice.
- **Automation output is untrusted.** Golf neutralizes it before display, sends
  every output through the existing review contracts, and merges nothing
  automatically.
- Every automation, engine and place sits under the feature-policy hierarchy
  (installation, then organization, then repository).

## Built-in automation library (first set)

| Tool | Trigger → output | Engines that fit |
| --- | --- | --- |
| PR reviewer (Greptile/CodeRabbit style) | PR opened or updated → summary plus inline comments, using the whole codebase through semantic search; re-reviews new pushes; learns from dismissed comments | Cloudflare model or provider model; a coding CLI for deep mode |
| Issue triage | issue opened → labels, duplicates (Vectorize), priority, suggested assignee, "needs info" request | Clef plus embeddings |
| Issue → PR | "Assign to agent" on an issue → draft PR that implements it, with tests | coding CLI |
| CI fixer | workflow run failed → diagnosis from the masked log, then a fix PR | coding CLI |
| Review-comment resolver | reviewer asks for changes → commits that address them, for the author to accept | coding CLI |
| Improvement loop | schedule → scans for bugs, performance, dead code and missing tests → at most N small draft PRs, de-duplicated against past findings | coding CLI |
| Dependency updater (Renovate style) | schedule → upgrade PRs with changelog notes and passing tests | coding CLI |
| Security sweep | schedule or push → secrets, vulnerable dependencies (OSV), risky code → issues and fix PRs | provider model plus coding CLI |
| Docs sync | merge → README and docs updated to match the code; release notes drafted | Cloudflare model |
| Merge conflict resolver | PR becomes conflicted → rebase proposal | coding CLI |
| Flaky test detective | repeated CI results → flaky-test report and quarantine PR | Cloudflare model |
| Preview reviewer | preview deployed → screenshots and accessibility audit through Cloudflare Browser Rendering → comment | Browser Rendering plus vision model |
| Codemod across many repositories | manual, pointed at an organization → one PR per repository | coding CLI |
| Ask the codebase | chat in the repository → answers with cited files and lines | Cloudflare model plus Vectorize |
| Gardener | schedule → stale issues and PRs nudged or closed, following the policy | Cloudflare model |

Users can copy any built-in tool and change its instructions, engine, place, target
and limits, or create a custom automation from scratch.

## Phases

1. **Connected machines and "Assign to agent":**
   - an agent mode for the host process;
   - SSH hosts reached directly;
   - host registration, access control and the inventory (tools installed, signed-in
     state, current task);
   - adapters for Codex, Claude Code and OpenCode;
   - "Assign to agent" on issues and pull requests;
   - proposal branches with a live log.

   **Status (2026-10-15): phase 1a hosted. Phase 1b (SSH hosts) is hosted and verified: Claude Code on an SSH host reached through Tailscale took an issue to a proposal branch.**
   Phase 1b is described in [SSH_HOSTS.md](SSH_HOSTS.md), schema 47:
   - SSH hosts are agent hosts that Golf reaches itself, with the same sharing, admission, task states and protocol;
   - Golf generates a sealed Ed25519 key per host;
   - the host key is pinned only after a person confirms the fingerprint a connection test reported;
   - Golf dispatches each task to an `SSHAgentTask` container running `golf-agent-host ssh-run`.

   It needs the deploy changes listed in that document.
2. **Engines, credential vault and the automation framework:**
   - engines, the credential vault (user subscriptions and keys, organization and
     installation keys) and engine selection, which replaces per-use-case model
     selection;
   - automation definitions, triggers, targets, outputs and limits;
   - the first built-in tools: PR reviewer, issue triage, Issue → PR, CI fixer.

   **Status (2026-10-16): phase 2a (engines and the credential vault) hosted and verified** (see IMPLEMENTATION_STATUS, 2026-10-15 "Hosted checks: agent tasks on MCP, automations, vault, engines"; provider-model reasoning effort #121).
   [CREDENTIAL_VAULT.md](CREDENTIAL_VAULT.md) and [ENGINES.md](ENGINES.md), schema 45:
   - user, organization and installation API keys, and stored subscription sign-ins, under envelope encryption with explicit grants;
   - engine selection at installation, organization and repository level, replacing per-use-case model selection;
   - provider models (OpenAI, Anthropic, xAI, Google) through the AI Gateway binding;
   - the `listEngines` / `resolveEngine` / `runChat` interface for the automation framework.

   Using a subscription sign-in waits for cloud sandboxes (phase 3).

   **Status (2026-10-16): phase 2b (the automation framework) hosted and verified:** PR reviewer, Issue → PR, CI fixer and Clef ran on the hosted demo (2026-10-15). Review tasks (#124) let a coding CLI review a pull request read-only under its own sign-in.
   [AUTOMATIONS.md](AUTOMATIONS.md), schema 46:
   - definitions at repository, organization and installation scope, with triggers (events and Durable Object alarm schedules),
     targets, engines, places, versioned instructions, outputs, limits, a kill switch and audit;
   - the built-in PR reviewer, issue triage, Issue → PR and CI fixer, plus custom automations;
   - model automations run through the engines registry or the installation's Workers AI selection; coding-CLI automations run as
     agent tasks on agent hosts;
   - output is always neutralized and a draft for a person, and nothing is merged.
3. **Cloud sandboxes:**
   - a Sandbox image with every CLI installed;
   - an egress proxy that adds the API key and routes through AI Gateway;
   - subscription token mounting with refresh write-back;
   - Grok, Antigravity and Muse adapters wherever a headless credential exists.
4. **Loops and the rest of the library:** improvement loop, dependency updater,
   security sweep, docs sync, conflict resolver, flaky tests, preview reviewer,
   codemods, Ask the codebase, gardener.
5. **Private networks:**
   - Tailscale: an ephemeral, tagged auth key per sandbox, Tailscale SSH and tailnet
     ACLs;
   - Cloudflare Tunnel / Workers VPC / Mesh for SSH hosts on private networks.

   **Status (2026-10-16): reach for SSH hosts verified on hosted over all four paths:** direct, Tailscale, Cloudflare Tunnel (`cloudflared access ssh` with an Access service token) and Workers VPC (#123, the DO bridge waits for the listener).
   See [SSH_HOSTS.md](SSH_HOSTS.md#reach):
   - **Tailscale:** an ephemeral node per task, in userspace networking, with a sealed auth key and tags;
   - **Cloudflare Tunnel:** `cloudflared access ssh`, with an optional Access service token;
   - **Workers VPC:** a Durable Object bridge to a `vpc_networks` binding. It reports itself unavailable until the binding
     exists, and has not been tried against a real VPC network.

   Tailscale for cloud sandboxes waits for phase 3.

## Open items to verify while building

- Whether each provider's terms allow a personal subscription to run in a hosted
  sandbox. Show the terms beside the sign-in, and refuse where it is not allowed.
- Grok Build, Antigravity and Muse Code headless behaviour and credentials. These
  were checked only against third-party write-ups so far.
- Whether a Cloudflare Container can reach SSH hosts through Workers VPC TCP, or
  whether Tunnel or Tailscale inside the container is needed.
  - Answered from the docs on 2026-10-15 (see [SSH_HOSTS.md](SSH_HOSTS.md#decision-ssh-runs-inside-a-container-not-in-the-worker)).
    A Container has no Workers VPC binding and no outbound TCP interception. A Worker
    or Durable Object has `vpc_networks` `connect()` for plaintext TCP.
  - Golf therefore bridges `getTcpPort().connect()` to the VPC socket in the Durable
    Object.
  - Tunnel and Tailscale inside the container are the documented paths.
  - Still to verify on a hosted installation.
- Cron Triggers do not fire on this account, so schedules use Durable Object alarms,
  as maintenance already does.

## Contribution graphs and AI impact

**Status (2026-10-16): not started; next (CG-1 and CG-2 first, on the hosted demo).**

Asked for on 2026-10-14: GitHub-style contribution graphs for people, and the same for
agents overall and for each individual agent, to show how much AI helps.

### Rules

- **Counts, not claims.** Show what happened (commits, pull requests merged, reviews,
  proposals accepted) and what it cost. Do not show "hours saved" or productivity
  multiples; any comparison (for example time to merge) is labelled as a comparison,
  not as an effect.
- **Attribution has tiers, and each is labelled:**
  1. *Golf agent* — Golf itself created the commit or branch (an agent proposal or an
     automation pull request). Verified from Golf's own records.
  2. *AI-assisted* — a person assigned or ran an agent and then merged the result.
     The person is the contributor; the AI is shown as assisting.
  3. *Declared* — the commit carries a `Co-Authored-By` trailer naming a known AI
     tool. Declared by the author, so shown separately and never counted as verified.
  4. *Unlabelled* — everything else. Never asserted to be human-written.
- **Access first.** A viewer sees counts only for repositories they can read. A person
  may choose to show private-repository activity on their profile as anonymous counts,
  as on GitHub. Feature policy id `contribution-graphs` (installation, organization,
  repository).

### Data

- A daily rollup table in D1, `contribution_days`, keyed by (day, actor, repository,
  kind, ai_tier) with a count. D1 stays authoritative because every read needs an
  access check; Analytics Engine can hold anonymous installation-wide aggregates only.
- Kinds: commit, pull request opened, pull request merged, review, issue opened, issue
  closed, comment, agent proposal created, agent proposal accepted.
- Written when the event happens (merge, issue, review, proposal) and backfilled from
  first-parent Git history by the existing `indexes` maintenance stage, in paced
  batches, so a new installation fills in over a few cycles.
- Agent identity is recorded on each task (tool, model, place, credential label, cost
  from `ai_runs` and gateway analytics), so per-agent pages are queries, not guesses.

### Views

- **Person (profile page and "Your activity"):** a 12-month heatmap, year picker,
  streaks, a per-day panel naming repositories and events, and a toggle that overlays
  AI involvement (a second hue for AI-assisted days, never replacing the human count).
- **Agents overall (installation and organization admin):** share of merged pull
  requests with AI involvement over time, proposals created and accepted (acceptance
  rate), reviews with findings that were acted on, CI pass rate of proposals, cost per
  accepted proposal, and an AI activity heatmap.
- **One agent, tool or automation:** its own page with the same graph for what it
  landed, runs and outcomes, tokens and cost, models used, per-repository breakdown and
  the most common failure reasons.
- **Repository pulse:** AI share and acceptance rate for that repository.

### Slices

| # | Slice | Depends on |
| --- | --- | --- |
| CG-1 | `contribution_days`, writers, Git backfill, person heatmap (human activity only, GitHub parity), profile privacy choice | — |
| CG-2 | AI attribution tiers (Golf-agent commits, trailers), AI overlay, installation "AI impact" page from today's agent proposals, review advice and AI runs | CG-1 |
| CG-3 | Per-agent, tool and automation pages with cost and outcomes | Agents plan phases 1–2 |
| CG-4 | Repository and organization rollups, CSV export | CG-2 |

Charts follow the dataviz guidance (one palette, accessible in light and dark, a
data table behind every chart).
