# Use Cloudflare's managed image registry

Status: accepted by the user, 2026-10-13; implementation and demo qualification in progress.

New Cloudflare installations use `registry.cloudflare.com` for image storage.
Golf retains repository permissions, current CI authority, exact-source digest
receipts and image inventory. Account-wide provider credentials remain inside the
trusted broker; the documented provider API does not supply repository scopes.

This supersedes the custom CFCR storage direction for new Cloudflare installs.
Preserve CFCR source, data and historical receipts until explicit retirement.
Portable Forgejo and Cloudflare Git storage remain unchanged. The managed backend
does not inherit CFCR scanning, trust, retention or per-pull policy contracts.

See [configuration and runnable checks](../CLOUDFLARE_MANAGED_REGISTRY.md).
