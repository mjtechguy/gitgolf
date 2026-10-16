# Prepared managed READ Git qualification

This packet is a runnable qualification recipe, **not actual READ transport proof** until its root-owned invocation and cleanup pass. It does not enroll WRITE, prove native/background quiescence or complete protected H/P/A/E/F enforcement, SSH, LFS, Git parity or the repository settings row.

## Frozen inputs and invocation

The initial recipe binds product source `f231fa22e00c78979bec1f98fb05fde8b71b48b4` to cached image `sha256:c7fcc575e5ad3aeba33d7b1248627015e50d33d46a8c4f78acc7e8cd6e03c55a`. It inspects those identities before startup, never builds or pulls, and uses separately cached official `codeberg.org/forgejo/forgejo:15.0.9-rootless` (pinned by digest) and `postgres:18.4-alpine3.24` image IDs. A 2 GiB Docker VM free-space floor precedes creation of the fresh `golf-gitread-10hex` project. A fresh private output directory contains only a closed metadata manifest. A separate 0700 temporary directory contains environment, certificate keys, stdin credentials, askpass and actual clones; it is deleted after owned cleanup.

Root first compiles the stdlib-only helper for the same architecture as the cached product image, without Docker or runtime secrets. For the current ARM64 images:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -o .tmp/managed-git-native ./scripts/managed-git-native
chmod 755 .tmp/managed-git-native
python3 scripts/managed-git-read-smoke.py \
  --image sha256:c7fcc575e5ad3aeba33d7b1248627015e50d33d46a8c4f78acc7e8cd6e03c55a \
  --native-helper .tmp/managed-git-native \
  --output .tmp/managed-git-read-served
```

`--stack-root` selects the Compose/CLI source directory when launching from an isolated worktree. The helper's actual ELF architecture and SHA-256 are observed independently; a Mach-O host build or mismatched architecture is refused. No helper/image registry fallback exists.

The fresh override removes native host ports **before initial startup**, disables native SSH/native Actions, and leaves WRITE incarnation blank. Only random loopback Golf browser HTTP and direct TLS ports are published. The existing direct TLS listener uses a disposable own CA and an IP SAN for 127.0.0.1; TLS1.3 and wrong-hostname refusal are checked. No client certificate is required: this is server-authenticated TLS, not mTLS. Ordinary RPCs retain their configured HTTP/cookie/Origin boundary. Smart HTTP requires actual `r.TLS`, with the loopback exception disabled. Its work-context upper bound does not extend the existing 20-second read/30-second write listener deadlines.

## Supported fixture boundary

Native bootstrap/purge and Golf account enrollment/disable use the supported CLIs. Their secret output is captured privately, never logged. The readonly-mounted helper accepts one bounded stdin JSON envelope and targets only `http://forgejo:3000`. It refuses redirects, proxies, unowned project actors/repositories, unknown body fields, arbitrary native URLs or unknown methods/routes. Before any authenticated non-user request it independently reads the current native user and requires a project-owned actor. It has no native filesystem, database or reference write facility. The fixture's ordinary owner creates the private repositories, one bounded source file and reader collaboration through supported APIs; the site administrator has no ordinary repository grant.

The helper limits input to 1 MiB and success JSON to 2 MiB, with a 15-second whole call deadline. Provider error bodies are never emitted. Authenticated JSON responses exist in process RAM only. The launcher prints fixed stages and error classes; no tokens, random passwords, native errors, pack bytes, source bodies, Git output or private request URLs go into artifacts. Git receives an opaque Golf READ token from a 0700 askpass script reading a 0600 temporary file, never a URL/environment secret or persistent credential helper. Host Git global/system configuration and inherited Git/proxy/auth environment are excluded.

## Required actual predicates

1. Observe exact product/native/database image and source receipts, current native version `15.0.9+gitea-1.22.0` (Forgejo's reported version string), no native host bindings and the explicit SSH/Actions-disabled configuration. These observations describe this fresh topology, not installation-wide proof that every possible ingress/background writer is mediated.
2. Ordinary personal owner and ordinary read-only collaborator each issue their own READ credential. The reader stays `read` and succeeds without becoming an administrator. Own credential inventories do not expose another user's metadata and another user's revoke is refused.
3. Actual host owner and reader clones, fetch and ls-remote use Golf HTTPS and issued capabilities. HEAD equals the independent native branch commit. Complete native commit-resolved root inventory (explicit first page, exact total count and no truncation) entries match actual Git path/mode/type/blob IDs, and Git hashes each downloaded file. Native root tree `sha` is a commit-resolved receipt in this pinned provider; it is not misreported as the true tree OID. The clone's actual `HEAD^{tree}` is recorded separately. This bounded fixture qualifies 40-character objects only.
4. Native administrator without ordinary access, Golf global administrator without native access, wrong repository identity, cross-target capability, Origin, cookie, malformed query, plaintext Git, read API bearer lifecycle calls and READ-as-receive are denied. WRITE issuance stays unavailable; native HEAD is independently unchanged by those denials. No native receive dispatch or protected-write completion is inferred from a denial alone.
5. Explicit credential revocation and parent logout survive core restart. A later browser login does not reactivate the former session's Git credential. A fresh authorized reader credential succeeds.
6. After a successful advertisement, remove reader native access and require the later upload request and host fetch to fail without private pack/source bytes; restart retains denial. Restore the ordinary grant through the owner API before cleanup. This is **serial movement between advertisement and upload**, not a deterministic in-flight byte-boundary revocation race or erasure of a previously authorized clone.
7. Rename the native repository and create a replacement under its former name. The original immutable target/capability cannot read the replacement. Delete that owned replacement and restore the original name with supported APIs; the current original capability becomes usable under the original identity again.
8. Runtime and topology identities remain stable. Original failure stage survives cleanup errors. Revoke API credentials, logout/revoke managed sessions, disable local accounts and purge owned native actors; remove only this project's containers, networks and volumes and independently verify zero project-labeled resources. Immutable Golf credential/account metadata is retained until those fresh volumes are removed; no retained installation is changed.

## Source checks

`python3 scripts/managed-git-read-smoke.py --self-check` checks independently expected packet length, full native/Git entry correspondence counterexamples, current credential scope and private manifest failure preservation without Docker, HTTP, listeners or native operations. `go test -race ./scripts/managed-git-native` and package vet check strict owned-path/body/envelope/current-actor admission without network operations. Actual runtime matrix, TLS, clone/fetch, current role loss and cleanup remain pending until root records a successful invocation.

Primary pinned references: [native Git HTTP handler](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/routers/web/repo/githttp.go), [tree API including pagination/truncation](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/routers/api/v1/repo/tree.go), [supported native account bootstrap](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/cmd/admin_user_create.go), and [Git smart HTTP](https://git-scm.com/docs/http-protocol).
