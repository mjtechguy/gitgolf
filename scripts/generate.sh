#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Tools are pinned in an isolated module and excluded from runtime dependencies.
go -C tools build -o ../bin/tools/buf github.com/bufbuild/buf/cmd/buf
go -C tools build -o ../bin/tools/protoc-gen-go google.golang.org/protobuf/cmd/protoc-gen-go
go -C tools build -o ../bin/tools/protoc-gen-connect-go connectrpc.com/connect/cmd/protoc-gen-connect-go
go -C tools build -o ../bin/tools/sqlc github.com/sqlc-dev/sqlc/cmd/sqlc
bin/tools/buf lint
if [[ "${1:-}" == "--check" ]]; then
  output=$(mktemp -d)
  trap 'rm -rf "$output"' EXIT
  bin/tools/buf generate --output "$output"
  diff -ru gen "$output/gen"
  diff -ru web/src/gen "$output/web/src/gen"
  bin/tools/sqlc diff
else
  bin/tools/buf generate
  bin/tools/sqlc generate
fi
