# Disposable native operation boundary fixture

Initial `P0.8-BOUNDARY-1` implementation slice, 2026-10-03. This is an executable fixture, **not Golf's production transport, a protected publisher, complete mediation, or closure of P0.8**. Both tracks retain the same portable-core safety requirement. It advances the first task in the [protected integration design](PROTECTED_MERGE_IMPLEMENTATION_DESIGN.md), with the [mutation inventory](GITEA_MUTATION_BOUNDARY_INVENTORY.md) remaining the full required scope.

## Run and isolation

```sh
python3 scripts/protected-boundary/test_classifier.py
python3 scripts/protected-boundary/qualify.py --port 3026
```

Run the native command only while other native qualifications/deployments are stopped. It creates a unique `golf-boundary-proof-*` Docker Compose project, fresh PostgreSQL/provider volumes and separate private/client bridge networks. The provider and database have **no published host ports**. Only the standard-library fixture broker publishes its selected loopback port. Existing Golf services, accounts, repositories, databases and configuration are not changed.

The provider joins only the internal private network. The broker joins private and client networks. An ordinary probe container joins only the client network. Provider bootstrap/reconciliation use separate, explicitly privileged transient private-network clients and supported Gitea CLI/API operations; these are operator access, not an admitted ordinary-client path. No forge database/repository/ref files are edited. The source commit is generated in the fixture's own temporary Git clone and published through supported Git HTTP transport.

The harness verifies native version `1.27.3`, records the actual image IDs/repository digests and Git version, checks selected settings from its own disposable provider configuration privately, and purges the native actor/repository before removing all fixture containers, volumes and networks. PostgreSQL passwords use a temporary `0600` environment file. Tokens stay in process memory/stdin/environment, never command arguments, intent files or logs. The broker logs only fixed denial labels. Fixture intent contains routing, native IDs and exact object identities, with no credentials.

This establishes isolation for the tested ordinary Docker client peer and loopback topology. It does not prove Linux host firewall isolation, Kubernetes NetworkPolicy, multi-node networking, a Cloudflare Container deployment, or denial to a trusted operator with Docker/private-network access. A privileged operator must suspend protected eligibility before direct provider intervention in a production design.

## Complete admitted fixture inventory

Only exact raw origin-form paths for the declared `boundary-owner/source` repository are admitted. Percent-encoded forms, dot segments, double slashes, absolute-form targets, extra query parameters and duplicate service queries are denied rather than normalized into an allowed route. Original HTTP request lines are checked before dispatch because Python's HTTP parser normalizes leading double slashes. Only HTTP 1.1 requests with the selected exact Host are admitted.

| Method and target | Fixture semantics |
| --- | --- |
| `GET /api/v1/version` | Exact metadata read after a supported native `/api/v1/user` credential check; the public version endpoint alone does not prove authentication. |
| `GET /api/v1/user` | Exact caller-authorized current-user read, retaining native credential/scope/signature/expiry validation. Actual PAT and Bearer-PAT reads are qualified; OAuth JWT lifecycle is separate pending work. |
| `GET /api/v1/repos/boundary-owner/source` | Native caller-authorized repository metadata. |
| `GET /api/v1/repos/boundary-owner/source/branches/main` | Native caller-authorized branch observation. |
| `GET /boundary-owner/source.git/info/refs?service=git-upload-pack` | Native smart-HTTP read advertisement. |
| `POST /boundary-owner/source.git/git-upload-pack` | Native authorized object read, exact upload content type and bounded body. This fixture does not expose arbitrary native GETs. |
| `GET /boundary-owner/source.git/info/refs?service=git-receive-pack` | Native push advertisement only; protocol extensions are denied. Advertisement is not publication authority. |
| `POST /boundary-owner/source.git/git-receive-pack` | Exactly one immutable fixture-declared `[old,new,refs/heads/feature]` update, with exact receive content type, SHA-1 object IDs and PACK framing. Current supported native repository read must match expected native owner/repository IDs before dispatch. |

The receive parser accepts the pinned Git client's normal leading capability space after NUL and only the individually enumerated report-status/report-status-v2, side-band-64k, quiet, ofs-delta, object-format=sha1 and bounded Git agent token forms. It denies atomic/push-options/unknown capabilities, control/ambiguous capability spacing, a second update command, deletions, tags, other branches, AGit refs and mismatched old/new objects. The native receiver still validates the pack; checking the PACK marker is not object validation. The harness independently proves the declared candidate descends from its expected old object before authorizing that fixture intent, then sends an explicit `--force-with-lease=refs/heads/feature:OLD` and independently reads native branch state back.

All unspecified API, native web, settings, review, merge, OAuth, LFS, wiki, package, credential and internal routes remain denied. There is no blanket bearer/cookie proxy or method-only allowlist. PAT/Basic formats are bounded; native endpoints retain actual credential/permission decisions. Bounded RFC-style Bearer headers are now admitted for the exact declared API reads, with native authentication retaining actual validity, scope and expiry decisions. Bearer Git transport remains denied until separately qualified. Empty credentials and invalid credentials cannot obtain the version read. Sudo, method-override, forwarded/rewritten authority, duplicate headers, transfer encoding and invalid/oversized Content-Length are denied. Ordinary admitted bodies are at most 2 MiB; forwarded responses are at most 8 MiB. Larger repositories/protocols are deliberately outside this initial fixture.

An in-memory one-shot flag prevents the same broker process issuing another receive after its first dispatch. **It is not a durable reservation, not restart-safe, and not proof that a timed-out accepted native write stopped.** No production code may use this flag to implement takeover, exactly-once publication, or release of an uncertain operation. The actual fixture is one short-lived broker and one declared publication, with no concurrent admission experiment yet.

## Native proof and observed toolchain

The successful native run records these image IDs and repository digests for this machine; tags alone do not establish those identities on another host:

| Image | Observed ID / repository digest |
| --- | --- |
| Gitea 1.27.3-rootless | `sha256:1c17ecaead42eb3b5391553d8708103a4beb0e86edf5b9ebc1eb269c318845f2` |
| PostgreSQL 18.4-alpine3.24 | `sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15` |
| Python 3.12-alpine broker/probe | `sha256:d09d15e60962ca365d1cd544a48773bac9d33f2fb1b00f2aa0deec78ade7dc31` |

Local Git is `2.39.5 (Apple Git-154)`. The current standard-library test corpus has six methods: five table-driven classifier methods, including narrow current-user/Bearer syntax, denied Bearer Git and denied credential/query/settings variants, plus a local Git pack generation/strict-validation case for the replay body. The latter uses a temporary Golf-owned Git repository with no provider/network/container/real credentials. Git is required for that case. Both initial and expanded native qualification pass on the recorded images, with a fresh private repository and a non-admin ordinary actor. They prove:

- Mediated clone and upload-pack fetch work with real native credentials; current metadata/native IDs are observed.
- API contents/protection/mirror writes, web editor/merge, internal endpoints, unknown/encoded routes, method overrides and alternate Host are denied; unsupported branch, multiple-ref and deletion pushes do not change the feature ref.
- Exact raw double-slash/dot/encoded/absolute targets, duplicate Host/Content-Length, transfer encoding and invalid/oversized Content-Length are denied at the running broker.
- An ordinary client-network peer cannot connect to provider DNS/IP on HTTP 3000, internal/direct-port paths or SSH 22/2222. The provider exposes no host port, and a separate private-network probe also observes SSH 22/2222 refused.
- Exactly the declared fast-forward feature update publishes the selected candidate; independent native branch readback matches it, `main` remains at the selected old object, and a supported mediated fetch reads the same candidate.
- Supported native API/CLI cleanup removes the actor/repository; Docker cleanup leaves no fixture-labeled containers, volumes or networks.

The fresh configuration explicitly disables SSH, native LFS, Actions, mirrors, custom Git hooks and create-on-push. These selected settings and the fresh fixture's observed effects are evidence for this narrow topology; they are not inventory/quiescence proof for an existing installation. Native post-receive bookkeeping still exists. No source/imported workflow, inference or remote organization write runs. Local detailed proof is retained in ignored `.tmp/protected-boundary-qualification.log` and `.tmp/protected-boundary-extended-qualification.log`; reproducible checked-in commands carry the acceptance criteria.

### Expanded native proof passes

The extended qualifier passes actual broker repository/main metadata receipts, current-user PAT and Bearer-PAT readback, invalid native Bearer denial, deliberately wrong native repository/owner IDs before publication, and a second receive of the same declared old/new/ref after successful publication. Its replay body contains a bounded real Git pack generated in the Golf-owned temporary clone; it is not a capture or a claim of byte-identical wire representation to Git's initial push. A normal up-to-date `git push` would send no receive command, so it would not establish this replay denial.

Both wrong-ID attempts return 403 and leave the feature ref unchanged; the subsequent ordinary supported Git push succeeds, proving those refusals did not consume the in-memory dispatch slot. After the real push, the replay returns 403 and independent native feature/main readback remains unchanged. Fixed broker diagnostics confirm the repository-identity and already-dispatched denial classes. The serialized expanded run exits 0 and native/Docker cleanup passes. Existing expected repository/owner binding stays required. Current-user read syntax does not create a new publisher authority; a same-process one-shot flag still supplies no durable/restart fence.

## Required next steps remain open

1. Complete `BOUNDARY-1`: qualified Golf local email/password login and exact OAuth consent, exchange, refresh, grant revocation, MFA/recovery behavior; additional classified operations; real portable Helm and Cloudflare topology, hostname/ingress/peer/credential variants. The current fixture still cannot replace Golf's configured forge URL: narrow current-user/Bearer-PAT reads pass, but other current typed Golf forge operations are not admitted, and OAuth authorize/grant/token/revocation routes remain denied. Prove legitimate Golf login/session expiry/revocation and actual OAuth JWT lifecycle before integration; do not expose a blanket auth namespace. A Bearer PAT read is distinct from an actual OAuth grant/refresh proof.
2. `ADMISSION-1`: durable before-dispatch reservations/immutable fingerprints, stable native identities and source/base/review/policy/membership conflict domains. Races, database loss and broker restart must not free issued or uncertain operations.
3. Background eligibility: existing schedules/mirrors/imports, async PR/review tasks, custom hooks and credentialed workers need supported inventory, quiescence and effective-write ordering. Fresh disabled configuration does not settle this.
4. Full Git capability scope: authenticated protocol-aware SSH, ordinary multi-ref/force/delete/tag/wiki/AGit/create-on-push policy, LFS, SHA-256, large/streaming transport and upload/archive variants require their own classification and tests. Disabling SSH here does not fulfill required SSH parity.
5. Exact merge/squash/rebase/fast-forward candidates, trusted producer/reviewer evidence, supported native finalization, private-fork identities and coordinated uncertain-publication recovery remain required. Current native success statuses are untrusted observations.
6. Credential/evidence expiry at the effective accepted native write remains unresolved. An ingress classifier, client timeout, new SQL epoch or one-shot flag cannot fence an already accepted native child. Strict expiry/revocation semantics need qualified provider-side enforcement or an explicitly accepted operation-authority contract; no silent grandfathering. Existing coordinated-recovery refusal is unchanged; the new [human-review journal034](PULL_REVIEW_MUTATION_CONTRACT.md) also requires fresh coordinated recovery proof.

The next boundary increment must establish and admit only the minimal current Golf session/OAuth lifecycle, then prove legitimate login/refresh/revocation alongside denied settings/credential routes. Keep those tests distinct from subsequent SQL-loss/restart/accepted-write admission tests; none is supplied by a serial publication proof.

The fixture composition is useful on either track: Docker/Kubernetes remain the portable implementation target, while Cloudflare networking/storage can back a deployment after the same native isolation/admission proof. Cloudflare products do not replace the missing Git effective-write fence.

Pinned protocol references: [Gitea Git HTTP handlers](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/web/repo/githttp.go), [native PAT/OAuth Bearer authentication](https://github.com/go-gitea/gitea/blob/v1.27.3/services/auth/oauth2.go), [native SSH command dispatcher](https://github.com/go-gitea/gitea/blob/v1.27.3/cmd/serv.go), [mirror settings](https://github.com/go-gitea/gitea/blob/v1.27.3/modules/setting/mirror.go), [environment-to-INI mapping](https://github.com/go-gitea/gitea/blob/v1.27.3/cmd/config.go), [Git 2.39.5 send-pack capability/command framing](https://github.com/git/git/blob/v2.39.5/send-pack.c), [Git push expected-object lease contract](https://git-scm.com/docs/git-push).
