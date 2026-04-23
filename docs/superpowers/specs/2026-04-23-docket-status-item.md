# Docket status-item — menu-bar anchor control

**Date:** 2026-04-23
**Status:** Draft — pending review
**Scope:** Daemon-owned macOS menu-bar status item. Clicking it opens a small HTML popover with six actions that reposition (or hide) the HUD: top-right, top-left, bottom-right, bottom-left, follow-cursor, hide. Chosen anchor persists across daemon restarts.
**Issue:** docklet-dys
**Depends on:** [`2026-04-23-docket-hud-design.md`](./2026-04-23-docket-hud-design.md) — reuses the HUD's `probe()` and lifecycle scaffolding.

## 1. Purpose

Today the HUD is pinned top-right (`src/docket.ts:157-180`). Users can't move it, choose a different corner, or have it follow the cursor. The HUD is `clickThrough: true`, which rules out in-window drag handles entirely: Swift sets `NSWindow.ignoresMouseEvents = true` (`glimpse.swift:386-388`), so AppKit never sees a mouse-down to start a drag, and `-webkit-app-region: drag` can't work without webview input.

A menu-bar status item sidesteps the clickthrough constraint. The status item is a separate glimpseui window (statusItem mode, `glimpse.swift:449-474`); clicking it opens a popover whose HTML we author. Popover click-handlers send messages back to the daemon, which repositions the HUD.

**Non-goals**

- No drag-to-reposition. Dropped per design discussion; the status item covers the common case without breaking clickthrough.
- No Linux/Windows parity. `statusItem()` throws on non-darwin (`glimpseui/src/glimpse.mjs:268`). Other platforms continue without a status item; the HUD stays on its default anchor.
- No per-client preference. Anchor is a single user-global setting.

## 2. Architecture

```
daemon (src/daemon.ts)
  ├─ docket            (existing: HUD window, src/docket.ts)
  └─ statusItem        (new: NSStatusItem + popover, src/status-item.ts)
         ▲                                │
         │ on("message", {type, anchor})  │  popover HTML runs in glimpse webview
         │                                ▼
         └──── daemon: writeConfig(...) + docket.setAnchor(...)
```

- Daemon owns the status item for its full lifetime. Opened on daemon start (gated by env/config) and closed on idle shutdown.
- New `src/status-item.ts` owns the statusItem glimpseui window and the popover HTML. UI-only; takes callbacks for `onAnchor(anchor)` and `onHide()`.
- New `src/config.ts` reads/writes `~/Library/Application Support/clawd-docklet/config.json`. Atomic writes (tmp + rename).
- `src/docket.ts` gains `setAnchor(anchor)`. HUD closes-and-reopens at the new position, preserving the last rendered HTML.

## 3. Status-item popover UI

Popover size: 220×260 px. Six rows; the active anchor is marked with a filled dot. Styling adapts to `info.appearance.darkMode`.

| Row | Label         | Message                                    |
|-----|---------------|--------------------------------------------|
| 1   | Top-right     | `{type: "set-anchor", anchor: "top-right"}` |
| 2   | Top-left      | `{type: "set-anchor", anchor: "top-left"}`  |
| 3   | Bottom-right  | `{type: "set-anchor", anchor: "bottom-right"}` |
| 4   | Bottom-left   | `{type: "set-anchor", anchor: "bottom-left"}`  |
| 5   | Follow cursor | `{type: "set-anchor", anchor: "follow-cursor"}` |
| 6   | Hide HUD      | `{type: "hide-hud"}`                       |

Interaction:

- Rows 1–5 → daemon calls `writeConfig` then `docket.setAnchor(anchor)`. Popover closes.
- Row 6 → daemon calls `docket.hide()`. Config is **not** changed. Status item stays up; the next `write_docket` reopens the HUD at the current saved anchor.
- Clicking outside the popover dismisses it (glimpseui's `NSPopover` uses `behavior = .transient`).

## 4. Anchor computation

In `src/docket.ts`, the current hard-coded top-right formula (`docket.ts:166-167`):

```ts
x: d.width - HUD_WIDTH - MARGIN,
y: d.height - HUD_HEIGHT - MARGIN,
```

becomes a `positionFor(anchor, d)` helper:

| anchor          | x                              | y                              | glimpse options added      |
|-----------------|--------------------------------|--------------------------------|----------------------------|
| `top-right`     | `d.width - HUD_WIDTH - MARGIN` | `d.height - HUD_HEIGHT - MARGIN` | —                          |
| `top-left`      | `MARGIN`                       | `d.height - HUD_HEIGHT - MARGIN` | —                          |
| `bottom-right`  | `d.width - HUD_WIDTH - MARGIN` | `MARGIN`                       | —                          |
| `bottom-left`   | `MARGIN`                       | `MARGIN`                       | —                          |
| `follow-cursor` | (omitted)                      | (omitted)                      | `followCursor: true, cursorAnchor: "top-right", cursorOffset: {x: -20, y: 20}` |

Notes:

- glimpseui/AppKit coordinates have the origin at the bottom-left, which is why `top-*` uses `d.height - HUD_HEIGHT - MARGIN`.
- Probe already returns `visibleHeight` (excluding menu bar, `docket.ts:114-115`), so top anchors land below the menu bar automatically.
- `cursorOffset` for follow-cursor keeps the HUD visually near the cursor without occluding it; concrete offset values are a tuning decision in M3.

## 5. Runtime anchor change

glimpseui has no post-create "move" RPC. Switching corners means close-and-reopen. `docket.setAnchor`:

```ts
async setAnchor(anchor: Anchor): Promise<void> {
  currentAnchor = anchor;
  if (disabled || !win) return;           // nothing to reposition yet
  const html = lastHtml;                  // docket tracks last rendered HTML
  try { win.close(); } catch {}
  win = null;
  const d = await probe();                // cached, usually instant
  win = openReal(openFn, html, d, anchor);
}
```

`show()` gains anchor awareness: the first open uses `currentAnchor`. Subsequent `show()` on the same anchor reuses the existing window with `setHTML` (today's behaviour).

Follow-cursor is treated the same as a corner for simplicity: always close-and-reopen on anchor change. The glimpseui runtime `win.followCursor(enabled, ...)` path exists (`glimpseui/src/glimpse.mjs:177`) but mixing it with live reposition adds states without a clear user win. Close-and-reopen is fast enough (sub-100ms in practice) and keeps state transitions linear.

## 6. Config persistence

New `src/config.ts`:

```ts
export type Anchor =
  | "top-right" | "top-left" | "bottom-right" | "bottom-left" | "follow-cursor";
export type Config = { anchor: Anchor };

export function readConfig(path: string): Config;          // sync; defaults on error
export function writeConfig(path: string, c: Config): Promise<void>;  // atomic
```

- Path default: `<socketDir>/config.json` (reuses `defaultSocketDir()` from `paths.ts`). Override via `CLAWD_DOCKLET_CONFIG`.
- Atomic write: write `config.json.tmp`, `fsync`, `rename` onto `config.json`.
- Missing file → default `{ anchor: "top-right" }`, no write.
- Invalid JSON or unknown anchor value → log once, return default, no write. `readConfig` never throws.

## 7. Env knobs (additions to `paths.ts`)

| Env var                               | Default                     | Purpose                                                        |
|---------------------------------------|-----------------------------|----------------------------------------------------------------|
| `CLAWD_DOCKLET_CONFIG`                | `<socketDir>/config.json`   | Persisted config path                                          |
| `CLAWD_DOCKLET_STATUS_DISABLED`       | `0`                         | When `1`, daemon skips status-item setup (tests / headless CI) |

`CLAWD_DOCKLET_DOCKET_DISABLED=1` implicitly disables the status item — no HUD means nothing for the popover to control.

## 8. Daemon wiring (`src/daemon.ts`)

In `runDaemonMain`, after `createDocket(...)`:

```ts
const initialAnchor = readConfig(paths.configPath).anchor;
docket.setAnchor(initialAnchor);   // no-op if HUD not yet open

const statusItem =
  paths.statusDisabled || paths.docketDisabled
    ? null
    : createStatusItem({
        initialAnchor,
        onAnchor: async (a) => {
          await writeConfig(paths.configPath, { anchor: a });
          await docket.setAnchor(a);
        },
        onHide: () => docket.hide(),
      });
```

Shutdown path (existing idle/signal handlers) calls `statusItem?.close()` before exiting.

## 9. Tests

Layer 1 (pure unit, no glimpseui):

- `test/config.test.ts` — `readConfig` returns default on missing file, invalid JSON, unknown anchor; `writeConfig` is atomic (tmp file gone after success; existing config untouched on tmp-write failure).
- `test/status-item.test.ts` — popover `message` handlers: `{type:"set-anchor", anchor:"top-left"}` invokes `onAnchor("top-left")`; `{type:"hide-hud"}` invokes `onHide`; malformed / unknown-type messages are ignored without throwing.

Layer 2 (docket with injected `open`):

- Anchor computation: for each of the five anchors, `openReal` is called with the expected `(x, y)` and option flags given fixed probe dims.
- `docket.setAnchor(next)` after `show(html)`: asserts close-and-reopen with preserved HTML and new coordinates.

Layer 4: skip. NSStatusBar interaction isn't automatable in headless CI; rely on manual smoke test.

## 10. Milestones

- **M1 — Config + anchor computation.** `src/config.ts`, `positionFor` helper in `docket.ts`, `docket.setAnchor`. No status item yet; expose initial anchor via `CLAWD_DOCKLET_ANCHOR` env var for manual smoke test. Unit + Layer 2 tests.
- **M2 — Status item + popover UI.** `src/status-item.ts`, daemon wiring, popover HTML. Manual smoke test: run daemon locally, click through all six rows, confirm HUD reposition and config persistence across daemon restart.
- **M3 — Polish.** Current-selection dot + row hover states, dark-mode styling from `info.appearance.darkMode`, tuned follow-cursor offsets.

## 11. Open questions

- Status-item button title: short text ("D") vs. unicode glyph ("◨") vs. SF Symbol. Glimpse currently sets `button.title` from `config.title` (`glimpse.swift:467`) with no SF Symbol plumbing. Start with "D" in M2; revisit if it looks out of place.
- Keyboard shortcut to cycle anchors? Deferred; status item is enough for v1.
- Behaviour when display configuration changes mid-session (monitor plug/unplug). Probe dims are cached (`docket.ts:75-79`). Out of scope — user restarts the daemon. May need a probe-invalidation path later.
