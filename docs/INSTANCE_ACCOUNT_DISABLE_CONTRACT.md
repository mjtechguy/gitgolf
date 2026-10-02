# Browser administrator local-account disable

Golf instance administrators can disable an ordinary Golf local-password account after confirming their own current Golf password. This capability operates on Golf's supported local-account storage on either infrastructure track. It does not disable the native forge identity, revoke independently authenticated provider sessions/tokens, change administrator roles, disable administrator accounts, or grant administrator roles. The separate [ordinary-account lifecycle](INSTANCE_ACCOUNT_LIFECYCLE_CONTRACT.md) implements password-confirmed re-enablement with fresh matching credentials.

## Authority and step-up

Only a current operator-enrolled local-password session with the explicit Golf instance-administrator role can read the inventory or invoke disable. The native forge's site-administrator role, a PAT/OAuth session, or a delegated Golf bearer does not confer that role. Same-origin and browser-cookie boundaries apply; private responses are no-store. Requests identify the target by canonical immutable local-account ID and expected credential version, not by email or a mutable username.

The administrator must submit their own current password. Verification consumes the same durable bounded login throttle and bounded password KDF used for local login, so step-up cannot bypass password-attempt protection. Golf repeats native identity and current local-administrator checks after that wait. Passwords are not stored in audit metadata. Administrator targets, including the acting administrator, are protected regardless of password confirmation; browser role grants, last-owner removal, administrator disable and administrator re-enablement are excluded.

## Atomic local effect

The transaction locks both immutable Golf users in sorted order, then account/session rows in the existing lifecycle lock order. It rechecks the actor's password hash, credential version, role, disable state, bound local session, session expiry and immutable identities. The target update requires the exact expected credential version, an enabled ordinary account and no administrator role. A stale or already disabled target requires refresh rather than a repeated successful mutation.

One commit disables the account, increments its credential version, deletes all its bound local sessions and appends `ADMIN_DISABLED` with operation ID, resulting version, revoked-session count, actor Golf-user ID and actor session ID. Source-session-bound delegated credentials become unusable when their sessions are deleted. Actor session IDs are durable historical identifiers, not live-session foreign keys; the actor's Golf-user reference and event constraints preserve audit attribution. Transaction failure rolls back the local disable, session removal and event together. A lost commit response remains uncertain and must be inspected before another action.

This is an atomic local-account lifecycle operation. It does not claim atomic control over an independently changing native forge identity, stop every already admitted external operation, or revoke independently sourced credentials. Operator recovery and ordinary browser re-enablement require fresh credentials and explicit immutable native mapping; a bare toggle cannot reactivate the account. Migration 009 introduces actor columns and `ADMIN_DISABLED`; downgrade explicitly refuses while such events exist, preventing silent audit-history loss.

## Runnable evidence

- `go test ./internal/server -run TestInstanceDisable -count=1` checks browser boundaries and, with `GOLF_TEST_DATABASE_URL`, disposable-schema atomicity, concurrent CAS, actor attribution, target sessions/delegations and negative authority cases.
- `python3 scripts/instance-account-disable-smoke.py --image <current-local-image>` creates and destroys an isolated canonical Compose core. It verifies actual password step-up, wrong-password/ordinary-user/PAT/bearer/Origin/administrator-target denial, target CAS, two local-session revocations and dependent bearer denial, independent native/PAT survival, durable actor event, restart persistence and the shared durable throttle.
- `python3 scripts/recovery-smoke.py --image <current-local-image>` captures a source with a real browser-generated `ADMIN_DISABLED` event, then verifies encrypted fresh-target restore preserves its operation, version and actor fields exactly before adding recovery events. This qualification requires the current image and source schema 009; merely allowing a manifest version does not qualify that restore path.

Keep live qualification outcomes in the implementation status; the scripts define evidence to run and do not by themselves claim successful native proof.
