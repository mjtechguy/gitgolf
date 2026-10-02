# ADR 0005: Credential keyring with drained activation

Status: accepted for the bounded developer-preview implementation, 2026-10-02; qualified scenarios and remaining limits are recorded in the implementation ledger. This extends the initial AES-GCM departure in [ADR 0001](0001-initial-forge-and-vertical-slice.md), not the product's full encryption or assurance disposition.

## Problem

The single configured encryption key cannot be replaced while preserving encrypted PAT/OAuth sessions and pending OAuth verifiers. Keeping only a label without binding its material would permit an accidental same-name key replacement. Re-encrypting all records in one unbounded transaction would make interruption and lock contention operationally expensive. Database ordering alone cannot reverse an OAuth issuer's already-completed refresh.

## Decision

Retain concrete AES-256-GCM for these two existing credential families. Add stored key labels, permanent database material bindings, an explicit active write policy and server-binary operator commands. Preserve existing ciphertext as `legacy`, validating it before registering its material. Nonlegacy associated data binds format/domain, key label and the existing session/state hash. Keep keys outside the database, supplied by operator environment/Secret; do not add a KMS abstraction before an actual backend is selected.

Activation requires a maintenance boundary: drain old writers and external exchanges, explicitly change database policy, then start only correctly configured instances. A database trigger and policy-row locks reject stale label writes. Do not represent this as a safe mixed-version rolling cutover or promise that failed database persistence restores upstream refresh tokens.

Re-encryption commits bounded resumable batches and per-batch operator metadata, preserving IDs, expiry and provider credentials. An old key can pass retirement-check only when both credential tables have zero uses, including expired records. The check does not erase a secret or permanently disable its label. Ordinary database guards protect label bindings/operator events, with the database owner explicitly outside that assurance boundary.

The exact variables, commands, output, bootstrap scan and downgrade constraints are in the [keyring contract](../CREDENTIAL_KEYRING.md). Status can run migrations and register legacy metadata; no read-only or complete integrity-scan claim is made.

## Alternatives and scope

Overwriting the single key loses decryptability. Opportunistic re-encryption only on reads can strand expired sessions and OAuth attempts indefinitely. An all-record transaction increases interruption/lock cost. A transparent rolling activation would need a qualified protocol that covers externally issued refresh operations; database fencing alone is insufficient.

The guide's age default, explicit algorithm migration, envelope keys, managed KMS/HSM, secret distribution/erasure, emergency-compromise procedures and FIPS profiles remain unresolved broader work. This increment stays portable and does not change the ownership of provider credentials or user-account audit history. The operator trail identifies a database role, not a verified human approver.

## Acceptance boundary

The [implementation ledger](../IMPLEMENTATION_STATUS.md) records final real-PostgreSQL migration/material/fence/rollback/resume checks, provider-fixture OAuth concurrency/expiry checks, and actual old-binary PAT/pending-verifier preservation through drained activation. This bounded decision does not claim live OAuth token exchange across activation. Fresh-backup restore, production rollout and assurance claims require their own evidence. P1.3 remains partial: broader audit, outbox, jobs and recovery are not delivered here.
