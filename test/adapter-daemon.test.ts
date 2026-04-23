import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { registerShowHandler, startDaemon, type Daemon } from "../src/daemon.js";
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

  describe("show handler", () => {
    beforeEach(() => {
      registerShowHandler(daemon);
    });

    test("accepts a well-formed payload and acks", async () => {
      const result = await client.request("show", {
        html: "<h1>hi</h1>",
        title: "Greetings",
      });
      expect(result).toEqual({ ok: true });
    });

    test("accepts html without a title", async () => {
      const result = await client.request("show", { html: "<p>nope</p>" });
      expect(result).toEqual({ ok: true });
    });

    test("rejects a missing html field", async () => {
      await expect(client.request("show", {})).rejects.toThrow(/html.*must be a string/);
    });

    test("rejects a non-string title", async () => {
      await expect(
        client.request("show", { html: "<p>x</p>", title: 42 }),
      ).rejects.toThrow(/title.*must be a string/);
    });
  });
});
