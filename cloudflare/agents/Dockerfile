FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep python3 curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --ignore-scripts opencode-linux-x64-baseline@1.18.34 \
    && ln -s /usr/local/lib/node_modules/opencode-linux-x64-baseline/bin/opencode /usr/local/bin/opencode \
    && npm cache clean --force \
    && mkdir -p /workspace/repo /workspace/task /auth && chown -R node:node /workspace /auth
COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
USER 1000:1000
WORKDIR /workspace/repo
CMD ["sleep", "infinity"]
