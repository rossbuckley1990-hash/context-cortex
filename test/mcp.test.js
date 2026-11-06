// The MCP server, driven by a real JSON-RPC client over stdio: the whole learning loop
// through context_* tools alone, as an AI with no shell would use it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAT, environment, GZIP } from "./helpers.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cortex.js");
let server, env, pending = new Map(), nextId = 1, buffer = "";

function send(method, params, notification = false) {
  const msg = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
  if (notification) {
    server.stdin.write(JSON.stringify(msg) + "\n");
    return Promise.resolve();
  }
  const id = nextId++;
  server.stdin.write(JSON.stringify({ ...msg, id }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`no reply to ${method}`)), 60_000).unref();
  });
}

async function tool(name, args = {}) {
  const r = await send("tools/call", { name, arguments: args });
  assert.ok(r.result, `tools/call ${name} returned a JSON-RPC error: ${JSON.stringify(r.error)}`);
  return r.result;
}

async function ok(name, args) {
  const r = await tool(name, args);
  assert.equal(r.isError, false, `${name} failed: ${r.content?.[0]?.text}`);
  assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
  return r.structuredContent;
}

before(() => {
  env = environment([GZIP]);
  server = spawn(process.execPath, [BIN, "mcp"], { env: { ...process.env, CORTEX_HOME: env.home }, stdio: ["pipe", "pipe", "inherit"] });
  server.stdout.setEncoding("utf8");
  server.stdout.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
});

after(() => server.stdin.end());

test("initialize, list tools, and run the whole loop through context_* tools", async () => {
  const init = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "1" } });
  assert.equal(init.result.serverInfo.name, "context-cortex");
  assert.equal(init.result.protocolVersion, "2025-06-18");
  await send("notifications/initialized", undefined, true);

  const list = await send("tools/list", {});
  const names = list.result.tools.map((t) => t.name);
  assert.deepEqual(names, [
    "context_status", "context_discover", "context_probe", "context_artefact", "context_experiment", "context_witness",
    "context_claims", "context_explain", "context_goal", "context_gap", "context_possibilities", "context_simulate",
    "context_compose", "context_crystallize", "context_skill", "context_evolve", "context_transfer", "context_ledger",
  ]);
  for (const t of list.result.tools) assert.equal(t.inputSchema.type, "object");
  assert.ok(!names.some((n) => /grant/.test(n)), "no tool can change the grant");

  const status = await ok("context_status");
  assert.notEqual(status.ledger.intact, false);
  assert.deepEqual(status.grant.programs, [GZIP]);

  const survey = await ok("context_discover", {});
  assert.equal(survey.surveyed, 1);
  const probe = await ok("context_probe", { program: GZIP });
  assert.ok(probe.formatMentions.includes("application/gzip"));

  const compressOp = { id: "gzip.compress", program: GZIP, args: ["-n", "-c", "{in:data}"], inputs: { data: "text/plain" }, outputs: { stdout: "application/gzip" } };
  const texts = ["first sample\n".repeat(9), "second, different sample\n".repeat(7), "third\n"];
  const c = await ok("context_experiment", { operation: compressOp, trials: texts.map((t) => ({ inputs: { data: { text: t } } })), controls: false });
  assert.equal(c.claims.find((x) => x.id === "gzip.compress:produces:stdout").state, "established");
  const gz = c.trials.map((t) => t.outputs.stdout.digest);

  const d = await ok("context_experiment", { operation: { id: "gzip.decompress", program: GZIP, args: ["-d", "-c", "{in:data}"], inputs: { data: "application/gzip" }, outputs: { stdout: "text/plain" } }, trials: gz.map((g) => ({ inputs: { data: g } })) });
  assert.equal(d.claims.find((x) => x.id === "gzip.decompress:rejects:truncate").state, "established");

  const w = await ok("context_witness", { action: "calibrate", witness: { id: "gzip-roundtrip", builtin: "bytes-equal", params: ["original", "compressed"], via: { compressed: "gzip.decompress" } }, references: [{ bind: { original: { text: texts[0] }, compressed: gz[0] } }, { bind: { original: { text: texts[1] }, compressed: gz[1] } }] });
  assert.equal(w.status, "calibrated");

  const h = await ok("context_experiment", { operation: compressOp, trials: texts.slice(0, 2).map((t) => ({ inputs: { data: { text: t } } })), controls: false, hypotheses: [{ id: "lossless", kind: "preservation", text: "round trip is exact", property: "bytes", check: { witness: "gzip-roundtrip", bind: { original: "input.data", compressed: "output.stdout" } } }] });
  assert.equal(h.claims.find((x) => x.id === "gzip.compress:lossless").state, "established");

  const skill = await ok("context_crystallize", { skill: {
    id: "gzip-verified", title: "gzip, verified lossless", objective: "Compress text so it decompresses to exactly the input.",
    inputs: { text: "text/plain" }, steps: [{ id: "compress", operation: "gzip.compress", bind: { data: "input.text" } }], output: "steps.compress.stdout", preserve: ["bytes"],
    successConditions: [{ witness: "gzip-roundtrip", property: "bytes", bind: { original: "input.text", compressed: "steps.compress.stdout" } }],
    selfTest: { fixtures: [{ id: "ok", inputs: { text: { text: texts[0] } }, expect: "pass" }, { id: "png", inputs: { text: { base64: "iVBORw0KGgoAAAANSUhEUg==" } }, expect: "refuse" }] },
  } });
  assert.equal(skill.status, "established", JSON.stringify(skill.gaps));

  const run = await ok("context_skill", { action: "run", id: "gzip-verified", inputs: { text: { text: "never seen before\n" } } });
  assert.equal(run.status, "completed");
  assert.equal(run.output.format, "application/gzip");

  const explained = await ok("context_skill", { action: "explain", id: "gzip-verified" });
  assert.deepEqual(explained.provenance.acquiredBy, { kind: "model", id: "test-client" });

  const map = await ok("context_goal", {});
  assert.ok(map.capabilities.some((x) => x.from === "text/plain" && x.to === "application/gzip"));
  const g = await ok("context_goal", { have: "text/plain", want: "application/gzip", preserve: ["bytes"] });
  assert.equal(g.skills[0].skill, "gzip-verified");

  const out = await ok("context_artefact", { action: "get", digest: run.output.digest });
  assert.equal(out.encoding, "base64");
  const claims = await ok("context_claims", { state: "established" });
  assert.ok(claims.claims.length >= 6);
  const why = await ok("context_explain", { claim: "gzip.compress:lossless" });
  assert.ok(why.supportingTrials.length >= 2);
  const gaps = await ok("context_gap", { have: "application/gzip", want: "text/plain", preserve: ["bytes"] });
  assert.ok(gaps.drafts.length >= 1);
  const sim = await ok("context_simulate", { have: "text/plain", want: "application/gzip", preserve: ["bytes"], inputs: [{ text: "sim\n" }], witness: "gzip-roundtrip" });
  assert.equal(sim.routes[0].ok, true);
  const composed = await ok("context_compose", { have: "text/plain", want: "application/gzip", preserve: ["bytes"], id: "composed-over-mcp" });
  assert.equal(composed.status, "established");
  const evolved = await ok("context_evolve", {});
  assert.deepEqual(evolved.newlyContradicted, []);
  const poss = await ok("context_possibilities", { since: "1" });
  assert.ok(poss.newlyPossible.length >= 2);
  const ledger = await ok("context_ledger", { action: "verify" });
  assert.equal(ledger.intact, true);

  const exported = await ok("context_transfer", { action: "export", skills: ["gzip-verified"] });
  assert.equal(exported.bundle.carriesAuthority, false);
  assert.ok(exported.bundle.experiments.length >= 2);
});

test("refusals come back as tool errors, and nothing outside the grant runs", async () => {
  const r = await tool("context_experiment", { operation: { id: "cat.copy", program: CAT, args: ["{in:x}"], inputs: { x: "text/plain" }, outputs: { stdout: "text/plain" } }, trials: [{ inputs: { x: { text: "x" } } }] });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /refused \(not-granted\)/);
  const read = await tool("context_experiment", { action: "sample", source: { path: "/etc/passwd" } });
  assert.equal(read.isError, true);
  assert.match(read.content[0].text, /outside the operator's read roots/);
  const unknown = await send("tools/call", { name: "context_grant", arguments: {} });
  assert.equal(unknown.error.code, -32602);
});
