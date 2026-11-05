import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, copyFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { goal, possibilities } from "../src/goal.js";
import { explainSkill, listSkills, runSkill } from "../src/skills.js";
import { exportBundle, importBundle, readBundle, writeBundle } from "../src/transfer.js";
import { ACTOR, environment, grant, GZIP, learnGzip, open, stateOf } from "./helpers.js";

let env, cx, learned;
before(async () => {
  env = environment();
  cx = await open(env);
  learned = await learnGzip(cx, env);
});

test("experiments establish what gzip accepts, produces and refuses", () => {
  const { compress, decompress } = learned;
  assert.equal(compress.deterministic, true);
  assert.equal(stateOf(compress, "gzip.compress:accepts:data"), "established");
  assert.equal(stateOf(compress, "gzip.compress:produces:stdout"), "established");
  assert.equal(stateOf(decompress, "gzip.decompress:produces:stdout"), "established");
  assert.equal(stateOf(decompress, "gzip.decompress:rejects:truncate"), "established");
  assert.equal(stateOf(decompress, "gzip.decompress:rejects:corrupt-header"), "established");
  assert.ok(decompress.controls.every((c) => c.outcome === "failure"), "every damaged input was refused");
});

test("a witness is calibrated against generated mutations, and a hypothesis it checks becomes established", () => {
  assert.equal(learned.witness.status, "calibrated");
  assert.ok(learned.witness.mutations >= 3);
  assert.equal(learned.witness.mutationsRejected, learned.witness.mutations);
  assert.deepEqual(learned.lossless.judgements.map((j) => j.verdict), ["supports", "supports"]);
  assert.equal(stateOf(learned.lossless, "gzip.compress:lossless"), "established");
});

test("crystallising runs the self-test, including the refusal fixture", () => {
  const s = learned.skill;
  assert.equal(s.status, "established", JSON.stringify(s.gaps));
  assert.deepEqual(s.selfTest.map((t) => [t.fixture, t.result, t.ok]), [["text", "completed", true], ["binary-is-refused", "refused", true]]);
  assert.match(s.preservedBy.bytes, /end to end/);
  const listed = listSkills(cx).find((k) => k.id === "gzip-verified");
  assert.equal(listed.usable, true);
  const explained = explainSkill(cx, "gzip-verified");
  assert.equal(explained.prerequisites.authority.network, false);
  assert.ok(explained.provenance.demonstrations.length >= 2);
});

test("a skill runs on an unseen input, checks its success condition and delivers the output", async () => {
  const r = await runSkill(cx, "gzip-verified", { text: { path: join(env.samples, "c.txt") } }, { deliver: join(env.out, "c.txt.gz") });
  assert.equal(r.status, "completed");
  assert.deepEqual(r.conditions.map((c) => c.accept), [true]);
  assert.equal(gunzipSync(readFileSync(join(env.out, "c.txt.gz"))).toString(), readFileSync(join(env.samples, "c.txt"), "utf8"));
});

test("a skill refuses an input of the wrong format instead of returning a result", async () => {
  const r = await runSkill(cx, "gzip-verified", { text: { base64: "H4sIAAAAAAAAAwMAAAAAAAAAAAA=" } });
  assert.equal(r.status, "refused");
  assert.match(r.reason, /application\/gzip/);
});

test("goal finds the skill and a ready route; possibilities maps what is newly possible", () => {
  const g = goal(cx, { have: "text/plain", want: "application/gzip", preserve: ["bytes"] });
  assert.equal(g.skills[0].skill, "gzip-verified");
  assert.equal(g.routes[0].ready, true);
  const gap = goal(cx, { have: "application/gzip", want: "text/plain", preserve: ["bytes"] });
  assert.equal(gap.routes[0].ready, false);
  assert.ok(gap.routes[0].gaps.some((x) => x.missing === "preserves bytes"));
  const p = possibilities(cx, { since: 1 });
  assert.ok(p.capabilities.some((c) => c.from === "text/plain" && c.to === "application/gzip" && c.preserves.includes("bytes")));
  assert.ok(p.newlyPossible.length >= 2);
});

test("probe reads a program's usage text inside the sandbox", async () => {
  const r = await cx.probe(GZIP);
  assert.ok(r.usage.some((u) => /usage|gzip/i.test(u.text)));
  assert.ok(r.formatMentions.includes("application/gzip"));
  assert.ok(!r.usage.some((u) => u.text.includes("\u0000")), "binary output is summarised, not printed");
});

test("transfer: a fresh home imports the bundle and re-establishes everything itself", async () => {
  const bundle = exportBundle(cx, ["gzip-verified"], ACTOR);
  assert.equal(bundle.carriesAuthority, false);
  const path = writeBundle(cx, bundle, join(env.out, "bundle.json"));
  const other = environment();
  copyFileSync(path, join(other.samples, "bundle.json"));
  const cx2 = await open(other);
  const r = await importBundle(cx2, readBundle(cx2, join(other.samples, "bundle.json")), ACTOR);
  assert.equal(r.revalidation.outcome, "revalidated", JSON.stringify(r.revalidation.errors));
  assert.deepEqual(r.revalidation.skills.map((k) => [k.skill, k.status, k.sameRevision]), [["gzip-verified", "revalidated", true]]);
  assert.deepEqual(r.revalidation.disagreements, []);
  const run = await runSkill(cx2, "gzip-verified", { text: { path: join(other.samples, "c.txt") } });
  assert.equal(run.status, "completed");
});

test("transfer: a host that has not granted the program keeps the skill unusable", async () => {
  const bundle = exportBundle(cx, ["gzip-verified"], ACTOR);
  const other = environment([]);
  const cx3 = await open(other);
  const r = await importBundle(cx3, bundle, ACTOR);
  assert.equal(r.revalidation.outcome, "not-revalidated");
  await assert.rejects(runSkill(cx3, "gzip-verified", { text: { text: "x\n" } }), /imported-unvalidated/);
});

test("transfer: a bundle whose bytes do not match their digests is refused", async () => {
  const bundle = exportBundle(cx, ["gzip-verified"], ACTOR);
  bundle.artefacts[0].data = Buffer.from("tampered").toString("base64");
  const cx4 = await open(environment());
  await assert.rejects(importBundle(cx4, bundle, ACTOR), /does not match its bytes/);
});

test("transfer: a bundle that claims authority is refused by the schema", async () => {
  const bundle = exportBundle(cx, ["gzip-verified"], ACTOR);
  bundle.carriesAuthority = true;
  const cx5 = await open(environment());
  await assert.rejects(importBundle(cx5, bundle, ACTOR), /carriesAuthority/);
});

test("the ledger is intact after all of it", () => {
  const v = cx.ledger.verify();
  assert.equal(v.intact, true);
  assert.ok(v.entries > 40);
});

test("grant changes take effect without restarting (operator only)", async () => {
  grant(env, []);
  cx.reloadGrant();
  await assert.rejects(runSkill(cx, "gzip-verified", { text: { text: "x\n" } }), /no longer granted/);
  grant(env, [GZIP]);
  cx.reloadGrant();
});
