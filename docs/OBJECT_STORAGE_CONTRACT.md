# Private CI source storage

Golf's first S3 consumer is a bounded, immutable CI source snapshot. The maintained AWS SDK for Go v2 signs requests; Golf does not implement its own S3 authentication. The portable target is RustFS and the Cloudflare target is R2. This adapter does not move Git repositories, Gitea LFS/attachments, job logs or general artifacts into object storage.

## Adapter contract

`internal/objectstore` exports:

- `New(ctx, Config) (*Store, error)` validates configuration without creating a bucket or writing data.
- `ProbeBucket(ctx) error` performs authenticated `HeadBucket`. A successful connection test proves bucket accessibility only; it does not qualify writes, conditional creation, retention, recovery or production availability.
- `CreateBucket(ctx) error` is explicit operator provisioning. It checks for an existing accessible bucket before creating one. It is never a missing-object fallback in application requests.
- `PutImmutable(ctx, key, source, expectedSHA) error` verifies the input's SHA-256 and uploads using `If-None-Match: *`. It reads back and verifies the content after a successful upload, a precondition failure or an ambiguous response. Equal existing content is an idempotent success; differing content is a conflict. It never deliberately replaces or deletes an existing object.
- `GetVerified(ctx, key, expectedSHA, maxBytes) ([]byte, error)` bounds the response, checks its declared length when present, and verifies SHA-256 before returning any bytes to the caller.

The initial key namespace is exactly `ci-sources/<64 lowercase hexadecimal characters>.tar`; a separately configured canonical prefix may precede it. The source digest is supplied independently by trusted stored metadata and checked over the downloaded bytes. Provider metadata or an ETag is not an integrity substitute. Keys and prefixes reject traversal, aliases and control characters. Prefixes are at most 256 characters. Sources are at most 16 MiB; a caller can request a smaller read limit.

Each operation has a 30-second deadline, respecting an earlier caller deadline. The SDK makes at most 3 attempts. Conditional PUT retries retain the condition and payload; an unknown outcome is not followed by deletion or unconditional retry. HTTP redirects and ambient HTTP proxies are disabled. SDK logging is disabled, and public errors are fixed categories without provider response bodies, endpoint URLs or credentials. Context cancellation/deadline errors remain distinguishable.

`PutImmutable` requires a provider that actually enforces conditional creation. Application hash checks cannot turn a provider that ignores `If-None-Match` into an immutable store. This is also not WORM/object lock: an independently authorized operator can overwrite/delete objects, and Golf's verified reads then fail closed when their content differs.

## Configuration and credential boundary

`Config` has `Endpoint`, `Bucket`, `Region`, `Prefix`, `AccessKeyID`, `SecretAccessKey`, `SessionToken`, `PathStyle` and `AllowHTTP` fields. The endpoint is an origin without embedded credentials, path, query or fragment. HTTPS is required unless the operator explicitly opts into HTTP. Internal plain HTTP is a deployment choice, not encryption in transit.

Both static access and secret keys must be provided together; an optional session token belongs to that pair. With neither supplied, the SDK's standard AWS credential chain supports environment credentials, shared configuration and workload IAM. These are trusted operator sources, never repository-controlled input. The adapter overrides ambient SDK endpoint settings with the validated explicit endpoint, or standard AWS endpoint selection when the endpoint is empty. Region is explicit.

Typical configurations:

| Target | Endpoint | Region | Path style | Qualification |
| --- | --- | --- | --- | --- |
| Local RustFS | Operator's private RustFS origin | `us-east-1` | `true` | Pinned native adapter fixture below |
| AWS S3 | Empty for standard AWS endpoint selection | Actual bucket region | Usually `false` | Maintained SDK path; live AWS account test remains open |
| Cloudflare R2 | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | `auto` | `true` | Documented S3 subset; live R2 account test remains open |

SDK optional checksum calculation/validation is set to `WhenRequired`, avoiding automatic AWS-specific checksum assumptions across S3 implementations. Golf always computes its own full-content SHA-256. This setting is not a claim that every checksum, multipart operation or S3 feature is portable.

Buckets must remain private. The core proxies authorized source reads; workers/jobs receive no S3 access keys, public URLs or presigned URLs. Runtime credentials need only the qualified bucket/prefix operations; separate operator provisioning may need `CreateBucket`. A bucket accessibility test is not an anonymous-access or least-privilege audit.

A persisted source locator must retain its storage connection identity. Changing the active bucket/endpoint cannot silently reinterpret old source references. External object retention, configuration/key recovery and coordinated database/object restoration require their own operator procedure; the existing canonical three-service offline recovery proof does not include these objects.

## RustFS native qualification

The exact image is:

```text
rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff
```

The official image runs as UID/GID 10001. `/data` needs persistent writable storage for that user; `/logs` also needs writable storage (a bounded tmpfs is suitable for the fixture). The image starts `rustfs` through its native entrypoint. Set unique `RUSTFS_ACCESS_KEY` and `RUSTFS_SECRET_KEY` (or supported secret-file variants), `RUSTFS_VOLUMES=/data`, `RUSTFS_ADDRESS=0.0.0.0:9000` and, when the console is unnecessary, `RUSTFS_CONSOLE_ENABLE=false`. Native HTTP health is `/health` on port 9000. The fixture uses fresh credentials, a fresh named volume and an ephemeral loopback port; it does not reuse an operator bucket or normal Golf services.

Run locally after pulling the exact image:

```sh
GOLF_RUSTFS_TEST_IMAGE=rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff \
  go test -race ./internal/objectstore -count=1 -v -timeout=150s
```

The native fixture verifies authenticated bucket creation/probe, a real conditional PUT returning `PreconditionFailed` for replacement, identical replay, preservation of original bytes, eight simultaneous creates producing exactly one winner, download caps, independent SHA mismatch rejection, invalid credential denial and data surviving an actual RustFS restart. The container, volume and private credential file are removed afterward. HTTP fixtures additionally cover acknowledgment ambiguity, SDK signing/checksum settings, traversal/configuration rejection, redirect refusal, sanitized errors, caller cancellation and standard credential-chain selection.

This is a small single-node adapter qualification. It does not prove distributed RustFS availability, node/disk failure recovery, large backups, RPO/RTO, Kubernetes storage correctness, tenant isolation across storage accounts, or live AWS/R2 behavior. CI execution, scheduler authorization and source-manifest identity are separate integration checks.

## Primary references

- [RustFS 1.0.0 release](https://github.com/rustfs/rustfs/releases/tag/1.0.0) and [pinned official Dockerfile](https://github.com/rustfs/rustfs/blob/1.0.0/Dockerfile).
- [RustFS container installation](https://docs.rustfs.com/en/installation/container/docker) and [credential configuration](https://docs.rustfs.com/en/operations/credentials).
- [AWS conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html), [Go SDK configuration/credential chain](https://docs.aws.amazon.com/sdk-for-go/v2/developer-guide/configure-gosdk.html) and [SDK checksum behavior](https://docs.aws.amazon.com/sdk-for-go/v2/developer-guide/s3-checksums.html).
- [Cloudflare R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/), including current conditional PUT support and region/checksum differences.
