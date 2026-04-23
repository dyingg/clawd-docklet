import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { encode, LineDecoder, type Frame } from "./protocol.js";
import { resolvePaths, type Paths } from "./paths.js";

export async function connectDaemon(paths: Paths, timeoutMs = 3000): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await tryConnect(paths.socketPath);
    } catch (err) {
      lastErr = err;
      await sleep(50);
    }
  }
  throw lastErr ?? new Error("daemon did not come up in time");
}

function tryConnect(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    sock.once("connect", () => {
      sock.off("error", reject);
      resolve(sock);
    });
    sock.once("error", reject);
  });
}

function spawnDaemon() {
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CLAWD_DOCKLET_ROLE: "daemon" },
  });
  child.unref();
}

export async function getOrSpawnDaemon(paths: Paths = resolvePaths()): Promise<Socket> {
  try {
    return await tryConnect(paths.socketPath);
  } catch {
    spawnDaemon();
    return await connectDaemon(paths);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Minimal RPC client over the daemon socket — used by future tool handlers.
export class DaemonClient {
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private decoder = new LineDecoder();

  constructor(private sock: Socket) {
    sock.on("data", (chunk) => {
      for (const frame of this.decoder.push(chunk)) this.dispatch(frame);
    });
    sock.on("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("daemon disconnected"));
      this.pending.clear();
    });
  }

  private dispatch(frame: Frame) {
    if (frame.kind !== "res") return;
    const p = this.pending.get(frame.id);
    if (!p) return;
    this.pending.delete(frame.id);
    if (frame.error) p.reject(new Error(frame.error.message));
    else p.resolve(frame.result);
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock.write(encode({ kind: "req", id, method, params }));
    });
  }

  close() {
    this.sock.end();
  }
}

export async function runAdapterMain() {
  const paths = resolvePaths();
  const daemonSock = await getOrSpawnDaemon(paths);
  const daemon = new DaemonClient(daemonSock);

  const mcp = new Server(
    { name: "clawd-docklet", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));

  // Keep the daemon warm while this adapter is connected.
  // Future: route tools/call here through daemon.request(...).
  void daemon;

  const cleanup = () => {
    daemon.close();
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  await mcp.connect(new StdioServerTransport());
}
