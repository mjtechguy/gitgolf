# Codex local container security profile

`seccomp.json` derives from the Apache-2.0 Moby default profile at
[`2ceae35d351c156cb5a8efc0fdc4a08cf94569d8`](https://github.com/moby/profiles/blob/2ceae35d351c156cb5a8efc0fdc4a08cf94569d8/seccomp/default.json).
The original file SHA256 is `6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6`;
its license is retained in `LICENSE.moby`.

Three appended rules allow bubblewrap's namespace setup: `mount`, `umount2`,
`pivot_root`, `unshare` only for `CLONE_NEWUSER`, and `clone` only with
`NEWUSER|NEWNS|NEWIPC|NEWPID` namespace bits (optionally `NEWNET`, without
`NEWUTS` or `NEWCGROUP`). The
upstream default-deny policy and `clone3` ENOSYS compatibility rule remain.
This extra clone argument rule supports amd64/arm64 syscall ordering only.
It is not a general Kubernetes/Cloudflare or hostile-tenant security profile.

Codex0.160.0 cannot create its workspace sandbox under the local Docker default
seccomp profile. This profile allows that inner sandbox while the outer process
remains UID1000, with all capabilities dropped, no-new-privileges, read-only root
and bounded task storage. It does not disable seccomp or Codex's sandbox, grant
SYS_ADMIN, or change the host's namespace/security settings. Host policies that
still prevent user namespaces must fail qualification rather than weaken them.

Run `python3 scripts/codex-sandbox-smoke.py --image <LOCAL_SHA256_IMAGE_ID>`.
The actual local arm64 proof verifies native workspace writes and denied auth/root
writes and sandbox TCP access. Model/auth traffic outside the command sandbox is
separate; this check does not establish a provider egress firewall or protect
credentials from every agent tool. Local named-volume credentials are private
operator state, not Golf's encrypted managed connection store.
