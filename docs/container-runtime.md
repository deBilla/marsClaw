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

Toggle with `bun run container enable` / `bun run container disable`.

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
  message** (~2 s cold start) and **idle-stopped after 15 min**. Sidecars stay up
  while the broker runs. (`src/providers/container-runtime.ts`)

### What's mounted (and what is NOT)
Mounted: `CLAUDE.md` (ro), `MEMORY.md` (rw), `skills/` (ro), `wiki/` (rw),
`~/.claude` transcript store (rw), and a path-identical `data/shared` media dir.
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
bun run container enable        # runtime=container in config.json; mints MARSCLAW_MCP_TOKEN
bun run container login         # mint CLAUDE_CODE_OAUTH_TOKEN (browser); held by the proxy only
brew services start colima      # container daemon, survives reboot (free; not OrbStack/Desktop)
# build the image once:
docker build -f container/agent-service/Dockerfile -t marsclaw-agent:latest .
bun run start                   # broker boots sidecars; container wakes on first message
bun run container status        # runtime, daemon, credentials, sidecar/container state
bun run container disable       # back to in-process
```

Runtime: **OrbStack/Docker Desktop are NOT used** (commercial license) — the target
is **Colima + the open-source docker CLI** (both free). The runtime sits behind one
binary name, so Apple `container`/Podman are a one-line swap.

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
| Google writes | `mutation_approval`/`allow_mutating_tools` | **per-call approval forced** (host MCP) |

**The trade to understand:** isolation protects the **host**, but the agent still
has full Gmail/Drive **read** (via the host MCP) AND raw public-web egress. The SSRF
filter stops network pivoting, **not** exfil to the public web. A prompt injection
in content the agent reads could exfiltrate data to a public URL — a path the
in-process allowlist+researcher partially closed. Decide consciously; mitigation is
to enforce a domain allowlist (or the researcher pattern) even in container mode.

---

## Known issues / open items
Full detail + severities in
[`reports/security-audit-container-2026-06-07.md`](../reports/security-audit-container-2026-06-07.md).
Top items:

- **🔴 Egress gateway binds `0.0.0.0` with no auth** (`EGRESS_PROXY_TOKEN` never
  minted) → an open, SSRF-filtered forward proxy reachable by LAN peers when
  container mode runs. **Do not run container mode on an untrusted network** until
  bound to the bridge address or token-required.
- **🟠 HTTP MCP fails open** if `MARSCLAW_MCP_TOKEN` is unset (should fail closed in container mode).
- **🟠 llm-proxy logs user prompt text** (200 chars) to local logs; `redact()` is a stub.
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
  isolation — dead (only set in a commented plist block).
- `data-platform` MCP (BigQuery) — wired in-process only; **dropped in container mode**.
- ~~`docs/vs-nanoclaw.md` / `docs/security.md` describe "no container" + enforced
  allowlist — now false under `runtime:container`.~~ Fixed — both now document the
  container runtime and the allowlist's inert-in-container behaviour.
- `.env.example` lists one key vs ~16 real; `.codebuddy/` committed by accident.
