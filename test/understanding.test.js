// Understanding the environment and itself, and acting on requests.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { runRequest } from "../src/agent.js";
import { apply } from "../src/apply.js";
import { environment, manual } from "../src/environment.js";
import { ACTOR, environment as makeEnv, learnGzip, open } from "./helpers.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-agent.js");
let env, cx;
before(async () => {
  env = makeEnv();
  writeFileSync(join(env.samples, "picture.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]));
  symlinkSync("/etc/hosts", join(env.samples, "outside-link"));
  cx = await open(env);
  await learnGzip(cx, env);
});

test("the environment model covers host, sandbox, authority, programs, data, knowledge and what can be done", async () => {
  const e = await environment(cx, { survey: true });
  assert.ok(e.host.platform && e.host.cpus >= 1);
  assert.ok(e.sandbox.kind === null || e.sandbox.enforces.some((x) => /^no network/.test(x)));
  assert.equal(e.cortex.tools, 33);
  const gz = e.programs.list.find((p) => p.operations.some((o) => o.id === "gzip.compress"));
  assert.ok(gz.mentions.includes("application/gzip"));
  assert.ok(gz.claims.established >= 4);
  const text = e.data.formats.find((f) => f.format === "text/plain");
  assert.equal(text.files, 3);
  assert.ok(e.data.formats.some((f) => f.format === "image/png"));
  assert.ok(!JSON.stringify(e.data).includes("/etc/hosts"), "a link out of the read roots is not followed");
  const can = e.canDo.find((c) => c.format === "text/plain");
  assert.ok(can.skills.some((k) => k.skill === "gzip-verified"));
  assert.ok(can.routes.some((r) => r.to === "application/gzip" && r.preserves.includes("bytes")));
  assert.ok(e.recommendations.some((r) => /image\/png/.test(r)), "data nothing can act on is reported");
});

test("the manual states the rules the code enforces", async () => {
  const m = await manual(cx);
  assert.equal(m.tools.length, 33);
  assert.ok(m.rules.claimStates.established.some((r) => /two distinct inputs/.test(r)));
  assert.ok(m.formats.detectedBySignature.includes("application/gzip"));
  assert.ok(m.safety.sandbox.some((x) => /^no network/.test(x)));
  const usage = await manual(cx, "usage");
  assert.match(usage.usage, /Using Context Cortex/);
  await assert.rejects(manual(cx, "nonsense"), /unknown topic/);
});

test("apply acts on every matching file, checks each output and never overwrites", async () => {
  const outDir = join(env.out, "batch");
  mkdirSync(outDir);
  const r = await apply(cx, { have: "text/plain", want: "application/gzip", preserve: ["bytes"], from: env.samples, deliverTo: outDir }, ACTOR);
  assert.equal(r.skill, "gzip-verified");
  assert.equal(r.items, 3, "only text files are taken; the PNG and the outside link are not");
  assert.equal(r.completed, 3);
  for (const name of ["a.txt", "b.txt", "c.txt"]) {
    assert.equal(gunzipSync(readFileSync(join(outDir, `${name}.gz`))).toString(), readFileSync(join(env.samples, name), "utf8"));
  }
  const again = await apply(cx, { skill: "gzip-verified", from: env.samples, deliverTo: outDir }, ACTOR);
  assert.equal(again.skipped, 3);
  await assert.rejects(apply(cx, { skill: "gzip-verified", from: env.samples, deliverTo: env.root }, ACTOR), /outside the operator's write roots/);
  const none = await apply(cx, { have: "image/png", want: "image/webp", from: env.samples }, ACTOR);
  assert.equal(none.status, "no-skill");
});

test("a request in plain language is carried out by an agent restricted to Cortex's tools", async () => {
  const outDir = join(env.out, "requested");
  mkdirSync(outDir);
  const { grant } = await import("./helpers.js");
  const { GZIP } = await import("./helpers.js");
  grant(env, [GZIP], { writeRoots: [outDir] });
  cx.reloadGrant();
  const dry = await runRequest(cx, "compress every text file losslessly", { dryRun: true });
  assert.match(dry.prompt, /The operator's request:\ncompress every text file losslessly/);
  assert.ok(dry.bytes < 70_000);
  const r = await runRequest(cx, "compress every text file losslessly", { agent: FAKE });
  assert.equal(r.isError, false, r.report);
  assert.match(r.report, /tools: 33; request: seen; applied 3 of 3/);
  assert.equal(r.effects.delivered.length, 3);
  assert.ok(r.effects.delivered.every((d) => existsSync(d.path)));
  assert.equal(r.effects.ledgerIntact, true);
  assert.ok(existsSync(r.record));
  assert.ok(cx.ledger.read().some((e) => e.kind === "request"));
});

test("a missing agent is a clear refusal", async () => {
  await assert.rejects(runRequest(cx, "anything", { agent: "/nonexistent/agent" }), /agent command not found/);
});
