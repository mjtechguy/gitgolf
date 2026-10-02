# Gitea identity and role qualification

Verified 2026-10-02 UTC (2026-10-01 America/New_York), against Gitea **1.27.3-rootless** and PostgreSQL **18.4-alpine3.24**, arm64. This is evidence for the shared forge boundary in [plan §4.3, §4.7 and P0.8](../GOLF_IMPLEMENTATION_PLAN.md), and input to P1.2/P1.8. It does **not** implement Golf organizations, teams, role administration or account recovery, and does not close P0.8.

Gitea can enforce the tested organization repository grants for both infrastructure tracks. Golf must preserve per-unit permissions and additive membership semantics. Strict viewer, constrained maintainer and last-recoverable-owner guarantees need additional decisions and enforcement; replacing their names with similar Gitea labels would overstate support.

## Reproduce the evidence

```sh
python3 scripts/gitea-role-smoke.py
# If loopback port 3016 is occupied:
python3 scripts/gitea-role-smoke.py --port 3017
```

Requires Docker Compose, Git and Python's standard library. The [harness](../scripts/gitea-role-smoke.py) creates a randomly named, isolated Compose project containing only PostgreSQL and Gitea. It reuses the existing PostgreSQL initializer, creates users/organization/teams/repositories through supported CLI/API operations, and exercises ordinary Git HTTP transport. It neither connects to nor reconfigures the existing development Compose deployment.

The temporary provider listens on loopback; PostgreSQL has no published port. Provider passwords live in a temporary `0600` file; user credentials stay in memory and Git's process environment. Commands and failures do not print passwords/tokens. HTTP calls reject redirects, have 15-second timeouts and a 2 MiB response ceiling. The fixture is small and collection reads are bounded; this is not a large-directory or organization-pagination benchmark.

The successful run asserted all rows below, purged the fixture through supported interfaces, destroyed its own provider volumes, and independently checked that the project's containers, volumes and network were absent. Cleanup runs on failures too. Abrupt host/process termination can still require operator removal of that randomly named disposable project; never point cleanup at the normal Golf project.

Observed local image digests:

| Image | Observed repository digest |
| --- | --- |
| `gitea/gitea:1.27.3-rootless` | `sha256:1c17ecaead42eb3b5391553d8708103a4beb0e86edf5b9ebc1eb269c318845f2` |
| `postgres:18.4-alpine3.24` | `sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15` |

The script uses the existing version tags and checks the live Gitea version. These digests identify this run; they do not qualify another architecture or a changed image under the same tag.

## Observed permission contract

Every role actor is an ordinary, non-site-admin user with its own token. Except for the explicit scope test, tokens have `read:user,write:organization,write:repository,write:issue`, so denied operations exercise the actor's permissions rather than accidentally passing because a token lacks the route scope. A separate disposable site administrator exists only for provisioning and recovery.

| Fixture / operation | Actual result | Golf implication |
| --- | --- | --- |
| Private organization member in a team with no assigned repository; anonymous caller | Private repository GET returns `404`. | Organization membership alone does not grant every repository. Preserve explicit team-to-repository assignments. |
| Organization owner, repository admin team, code-write team | Source GET and Git `ls-remote` succeed; pushing a new branch succeeds. | These exact grants support ordinary source collaboration. No protected-branch claim follows. |
| Code-read teams, including the reporter/viewer fixtures | Source GET and Git ref discovery succeed; pushing a new branch fails. | Read/write separation works for Git HTTP and this source API. |
| Issues-write team with code disabled | Issue list succeeds; source GET returns `403`; Git ref discovery fails. | Issue permission must not be treated as source permission. |
| Code-read team with issues and pulls disabled | Source succeeds; issue list returns `404`. | Denial status depends on the unit/route. Do not convert concealed absence into a grant or an empty successful response. |
| Reporter and viewer fixtures with `repo.issues=read` | Issue creation/comment creation return `201`; editing own issue returns `201`; editing another user's issue returns `403`. | “Read” is a collaboration capability, not a guarantee of zero writes. |
| Same viewer with a separate `read:user,read:repository,read:issue` token | Issue GET succeeds; issue creation returns `403`. | Token scope can narrow this credential, but does not change the account's permissions through other credentials or interfaces. |
| Issues-write actor | Editing another user's issue returns `201`. | Moderation is a separate privilege from reporting. |
| Owner and repository admin team | Repository settings PATCH succeeds; repository admin can delete an assigned disposable organization repository (`204`). | Repository admin is too broad for a maintainer contract that forbids deletion. |
| Repository admin | Organization settings PATCH and creating an organization team return `403`. | Repository administration and organization ownership are separate API boundaries. |
| Repository admin with `repo_admin_change_team_access=false` | Both team-side and repository-side attachment attempts return `403`, including when the actor belongs to the target team. Its other member still sees repository `404`. | Keep this restriction explicit; qualify both routes on upgrades. |
| Developer also belongs to a read team, then loses the write team | Source/Git read still work; a new branch push fails. | Grants combine; removing one grant does not revoke another. |
| Developer loses its final repository-granting team | Its token still authenticates to `/user`, but repository/source GET become `404` and Git ref discovery fails. | Existing-token permission changes take effect on subsequent requests. |
| Reporter removed from organization | Issue list returns `404`; Git ref discovery fails. | Organization removal revokes these tested memberships and subsequent reads. |
| Site administrator | Reads the private repository without membership. | Site administration is an exceptional trust boundary, never an ordinary Golf role mapping. |

For general teams created with `units_map`, the response's legacy `permission` field was `none` even while unit reads/writes worked. The script verifies the returned unit map. A future adapter must not authorize from that coarse field alone. Effective permission calculations also combine team grants in the [pinned permission implementation](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/models/perm/access/repo_permission.go).

The issue behavior matches the [1.27 permissions guide](https://docs.gitea.com/1.27/usage/access-control/permissions/) and [pinned issue handlers](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/routers/api/v1/repo/issue.go). The guide's broad statement about admin teams creating teams is not the contract proved here: the tested API requires organization ownership, as enforced by [`reqOrgOwnership`](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/routers/api/v1/api.go).

The two team-link denials intentionally cover the route distinction in Gitea's [repository-side team-link advisory, fixed in 1.27.3](https://github.com/go-gitea/gitea/security/advisories/GHSA-g5jj-gp8w-73h7). This is a targeted regression proof, not a complete provider security audit.

## Role mapping decisions before implementation

These are proposed enforcement dispositions for Golf's role work, not installed roles. P1.2 must define each role as an explicit capability set, including separate organization/repository scope, before exposing it.

| Golf concept | Preserve / reject / defer | Required implementation decision |
| --- | --- | --- |
| Organization owner | Preserve the qualified Owners-team authority; defer Golf recovery guarantee. | Bind stable provider IDs, show the breadth of authority, and protect the last recoverable owner across every lifecycle path. |
| Organization admin distinct from owner | Defer exact mapping. | Define whether membership, recovery, deletion and ownership transfer are allowed. Do not grant Owners membership merely because the UI label says admin. |
| Repository admin | Preserve only where Golf explicitly grants the observed broad repository controls. | Surface deletion and access-administration consequences; keep site admin separate. |
| Maintainer | Reject automatic mapping to repository admin. | Define the necessary settings/review/code privileges. If Gitea cannot enforce the exact subset on every entry point, reject the unsupported combination or explicitly revise the product contract. |
| Developer | Preserve code-write plus separately selected collaboration units. | Test branch protections, merge authority and CI credentials before claiming protected writes; repository settings remain denied in this fixture. |
| Reporter | Preserve code-read where needed and issue-read collaboration. | Allow reporting/commenting/own edits explicitly. Do not grant issue-write solely to enable reporting. |
| Strict viewer | Reject a universal mapping to Gitea issue-read. | Source-only read is qualified; viewing issues without any issue mutation is not provided by this team mapping. A read-only token is a credential restriction, not an account-wide policy boundary. |
| Service account / agent | Defer Golf lifecycle and delegated capability implementation. | Evaluate actor grants, credential scope and operation together; no generic site-admin credential substitution. Deployment, secret administration and recovery are separate capabilities. |

Restricting only Golf's UI/API is insufficient when a broader Gitea token, Git endpoint, web session or another provider route remains usable. Any stricter Golf mapping needs the enforceable policy boundary required by plan §2.4/§4.7, or an explicit unsupported state. This qualification does not establish that such a boundary exists today.

## Recovery invariants: two distinct gaps

**Last organization owner:** removing the sole Owners member through either team-member deletion or organization-member deletion returned `500`, and a subsequent membership read confirmed that the owner remained. The [pinned removal service](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/services/org/team.go) checks the owner-team member count. The harness checks state as well as status; an arbitrary server failure would not be adequate evidence.

That count does not establish recoverability. In the same private fixture, an administrator prohibited a second user's login (its valid token then received `403`). The owner could add that account to Owners and remove itself, leaving only the login-prohibited owner. The disposable administrator restored the original owner immediately. Golf's last-**recoverable**-owner requirement therefore remains open. Concurrent removals, disabled identity providers, lost MFA and recovery credential changes were not tested.

**Last site administrator:** deleting the only active site administrator through the supported CLI was denied, with the account still present. However, that administrator could set its own `active=false` through the supported API; CLI deletion then succeeded. The harness uses this only inside its disposable provider, and verifies account absence before destroying the instance. The [deletion service](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/services/user/user.go) applies the last-admin check to active users, while the [update service](https://raw.githubusercontent.com/go-gitea/gitea/v1.27.3/services/user/update.go) handles activation separately. This is a recovery-safety gap, not a recommended production procedure or a Golf bootstrap feature.

Do not conflate these findings with unauthorized privilege escalation: both fixtures use already-authorized owners/administrators. The missing property is reliable recovery after permitted lifecycle changes. Golf must define an auditable emergency administration boundary and test deactivation, prohibition, demotion, removal, deletion and identity unlinking together before claiming that invariant.

## Remaining acceptance work

| Plan task | Next concrete obligation | Required evidence |
| --- | --- | --- |
| P0.8 | Accept an explicit role/capability matrix and inventory every alternate write path. | A supported operation matrix, unresolved mappings rejected, route/credential bypass tests; protected-write/conditional-merge and licensing work remain open. |
| P1.2 | Implement stable organization/team membership and exact role mappings. | Cross-user/organization denial, repository assignment, additive grants, per-unit settings, stale membership changes, API/UI parity and no privileged credential substitution. |
| P1.8 | Enforce recoverable-owner/account lifecycle and service identity policy. | Sequential and concurrent last-owner cases, prohibited/disabled accounts, provider unlinking, recovery loss, auditable operator recovery and actor credential revocation. |
| P1.3 | Propagate revocation through future caches/jobs/audit. | Revoked memberships deny subsequent work; running and queued operations follow documented cancellation policy; no stale private search/log/artifact exposure. |
| P2.1/P2.2 | Extend organization and collaboration operations through Golf's generated contract. | Real provider tests for the actual Golf paths, preserving these denials and immutable identity associations. Upstream capability alone is not a completed Golf feature. |

This run does not qualify SSH keys, deploy keys, LFS, personal-repository collaborator semantics, forks/visibility changes, PR/review/merge rules, protected branches/tags, repository transfer, web UI authorization, OAuth role changes, federated/MFA recovery, concurrent ownership mutations, in-flight Git revocation, or other Gitea versions. It also says nothing about Cloudflare resource permissions, deployment environments, runner secrets or agent tool policy. Those belong to their own task gates; both infrastructure tracks share the same unresolved Golf identity requirements.
