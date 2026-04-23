import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { cleanupEnv, freshEnv, type FreshEnv } from "./helpers/env.js";
import { readDaemonPid, sleep, waitForProcessExit } from "./helpers/spawn.js";

const ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));

describe("end-to-end MCP over stdio", () => {
  let env: FreshEnv;

  beforeEach(() => {
    env = freshEnv({
      CLAWD_DOCKLET_IDLE_MS: "300",
      CLAWD_DOCKLET_DOCKET_DISABLED: "1",
    });
  });

  afterEach(async () => {
    // Wait for daemon to clear after adapter exits; best-effort cleanup.
    try {
      const pid = readDaemonPid(env);
      await waitForProcessExit(pid, 2000).catch(() => {});
    } catch {
      // no daemon spun up
    }
    cleanupEnv(env);
  });

  test("initialize handshake advertises write/read/edit/hide_docket tools", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: env as NodeJS.ProcessEnv as Record<string, string>,
    });
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });

    await client.connect(transport);
    const info = client.getServerVersion();
    expect(info?.name).toBe("clawd-docklet");
    expect(info?.version).toBe("0.0.1");

    const caps = client.getServerCapabilities();
    expect(caps?.tools).toBeDefined();

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["write_docket", "hide_docket", "read_docket", "edit_docket"]),
    );
    expect(names).not.toContain("docket_show");
    expect(names).not.toContain("set_docket");

    await client.close();
  });

  test("calling write_docket forwards to the daemon and returns ok", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: env as NodeJS.ProcessEnv as Record<string, string>,
    });
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);

    const result = await client.callTool({
      name: "write_docket",
      arguments: { html: "<h1>hello</h1>", title: "greet" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.type).toBe("text");
    expect(content[0]?.text).toBe("ok");

    await client.close();
  });

  test("write → read → edit → read round-trip over MCP", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: env as NodeJS.ProcessEnv as Record<string, string>,
    });
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);

    await client.callTool({
      name: "write_docket",
      arguments: { html: "<div id=a>hi</div>" },
    });

    const readRes = await client.callTool({ name: "read_docket", arguments: {} });
    const readContent = readRes.content as Array<{ type: string; text?: string }>;
    expect(readContent[0]?.text).toBe("<div id=a>hi</div>");

    const editRes = await client.callTool({
      name: "edit_docket",
      arguments: { old_string: "hi", new_string: "bye" },
    });
    expect(editRes.isError).toBeFalsy();
    const editContent = editRes.content as Array<{ type: string; text?: string }>;
    expect(editContent[0]?.text).toMatch(/ok \(version=\d+\)/);

    const readAfter = await client.callTool({ name: "read_docket", arguments: {} });
    const readAfterContent = readAfter.content as Array<{ type: string; text?: string }>;
    expect(readAfterContent[0]?.text).toBe("<div id=a>bye</div>");

    await client.close();
  });

  test("edit_docket without a prior read_docket surfaces MustReadFirst as isError", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: env as NodeJS.ProcessEnv as Record<string, string>,
    });
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);

    await client.callTool({
      name: "write_docket",
      arguments: { html: "<p>hi</p>" },
    });

    const res = await client.callTool({
      name: "edit_docket",
      arguments: { old_string: "hi", new_string: "bye" },
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toMatch(/MustReadFirst/);

    await client.close();
  });

  test("calling hide_docket forwards to the daemon and returns ok", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: env as NodeJS.ProcessEnv as Record<string, string>,
    });
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);

    const result = await client.callTool({
      name: "hide_docket",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toBe("ok");

    await client.close();
  });

  test("two adapters share one daemon", async () => {
    const open = async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [ENTRY],
        env: env as NodeJS.ProcessEnv as Record<string, string>,
      });
      const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
      await client.connect(transport);
      return client;
    };

    const a = await open();
    // Give the first adapter time to write the pidfile.
    await sleep(100);
    const pid1 = readDaemonPid(env);

    const b = await open();
    await sleep(100);
    const pid2 = readDaemonPid(env);

    expect(pid1).toBe(pid2);

    await a.close();
    await b.close();
  });
});
