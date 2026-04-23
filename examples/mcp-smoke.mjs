// Manual smoke test for clawd-docklet.
//
// Spawns the adapter over stdio, lists tools, then drives the shared HUD
// through the full write_docket / read_docket / edit_docket / hide_docket
// surface to prove the whole chain (MCP → adapter → daemon → glimpse) works
// end-to-end with a real window.
//
// The edit_docket segment in particular demonstrates the token-efficient
// patching model: after one write_docket, a handful of small edit_docket
// calls animate a progress bar in place without re-sending the full HTML.
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

const HELLO = `<body style="margin:0;background:transparent">
  <div style="position:fixed;top:20px;right:20px;
              padding:16px 22px;border-radius:14px;
              background:rgba(20,150,250,0.92);color:white;
              font:600 14px system-ui;
              box-shadow:0 6px 30px rgba(0,0,0,0.3)">
    👋 hello from write_docket
  </div>
</body>`;

// The progress card uses unique marker substrings (width:X%; and X% · step Y/4)
// so later edit_docket calls can patch them without ambiguity.
const PROGRESS = `<body style="margin:0;background:transparent">
  <div style="position:fixed;top:20px;right:20px;width:280px;
              padding:14px 18px;border-radius:14px;
              background:rgba(20,20,30,0.9);color:#fff;
              font:500 13px system-ui;
              box-shadow:0 8px 32px rgba(0,0,0,0.35);
              border:1px solid rgba(255,255,255,0.1)">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <span style="width:8px;height:8px;border-radius:50%;background:#fbbf24;
                   animation:pulse 1.2s ease-in-out infinite"></span>
      <strong data-tag="label">Starting…</strong>
    </div>
    <div style="height:6px;border-radius:999px;background:rgba(255,255,255,0.1);overflow:hidden">
      <div style="width:0%;height:100%;background:linear-gradient(90deg,#4ade80,#22d3ee);
                  border-radius:999px;transition:width .4s ease"></div>
    </div>
    <div style="margin-top:6px;opacity:0.6;font-size:11px" data-tag="status">0% · step 0/4</div>
    <style>@keyframes pulse{0%,100%{opacity:.5}50%{opacity:1}}</style>
  </div>
</body>`;

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
    const label = res.isError ? `× ${name}` : `← ${name}`;
    const text = (res.content?.[0]?.text ?? "").slice(0, 80);
    console.log(`${label}:`, text || "(empty)");
    return res;
  };

  console.log("\n── 1. write_docket(hello) ──  (blue pill, 2s)");
  await call("write_docket", { html: HELLO, title: "hello" });
  await sleep(2000);

  console.log("\n── 2. write_docket(progress @ 0%) ──  (progress card appears)");
  await call("write_docket", { html: PROGRESS, title: "building" });
  await sleep(1200);

  console.log("\n── 3. read_docket ──  (arms this client for edit_docket)");
  const read = await call("read_docket");
  console.log(`   HUD is ${read.content?.[0]?.text?.length ?? 0} chars of HTML`);

  console.log("\n── 4. edit_docket: bump progress 0% → 33%, label → Building ──");
  await call("edit_docket", { old_string: "width:0%;", new_string: "width:33%;" });
  await call("edit_docket", { old_string: "0% · step 0/4", new_string: "33% · step 1/4" });
  await call("edit_docket", { old_string: "Starting…", new_string: "Building…" });
  await sleep(1000);

  console.log("\n── 5. edit_docket: 33% → 66% (step 2/4) ──");
  await call("edit_docket", { old_string: "width:33%;", new_string: "width:66%;" });
  await call("edit_docket", { old_string: "33% · step 1/4", new_string: "66% · step 2/4" });
  await sleep(1000);

  console.log("\n── 6. edit_docket: 66% → 100%, label → Done ──");
  await call("edit_docket", { old_string: "width:66%;", new_string: "width:100%;" });
  await call("edit_docket", { old_string: "66% · step 2/4", new_string: "100% · step 4/4" });
  await call("edit_docket", { old_string: "Building…", new_string: "✅ Done" });
  await call("edit_docket", { old_string: "#fbbf24", new_string: "#34c759" }); // dot: amber → green
  await sleep(2000);

  console.log("\n── 7. edit_docket WITHOUT prior read fails ──");
  //  Demonstrate the read-before-edit gate. write_docket invalidates the
  //  previous lastRead version; we skip read_docket on purpose here.
  await call("write_docket", { html: PROGRESS, title: "reset" });
  const staleRes = await call("edit_docket", {
    old_string: "width:0%;",
    new_string: "width:50%;",
  });
  if (!staleRes.isError) {
    console.error("!! expected isError=true from edit without prior read");
    process.exitCode = 1;
  }

  console.log("\n── 8. hide_docket ──  (window closes, 1s)");
  await call("hide_docket");
  await sleep(1000);

  console.log("\n── 9. write_docket(hello) ──  (reopens fast, cached probe)");
  await call("write_docket", { html: HELLO, title: "back" });
  await sleep(2000);

  console.log("\n── closing ──");
  await client.close();
  console.log("✓ done");
}

main().catch((e) => { console.error(e); process.exit(1); });
