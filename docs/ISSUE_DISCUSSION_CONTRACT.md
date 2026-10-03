# Issue discussions and durable write observations

Status: implemented bounded developer-preview workflow; final-image qualification is recorded in the [implementation ledger](IMPLEMENTATION_STATUS.md). This supports the shared portable/Cloudflare core through pinned Gitea APIs. It does not complete P2.2 or protected publication.

## Discussion reads

`RepositoryService.ListIssueComments` takes the repository address, expected immutable repository ID, issue number, expected immutable issue ID and an explicit page. Native IDs are canonical positive decimal strings. The target must be an ordinary issue, not a PR exposed through the native issue API.

Gitea 1.27.3's issue-specific comments endpoint ignores page/limit. Golf therefore requests one bounded page from the supported repository-wide comments endpoint and filters exact ordinary-comment issue URLs to the requested issue. It returns no unrelated bodies, PR comments or native repository-wide totals. Empty filtered pages can have `nextPage`; callers must follow continuation. It does not scan unseen pages automatically or claim a snapshot/completeness guarantee while native comments are being edited/deleted. Native page/response and Golf transport bounds remain enforced; excess data fails visibly instead of being silently truncated.

Target IDs and current caller/native access are checked around reads. Provider URLs are validated metadata, never destinations for outbound requests. External bodies are bounded to 256KiB and issue titles to 1024 bytes; native JSON is bounded to 2MiB, with page size at most 100 and page ceiling 10000. Excess data fails visibly. Comments and issue bodies use the shared safe CommonMark/GFM renderer, sanitized HTML and bounded code highlighting. Context-free discussion images remain unavailable placeholders; attachment delivery is separate work.

## Create an issue or comment

`CreateIssue` requires the repository address/expected ID, title, body and a canonical lowercase UUIDv4 `idempotency_key`. `CreateIssueComment` additionally requires the displayed issue's number/expected ID. Only browser-session authority can invoke these writes; read-only API credentials and local MCP tools cannot.

A title is trimmed, nonempty UTF-8, at most 255 bytes and contains no controls. Bodies preserve exact valid UTF-8 and are at most 6000 bytes; comments must contain non-whitespace text. Only tab, LF and CR controls are accepted in bodies. The 6000-byte cap keeps worst-case JSON escaping plus bounded metadata within the existing 16 KiB Connect request boundary. This is an explicit input ceiling, not truncation of submitted content.

Create, comment and update operations share an owner/forge/key journal. Exact canonical input, operation kind and target IDs bind a fingerprint; stored records contain metadata/digests, not request titles/bodies or provider credentials. Reservation plus the initial `OUTCOME_UNKNOWN` event commit before any native POST/PATCH. Only the invocation that created that reservation may dispatch. Repeating a key with identical input reads recorded evidence; different input fails precondition. A key is never reused to retry a provider write, including after cancellation, process failure or restore.

Known preflight target-ID mismatch records `REJECTED`/`target_changed` without a POST. Qualified explicit native denials may also be rejected. An exact native HTTP 201 receipt matching actor, target address and submitted text first records immutable provisional `observed_result_id`/`observed_number` metadata with a `RECEIPT` event while the operation remains unknown. Only a subsequent current ID-bound postflight records `SUCCEEDED` with its immutable issue/comment identity and terminal event together. Provisional IDs are diagnostic evidence, never permission to adopt an object or present success. A crash or storage failure before receipt commit can still lose that observation. Lost acknowledgment, malformed responses, post-dispatch target mismatch and uncertain effects remain `OUTCOME_UNKNOWN`. The state is evidence, not an HTTP success promise; do not automatically resend or adopt a similarly worded issue/comment.

`GetIssueMutation` reads the issuing account's historical record. Foreign keys are concealed. Returning an optional current issue/comment also requires current native access and exact recorded object/target binding. Historical success cannot grant access to a deleted, moved or replaced object. Outcome bookkeeping after response loss is bounded synchronous storage work and does not issue another provider request.

## Edit, close and reopen ordinary issues

`RepositoryService.UpdateIssue` is browser-session-only. It takes the repository address, expected immutable repository/issue IDs, issue number, displayed `Issue.revision`, a UUIDv4 key and **exactly one** optional title, optional body or OPEN/CLOSED state. Optional body presence distinguishes clearing the body (`""`) from leaving it unchanged. Pull requests are refused. Input caps remain255/6000 UTF-8 bytes. `UPDATE_ISSUE` shares the existing metadata-only journal and issuing-account status lookup; no CLI/MCP write is added.

The revision hashes issue ID, number, author ID, native `content_version`, title, body, state and updated timestamp. Missing/invalid native version disables browser actions. After current repository/caller/issue binding, a changed revision records `REJECTED/revision_changed`; an unchanged selected field records `REJECTED/unchanged`. Neither dispatches a native PATCH. A pending editor retains its original revision through background access checks. A rejected stale edit closes on **Review current issue**; the user must explicitly reopen an editor against current values. Golf never silently rebases the draft or generates a retry.

One native PATCH sends the selected field and observed `content_version`. Its HTTP201 receipt must bind the same ordinary issue/address/author and exact selected value. Provisional receipt metadata commits before the independent current-access readback; success additionally observes that value again. Lost responses, malformed receipts, changed postflight fields and caller revocation leave uncertain evidence without another PATCH. An explicit403,409 or412 denial is rejected. Current optional result objects are current observations, not immutable snapshots of submitted text.

Native author or issue-unit write permission governs title/body/state changes. Actual local qualification proves owner/writer edits, a read-role user's own issue edit/close, reader denial on another author's issue and outsider denial. Golf does not infer issue-write authority from code push permission and does not yet expose a per-action `canEdit` observation: offered controls still check native permission when saving. Native permissions and `write:issue` credential scope are distinct.

The pinned handler is **not transactional across title/body/state**, so mixed-field submissions are refused. Body changes use native `content_version` conditional admission; the native stale-body409 case is qualified. Title/state check the version before changes but still have a concurrent-write window. Golf revisions/preflight/postflight do not establish atomic whole-issue CAS, an expected-ID address fence, full unit-policy enforcement or protected merge authority. Native events/notifications/hooks may run. These limitations remain explicit developer-preview boundaries.

## Native-address limitation

The pinned native POST routes address repositories by owner/name and comments by issue number; they have no expected-ID predicate. Golf's preflight and verified postflight establish observed results but cannot atomically prevent a native rename/delete/reuse during dispatch. A mismatch after dispatch can mean an effect occurred at another native address, and remains unknown rather than becoming a successful Golf observation. Neither an account lock nor a receipt check is a target-side conditional write fence.

This limitation remains a release qualification gap where the plan requires conditional target admission. It does not weaken the separate protected Git/source/base/approval gates, enable PR mutations or claim exactly-once external effects. The current supported-native-address workflow follows the selected Gitea integration; a required conditional workflow needs a supported enforcement design and its own complete race corpus before it can be advertised as qualified.

## Authentication and client behavior

Native writes require `write:issue` plus the scopes used for caller/repository binding (`read:user`, `read:repository`). Native issue-unit permissions still govern access: a native read-role may allow reporting/commenting, so Golf does not equate that label with a zero-write role. New browser OAuth grants request `write:issue`; existing `read:issue` grants are not silently upgraded. Revoke the old Gitea grant and obtain fresh consent, or use a dedicated appropriately scoped PAT. Managed identity/role policy remains separate work.

The browser freezes one UUID-backed intent, prevents duplicate submission and offers status inspection after uncertainty. Reload only inspects a pending operation; it never reposts. Convenience storage contains only key/kind/target metadata scoped to exact origin/native user/repository ID, never titles, bodies or credentials. Authentication/access loss clears private discussion/form state. A terminal rejection permits an explicit new intent; an uncertain operation does not become an automatic retry.

CLI/local MCP add comment-page and own-operation-status reads to the existing authorized dispatcher. They preserve explicit empty-page continuation and conservative MCP annotations. There are no new write commands/tools or agent approval semantics.

## Persistence and remaining work

Schema `202610020006` adds `golf_issue_mutations` and separate append-only `golf_issue_mutation_events` with once-only `RESERVED`, `RECEIPT` and `COMPLETED` phases. Coordinated encrypted recovery must preserve both byte-equivalently, retain recorded outcomes and original native objects, invalidate all restored source credentials and prove keyed replay creates no duplicate issue/comment. The previous schema005 proof does not qualify this schema.

Schema `202610030032` extends kind/target/receipt constraints and immutable guards for updates without adding private payload columns or changing historical create/comment fingerprints. Migration Down explicitly refuses silent journal/history loss. Latest schema032 coordinated recovery remains unqualified; existing recovery tooling refuses it until its full restore/replay corpus passes. This migration does not establish recovery readiness.

Labels/assignees/milestones, boards, attachments, complete issue event timelines, richer notification/webhook delivery, PR creation/edit/review mutations, import and general outbox/job reconciliation remain required later work. This journal covers these concrete ordinary writes; it does not implement their broader execution infrastructure.

Primary references: [pinned native comment handlers](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/api/v1/repo/issue_comment.go), [pinned issue handlers](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/api/v1/repo/issue.go), and the existing [native role qualification](GITEA_IDENTITY_ROLE_QUALIFICATION.md). Actual native behavior and final test evidence belong in the implementation ledger.

Native Gitea may process mentions, notifications and hooks for submitted text independently of Golf’s safe Markdown rendering. This is not a promise of side-effect-free native posting. A malformed or moved comment association fails visibly without returning a current object; known repository/issue ID replacement can return only the historical successful record.
