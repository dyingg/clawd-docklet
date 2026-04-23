import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type Anchor =
  | "top-right"
  | "top-left"
  | "bottom-right"
  | "bottom-left"
  | "follow-cursor";

export type Config = { anchor: Anchor };

export const DEFAULT_CONFIG: Config = { anchor: "top-right" };

const ANCHORS: readonly Anchor[] = [
  "top-right",
  "top-left",
  "bottom-right",
  "bottom-left",
  "follow-cursor",
];

export function isAnchor(v: unknown): v is Anchor {
  return typeof v === "string" && (ANCHORS as readonly string[]).includes(v);
}

export async function readConfig(path: string): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_CONFIG };
  const a = (parsed as { anchor?: unknown }).anchor;
  if (!isAnchor(a)) return { ...DEFAULT_CONFIG };
  return { anchor: a };
}

export async function writeConfig(path: string, config: Config): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2));
  await rename(tmp, path);
}
