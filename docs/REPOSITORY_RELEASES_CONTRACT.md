# Current native release metadata

The integrated release slice is read-only: backend `41e26fa`, shared reader `fa64873`, registration/generated clients `41cb8ed` and canonical mounts `8e44fc0`. Bounded actual native/served qualification passes below; retained schema063 deployment and independent running verification pass (see the implementation ledger). It does not create/edit/delete releases, upload/download assets, promote artifacts or verify a tag's immutable source snapshot.

## API and authority

`RepositoryService.ListRepositoryReleases` accepts canonical `RepositoryKey`, required positive signed64 decimal `repositoryId`, and page/limit (default1/20, page≤10000, limit≤50). It returns the observed canonical key/ID, releases, next page and required decimal `totalCount`. The total comes from verified native `X-Total-Count`, never the number of loaded rows. Native page-clamp discovery and exact row/count checks refuse incomplete or inconsistent pages.

`GetRepositoryRelease` takes that same target plus a required positive decimal `releaseId`, and verifies the returned native release ID. Both use current authorized repository reads with exact native ID checks before and after the bounded 15-second operation. Authority changes, repository replacement, malformed responses and unresolved provider observations return errors with no adopted private payload. Independent native observations are not atomic or SHA-bound.

A release projects native ID, title, tag name, target commitish, Markdown notes, explicit draft/prerelease flags, created/published timestamps and optional author. Asset metadata is ID/name/size/download-count/created-time only; attachment URLs and native UUIDs are neither decoded nor exposed. Notes are bounded to128KiB each/512KiB per page; assets to100 per release/500 per page. Numeric IDs/counts remain canonical decimal strings. Native timestamps and target commitish do not establish publication authority or an exact checkout.

## Workspace

`/OWNER/REPO/releases` presents a shared searchable/sortable loaded inventory with explicit pagination. `/OWNER/REPO/releases/ID` presents notes, badges, author/time observations, a native-metadata disclosure and an asset inventory. Asset downloads are unavailable. Current `GetRepository` identity gates these pages; they do not resolve source refs or fetch repository contents. Account/target changes abort private reads, revalidation masks previous results, and denial clears observations. Reload/read/refresh never mutate releases.

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

The operator first provisions the exact fresh stack and tokenless native bootstrap. The helper enrolls two ordinary actors, creates one published release and one prerelease through supported native APIs, compares Golf list/detail metadata independently, checks wrong-ID/current reader removal, and optionally captures eight actual read-only dark/light1440/390 list/detail views. It purges only owned native fixtures and revokes/disables owned Golf accounts; the operator disposes the externally provisioned stack. Bodies/credentials are not retained in public diagnostics.

[Actual attempt1](../.tmp/repository-releases063-served-attempt1/qualification/manifest.json) passes on frozen source `b3f9e86c0612b469f320b79e215ea591bef79aac`: two actual native published/prerelease fixtures, owner/reader exact list/detail IDs, tag, body, author and times; wrong repository-ID refusal and current reader-removal404. Eight actual read-only dark/light1440/390 [list/detail captures](../.tmp/repository-releases063-served-attempt1/qualification/browser/manifest.json) pass; root inspected the dark desktop detail. The [parent receipt](../.tmp/repository-releases063-served-attempt1/parent-manifest.json) records runtime identity, owned cleanup and unchanged foreign identities. This proves the current metadata reader only, not asset downloads, release writes or a publication snapshot.

The [retained deployment](../.tmp/settings-063-final-retained-backup/receipt.json) and [independent running proof](../.tmp/settings-063-final-running-proof/manifest.json) pass on that exact component. Release write intents, assets with authorized byte reads, artifact-to-release publication, protected policy enforcement and recovery are subsequent functional gates, not implied by this metadata reader. See [local completion order](LOCAL_COMPLETION_NEXT.md) and the [implementation ledger](IMPLEMENTATION_STATUS.md).
