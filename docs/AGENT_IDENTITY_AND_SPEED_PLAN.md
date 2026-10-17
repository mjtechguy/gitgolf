# Agent accounts and a lean, fast Golf: plan

Drafted 2026-10-17 for the owner's review. Nothing here is agreed yet; the open decisions are listed at the end.
Nothing is complete until `docs/IMPLEMENTATION_STATUS.md` records it with runnable evidence.

This plan has two goals:
1. **Agents get their own identity.** Today an agent is a person's API token. An agent should be an account of its own, sponsored by a
   person or an organization, and the rules for agents should follow from that account's kind.
2. **Golf gets lean and fast** on both tracks (hosted Cloudflare-native and local Docker with Forgejo), on the Git side and in the UI.
   Each item below comes from a measurement or a profile, and each phase is measured again before it counts.

Related plans: [AGENTIC_MODE_PLAN.md](AGENTIC_MODE_PLAN.md) (landing at agent speed), [SCALE_OUT_PLAN.md](SCALE_OUT_PLAN.md) (moving work
out of the Workspace Durable Object), [AGENT_ACCESS.md](AGENT_ACCESS.md) (API tokens and MCP), [QUALITY_PLAN.md](QUALITY_PLAN.md) parts
E and F (large lists and views).

## Constraints that apply to every phase

- Forgejo is the only portable backend (ADR 0009). Application features use supported Forgejo APIs and never write Forgejo's database or
  repository files.
- Capability states are honest: a feature that a backend cannot support yet shows as unavailable, not as a mock success.
- Authorization stays explicit. An agent never holds more access than its sponsor, and every check runs at request time, not only when a
  grant is made.
- Hosted migrations are additive (`CREATE … IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN` with a default).
- Hosted deploys run `plan` first. The email login (`[Login]`) and both Access policies (`[ControlAccess]`, `[PreviewAccess]`) must be
  noop, with nothing created, replaced or deleted.
- Private content still hides on denial, sign-out and revalidation, unless the owner explicitly changes that (decision D-5).
- Settings pages lead with the current inventory and explicit Add/Edit actions, using TanStack Form, the shared DataTable and global
  `styles.css` classes.
- Benchmark runs stay short (8 minutes plus the landing window), because they drive the hosted Artifacts bill.

---

## Part 1: Agent accounts

### Why

What exists today:
- Coding agents use a person's API token (`golf_pat_`, `api_tokens`, schema 39). The token can be narrowed to some repositories, `read`
  or `write`, and a branch pattern. It is never more than its owner.
- Agent tasks run with a per-task token (`golf_agent_task_…`) tied to the person who requested the task.
- Agentic mode has no service account. Landings, reverts, comments and issues are credited to the administrator who last saved the
  agentic mode setting (`docs/AGENTIC_MODE.md`, "Accountable account"). Commits carry the fixed identity
  `Golf (agentic mode) <agentic@golf.invalid>` (`land-queue.mjs` `agenticIdentity`).
- `pull_request_origins` records how a pull request was opened: by a person, an API token or an agent task.

What this costs:
1. **Attribution is blurred.** Contribution graphs (CG-1, CG-2), the audit log, blame and the AI impact view cannot cleanly tell a
   person's work from their agents' work. They infer it from token labels and origins.
2. **Agents can't be controlled one at a time.** Stopping one misbehaving agent means finding its token. Changing the owner's account
   (login, email, active state) ends every token at once, including the agents that were behaving.
3. **An agent can't have narrower standing access than its owner,** except by narrowing each token by hand. Nothing stops a new token
   from being broader than intended.
4. **Golf's own automatic actions have no actor of their own.** "The admin who last saved the setting" is a stand-in, and it changes
   meaning when a different admin saves the page.
5. **Policies can't target agents.** Rules like "agents may land docs without a person" or "agents never approve" have no account kind to
   key on. They key on token origin, which a person can also use.

### The model

**An agent is an account of kind `agent`.**
- It is a row in `users` with `kind='agent'`, so every existing authority path applies to it unchanged: grants, `native_identity_versions`,
  API tokens, budgets, audit, the merge and push journals. The new rules are added on top. There is no parallel identity system to keep in
  sync.
- Its details live in a new table, `agent_accounts`: the sponsor, a description, who created it and when, and its state.
- The kind is set when the account is created and never changes. It is never inferred from a login name, a token label or a user agent.

**Every agent has a sponsor**, either a person or an organization.
- **Person-sponsored:** the sponsor manages the agent. It can be granted only repositories the sponsor can currently access, at most at
  the sponsor's role, and never administration.
- **Organization-sponsored:** organization administrators manage it. It can be granted only repositories the organization owns, never
  administration.
- **The cap is checked on every request,** not only when a grant is saved. The repository authority check joins the sponsor's current
  grant: if the sponsor loses access, is demoted or is disabled, the agent loses that access on its next request. This is the same
  committed-revocation guarantee the scale-out work established (`confirmReadFromD1`).
- Disabling a sponsor disables their agents. Deleting a sponsor needs their agents transferred or disabled first.

**The agent lane: what the kind implies.** These rules follow from `kind='agent'`. Nobody has to remember to set them.
- **No interactive sign-in.** An agent account cannot sign in through Access, email codes or local passwords. It authenticates only with
  its own tokens. The browser UI shows its activity, but an agent never holds a browser session.
- **Never administrator.** Grants with role `admin` are refused for agents at write time, and the authority check also treats an agent
  `admin` grant as `write`, for defense in depth.
- **Its own branch space by default.** A new agent token gets the write branch pattern `agent/<agent-login>/*` unless the sponsor sets
  another one explicitly. Protected branches, rules and code owners apply as they do for people.
- **Budgets per agent.** `agent-budgets.mjs` already charges by subject. The agent account becomes the subject, so one agent's burst does
  not use up its sponsor's budget for other agents.
- **Its pull requests go through the land queue,** under the repository's agentic policy. Whether they land without a person stays a
  repository decision (`repository_agentic_settings`). The account kind decides who is an agent; the repository decides what agents may
  do there.
- **Its approvals don't count by default.** An agent can comment and request changes, but its approval does not count toward required
  approvals unless the repository's rules explicitly allow agent approvals (decision D-4).
- **A real commit identity.** Commits it writes through the Source API, merges and reverts use `<display name> <login@agents.HOST>`.
  Commits it pushes keep the author the client wrote, and the push journal records the agent account.

**Golf's own system agent.**
- One built-in agent account per installation, `golf`, sponsored by the installation. It replaces "the admin who last saved the setting"
  as the actor for agentic landings, reverts, the comments and issues Golf writes, and agent branch cleanup.
- Accountability is unchanged: the policy's authority is still the administrator who saved the setting and still holds administration
  (`policyGuard`), and the journals record that administrator as the policy owner. The actor changes, not the authority.

**People acting through tools keep working.** A person's `golf_pat_` token stays exactly as it is today: a person working through
Claude Code, Codex or an editor plugin is still that person. Agent accounts are for software that acts on its own: CI-style bots,
long-running coding agents, scheduled automations and agent hosts.

### Data model (schema 56, additive)

```sql
ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'person' CHECK(kind IN ('person','agent','system'));
CREATE TABLE IF NOT EXISTS agent_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  sponsor_kind TEXT NOT NULL CHECK(sponsor_kind IN ('user','organization','installation')),
  sponsor_id INTEGER NOT NULL,            -- users.id, native_owners.id, or 0 for the installation
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','DISABLED')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_accounts_sponsor ON agent_accounts(sponsor_kind,sponsor_id,user_id);
```

- `ALTER TABLE … ADD COLUMN` with a constant default is additive in SQLite and D1. Schema detection (`installation.mjs` `schemaTables`)
  keys on `agent_accounts`.
- `pull_request_origins.kind` gains `agent_account`, and the contribution and impact reads group by `users.kind`.
- The portable track (Go server, PostgreSQL) gets the same columns in its own migration, and the Forgejo mapping below.

### Forgejo (portable track)

- Each Golf agent account needs a matching Forgejo account, created and changed only through Forgejo's admin API, never its database.
- **Spike first (A-0):** check what Forgejo 15.0.9's API supports. Can a bot or restricted user type be created and kept from signing in
  interactively? Can it hold collaborator grants, and can it be turned off with "prohibit login"? Record the answer before building.
- If Forgejo has no suitable account type, the fallback is an ordinary Forgejo user with login prohibited, marked as an agent by Golf. The
  agent lane is then enforced by Golf, which brokers all Git and API access.
- Until the mapping is built and tested, the portable track shows the capability `agents.accounts` as unavailable, with its reason.

### Phases and tasks

**A-0. Decisions and spike (small).**
- Record the owner's answers to decisions D-1 to D-4.
- Run the Forgejo account-type spike above and write the result into this plan.
- Check every place that assumes a user is a person: email-only lookups, profile pages, notification delivery, the account menu, the
  `/agents` view, and `users.email UNIQUE` (agents have no email; null is allowed).

**A-1. Schema and authority (Cloudflare-native first).**
- Migration 0056: the column, table and index above. Update `release.mjs`, `release.test.mjs`, `schema.sql` and the schema detection.
- Repository authority (`authorizedRepository`, `confirmReadFromD1`, `resourceAuthority`, the push and Source API guards): for
  `kind='agent'`, also require the sponsor's current grant at or above the agent's role, and treat `admin` as `write`.
- Refuse `admin` grants for agents in `SetRepositoryCollaborator` and organization team management.
- Refuse any interactive sign-in for agent and system accounts (Access identity mapping, local accounts).
- Tests: the cap on grants, demoting the sponsor between two requests, disabling the sponsor, an organization sponsor losing ownership of a
  repository, and an `admin` grant refused.

**A-2. Agent tokens.**
- Tokens for an agent are created by its sponsor (or an organization administrator) from a signed-in browser session, as for people.
- The default write branch pattern is `agent/<login>/*`. A broader pattern must be chosen explicitly and is audited.
- Token format: decision D-1 (keep `golf_pat_`, or a distinct `golf_agt_` prefix for secret scanning).
- Budgets keyed by the agent account.
- Tests: scope, branch pattern, budget isolation between two agents of one sponsor, and revoking one agent leaving the others working.

**A-3. Attribution.**
- `pull_request_origins` kind `agent_account`. Merge and push journals already record `user_id`, which is now the agent.
- Source API and merge commits use the agent's commit identity.
- Contribution graphs and AI impact split by `users.kind`: people, agents, and Golf's system agent.
- Audit entries show "agent `<login>` (sponsored by `<sponsor>`)".

**A-4. Golf's system agent.**
- Create it at migration or first maintenance (`kind='system'`, sponsor `installation`).
- Land queue, reverts, comments, issues and branch cleanup act as it. The policy guard keeps the saving administrator's authority.
- Update `docs/AGENTIC_MODE.md` "Accountable account".

**A-5. UI.**
- **Account settings → Agents** (person-sponsored) and **Organization settings → Agents**: the current inventory first (name,
  repositories, last active, state), then Add agent, Edit, Disable and Tokens. Built with TanStack Form and the shared DataTable.
- **Repository collaborators:** agents appear with an "Agent" badge and their sponsor. The role picker for an agent has no Admin option.
- **Pull requests, commits, timelines and the `/agents` view:** an "Agent" badge, and the sponsor on hover.
- **Policies:** branch rules and agentic settings can name "agents" as a class (for example "agents may land `docs/**` without a
  person").

**A-6. Portable track (Go server and Forgejo).**
- The same schema in PostgreSQL, the Forgejo account mapping from A-0, and the same authority and sign-in rules in the Go server.
- Real-database tests and a served drill with an agent account doing clone, push and open pull request through the managed Git path.

**A-7. Migration and rollout.**
- Existing tokens are unchanged. Nothing is converted automatically.
- Document "when to create an agent account versus use your own token" in `docs/AGENT_ACCESS.md`.
- Hosted: migrate, deploy, then create one demo agent and run the S7 bench loop with it, checking attribution in contribution graphs and
  the audit log.

**Acceptance for part 1:**
- An agent account can do everything the current S7 loop does (Source API commit, open a pull request over MCP, land), and every
  record names the agent.
- Revoking or disabling one agent does not affect its sponsor or the sponsor's other agents.
- Demoting the sponsor removes the agent's access on its next request (tested on hosted).
- No agent can hold administration, sign in interactively, or exceed its sponsor.

**Risks:**
- Places that assume every user is a person with an email. A-0 lists them; the tests cover each one.
- The Forgejo mapping may not be clean. The capability is shown as unavailable on that track until it is.
- Org-sponsored agents and transfers between organizations are the hardest case, and can wait for a later slice if needed.

---

## Part 2: Hosted Git and agent speed

Evidence: [benchmarks/2026-10-17-write-holds](benchmarks/2026-10-17-write-holds/README.md). After #171 and #172, at about 110 agents,
every push and Source API commit succeeded and all 180 agent pull requests landed (p50 5.8 s). These items are what remains.

### B-1. Open pull requests and CI reports outside the Workspace queue (largest remaining win)

**Why.** `CreatePullRequest`, MCP `open_pull_request`, `ReportCheck` and `CreateIssueComment` still run as exclusive requests in the
single Workspace Durable Object. In run `r3` their admission wait was p50 6.0 s and p95 18.0 s, the Workspace probe peaked at 20.4 s,
and the one failure of the run was an `open_pull_request` "could not be confirmed".

**What not to do again.** The `admission-overlap` branch (2026-10-15) reclassified these writes so they overlapped *inside* the
Workspace. Within eight minutes the object saturated and the whole demo stopped answering. The lesson: these writes must run outside
the object, in the stateless Worker, as pushes and Source API commits now do (S2).

**Design.**
- **IDs without a queue.** `collaboration.mjs` `nextId` takes `max(id)+1`, which only works while the Workspace serializes the writes.
  Retry the batch on `UNIQUE constraint failed` with a fresh ID, up to five times with jitter. The overlap branch measured this: five
  concurrent creates failed 4 of 5 without the retry and all succeeded with it.
- **Atomic "one open pull request per branch pair".** Today it is a read followed by an insert. Move it into the guarded insert, either
  with a new table `open_pull_heads(repository_id, base_branch, head_branch)` under a unique index (inserted with the pull request,
  deleted when it closes or merges) or with a trigger. MCP mints a fresh idempotency key per call, so without this a retried call could
  open a duplicate.
- **Discussion numbers.** `number = max(number)+1` per repository has the same race. It gets the same retry.
- **Comments on one discussion.** Concurrent comments bump `discussions.revision`, and that conflict currently becomes a 412. Retry the
  revision bump instead.
- **Routing.** `public.mjs` `statelessRoute` sends these RPCs and MCP tools to `core.mjs` in the Worker. After the write, the Worker calls
  the Workspace's `writeSettled` RPC (webhooks, email, live activity, CI), as S2 does. `mcpClass` stops classing them as `exclusive`.
- **Authority.** Each guarded insert already carries the grant, identity and credential checks, so a committed revocation fences the
  write without queue order.

**Tasks.**
1. ID and number retry, with tests (concurrent creates of issues, pull requests, comments and checks on an in-memory D1 with real
   `UNIQUE` failures).
2. The atomic open-pull-request constraint (migration 0057, additive), with a race test.
3. Route the four writes and the two MCP tools to the Worker. List every side effect `dispatch` ran in its `finally` and add a test that
   each still happens.
4. Measure at 30, then 60, then about 110 agents. Abort if the home page takes over 5 s or 5xx come in a burst. Roll back at once if the
   Workspace probe rises instead of falling.

**Acceptance:** at about 110 agents, `open_pull_request` and CI report p95 under 3 s, the Workspace probe p95 under 1 s, no
"could not be confirmed", and no duplicate open pull requests.

### B-2. Tell agents when something happens instead of making them poll

**Why.** S7 agents poll `get_pull_request` until their pull request lands: 4,447 polls in one 8-minute run (`r2`), 822 in `r1`.
Every poll is a request, a D1 read and a confirmation. Most answer "no change".

**Design.**
- A new MCP tool, `wait_for_pull_request(number, until, timeout)`. `until` is one of `landed`, `checks_done`, `changed` or
  `needs_action`, and `timeout` is at most 60 s. It returns as soon as the state matches, or with the current state at the timeout.
- It is served from the repository's activity stream (`RepositoryActivity`), which already publishes pull request and check changes,
  so the wait holds no D1 polling loop. The access check runs before the wait and again before answering.
- Agents running their own server can use outbound webhooks, which already exist.

**Tasks:** the tool, its access checks, MCP docs, and the bench S7 loop switched to it. Measure the requests per landed pull request
before and after.

**Acceptance:** requests per landed pull request drop by at least 10×, and landing latency doesn't rise.

### B-3. Retry a busy landing in seconds, not minutes

**Why.** A land refused because the repository was busy ends `FAILED` and is retried after 10 minutes (`docs/AGENTIC_MODE.md`). In
`r2`, 30 landings failed this way and waited for the sweep.

**Design.** A busy refusal goes back to `QUEUED` with `next_attempt_at` set 5 to 20 s ahead (jittered), up to a bounded number of
times. A settled write (`writeSettled`) triggers `landSoon` for that repository. Real refusals (`NEEDS_REBASE`, a failed check,
`BLOCKED`) are unchanged.

**Acceptance:** no landing waits more than 30 s because of a busy repository.

### B-4. Land several pull requests in one provider write

**Why.** Artifacts drops the ref status when too many receive-packs hit one repository at once ("no ref status", seen up to five
attempts in a row). Every landing is a receive-pack to the base branch, so landings compete with each other and with agent pushes.

**Design.**
- When several pull requests are ready to land on one base, the land queue merges them in sequence in memory: each gets its own merge
  commit, chained on the previous one. It then sends one receive-pack that moves the base to the last commit.
- Each pull request keeps its own merge commit, so reverting one on a failed check still works per pull request.
- If any merge in the chain conflicts, that pull request drops out of the batch and gets `NEEDS_REBASE`, and the rest continue.
- The batch size is bounded (for example 8) and the merge journal records every pull request in the batch.

**Acceptance:** at about 110 agents, fewer provider writes per landed pull request and fewer unknown outcomes, with per-pull-request
revert still passing its tests.

### B-5. Fewer and nearer database calls

**Why.** Each D1 call from the stateless Worker took about 100 ms, against about 20 ms from the Workspace, because the Worker runs where
the request lands and D1's primary is in `ENAM`. A clone makes 5 to 6 calls.

**Design.**
- **Fewer calls:** combine the actor lookup, grant check and token guard into one query, or one `batch`, per request. Count D1 calls per
  route in `Server-Timing` so the gain can be measured.
- **Nearer calls:** turn on Smart Placement for the forge Worker. The Alchemy Worker resource does not expose `placement` yet. Either add
  it upstream, or apply it in `scripts/cloudflare_alchemy_demo.py` after deploy through the Workers settings API, and verify that the
  next `plan` still shows Access noop and does not undo it.

**Acceptance:** clone and `ls-remote` p50 down by at least 30 % from `r3` (clone 2.0 s, `ls-remote` 1.1 s).

---

## Part 3: Local (Docker with Forgejo) speed

The local track has not been benchmarked with the agent mix yet. Measure first, then fix what the measurements show.

### C-1. A local benchmark

- Run `scripts/agent_speed_bench.mjs` against the canonical Compose installation (`golf-forgejo`) with the same scenarios at 4, 16 and 64
  agents, with tokens created through the supported API.
- Record the same table as the hosted runs.

### C-2. The managed Git concurrency limit (known suspect)

- `internal/server/git_transport.go` allows at most **four** managed Git operations per server process (`managedGitBuffers`). A fifth
  concurrent clone, fetch or push is refused at once with "storage unavailable"; it does not wait.
- Requests and responses are fully buffered in memory (`io.ReadAll` with a limit).
- The likely fix:
  - let a request wait for a slot up to a deadline instead of failing at once;
  - size the limit from a memory budget (configurable, with a sane default);
  - stream upload-pack responses to the client while counting bytes against the limit, instead of buffering them.

  Keep the authority readback the buffering exists for: a push is confirmed before the response.
- **Acceptance:** at 16 agents, no "storage unavailable" refusals, and memory stays inside the configured budget.

### C-3. The path to Forgejo

- Check connection reuse to Forgejo (`http.Transport` idle connections per host), the PostgreSQL pool size for both databases, and how
  many Forgejo API calls one Golf request makes.
- Check Forgejo settings that matter for many writers: the queue type, cache, and Git garbage collection timing. Change only settings
  Forgejo documents.
- Fix what the C-1 numbers point at; leave the rest.

---

## Part 4: UI speed (both tracks)

Evidence: QUALITY_PLAN parts E and F, and the production bundle.

### D-1. A smaller first download

**Why.** The production entry chunk is 570 KB (160 KB gzipped). The generated API client chunk is another 366 KB, because every service's
generated code ships together. Every first visit downloads and parses both before showing anything.

**Tasks.**
1. Measure: `vite build` bundle report, and first contentful paint and time to interactive at 4× CPU and a slow 4G profile, for the home
   page, a repository page and a pull request.
2. Split the generated code per service so a page loads only the services it calls.
3. Load admin, Actions, settings and other rarely used routes lazily. Check that nothing heavy (Markdown, syntax highlighting, charts) is
   in the entry chunk.
4. Set a budget in a test, for example entry chunk under 250 KB raw, so it doesn't grow back.

**Acceptance:** the entry chunk at least halved, and first contentful paint measurably faster on the three pages.

### D-2. One reactions request per conversation, not per comment

**Why.** A 300-comment conversation makes 301 reactions requests (part F).

**Design.** A batched read: the reactions for every comment on one page of a discussion, in one RPC, implemented on both tracks (the
forge and the Go server through Forgejo's API). Comment rows read from that one query.

**Acceptance:** one reactions request per page of comments. The 300-comment first render measured again.

### D-3. Render each comment's Markdown once

**Why.** Markdown is about 3 ms per comment, most of a long conversation's first render (part F).

**Design.** Memoize rendered Markdown by a hash of its source text, in memory only. The cache is cleared together with the query cache on
sign-out, denial and actor change, so it follows the same privacy rules as the data it came from.

### D-4. Highlight diffs off the main thread, in place

**Why.** Syntax colors arrive in a second full render that rebuilds every hunk's rows. A 100-file diff takes 2.8 s in production until
its colors are in (part F).

**Design.** Run the highlighter in a Web Worker that returns token ranges per line, and apply them to the rows already mounted, file by
file as they come into view.

### D-5. Show unchangeable content at once (owner decision)

**Why.** Private pages refetch, and hide their data while they do, on every visit. That is deliberate (no private content is shown
before access is checked again), and it is the main reason navigation feels slower than GitHub's.

**Option.** Content addressed by an exact commit or blob can never change. It could be shown at once from memory while access is checked
again in the background, and hidden if that check fails. This narrows the rule from "never show before re-checking" to "show
unchangeable content you were just allowed to see, for at most one request round-trip". `privateNavigationQuery` already does this for
source navigation after a fresh access receipt. This option would widen it. Decision D-5.

### D-6. Development-build first render (optional)

The development build's first render of a 1000-row directory or a 500-row list is still one long task (StrictMode and React's development
checks). If it keeps timing out tests under load, mount rows in chunks after the first screenful. This is not windowing: every row still
ends up in the page, so find-in-page and screen readers keep working.

---

## Order and dependencies

| Order | Item | Size | Depends on |
| --- | --- | --- | --- |
| 1 | A-0 decisions and Forgejo spike | S | owner answers |
| 2 | B-1 pull requests and checks outside the Workspace | L | none |
| 3 | A-1 to A-4 agent accounts, Cloudflare-native | L | A-0 |
| 4 | B-3 busy landings retried in seconds | S | none |
| 5 | B-2 `wait_for_pull_request` | M | none (better after B-1) |
| 6 | D-1 bundle | M | none |
| 7 | C-1 and C-2 local benchmark and Git concurrency | M | none |
| 8 | A-5 agent accounts UI | M | A-1 |
| 9 | D-2 batched reactions, D-3 Markdown cache | M | none |
| 10 | B-4 batch landing | L | B-1, B-3 |
| 11 | B-5 fewer and nearer D1 calls | M | Alchemy placement support, or a post-deploy step |
| 12 | A-6 agent accounts on the portable track | L | A-0 spike, A-1 |
| 13 | D-4 off-thread highlighting, D-6 | M | none |
| 14 | D-5 | S | decision D-5 |

Items in parts 2 to 4 that share no files can run in parallel, with disjoint file ownership as AGENTS.md requires: for example B-1
(forge collaboration and routing), D-1 (web build) and C-2 (Go server) together.

## How each phase is verified

- **Unit and integration tests:** `node --test cloudflare/forge/*.test.mjs`, `node --test web/tests/*.test.ts`,
  `go test ./internal/...`. New tests fail on `main` where a behavior changes.
- **Browser tests:** the affected Playwright specs at `--repeat-each=3`, and the full suite before merging a change to shared components
  (QUALITY_PLAN Q-3).
- **Hosted:** plan with Access noop, migrate if needed, deploy, then the bench mix at 30, 60 and about 110 agents, with the abort
  criteria. Results go in a dated `docs/benchmarks/` README and in `IMPLEMENTATION_STATUS.md`.
- **Local:** the C-1 benchmark before and after, and the recovery drill (`scripts/recovery-smoke.py`) after any schema change on the
  portable track.
- **UI:** production-build measurements at 4× CPU, median of 5, old and new alternated, as in QUALITY_PLAN parts E and F.

## Decisions for the owner

- **D-1. Token prefix for agent accounts.** Keep `golf_pat_` (the owner's kind decides the lane; nothing else changes), or add
  `golf_agt_` (clearer in logs and secret scanning, but every token parser and scanner must learn it). Recommendation: keep `golf_pat_`.
- **D-2. Can a repository administrator grant an agent access its sponsor lacks?** Recommendation: no. The sponsor cap is the core
  guarantee; to widen an agent, widen its sponsor or use an organization-sponsored agent.
- **D-3. Organization-sponsored agents in the first slice, or later?** Recommendation: in the first slice for the Cloudflare-native
  track, because team automations are the common case. Transfers between organizations come later.
- **D-4. Do agent approvals count toward required approvals?** Recommendation: not by default. A branch rule can allow it per
  repository.
- **D-5. Show unchangeable private content at once while access is re-checked?** Recommendation: yes for commit- and blob-addressed
  content only, hidden the moment the re-check fails. This is a privacy trade-off, so it is the owner's call.
- **D-6. Benchmark budget.** How many hosted 110-agent runs per phase are acceptable for the Artifacts bill. Recommendation: one before
  and one after each of B-1, B-2, B-4 and B-5.
