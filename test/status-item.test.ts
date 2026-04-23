import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import {
  createStatusItem,
  renderPopoverHtml,
  type GStatusWindow,
  type GlimpseStatusFactory,
} from "../src/status-item.js";

class FakeStatusWindow extends EventEmitter {
  setHTML = vi.fn<(html: string) => void>();
  close = vi.fn<() => void>();
  constructor(
    public openArgs: {
      html: string;
      options: { width: number; height: number; title?: string };
    }
  ) {
    super();
  }
}

function makeFactory() {
  const windows: FakeStatusWindow[] = [];
  const factory: GlimpseStatusFactory = (html, options) => {
    const w = new FakeStatusWindow({ html, options });
    windows.push(w);
    return w as unknown as GStatusWindow;
  };
  return { factory, windows };
}

describe("renderPopoverHtml", () => {
  test("marks the selected anchor row active", () => {
    const html = renderPopoverHtml("bottom-left");
    // The embedded script sets SELECTED from this literal; use it as a proxy.
    expect(html).toContain('var SELECTED = "bottom-left"');
    // All five anchor rows are present.
    for (const a of [
      "top-right",
      "top-left",
      "bottom-right",
      "bottom-left",
      "follow-cursor",
    ]) {
      expect(html).toContain(`data-anchor="${a}"`);
    }
    // Hide row exists and is separated.
    expect(html).toContain('id="hide"');
    expect(html).toMatch(/class="sep"/);
  });

  test("styles adapt to dark mode via prefers-color-scheme", () => {
    const html = renderPopoverHtml("top-right");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("-apple-system");
  });
});

describe("createStatusItem", () => {
  test("opens with initialAnchor rendered selected, at the popover size", () => {
    const { factory, windows } = makeFactory();
    createStatusItem({
      initialAnchor: "follow-cursor",
      onAnchor: vi.fn(),
      onHide: vi.fn(),
      factory,
    });

    expect(windows).toHaveLength(1);
    expect(windows[0].openArgs.options).toMatchObject({
      width: 240,
      height: 224,
      title: "▣",
    });
    expect(windows[0].openArgs.html).toContain('var SELECTED = "follow-cursor"');
  });

  test("set-anchor message invokes onAnchor with the chosen anchor", () => {
    const onAnchor = vi.fn();
    const onHide = vi.fn();
    const { factory, windows } = makeFactory();
    createStatusItem({
      initialAnchor: "top-right",
      onAnchor,
      onHide,
      factory,
    });

    windows[0].emit("message", { type: "set-anchor", anchor: "bottom-left" });

    expect(onAnchor).toHaveBeenCalledWith("bottom-left");
    expect(onHide).not.toHaveBeenCalled();
  });

  test("hide-hud message invokes onHide", () => {
    const onAnchor = vi.fn();
    const onHide = vi.fn();
    const { factory, windows } = makeFactory();
    createStatusItem({
      initialAnchor: "top-right",
      onAnchor,
      onHide,
      factory,
    });

    windows[0].emit("message", { type: "hide-hud" });

    expect(onHide).toHaveBeenCalledTimes(1);
    expect(onAnchor).not.toHaveBeenCalled();
  });

  test("malformed messages are ignored (no throws, no callbacks)", () => {
    const onAnchor = vi.fn();
    const onHide = vi.fn();
    const { factory, windows } = makeFactory();
    createStatusItem({
      initialAnchor: "top-right",
      onAnchor,
      onHide,
      factory,
    });

    const w = windows[0];
    w.emit("message", null);
    w.emit("message", "hello");
    w.emit("message", { type: "unknown" });
    w.emit("message", { type: "set-anchor" }); // no anchor
    w.emit("message", { type: "set-anchor", anchor: "center" }); // invalid
    w.emit("message", { type: "set-anchor", anchor: 42 });

    expect(onAnchor).not.toHaveBeenCalled();
    expect(onHide).not.toHaveBeenCalled();
  });

  test("setAnchor re-renders popover HTML with new selected state", () => {
    const { factory, windows } = makeFactory();
    const item = createStatusItem({
      initialAnchor: "top-right",
      onAnchor: vi.fn(),
      onHide: vi.fn(),
      factory,
    });

    item.setAnchor("bottom-right");

    expect(windows[0].setHTML).toHaveBeenCalledTimes(1);
    expect(windows[0].setHTML.mock.calls[0][0]).toContain(
      'var SELECTED = "bottom-right"'
    );
  });

  test("close closes the underlying window", () => {
    const { factory, windows } = makeFactory();
    const item = createStatusItem({
      initialAnchor: "top-right",
      onAnchor: vi.fn(),
      onHide: vi.fn(),
      factory,
    });

    item.close();

    expect(windows[0].close).toHaveBeenCalledTimes(1);
  });
});
