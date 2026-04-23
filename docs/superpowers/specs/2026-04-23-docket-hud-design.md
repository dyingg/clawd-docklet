# Docket HUD — daemon-owned glimpseui window

**Date:** 2026-04-23
**Status:** Approved — ready for implementation
**Scope:** First real tool(s) on top of the shell. Daemon owns a single glimpseui window ("docket") rendered top-right of the screen. Two MCP tools let any client set/hide its HTML. Lifecycle is configurable.
**Issue:** docklet-878
**Predecessor:** docklet-xbv (closed) — shipped `docket_show` tool and payload-only daemon ack (commit `dc95eab`); this spec completes the daemon→glimpse wiring that xbv deferred.
**Depends on:** [`2026-04-23-clawd-docklet-shell-design.md`](./2026-04-23-clawd-docklet-shell-design.md) — the adapter/daemon singleton architecture this feature plugs into.

## 1. Purpose

Give the daemon a long-lived visual surface — a transparent, frameless, clickthrough HUD in the top-right corner — that agents can drive over MCP. This is the first real use of glimpseui in the project and validates the "daemon owns shared UI across sessions" premise of the shell design.

The surface is a canvas: whatever HTML a client passes is what shows. There is no interaction contract (clickthrough stays on), no fixed content schema, and no embedded widgets. Name "docket" is provisional and may change later ("HUD" is a more accurate description of the current shape).

## 2. Architecture

```
adapter (src/adapter.ts)
  ├─ MCP tool set_docket  ──▶ daemon.request("show", {html, title?})
  └─ MCP tool hide_docket ──▶ daemon.request("hide", {})
                                    │
                                    ▼
daemon (src/daemon.ts) registers:
  onRequest("show", ...) ──┐
  onRequest("hide", ...) ──┤──▶ docket (src/docket.ts)
                           │       ├─ glimpseui window (singleton)
  on startup (hudMode=always):     ├─ show(html, title?)
    docket.show(placeholderHTML)   └─ hide()
```

- The daemon owns the **only** glimpseui process. Adapters never `import 'glimpseui'` — they speak to the daemon via the existing socket RPC.
- `src/docket.ts` is a pure HUD module with no MCP knowledge: given a glimpseui factory, it manages a single window's lifecycle. This is what we unit-test.
- The existing daemon RPC registry (`daemon.onRequest(method, handler)`) is the integration seam — no new transport work.

## 3. Current state (what exists vs. what lands here)

Already on `main`:
- `adapter.ts` exports `registerDocketShow(mcp, daemon)` — the MCP tool `docket_show({html, title})` forwards to `daemon.request("show", …)`.
- `daemon.ts` exports `registerShowHandler(daemon)` — validates `{html, title}` payload and acks with `{ok:true}` but does **not** drive any UI yet (comment: "Daemon→glimpse wiring lands in a later change"). Registered in `runDaemonMain`.
- `test/adapter-daemon.test.ts` covers payload validation on `show`.
- `test/e2e.test.ts` covers MCP tool surface for `docket_show`.

This task:
- Renames `docket_show` → `set_docket` and `registerDocketShow` → `registerDocketTools`; adds `hide_docket` tool.
- Renames `registerShowHandler` → `registerDocketHandlers(daemon, docket)`; keeps payload validation, now drives a real `Docket`.
- Adds `src/docket.ts` (the glimpseui-owning module).
- Updates `paths.ts` for `CLAWD_DOCKLET_HUD_MODE`.
- Drops the leftover `ping` stub in `runDaemonMain` (no longer a placeholder; real handlers are registered).
- Updates tests accordingly; adds `test/docket.test.ts`.

## 4. MCP tool surface

Registration lives in `adapter.ts` under `registerDocketTools(mcp, daemon)`:

| Tool         | Input schema                              | Daemon RPC                       | Return                                |
|--------------|-------------------------------------------|----------------------------------|---------------------------------------|
| `set_docket` | `{ html: string, title?: string }`        | `show({html, title})`            | `{content:[{type:"text", text:"ok"}]}` |
| `hide_docket`| `{}`                                      | `hide({})`                       | same                                   |

`set_docket`:
- **title:** "Set HTML in Docklet HUD"
- **description:** "Render the given HTML in the shared Docklet HUD window (top-right of the screen, frameless, transparent, clickthrough). Multiple MCP clients share a single window owned by the daemon; each call replaces the previous HTML."

`hide_docket`:
- **title:** "Hide the Docklet HUD"
- **description:** "Close the shared Docklet HUD window. A subsequent `set_docket` will reopen it."

No `eval_hud_js` in this scope — deferred until a real client needs incremental updates.

## 5. Positioning

glimpseui has no post-create move API: `x,y` are fixed at window creation. It does expose a runtime `resize` command and dynamic `html`/`show`/`close`/`title` messages.

To land top-right accurately on any screen size, the daemon **probes once** at first-open:

1. Open a 1×1 hidden probe window (`frameless + transparent + clickThrough + noDock`) at an off-screen coordinate.
2. Wait for the `ready` event; read `info.screen.visibleWidth` and `info.screen.visibleHeight`.
3. Close the probe.
4. Open the real HUD window at:
   - `width: 320`, `height: 400`
   - `x = visibleWidth - 320 - 20`
   - `y = visibleHeight - 400 - 20` (NSWindow origin is bottom-left on macOS; this puts the window ~20px from the top-right corner)

Probe adds ~100–200ms to first-open (one-time — the cached screen dims are reused if the window is later closed and reopened within the same daemon lifetime).

Size (320×400) is a starting point and likely to change; unused window area is transparent+clickthrough so oversizing costs nothing visually.

**Rejected alternatives:**
- Hardcoded coordinates → wrong on external displays, wrong on non-Retina, etc.
- Fullscreen transparent window + CSS `right:20px` anchoring → fails when the window is larger than the screen (content anchored via `right:20px` lands off the visible area).
- Probe + reopen real window on every `hide`/`show` cycle → unnecessary; cache the dims.

## 6. Glimpseui options

Real HUD window:

```js
open(html, {
  width: 320, height: 400,
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

New env var in `paths.ts`: `CLAWD_DOCKLET_HUD_MODE` ∈ {`always`, `lazy`}, default `always`.

| Mode     | On daemon startup              | On `set_docket`                  | On `hide_docket`         |
|----------|--------------------------------|----------------------------------|--------------------------|
| `always` | Probe → open window with placeholder HTML | Update HTML in existing window; reopen if closed | Close window              |
| `lazy`   | Do nothing (no probe, no window)          | Probe on first call, then open & set HTML; update on subsequent calls | Close window               |

- `always` is the debug/dev default: you see the HUD the instant the daemon comes up.
- `lazy` is for production where the HUD should stay silent until an agent opts in.
- Neither mode tries to preserve a "minimized" state. Hiding = close the window. Reopen is cheap (screen probe is cached).

Screen-dim probe result is cached on the `Docket` instance. If the first probe fails (timeout), `show` rejects with a clear error; `hide` is a no-op.

## 8. Placeholder HTML (native-mac feel)

Shown in `always` mode at daemon startup and whenever `set_docket` has never been called.

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
    clawd-docklet
  </div>
</body>
```

Small pill, backdrop-blur, system fonts, a green status dot. Adapts to dark/light via `canvas`/`canvastext` and `color-scheme`. Subtle and ignorable — that's the native vibe.

## 9. Module layout

```
src/
├── docket.ts      (new)     Docket module: probe, open, setHTML, close. No MCP imports.
├── daemon.ts      (modified) Instantiate Docket; register show/hide handlers; honor hudMode on startup.
├── adapter.ts     (modified) registerDocketTools(mcp, daemon): set_docket + hide_docket.
├── paths.ts       (modified) Read CLAWD_DOCKLET_HUD_MODE.
├── index.ts       (unchanged)
└── protocol.ts    (unchanged)

test/
├── docket.test.ts (new)      Unit: inject a mock glimpseui `open`; assert probe-then-open flow, setHTML on update, close on hide, cached screen dims.
├── e2e.test.ts    (modified) Rename `docket_show` → `set_docket` assertions; add `hide_docket` coverage.
└── adapter-daemon.test.ts    (unchanged)
```

## 10. `src/docket.ts` public API

```ts
export interface DocketOptions {
  open?: typeof import('glimpseui').open;  // injectable for tests
  hudMode?: 'always' | 'lazy';              // default 'always'
  disabled?: boolean;                       // default false; when true, show/hide are no-ops (CI/tests)
}

export interface Docket {
  show(html: string, title?: string): Promise<void>;
  hide(): Promise<void>;
  close(): Promise<void>;                   // teardown on daemon shutdown
}

export function createDocket(opts?: DocketOptions): Docket;
```

Internal state: optional `GlimpseWindow` handle; cached `{width, height}` from probe; pending-probe promise (so concurrent `show` calls don't race).

## 11. Daemon wiring

`registerShowHandler` is renamed to `registerDocketHandlers(daemon, docket)` and now drives the real Docket instead of just acking:

```ts
export function registerDocketHandlers(daemon: Pick<Daemon, "onRequest">, docket: Docket) {
  daemon.onRequest("show", async (params) => {
    const p = params as Partial<ShowParams> | null;
    if (!p || typeof p.html !== "string") throw new Error("show: 'html' must be a string");
    if (p.title !== undefined && typeof p.title !== "string") throw new Error("show: 'title' must be a string when provided");
    await docket.show(p.html, p.title);
    return { ok: true };
  });
  daemon.onRequest("hide", async () => {
    await docket.hide();
    return { ok: true };
  });
}
```

In `runDaemonMain`:

```ts
const daemon = await startDaemon(paths);
const docket = createDocket({ hudMode: paths.hudMode });
registerDocketHandlers(daemon, docket);
if (paths.hudMode === "always") await docket.show(PLACEHOLDER_HTML);
// Ensure docket.close() runs on idle-exit teardown.
```

The `ping` stub handler is dropped — no longer a shell placeholder now that real RPCs exist.

## 12. Tests

**`test/docket.test.ts` (new)** — pure unit test with a mock glimpseui:
- `show()` triggers probe → open real window (verifies the two-step open flow)
- Second `show()` calls `setHTML` on the same window (no reopen)
- `hide()` closes the window; next `show()` opens a new one but reuses cached screen dims (no second probe)
- `always` mode: placeholder not auto-rendered by the module (that's daemon.ts's job) — but placeholder constant is exported so both the daemon and the test can share it
- Probe timeout → `show()` rejects with actionable error

**`test/e2e.test.ts` (modified)** — real subprocess + MCP SDK client. Rename `docket_show` → `set_docket`. Add a `hide_docket` test. These tests run against a daemon without a working display (CI), so the glimpseui binary will fail to open a window. **The RPC layer must still return `ok`** — glimpse failures surface as daemon-side errors logged to stderr but don't crash the daemon. To keep the e2e test deterministic, add a new env var `CLAWD_DOCKLET_DOCKET_DISABLED=1` that makes `Docket.show/hide` become no-ops (return immediately). The e2e tests set this flag.

Rationale: we want to verify the MCP tool surface and RPC plumbing end-to-end without depending on a GUI-capable runner. Real window rendering stays a manual smoke test during development.

**`test/adapter-daemon.test.ts` (modified)** — the existing `describe("show handler")` block currently calls `registerShowHandler(daemon)` (payload-only). It keeps its coverage but now calls `registerDocketHandlers(daemon, docket)` with a Docket created under `CLAWD_DOCKLET_DOCKET_DISABLED=1` (or an explicit `disabled: true` option on `createDocket`) so the validation tests don't spawn a GUI process. Adds a similar block for `hide` handler.

## 13. Configuration summary

| Env var                         | Default   | Purpose                               |
|---------------------------------|-----------|---------------------------------------|
| `CLAWD_DOCKLET_HUD_MODE`        | `always`  | `always` or `lazy` lifecycle          |
| `CLAWD_DOCKLET_DOCKET_DISABLED` | unset     | `1` → `Docket` becomes a no-op (tests)|

Existing `CLAWD_DOCKLET_ROLE`, `CLAWD_DOCKLET_SOCKET`, `CLAWD_DOCKLET_PIDFILE`, `CLAWD_DOCKLET_IDLE_MS` are unchanged.

## 14. Out of scope

- Multi-monitor awareness (use the primary display)
- Incremental JS eval (`eval_hud_js` tool)
- Persistent HUD state across daemon restarts
- Interactive HUD (clicks, forms) — would require turning off clickthrough, which contradicts the current contract
- Dynamic resizing based on content height
- Linux/Windows polish (should work but not explicitly tested here)

## 15. Follow-ups

- Rename "docket" once the right name surfaces (HUD? surface? canvas?). `set_docket`/`hide_docket` are temporary.
- Consider a size parameter on `set_docket` (or a separate `resize_docket`) once there's a real use case.
- Revisit the placeholder design once clients start driving real content.
