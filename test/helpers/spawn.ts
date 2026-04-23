import { readFileSync } from "node:fs";
import { type FreshEnv } from "./env.js";

export function readDaemonPid(env: FreshEnv): number {
  return Number.parseInt(readFileSync(env.CLAWD_DOCKLET_PIDFILE, "utf8"), 10);
}

export async function waitForProcessExit(pid: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(50);
  }
  throw new Error(`process ${pid} did not exit within ${timeoutMs}ms`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
