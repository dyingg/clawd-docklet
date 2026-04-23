# Docket HUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire a daemon-owned glimpseui HUD window into the existing adapter/daemon shell, with `set_docket` / `hide_docket` MCP tools and screen-probe-based top-right positioning.

**Architecture:** Add `src/docket.ts` as a pure HUD module (glimpseui factory injectable for tests). `src/daemon.ts` instantiates one `Docket` and registers `show`/`hide` RPC handlers that drive it. `src/adapter.ts` exposes two MCP tools that forward to those RPCs. Lifecycle is controlled by `CLAWD_DOCKLET_HUD_MODE` (`always`|`lazy`); tests disable real window spawning with `CLAWD_DOCKLET_DOCKET_DISABLED=1`.

**Tech Stack:** TypeScript (ESM/NodeNext), `@modelcontextprotocol/sdk@1.29.0` (`McpServer` + `registerTool`), `glimpseui@0.8.0` (`open()` returning `GlimpseWindow` EventEmitter), `vitest`, `zod`.

**Spec:** [`docs/superpowers/specs/2026-04-23-docket-hud-design.md`](../specs/2026-04-23-docket-hud-design.md)
**Beads issue:** `docklet-878`
**Predecessor (shipped):** `docklet-xbv` — commit `dc95eab` landed `docket_show` tool + daemon payload ack; this plan completes the glimpse wiring.

---

## Pre-flight: read these before starting

1. **Spec**: `docs/superpowers/specs/2026-04-23-docket-hud-design.md` — sections 4–12 are the contract for this work.
2. **Current code**:
   - `src/adapter.ts:95-112` — existing `registerDocketShow` (will be renamed).
   - `src/daemon.ts:114-128` — existing `registerShowHandler` (will be renamed and now drives Docket).
   - `src/daemon.ts:130-144` — `runDaemonMain` (drops `ping` stub, adds Docket instantiation).
   - `src/paths.ts` — env-var knob layout.
   - `test/adapter-daemon.test.ts:54-81` — `show handler` block (gets replaced and extended).
   - `test/e2e.test.ts:29-71` — `docket_show` MCP surface tests (renamed + extended).
3. **Glimpseui subtlety**: In `node_modules/glimpseui/src/glimpse.mjs:94-105`, when `open(html, ...)` is called with a non-empty `initialHTML`, the `'ready'` event is **not** emitted (the handler calls `setHTML` instead and returns). Therefore the **probe window must be opened with `open('', {...})`** so we get the `ready` event carrying `info.screen.visibleWidth`/`visibleHeight`. The real HUD window can be opened with `open(html, {...})` (no ready needed — we already cached the dims from the probe).
4. **MCP SDK**: We use `McpServer.registerTool(name, config, handler)` (see `CLAUDE.md` → "Verify Library APIs Before Using Them"). Do NOT use the deprecated `server.tool(...)` overloads.

## Beads alignment

- **Primary issue:** `docklet-878` — already open, priority P2, `--claim` it at the start of Task 0.
- **No sub-issues.** This is one coherent feature landing in one PR; decomposition is at the task level, not the beads level.
- **At end:** close `docklet-878` with a reference to the final commit.

---

## File structure

```
src/
├── docket.ts         (NEW) — createDocket(), Docket interface, PLACEHOLDER_HTML.
│                              Imports glimpseui; adapter.ts never imports glimpseui.
├── paths.ts          (MOD) — add hudMode + docketDisabled to Paths + resolvePaths().
├── daemon.ts         (MOD) — registerDocketHandlers(daemon, docket) replaces
│                              registerShowHandler; runDaemonMain wires Docket;
│                              drop `ping` stub.
├── adapter.ts        (MOD) — registerDocketTools(mcp, daemon): set_docket + hide_docket.
├── index.ts          (unchanged)
└── protocol.ts       (unchanged)

test/
├── docket.test.ts             (NEW) — unit test with a fake glimpseui open().
├── adapter-daemon.test.ts     (MOD) — uses registerDocketHandlers w/ disabled Docket;
│                                       adds hide-handler block.
├── e2e.test.ts                (MOD) — rename docket_show → set_docket; add
│                                       hide_docket test; env sets
│                                       CLAWD_DOCKLET_DOCKET_DISABLED=1.
└── helpers/                   (unchanged)
```

Each task lists its files up top and the exact commands to run. Tasks are TDD-shaped (test-first where a test exists) with frequent commits.

---

## Task 0: Claim the beads issue

**Files:** none (process step).

- [ ] **Step 1: Claim `docklet-878`**

```bash
bd update docklet-878 --claim
bd show docklet-878
```

Expected: `Status: in_progress`, `Owner: Dying`.

- [ ] **Step 2: Run baseline tests so we know the starting point is green**

```bash
npm test
```

Expected: all tests pass (protocol + adapter-daemon + e2e). If any fail on a clean tree, stop and investigate before proceeding — the plan assumes a green baseline.

---

## Task 1: Extend `Paths` with `hudMode` and `docketDisabled`

**Files:**
- Modify: `src/paths.ts`
- Modify: `test/adapter-daemon.test.ts:11-23` (Paths literal in `beforeEach` will gain two fields)

- [ ] **Step 1: Add fields to `Paths` and `resolvePaths()`**

Replace the full contents of `src/paths.ts` with:

```ts
import { homedir, platform } from "node:os";
import { join } from "node:path";

export type HudMode = "always" | "lazy";

export type Paths = {
  socketPath: string;
  pidfilePath: string;
  idleMs: number;
  hudMode: HudMode;
  docketDisabled: boolean;
};

function defaultSocketDir(): string {
  const plat = platform();
  if (plat === "darwin") {
    return join(homedir(), "Library", "Application Support", "clawd-docklet");
  }
  if (plat === "win32") {
    return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local", "clawd-docklet");
  }
  return process.env.XDG_RUNTIME_DIR ?? join(homedir(), ".clawd-docklet");
}

function defaultSocketPath(): string {
  if (platform() === "win32") return String.raw`\\.\pipe\clawd-docklet`;
  return join(defaultSocketDir(), "daemon.sock");
}

function defaultPidfilePath(): string {
  return join(defaultSocketDir(), "daemon.pid");
}

function parseHudMode(raw: string | undefined): HudMode {
  if (raw === "lazy") return "lazy";
  return "always";
}

function parseBoolFlag(raw: string | undefined): boolean {
  return raw === "1" || raw === "true";
}

export function resolvePaths(): Paths {
  return {
    socketPath: process.env.CLAWD_DOCKLET_SOCKET ?? defaultSocketPath(),
    pidfilePath: process.env.CLAWD_DOCKLET_PIDFILE ?? defaultPidfilePath(),
    idleMs: Number.parseInt(process.env.CLAWD_DOCKLET_IDLE_MS ?? "30000", 10),
    hudMode: parseHudMode(process.env.CLAWD_DOCKLET_HUD_MODE),
    docketDisabled: parseBoolFlag(process.env.CLAWD_DOCKLET_DOCKET_DISABLED),
  };
}
```

- [ ] **Step 2: Update the Paths literals in `test/adapter-daemon.test.ts`**

The existing `beforeEach` constructs two `Paths` objects (startDaemon and connectDaemon). Extend each to satisfy the new shape. Change:

```ts
daemon = await startDaemon({
  socketPath: env.CLAWD_DOCKLET_SOCKET,
  pidfilePath: env.CLAWD_DOCKLET_PIDFILE,
  idleMs: 60000,
});
const sock = await connectDaemon({
  socketPath: env.CLAWD_DOCKLET_SOCKET,
  pidfilePath: env.CLAWD_DOCKLET_PIDFILE,
  idleMs: 60000,
});
```

to:

```ts
daemon = await startDaemon({
  socketPath: env.CLAWD_DOCKLET_SOCKET,
  pidfilePath: env.CLAWD_DOCKLET_PIDFILE,
  idleMs: 60000,
  hudMode: "always",
  docketDisabled: true,
});
const sock = await connectDaemon({
  socketPath: env.CLAWD_DOCKLET_SOCKET,
  pidfilePath: env.CLAWD_DOCKLET_PIDFILE,
  idleMs: 60000,
  hudMode: "always",
  docketDisabled: true,
});
```

- [ ] **Step 3: Typecheck & run tests**

```bash
npx tsc -p tsconfig.test.json
npm test
```

Expected: typecheck passes, existing tests still pass (the new fields are inert until consumed).

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(paths): add hudMode and docketDisabled knobs" -- src/paths.ts test/adapter-daemon.test.ts
```

---

## Task 2: Write failing unit tests for `src/docket.ts`

**Files:**
- Test (create): `test/docket.test.ts`

- [ ] **Step 1: Create the failing test file**

Create `test/docket.test.ts` with the following full contents:

```ts
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDocket, PLACEHOLDER_HTML, type DocketOptions } from "../src/docket.js";

/** Minimal fake that mirrors the subset of GlimpseWindow the Docket uses. */
class FakeWindow extends EventEmitter {
  setHTML = vi.fn<(html: string) => void>();
  close = vi.fn<() => void>();
  closed = false;
  constructor(public openArgs: { html: string; options: Record<string, unknown> }) {
    super();
  }
}

type OpenFn = NonNullable<DocketOptions["open"]>;

function makeOpen(onOpen?: (w: FakeWindow) => void) {
  const windows: FakeWindow[] = [];
  const open: OpenFn = ((html: string, options: Record<string, unknown>) => {
    const w = new FakeWindow({ html, options });
    windows.push(w);
    queueMicrotask(() => onOpen?.(w));
    return w as unknown as ReturnType<OpenFn>;
  }) as OpenFn;
  return { open, windows };
}

function fireReady(w: FakeWindow, width = 1440, height = 900) {
  w.emit("ready", {
    screen: { visibleWidth: width, visibleHeight: height },
    screens: [],
    appearance: "light",
    cursor: { x: 0, y: 0 },
    cursorTip: null,
  });
}

describe("Docket", () => {
  afterEach(() => vi.restoreAllMocks());

  test("first show: probe → close probe → open real HUD at top-right", async () => {
    const { open, windows } = makeOpen((w) => {
      if (windows.length === 1) fireReady(w, 1440, 900);
    });
    const docket = createDocket({ open });

    await docket.show("<h1>hi</h1>");

    expect(windows).toHaveLength(2);

    // Probe: 1×1, off-screen, frameless+transparent+clickThrough+noDock.
    expect(windows[0].openArgs.html).toBe("");
    expect(windows[0].openArgs.options).toMatchObject({
      width: 1,
      height: 1,
      frameless: true,
      transparent: true,
      clickThrough: true,
      noDock: true,
    });
    expect(windows[0].close).toHaveBeenCalledTimes(1);

    // Real HUD: 320×400 anchored top-right from 1440×900.
    expect(windows[1].openArgs.html).toBe("<h1>hi</h1>");
    expect(windows[1].openArgs.options).toMatchObject({
      width: 320,
      height: 400,
      x: 1440 - 320 - 20,
      y: 900 - 400 - 20,
      frameless: true,
      transparent: true,
      clickThrough: true,
      floating: true,
      noDock: true,
    });
  });

  test("second show updates existing window via setHTML (no reopen)", async () => {
    const { open, windows } = makeOpen((w) => {
      if (windows.length === 1) fireReady(w);
    });
    const docket = createDocket({ open });

    await docket.show("<p>one</p>");
    await docket.show("<p>two</p>");

    expect(windows).toHaveLength(2); // probe + real, no third
    expect(windows[1].setHTML).toHaveBeenCalledWith("<p>two</p>");
  });

  test("hide closes the window; next show reuses cached dims (no second probe)", async () => {
    const { open, windows } = makeOpen((w) => {
      if (windows.length === 1) fireReady(w, 2000, 1200);
    });
    const docket = createDocket({ open });

    await docket.show("<p>first</p>");
    await docket.hide();
    expect(windows[1].close).toHaveBeenCalledTimes(1);

    await docket.show("<p>second</p>");

    // windows[0] = probe, windows[1] = first real HUD (now closed),
    // windows[2] = reopened HUD — no second probe.
    expect(windows).toHaveLength(3);
    expect(windows[2].openArgs.options).toMatchObject({
      width: 320,
      height: 400,
      x: 2000 - 320 - 20,
      y: 1200 - 400 - 20,
    });
  });

  test("concurrent show calls share a single probe", async () => {
    const { open, windows } = makeOpen((w) => {
      if (windows.length === 1) setTimeout(() => fireReady(w), 5);
    });
    const docket = createDocket({ open });

    await Promise.all([docket.show("<p>a</p>"), docket.show("<p>b</p>")]);

    // One probe + one real HUD. The loser's HTML should be the final setHTML
    // (we allow either order, but there must be exactly two windows).
    expect(windows).toHaveLength(2);
  });

  test("probe timeout rejects show with an actionable error", async () => {
    vi.useFakeTimers();
    const { open } = makeOpen(); // never fires ready
    const docket = createDocket({ open, probeTimeoutMs: 500 });

    const p = docket.show("<p>x</p>");
    vi.advanceTimersByTime(600);
    await expect(p).rejects.toThrow(/probe.*timed out/i);
    vi.useRealTimers();
  });

  test("disabled: show/hide/close are no-ops and never call open()", async () => {
    const { open, windows } = makeOpen();
    const docket = createDocket({ open, disabled: true });

    await docket.show("<p>x</p>");
    await docket.hide();
    await docket.close();

    expect(windows).toHaveLength(0);
  });

  test("PLACEHOLDER_HTML is a non-empty html snippet", () => {
    expect(typeof PLACEHOLDER_HTML).toBe("string");
    expect(PLACEHOLDER_HTML).toMatch(/<body/i);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails for the right reason**

```bash
npx vitest run test/docket.test.ts
```

Expected: failure on `Cannot find module '../src/docket.js'` (module does not exist yet). This confirms we're about to create real behavior, not re-exercise an existing module.

- [ ] **Step 3: Commit the failing test**

```bash
git commit -m "test(docket): failing unit tests for Docket module" -- test/docket.test.ts
```

---

## Task 3: Implement `src/docket.ts`

**Files:**
- Create: `src/docket.ts`

- [ ] **Step 1: Write `src/docket.ts` with the minimum behavior to pass the tests**

Create `src/docket.ts` with:

Note: `glimpseui` ships as `.mjs` with no `.d.ts`. Under `strict` + NodeNext, importing it directly will fail to typecheck. We model the subset we use as a structural type (`GlimpseOpen` / `GWindow`) and load the real module via a lazy dynamic `import()` wrapped in `@ts-expect-error`. This keeps `src/` typecheck-clean while letting the daemon actually spawn windows at runtime.

```ts
export type HudMode = "always" | "lazy";

/** Subset of glimpseui's GlimpseWindow that Docket touches. */
export type GWindow = {
  setHTML: (html: string) => void;
  close: () => void;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

export type GlimpseOpen = (html: string, options: Record<string, unknown>) => GWindow;

export interface DocketOptions {
  /** Injected glimpseui.open (for tests). Defaults to the real module loaded lazily. */
  open?: GlimpseOpen;
  hudMode?: HudMode;
  /** When true, show/hide/close are no-ops. Used by tests and CI. */
  disabled?: boolean;
  /** Max time to wait for the probe window's `ready` event. */
  probeTimeoutMs?: number;
}

export interface Docket {
  show(html: string, title?: string): Promise<void>;
  hide(): Promise<void>;
  close(): Promise<void>;
}

type ScreenDims = { width: number; height: number };

const HUD_WIDTH = 320;
const HUD_HEIGHT = 400;
const MARGIN = 20;
const DEFAULT_PROBE_TIMEOUT_MS = 3000;

export const PLACEHOLDER_HTML = `<!doctype html>
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
</body>`;

async function loadGlimpseOpen(): Promise<GlimpseOpen> {
  // glimpseui ships .mjs without types; cast through unknown at the boundary.
  // @ts-expect-error no types for "glimpseui"
  const mod = (await import("glimpseui")) as { open: GlimpseOpen };
  return mod.open;
}

export function createDocket(opts: DocketOptions = {}): Docket {
  const disabled = opts.disabled === true;
  const probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  let openFn: GlimpseOpen | null = opts.open ?? null;

  async function getOpen(): Promise<GlimpseOpen> {
    if (openFn) return openFn;
    openFn = await loadGlimpseOpen();
    return openFn;
  }

  let win: GWindow | null = null;
  let dims: ScreenDims | null = null;
  let probeInFlight: Promise<ScreenDims> | null = null;

  async function probe(): Promise<ScreenDims> {
    if (dims) return dims;
    if (probeInFlight) return probeInFlight;
    const open = await getOpen();
    probeInFlight = new Promise<ScreenDims>((resolve, reject) => {
      const probeWin = open("", {
        width: 1,
        height: 1,
        x: -10000,
        y: -10000,
        frameless: true,
        transparent: true,
        clickThrough: true,
        noDock: true,
      });
      const timer = setTimeout(() => {
        try { probeWin.close(); } catch { /* ignore */ }
        reject(new Error(`docket: probe timed out after ${probeTimeoutMs}ms`));
      }, probeTimeoutMs);
      probeWin.once("ready", (...args: unknown[]) => {
        clearTimeout(timer);
        const info = args[0] as { screen?: { visibleWidth?: number; visibleHeight?: number } } | undefined;
        const width = info?.screen?.visibleWidth ?? 0;
        const height = info?.screen?.visibleHeight ?? 0;
        try { probeWin.close(); } catch { /* ignore */ }
        if (!width || !height) {
          reject(new Error(`docket: probe returned invalid dims (${width}×${height})`));
          return;
        }
        dims = { width, height };
        resolve(dims);
      });
      probeWin.once("error", (...args: unknown[]) => {
        clearTimeout(timer);
        try { probeWin.close(); } catch { /* ignore */ }
        const err = args[0];
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    }).finally(() => {
      probeInFlight = null;
    });
    return probeInFlight;
  }

  function openReal(open: GlimpseOpen, html: string, d: ScreenDims): GWindow {
    const w = open(html, {
      width: HUD_WIDTH,
      height: HUD_HEIGHT,
      x: d.width - HUD_WIDTH - MARGIN,
      y: d.height - HUD_HEIGHT - MARGIN,
      frameless: true,
      transparent: true,
      clickThrough: true,
      floating: true,
      noDock: true,
    });
    w.once("closed", () => {
      if (win === w) win = null;
    });
    return w;
  }

  return {
    async show(html: string): Promise<void> {
      if (disabled) return;
      if (win) {
        win.setHTML(html);
        return;
      }
      const d = await probe();
      // Another concurrent show() may have opened the window while we awaited.
      if (win) {
        (win as GWindow).setHTML(html);
        return;
      }
      const open = await getOpen();
      win = openReal(open, html, d);
    },
    async hide(): Promise<void> {
      if (disabled) return;
      if (!win) return;
      try { win.close(); } catch { /* ignore */ }
      win = null;
    },
    async close(): Promise<void> {
      if (disabled) return;
      if (win) {
        try { win.close(); } catch { /* ignore */ }
        win = null;
      }
    },
  };
}
```

- [ ] **Step 2: Run the Docket tests**

```bash
npx vitest run test/docket.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 3: Typecheck**

```bash
npx tsc -p tsconfig.test.json
npm run build
```

Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(docket): glimpseui-owning HUD module with probe-based positioning" -- src/docket.ts
```

---

## Task 4: Wire `Docket` into the daemon

**Files:**
- Modify: `src/daemon.ts`
- Modify: `test/adapter-daemon.test.ts` (the existing `describe("show handler")` block)

This task updates the handler name, drives a real `Docket`, and adds a `hide` handler. We keep all existing payload-validation coverage and add a parallel block for `hide`.

- [ ] **Step 1: Update `test/adapter-daemon.test.ts` to target the new API (failing)**

Replace the `describe("show handler", ...)` block (currently `test/adapter-daemon.test.ts:54-81`) with:

```ts
  describe("docket handlers", () => {
    let docket: ReturnType<typeof import("../src/docket.js")["createDocket"]>;

    beforeEach(async () => {
      const { createDocket } = await import("../src/docket.js");
      docket = createDocket({ disabled: true });
      const { registerDocketHandlers } = await import("../src/daemon.js");
      registerDocketHandlers(daemon, docket);
    });

    describe("show", () => {
      test("accepts a well-formed payload and acks", async () => {
        const result = await client.request("show", {
          html: "<h1>hi</h1>",
          title: "Greetings",
        });
        expect(result).toEqual({ ok: true });
      });

      test("accepts html without a title", async () => {
        const result = await client.request("show", { html: "<p>nope</p>" });
        expect(result).toEqual({ ok: true });
      });

      test("rejects a missing html field", async () => {
        await expect(client.request("show", {})).rejects.toThrow(/html.*must be a string/);
      });

      test("rejects a non-string title", async () => {
        await expect(
          client.request("show", { html: "<p>x</p>", title: 42 }),
        ).rejects.toThrow(/title.*must be a string/);
      });
    });

    describe("hide", () => {
      test("acks with ok regardless of prior state", async () => {
        const result = await client.request("hide", {});
        expect(result).toEqual({ ok: true });
      });

      test("acks after show", async () => {
        await client.request("show", { html: "<p>x</p>" });
        const result = await client.request("hide", {});
        expect(result).toEqual({ ok: true });
      });
    });
  });
```

Also update the top-level import line at `test/adapter-daemon.test.ts:2`:

```ts
import { startDaemon, type Daemon } from "../src/daemon.js";
```

(Remove `registerShowHandler` — it won't exist anymore.)

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/adapter-daemon.test.ts
```

Expected: failure referencing `registerDocketHandlers` not exported from `../src/daemon.js`. Good — test is shaped against the target API.

- [ ] **Step 3: Update `src/daemon.ts` to implement the new API**

In `src/daemon.ts`, replace the `registerShowHandler` function (currently `src/daemon.ts:114-128`) and update `runDaemonMain` (`src/daemon.ts:130-144`). The final state of both sections should be:

```ts
// At the top of the file, alongside the existing imports:
import { createDocket, PLACEHOLDER_HTML, type Docket } from "./docket.js";

// ... (keep all existing code above registerShowHandler)

export type ShowParams = { html: string; title?: string };

export function registerDocketHandlers(
  daemon: Pick<Daemon, "onRequest">,
  docket: Docket,
) {
  daemon.onRequest("show", async (params) => {
    const p = params as Partial<ShowParams> | null;
    if (!p || typeof p.html !== "string") {
      throw new Error("show: 'html' must be a string");
    }
    if (p.title !== undefined && typeof p.title !== "string") {
      throw new Error("show: 'title' must be a string when provided");
    }
    await docket.show(p.html, p.title);
    return { ok: true };
  });
  daemon.onRequest("hide", async () => {
    await docket.hide();
    return { ok: true };
  });
}

export async function runDaemonMain() {
  const paths = resolvePaths();
  try {
    const daemon = await startDaemon(paths);
    const docket = createDocket({
      hudMode: paths.hudMode,
      disabled: paths.docketDisabled,
    });
    registerDocketHandlers(daemon, docket);
    if (paths.hudMode === "always" && !paths.docketDisabled) {
      // Fire-and-forget: don't crash the daemon if the GUI is unavailable.
      docket.show(PLACEHOLDER_HTML).catch((err) => {
        console.error("docket: initial placeholder failed:", err);
      });
    }
    const shutdown = async () => {
      try { await docket.close(); } catch { /* ignore */ }
    };
    process.on("exit", () => { void shutdown(); });
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE") {
      process.exit(0);
    }
    throw err;
  }
}
```

**Delete** the old `registerShowHandler` function entirely, plus the `daemon.onRequest("ping", …)` line in `runDaemonMain`. The spec (§3) says "Drops the leftover `ping` stub".

- [ ] **Step 4: Run the full test suite**

```bash
npx tsc -p tsconfig.test.json
npm test
```

Expected: all tests pass. The `e2e.test.ts` tests will still assert on `docket_show` at this stage — they should still pass because we haven't renamed the tool yet. If they fail because `registerDocketShow` in `adapter.ts` no longer compiles, stop here — it should still compile; nothing in adapter.ts has changed yet.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(daemon): drive Docket from show/hide handlers; drop ping stub" -- src/daemon.ts test/adapter-daemon.test.ts
```

---

## Task 5: Rename adapter MCP tools → `set_docket` + `hide_docket`

**Files:**
- Modify: `src/adapter.ts`
- Modify: `test/e2e.test.ts`

- [ ] **Step 1: Update `test/e2e.test.ts` to fail against the new tool names**

At `test/e2e.test.ts:14-16`, extend the `beforeEach` so the Docket stays disabled during e2e (the daemon starts in `always` mode by default, which would try to spawn glimpse on a CI runner):

```ts
  beforeEach(() => {
    env = freshEnv({
      CLAWD_DOCKLET_IDLE_MS: "300",
      CLAWD_DOCKLET_DOCKET_DISABLED: "1",
    });
  });
```

Then replace the two existing tool tests and add a hide test. The final block (lines `29-71` today) should be:

```ts
  test("initialize handshake advertises set_docket and hide_docket tools", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: env as NodeJS.ProcessEnv as Record<string, string>,
    });
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });

    await client.connect(transport);
    const info = client.getServerVersion();
    expect(info?.name).toBe("clawd-docklet");
    expect(info?.version).toBe("0.0.1");

    const caps = client.getServerCapabilities();
    expect(caps?.tools).toBeDefined();

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["set_docket", "hide_docket"]));
    expect(names).not.toContain("docket_show");

    await client.close();
  });

  test("calling set_docket forwards to the daemon and returns ok", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: env as NodeJS.ProcessEnv as Record<string, string>,
    });
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);

    const result = await client.callTool({
      name: "set_docket",
      arguments: { html: "<h1>hello</h1>", title: "greet" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.type).toBe("text");
    expect(content[0]?.text).toBe("ok");

    await client.close();
  });

  test("calling hide_docket forwards to the daemon and returns ok", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: env as NodeJS.ProcessEnv as Record<string, string>,
    });
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);

    const result = await client.callTool({
      name: "hide_docket",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toBe("ok");

    await client.close();
  });
```

Leave the `"two adapters share one daemon"` test unchanged.

- [ ] **Step 2: Run e2e — verify it fails**

```bash
npm run build && npx vitest run test/e2e.test.ts
```

Expected: failures on `set_docket` / `hide_docket` not being in `tools/list`. This is the TDD red step.

- [ ] **Step 3: Update `src/adapter.ts`**

In `src/adapter.ts`, replace the existing `registerDocketShow` function (`src/adapter.ts:95-112`) with:

```ts
export function registerDocketTools(mcp: McpServer, daemon: Pick<DaemonClient, "request">) {
  mcp.registerTool(
    "set_docket",
    {
      title: "Set HTML in Docklet HUD",
      description:
        "Render the given HTML in the shared Docklet HUD window (top-right of the screen, frameless, transparent, clickthrough). Multiple MCP clients share a single window owned by the daemon; each call replaces the previous HTML.",
      inputSchema: {
        html: z.string().describe("HTML document or fragment to render."),
        title: z.string().optional().describe("Optional window title."),
      },
    },
    async ({ html, title }) => {
      await daemon.request("show", { html, title });
      return { content: [{ type: "text", text: "ok" }] };
    },
  );

  mcp.registerTool(
    "hide_docket",
    {
      title: "Hide the Docklet HUD",
      description:
        "Close the shared Docklet HUD window. A subsequent `set_docket` will reopen it.",
      inputSchema: {},
    },
    async () => {
      await daemon.request("hide", {});
      return { content: [{ type: "text", text: "ok" }] };
    },
  );
}
```

Then update the call inside `runAdapterMain` (`src/adapter.ts:120`) from:

```ts
  registerDocketShow(mcp, daemon);
```

to:

```ts
  registerDocketTools(mcp, daemon);
```

- [ ] **Step 4: Rebuild, run the full test suite**

```bash
npm run build
npm test
```

Expected: every test passes (protocol + adapter-daemon + docket + e2e).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(adapter): rename docket_show → set_docket; add hide_docket" -- src/adapter.ts test/e2e.test.ts
```

---

## Task 6: Manual smoke test (GUI-visible)

**Files:** none (verification step). Run this on a macOS machine with a display.

The automated tests run with `CLAWD_DOCKLET_DOCKET_DISABLED=1`. This task verifies the real glimpseui path works end-to-end.

- [ ] **Step 1: Rebuild and clear any running daemon**

```bash
npm run build
pkill -f "dist/index.js" || true
rm -f "$HOME/Library/Application Support/clawd-docklet/daemon.sock" \
      "$HOME/Library/Application Support/clawd-docklet/daemon.pid"
```

- [ ] **Step 2: Start the daemon in `always` mode and confirm the placeholder HUD appears**

```bash
CLAWD_DOCKLET_ROLE=daemon CLAWD_DOCKLET_IDLE_MS=0 node ./dist/index.js &
DAEMON_PID=$!
sleep 1
```

Expected: a small pill with a green dot and "clawd-docklet" text appears in the top-right corner of the primary display. Frameless, translucent, does not accept clicks (clickthrough).

- [ ] **Step 3: Replace its contents via a transient MCP client**

Use any MCP client (e.g., Claude Code running against `dist/index.js`) and call:

```json
{ "name": "set_docket", "arguments": { "html": "<body style='background:rgba(0,0,0,0.6);color:white;padding:20px;font-family:system-ui'>Hello from smoke test</body>" } }
```

Expected: the HUD's contents update in place. No flicker, no reposition (same window).

- [ ] **Step 4: Call `hide_docket`**

Expected: the HUD window closes.

- [ ] **Step 5: Call `set_docket` again with a new payload**

Expected: the HUD re-opens at the top-right with the new content, no noticeable probe delay (cached dims).

- [ ] **Step 6: Stop the daemon**

```bash
kill "$DAEMON_PID"
```

- [ ] **Step 7: Record the result**

Note in `bd remember` whether the smoke test passed:

```bash
bd remember "docklet HUD smoke test on macOS $(sw_vers -productVersion): placeholder visible, set_docket updates in place, hide closes, reopen is fast. Verified on commit $(git rev-parse --short HEAD)."
```

If any step fails, file a follow-up issue and keep `docklet-878` open until resolved.

---

## Task 7: Final verification and close-out

**Files:** none (verification + process).

- [ ] **Step 1: Run the full test suite one more time**

```bash
npm run build && npm test
```

Expected: all tests pass. Four suites: `test/protocol.test.ts`, `test/docket.test.ts`, `test/adapter-daemon.test.ts`, `test/e2e.test.ts`.

- [ ] **Step 2: Run preflight checks**

```bash
bd preflight
```

Address any `bd lint` / `bd stale` / `bd orphans` output before proceeding.

- [ ] **Step 3: Close `docklet-878`**

```bash
bd close docklet-878 --reason="Docket HUD shipped: set_docket/hide_docket tools, daemon-owned glimpseui window with probe-based top-right positioning, hudMode + docketDisabled knobs."
```

- [ ] **Step 4: Push everything**

```bash
git pull --rebase
bd dolt push
git push
git status   # must show "up to date with origin"
```

- [ ] **Step 5: Hand off**

Report the commit SHAs, the smoke-test result, and the spec filename so the next session knows where to pick up follow-ups (rename `docket` → something better; consider `resize_docket`; revisit placeholder design).

---

## Out-of-scope reminders (from spec §14)

Do **not** implement any of the following in this plan. File a beads issue if you notice a real need:

- Multi-monitor awareness (always uses primary display)
- `eval_hud_js` tool for incremental JS eval
- Persistent HUD state across daemon restarts
- Interactive HUD (would require disabling clickthrough)
- Dynamic content-height resizing
- Linux/Windows-specific polish (should just work via glimpseui but not explicitly tested here)
