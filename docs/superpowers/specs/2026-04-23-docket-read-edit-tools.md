# Docket HUD — `read_docket` / `edit_docket` tools

**Date:** 2026-04-23
**Status:** Implemented — shipped alongside the spec
**Scope:** Add two MCP tools that mirror Claude Code's `Read` / `Edit` tool pair, scoped to the daemon-owned HUD HTML buffer. Purpose is token efficiency for iterative UI updates.
**Issue:** docklet-494
**Predecessor:** docklet-878 (docket HUD) — this spec assumes `write_docket` / `hide_docket` and the `Docket` module from [`2026-04-23-docket-hud-design.md`](./2026-04-23-docket-hud-design.md) exist and the daemon already owns the singleton HUD.
**Depends on:** [`2026-04-23-docket-hud-design.md`](./2026-04-23-docket-hud-design.md)

## 1. Purpose

`write_docket` replaces the full HTML blob every call. For iterative UI work — flipping a status dot from green to red, bumping a progress number, appending a row — re-sending the whole document is token-wasteful and obscures intent.

Claude Code agents already have a robust mental model for "read the current state, then patch a specific slice." We copy that model 1:1, scoped to the HUD:

- `read_docket` → returns the current HTML the daemon is rendering.
- `edit_docket` → exact-string `{old_string → new_string}` replacement with the same uniqueness + read-before-edit guarantees the FS `Edit` tool provides.

The daemon — not the model — enforces the gate. That's what makes it reliable against multi-client races.

## 2. Architecture

```
client A ──stdio──▶ adapter ─┐
client B ──stdio──▶ adapter ─┼──▶ socket ──▶ daemon
                             │                ├─ Docket (glimpseui window)
                             │                └─ DocketBuffer  (new)
                             │                     ├─ html: string
                             │                     ├─ version: number          (monotonic)
                             │                     └─ perClient: Map<cxnId, lastReadVersion>
```

`DocketBuffer` is the new piece. It lives in the daemon process and is the authoritative source of truth for what the HUD is showing. Every mutation — whether from `write_docket`, `edit_docket`, or `hide_docket` — flows through it and bumps `version`.

Per-client bookkeeping is keyed by the daemon socket connection id (each adapter → daemon `DaemonClient` gets its own id), **not** by MCP session. This matches how the FS tools scope their bookkeeping: one editor process, one registry.

## 3. MCP tool surface

New registrations in `adapter.ts` alongside `registerDocketTools`:

| Tool          | Input schema                                              | Daemon RPC                                     | Return                                                            |
|---------------|-----------------------------------------------------------|------------------------------------------------|-------------------------------------------------------------------|
| `read_docket` | `{}`                                                      | `read({})`                                     | `{content:[{type:"text", text: "<current html>"}]}`              |
| `edit_docket` | `{ old_string: string, new_string: string, replace_all?: boolean }` | `edit({old_string, new_string, replace_all})` | `{content:[{type:"text", text:"ok (version=N)"}]}` on success    |

### 3.1 `read_docket`

- **title:** "Read current Docket HUD HTML"
- **description:** "Return the HTML currently rendered in the shared Docklet HUD. You must call this before `edit_docket` — the daemon tracks your last-read version and rejects stale edits. Returns an empty string if the HUD has never been set or was hidden."

Internally, on success the daemon sets `perClient[cxnId] = version` so the next `edit_docket` from the same adapter connection is accepted.

### 3.2 `edit_docket`

- **title:** "Patch the Docket HUD HTML by exact string replacement"
- **description:** "Replace `old_string` with `new_string` in the current HUD HTML. Mirrors the semantics of the `Edit` tool on files: `old_string` must match byte-for-byte (including whitespace) and must be unique unless `replace_all` is true. Requires a prior `read_docket` in this session — the daemon rejects edits that race ahead of the reader's view. Use `write_docket` for full-document replacement."

Input schema (JSON Schema):

```json
{
  "type": "object",
  "required": ["old_string", "new_string"],
  "additionalProperties": false,
  "properties": {
    "old_string":  { "type": "string",  "description": "Exact text to replace. Must match byte-for-byte." },
    "new_string":  { "type": "string",  "description": "Replacement text. Must differ from old_string." },
    "replace_all": { "type": "boolean", "default": false, "description": "Replace every occurrence instead of requiring uniqueness." }
  }
}
```

## 4. Read-before-edit gate

The gate is the contract. Its semantics match the FS `Edit` tool's behavior, implemented as a daemon-side preflight:

1. **No prior read** (`perClient[cxnId]` unset) → `MustReadFirst` error: *"Call `read_docket` before `edit_docket`."*
2. **Stale read** (`perClient[cxnId] < version`) → `StaleRead` error: *"Docket was modified since your last read. Call `read_docket` again and retry."*
3. **Match check** against current `html`:
   - 0 occurrences → `NoMatch` error: *"`old_string` not found in current docket."*
   - ≥2 occurrences and `replace_all === false` → `Ambiguous` error: *"`old_string` matches N times; expand context to make it unique or pass `replace_all: true`."*
4. **No-op check** (`old_string === new_string`) → `NoOp` error: *"`new_string` must differ from `old_string`."*
5. All checks pass → replace in-memory, bump `version`, call `docket.show(html)` to re-render, update `perClient[cxnId] = version`, return ok.

Version is a monotonically increasing integer (daemon-local; resets on daemon restart, which is fine because `perClient` resets at the same time — connections die with the daemon).

### 4.1 What counts as a mutation

Any of these bump `version`:

- `write_docket` — replaces `html`, bumps version. (Buffer method: `buffer.write(html)`.)
- `edit_docket` — mutates `html`, bumps version.
- `hide_docket` — sets `html = ""`, bumps version. (Rationale: subsequent reads should see `""`, not the stale pre-hide HTML.)
- Daemon startup in `always` mode — initial placeholder counts as version 1, not 0. Clients must read before patching the placeholder.

### 4.2 Per-client vs. global state

The registry is per-connection, not shared. Two different adapter connections each need their own `read_docket` before they can `edit_docket`, even if they'd see identical HTML. This matches the FS tool's session scoping and prevents one client's read from masking another's stale view.

## 5. Module layout

```
src/
├── docket-buffer.ts  (new)     DocketBuffer: html, version, perClient map; read/edit/set operations. No MCP, no glimpseui — just state + gate logic.
├── docket.ts         (unchanged) Still owns the glimpseui window; DocketBuffer drives it.
├── daemon.ts         (modified) Instantiate DocketBuffer; wire it to the existing Docket; register read/edit handlers; update set/hide handlers to go through the buffer.
├── adapter.ts        (modified) registerDocketTools now also registers read_docket + edit_docket.
├── paths.ts          (unchanged)
├── protocol.ts       (unchanged)
└── index.ts          (unchanged)

test/
├── docket-buffer.test.ts (new)  Pure unit test of DocketBuffer: gate transitions, version bumps, uniqueness checks, replace_all, all error paths.
├── adapter-daemon.test.ts (modified) In-process read/edit integration; multi-client StaleRead scenario.
└── e2e.test.ts       (modified) Real subprocess: write_docket → read_docket → edit_docket → read_docket round-trip over MCP.
```

## 6. `src/docket-buffer.ts` public API

```ts
export type ClientId = string;

export interface DocketBufferOptions {
  initialHtml?: string;       // default ""; daemon passes placeholder in always mode
  onChange?: (html: string) => void | Promise<void>;   // called after every mutation; daemon hooks this to docket.show()
}

export type EditResult =
  | { ok: true; version: number }
  | { ok: false; code: "MustReadFirst" | "StaleRead" | "NoMatch" | "Ambiguous" | "NoOp"; message: string };

export interface DocketBuffer {
  getVersion(): number;
  read(clientId: ClientId): { html: string; version: number };
  write(html: string): number;                                   // returns new version
  hide(): number;                                                // sets html="", returns new version
  edit(clientId: ClientId, params: { old_string: string; new_string: string; replace_all?: boolean }): EditResult;
  forgetClient(clientId: ClientId): void;                        // called when a connection closes
}

export function createDocketBuffer(opts?: DocketBufferOptions): DocketBuffer;
```

The `onChange` callback is how the buffer stays decoupled from glimpseui: `daemon.ts` wires `onChange: (html) => docket.show(html)` (with a guard for the `hide` case that closes the window).

## 7. Daemon wiring

In `runDaemonMain`, replace the straight `docket` wiring with:

```ts
const docket = createDocket({ hudMode: paths.hudMode });
const buffer = createDocketBuffer({
  initialHtml: paths.hudMode === "always" ? PLACEHOLDER_HTML : "",
  onChange: async (html) => {
    if (html === "") await docket.hide();
    else await docket.show(html);
  },
});

registerDocketHandlers(daemon, buffer);     // now takes buffer, not docket directly
if (paths.hudMode === "always") await buffer.set(PLACEHOLDER_HTML);   // bumps version to 1
```

`registerDocketHandlers` expands:

```ts
daemon.onRequest("write", async (params, meta) => {                   // write_docket
  /* ...existing validation... */
  buffer.set(p.html);
  return { ok: true, version: buffer.getVersion() };
});
daemon.onRequest("hide", async (_, meta) => {
  buffer.hide();
  return { ok: true, version: buffer.getVersion() };
});
daemon.onRequest("read", async (_, meta) => {
  const { html, version } = buffer.read(meta.clientId);
  return { html, version };
});
daemon.onRequest("edit", async (params, meta) => {
  /* ...input validation: strings, non-empty old_string... */
  const result = buffer.edit(meta.clientId, params);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return { ok: true, version: result.version };
});
daemon.onConnectionClose((clientId) => buffer.forgetClient(clientId));
```

> **Resolved:** `Daemon.onRequest` already passes `(params, ctx: { connId: string })` as of the shell-design baseline — no signature change needed. We also add a new `Daemon.onConnectionClose(listener)` hook so the buffer can evict `lastRead` entries for dead connections.

## 8. Tests

**`test/docket-buffer.test.ts` (new)** — pure unit, no daemon, no glimpseui:

- `read` from never-set buffer → `{html: "", version: 0}`
- `edit` without prior `read` → `MustReadFirst`
- `read` then `edit` → success, version bumps, returned html reflects change
- `read` (v1) → another client `set` (v2) → original client `edit` → `StaleRead`
- `edit` with `old_string` not in html → `NoMatch`
- `edit` with `old_string` appearing 2× and `replace_all=false` → `Ambiguous`
- `edit` with `old_string` appearing 2× and `replace_all=true` → success, both replaced
- `edit` with `old_string === new_string` → `NoOp`
- `forgetClient` removes bookkeeping (subsequent `edit` from that id → `MustReadFirst`)
- `onChange` fires with new html after `set`, `edit`, and `hide` (with `""`)

**`test/adapter-daemon.test.ts` (modified)** — in-process adapter/daemon:

- Happy-path: connect two `DaemonClient`s, `read` on each, `edit` on each with disjoint `old_string`s → both succeed and version ends at 3 (or 4 depending on initial placeholder).
- StaleRead path: clientA reads, clientB sets, clientA edits → daemon surfaces `StaleRead` as a JSON-RPC error; adapter maps it to an MCP `isError: true` content response.
- Connection close triggers `forgetClient` (assert via next edit after reconnect requiring a fresh read).

**`test/e2e.test.ts` (modified)** — real subprocess, MCP SDK client:

- `write_docket({html: "<div id=a>hi</div>"})` → `read_docket()` returns that exact string → `edit_docket({old_string: "hi", new_string: "bye"})` ok → `read_docket()` shows `<div id=a>bye</div>`.
- `edit_docket` before any `read_docket` → MCP error with message containing `MustReadFirst`.
- Uses the existing `CLAWD_DOCKLET_DOCKET_DISABLED=1` flag so no real window is spawned — the buffer path is exercised regardless.

## 9. Error surface (MCP client view)

All failures come back as MCP tool errors (`isError: true` in the tool result), with the error code as a prefix of the text for parseability:

```
MustReadFirst: Call read_docket before edit_docket.
StaleRead: Docket was modified since your last read. Call read_docket again and retry.
NoMatch: old_string not found in current docket.
Ambiguous: old_string matches 3 times; expand context to make it unique or pass replace_all: true.
NoOp: new_string must differ from old_string.
```

This mirrors the FS `Edit` tool's error style closely enough that agents already familiar with it don't need new prompting to recover.

## 10. Out of scope

- **Versioned return on `read_docket`.** The MCP `read_docket` result is *just the HTML*; the version is tracked server-side and not exposed to the model. This matches `Read` on files — the model doesn't see mtimes. Keeps the tool output minimal.
- **Multi-step patches / diff hunks.** One `old_string`/`new_string` pair per call, like Edit. Agents sequence multiple edits if needed.
- **DOM-aware patching** (e.g. "update element with id=foo"). HTML is treated as opaque text; if agents want structure, they control it via IDs and use unique-enough `old_string`s.
- **Undo / history.** Buffer is last-write-wins. If an agent wants to roll back, it re-reads and edits.
- **Persistence across daemon restarts.** Buffer state is ephemeral; matches the HUD's own lifecycle.
- **Cross-tool interaction of `replace_all`**: no `occurrence_index` or "Nth match" variant. If the agent can't make the match unique, it uses `replace_all` or reshapes the doc.

## 11. Follow-ups

- Consider exposing `version` in `read_docket` output if agents start making decisions based on "has this changed" — but hold off until there's a concrete need.
- If the HUD grows structured regions (header / body / footer), revisit whether a region-scoped patch (`edit_docket_region(region, old, new)`) beats freeform string-match. Not now.
- Align naming with whatever final name the "docket" gets (see the parent spec's Follow-ups).
