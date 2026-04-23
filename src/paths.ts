import { homedir, platform } from "node:os";
import { join } from "node:path";

export type Paths = {
  socketPath: string;
  pidfilePath: string;
  idleMs: number;
};

function defaultSocketDir(): string {
  const plat = platform();
  if (plat === "darwin") {
    return join(homedir(), "Library", "Application Support", "clawd-docklet");
  }
  if (plat === "win32") {
    // Named pipes on Windows don't live on the filesystem; pidfile goes in LOCALAPPDATA.
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

export function resolvePaths(): Paths {
  return {
    socketPath: process.env.CLAWD_DOCKLET_SOCKET ?? defaultSocketPath(),
    pidfilePath: process.env.CLAWD_DOCKLET_PIDFILE ?? defaultPidfilePath(),
    idleMs: Number.parseInt(process.env.CLAWD_DOCKLET_IDLE_MS ?? "30000", 10),
  };
}
