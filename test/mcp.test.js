// The MCP server, driven by a real JSON-RPC client over stdio: the whole learning loop
// through context_* tools alone, as an AI with no shell would use it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAT, environment, grant, GZIP } from "./helpers.js";

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
  const rws = join(env.root, "recon-ws");
  mkdirSync(rws);
  writeFileSync(join(rws, "inj.js"), 'const { exec } = require("child_process");\nconst file = process.argv[2];\nexec(`wc -c ${file}`, (err, out) => console.log(out || err));\n');
  grant(env, [GZIP], { workspaces: [{ path: rws, network: false }] });
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
    "context_status", "context_environment", "context_manual", "context_apply", "context_workspace", "context_edit", "context_run", "context_audit", "context_recon", "context_repair", "context_plan", "context_reach", "context_escape", "context_gates", "context_secrets", "context_persist", "context_discover", "context_probe", "context_artefact", "context_experiment", "context_witness",
    "context_claims", "context_explain", "context_goal", "context_gap", "context_possibilities", "context_simulate",
    "context_compose", "context_crystallize", "context_skill", "context_evolve", "context_transfer", "context_ledger",
  ]);
  for (const t of list.result.tools) assert.equal(t.inputSchema.type, "object");
  assert.ok(!names.some((n) => /grant/.test(n)), "no tool can change the grant");

  const status = await ok("context_status");
  assert.notEqual(status.ledger.intact, false);
  assert.deepEqual(status.grant.programs, [GZIP]);

  const envModel = await ok("context_environment", {});
  assert.equal(envModel.cortex.tools, 33);
  const rules = await ok("context_manual", { topic: "rules" });
  assert.ok(rules.rules.claimStates.established.length >= 3);
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

  const a = await ok("context_audit", { operation: "gzip.decompress", inputs: { data: gz } });
  assert.deepEqual(a.findings, [], "gzip refuses every damaged input: the honest null");
  assert.equal(a.refusals, 12);
  assert.ok(a.claims.every((c) => c.state === "established" || c.state === "observed"));
  assert.match(a.coverage.note, /not that the operation is safe/);

  const rc = await ok("context_recon", { workspace: join(env.root, "recon-ws") });
  assert.equal(rc.summary.exploited, 1, JSON.stringify(rc.summary));
  const inj = rc.findings.find((f) => f.class === "command-injection");
  assert.equal(inj.drive.status, "exploited");

  const rp = await ok("context_repair", { workspace: join(env.root, "recon-ws") });
  assert.equal(rp.summary.closed, 1, JSON.stringify(rp.summary));
  assert.equal(rp.summary.reverted, 0);
  const fixed = await ok("context_workspace", { action: "read", workspace: join(env.root, "recon-ws"), path: "inj.js" });
  assert.match(fixed.content, /untrusted argument/, "the guard is really in the file");

  const pl = await ok("context_plan", { requirement: "find and fix the command injection in inj.js", workspace: join(env.root, "recon-ws") });
  assert.ok(pl.steps.some((s) => s.tool === "context_repair"), JSON.stringify(pl.steps.map((s) => s.tool)));
  assert.deepEqual(pl.intents, ["hunt", "fix"]);
  assert.match(rc.coverage.note, /never that the code is secure/);

  // the boundary tools, over the same session the model gets
  const rch = await ok("context_reach", { workspace: join(env.root, "recon-ws") });
  assert.ok(rch.graph.runs.read.some((x) => x.includes("engine only")), "the graph separates what the engine reads from what runs can see");
  assert.equal(rch.workspaces[0].network, false);
  assert.ok(Array.isArray(rch.workspaces[0].triggers));
  const esc = await ok("context_escape", { workspace: join(env.root, "recon-ws"), probes: ["write-outside", "env"] });
  assert.equal(esc.summary.escaped, 0, JSON.stringify(esc.probes));
  assert.ok(esc.probes.every((p) => ["refused", "isolated", "verified", "finding"].includes(p.status)), JSON.stringify(esc.probes));
  assert.deepEqual(esc.leftovers ?? [], []);
  const gts = await ok("context_gates", { workspace: join(env.root, "recon-ws") });
  const byGate = Object.fromEntries(gts.gates.map((g) => [g.gate, g]));
  assert.equal(byGate.sudo.state, "refused-by-design");
  assert.ok(gts.fence.policy.length >= 5);
  assert.ok(Array.isArray(gts.suid.examples));
  // the host itself is a target: no workspace stages the probe through the experiment fence
  const host = await ok("context_gates", {});
  assert.match(host.target, /the host itself/);
  const sec = await ok("context_secrets", {});
  assert.ok(Array.isArray(sec.items));
  assert.ok(Array.isArray(sec.readDrives), "each workspace's credential read-reachability is driven, not assumed");
  assert.equal("reveals" in sec, false, "a model session never receives secret contents");
  const per = await ok("context_persist", { workspace: join(env.root, "recon-ws") });
  assert.equal(per.summary.planted, 0, "no host persistence surface may be plantable");
  assert.ok(per.hostSurfaces.every((s) => ["cannot-plant", "isolated", "absent", "unproven", "not-measured"].includes(s.status)), JSON.stringify(per.hostSurfaces));
  assert.ok(per.summary.surfaces >= 7, "the standard battery per platform");

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
  const applied = await ok("context_apply", { skill: "gzip-verified", inputs: [{ text: "one\n" }, { text: "two\n" }] });
  assert.equal(applied.completed, 2);
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
  const ws = await ok("context_workspace", {});
  assert.equal(ws.workspaces.length, 1, "the recon workspace is granted; everything else is not");
  assert.equal(ws.workspaces[0].network, false);
  const editOutside = await tool("context_edit", { workspace: env.samples, path: "a.txt", content: "x" });
  assert.equal(editOutside.isError, true);
  assert.match(editOutside.content[0].text, /not inside a code workspace/);
  const runOutside = await tool("context_run", { workspace: env.samples, program: GZIP, args: ["--version"] });
  assert.equal(runOutside.isError, true);
  // the operator-only boundary: a model naming any digest is refused, whatever it asks to reveal
  const reveal = await tool("context_secrets", { reveal: ["sha256:0000000000000000000000000000000000000000000000000000000000000000"] });
  assert.equal(reveal.isError, true);
  assert.match(reveal.content[0].text, /operator's own hand/);
  const escNoWs = await tool("context_escape", {});
  assert.equal(escNoWs.isError, true);
  assert.match(escNoWs.content[0].text, /workspace/);
  const unknown = await send("tools/call", { name: "context_grant", arguments: {} });
  assert.equal(unknown.error.code, -32602);
});
