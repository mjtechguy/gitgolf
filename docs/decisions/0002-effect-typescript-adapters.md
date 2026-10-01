# ADR 0002: Evaluate Effect inside substantive TypeScript adapters

Status: **Proposed qualification; dependency not adopted.** Recorded 2026-10-01 after the user's architecture question. Applies to P0.2/P6.2 and the first actual multi-step TypeScript integration, not a rewrite of the shared Go core.

## Context and recommendation

Golf's Cloudflare adapters will combine remote operations, bounded concurrency, cancellation, retry classification, credential lifetimes and cleanup. Effect provides typed errors/requirements, structured concurrency, resource scopes and testing/observability facilities that could make those paths easier to reason about. It is a TypeScript library, not a Cloudflare-only dependency; a justified portable TypeScript component could use the same approach.

Recommend one comparative pilot when the first substantive adapter is implemented. Keep Go for the shared authoritative core, and retain plain TypeScript/native browser APIs for the current marketing/docs interactions and simple application screens. There is no present Effect runtime requirement, no migration of current source, and no claim that Effect automatically improves latency or scale. The npm registry's latest tag was 4.0.0 at review; recheck and pin the exact compatible stable version when implementing. Use that major's documentation rather than mixing v3 and v4 examples.

## Pilot and acceptance

Use one real task-admission path: validated request → eligible Artifacts workspace/fork → scoped credential → admitted execution → result/cancellation/cleanup. Compare a plain TypeScript implementation using promises, AbortSignal and explicit error types with the Effect version. Keep the external contract identical.

The pilot must demonstrate:

- Explicit expected error types, bounded concurrency and total deadlines; honor provider rate-limit/retry semantics. Permission errors and invalid requests do not retry as transient failures.
- Cancellation reaches the actual provider/runner API where required. Interrupting a local fiber alone cannot stop remote compute. Duplicate/replayed requests do not create duplicate billable resources.
- Request/tenant credentials remain request-scoped; reusable runtimes/layers cannot leak one caller's identity into another request. No Node-only filesystem/process assumptions in a Workers isolate.
- Controlled failure after resource creation leaves a durable cleanup record. In-process finalizers cannot be relied on after hard termination. Restart/eviction recovers through the authoritative job/reconciliation system.
- Real workerd/Workers execution with bundle size, initialization/CPU time, streaming behavior, traces and safe logs measured against the same plain-TypeScript fixture.
- Tests cover typed failures, timeout, cancellation, transient retries, duplicate events and cleanup. Another maintainer can understand the error and ownership flow without maintaining two parallel frameworks.

Adopt only if the pilot reduces repeated control-flow code or materially improves failure correctness enough to justify the added concepts and maintenance. Retain the plain implementation if it remains clearer. Do not retain both implementations after the decision.

## Architectural boundaries

Golf's existing authority and contracts remain intact. Effect's normal in-process execution does not automatically persist work across Worker eviction. Any Effect durable-workflow module would require its own explicit adapter/ADR; do not silently introduce a competing job authority beside PostgreSQL, Cloudflare Queues/Workflows or the selected coordinator. Choose one retry owner per operation boundary to avoid multiplicative retries.

Generated API contracts remain authoritative. Do not maintain incompatible hand-written Effect Schema, Zod and protobuf/OpenAPI definitions for the same payload. Any schema use must consume or validate the existing contract through a qualified path. This proposal does not add Effect AI or change support/authentication commitments for the five requested coding harnesses.

The portable track remains fully independent of Cloudflare. An adapter-level TypeScript library choice cannot turn Workers, Artifacts or inference into prerequisites for Docker/Kubernetes installations.

## Primary references

- [Effect](https://effect.website/) and [v4 runtime](https://effect.website/docs/v4/runtime).
- [Concurrency and interruption](https://effect.website/docs/v4/concurrency/basic-concurrency).
- [Resource scopes and finalization](https://effect.website/docs/v4/resource-management/introduction).
- [Cloudflare Workers lifecycle and platform limits](https://developers.cloudflare.com/workers/platform/limits/).

These sources explain library/runtime behavior. The pilot design, adoption criteria and Golf-specific boundaries above are engineering recommendations, not claims of measured Golf performance or verified production compatibility.
