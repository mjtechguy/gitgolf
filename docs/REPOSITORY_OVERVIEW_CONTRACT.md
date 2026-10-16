# Repository overview contract

The initial repository sidebar adapter reads authorized native metadata and indexed language/license observations. It supports both infrastructure tracks with AI and Cloudflare optional. It does not claim GitHub sidebar parity. See the [sidebar review](REPOSITORY_SIDEBAR_PARITY_REVIEW.md), [repository experience matrix](REPOSITORY_EXPERIENCE_PARITY.md) and [implementation ledger](IMPLEMENTATION_STATUS.md) for UI delivery and served qualification.

## API and identity

`RepositoryService.GetRepositoryOverview` accepts `repository: RepositoryKey` and `repository_id`, a required canonical positive signed64 decimal native repository ID. The response echoes that exact ID and the native canonical `RepositoryKey`; it returns description, website, topics, optional social counts, language observations and detected license IDs.

The handler validates the target before provider work and uses `withRepositoryRead`: current native caller and live Golf session/delegation are checked, native repository identity/access are observed before reading, and native repository identity/access, caller identity and local session/delegation are rechecked after provider waits. The additional metadata observation must match the original native ID and canonical name. Wrong IDs, replacement, changed authority, ended sessions and cancellation yield no overview payload. This is an observed read boundary, not a lock on membership or repository state.

The RPC has a 15-second deadline, the existing 2MiB maximum per native JSON response, the normal authenticated same-Origin RPC boundary and `Cache-Control: no-store`. It is explicitly allowlisted for read-only Golf bearer delegation. It adds no write grant or session lifecycle capability. The initial sidebar checkpoint had no dedicated CLI/MCP overview command; the later `repo overview` / `golf_repo_overview` slice validates the same exact-ID contract without source selectors (see MCP contract and ledger). No new database table, worker, cache or migration is required.

## Metadata and counts

| Field | Contract |
| --- | --- |
| `description` | At most 2048 UTF-8 bytes; text may contain normal multiline whitespace. |
| `website` | At most 1024 UTF-8 bytes; an absolute `http`/`https` URL with a hostname, no userinfo or control characters. A safe value is returned unchanged; unsafe/malformed values are omitted as an empty string. The backend never fetches it. |
| `topics` | Complete native persisted metadata array, not a loaded page. Requires a present array, at most 100 unique, trimmed, nonempty names of at most 100 UTF-8 bytes each, without controls. Missing/null, duplicate or excessive metadata fails the overview instead of becoming a fabricated empty inventory. |
| `stars_count`, `watchers_count`, `forks_count` | Optional canonical nonnegative signed64 decimal strings. An absent native count remains absent; an explicitly observed 0 remains `"0"`. Negative or malformed counts fail the metadata read. |

The pinned native converter emits the complete persisted topics JSON column as an array. These social counts are native metadata observations; they are not calculated from loaded stargazer/subscriber/fork rows. They do not certify an accessible inventory, the current user's star/watch/fork state or support for the corresponding mutations. Large values remain decimal strings without JavaScript number rounding.

## Independent language and license indexes

`languages_state` and `licenses_state` each use `RepositoryOverviewSectionState`:

| State | Meaning |
| --- | --- |
| `AVAILABLE` | The corresponding complete native response passed its bounds and shape validation. An empty array is a legitimate empty index observation. |
| `UNAVAILABLE` | The native section returned 403 or 404 while the overall repository/caller authority still passed the final checks. No section data is returned. |
| `ERROR` | A non-authority provider failure, malformed, excessive or incomplete response prevented a valid observation. No partial section data is returned. |

`UNSPECIFIED` is not a successful section state. Native 401, cancellation or deadline expiry abort the whole RPC. Final repository/caller/session denial also aborts the whole RPC, including when an optional section initially appeared unavailable. No arbitrary native error text is exposed through the section states.

`languages` comes from the supported native `/languages` endpoint's complete indexed map. The adapter accepts at most 256 unique, trimmed, nonempty language names of at most 100 UTF-8 bytes without controls. Native byte counts must be canonical nonnegative signed64 integer observations; floats, exponent notation, quoted numbers, duplicate JSON keys and aggregate signed64 overflow are rejected. Output is `{name, byte_count}` with decimal string bytes, sorted by bytes descending and then name. A percentage may only use the complete validated byte map, with zero-total handling; a bounded preview cannot be presented as a complete language distribution.

`license_ids` comes from the native repository `/licenses` endpoint where one exists. Forgejo 15.0.9's [API router](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/routers/api/v1/api.go) registers no repository-level `/licenses` route (only license templates), so the license section is not expected to populate on Forgejo: Golf maps a native 403/404 to `UNAVAILABLE` (not yet exercised against Forgejo). Where the endpoint exists, Golf accepts a present array with at most 128 unique, trimmed, nonempty IDs of at most 128 UTF-8 bytes without controls. Null, duplicates, malformed or excessive arrays produce `ERROR`, not an available empty result. An empty available result does not prove that a repository is unlicensed.

The language endpoint is a code-unit reader operation in the pinned native router; its values are a repository index. On the since-retired backend, license classification processed the default-branch `LICENSE` file asynchronously and exposed detected IDs rather than a selected-commit receipt. Language responses similarly expose indexed byte counts without the index's native commit identity or a freshness timestamp. Golf does not add a cache, but a new authorized HTTP read does not prove that the native index has already caught up with a push.

## Source and feature boundaries

The overview request contains no source selector or SHA. Metadata, language and license reads are independent current observations and are not an atomic snapshot. The sidebar must not label them as derived from the currently displayed branch, tag, historical commit or exact source tree. A read timestamp cannot substitute for an index freshness receipt. Exact source/path receipts remain governed by the [source selection design](READABLE_SOURCE_URL_DESIGN.md) and [navigator contract](SOURCE_NAVIGATOR_CONTRACT.md).

This slice has no contributor summary, release/package inventory, deployment/environment data or social mutations. A bounded commit page is not a complete contributor inventory; owner-scoped package counts are not repository package totals. Those features retain their separate acceptance criteria in the sidebar review and implementation plan.

## Evidence and remaining qualification

Main implementation commit `8f37a27a2bceae5f6824e2512d1de744b5549c06` integrates the isolated adapter packet `39208938bebe295ab50f341a8d2c7cf58ac76bf2`. Generated API SHA256 is `8b832a131ecc85cc614b0afc11f2481555a729848ad771df9177133164d7c550`. These are local source identities, not remote publication claims.

`internal/server/repository_overview_test.go` covers safe website omission/no fetch, optional unknown versus explicit0, values above 2^53, complete/empty/error/unavailable indexes, malformed/duplicate/noninteger/overflowing language counts, cardinality and payload limits, incomplete license data, required IDs, Origin/authentication before body decoding and no-store responses. Real disposable PostgreSQL tests cover wrong IDs, post-read repository replacement, native/local access loss during index waits, canceled reads returning no payload, and actual read-only bearer access without write delegation. The reviewed descriptor allowlist remains exhaustive in `internal/server/api_credentials_test.go`.

Focused source race tests pass1.544s. Final isolated PostgreSQL race coverage (`TestRepositoryOverview|TestApiCredentialBoundary|TestRepositoryUnits`) passes 2.676s; its disposable container is removed. Generation, generated drift, Go vet and whitespace checks pass. The bounded source/SQL log is `.tmp/repository-overview-final-postgres.log`, retained locally without credentials.

These source/SQL checks are distinct from the subsequent native/served checkpoint below. Earlier source/review screenshots do not qualify the new overview; final runtime identity and new captures belong in the implementation ledger.

Primary native sources: [pinned router and permission gates](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/routers/api/v1/api.go), [repository metadata conversion](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/services/convert/repository.go) and [language handler](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/routers/api/v1/repo/language.go). The license handler/updater references pointed at the since-retired backend and were removed.

## Bounded served checkpoint

Backend `8f37a27` and UI `3bc302e` with final meter correction `c35dc86` now have actual local supported-native/served proof. `scripts/source-identity-smoke.py --overview` compares native description/website/topics/counts/license/language observations, exercises wrong-ID/private denial and delegated read, captures both themes at390/1280px with measured root alignment, and clears root metadata/README/image plus file preview across two tabs on native access removal. Fixtures are purged and managed sessions revoked/accounts disabled. Final image/source, eight capture provenance, tests and explicit remaining gates are in [implementation status](IMPLEMENTATION_STATUS.md). This replaces only the earlier served-pending state; it does not make indexed metadata snapshot-bound or qualify contributors/releases/packages/CD, all native metadata edit events, rename following or CLI/MCP overview parity.
