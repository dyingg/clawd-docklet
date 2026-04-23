import { describe, expect, test, vi } from "vitest";
import { createDocketBuffer } from "../src/docket-buffer.js";

describe("DocketBuffer", () => {
  describe("read", () => {
    test("empty buffer returns empty html and version 0", () => {
      const buf = createDocketBuffer();
      const { html, version } = buf.read("client-a");
      expect(html).toBe("");
      expect(version).toBe(0);
    });

    test("initialHtml surfaces with version 0 until first mutation", () => {
      const buf = createDocketBuffer({ initialHtml: "<p>hi</p>" });
      expect(buf.read("client-a")).toEqual({ html: "<p>hi</p>", version: 0 });
    });

    test("arms the client against subsequent edits", () => {
      const buf = createDocketBuffer();
      buf.write("<div>a</div>");                  // version 1
      buf.read("client-a");                        // arms client-a at v1
      const result = buf.edit("client-a", {
        old_string: "a",
        new_string: "b",
      });
      expect(result).toEqual({ ok: true, version: 2 });
    });
  });

  describe("write", () => {
    test("returns incrementing version and updates html", () => {
      const buf = createDocketBuffer();
      expect(buf.write("<p>one</p>")).toBe(1);
      expect(buf.write("<p>two</p>")).toBe(2);
      expect(buf.read("c").html).toBe("<p>two</p>");
    });

    test("fires onChange with new html", async () => {
      const onChange = vi.fn();
      const buf = createDocketBuffer({ onChange });
      buf.write("<p>x</p>");
      // onChange can be sync or async; flush microtasks
      await Promise.resolve();
      expect(onChange).toHaveBeenCalledWith("<p>x</p>");
    });
  });

  describe("hide", () => {
    test("sets html to empty string and bumps version", () => {
      const buf = createDocketBuffer({ initialHtml: "<p>x</p>" });
      expect(buf.hide()).toBe(1);
      expect(buf.read("c").html).toBe("");
    });

    test("bumps version even when already empty", () => {
      const buf = createDocketBuffer();
      expect(buf.hide()).toBe(1);
      expect(buf.hide()).toBe(2);
    });

    test("fires onChange with empty string", async () => {
      const onChange = vi.fn();
      const buf = createDocketBuffer({ initialHtml: "<p>x</p>", onChange });
      buf.hide();
      await Promise.resolve();
      expect(onChange).toHaveBeenCalledWith("");
    });
  });

  describe("edit — gate", () => {
    test("MustReadFirst when client has never read", () => {
      const buf = createDocketBuffer({ initialHtml: "<p>hi</p>" });
      buf.write("<p>hi</p>");
      const result = buf.edit("client-a", { old_string: "hi", new_string: "bye" });
      expect(result).toEqual({
        ok: false,
        code: "MustReadFirst",
        message: expect.stringContaining("read_docket"),
      });
    });

    test("StaleRead when another mutation happened after the client's read", () => {
      const buf = createDocketBuffer();
      buf.write("<p>v1</p>");            // version 1
      buf.read("client-a");               // arms A at v1
      buf.write("<p>v2</p>");            // version 2 (by someone else)
      const result = buf.edit("client-a", { old_string: "v2", new_string: "v3" });
      expect(result).toEqual({
        ok: false,
        code: "StaleRead",
        message: expect.stringContaining("read_docket"),
      });
    });

    test("NoMatch when old_string is absent", () => {
      const buf = createDocketBuffer({ initialHtml: "<p>hi</p>" });
      buf.read("c");
      const result = buf.edit("c", { old_string: "missing", new_string: "x" });
      expect(result).toEqual({
        ok: false,
        code: "NoMatch",
        message: expect.stringContaining("not found"),
      });
    });

    test("Ambiguous when old_string matches >1 without replace_all", () => {
      const buf = createDocketBuffer({ initialHtml: "<b>x</b><b>x</b>" });
      buf.read("c");
      const result = buf.edit("c", { old_string: "x", new_string: "y" });
      expect(result).toEqual({
        ok: false,
        code: "Ambiguous",
        message: expect.stringMatching(/matches 2/),
      });
    });

    test("replace_all succeeds on multiple occurrences", () => {
      const buf = createDocketBuffer({ initialHtml: "<b>x</b><b>x</b>" });
      buf.read("c");
      const result = buf.edit("c", { old_string: "x", new_string: "y", replace_all: true });
      expect(result).toEqual({ ok: true, version: 1 });
      expect(buf.read("c").html).toBe("<b>y</b><b>y</b>");
    });

    test("NoOp when old_string === new_string", () => {
      const buf = createDocketBuffer({ initialHtml: "<p>hi</p>" });
      buf.read("c");
      const result = buf.edit("c", { old_string: "hi", new_string: "hi" });
      expect(result).toEqual({
        ok: false,
        code: "NoOp",
        message: expect.stringContaining("differ"),
      });
    });
  });

  describe("edit — happy path", () => {
    test("applies replacement, bumps version, re-arms the editing client", () => {
      const buf = createDocketBuffer({ initialHtml: "<p>hi</p>" });
      buf.read("c");                                      // v0
      const first = buf.edit("c", { old_string: "hi", new_string: "bye" });
      expect(first).toEqual({ ok: true, version: 1 });
      expect(buf.read("c").html).toBe("<p>bye</p>");
      // The editing client can immediately edit again (re-armed at v1).
      const second = buf.edit("c", { old_string: "bye", new_string: "ok" });
      expect(second).toEqual({ ok: true, version: 2 });
    });

    test("does NOT re-arm other clients", () => {
      const buf = createDocketBuffer({ initialHtml: "<p>hi</p>" });
      buf.read("a");
      buf.read("b");
      buf.edit("a", { old_string: "hi", new_string: "bye" });
      // b's last read was at v0; buffer is now v1 → stale.
      const bResult = buf.edit("b", { old_string: "bye", new_string: "ok" });
      expect(bResult).toMatchObject({ ok: false, code: "StaleRead" });
    });

    test("fires onChange with the new html", async () => {
      const onChange = vi.fn();
      const buf = createDocketBuffer({ initialHtml: "<p>hi</p>", onChange });
      buf.read("c");
      buf.edit("c", { old_string: "hi", new_string: "bye" });
      await Promise.resolve();
      expect(onChange).toHaveBeenLastCalledWith("<p>bye</p>");
    });
  });

  describe("forgetClient", () => {
    test("removes bookkeeping; next edit must re-read", () => {
      const buf = createDocketBuffer({ initialHtml: "<p>hi</p>" });
      buf.read("c");
      buf.forgetClient("c");
      const result = buf.edit("c", { old_string: "hi", new_string: "bye" });
      expect(result).toMatchObject({ ok: false, code: "MustReadFirst" });
    });

    test("no-op when client unknown", () => {
      const buf = createDocketBuffer();
      expect(() => buf.forgetClient("never-seen")).not.toThrow();
    });
  });

  describe("getVersion", () => {
    test("reflects the current monotonic version", () => {
      const buf = createDocketBuffer();
      expect(buf.getVersion()).toBe(0);
      buf.write("<p>a</p>");
      expect(buf.getVersion()).toBe(1);
      buf.hide();
      expect(buf.getVersion()).toBe(2);
    });
  });
});
