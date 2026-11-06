#!/usr/bin/env node
// A stand-in for `claude -p` in tests. It checks it was given only Context Cortex tools, starts
// the MCP server from the config it was handed, acts on the request through context_apply, and
// prints a result in Claude Code's --output-format json shape.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
const fail = (m) => { console.log(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: m })); process.exit(1); };
if (args[0] !== "-p") fail("expected -p first");
const prompt = args[1];
if (!args.includes("--strict-mcp-config")) fail("not strict");
const allowed = at("--allowedTools").split(",");
if (!allowed.every((t) => t.startsWith("mcp__context-cortex__context_"))) fail(`non-Cortex tool allowed: ${allowed}`);
const env = JSON.parse(prompt.split("\n").find((l) => l.startsWith('{"host"')));
const config = JSON.parse(readFileSync(at("--mcp-config"), "utf8")).mcpServers["context-cortex"];
const server = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ["pipe", "pipe", "inherit"] });
let buf = "", id = 0;
const waiting = new Map();
server.stdout.setEncoding("utf8");
server.stdout.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    waiting.get(m.id)?.(m);
  }
});
const rpc = (method, params) => new Promise((r) => { const n = ++id; waiting.set(n, r); server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agent", version: "1" } });
const r = await rpc("tools/call", { name: "context_apply", arguments: { have: "text/plain", want: "application/gzip", preserve: ["bytes"], from: env.authority.readRoots[0], deliverTo: env.authority.writeRoots[0] } });
server.stdin.end();
const out = r.result.structuredContent;
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0, duration_ms: 5, result: `tools: ${allowed.length}; request: ${prompt.includes("compress every text file") ? "seen" : "missing"}; applied ${out.completed} of ${out.items}` }));
