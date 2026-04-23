import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
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

  test("concurrent show calls share a single probe and both HTMLs land", async () => {
    const { open, windows } = makeOpen((w) => {
      if (windows.length === 1) setTimeout(() => fireReady(w), 5);
    });
    const docket = createDocket({ open });

    await Promise.all([docket.show("<p>a</p>"), docket.show("<p>b</p>")]);

    // One probe + one real HUD.
    expect(windows).toHaveLength(2);

    // Whichever show won the race: its HTML went in via the real window's
    // initial open() arg; the loser's HTML went in via setHTML. Together they
    // cover {"<p>a</p>", "<p>b</p>"}.
    const landed = [
      windows[1].openArgs.html,
      ...windows[1].setHTML.mock.calls.map((c) => c[0] as string),
    ];
    expect(landed).toEqual(expect.arrayContaining(["<p>a</p>", "<p>b</p>"]));
  });

  test("probe timeout rejects show and closes the probe window", async () => {
    vi.useFakeTimers();
    const { open, windows } = makeOpen(); // never fires ready
    const docket = createDocket({ open, probeTimeoutMs: 500 });

    const p = docket.show("<p>x</p>");
    vi.advanceTimersByTime(600);
    await expect(p).rejects.toThrow(/probe.*timed out/i);
    // Leaking the probe window = leaking a native glimpse process in prod.
    expect(windows[0].close).toHaveBeenCalledTimes(1);
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
