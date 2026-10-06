# Explicit password recovery consent090/091

Source contract, 2026-10-06. This packet adds explicit **own-account enrollment**;
public code issuance/redemption and SMTP delivery are integrated separately.
Historical notification-mail verification/consent never authorizes password reset.

`PasswordRecoveryEnrollmentService` exposes browser-session
`GetOwnPasswordRecoveryEnrollment` and `SaveOwnPasswordRecoveryEnrollment`.
Only a current Golf local-password session can read or save this setting. Native
PAT/OAuth sessions and delegated credentials do not substitute for local authority.
Reads return current IDs, versions, own email, effective setting and MFA state;
they return no password hash, provider credential, mail code or authenticator secret.

Save requires exact local-account/native identity, credential/contact/enrollment
versions, current password confirmation and current authenticator or unused MFA
recovery code when enabled. The implementation reuses `withOwnMFA` and its
credential/session/expiry checks, password/MFA limits and actor/account lock order.
It locks the factor before the contact, validates the saved versions while holding
the actor/account locks, consumes the current factor and appends the existing
`recovery_used` audit when applicable. Stale/replayed versions refuse the update;
a failed transaction does not consume a factor or publish consent history.

Migration091 creates `golf_password_recovery_enrollments` with immutable user
association and saved account/native/CV/contact bindings, plus append-only
`golf_password_recovery_enrollment_events`. It creates **no enrollment rows**.
An enabled record is effective only while those bindings match the current
verified, unsuppressed mailbox. Credential or contact changes make it ineffective
without rewriting its original consent event. Fresh reenrollment requires another
explicit confirmed save. Notification preference changes remain independent.
Disabling stale or unverified consent is allowed with current password/MFA.

Public recovery admission/redemption and the before-SMTP-DATA authority must join:

```sql
JOIN golf_password_recovery_enrollments e
 ON e.user_id = u.id AND e.local_account_id = a.id
 AND e.native_user_id = u.forge_user_id
 AND e.credential_version = a.credential_version
 AND e.contact_version = c.version AND e.enabled
```

This joins the existing current local-account/contact/native authority predicates;
it does not replace them. A recovery operation must retain its originally admitted
enrollment version and refuse a disable/re-enable ABA, not adopt the new consent.
The public redemption transaction also locks current contact authority across its
final native wait and conditionally consumes the unexpired original recovery code
before its password update. Recovery preserves the active MFA factor and unused
MFA recovery codes, revokes Golf sessions/preissued MFA login challenges and does
not revoke independent native provider/Git credentials. Existing password login
rate limits remain separate; recovery must not clear a shared hash bucket that may
also protect another account. SMTP acceptance is not inbox delivery, and an
uncertain SMTP response remains an uncertain original attempt.

The new `PasswordRecoveryEnrollment90` component receives the generated client,
native user ID and signing-out state. It leads with the current shared DataTable
inventory, opens its TanStack Form only through Edit, uses global styles, clears
confirmation fields on cancel/departure and blocks another write after an
unconfirmed outcome until explicit read inspection. Root account security mounting,
public sign-in recovery and broker binding checks are separate integration changes.

Passing enrollment checks:

```sh
bin/tools/buf lint
npm --prefix web run check
GOLF_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:45472/postgres?sslmode=disable' \
 go test -race -p 1 ./internal/server -run '^TestPasswordRecoveryEnrollment90' -count=1
```

The three PostgreSQL/race tests passed in30.901s using isolated schemas. They prove
no automatic enrollment after native-format mailbox verification, exact identity/
CV/contact/password refusal, consent-version replay rejection, independent
notification opt-out, stale-binding disable, immutable audit, current MFA setup/
login/confirmation and reuse refusal for consumed recovery codes.

The six isolated-component Playwright cases passed in2.9s: inventory-first/default
off, verified explicit save, unverified enable refusal, cancel secret cleanup,
active MFA confirmation, accepted-response-loss/no-resend and390/1440 layout.
Earlier fixture runs failed on dependency-module/context setup before rendering;
the corrected fixture loads the actual component and its matching Vite query
module. Shared dependency symlinks emit font allowlist warnings, so this is
behavioral/layout evidence, not new served-image or screenshot qualification.
The fixture sends no native requests and uses no Docker resources or model jobs.

Required remaining receipts: integrated generated RPC/browser boundary, actual
retained-native authority and real SMTP/inbox code flow with explicit enrollment,
expiry during the final native wait, enrollment disable/re-enable during delivery
and redemption, original replay/restart, current account/mailbox revocation and
coordinated latest-schema recovery. This source slice does not mark the complete
identity/recovery phase or unified native/Git suspension verified.
