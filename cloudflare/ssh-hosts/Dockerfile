# The SSH host task container (docs/SSH_HOSTS.md): golf-agent-host for `ssh-run` and `ssh-probe`, Git for the task clone, and the
# reach helpers (Tailscale in userspace networking, cloudflared for Cloudflare Access). Build from the repository root:
#   docker build --platform linux/amd64 -f cloudflare/ssh-hosts/Dockerfile -t golf-ssh-hosts:<tag> .
# The SSHAgentTask Durable Object starts it with `sleep infinity` and runs the binary with the job on standard input.
FROM golang:1.27-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download golang.org/x/crypto golang.org/x/sys
COPY cmd/golf-agent-host ./cmd/golf-agent-host
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /out/golf-agent-host ./cmd/golf-agent-host

FROM debian:bookworm-slim
ARG TAILSCALE_VERSION=1.104.1
ARG TAILSCALE_SHA256=108d1d96ecf410d305571e173516f27038f870919a9b89c914a167c6d33a4528
ARG CLOUDFLARED_VERSION=2026.10.0
ARG CLOUDFLARED_SHA256=d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git \
    && curl -fsSL -o /tmp/tailscale.tgz "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_amd64.tgz" \
    && echo "${TAILSCALE_SHA256}  /tmp/tailscale.tgz" | sha256sum -c - \
    && tar -xzf /tmp/tailscale.tgz -C /tmp \
    && install -m 0755 "/tmp/tailscale_${TAILSCALE_VERSION}_amd64/tailscale" "/tmp/tailscale_${TAILSCALE_VERSION}_amd64/tailscaled" /usr/local/bin/ \
    && curl -fsSL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64" \
    && echo "${CLOUDFLARED_SHA256}  /usr/local/bin/cloudflared" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/cloudflared \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* /tmp/tailscale* \
    && useradd --create-home --uid 1000 golf
COPY --from=build /out/golf-agent-host /usr/local/bin/golf-agent-host
USER 1000:1000
WORKDIR /home/golf
CMD ["sleep", "infinity"]
