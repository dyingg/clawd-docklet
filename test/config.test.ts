import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  DEFAULT_CONFIG,
  isAnchor,
  readConfig,
  writeConfig,
  type Config,
} from "../src/config.js";

describe("config", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docklet-config-"));
    path = join(dir, "config.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("readConfig returns default when file is missing", async () => {
    expect(await readConfig(path)).toEqual(DEFAULT_CONFIG);
  });

  test("readConfig returns default on invalid JSON", async () => {
    writeFileSync(path, "{ not json");
    expect(await readConfig(path)).toEqual(DEFAULT_CONFIG);
  });

  test("readConfig returns default on unknown anchor value", async () => {
    writeFileSync(path, JSON.stringify({ anchor: "center" }));
    expect(await readConfig(path)).toEqual(DEFAULT_CONFIG);
  });

  test("readConfig returns default when anchor field is missing", async () => {
    writeFileSync(path, JSON.stringify({}));
    expect(await readConfig(path)).toEqual(DEFAULT_CONFIG);
  });

  test("readConfig returns default when top-level is not an object", async () => {
    writeFileSync(path, JSON.stringify("top-right"));
    expect(await readConfig(path)).toEqual(DEFAULT_CONFIG);
  });

  test("writeConfig + readConfig round-trips every valid anchor", async () => {
    for (const anchor of [
      "top-right",
      "top-left",
      "bottom-right",
      "bottom-left",
      "follow-cursor",
    ] as const) {
      const cfg: Config = { anchor };
      await writeConfig(path, cfg);
      expect(await readConfig(path)).toEqual(cfg);
    }
  });

  test("writeConfig creates the parent directory if missing", async () => {
    const nested = join(dir, "nested", "deeper", "config.json");
    await writeConfig(nested, { anchor: "top-left" });
    const raw = JSON.parse(readFileSync(nested, "utf8"));
    expect(raw).toEqual({ anchor: "top-left" });
  });

  test("writeConfig leaves no .tmp file behind after a successful write", async () => {
    await writeConfig(path, { anchor: "bottom-right" });
    const entries = readdirSync(dir);
    expect(entries).toContain("config.json");
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  test("isAnchor accepts all five anchors and rejects others", () => {
    expect(isAnchor("top-right")).toBe(true);
    expect(isAnchor("top-left")).toBe(true);
    expect(isAnchor("bottom-right")).toBe(true);
    expect(isAnchor("bottom-left")).toBe(true);
    expect(isAnchor("follow-cursor")).toBe(true);
    expect(isAnchor("center")).toBe(false);
    expect(isAnchor("")).toBe(false);
    expect(isAnchor(null)).toBe(false);
    expect(isAnchor(undefined)).toBe(false);
    expect(isAnchor(42)).toBe(false);
  });
});
