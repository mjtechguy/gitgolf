# Cloudflare agent runtime qualification

The fixed-role qualification below is an operator-controlled, disposable CF2 proof. The maintained runtime is in `cloudflare/agents`; the live phase is `scripts/cloudflare_agents.py`, called by the existing foundation runner. It does not grant Cloudflare execution to Golf tenants or replace Golf's task/result authority. The separate [native PR agent setup](CLOUDFLARE_NATIVE_SETUP.md#operator-approved-native-pr-agents) now implements admission through current native repository authority and reuses this controller. The [native reviewer UI](CLOUDFLARE_NATIVE_SETUP.md#access-login-and-native-reviewer-ui) adds current-authority context/report inspection and explicit comparison of two same-source proposals. Source/local/native build and hosted evidence are recorded independently in the status ledger. Tested proposal integration, protected canonical publication and complete product acceptance remain open.

Run the local checks and build the native image from the repository root:

```sh
make cloudflare-check
npm ci --ignore-scripts --prefix cloudflare/agents
docker build --platform linux/amd64 --provenance=false -f cloudflare/agents/Dockerfile -t golf-cf-agent:qualification .
python3 scripts/cloudflare-foundation-smoke.py --profile golf --account-id YOUR_ACCOUNT_ID --agents
```

The native `cf` CLI must be the qualified version `1.0.0-beta.13`, authenticated with the selected named profile. Workers Paid, Artifacts, R2, Containers, Workers AI and AI Gateway must be available. The runner refuses ambient API credential overrides and pins the profile/account before writes. The existing $10/day envelope is a planning budget, not a provider billing cap.

## Execution and authority

The fixture has two broken arithmetic functions and two tests. Agent A fixes addition and passes its targeted check while the full suite fails. Agent B fixes both functions using a deliberately overlapping addition change. Each task has a separate Artifacts fork, SQLite Durable Object, Linux container and repository-scoped credentials. Both are admitted before either is awaited; successful qualification requires observation of concurrent inference and overlapping execution intervals.

The image pins OpenCode 1.18.34 and Sandbox 1.0.0. The Worker uses native container execution and `ctx.exports` loopback bindings. Agents can read/edit/write only `calc.py`, with other files and Git metadata denied, no shell tools, and no provider credentials. Native write uses the edit permission; file permission patterns are relative to the Git worktree. The controller verifies the exact effective deny/allow rules and enabled tools before inference. OpenCode adds a native tool-output-directory permission exception; this fixture policy is not a proof of general hostile-repository isolation. The trusted controller commits, tests and publishes proposals. It admits only an exact starting commit/tree and refuses unexpected or untracked agent edits.

The image and OpenCode commands use user `1000:1000`. This is an execution convention, not a security boundary: Cloudflare documents shared files and root capabilities within each sandbox. Real credentials stay in the Worker, with separate containers and restricted outbound authority per task. See [Sandbox security](https://developers.cloudflare.com/sandbox/concepts/security/). Build with the native CLI's `linux/amd64` and `--provenance=false` flags; attested OCI indexes are rejected before upload.

Internet access is disabled. Worker interception permits exact task-repository upload-pack reads during cloning, receive-pack writes during controller publication, and the single Workers AI inference route during agent execution. Git credentials are inserted outside the container. The selected model is `@cf/zai-org/glm-5.3-flash`, routed through the owned AI Gateway with inference logging and caching disabled. Each agent can reserve at most 16 inference calls, with 64 KiB request bodies and 2,048 output tokens per call. Reservations precede dispatch and are not refunded or retried on ambiguous outcomes. Cancellation can leave an already dispatched inference billable.

The binding's native usage-only stream event is normalized to OpenAI's empty-choices usage event for OpenCode, preserving the actual provider token counts. Other events remain unchanged. Stream decoding handles fragmented UTF-8 and enforces 1 MiB per inference and 64 KiB per event; malformed usage fails closed. Native harness errors retain bounded, credential-screened names/messages for diagnosis.

Task admission is single-use. An ambiguous preparation does not redispatch the process. The active agent deadline is at most 120 seconds; container preparation has a separate operator wait bound. Cancellation destroys the container and denies later inference/publication. Cancellation during an already dispatched push records an unknown publication outcome, rather than claiming the push was undone. Provider runtime success requires real native completion/usage events, command exit and tests; local test shims do not count as provider evidence.

## Candidate and evidence

The operator fetches both exact published proposals, creates a real Git merge conflict, resolves it into a new merge commit preserving both proposal lineages, and pushes that candidate to the isolated integration repository. A fresh Cloudflare container must clone its exact commit/tree and run its own full tests. The parent is then deliberately advanced; promotion is withheld against the stale recorded base and both proposals must remain intact. This fixture does not implement protected production integration or a native Git compare-and-swap contract.

Private immutable R2 receipts include prompt context and its hash, policy hash, native harness/model, projected native events/usage, proposal identities, patch and test output. The operator verifies readback hashes independently. Task success stays hidden behind `finalizing` until container destruction and receipt storage complete; evidence storage failure records `lost`. Clef's one reserved advisory call recommends review routing and cannot authorize a merge, deployment or resource allocation.

## Ownership and cleanup

All resources belong to a fresh journaled scope. The runner retires its own Durable Object class, deletes its exact container application, Worker, registry image tag and AI Gateway, then runs the existing foundation cleanup for scoped Git tokens, repositories, immutable objects, bucket and namespace. It records failed cleanup and refuses a passing qualification when cleanup fails. Native command timeouts terminate that command's process group, including local Docker upload descendants. No broad account cleanup or credential-file extraction is used.

Namespace retirement is checked against a bounded native inventory, refusing ambiguous or full pages. Fresh routing and empty-object initialization errors may be retried only for GETs or the deliberately invalid `{}` admission, which cannot dispatch work. A valid admission is never retried after an ambiguous response.

The [2026-10-08 live receipt](../.tmp/cloudflare-foundation/golf-cf1-20261008-0496f62e/ownership.json) passes the complete operator prototype, with matching maintained source hashes and complete owned cleanup. Its [private local retention ledger](../.tmp/cloudflare-foundation/golf-cf1-20261008-0496f62e/retained-context.json) binds all five original R2 context/result payloads copied before teardown. Focused source checks and the native deployment dry-run pass. Earlier failed attempts remain evidence of failures; successful deployment or harness installation alone is insufficient. Golf's authorized task/result consumer and comparison/context surfaces remain the next CF2 product work. Provisioning, D1, repository-authorized Zero Trust previews, tenant scheduling, measured fleet cost and the competition delivery story remain separate milestones.
