# ADR 0002: Generated API, SQL queries and typed navigation

Accepted 2026-10-01 for the existing developer preview.

## Decision

`api/golf/v1/golf.proto` is the shared contract for existing session, repository and capability operations. Connect handlers run under chi at `/rpc`; generated Go clients serve the CLI and generated TypeScript descriptors serve Connect-Web. Health endpoints remain explicit HTTP. This retires ADR 0001's temporary application REST exception. The unpublished bootstrap REST endpoints and `golf.cli.v0` envelope are removed; consumers must move to `golf.cli.v1`. No stable public compatibility promise existed for the bootstrap.

The API uses opaque string identifiers, integral uint64 sizes, enum states and explicit optional visibility/content. Protobuf JSON uses camelCase and omits default fields; generated clients reconstruct defaults. CLI JSON emits defaults and preserves 64-bit values as decimal strings. Future published schema changes must preserve field numbers; removed numbers must be reserved. Buf lint and deterministic generated-output checks run locally, without repository CI.

Origin and opaque-session checks precede Connect decoding/decompression. Each repository operation still uses the user's scoped upstream credential. Unknown domain failures produce sanitized typed errors. These controls do not replace the future Golf tenant/organization permission model.

SQLC generates concrete `database/sql` queries over the existing goose schema and pgx stdlib driver. Transactions use generated `WithTx`; no generic repository interface or query builder is needed. Native pgx adoption remains a separate guide disposition.

TanStack Router replaces native history handling, with typed repository routes/search parameters and not-found handling. TanStack Query remains the sole server-data cache; authentication transitions cancel and clear private data. This uses the technology guide's allowed TanStack alternative: route/search typing matters to pinned Git snapshots, while one router avoids competing navigation lifecycles. Forms and broader UI components remain separate work.

## Evidence and limits

The implementation ledger records generated-output checks, actual PostgreSQL transaction/scoping/migration checks, typed-client tests, browser cases and real pinned-Gitea checks. Only existing operations are generated. OAuth, machine credentials, MCP, ACP, organization policy, jobs, runners and deployments are not implemented by this foundation. Wider service schemas will be added with their executable behavior.

References: [Connect Go](https://connectrpc.com/docs/go/getting-started/), [Connect Web](https://connectrpc.com/docs/web/getting-started/), [SQLC](https://docs.sqlc.dev/), [TanStack Router](https://tanstack.com/router/latest/docs/framework/react/overview), [guide register](../TECHNOLOGY_GUIDE_REGISTER.md).

## Qualified versions

Runtime: Connect Go 1.21.0, Protobuf Go 1.36.12, Connect-Web 2.2.0, Protobuf-ES 2.16.0 and TanStack Router 1.170.41. Build tools: Buf 1.73.0, SQLC 1.31.1 and the matching generators. `tools/go.mod` isolates Go generator dependencies from the server module; npm generator versions are locked in `web/package-lock.json`. `make generate` regenerates; `make generate-check` compares temporary Protobuf output and SQLC's native diff. Tool updates require regeneration and the stated checks; these are qualified pins, not a continuing claim to latest versions.
