#!/usr/bin/env bash
# Phase 1 orchestration for runtime='container' (dev/scripted-E2E form).
# Starts the host sidecars the container depends on, then runs the agent
# container wired to them. The host broker (channels, DB, outbox drain) is
# started separately with MARSCLAW_RUNTIME=container.
#
#   Host sidecars                          Container
#   ─────────────                          ─────────
#   llm-proxy        :8765  (real cred) ◄── ANTHROPIC_BASE_URL
#   HTTP MCP         :8766  (Google cred)◄── MCP /mcp/<threadId>
#   egress gateway   :8775  (SSRF)      ◄── HTTPS_PROXY
#   agent /turn      :8770              ◄── published to host loopback
#
# All host sidecars bind 0.0.0.0 so host.docker.internal can reach them
# (loopback bind is unreachable from the container — Phase 0.2 finding).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Any Docker-CLI-compatible runtime works (Colima, Podman, Docker Engine). The
# CLI is found on PATH; override with DOCKER=... if it lives elsewhere.
DOCKER="${DOCKER:-docker}"
IMAGE="${MARSCLAW_AGENT_IMAGE:-marsclaw-agent:latest}"
TURN_PORT="${MARSCLAW_TURN_PORT:-8770}"
MCP_PORT="${MARSCLAW_MCP_HTTP_PORT:-8766}"
PROXY_PORT="${LLM_PROXY_PORT:-8765}"
EGRESS_PORT="${EGRESS_GATEWAY_PORT:-8775}"
SHARED_MEDIA="${MARSCLAW_SHARED_MEDIA:-$ROOT/data/shared}"
AGENT_HOME="${MARSCLAW_AGENT_HOME:-$ROOT/data/agent-home}"
CONTAINER_NAME="${MARSCLAW_AGENT_CONTAINER:-marsclaw-agent}"

mkdir -p "$SHARED_MEDIA" "$AGENT_HOME/.claude"

# Selective memory/persona mounts (shared with the host so it's the SAME bot) —
# never .env or data/. RO for instructions/skills, RW for memory/wiki. Added
# only if the host path exists.
CLAUDE_MD_MOUNT=""; [ -f "$ROOT/CLAUDE.md" ] && CLAUDE_MD_MOUNT="-v $ROOT/CLAUDE.md:/workspace/CLAUDE.md:ro"
MEMORY_MD_MOUNT=""; [ -f "$ROOT/MEMORY.md" ] && MEMORY_MD_MOUNT="-v $ROOT/MEMORY.md:/workspace/MEMORY.md"
SKILLS_MOUNT="";    [ -d "$ROOT/skills" ]    && SKILLS_MOUNT="-v $ROOT/skills:/workspace/skills:ro"
WIKI_MOUNT="";      [ -d "$ROOT/wiki" ]      && WIKI_MOUNT="-v $ROOT/wiki:/workspace/wiki"

# --- env / secrets (from .env) --------------------------------------------
# shellcheck disable=SC1091
set -a; [ -f .env ] && . ./.env; set +a
: "${CLAUDE_CODE_OAUTH_TOKEN:?set CLAUDE_CODE_OAUTH_TOKEN in .env (claude setup-token)}"
: "${LLM_PROXY_SESSION_TOKEN:?set LLM_PROXY_SESSION_TOKEN in .env}"

log() { printf '[run] %s\n' "$*" >&2; }

# --- host sidecars ---------------------------------------------------------
start_sidecar() {
  local name="$1" port="$2"; shift 2
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    log "$name already listening on :$port — reusing"
  else
    log "starting $name on :$port"
    "$@" >"$ROOT/logs/${name}.log" 2>&1 &
  fi
}
mkdir -p "$ROOT/logs"

start_sidecar llm-proxy "$PROXY_PORT" \
  env LLM_PROXY_HOST=0.0.0.0 LLM_PROXY_PORT="$PROXY_PORT" bun run tools/llm-proxy/proxy.ts
start_sidecar mcp-http "$MCP_PORT" \
  env MARSCLAW_MCP_HTTP_HOST=0.0.0.0 MARSCLAW_MCP_HTTP_PORT="$MCP_PORT" bun run src/mcp/http-server.ts
start_sidecar egress "$EGRESS_PORT" \
  env EGRESS_GATEWAY_HOST=0.0.0.0 EGRESS_GATEWAY_PORT="$EGRESS_PORT" bun run tools/egress-gateway/gateway.ts

sleep 2

# --- agent container -------------------------------------------------------
# Detached so this script returns; the host broker (bun run start) is the long-
# running foreground process. Pass MARSCLAW_MUTATION_APPROVAL through to the MCP
# sidecar above if you want per-call Google-write approval (see notes below).
"$DOCKER" rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
log "starting agent container '$CONTAINER_NAME' (detached)"
"$DOCKER" run -d --rm --name "$CONTAINER_NAME" \
  --user bun \
  -p "127.0.0.1:${TURN_PORT}:${TURN_PORT}" \
  -e HOME=/home/bun \
  -e AGENT_SERVICE_PORT="$TURN_PORT" \
  -e AGENT_WORKDIR=/workspace \
  -e ANTHROPIC_BASE_URL="http://host.docker.internal:${PROXY_PORT}" \
  -e ANTHROPIC_API_KEY="$LLM_PROXY_SESSION_TOKEN" \
  -e HTTPS_PROXY="http://host.docker.internal:${EGRESS_PORT}" \
  -e HTTP_PROXY="http://host.docker.internal:${EGRESS_PORT}" \
  -e NO_PROXY="host.docker.internal,127.0.0.1,localhost" \
  -e MARSCLAW_MCP_BASE_URL="http://host.docker.internal:${MCP_PORT}/mcp" \
  -e MARSCLAW_BOT_NAME="${MARSCLAW_BOT_NAME:-Mars}" \
  -e MARSCLAW_OWNER_NAME="${MARSCLAW_OWNER_NAME:-}" \
  -e MARSCLAW_SHARED_MEDIA="${SHARED_MEDIA}" \
  -v "${AGENT_HOME}/.claude:/home/bun/.claude" \
  -v "${SHARED_MEDIA}:${SHARED_MEDIA}" \
  ${CLAUDE_MD_MOUNT} ${MEMORY_MD_MOUNT} ${SKILLS_MOUNT} ${WIKI_MOUNT} \
  "$IMAGE" >/dev/null

log "waiting for /turn health on :${TURN_PORT} …"
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${TURN_PORT}/health" >/dev/null 2>&1; then
    log "agent container healthy: $(curl -s http://127.0.0.1:${TURN_PORT}/health)"
    log "stack up. Now run:  MARSCLAW_RUNTIME=container bun run start"
    exit 0
  fi
  sleep 2
done
log "ERROR: agent container did not become healthy — check: $DOCKER logs $CONTAINER_NAME"
exit 1
