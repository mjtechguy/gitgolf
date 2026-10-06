# Local authenticator recovery

Recovery is separate from password reset. Resetting a password never silently removes MFA. These operations affect Golf-owned state only; native forge database/repository files are never written.

## Global administrator portal

The local-account inventory shows authenticator status and saved versions. An explicit recovery action is available for another ordinary enrolled account with an enabled factor or pending setup. No browser action can reset the caller or an instance administrator, even when native administrator credentials are supplied.

Recovery requires the current Golf global-administrator password session, current administrator password, its current authenticator or unused recovery code when enrolled, exact target local/Golf/native user IDs, exact credential/MFA versions, exact administrator MFA version, a recovery reason and explicit warning acknowledgement. The operator must verify the recovery request; Golf cannot establish that a person requesting recovery owns an external mailbox or telephone.

Sorted user/account/session/MFA locks keep the actor and target bindings current. One transaction disables the target factor, advances both versions, removes recovery digests and pending challenges, revokes local password and same-user managed native-token browser sessions, and fences dependent API credentials and account-bound background authorizations. The password, mapped native credential, instance role and disabled state stay unchanged. Already accepted external effects cannot be recalled by session revocation. Existing independent provider OAuth and native Git/API/SSH credentials remain separate.

The immutable MFA event records the subject, distinct administrator actor/session, reason and operation. The account credential ledger records the same operation and credential version. Failed audit/commit paths roll back factor consumption and revocation together. Unknown responses are not automatically resent; refresh the inventory and inspect the saved versions/state first. A successful recovery does not revoke the administrator's current session.

## Privileged console recovery

An instance administrator who lost both authenticator and recovery codes cannot be recovered through another browser administrator. A trusted deployment operator with privileged Golf database access and the active keyring can use the explicit console operation.

First quarantine Golf traffic and drain/stop its authoritative application, agent/reviewer, runner and delivery writers. Keep the owned Golf database and native forge API available. Reconcile any in-flight external effects before reopening traffic. The `writers_drained` field acknowledges this operator procedure; it does not claim automatic proof that every remote process stopped.

Inspect the enrolled account without changing data:

```sh
printf '%s\n' '{"username":"golf-admin"}' | golf local-account inspect
```

`inspect` accepts only a canonical username on bounded stdin. It reads only nonsecret Golf metadata, including local account ID (`id`), Golf user ID (`user_id`), native user ID, credential/MFA versions, role, enabled/disabled status and pending setup expiry. It needs `DATABASE_URL` and the configured `GITEA_URL`; it does not need encryption keys, decrypt credentials, contact a provider, or run migrations. A PostgreSQL read-only connection is supported.

Copy the exact current values into an operator-owned input file:

```json
{
  "username": "golf-admin",
  "account_id": "1",
  "golf_user_id": "2",
  "expected_native_user_id": "42",
  "expected_credential_version": "3",
  "expected_mfa_version": "4",
  "reason": "Verified lost authenticator; Golf writers drained",
  "acknowledge_warning": true,
  "writers_drained": true
}
```

Those numbers are examples. Run with the deployment's existing protected database/keyring configuration:

```sh
golf local-account reset-mfa < protected-recovery-input.json
```

No passwords or provider tokens belong in argv or the recovery input. The command verifies the current mapped native identity through the supported API using the retained encrypted credential, checks all immutable IDs/versions again under locks, and applies the same revocation effect as browser recovery. It preserves password, disabled state and administrator role. Its immutable event is marked `actor_kind=operator`, with no fabricated Golf actor/session. Output contains only nonsecret IDs, versions, counts and an operation identifier.

If the retained native credential is unavailable or revoked, this command refuses. Reconcile the original immutable identity using the existing explicit operator disable/enable procedures and a freshly validated matching native credential before factor recovery. Password reset alone neither renews that credential nor removes the factor. Console mutations use the existing operator database/keyring startup facility and may apply additive Golf migrations, so use a release-compatible binary during the drained maintenance window.

After recovery, reopen access deliberately, sign in with the unchanged/current password, enroll a new authenticator and save its new recovery codes. Previously revoked sessions/delegations stay revoked.

## Qualification

Source PostgreSQL/race checks cover the administrator/native-token/OAuth/delegation role matrix; protected targets; exact stale IDs/versions; own administrator factor; concurrent reset; disabled state; audit rollback; managed PAT/API revocation; operator native identity verification and role/password preservation. Browser tests exercise requested forms, warnings, immutable versions, secret clearing, denial and unknown outcomes.

`scripts/admin-mfa-native-source-proof.py --stack-root STACK --output RECEIPT --include-cli` creates/purges two ordinary native actors, enrolls one as a Golf administrator in an isolated host PostgreSQL schema, and exercises the actual handlers. With `--include-cli`, it builds a private host binary, runs read-only inspection with `default_transaction_read_only=on` and no encryption keys, and runs actual console recovery against that exact owned schema. It creates no Docker jobs/resources and changes no retained user settings. Served runtime/UI deployment, independent ingress suspension and organization-mandated MFA policy remain separate acceptance gates.
