# Repository live activity contract

2026-10-03 initial portable implementation. `RepositoryActivityService.WatchRepository` is a generated Connect server stream, not EventSource/SSE and not an ACP session. It carries private invalidations; existing APIs still authorize and return content.

## Boundary and cursor

Requests require the normal same-origin opaque session or an explicitly allowed read-only API credential, exact owner/name and native repository ID. Each observation rechecks session/caller and repository authority before and after provider waits. Delegated credential authority is also checked before sending. Responses are `no-store`, disable Nginx buffering through `X-Accel-Buffering: no`, and contain only repository ID, canonical decimal cursor, kind and fixed topic names.

The PostgreSQL journal is append-only. Golf workflow state/log-sequence, agent task version, accepted push receipt, successful issue/comment mutation and reviewer state/native review receipt generate invalidations transactionally. Same-repository writers acquire a transaction advisory lock before assigning IDs; a later cursor cannot commit ahead of an earlier same-repository event. Rolled-back work produces no visible invalidation. Different repositories can have unrelated cursor gaps.

An initial request receives `reset` at the greatest currently authorized cursor and refetches mutable views. Resumption requires a cursor already belonging to that forge/repository and recipient scope. Up to100 journal entries are coalesced by topic per read. Personal agent invalidations are restricted to the owning Golf user; ordinary repository topics require current repository access. No prompts, credentials, command/log text or native protocol output are copied into the journal.

## Bounded connection

Each server process admits at most32 streams and4 per Golf user. Connections read every2 seconds and rotate after10 seconds, within existing HTTP deadlines. Cancellation releases the slot. Heartbeats and a reconnect marker distinguish normal rotation from an unexpected disconnect. The browser resumes its in-memory cursor; connection state is visible, disconnections back off to15 seconds, and mutable reads revalidate during fallback. An unsupported method stops automatic retries until an explicit reconnect. No private journal cursor is stored in browser persistence.

Logout/pagehide/unmount aborts the stream. Authentication loss clears private queries. Repository denial cancels and removes scoped queries and hides the workspace. Fixed topic names are mapped to explicit query keys; event payloads cannot name arbitrary caches. Source trees and commit/PR file comparisons do not silently move on events. A notice offers explicit latest-head/comparison refresh. Open issue drafts stay mounted but hidden during access revalidation; denial removes them.

## Limits and remaining acceptance

This is polling of a durable invalidation journal through a streamed HTTP response, not push notifications from PostgreSQL or a capacity-qualified event broker. Limits are per process, not distributed quotas. Per-repository writer locking and repeated native authority reads need load measurement. There is no journal pruning/retention operator workflow yet. Raw native forge issue edits do not emit these Golf mutation triggers; approved producer reconciliation remains needed for complete external activity coverage.

CI log invalidations refresh authorized loaded log pages; the run workspace now follows sequence continuation beyond the first page, with loaded-only search/download and visible worker truncation. Worker-recorded single-job step events increment the run version and emit the same Actions invalidation. The UI revalidates step outcomes/times and the selected step's bounded log range; it does not infer events from output. Agent invalidations refresh private task state/final results; they do not expose native intermediate thinking/tool/protocol logs. Tail-only/high-volume CI log transport, safe agent phase/event normalization, actual ACP sessions, cross-replica replay/revocation, reverse-proxy flushing/buffering, slow-consumer tests, distributed admission and retention/recovery remain GX-5 acceptance. Recovery still refuses newer schemas beyond its qualified checkpoint, including schema031.

Tests cover actual Connect/HTTP first-frame delivery, cursor/recipient/repository binding, resumption, session revocation, same-repository commit ordering, rollback, admission ceilings, browser invalidation/reconnect/source pinning and private draft retention. Native Compose qualification observes an independently posted owned issue comment in the already-open browser conversation. These checks do not establish complete live-event coverage, an atomic merge fence or Cloudflare adapters.
