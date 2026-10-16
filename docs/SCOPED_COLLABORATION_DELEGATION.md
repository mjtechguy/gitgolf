# Scoped collaboration delegation

Golf API credentials delegate a live browser session; they never store a second
provider token. Existing `golf_ro_` credentials remain read-only. A newly issued
`golf_rw_` credential can explicitly grant `issues:write`, `pulls:write`,
`source:write`, `actions:read` and `agents:read` for one exact repository key/native
ID. Basic reads retain the reviewed current-native-access surface across repositories;
source writes and execution/task inspection bind to the selected repository.

The account credential inventory exposes scopes and target. New opens the shared
TanStack Form editor. The user selects permissions and OWNER/REPO; Golf resolves
the native ID and verifies it again at issuance. A failed repository lookup issues
nothing. A lost issuance response still requires inspecting/revoking the original
credential before a separate issuance. Secrets are shown once, kept out of query
and mutation caches and storage, and removed on navigation/sign-out/pagehide.

## Available operations

| CLI | MCP tool | Required write scope |
| --- | --- | --- |
| `golf issue create --input request.json` | `golf_issue_create` | `issues:write` |
| `golf issue comment --input request.json` | `golf_issue_comment` | `issues:write` or `pulls:write`, according to the explicit discussion unit |
| `golf issue update --input request.json` | `golf_issue_update` | `issues:write` |
| `golf pr create --input request.json` | `golf_pr_create` | `pulls:write` |
| `golf pr update --input request.json` | `golf_pr_update` | `pulls:write` |
| `golf pr review --input request.json` | `golf_pr_review` | `pulls:write` |
| `golf source file --input request.json` | `golf_source_file` | `source:write` |
| `golf source ref --input request.json` | `golf_source_ref` | `source:write` |
| `golf source access --input request.json` | `golf_source_access` | `source:write` |
| `golf source operation --input request.json` | `golf_source_operation` | `source:write` |
| `golf ref operation --input request.json` | `golf_ref_operation` | `source:write` |
| `golf actions list/view/logs --input request.json` | `golf_actions_list`, `golf_actions_view`, `golf_actions_logs` | `actions:read` |
| `golf agent list/view/events --input request.json` | `golf_agent_list`, `golf_agent_view`, `golf_agent_events` | `agents:read` |
| `golf repo access --input request.json` | `golf_repo_access` | Existing reviewed read access |

CLI request files and MCP's `request` object use the corresponding versioned
Protobuf JSON contract. Unknown fields are rejected. Exact repository IDs,
original UUID-v4 operation keys, and the applicable expected revision/PR source
selection are mandatory. Clients neither discover a fresh write target nor
invent a key or retry. Native authorization and original operation journals are
shared with browser operations. A transport failure explicitly directs the caller
to original-operation inspection. `OUTCOME_UNKNOWN` remains unknown in structured
output and is never converted to success.

Inspect issue/comment/PR create/update operations with `golf issue operation KEY`;
inspect overall review operations with `golf pr review-operation KEY` or
`golf_pr_review_operation`. Source/ref inspection uses the exact typed request
containing the original operationId and repository/owner IDs. Basic discovery has
34 read tools; a configured `golf_rw_` process advertises another nine scoped
inspection tools and eight writes (51 total). Discovery grants no authority:
server-side scope/target checks remain authoritative. No tool accepts another
origin or credential.

## Enforcement

- Migration075 adds an immutable Golf-owned grant table, leaving retained
  credential rows and their read-only authority unchanged.
- Credential creation and its grant/event commit in one account-locked transaction.
  Repository replacement/slug changes fail the exact write target check.
- Every supported write checks its scope and target before journal reservation.
  PR comments require the pull scope independently of issue access. Current native
  permissions still determine whether the specific operation is permitted.
- Expiry, source-session expiry/sign-out/revocation, local user suspension and
  native identity loss retain the existing session and post-wait checks. Restore
  never revives an old credential.
- Migration080 extends the ordered allowed scope vocabulary, without changing
  retained grants. Explicit source delegation reuses existing file/ref journals,
  authority, unknown-outcome and lifecycle fences. Individual files remain capped
  at256 KiB; refs retain native administrator scope. Protected writes are refused,
  and native expected-HEAD atomic CAS is not claimed.
- Execution inspection never grants dispatch/cancel/resume, connection/credential
  management or merge authority. Task summaries/patches/encrypted journals remain
  private to their initiating Golf user, require a live local/OAuth source session
  and native repository authority, and preserve withheld/unavailable bodies.
  Workflow logs return explicit bounded retained chunks; no silent traversal.
- Bearer credentials cannot manage credentials/accounts/settings, publish protected
  Git writes, merge, dispatch workflows, or run coding agents. Issue/PR grants
  never imply source or execution-inspection permission.

## Verification and limits

`TestApiWriteGrantJournalAndRevocationPostgres` exercises issuance/listing,
immutable grants, old-token refusal, one native fixture dispatch across replay,
wrong ID/slug/unit/scope refusal and revocation. `TestApiWriteGrantValidationPostgres`
rejects unsupported/duplicate scopes, absent targets and mismatched IDs without
creating credentials. These use real PostgreSQL and an HTTP native-protocol
fixture; they do not claim actual Forgejo or served deployment qualification.

CLI/MCP checks exercise typed inputs, both supported MCP protocol revisions,
write discovery/annotations, owner-configured bearer-only transport, original
keys, secret-safe errors, no retries and preservation of unknown operation state.
Browser checks cover scope defaults, exact-ID lookup, failed preflight correction,
shared inventory/editor behavior, one-time secrets and light/dark/mobile controls.
Actual native delegation and the retained localhost rollout are recorded separately
in the implementation ledger when qualified.

The optional `scripts/scoped-collaboration-native-proof.py` passed in an earlier
native qualification on a since-retired backend, through production source HTTP
handlers and isolated Golf PostgreSQL; it has not been repeated on Forgejo 15.0.9. Independent native readback verifies exactly one issue/comment after
original-key replay, and revoked delegation is refused. Owned actors/repositories
are purged. Receipt: [native attempt1](../.tmp/portable-completion075/native-delegation-attempt1/manifest.json).
This qualifies the bounded native issue/comment slice; it does not qualify all six
write operations, the CLI/MCP against actual native transport, or served localhost.

The integrated [native CLI/MCP attempt](../.tmp/portable-completion075/native-cli-mcp-attempt1/manifest.json)
also passed the CLI and actual stdio MCP in both supported protocol revisions
against those production source handlers and the same since-retired native backend. Reusing the original
comment operation produces exactly one native comment. This remains bounded
issue/comment qualification, separate from broader PR writes and served rollout.


## Machine permissions080 evidence

`TestMachineSourceJournalPostgres`, `TestMachineRefJournalPostgres` and
`TestMachineSourceProtectionAndUncertaintyPostgres` exercise file create/update/
delete and branch/tag administration, original replay/revocation, explicit target
refusals, protected/stale refusal and uncertain outcomes with real PostgreSQL and
native-protocol fixtures. `TestMachineExecutionInspectionPostgres` exercises real
retained encrypted journal bodies, own/foreign task access, workflow detail/log
inspection, cancellation capability suppression and execution/credential denials.
CLI checks cover every typed inspection route, original selections, discovery and
no automatic retries. Browser tests cover individual custom permissions and
one-time secret handling. Actual native CLI/MCP source effects and deployment
are qualified separately in the implementation ledger; these source checks alone
are not interactive ACP, model execution, full workflow compatibility or parity.
