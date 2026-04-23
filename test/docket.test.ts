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

    // Real HUD: 480×400 anchored top-right from 1440×900.
    expect(windows[1].openArgs.html).toBe("<h1>hi</h1>");
    expect(windows[1].openArgs.options).toMatchObject({
      width: 480,
      height: 400,
      x: 1440 - 480 - 20,
      y: 900 - 400 - 20,
      frameless: true,
      transparent: true,
      clickThrough: true,
      floating: true,
      noDock: true,
    });
  });

  test("title is forwarded to the real HUD's open options when provided", async () => {
    const { open, windows } = makeOpen((w) => {
      if (windows.length === 1) fireReady(w, 1440, 900);
    });
    const docket = createDocket({ open });

    await docket.show("<h1>hi</h1>", "My HUD");

    expect(windows).toHaveLength(2);
    expect(windows[1].openArgs.options.title).toBe("My HUD");
  });

  test("title is omitted from open options when not provided", async () => {
    const { open, windows } = makeOpen((w) => {
      if (windows.length === 1) fireReady(w);
    });
    const docket = createDocket({ open });

    await docket.show("<h1>hi</h1>");

    expect(windows).toHaveLength(2);
    expect(windows[1].openArgs.options).not.toHaveProperty("title");
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
      width: 480,
      height: 400,
      x: 2000 - 480 - 20,
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

  test("initial anchor top-left lands the HUD at left edge", async () => {
    const { open, windows } = makeOpen((w) => {
      if (windows.length === 1) fireReady(w, 1440, 900);
    });
    const docket = createDocket({ open, anchor: "top-left" });

    await docket.show("<h1>hi</h1>");

    expect(windows).toHaveLength(2);
    expect(windows[1].openArgs.options).toMatchObject({
      width: 480,
      height: 400,
      x: 20,
      y: 900 - 400 - 20,
    });
  });

  test("initial anchor bottom-right lands the HUD at bottom-right", async () => {
    const { open, windows } = makeOpen((w) => {
      if (windows.length === 1) fireReady(w, 1440, 900);
    });
    const docket = createDocket({ open, anchor: "bottom-right" });

    await docket.show("<h1>hi</h1>");

    expect(windows[1].openArgs.options).toMatchObject({
      x: 1440 - 480 - 20,
      y: 20,
    });
  });

  test("initial anchor bottom-left lands the HUD at origin + margin", async () => {
    const { open, windows } = makeOpen((w) => {
      if (windows.length === 1) fireReady(w, 1440, 900);
    });
    const docket = createDocket({ open, anchor: "bottom-left" });

    await docket.show("<h1>hi</h1>");

    expect(windows[1].openArgs.options).toMatchObject({ x: 20, y: 20 });
  });

  test("top anchors honor visibleY (dock at bottom) — HUD sits flush under the menu bar", async () => {
    // Simulate a 1440×900 visible area offset by a 90px dock at the bottom.
    // Without visibleY support the HUD would land 90px below the menu bar.
    const { open, windows } = makeOpen((w) => {
      if (windows.length === 1) {
        w.emit("ready", {
          screen: {
            visibleWidth: 1440,
            visibleHeight: 900,
            visibleX: 0,
            visibleY: 90,
          },
        });
      }
    });
    const docket = createDocket({ open, anchor: "top-right" });
    await docket.show("<h1>hi</h1>");
    expect(windows[1].openArgs.options).toMatchObject({
      x: 0 + 1440 - 480 - 20,
      y: 90 + 900 - 400 - 20,
    });
  });

  test("follow-cursor sets followCursor and omits explicit x/y", async () => {
    const { open, windows } = makeOpen((w) => {
      if (windows.length === 1) fireReady(w, 1440, 900);
    });
    const docket = createDocket({ open, anchor: "follow-cursor" });

    await docket.show("<h1>hi</h1>");

    const opts = windows[1].openArgs.options;
    expect(opts).toMatchObject({ followCursor: true, width: 480, height: 400 });
    expect(opts).not.toHaveProperty("x");
    expect(opts).not.toHaveProperty("y");
  });

  test("setAnchor to a new corner closes old window and reopens at new position with preserved HTML + title", async () => {
    const { open, windows } = makeOpen((w) => {
      if (windows.length === 1) fireReady(w, 1440, 900);
    });
    const docket = createDocket({ open });

    await docket.show("<p>kept</p>", "My HUD");
    await docket.setAnchor("bottom-left");

    // windows[0] probe, windows[1] first HUD (closed), windows[2] reopened HUD.
    expect(windows).toHaveLength(3);
    expect(windows[1].close).toHaveBeenCalledTimes(1);
    expect(windows[2].openArgs.html).toBe("<p>kept</p>");
    expect(windows[2].openArgs.options).toMatchObject({
      x: 20,
      y: 20,
      title: "My HUD",
    });
  });

  test("setAnchor to the same anchor is a no-op (no close/reopen)", async () => {
    const { open, windows } = makeOpen((w) => {
      if (windows.length === 1) fireReady(w);
    });
    const docket = createDocket({ open });

    await docket.show("<p>x</p>");
    await docket.setAnchor("top-right");

    expect(windows).toHaveLength(2);
    expect(windows[1].close).not.toHaveBeenCalled();
  });

  test("setAnchor before any show just updates the default for the next open", async () => {
    const { open, windows } = makeOpen((w) => {
      if (windows.length === 1) fireReady(w, 1440, 900);
    });
    const docket = createDocket({ open });

    await docket.setAnchor("bottom-right");
    await docket.show("<p>first</p>");

    expect(windows).toHaveLength(2);
    expect(windows[1].openArgs.options).toMatchObject({
      x: 1440 - 480 - 20,
      y: 20,
    });
  });

  test("setAnchor to follow-cursor reopens with followCursor true", async () => {
    const { open, windows } = makeOpen((w) => {
      if (windows.length === 1) fireReady(w);
    });
    const docket = createDocket({ open });

    await docket.show("<p>x</p>");
    await docket.setAnchor("follow-cursor");

    expect(windows).toHaveLength(3);
    const opts = windows[2].openArgs.options;
    expect(opts).toMatchObject({ followCursor: true });
    expect(opts).not.toHaveProperty("x");
  });

  test("setAnchor is a no-op when disabled", async () => {
    const { open, windows } = makeOpen();
    const docket = createDocket({ open, disabled: true });
    await docket.setAnchor("bottom-left");
    expect(windows).toHaveLength(0);
  });
});
