import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FreshEnv = NodeJS.ProcessEnv & {
  CLAWD_DOCKLET_SOCKET: string;
  CLAWD_DOCKLET_PIDFILE: string;
  CLAWD_DOCKLET_IDLE_MS: string;
  __tmpDir: string;
};

export function freshEnv(overrides: Partial<FreshEnv> = {}): FreshEnv {
  const dir = mkdtempSync(join(tmpdir(), "clawd-docklet-"));
  return {
    ...process.env,
    CLAWD_DOCKLET_SOCKET: join(dir, "daemon.sock"),
    CLAWD_DOCKLET_PIDFILE: join(dir, "daemon.pid"),
    CLAWD_DOCKLET_IDLE_MS: "60000",
    // Safety rail: tests never touch the user's menu bar.
    CLAWD_DOCKLET_STATUS_DISABLED: "1",
    __tmpDir: dir,
    ...overrides,
  } as FreshEnv;
}

export function cleanupEnv(env: FreshEnv): void {
  try {
    rmSync(env.__tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
