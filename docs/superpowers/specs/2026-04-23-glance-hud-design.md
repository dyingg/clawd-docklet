# Glance HUD — daemon-owned glimpseui window

**Date:** 2026-04-23
**Status:** Approved — ready for implementation
**Renamed from:** 2026-04-23-docket-hud-design.md (docklet-6ye, 2026-04-23)
**Scope:** First real tool(s) on top of the shell. Daemon owns a single glimpseui window ("glance") rendered top-right of the screen. Two MCP tools let any client set/hide its HTML. Lifecycle is configurable.
**Issue:** docklet-878
**Predecessor:** docklet-xbv (closed) — shipped the initial `write_glance` precursor tool and payload-only daemon ack (commit `dc95eab`); this spec completes the daemon→glimpse wiring that xbv deferred.
**Depends on:** [`2026-04-23-agent-glance-shell-design.md`](./2026-04-23-agent-glance-shell-design.md) — the adapter/daemon singleton architecture this feature plugs into.

## 1. Purpose

Give the daemon a long-lived visual surface — a transparent, frameless, clickthrough HUD in the top-right corner — that agents can drive over MCP. This is the first real use of glimpseui in the project and validates the "daemon owns shared UI across sessions" premise of the shell design.

The surface is a **full web view** (Chromium/WebKit via glimpseui): whatever HTML a client passes is what shows, and that HTML can include `<script>`, `<style>`, CSS animations, `fetch`, `setTimeout`, canvas/SVG — the same primitives as a browser page. There is no input-interaction contract (clickthrough stays on, so pointer/keyboard events don't reach the page), no fixed content schema, and no embedded widgets. "Glance" is the caller-facing name for this HUD surface.

Tool descriptions (`write_glance`, `read_glance`, `edit_glance`) surface the web-view nature + the 480×400 viewport so agents know what primitives are available and what bounds to respect.

## 2. Architecture

```
adapter (src/adapter.ts)
  ├─ MCP tool write_glance ──▶ daemon.request("write", {html, title?})
  └─ MCP tool hide_glance  ──▶ daemon.request("hide", {})
                                    │
                                    ▼
daemon (src/daemon.ts) registers:
  onRequest("write", ...) ──┐
  onRequest("hide", ...)  ──┤──▶ glance (src/glance.ts)
                           │       ├─ glimpseui window (singleton)
  on startup (hudMode=always):     ├─ show(html, title?)
    glance.show(placeholderHTML)   └─ hide()
```

- The daemon owns the **only** glimpseui process. Adapters never `import 'glimpseui'` — they speak to the daemon via the existing socket RPC.
- `src/glance.ts` is a pure HUD module with no MCP knowledge: given a glimpseui factory, it manages a single window's lifecycle. This is what we unit-test.
- The existing daemon RPC registry (`daemon.onRequest(method, handler)`) is the integration seam — no new transport work.

## 3. Current state (what exists vs. what lands here)

Already on `main`:
- `adapter.ts` exports `registerGlanceTools(mcp, daemon)` — the MCP tools `write_glance({html, title})` and `hide_glance({})` forward to `daemon.request("write", …)` / `daemon.request("hide", …)`.
- `daemon.ts` exports `registerGlanceHandlers(daemon, glance)` — validates `{html, title}` payload and drives the `Glance`. Registered in `runDaemonMain`.
- `test/adapter-daemon.test.ts` covers payload validation on `show`.
- `test/e2e.test.ts` covers MCP tool surface for the initial precursor tool.

This task:
- Lands the `write_glance` tool and `registerGlanceTools` export (replacing the predecessor precursor tool); adds `hide_glance` tool. (Note: the MCP tool name was consolidated to `write_glance` to match the `Read`/`Write`/`Edit` idiom — see [`2026-04-23-glance-read-edit-tools.md`](./2026-04-23-glance-read-edit-tools.md).)
- Renames `registerShowHandler` → `registerGlanceHandlers(daemon, glance)`; keeps payload validation, now drives a real `Glance`. Internal RPC name is `"write"` (not `"show"`) for symmetry with `read` / `edit` / `hide`.
- Adds `src/glance.ts` (the glimpseui-owning module).
- Updates `paths.ts` for `AGENT_GLANCE_HUD_MODE`.
- Drops the leftover `ping` stub in `runDaemonMain` (no longer a placeholder; real handlers are registered).
- Updates tests accordingly; adds `test/glance.test.ts`.

## 4. MCP tool surface

Registration lives in `adapter.ts` under `registerGlanceTools(mcp, daemon)`:

| Tool         | Input schema                              | Daemon RPC                       | Return                                |
|--------------|-------------------------------------------|----------------------------------|---------------------------------------|
| `write_glance` | `{ html: string, title?: string }`        | `write({html, title})`           | `{content:[{type:"text", text:"ok"}]}` |
| `hide_glance`| `{}`                                      | `hide({})`                       | same                                   |

`write_glance`:
- **title:** "Write HTML to the Glance HUD"
- **description:** "Render the given HTML in the shared Glance HUD window (top-right of the screen, frameless, transparent, clickthrough). Multiple MCP clients share a single window owned by the daemon; each call replaces the previous HTML."

`hide_glance`:
- **title:** "Hide the Glance HUD"
- **description:** "Close the shared Glance HUD window. A subsequent `write_glance` will reopen it."

No `eval_hud_js` in this scope — deferred until a real client needs incremental updates.

## 5. Positioning

glimpseui has no post-create move API: `x,y` are fixed at window creation. It does expose a runtime `resize` command and dynamic `html`/`show`/`close`/`title` messages.

To land top-right accurately on any screen size, the daemon **probes once** at first-open:

1. Open a 1×1 hidden probe window (`frameless + transparent + clickThrough + noDock`) at an off-screen coordinate.
2. Wait for the `ready` event; read `info.screen.visibleWidth` and `info.screen.visibleHeight`.
3. Close the probe.
4. Open the real HUD window at:
   - `width: 480`, `height: 400`
   - `x = visibleWidth - 480 - 20`
   - `y = visibleHeight - 400 - 20` (NSWindow origin is bottom-left on macOS; this puts the window ~20px from the top-right corner)

Probe adds ~100–200ms to first-open (one-time — the cached screen dims are reused if the window is later closed and reopened within the same daemon lifetime).

Size (480×400) is a starting point and may change; unused window area is transparent+clickthrough so oversizing costs nothing visually. The viewport is surfaced in the `write_glance` / `edit_glance` / `read_glance` tool descriptions so agents can design HTML that fits.

**Rejected alternatives:**
- Hardcoded coordinates → wrong on external displays, wrong on non-Retina, etc.
- Fullscreen transparent window + CSS `right:20px` anchoring → fails when the window is larger than the screen (content anchored via `right:20px` lands off the visible area).
- Probe + reopen real window on every `hide`/`show` cycle → unnecessary; cache the dims.

## 6. Glimpseui options

Real HUD window:

```js
open(html, {
  width: 480, height: 400,
  x, y,                    // computed from probe
  frameless: true,
  transparent: true,
  clickThrough: true,
  floating: true,
  noDock: true,
})
```

Probe window:

```js
open('', {
  width: 1, height: 1,
  x: -10000, y: -10000,    // off-screen
  frameless: true,
  transparent: true,
  clickThrough: true,
  noDock: true,
})
```

Updates after open use the `GlimpseWindow.setHTML(html)` method (which triggers the native host's `html` command). No full reopen per update.

## 7. Lifecycle modes

New env var in `paths.ts`: `AGENT_GLANCE_HUD_MODE` ∈ {`always`, `lazy`}, default `always`.

| Mode     | On daemon startup              | On `write_glance`                  | On `hide_glance`         |
|----------|--------------------------------|----------------------------------|--------------------------|
| `always` | Probe → open window with placeholder HTML | Update HTML in existing window; reopen if closed | Close window              |
| `lazy`   | Do nothing (no probe, no window)          | Probe on first call, then open & set HTML; update on subsequent calls | Close window               |

- `always` is the debug/dev default: you see the HUD the instant the daemon comes up.
- `lazy` is for production where the HUD should stay silent until an agent opts in.
- Neither mode tries to preserve a "minimized" state. Hiding = close the window. Reopen is cheap (screen probe is cached).

Screen-dim probe result is cached on the `Glance` instance. If the first probe fails (timeout), `show` rejects with a clear error; `hide` is a no-op.

## 8. Placeholder HTML (native-mac feel)

Shown in `always` mode at daemon startup and whenever `write_glance` has never been called.

```html
<!doctype html>
<meta name="color-scheme" content="light dark">
<body style="background:transparent!important;margin:0;font-family:-apple-system,system-ui,sans-serif">
  <div style="position:fixed;top:20px;right:20px;
              display:flex;align-items:center;gap:8px;
              padding:8px 14px;border-radius:999px;
              background:color-mix(in srgb, canvas 70%, transparent);
              backdrop-filter:blur(24px) saturate(180%);
              -webkit-backdrop-filter:blur(24px) saturate(180%);
              border:1px solid color-mix(in srgb, canvastext 10%, transparent);
              font-size:12px;color:canvastext;">
    <span style="width:8px;height:8px;border-radius:50%;background:#34c759;
                 box-shadow:0 0 6px rgba(52,199,89,.6)"></span>
    agent-glance
  </div>
</body>
```

Small pill, backdrop-blur, system fonts, a green status dot. Adapts to dark/light via `canvas`/`canvastext` and `color-scheme`. Subtle and ignorable — that's the native vibe.

## 9. Module layout

```
src/
├── glance.ts      (new)     Glance module: probe, open, setHTML, close. No MCP imports.
├── daemon.ts      (modified) Instantiate Glance; register show/hide handlers; honor hudMode on startup.
├── adapter.ts     (modified) registerGlanceTools(mcp, daemon): write_glance + hide_glance.
├── paths.ts       (modified) Read AGENT_GLANCE_HUD_MODE.
├── index.ts       (unchanged)
└── protocol.ts    (unchanged)

test/
├── glance.test.ts (new)      Unit: inject a mock glimpseui `open`; assert probe-then-open flow, setHTML on update, close on hide, cached screen dims.
├── e2e.test.ts    (modified) `write_glance` assertions; add `hide_glance` coverage.
└── adapter-daemon.test.ts    (unchanged)
```

## 10. `src/glance.ts` public API

```ts
export interface GlanceOptions {
  open?: typeof import('glimpseui').open;  // injectable for tests
  hudMode?: 'always' | 'lazy';              // default 'always'
  disabled?: boolean;                       // default false; when true, show/hide are no-ops (CI/tests)
}

export interface Glance {
  show(html: string, title?: string): Promise<void>;
  hide(): Promise<void>;
  close(): Promise<void>;                   // teardown on daemon shutdown
}

export function createGlance(opts?: GlanceOptions): Glance;
```

Internal state: optional `GlimpseWindow` handle; cached `{width, height}` from probe; pending-probe promise (so concurrent `show` calls don't race).

## 11. Daemon wiring

`registerShowHandler` is renamed to `registerGlanceHandlers(daemon, glance)` and now drives the real Glance instead of just acking:

```ts
export function registerGlanceHandlers(daemon: Pick<Daemon, "onRequest">, glance: Glance) {
  daemon.onRequest("write", async (params) => {
    const p = params as Partial<WriteParams> | null;
    if (!p || typeof p.html !== "string") throw new Error("write: 'html' must be a string");
    if (p.title !== undefined && typeof p.title !== "string") throw new Error("write: 'title' must be a string when provided");
    await glance.show(p.html, p.title);
    return { ok: true };
  });
  daemon.onRequest("hide", async () => {
    await glance.hide();
    return { ok: true };
  });
}
```

In `runDaemonMain`:

```ts
const daemon = await startDaemon(paths);
const glance = createGlance({ hudMode: paths.hudMode });
registerGlanceHandlers(daemon, glance);
if (paths.hudMode === "always") await glance.show(PLACEHOLDER_HTML);
// Ensure glance.close() runs on idle-exit teardown.
```

The `ping` stub handler is dropped — no longer a shell placeholder now that real RPCs exist.

## 12. Tests

**`test/glance.test.ts` (new)** — pure unit test with a mock glimpseui:
- `show()` triggers probe → open real window (verifies the two-step open flow)
- Second `show()` calls `setHTML` on the same window (no reopen)
- `hide()` closes the window; next `show()` opens a new one but reuses cached screen dims (no second probe)
- `always` mode: placeholder not auto-rendered by the module (that's daemon.ts's job) — but placeholder constant is exported so both the daemon and the test can share it
- Probe timeout → `show()` rejects with actionable error

**`test/e2e.test.ts` (modified)** — real subprocess + MCP SDK client. Assert on the `write_glance` tool. Add a `hide_glance` test. These tests run against a daemon without a working display (CI), so the glimpseui binary will fail to open a window. **The RPC layer must still return `ok`** — glimpse failures surface as daemon-side errors logged to stderr but don't crash the daemon. To keep the e2e test deterministic, add a new env var `AGENT_GLANCE_HUD_DISABLED=1` that makes `Glance.show/hide` become no-ops (return immediately). The e2e tests set this flag.

Rationale: we want to verify the MCP tool surface and RPC plumbing end-to-end without depending on a GUI-capable runner. Real window rendering stays a manual smoke test during development.

**`test/adapter-daemon.test.ts` (modified)** — the existing `describe("show handler")` block currently calls `registerShowHandler(daemon)` (payload-only). It keeps its coverage but now calls `registerGlanceHandlers(daemon, glance)` with a Glance created under `AGENT_GLANCE_HUD_DISABLED=1` (or an explicit `disabled: true` option on `createGlance`) so the validation tests don't spawn a GUI process. Adds a similar block for `hide` handler.

## 13. Configuration summary

| Env var                         | Default   | Purpose                               |
|---------------------------------|-----------|---------------------------------------|
| `AGENT_GLANCE_HUD_MODE`         | `always`  | `always` or `lazy` lifecycle          |
| `AGENT_GLANCE_HUD_DISABLED`     | unset     | `1` → `Glance` becomes a no-op (tests)|

Existing `AGENT_GLANCE_ROLE`, `AGENT_GLANCE_SOCKET`, `AGENT_GLANCE_PIDFILE`, `AGENT_GLANCE_IDLE_MS` are unchanged.

## 14. Out of scope

- Multi-monitor awareness (use the primary display)
- Incremental JS eval (`eval_hud_js` tool)
- Persistent HUD state across daemon restarts
- Interactive HUD (clicks, forms) — would require turning off clickthrough, which contradicts the current contract
- Dynamic resizing based on content height
- Linux/Windows polish (should work but not explicitly tested here)

## 15. Follow-ups

- Revisit the placeholder design once clients start driving real content.
- Consider a size parameter on `write_glance` (or a separate `resize_glance`) once there's a real use case.
- **Token-efficient iterative updates** → [`2026-04-23-glance-read-edit-tools.md`](./2026-04-23-glance-read-edit-tools.md) (docklet-494): adds `read_glance` / `edit_glance` mirroring the FS Read/Edit tool pair, with daemon-side read-before-edit gate.
