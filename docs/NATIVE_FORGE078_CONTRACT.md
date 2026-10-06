# Native forge consumers078

Golf exposes these supported native1.27.3 API consumers on both infrastructure tracks. Cloudflare, AI and additional Docker execution capacity are not prerequisites. Native repository files/databases are never written directly.

## Wiki

Current wiki reads remain wiki-unit authorized. Create/edit/delete require a managed Golf browser session, current ordinary repository ownership/direct administration (or the existing qualified organization-owner/direct-admin rules), an enabled internal wiki, and an unarchived, nonmirror repository. A Golf/global/native site administrator does not acquire that authority through its site role.

Wiki authoring uses requested TanStack Form editors, sanitized Markdown preview, shared styles and explicit confirmation. Page edits preserve titles/slugs; renaming is unavailable. Nonempty safe UTF-8 Markdown is capped at256 KiB; commit messages at1024 bytes. Existing-page changes bind the exact opaque native slug and observed commit. Native APIs do not support atomic expected-commit CAS, so independent native writers can still race these observations.

Schema078 stores immutable actor/tenant/repository/owner/access/slug/version/UUID/fingerprint identity and append-only phase events. It retains fingerprints, not Markdown drafts or native credentials. An original dispatch is reserved and marked uncertain durably before the supported native request. Only its same-dispatch exact content/metadata/version readback can record success. Replay and inspection return that original outcome, never resend, adopt later matching native state or manufacture a new UUID. Unresolved writes block subsequent managed repository effects through the existing lifecycle gate. Destructive recovery/downgrade is not automatic.

History lists current native revision metadata. The documented revisions endpoint accepts a native page number, not a caller-selected limit; an additional page probe stops at empty history. Historical content/permalinks, wiki attachments, relative wiki image/link resolution and all wiki-unit team writers remain acceptance work.

## Packages

Repository package inventories scan bounded native owner entries and expose only versions linked to the exact currently readable repository. Package version/file reads separately invoke native package authorization; repository permissions are not substituted for registry permissions. Unlinked and other-repository packages are not exported. No owner-wide counts are represented as repository totals. Pagination/search/sorting use the shared loaded inventory rules.

Package details verify current native version identity, linked repository/owner, creator and safe metadata; file inventories retain exact IDs/sizes/SHA-256. The UI never turns native URLs into browser links. Publishing, deletion, registry credential issuance, authenticated download proxying and package manager/OCI ingress are not implemented by this read consumer. Missing package scopes/unit authorization are reported honestly.

## Organization labels

Current members can read organization labels. Only a current native organization owner can create/edit/delete; repo administration and Golf instance administration do not substitute. Changes bind the exact organization ID, original native label ID/revision, UUID and input hash, with an independent readback during the original dispatch. Labels expose name/color/description/exclusivity/archive state and share the inherited organization-label consumers already used by issue/PR metadata.

Schema078 retains immutable original label operations and events, serializes org label dispatches, and excludes another unresolved organization-label write. Unknown outcomes remain original-only inspection. Organization label CRUD is not a general grant/role editor or native atomic CAS.

## Pull mirrors

Current ordinary repository administrators can inspect native configuration, edit a1-hour–30-day interval in whole minutes, and request a native synchronization. The revision hashes exact source/configuration identity without exporting source paths or credentials. Duration equivalence is canonicalized using Go's native duration representation. Source URL/credentials and push mirrors are unavailable in this editor.

Mirror operations use an immutable original journal and the shared repository lifecycle gate. Interval success requires exact independently observed configuration readback. Synchronization success means the native queue accepted this original request; it does **not** prove completed sync, source/ref equality or successful remote access. The UI labels that distinction explicitly. Lost/invalid responses remain unknown and are never resent or adopted later.

## Projects

The pinned native Swagger inventory exposes no supported projects/board REST endpoints. Golf therefore does not claim native boards are usable through its API/UI. Private endpoints, HTML scraping and direct database writes are not alternatives. A supported contract or explicitly owned Golf project subsystem must be selected and qualified before that area becomes available.

## Evidence

The owned native qualifier is `scripts/native-forge078-source-proof.py`; it uses actual production HTTP handlers, isolated host PostgreSQL schemas and supported existing Gitea APIs, with no new Docker jobs. It checks wiki CRUD/history, original replay/inspection, linked private generic package inventory/files, organization label CRUD, mirror interval edits and synchronization queue acceptance. Every owned organization, user, repository, package and session is removed. Failed original requests are retained in receipts and fresh fixture UUIDs are used for subsequent qualification.

`TestWikiOperationJournalPostgres` covers exact success, lost/invalid receipts, stale expected versions, lost authority, unchanged replay, changed-intent refusal and immutable journal/events. Browser tests cover requested forms, previews, explicit confirmation, unknown-operation reload, denial clearing, temporary parent revalidation, shared package/label tables, honest sync acceptance and both themes/mobile widths. These source/native checks do not establish served localhost deployment or close an entire plan phase.
