# `agent-glance` — MCP Server Shell Design

**Date:** 2026-04-23
**Status:** Approved — shipped (docklet-2v5); subsequent work builds on this.
**Renamed from:** 2026-04-23-clawd-docklet-shell-design.md (docklet-6ye, 2026-04-23)
**Scope:** Minimal runnable shell, installable via MCP server installer. No tools yet.
**Follow-ups built on this shell:**
- [`2026-04-23-glance-hud-design.md`](./2026-04-23-glance-hud-design.md) — first real tools (`write_glance`, `hide_glance`) + daemon-owned glimpseui window (docklet-878).
- [`2026-04-23-glance-read-edit-tools.md`](./2026-04-23-glance-read-edit-tools.md) — `read_glance` / `edit_glance` mirroring the FS Read/Edit pair for token-efficient HUD patching (docklet-494).

## 1. Purpose

Ship a TypeScript MCP server published to npm as `agent-glance` that:

1. Installs with a single command: `claude mcp add agent-glance -- npx -y agent-glance`.
2. Has structural seams for a singleton adapter/daemon architecture so future glimpseui tools can be shared across multiple MCP client sessions (Claude Code #1, Claude Code #2, Codex) without opening duplicate windows.
3. Ships today with zero tools registered — a valid MCP handshake is the only user-visible behavior.

`glimpseui` is declared as a dependency now so it's ready when tools arrive, but is not imported by the shell.

## 2. Architecture (Option A — Singleton Daemon + Adapter)

```
Client #1 ──stdio──▶ adapter ─┐
Client #2 ──stdio──▶ adapter ─┼──▶ Unix socket ──▶ daemon  (one process)
Codex     ──stdio──▶ adapter ─┘
```

- **Adapter**: the published `bin`. Terminates MCP stdio for its client, proxies every request to the daemon.
- **Daemon**: a long-running process spawned on demand by the first adapter. Owns all shared state (windows, later). Exits after idle timeout with no connected adapters.
- **Protocol**: newline-delimited JSON over a Unix domain socket (macOS/Linux) or named pipe (Windows).
- **Race-free startup**: the daemon uses `bind()` on the socket path as its lock — losers of the race get `EADDRINUSE` and exit cleanly.

### Single-binary dispatch

One compiled entry (`dist/index.js`) with `#!/usr/bin/env node`. Dispatches by `AGENT_GLANCE_ROLE` env var:

- unset → runs as adapter (default; this is what npm's `bin` invokes)
- `daemon` → runs as daemon (how the adapter spawns it via `spawn(process.execPath, [entry], { env: { ...env, AGENT_GLANCE_ROLE: "daemon" }, detached: true, stdio: "ignore" })`)

## 3. Shell scope (what gets built now)

Files:

```
src/
├── index.ts       # role dispatcher (shebang lives here)
├── adapter.ts     # stdio MCP server; connects to daemon
├── daemon.ts      # socket server; bind-as-lock; idle shutdown; pidfile
├── protocol.ts    # Frame types, encoder, LineDecoder
└── paths.ts       # env-aware socket/pidfile/idle-timeout resolution

test/
├── protocol.test.ts         # Layer 1: pure unit
├── adapter-daemon.test.ts   # Layer 2: in-process socket round-trip
├── e2e.test.ts              # Layer 4: real subprocess + MCP SDK client
└── helpers/
    ├── env.ts               # freshEnv()
    └── spawn.ts             # spawnAndInit(), readDaemonPid(), waitForExit()
```

For the shell stage, the adapter's request handler simply **terminates MCP locally** and returns empty results (no tools). The daemon accepts connections and echoes/acks requests, but has no MCP knowledge yet. The proxy handoff between them is wired so the next change is "add a tool" rather than "refactor everything."

## 4. Configuration (env-var knobs)

All paths and timeouts overridable via env for testability:

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_GLANCE_SOCKET` | `~/Library/Application Support/agent-glance/daemon.sock` (mac), `$XDG_RUNTIME_DIR/agent-glance.sock` (linux), `\\.\pipe\agent-glance` (win) | Socket path |
| `AGENT_GLANCE_PIDFILE` | Same dir as socket, `daemon.pid` | Pidfile written on bind |
| `AGENT_GLANCE_IDLE_MS` | `30000` | Ms after last client disconnect before daemon exits |
| `AGENT_GLANCE_ROLE` | unset | `daemon` to run as daemon |

## 5. Package metadata

- **Name**: `agent-glance` (unscoped)
- **Version**: `0.1.0`
- **License**: MIT
- **Entry**: `dist/index.js` (with shebang, chmod +x via `prepare` script)
- **Bin**: `{ "agent-glance": "dist/index.js" }`
- **Type**: `module` (ESM)
- **Files published**: `["dist"]`
- **Engines**: `node >= 18`
- **Deps**: `@modelcontextprotocol/sdk@^1`, `glimpseui@^0.8`
- **DevDeps**: `typescript@^5`, `@types/node@^22`, `vitest@^3`

## 6. Test plan

Layer 1 — protocol unit tests (vitest, no I/O).
Layer 2 — adapter↔daemon round-trip on a temp socket, in-process.
Layer 4 — spawn real `bin`, connect with MCP SDK client, assert `initialize` and `tools/list` succeed.

Deferred tests (tracked in bd, implemented when relevant):
- Layer 3A — race: simultaneous adapter spawns produce one daemon (run 20×).
- Layer 3B — stale socket recovery.
- Layer 3C — daemon idle shutdown.

Rationale: shell has no meaningful behavior for idle shutdown / race to validate; L3 tests matter when glimpseui state is on the line. Smoke coverage ships now; hardening tests ship with the first real tool.

## 7. Install UX (what the user runs)

```bash
# After publish
claude mcp add agent-glance -- npx -y agent-glance

# Local dev
npm link
claude mcp add agent-glance -- agent-glance
```

## 8. Out of scope (deferred)

- Any MCP tools (the `open_window` / `send_message` / `receive_message` / `close_window` set).
- glimpseui child-process management.
- CI workflows (Actions files).
- Lint/format tooling — format on commit with whatever's local until we pick.
- Hardening tests listed in §6.
