# Current native releases and private asset reads

The integrated slice reads native releases and bounded local asset attachments. The original metadata reader (`41e26fa`, `fa64873`, `41cb8ed`, `8e44fc0`) has its separate schema063 deployment proof below. Asset source `155f88778337bd5906697800689f226d2b96fd85` now passes fresh native/served qualification; its matched [retained deployment](../.tmp/settings-assets64-retained-backup/receipt.json) and [independent running proof](../.tmp/settings-assets64-running-proof/manifest.json) now pass at schema064. Golf does not create/edit/delete releases, upload assets, promote build artifacts or verify a tag's immutable publication snapshot.

## API and authority

`RepositoryService.ListRepositoryReleases` accepts canonical `RepositoryKey`, required positive signed64 decimal `repositoryId`, and page/limit (default1/20, page≤10000, limit≤50). It returns the observed canonical key/ID, releases, next page and required decimal `totalCount`. The total comes from verified native `X-Total-Count`, never the number of loaded rows. Native page-clamp discovery and exact row/count checks refuse incomplete or inconsistent pages.

`GetRepositoryRelease` takes that same target plus a required positive decimal `releaseId`, and verifies the returned native release ID. Both use current authorized repository reads with exact native ID checks before and after the bounded 15-second operation. Authority changes, repository replacement, malformed responses and unresolved provider observations return errors with no adopted private payload. Independent native observations are not atomic or SHA-bound.

A release projects native ID, title, tag name, target commitish, Markdown notes, explicit draft/prerelease flags, created/published timestamps and optional author. Asset metadata is ID/name/size/download-count/created-time only. The metadata API exposes neither native UUIDs nor attachment URLs; the download reader uses a separately verified UUID privately. Notes are bounded to128KiB each/512KiB per page; assets to100 per release/500 per page. Numeric IDs/counts remain canonical decimal strings. Native timestamps and target commitish do not establish publication authority or an exact checkout.

## Workspace

`/OWNER/REPO/releases` presents a shared searchable/sortable loaded inventory with explicit pagination. `/OWNER/REPO/releases/ID` presents notes, badges, author/time observations, a native-metadata disclosure and an asset inventory. Assets of 0–10485760 bytes have an explicit **Download asset NAME** link; larger entries remain metadata with the stated 10 MiB limit. Current `GetRepository` identity gates these pages; they do not resolve source refs or fetch repository contents. Account/target changes abort private reads, revalidation masks previous results, and denial clears observations. Reload/read/refresh never mutate releases.

## Managed local attachment contract

`GET /api/repositories/OWNER/REPO/REPOSITORY_ID/releases/RELEASE_ID/assets/ASSET_ID/download` accepts a current managed browser cookie only. IDs must be canonical positive signed64 decimals. Authorization headers, query strings, cross-site fetches and a foreign Origin refuse 403; missing sessions refuse 401, malformed identity 400, and wrong original repository/association or current privacy denial 404. Unresolved/malformed native observations and redirects refuse 503; oversize refuses 413. Error responses carry no asset metadata or bytes.

The reader verifies current actor/session, exact canonical repository/native ID and owner, and release-to-asset association before fetching. Native asset ID, UUID, name, size and created time are reobserved after buffering; current repository/owner and read authority are checked again before response headers. Native draft visibility is enforced by the exact release-asset API. These independent observations are not an atomic native CAS or an immutable publication receipt.

The pinned [native asset API](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/routers/api/v1/repo/release_attachment.go) returns metadata. Bytes use the fixed repository-scoped native web route `/OWNER/REPO/releases/attachments/UUID` with server-held Bearer PAT/OAuth authentication; the API PAT `token` scheme is not substituted for that web authentication. No user-supplied URL, query credential, redirect, ServeDirect or remote-provider download grant is accepted. Local native attachments only are qualified.

The reader buffers at most 10 MiB and requires actual byte length to match current native size, including zero. It forces `application/octet-stream`, `Content-Disposition: attachment` with a sanitized native basename, exact `Content-Length`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'`. Project HTML is downloaded, never served inline on Golf's authenticated application origin. UUIDs/URLs/credentials remain server-only; no digest header or public object URL is minted.

Native `download_count` legitimately increases during a byte read, including before some storage failures. It is current metadata, excluded from immutable asset comparisons. The independently compared SHA256 below describes fetched fixture bytes; native metadata supplies no trusted content digest, and the observation proves neither tag source nor release publication authenticity.

## Runnable evidence and next acceptance

The [actual PostgreSQL/race checks](../.tmp/repository-releases-postgres-attempt1.log) pass2.765s with the owned database removed, including current authority, replacement, actor/logout and wrong-release refusals. Source UI fixtures remain distinct from served evidence.

Prepared [release helper](../scripts/repository-releases-smoke.py) and [browser helper](../scripts/repository-releases-browser.mjs) have pure scope/receipt and syntax checks and the bounded runtime proof below:

```sh
python3 scripts/repository-releases-smoke.py --self-check
node scripts/repository-releases-browser.mjs --self-check
python3 scripts/repository-releases-smoke.py \
  --stack-root "$STACK_ROOT" --project "$OWNED_MERGEOBS_PROJECT" \
  --compose-file "$FRESH_COMPOSE" --env-file "$FRESH_ENV" \
  --image "$EXACT_CORE_IMAGE" --source-revision "$FULL_SOURCE_COMMIT" \
  --golf-url "$OWNED_GOLF_LOOPBACK" --native-url "$OWNED_NATIVE_LOOPBACK" \
  --output "$FRESH_PRIVATE_OUTPUT" --browser
```

Add `--assets` to qualify two small native-uploaded fixtures and their authorized attachments, or `--assets --browser` to include eight actual metadata views and one explicit browser attachment download. The default recipe remains the historical metadata-only proof.

The operator first provisions the exact fresh stack and tokenless native bootstrap. The helper enrolls two ordinary actors, creates one published release and one prerelease through supported native APIs, compares Golf list/detail metadata independently, checks wrong-ID/current reader removal, and optionally captures eight actual read-only dark/light1440/390 list/detail views. It purges only owned native fixtures and revokes/disables owned Golf accounts; the operator disposes the externally provisioned stack. Bodies/credentials are not retained in public diagnostics.

[Actual attempt1](../.tmp/repository-releases063-served-attempt1/qualification/manifest.json) passes on frozen source `b3f9e86c0612b469f320b79e215ea591bef79aac`: two actual native published/prerelease fixtures, owner/reader exact list/detail IDs, tag, body, author and times; wrong repository-ID refusal and current reader-removal404. Eight actual read-only dark/light1440/390 [list/detail captures](../.tmp/repository-releases063-served-attempt1/qualification/browser/manifest.json) pass; root inspected the dark desktop detail. The [parent receipt](../.tmp/repository-releases063-served-attempt1/parent-manifest.json) records runtime identity, owned cleanup and unchanged foreign identities. This proves the current metadata reader only, not asset downloads, release writes or a publication snapshot.

The [retained deployment](../.tmp/settings-063-final-retained-backup/receipt.json) and [independent running proof](../.tmp/settings-063-final-running-proof/manifest.json) pass on that exact component. That historical receipt covers metadata only. Release write intents, artifact-to-release publication, protected policy enforcement and recovery remain separate functional gates. See [local completion order](LOCAL_COMPLETION_NEXT.md) and the [implementation ledger](IMPLEMENTATION_STATUS.md).

## Asset source and fresh served evidence (2026-10-04)

[Fresh database/race checks](../.tmp/repository-release-assets-postgres-attempt1.log) pass in 3.061s with no skipped cases and the owned database removed. They cover zero bytes, association/size/UUID/name changes, replacement/owner/actor/logout, draft denial, redirects and oversize. The [29 integrated source-browser cases](../.tmp/repository-release-assets-ui-main-attempt1.log) pass in 10.4s and combined checks pass; source fixtures are distinct from actual served evidence.

[Actual asset attempt1](../.tmp/repository-assets64-served-attempt1/qualification/manifest.json) qualifies on frozen component `155f88778337bd5906697800689f226d2b96fd85`, core `304dfcd883458cbb49e2eabbf7374a46d3a15df150960327f75fe7ab0eabeb1e`: two ordinary managed actors, two native published/prerelease fixtures, and two 22-byte assets uploaded only through supported native APIs. Independent native bytes match owner/reader Golf attachments and private response controls. Wrong repository/association/missing asset, Origin/bearer/query/cross-site/missing-session refusals, backend restart with exact current bytes, and current reader revocation pass. Uploading fixture bytes is not a Golf release-write feature.

The [actual browser receipt](../.tmp/repository-assets64-served-attempt1/qualification/browser/manifest.json) passes eight dark/light 1440/390 list/detail captures and one explicit owner attachment download with exact filename, size and SHA256; no credentials are persisted. The [parent receipt](../.tmp/repository-assets64-served-attempt1/parent-manifest.json) records exact runtime/source identity, owned cleanup and unchanged outside-project IDs/images/running flags, with lifecycle status observations separate. Earlier metadata-only063 evidence retains its original scope. Matched retained deployment and independent running verification now pass for this exact component; this proof adds bounded local reads, not release mutation, remote attachments, checksum authenticity, immutable publication, protected writes or full readiness.
