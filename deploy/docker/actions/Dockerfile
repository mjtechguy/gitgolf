# Trusted operator image for the bounded Ubuntu24/Node24 Actions profile.
# Put the pinned public Python release archive beside this Dockerfile.
FROM node@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS node
FROM ubuntu@sha256:561618e2c15bf2397621dd04f96926663a3b5616c189cf7e38db7e82f5c538ea
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl tar gzip unzip xz-utils libssl3t64 libffi8 libbz2-1.0 libsqlite3-0 libreadline8t64 libncursesw6 liblzma5 libuuid1 tk zlib1g && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
ENV AGENT_TOOLSDIRECTORY=/usr/local/golf-toolcache
RUN --mount=type=bind,source=python-3.14.8-linux-24.04-x64.tar.gz,target=/tmp/python.tar.gz \
    echo 'fa74abc70a55c10f6631967784878704eef81bbde9b8ec27469534f6ba997cb3  /tmp/python.tar.gz' | sha256sum -c - && \
    mkdir /tmp/python-install && tar -xf /tmp/python.tar.gz -C /tmp/python-install && \
    cd /tmp/python-install && LD_LIBRARY_PATH=/usr/local/golf-toolcache/Python/3.14.8/x64/lib bash ./setup.sh && cd / && rm -rf /tmp/python-install && \
    echo /usr/local/golf-toolcache/Python/3.14.8/x64/lib > /etc/ld.so.conf.d/golf-python.conf && ldconfig && \
    /usr/local/golf-toolcache/Python/3.14.8/x64/bin/python --version
RUN node --version && git --version && id ubuntu
ENV PATH=/var/run/act/home/.local/bin:/usr/local/bin:/usr/bin:/bin
