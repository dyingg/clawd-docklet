import { describe, expect, test } from "vitest";
import { buildAddMcpArgs, resolveEntryMode } from "../src/cli.js";

describe("CLI entrypoint", () => {
  test("install delegates to add-mcp globally for agent-glance", () => {
    expect(buildAddMcpArgs([])).toEqual([
      "-y",
      "add-mcp",
      "npx -y agent-glance@latest",
      "-g",
    ]);
  });

  test("install forwards add-mcp flags", () => {
    expect(buildAddMcpArgs(["-y", "--all"])).toEqual([
      "-y",
      "add-mcp",
      "npx -y agent-glance@latest",
      "-g",
      "-y",
      "--all",
    ]);
  });

  test("install subcommand routes to installer even without a TTY", () => {
    expect(
      resolveEntryMode({
        argv: ["node", "agent-glance", "install"],
        env: {},
        stdinIsTTY: false,
        stdoutIsTTY: false,
      }),
    ).toBe("install");
  });

  test("bare terminal launch remains the MCP adapter path", () => {
    expect(
      resolveEntryMode({
        argv: ["node", "agent-glance"],
        env: {},
        stdinIsTTY: true,
        stdoutIsTTY: true,
      }),
    ).toBe("adapter");
  });

  test("bare non-TTY launch remains the MCP adapter path", () => {
    expect(
      resolveEntryMode({
        argv: ["node", "agent-glance"],
        env: {},
        stdinIsTTY: false,
        stdoutIsTTY: false,
      }),
    ).toBe("adapter");
  });

  test("piped stdout remains the MCP adapter path even when stdin is a TTY", () => {
    expect(
      resolveEntryMode({
        argv: ["node", "agent-glance"],
        env: {},
        stdinIsTTY: true,
        stdoutIsTTY: false,
      }),
    ).toBe("adapter");
  });

  test("piped stdin remains the MCP adapter path even when stdout is a TTY", () => {
    expect(
      resolveEntryMode({
        argv: ["node", "agent-glance"],
        env: {},
        stdinIsTTY: false,
        stdoutIsTTY: true,
      }),
    ).toBe("adapter");
  });

  test("daemon role still wins over CLI routing", () => {
    expect(
      resolveEntryMode({
        argv: ["node", "agent-glance", "install"],
        env: { AGENT_GLANCE_ROLE: "daemon" },
        stdinIsTTY: true,
        stdoutIsTTY: true,
      }),
    ).toBe("daemon");
  });
});
