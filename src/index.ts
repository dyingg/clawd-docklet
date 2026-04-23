#!/usr/bin/env node
import { runAdapterMain } from "./adapter.js";
import { runDaemonMain } from "./daemon.js";

const role = process.env.CLAWD_DOCKLET_ROLE;

if (role === "daemon") {
  runDaemonMain().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  runAdapterMain().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
