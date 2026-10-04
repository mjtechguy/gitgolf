# Readable source URL qualification matrix

Prepared 2026-10-03. RS-2 implements readable branch/tag addresses on the RS-1 exact-object foundation. This document specifies evidence needed; it does not claim the new resolver or browser packet has passed. No native fixture, login, deployment or inference was performed for this review. The implementation owners retain their source/test files.

## Required behavior and evidence boundary

Ordinary `/OWNER/REPO/tree/main/src` and `/blob/release/README.md` addresses remain readable. An accepted selection pins one native repository ID, typed ref and full commit for all loaded source consumers. Copy permalink emits an immutable full-commit address. Latest explicitly resolves the same typed named selection again. Source revalidation, focus/reconnect and SSE must not silently move the accepted snapshot. Reload or a fresh readable entry may resolve the current ref; the visible commit explains that distinction.

GitHub documents branch-head file views, tag identifiers, separate commit permalinks and line/range links. These are the UX target, not evidence that Golf may copy GitHub's ambiguous-ref precedence. See [permanent links](https://docs.github.com/en/repositories/working-with-files/using-files/getting-permanent-links-to-files). Existing [RS-1/RS-2 design](READABLE_SOURCE_URL_DESIGN.md) and exact source/image contracts remain authoritative.

The frozen planned suffix wire extends ResolveRepositorySource with mutually exclusive `suffix` versus `selector`/`path`. Response resolution is RESOLVED or AMBIGUOUS. A unique suffix result has one candidate plus matching top-level selection/path; ambiguity returns all checked candidates without an invented top-level selection/path. Typed resolution has no suffix/candidate collection. Each candidate contains its typed selection and literal source path. UNSPECIFIED is invalid as a successful new suffix receipt. The browser must validate this shape, repository identity, reconstructed suffix, full IDs and uniqueness before displaying a candidate or reading content.

Initial policy is 4096 UTF-8 suffix/path bytes, existing 1024-byte ref validation, at most 32 valid split positions/64 logical branch/tag jobs, pool concurrency four, and an overall 15-second server deadline. Positive candidates also require exact commit and named-ref reobservation calls, so 64 is **not** a total HTTP request claim. Malformed, oversized, timed-out or canceled checks remain unresolved; they cannot establish unique selection or absence. No per-candidate source/path reads are used to disambiguate.

## Primary-source findings and fixture feasibility

Pinned native [API routing](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/routers/api/v1/api.go) provides wildcard `/git/refs/*` and `/tags/*`. The [refs handler](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/routers/api/v1/repo/git_ref.go) returns an unpaged prefix collection, with object/array output dependent on the exact filter. Golf must bound all rows and match the complete `refs/heads/NAME`, not accept a prefix neighbor. The [named tag handler](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/routers/api/v1/repo/tag.go) uses the wildcard name; annotated object and peeled source commit remain distinct. Native [short-name guessing](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/modules/git/repo_ref.go) is explicitly branch-first and can select the wrong ambiguous name. It is unsuitable as Golf authority.

Use **cross-namespace** split collisions. Branch `feature` and branch `feature/topic` ordinarily conflict within the Git heads namespace; the equivalent tag/tag pair has the same problem. Git's [reference availability checks](https://raw.githubusercontent.com/git/git/master/refs.c) reject ancestor/descendant name conflicts. Valid fixtures include branch `feature` plus tag `feature/topic`, or the inverse, and branch `feature` versus branch `feature-topic` for non-segment prefix behavior. These are source findings; installed native/proxy encoded-name behavior still requires actual supported-API evidence.

A suffix may be uniquely checked only at the observed lookup times. Before/after matching observations do not lock Git refs or detect move-away/move-back races. A negative branch lookup followed by a new branch creation is not an atomic absence proof. Document these limits rather than promising race-free global namespace completeness.

## Resolver and transport matrix

| Case / fixture | Required result | Evidence |
| --- | --- | --- |
| Unique branch `feature/topic`, suffix `feature/topic/src/app.py` | BRANCH selection and literal `src/app.py`; exact full commit; no SHA redirect | Source tests + native + served |
| Unique lightweight and annotated slash tags | TAG; tag object retained separately; peeled commit drives bytes | Independent Git/native + served |
| Same branch/tag name, different commits | AMBIGUOUS with two typed choices; no source request before choice | Source + native + served |
| Same branch/tag name, same commit | Still AMBIGUOUS; namespace identity is not deduplicated by commit | Source + native + served |
| Branch `feature` + tag `feature/topic` | Both valid ref/path splits returned | Native + served |
| Only one candidate path exists | Both refs still candidates; path existence does not choose | Source + native + served |
| Prefix neighbor `feature-topic` when `feature` absent | Neighbor is not an exact branch match | Native |
| DB-backed branch inventory lags or misses Git ref | Exact supported Git-ref lookup remains authority; no inventory completeness inference | Source; actual native only if safely reproducible |
| One namespace errors/malformed/oversize/cancels while another matches | No unique/ambiguous success from incomplete checks | Fault/source tests |
| Initial exact namespace404, final authority valid | May be observed absent; no atomic-absence claim | Native + fault tests |
| 404 after an initial positive candidate | Error/unresolved; never silently remove that candidate | Fault/source tests |
| Ref moves between lookup/commit/reobservation | Refused or unresolved; no mixed receipt | Fault tests; serial native movement is narrower |
| 32-position boundary, 33 valid splits, long Unicode byte limits | Exact configured acceptance/rejection; no truncation into uniqueness | Source boundary tests |
| Duplicate/malformed candidate names, wrong namespace/object IDs | Reject entire successful receipt | Source + browser tests |
| Wrong repository ID, replacement address, caller/session/native loss during waits | No candidate or source payload released | Real-PG/fault + native/served |
| PAT/delegated bearer/managed cookie and foreign Origin | Supported read-only boundary preserved; no write capability expansion | Source + native/served |

Do not claim64-bit native Git object support from accepting 64-character syntax alone. Keep independently qualified 40-character native objects distinct from syntax/fake-provider 64-character coverage.

## Decoding and query-selector matrix

The explicit `refKind`/`refName` selector must reconstruct exactly the decoded suffix as `refName` plus the literal path boundary. Do not choose longest prefix or repair a mismatch. A full-SHA first component denotes a permalink unless a valid explicit named selector says the ref itself has that SHA-looking name. Legacy `ref`, `path`, `branch` and `tag` aliases must not override the canonical route or conflict with its selectors.

| Input | Expected handling |
| --- | --- |
| Slash ref encoded as components versus escaped slash | Same supported logical name only where actual router/proxy behavior is proven; do not infer boundaries from `%2F` alone |
| Ref literally containing `%2F` versus ref containing `/` | Distinct names; `%252F` decodes once into literal `%2F`, not another separator |
| Unicode ref/path and literal `%`, `#`, `+`, spaces | Encode each emitted component once; decode once; fragment remains separate |
| Literal `?` in file path | Preserved as encoded path content; Git ref validation still rejects `?` in refs |
| Ref with `+`; query selector uses encoded `%2B` | Literal plus retained; query form decoding must not change it into a space |
| Malformed percent escape or invalid UTF-8 | Rejected before native/content dispatch |
| NUL/control/backslash, empty/dot/dotdot segment | Rejected without normalization into another target |
| Duplicate selector query keys, partial selector pair, unknown kind | Explicitly rejected; no silent last-value selection |
| `refKind=branch&refName=...` not matching route suffix | Rejected; no content request |
| SHA-looking branch and tag pointing away from that object | Explicit typed names resolve named commits; untyped permalink still reads exact object |
| `/blob/FULL_SHA/file#L2-L4` and Copy permalink | Exact commit/path retained on reload; valid fragment preserved; readable selector removed |

Native fixture names must pass real Git ref rules. Percent, plus, hash and Unicode can test encoding; spaces/question marks belong in literal source paths, not branch/tag fixtures. An invalid ref test is a refusal test, not evidence of supported browsing.

## Browser snapshot and privacy matrix

1. Open a readable branch, traverse a directory/file, breadcrumbs and the loaded navigator; preserve readable typed context and one accepted full commit. Open README-relative file/image links at that commit. Verify each content/image request's native repository ID and full commit, not just text or address.
2. Move the branch through supported fixture APIs. Focus/reconnect, SSE metadata revalidation and ordinary exact-content refresh must keep the accepted commit, latest-commit banner, README/image bytes, navigator, path history and Copy permalink consistent. Show an activity notice. A default staleTime 0 named resolver must not replace the accepted snapshot through automatic query refetch.
3. Click Latest explicitly. Replace all snapshot-dependent consumers only after a matching receipt; delayed old resolver/image/file callbacks cannot overwrite the new generation. Deleted/moved named refs must not fall back to default.
4. Reload/fresh entry and back/forward preserve readable addresses and selectors, with the documented current-resolution behavior. Direct immutable permalink stays exact even beside a same-named SHA branch. Per-row commit history uses its own truthful path history at the selected full commit.
5. Test ambiguity chooser focus, keyboard activation, readable selected address and no source dispatch until choice. Keep real namespace labels even when two choices have identical commits.
6. Exercise dark/light at 1280 and390/320, long slash/Unicode names, line fragments, shared control sizes and no document overflow. Reuse global layouts and existing source/navigation components.
7. Revoke native access while root README/image/sidebar and nested file/navigator tabs are open. Remove all private content/ref/path/candidate data, abort outstanding queries and fence late receipts. Logout/account switch does the same. Private source, candidate inventories and selected paths must not persist in browser storage.

## Conservative rename contract

GitHub [documents repository rename redirects](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository), including loss of the redirect when an old name is reused. This is UX reference, not Golf authorization evidence. The current fixed-native-origin HTTP client refuses redirects. Keep an old alias explicitly refused/unresolved unless a dedicated adapter is source-tested and native-qualified.

If added later, inspect only a narrowly validated same-origin supported repository route; independently authorize the destination and prove the expected original native ID before/after. Never enable generic redirect following or forward credentials to HTML/raw/Location URLs. Cross-origin, insecure-origin, malformed destination, inaccessible target, multiple hops and recreated old addresses must fail. A known old pinned workspace cannot inherit a new repository's data. Fresh navigation to a genuinely new address uses new authorized metadata rather than an old remembered ID. Alias normalization must preserve literal source selectors and never broaden private-fork access.

## Qualification record and ownership

The backend owner owns suffix/proto/generated/source tests; the browser owner owns readable routing, snapshot generation and dependent contexts; root coordinates native fixtures/deployment/served captures. This document owner performs read-only review and records gaps. Actual proof records must identify source commit, served image, native version, actor/fixture cleanup, exact assertions, relevant captures and narrower untested limits. Do not turn a fake-provider race test, serial ref move or mocked router into byte-boundary native race/proxy qualification.

All rows above are acceptance requirements pending the corresponding RS-2 evidence. RS-1 checks remain valid prerequisites; they do not close RS-2, safe rename support, protected writes, native permission/ref fences, either full infrastructure track, or the overall Golf plan.
