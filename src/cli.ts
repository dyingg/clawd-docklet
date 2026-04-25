import { spawn, type ChildProcess } from "node:child_process";

export type EntryMode = "adapter" | "daemon" | "install" | "usage";

export type EntryModeInput = {
  argv: readonly string[];
  env: { AGENT_GLANCE_ROLE?: string | undefined };
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
};

const SERVER_COMMAND = "npx -y agent-glance@latest";

export function resolveEntryMode(input: EntryModeInput): EntryMode {
  if (input.env.AGENT_GLANCE_ROLE === "daemon") return "daemon";
  if (input.argv[2] === "install") return "install";
  if (input.stdinIsTTY && input.stdoutIsTTY) return "usage";
  return "adapter";
}

export function buildAddMcpArgs(args: readonly string[]): string[] {
  return ["-y", "add-mcp", SERVER_COMMAND, "-g", ...args];
}

export function printUsage(out: NodeJS.WritableStream = process.stdout): void {
  out.write(`Usage:
  npx agent-glance install

Installs agent-glance into supported MCP clients via add-mcp.

MCP clients should launch agent-glance as a stdio server:
  npx -y agent-glance
`);
}

type SpawnFn = typeof spawn;

function npxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

export function runInstallCommand(
  args: readonly string[],
  spawnFn: SpawnFn = spawn,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawnFn(npxCommand(), buildAddMcpArgs(args), {
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const suffix = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      reject(new Error(`add-mcp failed with ${suffix}`));
    });
  });
}
