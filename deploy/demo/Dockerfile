# Build the reviewed base first with cloudflare/agents/Dockerfile.
FROM golf-cf-agent:demo-base
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /tmp/demo-requirements.txt
RUN python3 -m pip install --break-system-packages --no-cache-dir -r /tmp/demo-requirements.txt && rm /tmp/demo-requirements.txt
USER 1000:1000
