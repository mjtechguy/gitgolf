# Organization execution values: selected-repository scope

This is the ORG-Values-1 source dependency contract. The first packet defines migration052, browser-only organization value methods, encrypted immutable content/policy, and current-owner receipts. It is **not a deployable or qualified organization broker** until the separate repository approval/release, encryption lifecycle, route/client, and actual consumer packets below are complete. The full [Secrets, variables and OIDC](REPOSITORY_SETTINGS_IMPLEMENTATION.md) and environment requirements remain required. Schema051 belongs to managed Git and is unchanged.

## Existing boundary and the selected increment

The existing repository broker stores immutable encrypted values and session-backed approvals of exact repository, workflow path, full commit/blob, source archive digest, maintained Actions catalog and manual/push event. Only that maintained Actions consumer receives values as execution environment variables. Policy, push sponsor and runner enrollment remain separate authority. Secret-bearing output is withheld and retained encrypted until qualified terminal redaction. Shell catalogs, agents, production, fork approvals, context expressions and OIDC do not gain access from this extension.

The selected increment adds organization-owned values shared with explicitly selected current repositories of that same organization. It does not add automatic all-repository sharing, an organization team administration role, named execution environments, job-scoped protection or provider deployment credentials. A named environment needs a real job-bound release/protection gate: the current repository consumer delivers its environment to the whole admitted Actions attempt.

GitHub's [organization secret policy](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets) distinguishes organization ownership, selected-repository access and repository/environment consumers. Golf follows those scope distinctions while retaining its stricter exact-source broker contract.

## Browser methods and observations

`OrganizationExecutionValueService` exposes five managed browser methods; no delegated bearer/API/CLI/MCP authority is added:

- `ListOrganizationExecutionValues({target})` returns exact target, broker revision, metadata values,64 retained-name cap,20 selected-repository cap and the existing maintained consumer profile. It does not return secret content.
- `SaveOrganizationExecutionValue({target,id,expectedVersion,expectedBrokerRevision,operationId,name,kind,value?,selectedRepositories,expiresAt})` creates/replaces an encrypted content+policy version. Missing `value` is permitted only for editing an existing nondeleted value's policy; it decrypts that value solely on the server and seals a fresh immutable version. It cannot create or restore unspecified content.
- `DeleteOrganizationExecutionValue` requires the exact ID/current version/broker revision/original operation ID and writes a retained tombstone. Encrypted history remains.
- `GetOrganizationExecutionVariable({target,id,version})` reveals only the current nondeleted VARIABLE version to a current actual organization owner. SECRET has no readback endpoint.
- `GetOrganizationExecutionValueOperation({target,operationId})` reads only the caller's original metadata receipt after current authority checks.

Target is `{organization,organizationId}`. A selected repository is `{repository:{owner,name},repositoryId}`. Organization/repository IDs are canonical positive signed64 decimals; item/operation IDs are canonical UUIDs. Names/kinds/bodies reuse the existing execution-value validator. Selection is bounded to20 distinct IDs and distinct case-insensitive routes; foreign organization names, replaced IDs, archived/mirror targets and changed native owners are refused. Empty selected repositories is valid and grants no repository access.

Save bounds are64 retained names per organization,256 encrypted content/policy versions, the existing active environment byte aggregate,8KiB single-line bodies (secrets at least8 bytes), and expiry between one minute and30 days, before the approving session expires. PostgreSQL stores microsecond expiry precision; encryption binds that stored observation, while the operation fingerprint preserves the exact original expiry string.

Value metadata includes the existing ID/name/kind/current version/deleted/created/updated fields plus the selected repository observations, share expiry and `requires_current_authority`. That label is a condition, **not a successful ongoing permission/health check**. Historical selected route names can become stale after rename/transfer and do not establish present authority.

## Identity, original intent and authority

Native supported reads independently establish current caller identity,204 organization membership, exact organization ID and explicit `is_owner:true`. Golf/site administration, public metadata or inherited effective owner-like repository permission supplies no substitute. Native identity/organization/owner proof is rechecked after SQL waits and after successful operations. A lost or denied postcommit acknowledgement can leave a durable accepted receipt; it does not imply rollback or permission to resend.

Mutation lock ordering is managed users/session, sorted affected repository lifecycle gates, organization broker, then existing repository broker/run dependencies in the consumer packet. Old and new selected repository IDs participate. The current policy is reread after the broker wait; an uncaptured changed selection refuses the request rather than acquiring out-of-order gates. Concurrent creates/edits serialize on one organization broker revision. Inventory locks the same broker without creating an absent scope, so its revision and collection cannot mix competing saves.

The metadata journal stores action, immutable target/item, expected versions, name/kind, optional-body presence, original ordered selected IDs/routes, original expiry and accepted receipt/time. It stores no body or secret-derived body hash. Exact-key replay compares complete metadata and, when content was supplied, compares that content against the encrypted accepted version in constant time. Reordering an otherwise equal selected set, changing optional-body presence/content, expiry or other intent is a different request and is refused. An exact replay performs no mutation and cannot renew the original share expiry/session authority. Status and replay remain historical receipts, never a new release grant. Current organization ownership and the caller's managed session are required for inventory, variable reveal, replay and status.

Save/revoke metadata is private. It emits no shared repository activity revealing secret names, organization values, recipients or operation existence. Consumer cancellation/release events remain separately scoped under their existing execution contracts.

## Storage and encrypted identity

Migration052 adds four tables: organization brokers, current value metadata, immutable content+policy versions, and immutable actor-scoped metadata operations. It does not store a native provider token or fabricate a repository identity for organization scope. IDs/name/kind/scope remain immutable; each update advances the current metadata version once. Delete advances metadata and retains earlier ciphertext. Restore needs explicit replacement content.

The organization-specific encryption domain is `organization_execution_value`; its AAD binds item/version, configured forge, exact organization ID, name/kind/byte count, complete ordered selected policy, local/native approver IDs, hashed approving session and normalized expiry. Repository-domain ciphertext cannot be transplanted. The active-key insertion guard and immutable ciphertext identity triggers preserve existing key activation and rotation semantics. Only ciphertext and key label may change during rotation.

The narrow first packet adds the closed keyring domain admission and shared exact-bound ciphertext opener. **Before deploy**, the second packet must integrate organization rows into every existing execution-value-family path: key counts and crypto event counts, startup/legacy validation, configured/required keys, remaining credentials, bounded rotation batches, retirement refusal, key fingerprint consistency, coordinated backup/restore and downgrade/recovery requirements. No historical/tombstoned org ciphertext can be hidden from those paths. These are acceptance gates, not optional cleanup.

## Required consumer and UI packet

The additive consumer proposal is `RepositoryExecutionValueReference.scope` (legacy absent means repository; explicit REPOSITORY or ORGANIZATION) plus `organizationId` required only for inherited references; repository inventory gains metadata-only `inheritedValues`. Exact binding references freeze origin, ID and version. Existing repository-owned values of the same name/kind are explicit overrides; UI identifies both origins and the selected winner. Cross-kind name collision refuses rather than silently turning a secret into a variable. A new local override invalidates prior inherited approvals for that name.

Admission, claim, heartbeat, release and terminal output handling must independently retain both current authorities: the organization owner's approving managed session/expiry/native actual-owner proof and the repository source approver's current administrator/session proof. Repository owner ID must still equal the pinned organization ID, with current native source identity and same-org selection. Rotation, deletion, policy removal/change, session expiry/logout/disable, org ownership loss and repository transfer deny subsequent release. The existing consumer/quarantine machinery must count and redact all selected winning secrets, never an implicitly merged duplicate name. No native permission/source edit is claimed atomic with SQL.

Organization settings show metadata inventory and explicit Add/Edit/Replace actions. Repository settings show inherited source, selected access/expiry and explicit Override action. Requested TanStack forms/shared tables/global CSS, metadata-only original operation storage, scoped private query cancellation, late-account/denial clearing, and current-source receipt validation remain mandatory. No permanent bare form or secret body in browser storage.

## Evidence and remaining gates

The first packet includes pure source tests for exact selected identities, organization-owner proof, org-bound ciphertext/AAD/domain separation and mutation admission. Disposable PostgreSQL tests are prepared for create/policy edit/delete/restore history, original-key fingerprint/replay, current-variable-only reveal, current authority after broker waits, native target replacement and browser boundary denials. Without a configured test DSN these tests skip; an ordinary passing source command is not real PostgreSQL proof.

At first-packet freeze there is no actual org-shared runner execution, served UI, migration052 recovery qualification, named environment protection or workload identity proof. Root owns resource-backed qualification. Required consumer tests include actual selected/unselected/foreign/transfer/fork denials, dual authority loss at every release boundary, competing override/share changes, exact source/version pinning, late failure quarantine, cross-chunk redaction, retained key rotation/retirement, and browser loss-of-acknowledgement inspection without resending content. Environment/job scope, non-Actions consumers, context expressions, durable background consent, CLI/MCP parity and OIDC remain explicit follow-up requirements rather than a complete Settings row.
