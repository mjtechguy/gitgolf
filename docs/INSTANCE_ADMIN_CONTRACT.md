# Golf instance account inventory

`InstanceAdminService.ListLocalAccounts` is a read-only inventory of enrolled Golf password accounts for the configured forge. It includes enabled and disabled local accounts. This read method does not list every native user or mutate accounts. Separate password-confirmed [ordinary-account lifecycle](INSTANCE_ACCOUNT_LIFECYCLE_CONTRACT.md) and [disable](INSTANCE_ACCOUNT_DISABLE_CONTRACT.md) methods support enrollment/reset/re-enable/disable. Role changes remain operator-managed.

## Authority and transport

The caller must have a current Golf password session whose immutable local-account binding has `is_instance_admin=true`. The stored session must be unexpired, match the local credential version, and belong to an enabled account. The mapped native credential must still resolve to the exact enrolled native user ID. Golf verifies native identity and local authority before and after reading the inventory; the existing local-session interceptor rechecks authority before encoding a successful response.

A native Gitea administrator is not automatically a Golf instance administrator. PAT/OAuth sessions do not acquire Golf administration by sharing an enrolled administrator's native identity. Delegated API credentials cannot call this endpoint, including credentials issued from an administrator's password session. CLI/MCP delegated read allowlists are unchanged.

The standard Connect boundary requires POST, the exact configured Origin, an unambiguous HttpOnly session cookie, bounded decoding and `Connect-Protocol-Version: 1`. Responses use `Cache-Control: no-store`. A missing/expired/revoked session or changed native identity is denied; a valid session without the required local administrator role receives permission denied. No inventory is returned with an error. This is current-session authorization, not a new password-confirmation, MFA or step-up mechanism.

## Read contract

`POST /rpc/golf.v1.InstanceAdminService/ListLocalAccounts` accepts `{page:{page,limit}}`. Omitted/zero values select page 1 and limit 20; limits above 100 or pages above 10,000 fail. The response has `accounts` and `page.nextPage`; zero next page means this request observed no subsequent row. An overfull final permitted page fails explicitly instead of silently claiming completion.

Rows are ordered by immutable local-account ID and scoped to the server's exact configured forge URL. Pagination is a current database observation, not a stable export snapshot across concurrent enrollment or operator changes. Browser search/sort applies only to loaded rows and must be labeled accordingly.

| Field | Meaning |
| --- | --- |
| `id` | Opaque decimal local-account ID. |
| `username`, `email` | Explicitly enrolled Golf login names; email may be empty and is not an email-verification claim. |
| `nativeUserId`, `golfUserId` | Immutable native user ID and Golf identity ID, represented as decimal strings. |
| `isInstanceAdmin` | Operator-enrolled Golf role; it grants no native provider permission by itself. |
| `disabled`, optional `disabledAt` | Persisted local password-account state and disable timestamp. |
| `credentialVersion` | Decimal version used to fence local sessions after lifecycle changes. |
| `createdAt` | Persisted enrollment timestamp. There is no inferred `updatedAt`. |

The SQL projection excludes password hashes, encrypted provider credentials, encryption-key labels, cryptographic bindings, session identifiers and authentication material. The response does not infer profile/email/role data from a same-named native account.

`disabled` describes local password login only. Existing independent PAT/OAuth sessions, native sessions, Git keys and provider credentials are separate authorities. Disabled rows remain in credential-key inventory. See [local authentication](LOCAL_AUTHENTICATION.md) for the enforced lifecycle and [recovery](RECOVERY.md) for restored-account quarantine.

## Separate lifecycle authorization

The operator `ManageLocalAccount` helper is not a browser authorization API. The newer [ordinary-account lifecycle](INSTANCE_ACCOUNT_LIFECYCLE_CONTRACT.md) and [disable](INSTANCE_ACCOUNT_DISABLE_CONTRACT.md) handlers provide caller password confirmation/throttling, post-wait authority checks, exact target revisions and transactional actor history. Inventory access alone cannot authorize those writes.

`disabled_at` also covers recovery quarantine. Browser re-enablement retains the fresh-password and freshly verified matching provider-credential requirement; it is not a toggle. All administrator targets remain excluded. Last-administrator role changes, security-policy recovery distinctions and browser break-glass remain separate gates; this inventory provides none of those guarantees.

## Verification

`go test -race ./internal/server -run '^TestInstanceAdmin' -count=1 -timeout 60s` uses `GOLF_TEST_DATABASE_URL` for isolated real-PostgreSQL schemas. The tests cover transport denial, administrator versus ordinary/PAT/OAuth/delegated authority, exact configured-forge isolation, enabled/disabled pagination, metadata privacy, and withholding results after disable, reset, logout, expiry or native identity/revocation changes during a provider wait. Database-backed tests skip when the DSN is absent; a compile-only run is not qualification. Terminal evidence and native/browser checks are recorded in the [implementation ledger](IMPLEMENTATION_STATUS.md).
