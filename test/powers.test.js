// The tools beyond the core loop: discovery, artefacts, explanation, gaps with executable drafts,
// simulation, automatic composition, evolution after a program changes, and the ledger.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { compose, simulate } from "../src/compose.js";
import { evolve } from "../src/evolve.js";
import { gap, possibilities } from "../src/goal.js";
import { runSkill } from "../src/skills.js";
import { ACTOR, compressOp, decompressOp, environment, grant, GZIP, learnGzip, open } from "./helpers.js";

let env, cx;
before(async () => {
  env = environment();
  cx = await open(env);
  await learnGzip(cx, env);
});

test("discover surveys every granted program without a task", async () => {
  const d = await cx.discover({ limit: 5 });
  assert.equal(d.granted, 1);
  assert.equal(d.surveyed, 1);
  assert.ok(d.inventory[0].formats.includes("application/gzip"));
  assert.equal(d.inventory[0].investigated, true);
  const again = await cx.discover({ limit: 5 });
  assert.equal(again.probedNow, 0, "an unchanged program is not probed twice");
});

test("artefacts can be read back, listed and damaged on purpose", () => {
  const text = cx.artefactList({ format: "text/plain", limit: 5 });
  assert.ok(text.length >= 3);
  const got = cx.artefact(text[0].digest);
  assert.equal(got.encoding, "utf8");
  const gz = cx.artefactList({ format: "application/gzip", limit: 1 })[0];
  assert.equal(cx.artefact(gz.digest).encoding, "base64");
  const damaged = cx.resolveSource({ mutate: { of: gz.digest, kind: "truncate" } });
  assert.ok(damaged.size < gz.size);
});

test("explain shows the trials behind a claim", () => {
  const e = cx.explain({ claim: "gzip.compress:lossless" });
  assert.equal(e.state, "established");
  assert.ok(e.supportingTrials.length >= 2);
  assert.ok(e.supportingTrials.every((t) => t.kind === "witness" && t.accept === true));
  const op = cx.explain({ operation: "gzip.decompress" });
  assert.ok(op.determinism.some((d) => d.identical));
  assert.ok(op.claims.some((c) => c.id === "gzip.decompress:rejects:truncate" && c.state === "established"));
});

test("gap drafts are executable: submitting them closes the gap, and compose builds the skill", async () => {
  const before = gap(cx, { have: "application/gzip", want: "text/plain", preserve: ["bytes"] });
  const d = before.drafts.find((x) => /preserves bytes/.test(x.closes));
  assert.ok(d?.first, "a witness to calibrate is drafted from demonstrated trials");
  assert.equal(d.first.arguments.witness.via.candidate, "gzip.compress");
  const w = await cx.calibrate(d.first.arguments, ACTOR);
  assert.equal(w.status, "calibrated");
  const e = await cx.experiment(d.then.arguments, ACTOR);
  assert.equal(e.claims.find((c) => c.id === "gzip.decompress:preserves-bytes").state, "established");
  const after = gap(cx, { have: "application/gzip", want: "text/plain", preserve: ["bytes"] });
  assert.equal(after.drafts.length, 0);
  assert.equal(after.routes[0].ready, true);
  const c = await compose(cx, { have: "application/gzip", want: "text/plain", preserve: ["bytes"] }, ACTOR);
  assert.equal(c.status, "established", JSON.stringify(c.crystallised.gaps));
  assert.ok(c.crystallised.selfTest.some((t) => t.expect === "refuse" && t.ok));
});

test("compose turns the compress route into a skill and runs it in the same call", async () => {
  const c = await compose(cx, { have: "text/plain", want: "application/gzip", preserve: ["bytes"], id: "auto-gzip", run: { input: { text: "composed automatically\n" }, deliver: join(env.out, "auto.gz") } }, ACTOR);
  assert.equal(c.status, "established");
  assert.deepEqual(c.route, ["gzip.compress"]);
  assert.equal(c.run.status, "completed");
  assert.equal(gunzipSync((await import("node:fs")).readFileSync(join(env.out, "auto.gz"))).toString(), "composed automatically\n");
});

test("compose without a ready route returns the drafts instead of a skill", async () => {
  const c = await compose(cx, { have: "text/plain", want: "image/png" }, ACTOR);
  assert.equal(c.status, "no-ready-route");
});

test("simulate runs routes side by side and reports what they actually did", async () => {
  const s = await simulate(cx, { have: "text/plain", want: "application/gzip", preserve: ["bytes"], inputs: [{ text: "simulate me\n" }], witness: "gzip-roundtrip" }, ACTOR);
  assert.deepEqual(s.best, ["gzip.compress"]);
  assert.equal(s.routes[0].ok, true);
  assert.equal(s.routes[0].proven.bytes, true);
  assert.equal(s.routes[0].runs[0].witness, true);
  assert.equal(s.routes[0].runs[0].formatOk, true);
});

test("possibilities grow as abilities are acquired", () => {
  const p = possibilities(cx);
  const toText = p.capabilities.find((c) => c.from === "application/gzip" && c.to === "text/plain");
  assert.ok(toText.preserves.includes("bytes"), "the newly proven property appears on the route");
});

test("a text skill refuses unrecognised binary input (found by a real agent run)", async () => {
  const r = await runSkill(cx, "gzip-verified", { text: { base64: Buffer.from([0, 1, 2, 3, 250, 251, 252]).toString("base64") } });
  assert.equal(r.status, "refused");
  assert.match(r.reason, /unrecognised/);
});

test("evolve re-establishes claims and skills after a program changes", async () => {
  const e2 = environment();
  const progs = join(e2.root, "progs");
  mkdirSync(progs);
  const wrapper = join(progs, "gzip");
  writeFileSync(wrapper, `#!/bin/sh\nexec ${GZIP} "$@"\n`, { mode: 0o755 });
  grant(e2, [wrapper]);
  const c2 = await open(e2);
  const op = { ...compressOp, program: wrapper };
  const a = { path: join(e2.samples, "a.txt") }, b = { path: join(e2.samples, "b.txt") };
  await c2.experiment({ operation: op, trials: [{ inputs: { data: a } }, { inputs: { data: b } }], controls: false }, ACTOR);
  const sk = await compose(c2, { have: "text/plain", want: "application/gzip", id: "wrapped" }, ACTOR);
  assert.equal(sk.status, "established");
  writeFileSync(wrapper, `#!/bin/sh\n# upgraded\nexec ${GZIP} "$@"\n`, { mode: 0o755 });
  assert.equal(c2.claims({ operation: "gzip.compress" })[0].state, "stale");
  await assert.rejects(runSkill(c2, "wrapped", { input: { text: "x\n" } }), /changed/);
  const ev = await evolve(c2, {}, ACTOR);
  assert.ok(ev.newlyEstablished.includes("gzip.compress:produces:stdout"), JSON.stringify(ev));
  assert.ok(ev.revisited.skills.includes("wrapped"), "the unusable skill was re-crystallised");
  const { explainSkill } = await import("../src/skills.js");
  const k = explainSkill(c2, "wrapped");
  assert.equal(k.status, "established");
  assert.equal(k.usable.ok, true, "the skill is pinned to the upgraded program");
  const run = await runSkill(c2, "wrapped", { input: { text: "after the upgrade\n" } });
  assert.equal(run.status, "completed");
});

test("the ledger lists entries by kind and stays intact", () => {
  const l = cx.ledgerEntries({ kind: "simulation" });
  assert.ok(l.entries.length >= 1);
  assert.equal(l.verify.intact, true);
});

test("decompress op helper stays consistent", () => {
  assert.equal(decompressOp.outputs.stdout, "text/plain");
});
