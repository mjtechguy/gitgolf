# Owner-issued read-only API credentials

Golf API credentials delegate the existing signed-in owner's read access. They do not create a separate identity, copy a Forgejo token, extend a provider grant or implement an OAuth authorization server. The portable and Cloudflare tracks use the same boundary.

## Issuance and lifetime

Only an authenticated browser session can call `ApiCredentialService/CreateApiCredential`, `ListApiCredentials` or `RevokeApiCredential`. The account page is `/account/api-credentials`. A credential requires a trimmed, nonempty UTF-8 label of at most 64 bytes without control characters. Requested lifetime defaults to one hour and otherwise must be 60–43200 seconds; actual expiry cannot exceed the issuing session's absolute expiry. An account may have at most 100 currently usable credentials.

Creation returns a `golf_ro_` token containing 32 cryptographically random bytes encoded as canonical unpadded base64url. The secret is returned once. Golf stores its SHA-256 digest, immutable owner/source-session binding, label and timestamps. List/revoke responses contain metadata only. The browser holds the new secret only in component memory and clears it on dismissal or navigation. If an issuance response is lost, inspect the list and revoke the unwanted credential; do not automatically retry issuance or expect secret recovery.

Issuance and the separate append-only `CREATED` event commit together. Explicit revocation and `REVOKED` commit together; repeat revocation is idempotent and foreign identifiers return not found. These events do not enlarge the existing session-activity action enum or claim a general organization audit system.

## Request authority

Send exactly one `Authorization: Bearer TOKEN` header, with no cookies. Query/form tokens, malformed or duplicate authorization, mixed cookie/bearer requests and nonmatching origin are rejected. Clients use the configured Golf origin, reject redirects and require HTTPS except the explicit local development loopback allowance. This follows the transport protections in [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750); issuance itself is not an OAuth flow.

The explicit allowlist contains the current 21 CLI/MCP reads plus `SessionService/GetSession`. API credentials cannot log in/out, create repositories/issues/comments, manage sessions, issue/list/revoke credentials or call unreviewed future procedures. Authorization runs before body decoding. Every delegated request requires an unexpired/unrevoked credential, the original live source session's exact ID/hash/owner/forge binding, and the matching current native Forgejo identity. Post-wait checks re-resolve delegation, and successful unary results receive a final native/local authority check before encoding.

Ending the issuing session invalidates all its credentials. Other still-live sessions are independent. Credential expiry/revocation denies access even while the source session remains live. Native token, membership and repository permission changes still govern each read; a Golf token does not override them. Existing OAuth session refresh can still update upstream session state, so local MCP discovery keeps conservative side-effect annotations.

## CLI and local MCP

Use `GOLF_API_TOKEN` or `--api-token-stdin` for CLI reads. Neither path opens an ephemeral browser session or calls login/logout. Never pass the secret as a command-line argument. Mixing API-token and Forgejo-token sources is rejected before reading stdin or making requests. Existing Forgejo PAT mode remains available.

For `golf mcp`, the process owner supplies exactly one of `GOLF_API_TOKEN` or `GOLF_FORGE_TOKEN`. Stdin remains reserved for protocol messages; tool arguments cannot override credentials or destinations. Both modes use the same 21 tools, bounds, cancellation guard and output contracts described in [the MCP contract](MCP_CONTRACT.md).

## Recovery and remaining scope

Schema `202610020005` preserves API credential metadata and events in encrypted offline backups. Restore deletes all source sessions before applications reopen. Retained token hashes therefore grant no authority, including after a fresh login as the same native user. A fresh session can issue a fresh credential. Recovery does not replay post-backup provider revocations; the existing operator reconciliation requirements remain mandatory.

This foundation does not complete long-lived service accounts, configurable scopes, organization/tenant roles, OAuth/device login, remote MCP authorization, ACP or named agent execution. Qualification evidence belongs in the [implementation ledger](IMPLEMENTATION_STATUS.md); source or a passing narrow test alone does not qualify these broader requirements.

## Runnable checks

`make check` includes generated-contract drift. Run the real database boundary with `GOLF_TEST_DATABASE_URL` pointing to a disposable PostgreSQL18.4 database and `go test -race ./internal/server -run '^TestApiCredential' -count=1 -timeout 90s`; it resets its own test tables. The browser fixture regression is `npm --prefix web test -- api-credentials.spec.ts` using the existing Playwright configuration.

The native CLI/MCP proof accepts explicit isolated endpoints and the disposable native container:

```sh
python3 scripts/mcp-smoke/run.py --cli bin/golf --api-credentials \
  --golf-url http://127.0.0.1:GOLF_PORT \
  --forge-url http://127.0.0.1:FORGEJO_PORT \
  --forge-container DISPOSABLE_FORGEJO_CONTAINER
python3 scripts/mcp-cancellation-check.py --cli bin/golf --api-token-mode
```

For native browser qualification, `node web/tests/api-credentials-live.mjs --target PRIVATE_TARGET_JSON` requires an already isolated core. Its target file contains `golf` (loopback origin with a non8080 port), `project` (a `golf-api-proof-` prefix) and `container` (that project's Forgejo container). The browser script creates/removes its own native user and session, checks real issuance/read-only denial/revocation/lost acknowledgment/pagination/privacy and captures secret-free layout images under ignored `.tmp`. The isolated core's owner removes its databases, volumes and private configuration afterward. None of these checks qualifies production scale, remote MCP or named agent execution.

The final native browser, CLI/MCP and encrypted-recovery proofs passed on the same exact image recorded in the ledger, in an earlier native qualification on a since-retired backend; they have not been repeated on Forgejo 15.0.9. The normal local core is updated to that image and its native source/session/Git/CLI regression passes. Marketing/docs remain independent static sites; no repository CI or live Cloudflare deployment was added.
