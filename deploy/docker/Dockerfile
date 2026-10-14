FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:24-alpine AS codex
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) package_arch=x64; native_arch=x86_64 ;; \
      arm64) package_arch=arm64; native_arch=aarch64 ;; \
      *) exit 1 ;; \
    esac \
    && npm install --prefix /opt/codex "@openai/codex@0.160.0-linux-$package_arch" \
    && cp "/opt/codex/node_modules/@openai/codex/vendor/$native_arch-unknown-linux-musl/bin/codex" /codex \
    && chmod 755 /codex

FROM node:24-alpine AS agents
ARG TARGETARCH
RUN case "$TARGETARCH" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) exit 1 ;; esac \
    && npm install --prefix /opt/agents "@anthropic-ai/claude-code-linux-$arch-musl@2.1.288" "opencode-linux-$arch-musl@1.18.34" \
    && cp "/opt/agents/node_modules/@anthropic-ai/claude-code-linux-$arch-musl/claude" /claude \
    && cp "/opt/agents/node_modules/opencode-linux-$arch-musl/bin/opencode" /opencode \
    && chmod 755 /claude /opencode

FROM golang:1.27.1-alpine AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY gen/ ./gen/
COPY engines/ ./engines/
RUN apk add --no-cache python3 && python3 engines/act/verify_upstream_source.py
RUN CGO_ENABLED=0 go build -trimpath -o /golf ./cmd/golf
RUN cd engines/act && CGO_ENABLED=0 go build -trimpath -o /golf-actions-engine ./cmd/golf-actions-engine

FROM alpine:3.23
RUN apk add --no-cache ca-certificates libstdc++ && addgroup -S golf && adduser -S -G golf golf
WORKDIR /app
COPY --from=server /golf /usr/local/bin/golf
COPY --from=server /golf-actions-engine /usr/local/bin/golf-actions-engine
COPY --from=server /src/engines/act/third_party/act/LICENSE /usr/share/licenses/golf-actions-engine/act-MIT.txt
COPY --from=server /src/engines/act/third_party/act/pkg/lookpath/LICENSE /usr/share/licenses/golf-actions-engine/lookpath-MIT.txt
COPY --from=server /src/engines/act/third_party/act/pkg/container/DOCKER_LICENSE /usr/share/licenses/golf-actions-engine/docker-Apache-2.0.txt
COPY --from=codex /codex /usr/local/bin/codex
COPY --from=agents /claude /usr/local/bin/claude
COPY --from=agents /opencode /usr/local/bin/opencode
ENV GOLF_CODEX_BINARY=/usr/local/bin/codex GOLF_CLAUDE_BINARY=/usr/local/bin/claude GOLF_OPENCODE_BINARY=/usr/local/bin/opencode
COPY --from=web /src/web/dist ./web/dist
USER golf
EXPOSE 8080
ENTRYPOINT ["golf"]
