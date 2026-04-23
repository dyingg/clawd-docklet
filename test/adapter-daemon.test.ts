import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startDaemon, type Daemon } from "../src/daemon.js";
import { DaemonClient, connectDaemon } from "../src/adapter.js";
import { cleanupEnv, freshEnv, type FreshEnv } from "./helpers/env.js";

describe("adapter ↔ daemon", () => {
  let env: FreshEnv;
  let daemon: Daemon;
  let client: DaemonClient;

  beforeEach(async () => {
    env = freshEnv();
    daemon = await startDaemon({
      socketPath: env.CLAWD_DOCKLET_SOCKET,
      pidfilePath: env.CLAWD_DOCKLET_PIDFILE,
      idleMs: 60000,
      hudMode: "always",
      docketDisabled: true,
    });
    const sock = await connectDaemon({
      socketPath: env.CLAWD_DOCKLET_SOCKET,
      pidfilePath: env.CLAWD_DOCKLET_PIDFILE,
      idleMs: 60000,
      hudMode: "always",
      docketDisabled: true,
    });
    client = new DaemonClient(sock);
  });

  afterEach(async () => {
    client.close();
    await daemon.close();
    cleanupEnv(env);
  });

  test("request routes to registered handler and returns result", async () => {
    daemon.onRequest("echo", async (params) => params);
    const result = await client.request("echo", { hello: "world" });
    expect(result).toEqual({ hello: "world" });
  });

  test("unknown method returns an error", async () => {
    await expect(client.request("nope", {})).rejects.toThrow(/unknown method/);
  });

  test("handler receives a stable connId per connection", async () => {
    const seen: string[] = [];
    daemon.onRequest("who", async (_p, ctx) => {
      seen.push(ctx.connId);
      return ctx.connId;
    });
    const a = await client.request("who", null);
    const b = await client.request("who", null);
    expect(a).toBe(b);
    expect(seen).toHaveLength(2);
  });

  describe("docket handlers", () => {
    let buffer: ReturnType<typeof import("../src/docket-buffer.js")["createDocketBuffer"]>;

    beforeEach(async () => {
      const { createDocketBuffer } = await import("../src/docket-buffer.js");
      buffer = createDocketBuffer();
      const { registerDocketHandlers } = await import("../src/daemon.js");
      registerDocketHandlers(daemon, buffer);
    });

    describe("write", () => {
      test("accepts a well-formed payload and acks with version", async () => {
        const result = await client.request("write", {
          html: "<h1>hi</h1>",
          title: "Greetings",
        });
        expect(result).toEqual({ ok: true, version: 1 });
      });

      test("accepts html without a title", async () => {
        const result = await client.request("write", { html: "<p>nope</p>" });
        expect(result).toEqual({ ok: true, version: 1 });
      });

      test("rejects a missing html field", async () => {
        await expect(client.request("write", {})).rejects.toThrow(/html.*must be a string/);
      });

      test("rejects a non-string title", async () => {
        await expect(
          client.request("write", { html: "<p>x</p>", title: 42 }),
        ).rejects.toThrow(/title.*must be a string/);
      });
    });

    describe("hide", () => {
      test("acks with ok regardless of prior state", async () => {
        const result = await client.request("hide", {});
        expect(result).toEqual({ ok: true, version: 1 });
      });

      test("acks after write", async () => {
        await client.request("write", { html: "<p>x</p>" });
        const result = await client.request("hide", {});
        expect(result).toEqual({ ok: true, version: 2 });
      });
    });

    describe("read + edit", () => {
      test("read → edit round-trip applies the replacement", async () => {
        await client.request("write", { html: "<p>hello</p>" });
        const readRes = (await client.request("read", {})) as { html: string; version: number };
        expect(readRes).toEqual({ html: "<p>hello</p>", version: 1 });
        const editRes = await client.request("edit", {
          old_string: "hello",
          new_string: "world",
        });
        expect(editRes).toEqual({ ok: true, version: 2 });
        const readAfter = await client.request("read", {});
        expect(readAfter).toMatchObject({ html: "<p>world</p>", version: 2 });
      });

      test("edit without prior read fails with MustReadFirst", async () => {
        await client.request("write", { html: "<p>hi</p>" });
        await expect(
          client.request("edit", { old_string: "hi", new_string: "bye" }),
        ).rejects.toThrow(/MustReadFirst/);
      });

      test("stale read across a second connection surfaces StaleRead", async () => {
        await client.request("write", { html: "<p>v1</p>" });
        await client.request("read", {});                       // clientA armed at v1

        const secondSock = await connectDaemon({
          socketPath: env.CLAWD_DOCKLET_SOCKET,
          pidfilePath: env.CLAWD_DOCKLET_PIDFILE,
          idleMs: 60000,
          hudMode: "always",
          docketDisabled: true,
        });
        const clientB = new DaemonClient(secondSock);
        try {
          await clientB.request("write", { html: "<p>v2</p>" });  // bumps version behind A's back
        } finally {
          clientB.close();
        }

        await expect(
          client.request("edit", { old_string: "v2", new_string: "v3" }),
        ).rejects.toThrow(/StaleRead/);
      });

      test("connection close forgets the client's read state", async () => {
        // Fresh connection, read, close, reconnect → must read again.
        const sock2 = await connectDaemon({
          socketPath: env.CLAWD_DOCKLET_SOCKET,
          pidfilePath: env.CLAWD_DOCKLET_PIDFILE,
          idleMs: 60000,
          hudMode: "always",
          docketDisabled: true,
        });
        const c2 = new DaemonClient(sock2);
        await c2.request("write", { html: "<p>hi</p>" });
        await c2.request("read", {});
        c2.close();
        // Wait for the daemon to observe the close and clear state.
        await new Promise((r) => setTimeout(r, 50));

        const sock3 = await connectDaemon({
          socketPath: env.CLAWD_DOCKLET_SOCKET,
          pidfilePath: env.CLAWD_DOCKLET_PIDFILE,
          idleMs: 60000,
          hudMode: "always",
          docketDisabled: true,
        });
        const c3 = new DaemonClient(sock3);
        try {
          // c3 is a fresh connId → has not read yet.
          await expect(
            c3.request("edit", { old_string: "hi", new_string: "bye" }),
          ).rejects.toThrow(/MustReadFirst/);
        } finally {
          c3.close();
        }
      });

      test("edit validates input types", async () => {
        await expect(
          client.request("edit", { new_string: "x" }),
        ).rejects.toThrow(/old_string.*must be a string/);
        await expect(
          client.request("edit", { old_string: "x" }),
        ).rejects.toThrow(/new_string.*must be a string/);
        await expect(
          client.request("edit", { old_string: "x", new_string: "y", replace_all: "yes" }),
        ).rejects.toThrow(/replace_all.*must be a boolean/);
      });
    });
  });
});
