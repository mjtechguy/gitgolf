# Native wiki read workspace

The portable Golf UI exposes a conditional Wiki tab, compact shared DataTable page inventory, sanitized shared Markdown rendering, raw-source toggle, latest page metadata and a read-only typed API. Both infrastructure tracks use this same supported native adapter. AI and Cloudflare are unnecessary.

Canonical URLs are `/OWNER/REPO/wiki` and `/OWNER/REPO/wiki/PAGE`. The page selector preserves the native encoded web segment as opaque metadata. Percent escapes receive the browser route's additional encoding layer; the route removes that layer once and sends the original native segment to the API. For example native `100%25-Free-%E9%9B%AA` becomes Golf `/wiki/100%2525-Free-%25E9%259B%25AA`. It is not reconstructed from the display title. Extra path components, malformed escapes and conflicting selectors refuse.

Current native wiki-unit authority is enforced by supported Wiki endpoints independently of code permission. Repository identity, internal wiki configuration, page metadata/HTML association and current session/provider authority are repeated after waits. External wiki URLs are never followed. Missing/uninitialized and denied wiki endpoints remain unavailable; a native404 is not fabricated into an empty inventory. Only a valid native empty collection establishes an empty loaded page.

Native list totals include Git entries that may be filtered out of the wiki page result. Golf uses native continuation but labels search/sort/pagination as loaded entries and does not claim that total as the wiki page count. Duplicate/changing inventories or page receipts refuse. Page reads observe the current native wiki, not an immutable historical Git checkout.

Preview content is bounded to256 KiB and safe UTF-8 Markdown. The native API returns an empty body both for truly empty pages and omitted oversized blobs. Golf preserves this ambiguity as unavailable content; it does not manufacture verified empty Markdown. Native sidebars/footer, relative wiki-link/image resolution, historical revisions and attachments remain separate work.

Create/edit/delete are unavailable through Golf in this slice. The native endpoints exist, but the existing primary-source and numeric discussion journals do not safely describe wiki slug/SHA identity or native path conversion. A dedicated qualified write contract must preserve original intent, exact current wiki-unit writer authority, source/content receipts and unknown-outcome inspection before those controls are exposed. No migration077 or future write subsystem is scaffolded.

Checks:

- `GOLF_TEST_DATABASE_URL=… go test -race ./internal/server -run '^TestWiki' -count=1` exercises isolated PostgreSQL, supported native boundaries, unit denial after waits, changing/foreign metadata, malformed content and body ambiguity.
- `GOLF_TEST_DATABASE_URL=… python3 scripts/repository-file-writer-native-proof.py --wiki --stack-root /path/to/retained/golf-git --output /private/new/output` exercises production HTTP reads against pinned native1.27.3 with disposable users/repository and isolated schemas. Actual reader inventory, Unicode/percent segment, exact Markdown, empty-content ambiguity and revocation pass. No Docker resources are created or restarted; native fixtures are purged.
- `npm exec -- playwright test tests/repository-wiki.spec.ts tests/repository-wiki-route.spec.ts --workers=1` exercises canonical click/reload/back navigation, conditional units, bound identities, loaded table controls, sanitized Markdown/raw disclosure, ambiguity, current denial and font-loaded mobile themes. Source-browser tests do not prove served-runtime deployment.

Primary contracts: [pinned native Wiki API](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/routers/api/v1/repo/wiki.go), [native page schema](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/modules/structs/repo_wiki.go), [native opaque path conversion](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/services/wiki/wiki_path.go).
