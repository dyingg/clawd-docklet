import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
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

export function registerDocketTools(mcp: McpServer, daemon: Pick<DaemonClient, "request">) {
  mcp.registerTool(
    "write_docket",
    {
      title: "Write HTML to the Docklet HUD",
      description:
        "Render the given HTML in the shared Docklet HUD window. The HUD is a full web view (Chromium/WebKit) — inline `<script>` runs, `<style>` + CSS animations/transitions work, `setTimeout`/`setInterval` fire, `fetch` is available, and you can draw with canvas/SVG. The viewport is 480×400 pixels, rendered as a frameless, transparent, clickthrough window anchored at a user-configured screen corner (top-right, top-left, bottom-right, bottom-left, or follow-cursor). You CANNOT query the active anchor, so write anchor-agnostic layouts: prefer content that fills the viewport, uses symmetric edges (e.g. `body{margin:0;padding:20px}` with natural flow, or `position:fixed;inset:20px`), or centers with flex/grid. Avoid pinning to one corner (`position:fixed;top:20px;right:20px` and friends) — that looks visually detached from the chosen corner for 4 of the 5 anchors. The preferred idiom is a HUD — translucent panels/chips with a backdrop blur that float over desktop content (transparent `<body>` background, visible elements use e.g. `rgba(…,0.85)` + `backdrop-filter:blur(24px)`); solid-filled layouts work but feel out of place, so reach for them only when the content demands it. Content outside the 480×400 viewport is clipped. The window is clickthrough, so pointer and keyboard events do NOT reach the page — use JS for visual/timed behavior, not for capturing input. Multiple MCP clients share a single window owned by the daemon; each call replaces the previous HTML (and with it, any running JS state).",
      inputSchema: {
        html: z.string().describe("HTML document or fragment to render."),
        title: z.string().optional().describe("Optional window title."),
      },
    },
    async ({ html, title }) => {
      await daemon.request("write", { html, title });
      return { content: [{ type: "text", text: "ok" }] };
    },
  );

  mcp.registerTool(
    "hide_docket",
    {
      title: "Hide the Docklet HUD",
      description:
        "Close the shared Docklet HUD window. A subsequent `write_docket` will reopen it.",
      inputSchema: {},
    },
    async () => {
      await daemon.request("hide", {});
      return { content: [{ type: "text", text: "ok" }] };
    },
  );

  mcp.registerTool(
    "read_docket",
    {
      title: "Read current Docklet HUD HTML",
      description:
        "Return the HTML currently rendered in the shared Docklet HUD (a 480×400 clickthrough web view anchored at a user-configured screen corner). Note: this returns the HTML as last written or patched — it does NOT reflect DOM mutations made by JavaScript at runtime. You must call this before `edit_docket` — the daemon tracks your last-read version and rejects stale edits. Returns an empty string if the HUD has never been written or was hidden.",
      inputSchema: {},
    },
    async () => {
      const res = (await daemon.request("read", {})) as { html: string; version: number };
      return { content: [{ type: "text", text: res.html }] };
    },
  );

  mcp.registerTool(
    "edit_docket",
    {
      title: "Patch the Docklet HUD HTML by exact string replacement",
      description:
        "Replace `old_string` with `new_string` in the current HUD HTML. Mirrors the semantics of the `Edit` tool on files: `old_string` must match byte-for-byte (including whitespace) and must be unique unless `replace_all` is true. Requires a prior `read_docket` in this session — the daemon rejects edits that race ahead of the reader's view. Use `write_docket` for full-document replacement. The HUD is a live 480×400 web view anchored at a user-configured screen corner; keep edits anchor-agnostic (prefer symmetric edges, filling, or centered layouts over single-corner pins — see `write_docket`). Edits that touch `<script>` contents may cause the browser to re-execute that script block. Overflow outside 480×400 is clipped.",
      inputSchema: {
        old_string: z.string().describe("Exact text to replace. Must match byte-for-byte."),
        new_string: z.string().describe("Replacement text. Must differ from old_string."),
        replace_all: z.boolean().optional().describe("Replace every occurrence instead of requiring uniqueness."),
      },
    },
    async ({ old_string, new_string, replace_all }) => {
      try {
        const res = (await daemon.request("edit", {
          old_string,
          new_string,
          replace_all,
        })) as { ok: true; version: number };
        return { content: [{ type: "text", text: `ok (version=${res.version})` }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );
}

export async function runAdapterMain() {
  const paths = resolvePaths();
  const daemonSock = await getOrSpawnDaemon(paths);
  const daemon = new DaemonClient(daemonSock);

  const mcp = new McpServer({ name: "clawd-docklet", version: "0.0.1" });
  registerDocketTools(mcp, daemon);

  const cleanup = () => {
    daemon.close();
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  await mcp.connect(new StdioServerTransport());
}
