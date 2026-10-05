# Portable native forge completion

Source packet, 2026-10-05. This document records implemented consumers and limits, not a localhost deployment or full Gitea/GitHub parity claim.

## Release management

Golf release detail now offers explicit Edit, Upload and Delete actions, with searchable/sortable shared asset administration and requested TanStack forms. Confirmation dialogs contain only confirmations. Markdown notes can be previewed. Ordinary current repository administration is required; instance administration does not substitute.

Supported native operations: release PATCH/DELETE and release asset multipart POST/PATCH/DELETE. Tag name and target are never editable in this slice, and release deletion does not request a Git-tag deletion. Uploads are limited to256 KiB per file; the existing private download path supports10 MiB. The upload receipt reads the supported native attachment metadata and exact private downloaded bytes before success.

Every request binds original actor, repository/owner identities, current access revision, original release ID and content revision, exact kind/asset ID and a deterministic input fingerprint. Release revisions include asset identities/names/sizes and omit mutable download counters. Before dispatch, enabled releases and non-archived/non-mirror configuration are checked. Native observations are not an atomic expected-revision CAS; independent native writers remain outside Golf's exclusive lifecycle gate.

Migration074 retains immutable original operation identity and phase events, with one unresolved operation per repository. The request becomes DISPATCH_UNKNOWN durably before a supported native write. A success requires the original native response and fresh effect/current-authorization observations within that dispatch; later matching state is not adopted. Same-key submission returns historical state without resending; changed same-key input is refused. Inspection is metadata-only and never sends a write. RESERVED/DISPATCH_UNKNOWN exclude replacement operations and other managed lifecycle writes. Retained notes and file bytes are represented only by hashes, not plaintext journal payloads; browser session storage retains original non-secret operation metadata.

### Runnable source checks

- `GOLF_TEST_DATABASE_URL=<owned PostgreSQL> go test -race -p 1 ./internal/server -run TestReleaseOperation -count=1`
- `npm run typecheck --prefix web`
- `cd web && npx playwright test release-management.spec.ts`

Real PostgreSQL tests cover all five effects, semantic fingerprints, preflight authority/identity/revision refusals, uncertain native outcomes for all five kinds, no replay/replacement, retained phase events and anonymous/cross-origin/delegated-token refusal. Native HTTP in these source tests is a controlled supported-API fixture, not a real forge qualification. Browser source tests cover all five explicit controls, no bare form, original-key reload/inspection, denial, late reply after account transition and shared dark/light390/1440 layouts. Early source checks exposed and fixed the requested form reset and cache-denial reentrancy bugs; final checks must pass before deployment.

Actual pinned Gitea native/served qualification, current-schema restore and deployment remain separate gates. Wider uploads/streaming, contributor releases-unit write permissions and native pending-release lifecycle rules remain open.

Primary endpoint reference: [Gitea1.27 API](https://docs.gitea.com/api/1.27/), repository release and attachment operations.

Actual pinned native source qualification now passes all five operations through production HTTP handlers and a disposable real PostgreSQL schema: edit, exact binary upload, rename, asset deletion, release deletion, same-key replay and explicit original inspection. Independent native reads confirm effects and preservation of the original Git tag. The owned fixture actor is purged. Run `GOLF_TEST_DATABASE_URL=<owned PostgreSQL> python3 scripts/release-management-native-source-proof.py --compose-root <retained Compose root> --output <new evidence directory>` to reproduce. No new Docker jobs or service restarts occur.

This qualification corrected the exact native attachment PATCH status to201, as specified by pinned1.27.3 swagger. Earlier failed attempts remain separate evidence; an unknown outcome was never resent or relabeled. Source/native qualification still does not establish localhost deployment or served UI native acceptance.
