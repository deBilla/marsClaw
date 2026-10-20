# Container runtime (security by isolation)

marsClaw can run its agent two ways, chosen by `runtime` in `data/config.json`
(or `MARSCLAW_RUNTIME`):

- **`in-process`** (default) — the Claude Agent SDK runs in the host bot process.
  Security is by **capability removal**: `allow_shell`/`allow_web`/mutations off by
  default, `canUseTool` path gates, a web allowlist, a summary-only `researcher`
  subagent, and a sensitive-path guard.
- **`container`** — the SDK runs inside an isolated container. Security is by
  **isolation**: the container is the boundary, so the agent runs with **full
  capability** (shell, raw web, file ops) without host risk. Modeled on nanoclaw.

Toggle with `bun run container enable` / `bun run container disable`, then restart the bot.

Container mode applies to the **Claude** provider only. With `agent_provider: gemini` the agent still runs in-process (Gemini has no container service), although the host sidecars are started at boot whenever `runtime: container` is set.

---

## Architecture (container mode)

```
                          HOST (broker process)
  channels ─ onMessage ─ approval intercept ─ per-thread serialize ─ handleMessage
                                                          │ POST /turn
                                                          ▼
   ┌─ sidecars (host) ───────────────┐         ┌─ agent container ─────────────┐
   │ llm-proxy   :8765  (real cred)  │◄────────│ ANTHROPIC_BASE_URL → proxy    │
   │ egress gw   :8775  (SSRF filter)│◄────────│ HTTPS_PROXY → egress          │
   │ http-mcp    :8766  (Google cred)│◄────────│ MCP → http://…/mcp/<threadId> │
   └─────────────────────────────────┘         │ SDK loop, contained canUseTool│
                                                └───────────────────────────────┘
   outbox drain ◄─ SQLite (host) ◄─ MCP tools write here          (no secrets in box)
```

- **Host keeps**: channels, SQLite, outbox drain, approval interceptor, audit, and
  the three credential-/egress-holding sidecars. The agent container holds **no
  real secrets**.
- **Anthropic** is reached only through the **llm-proxy**, which swaps a rotatable
  session token for the real `CLAUDE_CODE_OAUTH_TOKEN` (held on the host only).
- **Host tools** (Google Workspace, `send_message`, `send_file`, `speak`) are
  reached over **HTTP MCP** — so Google OAuth + the DB stay on the host. Per-thread
  identity via the `/mcp/<threadId>` path → `AsyncLocalStorage`.
- **General web** is reached through the **SSRF egress gateway** (blocks
  loopback/private/CGNAT/link-local/cloud-metadata; DNS-pinned).
- **Lifecycle**: one shared long-lived container, **lazy-started on the first
  message** (cold start is a few seconds; the host waits up to 60 s for `/health`)
  and **idle-stopped after 15 min** (`MARSCLAW_CONTAINER_IDLE_MS`). Sidecars are
  spawned by the broker at boot (reusing any already listening on their port),
  log to `logs/<name>.log`, and stay up while the broker runs.
  (`src/providers/container-runtime.ts`)
- **Binding**: the three sidecars bind `0.0.0.0` (the container reaches them via
  `host.docker.internal`, which isn't host loopback). The agent's `/turn` port is
  published on `127.0.0.1` only.
- **Inside the box**: the SDK runs with `permissionMode: 'bypassPermissions'` and a
  contained `canUseTool` that allows everything; Claude Code UI tools are still
  removed. Warm per-thread sessions live in an LRU (`MARSCLAW_MAX_SESSIONS`), and
  the host carries the resume id + seeded history in each `/turn` request. The
  image (`oven/bun:1-debian` + git, ripgrep, curl) runs as the non-root `bun` user.

### What's mounted (and what is NOT)
Mounted (each only if it exists on the host): `CLAUDE.md` (ro), `MEMORY.md` (rw),
`skills/` (ro), `wiki/` (rw), `data/agent-home/.claude` → `/home/bun/.claude`
(transcript store, rw), and `data/shared` at the **same absolute path** on both
sides (inbound media, and files the agent wants to `send_file`).
**Never mounted**: `.env`, `data/` (DB, secrets, auth), the Keychain. So a
full-shell agent in the box cannot read host secrets. Persona is injected from the
mounted `CLAUDE.md` so host and container are the **same bot** with the **same
memory**.

### Key files
| Concern | File |
|---|---|
| Runtime switch + settings | `src/lib/config.ts` (`runtime`, `container_turn_url`) |
| Host→container dispatch | `src/agent.ts`, `src/providers/container-client.ts` |
| Lifecycle (wake/idle/sidecars) | `src/providers/container-runtime.ts` |
| In-container SDK service | `container/agent-service/src/index.ts`, `Dockerfile`, `run.sh` |
| Contained capability gate | `src/lib/tool-permissions.ts` (`buildCanUseTool(cfg,{contained:true})`) |
| HTTP MCP + identity | `src/mcp/http-server.ts`, `build-server.ts`, `thread-context.ts` |
| Credential / egress sidecars | `tools/llm-proxy/proxy.ts`, `tools/egress-gateway/{gateway,ssrf}.ts` |
| CLI | `src/cli/container.ts` (`enable`/`disable`/`login`/`status`) |

---

## Operating it

```bash
bun run container enable        # runtime=container in config.json; mints MARSCLAW_MCP_TOKEN into .env
bun run container login         # `claude setup-token` (browser) → CLAUDE_CODE_OAUTH_TOKEN in .env;
                                # also mints LLM_PROXY_SESSION_TOKEN. Held by the proxy only.
brew services start colima      # container daemon, survives reboot (free; not OrbStack/Desktop)
# build the image once:
docker build -f container/agent-service/Dockerfile -t marsclaw-agent:latest .
bun run start                   # broker boots sidecars; container wakes on first message
bun run container status        # runtime, daemon, credentials, sidecar/container state
bun run container disable       # back to in-process
```

Runtime: **OrbStack/Docker Desktop are NOT used** (commercial license) — the target
is **Colima + the open-source docker CLI** (both free). The CLI is resolved from
`MARSCLAW_DOCKER_BIN`, then `/opt/homebrew/bin/docker`, `/usr/local/bin/docker`,
`/usr/bin/docker`, then `PATH`, so any Docker-CLI-compatible runtime (Podman, Docker
Engine) works. If the daemon isn't reachable at boot the broker logs a warning and
the first turn retries.

The proxy accepts `ANTHROPIC_API_KEY` instead of `CLAUDE_CODE_OAUTH_TOKEN` if you'd
rather run metered. `bun run container login` doesn't restart a running proxy —
restart the bot to pick up a new account.

[container/agent-service/run.sh](https://github.com/deBilla/marsclaw/blob/main/container/agent-service/run.sh)
is a manual/dev alternative that starts the sidecars and the container from a shell;
the broker does the same automatically.

---

## Security model — what changes between modes

| Control | in-process | container |
|---|---|---|
| Host filesystem / `.env` / creds | reachable as host user (gated) | **not mounted — unreachable** |
| Real Anthropic credential | in process env | **never in the box** (proxy holds it) |
| Shell | off (capability removed) | **on** (container is the jail) |
| Web | allowlist + summary-only researcher | **raw fetch, any public host** (SSRF-filtered) |
| `allowed_web_domains` | enforced | **inert (no-op)** |
| Bash denylist / sensitive-path guard | enforced | **bypassed** |
| Google writes | `mutation_approval`/`allow_mutating_tools` | **per-call approval** (host MCP sidecar defaults to `MARSCLAW_MUTATION_APPROVAL=all`) |
| Tool audit trail | host `logs/audit.log` | in-container, lost on stop (host MCP/proxy/gateway still audited) |
| Daily budget / `bun run usage` | enforced / recorded (metered key) | **not recorded** |
| `data-platform` MCP | available | **not wired** |
| `stop` interrupt (WhatsApp) | in-process teardown | `POST /interrupt` |

**The trade to understand:** isolation protects the **host**, but the agent still
has full Gmail/Drive **read** (via the host MCP) AND raw public-web egress. The SSRF
filter stops network pivoting, **not** exfil to the public web. A prompt injection
in content the agent reads could exfiltrate data to a public URL — a path the
in-process allowlist+researcher partially closed. Decide consciously; mitigation is
to enforce a domain allowlist (or the researcher pattern) even in container mode.

---

## Known issues / open items
From a container security audit (2026-06-07; the full report lives in the
gitignored `reports/` folder and isn't published). Re-checked against the code
on 2026-10-20 — all still open:

- **🔴 Egress gateway binds `0.0.0.0` with no auth by default.** Token auth exists
  (`EGRESS_PROXY_TOKEN`; the broker then embeds it in the container's `HTTPS_PROXY`
  URL) but nothing mints it, so out of the box it's an open, SSRF-filtered forward
  proxy reachable by LAN peers. **Do not run container mode on an untrusted network**
  unless you set `EGRESS_PROXY_TOKEN` yourself (and verify the agent's HTTP client
  forwards proxy credentials) or firewall the port.
- **🟠 HTTP MCP fails open** if `MARSCLAW_MCP_TOKEN` is unset (should fail closed in
  container mode). `bun run container enable` mints it, so this bites only if you
  set `runtime: container` by hand.
- **🟠 llm-proxy records a 200-char preview of each request body** (i.e. user prompt
  text) in `logs/audit.log`; `redact()` is a stub.
- **🟠 The llm-proxy binds `0.0.0.0` too** — it requires the session token, but is
  reachable from the LAN.
- **🟡** tokens passed via `docker run -e` (visible to local `docker inspect`; real
  cred is NOT exposed); `/turn` has no auth (loopback-only); persona `@import`
  resolves arbitrary container paths.

### Verified-good
`contained` is container-only; threadId → parameterized SQL (injection-safe);
`.env`/`data/` never in the box; real Anthropic credential never in the container
or `docker inspect`; SSRF filter sound (fails closed, DNS-pinned); Google writes
gated by approval.

### Unwired / stale (cleanup)
- `tools/sandbox/` (sandbox-exec, pf anchor, hardened plist) — orphaned; mutually
  exclusive with containers.
- `MARSCLAW_EGRESS_ENFORCED` branch + in-process `agentSubprocessEnv` credential
  isolation — present but unused by default (only set in a commented plist block).
- `data-platform` MCP (BigQuery) — wired in-process only; **dropped in container mode**.
- ~~`docs/vs-nanoclaw.md` / `docs/security.md` describe "no container" + enforced
  allowlist — now false under `runtime:container`.~~ Fixed — both now document the
  container runtime and the allowlist's inert-in-container behaviour.
- ~~`.env.example` lists one key vs ~16 real.~~ Fixed — it now lists the full set,
  including the container keys. `.codebuddy/` is still committed by accident.
