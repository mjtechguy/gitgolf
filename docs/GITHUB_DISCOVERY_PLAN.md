# Discovery and public identity

Reviewed 2026-10-13. The chosen increment is public user/company profiles,
profile READMEs, pinned repositories, topics and repository search. It extends
the existing native runtime; it does not change the portable provider contract.

## What to borrow from GitHub

GitHub's [personal profile](https://docs.github.com/en/account-and-profile/concepts/personal-profile)
gives visitors a recognizable identity and selected work. Its
[organization profile](https://docs.github.com/en/account-and-profile/concepts/organization-profile)
uses the same pattern for a company or team. Golf should make owner identity a
first-class destination from repository headers and account/organization menus.

GitHub [organization customization](https://docs.github.com/en/organizations/collaborating-with-groups-in-organizations/customizing-your-organizations-profile)
separates public and member views. Golf's public profile is likewise distinct
from its signed-in organization workspace. Public pages must not silently reuse
account contact fields, organization membership, private counts or private pins.

GitHub [topics](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics)
connect related repositories. Golf connects existing editable repository topics
to a dedicated discovery route. Search must query all eligible records on the
server, rather than silently filtering only the first loaded page.

GitHub's [contribution reference](https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference)
illustrates why activity requires its own attribution and visibility rules.
Imported Git history is not evidence that the importing user authored those
commits. Do not manufacture contribution squares, followers or popularity for a
demo. Existing verified activity can support a later permission-filtered feed.

GitHub's [dashboard context selector](https://docs.github.com/en/organizations/collaborating-with-groups-in-organizations/about-your-organizations-news-feed)
switches a dashboard between personal and organization contexts. Golf limits its
workspace dropdown to repository inventories and organization workspaces. Public
profiles and discovery use their own headings rather than a misleading global
workspace context; profiles are top-level `/:owner` destinations.

## Implemented slice

| Surface | Behavior | Boundary |
| --- | --- | --- |
| `/:owner` | User or organization identity, published bio/location/website, sanitized Markdown README, public count | Explicit publication; account email and memberships excluded |
| Profile editor | TanStack Form, owner-only save, revision-checked writes | Personal owner or current organization owner; ordinary members cannot edit |
| Pins | Up to six repositories in chosen order | Same owner and currently public; each read removes revoked/private pins |
| `/explore` | Server-paged search over name, description and topics; exact topic filter | Public repositories only; no code search or private-result counts |
| Repository lists | Reusable Public/globe and Private/lock badges | Actual visibility on signed-in lists; anonymous lists never include private repositories |
| Public repository | Shared source browser, branches/tags, history/diffs, file finder, README, anonymous HTTPS clone | Source/history only; issues, PRs, writes, packages, artifacts, settings and previews retain existing permissions |
| Login | Path-scoped Cloudflare Access entry, signed cookie validation elsewhere | Exact issuer/audience/signature/expiry; current Golf enrollment/grants still required |

Profile Markdown is stored in D1 and edited through Golf. Unlike GitHub's special
profile repository convention, it does not create or synchronize hidden Git
repositories. Remote README images need a source-backed image context; profile
READMEs currently support sanitized text, links and Markdown structure, without
an avatar upload or arbitrary remote-image proxy. Repository README images keep
the existing validated image pipeline.

The demo publishes `mj`, `mj-platform` and `mj-labs`, and only `mj/fastapi` source.
The imported repositories retain shallow snapshots, not full upstream history.
Modern Git clones use protocol v2 so Artifacts can negotiate those shallow
boundaries correctly. Legacy v0 shallow clones are not qualified.
Both organization workspaces retain their three private repositories; a visitor
sees no private inventory. The explicit fixture is `deploy/demo/mj-public.json` (passed as `seed-public --manifest`) and
`seed-public` is separate from ordinary infrastructure deployment.

## Next increments, in order

| Priority | Experience | Reuse and acceptance gate |
| --- | --- | --- |
| 1 | Better repository About sidebar and topic navigation everywhere | Existing overview/language/license indexes; stable layout, links to topic search, no extra Git work on lists |
| 2 | Public activity and contribution history | Existing native discussion/activity records plus imported-commit provenance; public-only projection, current permission check, correct identity mapping and deletion/revocation tests |
| 3 | Public stars and saved collections | Existing repository stars API; separate public/private preference, membership-filtered results, no public leakage of private starred repositories |
| 4 | Member organization overview | Existing organization membership and repository inventory; explicit member/public switch and independently authorized README/pins |
| 5 | Community onboarding | Detect CONTRIBUTING, SUPPORT, CODE_OF_CONDUCT, SECURITY and issue/PR templates from indexed source; inherited defaults require explicit precedence and authorization |
| 6 | Discussions and announcements | Separate conversation categories, moderation, subscriptions and answer state; do not label ordinary issues as a completed Discussions feature |
| 7 | Cross-repository code search | Existing immutable source/path indexes first; permission-filtered content index only after measured demand, revocation and pagination/load qualification |
| 8 | Followers, organization verification and richer social identity | Opt-in identity publication, abuse controls and actual verification evidence; never decorative trust badges |

Community onboarding follows GitHub's
[default community health files](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file).
A future discussion surface should model the capabilities in
[GitHub Discussions](https://docs.github.com/en/discussions) explicitly rather
than imply support through a navigation label.

Forks, cross-repository PRs, CODEOWNERS, projects and release/package publishing
remain their existing roadmap/provider qualification tracks. This discovery
increment does not claim those features or complete portable/native parity.

## Density, size and speed

Use the existing TanStack Router/Query/Form stack, shared Markdown renderer and
global theme tokens. Profile/discovery code is lazy-loaded; the shared visibility
badge adds no new dependency. The identity column is 240px, pinned cards use two
columns on desktop, and repository rows use compact spacing. Mobile collapses to
one column. Flare uses the same global tokens and spacing as other themes.

Discovery performs bounded D1 queries over metadata and never clones or scans
Git to render a list. Profile pins are capped at six. Source reads keep immutable
Git/index caches and background pre-reading, but validate current repository
access before serving cached bytes. HTML and API responses are `no-store`;
hashed UI assets remain immutable. Cache public source by immutable commit only
behind the current visibility gate: a public-to-private change must stop new
reads even when content was previously cached. Already downloaded clones cannot
be recalled.

Current limits: substring search scans eligible metadata and uses bounded offset
pagination. Before thousands of repositories/high anonymous traffic, measure D1
query time and add an appropriate index/search design, rate controls and load
qualification. Do not claim internet-scale readiness from the retained demo.
The existing main frontend chunk still triggers Vite's 500 kB warning; this
increment does not solve the app-wide bundle split.

## Validation gates

Native tests cover opt-in defaults, signed-cookie checks, anonymous read/write
boundaries, stale visibility/profile revisions, private pin rejection, public
search filtering, organization owner authorization and visibility revocation.
Deployment tests cover the additive migration, schema receipt identity,
repeatability, and refusal to overwrite customized public demo profiles or
republish a repository deliberately made private. Hosted evidence must include
an anonymous HTTPS clone, private repository denial, signed-in admin retention,
profile/topic navigation and mobile/Flare badge rendering before claiming the
live demo complete.

## Agent-oriented workflow follow-up

The separate [Agent workspace proposal](AGENT_WORKSPACE_PLAN.md) applies lessons
from Anthropic’s Scion article to a Git-compatible, optional task/proposal view
and measured source/CI improvements. A first read-only native workspace now shows
existing PRs, evidence and previews. Selective inputs and execution improvements
remain staged proposals; repository storage and merge authority are unchanged.
