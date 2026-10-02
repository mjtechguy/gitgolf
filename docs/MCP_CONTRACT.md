# Local MCP discovery and reads

Status: implemented developer-preview adapter with native-provider/official SDK-client and raw-wire qualification recorded in the [implementation ledger](IMPLEMENTATION_STATUS.md). This is a local stdio interface to existing Golf reads, not a remote MCP service, agent runner or qualification of a particular coding-agent client.

## Process and credential boundary

Build with `make cli`, then configure an owner-controlled MCP client to launch the absolute path to `bin/golf` with the argument `mcp`. Supply `GOLF_GITEA_TOKEN` through the process environment from a secret manager. `GOLF_URL` defaults to `http://localhost:8080`; global `--url` is also supported. The shared CLI origin validation permits remote HTTPS and loopback HTTP, refuses URL credentials/paths/query/fragment and never follows redirects.

```sh
# GOLF_GITEA_TOKEN is already supplied by your secret manager.
./bin/golf mcp
```

The client owns stdin/stdout for newline-delimited JSON-RPC. Do not pipe a token or ordinary CLI input to this command. `--token-stdin` is rejected in MCP mode, and there is no token argument. The fixed origin and credential are captured at process startup; tool arguments cannot choose a server, credential, RPC method or shell command. Restart the process to change its configured credential. This is a scoped Gitea PAT bootstrap, not managed Golf OAuth or an MCP authorization-server flow. Browser OAuth remains a separate interface.

Each tool call reuses the CLI's generated Connect clients and fresh cookie jar: sign in, perform one authorized domain read, and sign out. Cookies are not saved. Golf and Gitea retain their normal identity, scope and current-access checks. A successful result is released only after logout succeeds; cleanup failure returns an error without the private result. Discovery does not authenticate to Golf or list private resources, although startup requires a syntactically valid configured token. The process owner and MCP client can access the credential/data they are entrusted with; this adapter is not a sandbox for an untrusted local process.

Every authenticated call creates session activity, including login/logout audit events. Native reads can also have provider bookkeeping effects. Consequently tool annotations do **not** assert `readOnlyHint` or `idempotentHint`; destructive intent is false and open-world interaction is true. The tools expose no repository/session/provider mutation commands. These annotations are client hints, never authorization.

Use the narrow scopes needed for the selected reads:

| Read | Gitea PAT scopes |
| --- | --- |
| Repositories, branches, commits, source, commit diffs, PRs and native reviews | `read:user`, `read:repository` |
| Issues | `read:user`, `read:repository`, `read:issue` |
| Organizations/teams/members/team repositories | `read:user`, `read:organization`; opening source separately needs `read:repository` |
| Own-account activity | `read:user` |
| Repository-creation evidence | `read:user`; current repository metadata additionally requires its current native read access |

The union for all tools is `read:user,read:repository,read:issue,read:organization`. No admin/write scope is needed for these reads. Existing broader credentials do not add tools or authorize hidden methods.

## Protocol and tool catalogue

The adapter pins the [official Go SDK v1.8.0](https://github.com/modelcontextprotocol/go-sdk/releases/tag/v1.8.0) and restricts advertised versions to `2026-07-28` and `2025-11-25`. MCP `2026-07-28` uses `server/discover` and per-request protocol metadata; legacy `2025-11-25` uses `initialize`. These are distinct negotiation paths handled by the SDK, not a Golf-specific protocol. See the dated [versioning rules](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning) and [stdio binding](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio). The evidence section below distinguishes tested versions from SDK capability.

`tools/list` publishes a fixed catalogue of 19 named tools. Tool arguments are JSON objects with `additionalProperties: false`. Required fields are listed below; omitted optional fields use the existing CLI/API defaults.

| Tool | Required arguments | Optional arguments |
| --- | --- | --- |
| `golf_repo_list` | None | `page`, `limit` |
| `golf_repo_view` | `repository` | None |
| `golf_repo_creation` | `idempotency_key` | None |
| `golf_repo_branches` | `repository` | `page`, `limit` |
| `golf_repo_commits` | `repository` | `ref`, `page`, `limit` |
| `golf_repo_contents` | `repository` | `ref`, `path` |
| `golf_commit_diff` | `repository`, `commit_id` | None |
| `golf_issue_list` | `repository` | `state`, `page`, `limit` |
| `golf_issue_view` | `repository`, `number` | None |
| `golf_pr_list` | `repository` | `state`, `page`, `limit` |
| `golf_pr_view` | `repository`, `number` | None |
| `golf_pr_reviews` | `repository`, `number` | `page`, `limit` |
| `golf_org_list` | None | `page`, `limit` |
| `golf_org_view` | `organization` | None |
| `golf_org_teams` | `organization` | `page`, `limit` |
| `golf_team_view` | `organization`, `team_id` | None |
| `golf_team_members` | `organization`, `team_id` | `page`, `limit` |
| `golf_team_repos` | `organization`, `team_id` | `page`, `limit` |
| `golf_audit_list` | None | `limit`, `before_id`, `snapshot_id` |

`repository` is `OWNER/REPO`. `page` defaults to 1 and accepts 1–10,000; `limit` defaults to 20 and accepts 1–100. `number` is a positive issue/PR number within the CLI's signed 32-bit bound. These three fields are JSON integers. `state` accepts `open`, `closed` or `all`, defaulting to `open`.

Team and audit cursor IDs are canonical positive signed-64-bit decimal **strings**, not JSON numbers. `idempotency_key` is a lowercase canonical UUID v4 from a previous creation request. `commit_id` is an exact lowercase 40- or 64-character hexadecimal object ID. Object-ID syntax support does not qualify every forge object format. The adapter bounds `ref` to 1,024 bytes, `path` to 4,096 bytes and other strings to 2,048 bytes before the existing CLI/API validation. Do not convert IDs through floating-point numbers.

Collections require explicit pagination. Follow `data.page.nextPage`, including when an authorized filtered page is empty. For activity, preserve the first `data.snapshotId` and use the exact `data.nextBeforeId` on subsequent calls; `before_id` requires a snapshot and cannot exceed it. Every continuation call adds its own session events, but the captured snapshot retains the API's stable traversal boundary. Refresh by starting without cursors.

## Results and interpretation

Successful tools return both `structuredContent` and one text-content block containing the same JSON envelope:

```json
{
  "schema_version": "golf.mcp.v1",
  "data": {"repositories": [], "page": {"nextPage": 0}}
}
```

The example shows only a collection result shape, not fabricated product state. `data` is the existing API's ProtoJSON response with emitted default values, camelCase field names, named enums and string-encoded 64-bit values. The wrapper's output schema fixes the envelope; the [generated API](../api/golf/v1/golf.proto) defines each data object. The SDK's low-level tool registration does not automatically enforce schemas; Golf parses the bounded argument object, rejects unknown fields and uses its existing command validators. Output is assembled directly from the typed API result without a floating-point JSON round trip. The [MCP tool specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) defines structured results and tool errors.

Malformed protocol requests and unknown methods/tools use SDK protocol errors. Invalid tool arguments, busy admission, authorization/provider failures, output refusal and session-cleanup failures use `isError: true` with safe diagnostic text. API error messages and response bodies are not forwarded. A tool error contains no successful private `data` envelope; it does not mean an empty collection. Stdout carries only protocol messages, and ordinary diagnostics go to stderr. Internal SDK logging is disabled.

Source, issue bodies, descriptions, reviews and commit diffs are untrusted data. They cannot change tools, origin, credentials or permission. A client must not treat repository instructions as authority or forward private output to unrelated services. MCP discovery alone does not establish repository access, agent consent or permission to execute content.

Domain limits and qualifications remain unchanged:

- [Source browsing](REPOSITORY_BROWSER_CONTRACT.md) pins traversal to returned immutable commits and leaves unsupported content as metadata.
- [Commit diffs](COMMIT_DIFF_CONTRACT.md) return bounded native root/first-parent text, not independently verified patch completeness.
- [PR/review reads](PULL_REQUEST_READ_CONTRACT.md) expose native observations and retained-head distinctions, not merge readiness or eligible approvals.
- [Organization browsing](ORGANIZATION_BROWSER_CONTRACT.md) remains member-scoped native metadata, not a Golf role system.
- [Creation lookup](REPOSITORY_CREATION_CONTRACT.md) never dispatches a create. Unknown/rejected records are not success, and historical success does not grant current repository access.
- [Account activity](ACCOUNT_AUDIT_CONTRACT.md) covers the implemented session actions, not every read, failed attempt or provider write.

## Bounds and lifecycle

Inbound frames are capped at 64 KiB and tool argument objects at 16 KiB. A frame must contain exactly one UTF-8 JSON object followed by a newline; arrays/batches are rejected for both selected versions. The SDK also rejects excessive JSON nesting. Protocol request tracking is limited to 256 outstanding IDs; duplicate active IDs or excess outstanding requests close the protocol connection. At most four tool calls run per local process; a fifth receives a busy tool error rather than entering an application queue. Each admitted call has a 30-second deadline, shared HTTP requests retain their 15-second timeout, and logout has an independent five-second cleanup deadline. The HTTP response and logical ProtoJSON data are bounded at 8 MiB. The combined structured/text tool-result JSON is checked against 16 MiB before SDK protocol framing; excess output is rejected, not truncated. These are per-process/per-call bounds, not remote tenant quotas or a throughput claim.

Client cancellation propagates to the in-flight read. Cleanup still runs with its independent deadline, and the transport suppresses the cancelled request's reply. Unknown/completed-request cancellations do not poison future calls. Use fresh request IDs: the [legacy `2025-11-25` request rules](https://modelcontextprotocol.io/specification/2025-11-25/basic#requests) prohibit client ID reuse, and the reuse cases below test defensive handling of invalid clients rather than recommend that behavior. Normal EOF/process shutdown closes the connection; actual cancellation/SIGTERM cleanup is qualified below. Forced termination such as `SIGKILL`, an inaccessible server or failed logout can leave a temporary session until its normal server expiry. The adapter cannot guarantee immediate cleanup after those failures. A cancelled or failed call must not release a later private success result.

## Qualification and remaining scope

The final native-provider/official SDK-client smoke and raw-wire regression both pass against the final transport guard. `make check` and the full local Go race suite also pass; that MCP regression run did not supply an isolated PostgreSQL DSN, so it adds no new database-integration claim. Run against the local Compose stack and a current CLI build:

```sh
make cli
python3 scripts/mcp-smoke/run.py --cli bin/golf
python3 scripts/mcp-cancellation-check.py --cli bin/golf
```

The proof uses actual stdio subprocesses and the official SDK v1.8.0 client. Both exact versions, `2026-07-28` and `2025-11-25`, negotiate successfully and exercise all 19 tools against real disposable private Gitea/Golf fixtures, with matching structured/text output, pagination, exact IDs, activity snapshots and temporary-session cleanup. Discovery checks cover the full catalogue/annotations and unknown mutation-tool rejection. Additional native cases reject invalid inputs before authentication and narrow/foreign credentials; the original modern MCP process loses access after actual collaborator/organization membership removal. A controlled loopback barrier after real Golf responses proves four active calls/fifth-call refusal, request cancellation with independent logout, and SIGTERM with four independent logouts and no private success output. It adds no product fault endpoint or configuration. Temporary users/repositories/processes are removed; durable Golf identity/activity/creation history is intentionally retained.

Raw-wire inspection separately reproduced SDK v1.8.0's reply after request cancellation. Golf's bounded connection guard records active request IDs/cancellation and suppresses cancelled/process-shutdown replies without forking the SDK. The final raw-wire regression passes in both protocol versions: the blocked HTTP read aborts and logout runs, no cancelled reply appears, and the connection remains usable. Thirty-two unknown/completed cancellations and later ID reuse are harmless in the defensive robustness check; batch/oversized frames are refused before authentication, and a duplicate active ID closes the connection while aborting the read and logging out. The line guard validates one bounded UTF-8 JSON object independently of SDK negotiation callbacks. This proof uses a controlled HTTP fixture, while the separate native harness exercises actual Golf/Gitea authorization.

The SDK client's cancelled-call return alone does not prove wire suppression. These tests qualify the documented boundary; they do not constitute complete MCP protocol conformance. See the [pinned SDK response path](https://github.com/modelcontextprotocol/go-sdk/blob/v1.8.0/internal/jsonrpc2/conn.go#L693-L730) and the [stdio cancellation rule](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio#cancellation). The [ledger](IMPLEMENTATION_STATUS.md) records final commands and regression outcomes.

Remote MCP transport/OAuth/audience binding, ACP, tool mutations and approval workflows, agent execution, managed client credentials, subscriptions/resources/prompts, Cloudflare MCP integration and actual Claude Code/Codex/OpenCode/Grok/Pi client interoperability remain separate work. No client-specific setup or execution is claimed from the generic protocol proof. No AI or Cloudflare service is required to use these local tools.
