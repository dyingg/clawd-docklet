import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { platform } from "node:os";
import { encode, LineDecoder, type Frame, type ReqFrame } from "./protocol.js";
import { resolvePaths, type Paths } from "./paths.js";
import { createDocket, PLACEHOLDER_HTML, type Docket } from "./docket.js";
import { createDocketBuffer, type DocketBuffer, type EditParams } from "./docket-buffer.js";

type Handler = (params: unknown, ctx: { connId: string }) => Promise<unknown>;
type ConnectionCloseListener = (connId: string) => void;

export type Daemon = {
  server: Server;
  close: () => Promise<void>;
  onRequest: (method: string, handler: Handler) => void;
  onConnectionClose: (listener: ConnectionCloseListener) => void;
  connections: number;
};

export async function startDaemon(paths: Paths = resolvePaths()): Promise<Daemon> {
  if (platform() !== "win32") {
    mkdirSync(dirname(paths.socketPath), { recursive: true });
    try {
      unlinkSync(paths.socketPath);
    } catch {
      // fine if it doesn't exist
    }
  }

  const handlers = new Map<string, Handler>();
  const closeListeners: ConnectionCloseListener[] = [];
  const conns = new Set<Socket>();
  let idleTimer: NodeJS.Timeout | null = null;

  const server = createServer((sock) => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    conns.add(sock);

    const connId = cryptoRandom();
    const decoder = new LineDecoder();

    sock.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.kind === "req") void dispatch(sock, frame, connId);
      }
    });
    sock.on("close", () => {
      conns.delete(sock);
      for (const l of closeListeners) {
        try { l(connId); } catch { /* ignore */ }
      }
      if (conns.size === 0) scheduleIdleExit();
    });
    sock.on("error", () => {
      conns.delete(sock);
    });
  });

  async function dispatch(sock: Socket, req: ReqFrame, connId: string) {
    const handler = handlers.get(req.method);
    if (!handler) {
      sock.write(
        encode({ kind: "res", id: req.id, error: { code: -32601, message: `unknown method: ${req.method}` } }),
      );
      return;
    }
    try {
      const result = await handler(req.params, { connId });
      sock.write(encode({ kind: "res", id: req.id, result }));
    } catch (err) {
      sock.write(
        encode({
          kind: "res",
          id: req.id,
          error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
        }),
      );
    }
  }

  function scheduleIdleExit() {
    if (idleTimer || paths.idleMs <= 0) return;
    idleTimer = setTimeout(() => {
      server.close(() => process.exit(0));
    }, paths.idleMs);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socketPath, () => {
      server.off("error", reject);
      writeFileSync(paths.pidfilePath, String(process.pid));
      resolve();
    });
  });

  return {
    server,
    get connections() {
      return conns.size;
    },
    onRequest(method, handler) {
      handlers.set(method, handler);
    },
    onConnectionClose(listener) {
      closeListeners.push(listener);
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (idleTimer) clearTimeout(idleTimer);
        for (const c of conns) c.destroy();
        server.close(() => resolve());
      }),
  };
}

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export type WriteParams = { html: string; title?: string };

export function registerDocketHandlers(
  daemon: Pick<Daemon, "onRequest" | "onConnectionClose">,
  buffer: DocketBuffer,
) {
  daemon.onRequest("write", async (params) => {
    const p = params as Partial<WriteParams> | null;
    if (!p || typeof p.html !== "string") {
      throw new Error("write: 'html' must be a string");
    }
    if (p.title !== undefined && typeof p.title !== "string") {
      throw new Error("write: 'title' must be a string when provided");
    }
    const version = buffer.write(p.html);
    return { ok: true, version };
  });
  daemon.onRequest("hide", async () => {
    const version = buffer.hide();
    return { ok: true, version };
  });
  daemon.onRequest("read", async (_params, ctx) => {
    return buffer.read(ctx.connId);
  });
  daemon.onRequest("edit", async (params, ctx) => {
    const p = params as Partial<EditParams> | null;
    if (!p || typeof p.old_string !== "string") {
      throw new Error("edit: 'old_string' must be a string");
    }
    if (typeof p.new_string !== "string") {
      throw new Error("edit: 'new_string' must be a string");
    }
    if (p.replace_all !== undefined && typeof p.replace_all !== "boolean") {
      throw new Error("edit: 'replace_all' must be a boolean when provided");
    }
    const result = buffer.edit(ctx.connId, {
      old_string: p.old_string,
      new_string: p.new_string,
      replace_all: p.replace_all,
    });
    if (!result.ok) {
      throw new Error(`${result.code}: ${result.message}`);
    }
    return { ok: true, version: result.version };
  });
  daemon.onConnectionClose((connId) => buffer.forgetClient(connId));
}

export async function runDaemonMain() {
  const paths = resolvePaths();
  try {
    const daemon = await startDaemon(paths);
    const docket = createDocket({ disabled: paths.docketDisabled });
    const buffer = createDocketBuffer({
      initialHtml: paths.hudMode === "always" ? PLACEHOLDER_HTML : "",
      onChange: (html) => {
        if (paths.docketDisabled) return;
        const p = html === "" ? docket.hide() : docket.show(html);
        p.catch((err) => console.error("docket: render failed:", err));
      },
    });
    registerDocketHandlers(daemon, buffer);
    if (paths.hudMode === "always" && !paths.docketDisabled) {
      // Render the placeholder once on startup — buffer holds it at version 0
      // so the next read_docket returns it, but onChange doesn't fire until a
      // mutation, so we render directly here.
      docket.show(PLACEHOLDER_HTML).catch((err) => {
        console.error("docket: initial placeholder failed:", err);
      });
    }
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      try { await docket.close(); } catch { /* ignore */ }
      try { await daemon.close(); } catch { /* ignore */ }
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE") {
      // Another daemon won the race. Exit quietly.
      process.exit(0);
    }
    throw err;
  }
}
