# Typed manual workflow inputs

This is the implementation contract for the next Actions increment. It does not enable input declarations, change the deployed input-free catalog, or mark CI settings Ready. The full Actions/GitLab requirements in the [settings packet](REPOSITORY_SETTINGS_IMPLEMENTATION.md) remain applicable.

## Source and parameter semantics

Support Actions `workflow_dispatch` string, boolean, number and choice declarations through a qualified maintained-engine consumer. Environment selectors remain unsupported until a real environment protection, approval and credential-release consumer exists. GitLab manual variables have distinct precedence and environment-variable semantics; they require a separate consumer.

Parse the exact selected workflow blob, preserving the existing 64-KiB single-document, depth-32, 4096-node, duplicate-key and alias restrictions. A declaration parser does not grant eligibility to the rest of the workflow. Expressions in jobs remain subject to the engine catalog; declarations, descriptions, options and defaults are literal. The current catalog refuses `${{` in descriptions, options and defaults; submitted string parameters may contain that text as inert data. This is a published declaration limit, not recursive evaluation.

Bound declarations/submissions to 25 names, 2048 UTF-8 bytes per string and 8192 bytes per canonical submitted/effective map, within the existing 16-KiB event envelope. Reject unknown or duplicate names, unsupported fields/types, invalid defaults, non-finite or out-of-contract numbers, invalid choices and oversized payloads before admission or credential release. Never trim or evaluate a supplied string. Error text must not contain submitted values.

Refuse declaration names that differ only by ASCII letter case: the pinned evaluator looks up map properties case-insensitively, so two such names would be ambiguous. Submitted names must use the exact declared spelling. This restriction is a published catalog limit rather than a change to the generic expression evaluator.

Presence differs from truthiness: explicit false, zero and an empty string are supplied values. A required omission without a default is refused. The foundation contract uses empty string/false for omitted optional string/boolean values. An omitted optional number or choice without a declared default is refused rather than inventing zero or the first choice. Publish these compatibility limits with the catalog; they are not a blanket GitHub parity claim.

Numbers use explicitly documented finite binary64 semantics and canonical JSON representation. Refuse unsafe integral magnitudes and underflow. Tests must establish normalization, negative-zero behavior and precision limits. Choices remain strings. Definition ordering and submission ordering must not change their canonical hashes; changes to types, defaults or choices must change the schema digest.

## Immutable admission and original-operation inspection

Typed submissions bind the managed actor, original idempotency key, immutable repository/owner IDs, full commit SHA, workflow path/blob, schema digest and canonical submitted-input digest. The server independently reads/verifies source and computes the effective/defaulted digest. Keep submitted and effective digests distinct.

Preserve the exact legacy input-free intent hash and historical replay behavior. A new versioned typed hash must not reinterpret old rows. Explicit typed mode with an empty map differs from an absent legacy parameter envelope. Same-key changed values, schema, source or native identities conflict instead of creating another run.

Original-key inspection requires the original typed digest and current managed/native authority. It remains read-only, cannot adopt a new digest and never grants retry. Missing original evidence is not proof of no effect. Persist only original identifiers and digests in browser resume metadata; never parameter values. Lost response/reload must not automatically dispatch or inspect.

Append-only wire fields will expose definition metadata and schema digest, typed submitted values, exact source/native binding, and run digests. Numeric values travel as validated canonical number text to avoid JavaScript/JSON precision loss. Tags are allocated with each actual consumer. The preparation RPC now exposes exact-source definitions and digests; dispatch and worker wire fields remain pending their integrated consumers.

## Preparation consumer (source implemented)

`WorkflowRunService.PrepareWorkflowDispatch` accepts a managed same-origin cookie, immutable repository/owner IDs, a full commit, an Actions workflow path and typed oneof values. It verifies current native writer access before and after exact commit/tree/blob reads, validates declarations and values through the common package, and rechecks the managed session after source reads. Native and Golf actor IDs remain distinct.

The response contains public exact-source declarations, native/source identity and schema/submitted/effective digests. It does not echo submitted values, fetch an archive, plan jobs, reserve a key, upload source, create a run or release credentials. Preparation may succeed while execution is disabled or no maintained engine is installed: its parameter contract is not an execution catalog or admission receipt. Dispatch must independently recompute all bindings, current authority and policy. Preparation does not change the deployed input-free catalog or enable the pending input form.

Pure/race tests cover wire presence, defaults, invalid values and outer cookie/Origin/bearer boundaries. Fresh PostgreSQL/HTTP tests cover exact metadata, no execution effects or submitted-value disclosure, immutable target mismatch, nonwriter denial and session/native-actor/permission revocation during reads. Actual served deployment and full typed execution qualification remain pending.

## Stored values and execution

Store immutable submitted/effective maps encrypted with authenticated binding to run, actor, native identities, workflow blob and schema. Add the retained credential family to startup checks, key inventory, rotation, retirement and recovery. Metadata, plans, audit and notification journals expose digests rather than values.

Only an explicitly input-capable worker can claim typed work. Reuse current session/native authority, execution-policy, resource-generation, attempt/lease, source and verified-TLS checks at admission and release. Legacy workers must receive no typed assignment.

GitHub distinguishes typed `inputs` from string-valued `github.event.inputs`. Preserve that distinction using the selected declaration and canonical event values. The pinned act evaluator currently converts dispatch booleans from string values and leaves numeric values as strings. A declaration/form alone therefore cannot support numbers. Qualify a minimal, reproducible evaluator adaptation across job, step and composite scopes before enabling the catalog. Do not rewrite arbitrary expressions or modify the module cache.

Input contexts may be admitted only in existing supported expression positions. Input-driven image selection, resource limits, runner authority, secrets, environment approval or job-graph expansion require separate supported consumers. Other denied platform/provider contexts stay denied. Existing accepted matrix, needs, output and local-composite semantics must remain intact.

Inputs are ordinary workflow parameters, not secrets. Direct users to Secrets settings for credentials. Golf must not imply that arbitrary workflow echo is private or masked. Supplied expression-looking text is data and must never undergo recursive evaluation. Examples pass untrusted values through environment variables instead of interpolating them into shell source.

## Qualification gates

1. Pure declaration/value tests: duplicates, unknown fields, false/zero/empty presence, defaults, required omission, choices, UTF-8, number precision, deterministic digests, schema changes and all byte/count bounds.
2. Real PostgreSQL/race tests: concurrent same-key admission once, changed-intent conflict, legacy replay, encrypted retained values and key lifecycle, wrong actor/native identities, current revocation, capable-worker selection and lost-ack inspection.
3. Pinned engine tests: boolean equality versus string event equality; numeric JSON output versus string event output; job/step/composite input scope; matrix/needs regressions; malicious-looking parameter values remain literal data.
4. Actual owned Docker run: all four types plus defaults/required choices, metacharacters through environment variables, independent source/blob and output receipts, real matrix/needs behavior, invalid values create no run/container, accepted-response loss inspects only the original digest, restart creates no replacement run and native revocation withholds release.
5. Served dark/light desktop/mobile form/detail checks using shared TanStack components and global styles. Parameter entry opens explicitly from Run workflow. Browser storage, screenshots and diagnostic artifacts must not retain private parameter values.

Record frozen product source, exact engine patch/source and binary receipts, actual runtime images, failures and cleanup. Source foundation tests alone do not qualify the public RPC, encrypted storage, execution consumer or deployed UI.

## References

- [GitHub workflow dispatch input types and context distinction](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_dispatchinputs).
- [GitHub secure use of untrusted workflow values](https://docs.github.com/en/actions/reference/security/secure-use).
- [Pinned act evaluator](https://github.com/nektos/act/blob/4f411281417e88660bea1c1a1749aa71ae0bd60f/pkg/runner/expression.go#L482-L513).
