#!/usr/bin/env node
import { runAdapterMain } from "./adapter.js";
import { resolveEntryMode, runInstallCommand } from "./cli.js";
import { runDaemonMain } from "./daemon.js";

const mode = resolveEntryMode({
  argv: process.argv,
  env: process.env,
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
});

if (mode === "daemon") {
  runDaemonMain().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (mode === "install") {
  runInstallCommand(process.argv.slice(3)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  runAdapterMain().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
