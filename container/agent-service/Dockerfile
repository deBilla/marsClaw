# marsClaw agent-service container — the isolated box where the agent runs
# UNRESTRICTED (runtime='container'). No real credentials live here: Anthropic
# is reached via the host LLM proxy, host tools via HTTP MCP, web via the SSRF
# egress proxy. Build context is the repo root:
#   docker build -f container/agent-service/Dockerfile -t marsclaw-agent:latest .
#
# Phase 0 finding: the SDK's --dangerously-skip-permissions refuses to run as
# root, so this image runs as the non-root `bun` user.

FROM oven/bun:1-debian

# Full agent capability inside the box: shell tools, git, ripgrep (Claude Code's
# Grep), curl, ca-certs. Add chromium/yt-dlp here in Phase 2 for browser/media.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates ripgrep curl coreutils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Deps layer (cached independently of source). The agent-service imports only
# the agent SDK + pino (via the few src/lib modules it reuses).
COPY container/agent-service/package.json /app/package.json
RUN bun install

# Source. Structure is preserved so the agent-service's ../../../src imports
# resolve: /app/container/agent-service/src/index.ts → /app/src/lib/*.
COPY src /app/src
COPY container /app/container

# Writable HOME for the SDK's ~/.claude transcript store (mount a volume here at
# run time so session resume survives container restarts).
ENV HOME=/home/bun
ENV AGENT_WORKDIR=/workspace
RUN mkdir -p /home/bun/.claude /workspace && chown -R bun:bun /home/bun /workspace

USER bun

ENTRYPOINT ["bun", "run", "/app/container/agent-service/src/index.ts"]
