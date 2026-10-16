# Cloudflare managed image registry

New Golf Cloudflare demos use `registry.cloudflare.com` for image storage under
[ADR 0010](decisions/0010-cloudflare-managed-image-registry.md). Cloudflare owns
image bytes and storage; Golf owns repository identity, current CI authorization,
digest receipts and the image inventory. Existing CFCR installations and historical
evidence are preserved. Alchemy remains an optional future provisioning tool;
the existing native `cf` build/deployment path is used now.

## Configuration

Store an account-scoped **Workers Containers Write** API token in Secrets Store,
then add its reference to the installation's `forge.json`:

```json
{"registry":{"provider":"cloudflare","ci":true,"apiToken":{"store":"YOUR_32_HEX_STORE_ID","name":"managed-registry"}}}
```

The token value never belongs in configuration, Git, a frontend or a repository
job. CI requires the existing approved native test allocation. Rebuild with
`cloudflare/forge/prepare.mjs` and deploy the reviewed native output. No CFCR
Worker, registry R2 bucket or registry service binding is provisioned.

Images use `registry.cloudflare.com/ACCOUNT/WORKER-rREPOSITORY_ID:ci-JOB_UUID`.
Repository renames preserve their destination. Reusing a Worker for a new database
with reused repository IDs requires explicit migration; new installs use distinct
Workers. Golf hashes the published manifest before recording the exact-source
image receipt.

## Supported behavior and limits

- Provider pull/push credentials stay in the trusted Worker. Jobs receive only
  coordinates and brokered OCI responses; direct user credentials are unavailable.
- The broker restricts requests to the current repository, job tag and job-owned
  upload sessions. It rejects mounts, foreign tags, catalog/token access, encoded
  paths and caller credentials. Source, actor and job authority is rechecked.
- Upload continuation state persists in the workspace DO. Requests are bounded
  to 32 MiB, manifests to 1 MiB and live uploads to 64 per workspace. Interrupted
  provider uploads rely on Cloudflare's lifecycle, not CFCR's recovery contract.
- Packages reads and digest-verifies at most 20 named tags, omitting Cloudflare's
  digest aliases. It follows the tag list's `last` cursor, at most five pages of
  21 entries, until a 21st named tag or the end of the list; the inventory is
  marked truncated only when a 21st named tag exists or the list continues past
  those pages. Search/sort covers the loaded inventory only.
- Scan reports, signature verification, package retention/pull policies and
  image-derived static previews are unavailable. Source previews remain available.
  Customer-runner socketless build receipts do not implement registry publication.
- Operators with independent Cloudflare credentials can bypass Golf's checks.
  Provider Container pulls do not recheck Golf permissions. Any future deployment
  policy must bind an approved immutable digest.

## Checks and retained demos

```sh
node --test cloudflare/forge/managed-registry.test.mjs cloudflare/forge/core.test.mjs
node cloudflare/forge/runtime-check.mjs /ABSOLUTE/PATH/TO/cf
node scripts/cloudflare-managed-registry-check.mjs PROFILE ACCOUNT_ID
```

The last command builds a real scratch Docker image, publishes its config/layer/
manifest through the scoped broker, verifies downloaded bytes and the inventory,
and pulls with Docker. It uses CLI-minted credentials, so hosted Secrets Store and
native CI need separate qualification. It removes its temporary named image tag,
Docker references and private Docker configuration.

The populated-demo launcher accepts `--managed-registry --retain-demo` with its
existing human demo, evidence, container, delivery and application arguments.
Retention follows passing CI, image inventory and preview preparation. The login
email is explicitly enrolled as operations administrator; human browser acceptance
remains separately recorded. The installation survives the launcher exiting.

Preview leases still expire after four hours. Owned provider tokens expire after
seven days and require operator rotation for later registry/app provisioning.
Temporary machine admission expires independently of human login. The private
ownership receipt records exact resources and the explicit stop/recovery command.
Retained resources incur provider charges until stopped.

After retaining an installation, populate the ten reviewed public snapshots and
run their demo CI with its private ownership receipt:

```sh
python3 scripts/cloudflare-demo-seed.py /ABSOLUTE/PATH/TO/ownership.json --ci
```

The approved test image must contain the upstream build backends and smoke-test
dependencies. Builds run offline on a separate `demo-ci` branch and leave upstream
main unchanged. Each successful job publishes a wheel, source archive and JSON
report as an OCI artifact, verifies the inventory digest, and retains its receipt.
This is focused build/smoke qualification, not the full upstream workflow matrix
or runnable application containers. The retained demo stop recovery checks each
managed tag against its owned repository and recorded job before deleting it.
See the [live qualification receipt](compatibility/evidence/managed-registry-retained-demo-20261013.json).

References: [image management](https://developers.cloudflare.com/containers/guides/image-management/),
[credential API](https://developers.cloudflare.com/api/resources/containers/subresources/registries/subresources/credentials/methods/generate/).
