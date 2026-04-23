# clawd-docklet

An MCP server shell with a singleton-daemon architecture. Designed so multiple agent sessions (Claude Code, Codex, etc.) share a single running server instead of spawning one per client.

**Status:** Shell only — no tools registered yet. Installs, handshakes, lists zero tools.

## Install

```bash
claude mcp add clawd-docklet -- npx -y clawd-docklet
```

For local development:

```bash
git clone <this repo>
cd docklet
npm install
npm run build
npm link
claude mcp add clawd-docklet -- clawd-docklet
```

## Architecture

```
Client #1 ──stdio──▶ adapter ─┐
Client #2 ──stdio──▶ adapter ─┼──▶ Unix socket ──▶ daemon  (one process)
Codex     ──stdio──▶ adapter ─┘
```

One compiled binary, two roles. Dispatched by the `CLAWD_DOCKLET_ROLE` env var:

- unset → adapter (what the MCP client launches)
- `daemon` → long-running server the adapter spawns on first use

The daemon uses `bind()` on its socket path as its lock — simultaneous adapter launches cannot produce two daemons.

## Development

```bash
npm run build      # tsc → dist/
npm test           # vitest run
npm run test:watch
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CLAWD_DOCKLET_SOCKET` | platform-specific | Socket/pipe path |
| `CLAWD_DOCKLET_PIDFILE` | next to socket | Pidfile written on daemon bind |
| `CLAWD_DOCKLET_IDLE_MS` | `30000` | Ms after last client disconnect before daemon exits |
| `CLAWD_DOCKLET_ROLE` | unset | Set to `daemon` to run as daemon (internal) |

## License

MIT
