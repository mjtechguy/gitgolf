# Scoped collaboration delegation

Golf API credentials delegate a live browser session; they never store a second
provider token. Existing `golf_ro_` credentials remain read-only. A newly issued
`golf_rw_` credential can add `issues:write`, `pulls:write`, or both for one exact
repository key/native ID. Read permissions retain the existing reviewed read
surface; the repository binding restricts writes, not all reads.

The account credential inventory exposes scopes and target. New opens the shared
TanStack Form editor. The user selects permissions and OWNER/REPO; Golf resolves
the native ID and verifies it again at issuance. A failed repository lookup issues
nothing. A lost issuance response still requires inspecting/revoking the original
credential before a separate issuance. Secrets are shown once, kept out of query
and mutation caches and storage, and removed on navigation/sign-out/pagehide.

## Available writes

| CLI | MCP tool | Required write scope |
| --- | --- | --- |
| `golf issue create --input request.json` | `golf_issue_create` | `issues:write` |
| `golf issue comment --input request.json` | `golf_issue_comment` | `issues:write` or `pulls:write`, according to the explicit discussion unit |
| `golf issue update --input request.json` | `golf_issue_update` | `issues:write` |
| `golf pr create --input request.json` | `golf_pr_create` | `pulls:write` |
| `golf pr update --input request.json` | `golf_pr_update` | `pulls:write` |
| `golf pr review --input request.json` | `golf_pr_review` | `pulls:write` |

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
`golf_pr_review_operation`. The read catalogue has 33 tools. The six write tools
are advertised only when the process owner configured a `golf_rw_` API credential;
server-side scope checks remain authoritative. Native PAT and read-only API modes
retain their read catalogue. No tool accepts another origin or credential.

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
- Bearer credentials cannot manage credentials/accounts/settings, write Git/source,
  merge, dispatch workflows, or run coding agents. These are separate reviewed
  delegation surfaces; enabling issue/PR writes never implies them.

## Verification and limits

`TestApiWriteGrantJournalAndRevocationPostgres` exercises issuance/listing,
immutable grants, old-token refusal, one native fixture dispatch across replay,
wrong ID/slug/unit/scope refusal and revocation. `TestApiWriteGrantValidationPostgres`
rejects unsupported/duplicate scopes, absent targets and mismatched IDs without
creating credentials. These use real PostgreSQL and an HTTP native-protocol
fixture; they do not claim actual Gitea or served deployment qualification.

CLI/MCP checks exercise typed inputs, both supported MCP protocol revisions,
write discovery/annotations, owner-configured bearer-only transport, original
keys, secret-safe errors, no retries and preservation of unknown operation state.
Browser checks cover scope defaults, exact-ID lookup, failed preflight correction,
shared inventory/editor behavior, one-time secrets and light/dark/mobile controls.
Actual native delegation and the retained localhost rollout are recorded separately
in the implementation ledger when qualified.

The optional `scripts/scoped-collaboration-native-proof.py` now passes against
actual Gitea1.27.3 through production source HTTP handlers and isolated Golf
PostgreSQL. Independent native readback verifies exactly one issue/comment after
original-key replay, and revoked delegation is refused. Owned actors/repositories
are purged. Receipt: [native attempt1](../.tmp/portable-completion075/native-delegation-attempt1/manifest.json).
This qualifies the bounded native issue/comment slice; it does not qualify all six
write operations, the CLI/MCP against actual native transport, or served localhost.
