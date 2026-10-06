# Local authenticator and recovery contract

This is Golf-local password authentication, using RFC6238 TOTP (SHA-1, six digits, 30 seconds) and ten independently generated 128-bit recovery codes. It does not claim passkeys, SSO enforcement, verified-email password reset or MFA enforcement at independent native Git/API/SSH/provider OAuth ingress. Existing Git credentials and explicitly authorized reviewer/background connections remain separate grants.

## Setup and account changes

Account security shows the current authenticator status and unused recovery count. Setup, confirmation, disabling and replacing recovery codes use explicitly opened TanStack forms. Only an own, current local password session can manage them; native tokens, delegated API credentials and instance administrator impersonation do not substitute.

Setup requires the current password and exact MFA version. A random160-bit setup secret expires after ten minutes; it is returned once, stored encrypted in the existing key rotation inventory and additionally bound inside its authenticated payload to the immutable local account ID. The provisioning URI supplies the algorithm/digit/period parameters. Confirmation requires the current password and a current authenticator code. It increments the MFA version, generates the recovery codes and revokes all local password sessions and dependent API credentials. Disable and recovery replacement require password plus a current authenticator or unused recovery code, then revoke sessions too. Own password/email changes also require the factor when enrolled and preserve MFA.

Recovery digests include the immutable account and current MFA version. Replacing the recovery set invalidates all older codes. Recovery use and authenticator counters commit under the account/MFA locks with the intended effect; failed writes roll back factor consumption. The exact successful self-revocation receipt is audited and is the only exception to the ordinary postflight session check.

## Password sign-in

A correct password and matching current native identity produce only a random opaque pre-authentication cookie when MFA is enabled. The cookie is HTTP-only, SameSite Strict, host-only, path `/`, expires after five minutes and is Secure with the `__Host-` prefix in HTTPS installations. Local HTTP uses the existing explicit insecure-cookie development policy. The response has no authenticated user or Golf session.

Completion verifies the current account credential/MFA versions, expiry, suspension, native actor and factor. A challenge has at most five attempts. A separate durable ten-attempt/five-minute account factor budget spans processes, aliases and challenges; starting another password challenge does not reset it. At most ten unconsumed live challenges exist per account, under its existing account lock. Cleanup is account-scoped.

The challenge, one-time recovery digest or TOTP counter and authenticated session commit atomically. Replaying a consumed challenge/code/counter cannot create another session. TOTP admits the previous/current/next time step and refuses counters at or before the last consumed counter; a code used for enrollment or a security change cannot be reused immediately for login. No secret/token enters browser storage or execution jobs. The challenge survives application restarts with the same authoritative database and keyring. Interactive native-token login is refused for an enrolled MFA account; provider OAuth and existing granted automation are separate authentication policies.

## One-time code disclosure

Successful enable/recovery replacement clears the authenticated workspace and private query caches. Recovery codes are held only in ephemeral App React state outside that workspace, so focus-triggered expired-session checks cannot unmount the disclosure while the user opens a password manager. Explicit acknowledgement returns to login. Pagehide/reload/unmount and a five-minute timer clear the disclosure. Unknown outcomes are not automatically retried; an authenticator holder can sign in and explicitly replace codes if the original response was lost.

## Evidence and remaining gates

`go test -race ./internal/server -run 'Test(MFATOTP|LocalMFA.*Postgres|LocalMFABoundary|AccountSecurity)'` with `GOLF_TEST_DATABASE_URL` exercises the RFC vectors, encrypted account binding, PostgreSQL enrollment/revocation, concurrent one-time recovery consumption, challenge expiry/budgets/capacity, password-change factor enforcement and generic key rotation. Playwright account MFA/security cases cover requested forms, secret clearing, password-to-factor transition, unknown outcomes and expired-session focus during recovery disclosure.

`TestLocalMFANativeProof` accepts an owner-only `GOLF_MFA_NATIVE_PROOF` JSON envelope containing `URL`, `Username` and `Token` for a launcher-owned ordinary `golf-mfa-probe-*` user at the retained localhost native forge. It tests actual native identity, application restart, recovery regeneration and logout using a disposable Golf schema, and creates an owned private `forms` repository for exact-commit YAML template reading and issue publication. The launcher must purge the native actor through supported APIs; the test never changes forge database/files. Native/runtime qualification is separate from source fixtures and must be recorded by the coordinator before advertising a deployed feature.

Operator MFA recovery/reset, passkeys, enterprise mandatory enrollment and provider/native-ingress MFA parity remain acceptance work. Administratively resetting a password does not remove MFA or grant access to its recovery codes.

Primary algorithm reference: [RFC6238](https://www.rfc-editor.org/rfc/rfc6238).
