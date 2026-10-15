# Credential vault (Cloudflare native)

Status: phase 2a of [AGENTS_AND_AUTOMATIONS_PLAN.md](AGENTS_AND_AUTOMATIONS_PLAN.md), verified locally (node tests and a mocked-backend
browser spec). Not yet hosted-verified. Check [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) before relying on it.

The vault holds the secrets engines use: provider **API keys** and **subscription sign-ins** (CLI token files). It lives in
`cloudflare/forge/src/vault.mjs` with schema 45 (`migrations/0045_credential_vault.sql`). It is separate from the portable server's
[credential keyring](CREDENTIAL_KEYRING.md), which protects Golf's own sessions and provider tokens.

## Scopes and who manages them

| Scope | Owner | Managed by | Where in the UI |
| --- | --- | --- | --- |
| `user` | one account | that account only (not even operations administrators) | Settings → Developer → Credentials and engines (`/account/credentials`) |
| `organization` | one organization | its owners; members see labels only | Organization settings → Credentials (`/organizations/<org>/settings/credentials`) |
| `installation` | the installation | operations administrators signed in through Access | Admin → Credentials (`/admin/credentials`) |

Subscription sign-ins are personal: they can only be added at `user` scope. Every mutation needs a browser session with Golf's own
`Origin`; bearer, service and API tokens cannot change credentials.

## Sealing

- Each value gets its own random 256-bit AES-GCM **data key**. The data key encrypts the value; the installation key encrypts the data key.
- The installation key is `EXECUTION_VALUE_KEY`, the Secrets Store key repository execution values already use (`sealed.mjs`). Its 8-byte
  one-way id is stored as `key_id` beside each envelope.
- Both layers authenticate a domain (`golf.vault.key.v1`, `golf.vault.data.v1`) and a context. For credentials the context is
  `credential:<id>:<version>`, so an envelope cannot be moved to another credential, another version or another sealed store.
- Stored: the envelope, `key_id`, the value size and, for API keys only, the last 4 characters (`fingerprint`). Never the plaintext.
- Revoking sets `sealed_value` to NULL at once. Metadata, grants and the audit trail stay.
- Rotating replaces the envelope and advances `version`. A handle issued before the rotation no longer opens.

`sealSecret(env, bytes, context)` and `openSecret(env, sealed, context)` are exported for other stores (for example SSH host keys). They use
the same envelope; pick a context unique to the owner, such as `ssh-host:<id>`.

## Nothing comes back

- `list` answers carry metadata only: label, provider, kind, tool, `…abcd`, size, state, version, who created it, last use, grants.
- No API, log line, audit row or error message contains a value. Tests scan every D1 table, every answer and every audit row for the
  plaintext.
- The only way to use a value is a **handle** from `credentialFor()`. Handles are frozen objects registered in a module-private `WeakMap`,
  so they cannot be forged or serialized into something usable. `engines.mjs` opens a handle for one outbound provider call
  (`openCredential`), after checking that the credential was neither revoked nor rotated since.

## Sharing (grants)

Only the owner can use a personal credential until they share it. Organization and installation credentials have no implicit users: the
Add form offers "members of this organization" or "everyone on this installation" as an explicit first grant.

| Grant | Who may use it |
| --- | --- |
| `user` | that person |
| `organization` | members of that organization, inside its repositories (or with no repository) |
| `repository` | people with any grant on that repository, inside it |
| `installation` | every active account (installation credentials only) |

Each grant may be limited to engine ids (`[]` means any engine that uses the credential) and to places: `cloud`, `agent-host`, `ssh-host`.
An organization credential can only be shared inside its own organization and repositories. Golf has no teams yet; organization grants
stand in for them.

## Use: `credentialFor`

`credentialFor(db, env, { person, engine, place, repository?, dryRun? })` returns `{ credential: handle }`, `{ credential: null }` (the
engine needs none, for example Workers AI) or `{ refusal, code }`. It refuses, in order:

1. `vault_unavailable`: schema 45 missing or `EXECUTION_VALUE_KEY` not bound;
2. `revoked`;
3. `place`: the engine does not run there;
4. `subscription`: "cloud sandboxes are phase 3". Subscription sign-ins are stored and listed but never used yet;
5. `not_granted`: an inactive account, or no grant matching the person, engine, place and repository.

Every refusal is written to the audit log as `credential.use_denied`, except dry runs (inventory reads and admission previews). A
successful non-dry use updates `last_used_at`.

## Audit

Category **Credentials** (`credential.*`):
- `create`, `rotate`, `revoke`, `grant` and `ungrant` are written in the same D1 batch as the change;
- refusals of those requests are recorded by the audit hook;
- `use_denied` records refused uses.

Personal and installation credentials are recorded at installation scope (like personal API tokens). Organization credentials are recorded
at the organization. A refused use inside a repository is recorded at that repository. Rows hold labels, kinds, grantees and versions, never
values.

## Subscription sign-ins

- Upload or paste the CLI's token file: for example `~/.codex/auth.json` or `~/.claude/.credentials.json`. JSON only, up to 64 KiB.
- The form shows a warning. The file signs in as you, with your plan. Check your provider's terms before letting a hosted sandbox use a
  personal subscription.
- Storing one requires ticking that you checked the terms.
- Phase 3 (cloud sandboxes) will mount the sealed file for one task at a time and write the refreshed token back.

## Capability

`settings.credentials` (**Credential vault**) is ready when schema 45 is applied and `EXECUTION_VALUE_KEY` is bound. Otherwise it reports
the reason, and the pages show it instead of an empty form.

## Deploy changes needed

None. The vault reuses the existing `EXECUTION_VALUE_KEY` Secrets Store binding. Provider calls use the existing Workers AI binding's
gateway (see [ENGINES.md](ENGINES.md)). An installation without `EXECUTION_VALUE_KEY` reports the vault as unavailable.

## Limits and not done

- **Re-wrapping:** no command re-wraps data keys after the installation key itself is rotated. Envelopes sealed under an old key fail with
  "Sealed under a different installation key".
- **Credential limits:** 100 active credentials per owner, 50 grants per credential, 10 grants in the create request.
- **Provider side:** Golf does not check a key against its provider when you add it, and revoking in Golf does not revoke at the provider.
- **Subscriptions:** no OAuth or device-code sign-in flow yet; the token file is uploaded.
- **Hosted evidence:** none yet.
