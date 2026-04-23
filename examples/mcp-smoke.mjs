// Manual smoke test for clawd-docklet.
//
// Spawns the adapter over stdio, lists tools, then drives the shared
// HUD through set_docket / hide_docket calls to prove the full chain
// (MCP → adapter → daemon → glimpse) works end-to-end with a real window.
//
// Run:   npm run smoke
// Or:    node examples/mcp-smoke.mjs
//
// Run `npm run build` first; the script expects dist/index.js to exist.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(__dirname, "..", "dist", "index.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SAMPLES = {
  hello: `<body style="margin:0;background:transparent">
    <div style="position:fixed;top:20px;right:20px;
                padding:16px 22px;border-radius:14px;
                background:rgba(20,150,250,0.92);color:white;
                font:600 14px system-ui;
                box-shadow:0 6px 30px rgba(0,0,0,0.3)">
      👋 hello from set_docket
    </div>
  </body>`,

  progress: `<body style="margin:0;background:transparent">
    <div style="position:fixed;top:20px;right:20px;width:260px;
                padding:14px 18px;border-radius:14px;
                background:rgba(20,20,30,0.9);color:#fff;
                font:500 13px system-ui;
                box-shadow:0 8px 32px rgba(0,0,0,0.35);
                border:1px solid rgba(255,255,255,0.1)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="width:8px;height:8px;border-radius:50%;background:#fbbf24;
                     animation:pulse 1.2s ease-in-out infinite"></span>
        <strong>Building…</strong>
      </div>
      <div style="height:6px;border-radius:999px;background:rgba(255,255,255,0.1);overflow:hidden">
        <div style="width:63%;height:100%;background:linear-gradient(90deg,#4ade80,#22d3ee);
                    border-radius:999px"></div>
      </div>
      <div style="margin-top:6px;opacity:0.6;font-size:11px">63% · 4/6 tests passing</div>
      <style>@keyframes pulse{0%,100%{opacity:.5}50%{opacity:1}}</style>
    </div>
  </body>`,

  done: `<body style="margin:0;background:transparent">
    <div style="position:fixed;top:20px;right:20px;
                padding:14px 20px;border-radius:14px;
                background:rgba(34,197,94,0.95);color:white;
                font:600 14px system-ui;
                box-shadow:0 6px 30px rgba(0,0,0,0.3)">
      ✅ all green · 27/27
    </div>
  </body>`,
};

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: process.env,
  });
  const client = new Client({ name: "docklet-smoke", version: "0.0.1" }, { capabilities: {} });

  console.log("→ connecting adapter…");
  await client.connect(transport);
  console.log("✓ connected:", client.getServerVersion());

  const { tools } = await client.listTools();
  console.log("✓ tools:", tools.map((t) => t.name).join(", "));

  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    console.log(`← ${name}:`, JSON.stringify(res.content));
  };

  console.log("\n── 1. set_docket(hello) ──  (blue pill, 2s)");
  await call("set_docket", { html: SAMPLES.hello, title: "hello" });
  await sleep(2000);

  console.log("\n── 2. set_docket(progress) ──  (updates same window, 3s)");
  await call("set_docket", { html: SAMPLES.progress, title: "building" });
  await sleep(3000);

  console.log("\n── 3. set_docket(done) ──  (another in-place swap, 2s)");
  await call("set_docket", { html: SAMPLES.done, title: "done" });
  await sleep(2000);

  console.log("\n── 4. hide_docket() ──  (window closes, 1s)");
  await call("hide_docket");
  await sleep(1000);

  console.log("\n── 5. set_docket(hello) ──  (reopens fast, cached probe)");
  await call("set_docket", { html: SAMPLES.hello, title: "back" });
  await sleep(2000);

  console.log("\n── closing ──");
  await client.close();
  console.log("✓ done");
}

main().catch((e) => { console.error(e); process.exit(1); });
