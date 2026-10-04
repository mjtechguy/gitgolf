# Organization execution values qualification

**Prepared helper source, not actual runtime proof.** The new helpers qualify the bounded migration 052 organization-sharing consumer after root builds and integrates the complete backend, crypto lifecycle, UI and registration packet. A passing `--self-check` does not start Docker, PostgreSQL, native accounts, runners or browsers. It does not establish deployment or close the full Secrets/settings row.

The source contract is [ORGANIZATION_EXECUTION_VALUES_CONTRACT.md](ORGANIZATION_EXECUTION_VALUES_CONTRACT.md). Repository approval, transport and quarantine behavior remains governed by [EXECUTION_POLICY_CONTRACT.md](EXECUTION_POLICY_CONTRACT.md) and the [shared broker consumer](../internal/server/execution_value_consumer.go). Keep the complete requirements in [REPOSITORY_SETTINGS_IMPLEMENTATION.md](REPOSITORY_SETTINGS_IMPLEMENTATION.md).

## Operator invocation

Root alone executes this prepared helper against a **fresh owned stack**, using already-built immutable cached image IDs/digests. It never builds, pulls, changes retained instance settings, sends notifications or invokes a model.

```sh
python3 scripts/organization-execution-values-smoke.py \
  --image sha256:ROOT_BUILT_CORE_CONFIG_DIGEST \
  --runner-image sha256:ROOT_BUILT_RUNNER_CONFIG_DIGEST \
  --expected-source ROOT_CORE_SOURCE_REVISION_40_HEX \
  --stack-root /absolute/path/to/complete/golf-git \
  --output /absolute/path/to/new-owner-only-artifacts \
  --seed-timeout 300 --ui
```

The placeholders must be replaced from actual root image receipts. The Golf OCI revision label must equal `--expected-source`; the runtime container must use the resolved exact Golf image before and after qualification. Evidence distinguishes product image source, helper working-tree source and both helper byte digests. It never assumes that a later helper commit is the product image revision.

A two-GiB available Docker filesystem guard precedes stack creation. Cached pinned DinD must exist already. `seed.json` identifies only the owned fresh daemon and exact pinned job/daemon images. Root may seed that daemon during the bounded window; the helper independently verifies its images before starting the runner. This is a real maintained Actions execution, rather than the shell interpreter or a mocked runner.

The fixture creates a one-day CA/server certificate with explicit key identifiers and verifies TLS 1.3, loopback SAN, wrong-host and untrusted-CA rejection, and TLS 1.2 exclusion. It uses server-authenticated TLS, **not mutual TLS**. HTTP and a TLS runner without the environment capability cannot claim the queued secret-bearing attempt. CA keys, runner capabilities, encryption keys, native PATs and passwords remain in memory or a removed private temporary directory.

## Actual assertions when executed

| Area | Required observation |
| --- | --- |
| Identity and native authority | Ordinary native org owner; member with independent direct repository admin; member reader; outsider; native site admin without ordinary org authority. Actual native `is_owner`, membership, repository ID and owner ID observations establish fixture roles. Site/global administration is not a share grant. |
| Sharing controls | Exact organization target; selected same-org native repository IDs; selected/unselected metadata distinction; foreign selection and wrong-ID denial; owner-only variable reveal; no secret reveal. Inventory contains metadata only. |
| Original operation | Create, unchanged original-key replay and own status receipt; changed body/presence is refused. Receipts bind item/operation/target/version/broker revision. No automatic resend occurs. |
| Browser boundary | All five organization procedures deny foreign Origin and API bearer usage, independently of read/write body validity. Repository reader cannot approve or reveal inherited values. |
| Real environment consumer | Current ordinary source admin approves scoped immutable refs and exact workflow H/blob/archive/catalog. Real TLS runner executes a job whose fixed shell assertions check secret length, variable value and absence of runner capability in the job environment. Only fixed success markers are printed. Exact run, source, attempt, binding and job receipts are read independently. |
| Explicit override | Cross-kind local override is refused. Same-kind local override fences the active inherited-bound attempt. A new workflow snapshot checks a different synthetic secret length and a new scoped repository binding must execute successfully. No duplicate-name merge or implicit source approval is accepted. |
| Version and selection changes | Actual running quarantined output is observed before replacement/removal. Replacing a share version or removing the selected repository prevents terminal success and readable output. The old binding cannot freshly dispatch. |
| Dual current authority | Actual org owner removal, share-session logout and local credential-version change independently fence running attempts even while source-admin read authority remains. Restoring role/login does not renew old versions; a new explicit share and source approval is required. |
| Expiry | A real share with a bounded near-term expiry is queued while the runner is stopped. Real clock expiry denies new admission; restarting the runner cannot release the old expired binding. No shortened database timestamps or clock mocks are used. |
| Owner transfer | Supported native transfer keeps the same native repository ID but changes its owning org. Existing share identity is unchanged. Original-namespace private run access is denied; bounded Golf metadata confirms withheld output/no readable log publication. |
| Served controls | Twelve actual captures, dark/light × 1440/390, show requested Add editor, shared inventory, and blank inherited override. Real Add, content replacement, sharing-only edit, local override/save/delete, org delete, reload and explicit logout/private clearing are independently checked. Repository selection uses the supported live picker, not manual ID entry or fake rows. |

The workflow never prints secret values, hashes, commands containing secrets or provider credentials. Different controlled lengths prove explicit override selection without exposing either body. Marker presence plus matched source/attempt/binding receipts establishes this narrow execution behavior; it does not prove arbitrary workflows or transformed-secret concealment.

Published output is read through its exact run/attempt/repository/source receipt. Before authority changes, the helper requires real running job state plus positive encrypted quarantine record counts and zero readable logs. After fencing, it requires a non-success terminal state with withheld output; current resource denial is separately checked after transfer. Read-only queries address the **owned Golf fixture database**, never native forge storage. They expose only states/counts, not ciphertext, raw logs or secret bodies.

Supported native transfer is an independent API operation, not a Golf transfer implementation or atomic permission fence. [Gitea 1.27.3 transfer handler](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/routers/api/v1/repo/transfer.go) declares the transfer API and completed transfer response; the [native organization/permission wire contract](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/modules/structs/org.go) distinguishes actual ownership from repository/admin observations. Golf retains its separate current-authority source contract.

## Evidence and failure handling

`manifest.json` is owner-only and retains closed source/image IDs, controlled fixture IDs, procedure status/code facts, run/source/attempt receipts, checks reached, TLS facts, helper digests and exact cleanup result. It records the original failure stage/type/line before teardown and never normalizes an earlier failure into a pass. `complete` requires both all assertions and cleanup success. The browser manifest records receipt metadata and twelve actual PNG/text captures; it does not serialize request bodies, native tokens, secret values or private provider identities.

Unexpected browser writes are blocked before dispatch. Each intended mutation is armed for one exact procedure/target/name/version/body-presence selection, then its native-backed SQL receipt and independently refreshed inventory are matched. A lost or wrong receipt fails qualification; it is never repaired by resending. Native-write noninterference monitoring via the separate read-only native fixture adapter remains a distinct proof; this helper does **not** claim completeness of native mutation monitoring.

Cleanup selects current repository routes by exact owned native ID and verifies the expected owner/name before deletion; it never follows a stale address into a replacement target. All tested native actors are purged and managed accounts disabled/sessions revoked. A tokenless unmanaged native bootstrap administrator exists solely to avoid native last-admin deletion refusal; it is discarded with verified fresh volumes. Stack-label container/volume/network inventories must be empty. Temporary keys/configuration are removed. Cleanup errors preserve the original failure and make `complete` false.

## Source checks and remaining acceptance

```sh
python3 scripts/organization-execution-values-smoke.py --self-check
node --check scripts/organization-execution-values-browser.mjs
node scripts/organization-execution-values-browser.mjs --self-check
```

These are pure receipt, bounds, fixed-output and artifact guards. Source PostgreSQL tests use controlled native HTTP fixtures and separately establish SQL/CAS/encryption/consumer behavior. They cannot substitute for the actual native/runner/browser execution above.

Still required separately: actual migration 052 encrypted key rotation/retirement and fresh-target recovery; crash/lost-ack/final-receipt failures across execution boundaries; native-write noninterference monitoring; full atomic/native external writers and ref-ABA protections; complete environment/job-scoped approval and OIDC; non-Actions agents/CD/context expressions; background-consent/OAuth issuer parity; CLI/MCP shared-value authority. The full product requirements stay open where these gates are not met.
