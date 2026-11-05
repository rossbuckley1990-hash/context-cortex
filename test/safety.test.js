import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { crystallize, runSkill } from "../src/skills.js";
import { Ledger } from "../src/ledger.js";
import { ACTOR, CAT, compressOp, environment, GZIP, learnGzip, open, skillDef, stateOf } from "./helpers.js";

test("a program outside the grant is refused and nothing is run", async () => {
  const env = environment([]);
  const cx = await open(env);
  const before = cx.ledger.verify().entries;
  await assert.rejects(cx.experiment({ operation: compressOp, trials: [{ inputs: { data: { text: "x\n" } } }] }, ACTOR), /not in the operator's grant/);
  await assert.rejects(cx.probe(GZIP), /not in the operator's grant/);
  assert.equal(cx.ledger.verify().entries, before, "no trial was recorded");
});

test("host files are read only inside read roots, and written only inside write roots, never overwritten", async () => {
  const env = environment();
  const cx = await open(env);
  assert.throws(() => cx.addSample({ path: "/etc/hosts" }), /outside the operator's read roots/);
  const { skill } = await learnGzip(cx, env);
  assert.equal(skill.status, "established");
  await assert.rejects(runSkill(cx, "gzip-verified", { text: { text: "x\n" } }, { deliver: join(env.root, "elsewhere.gz") }), /outside the operator's write roots/);
  writeFileSync(join(env.out, "taken.gz"), "keep me");
  await assert.rejects(runSkill(cx, "gzip-verified", { text: { text: "x\n" } }, { deliver: join(env.out, "taken.gz") }), /overwrite/);
  assert.equal(readFileSync(join(env.out, "taken.gz"), "utf8"), "keep me");
});

test("with no sandbox, nothing runs unless the operator allowed it", async () => {
  const env = environment();
  const cx = await open(env);
  const saved = process.env.CORTEX_SANDBOX;
  process.env.CORTEX_SANDBOX = "none";
  try {
    cx.grant.allowUnsandboxed = false;
    await assert.rejects(cx.experiment({ operation: compressOp, trials: [{ inputs: { data: { text: "x\n" } } }] }, ACTOR), /no sandbox is available/);
  } finally {
    if (saved === undefined) delete process.env.CORTEX_SANDBOX;
    else process.env.CORTEX_SANDBOX = saved;
    cx.reloadGrant();
  }
});

test("a program that exits 0 on damaged input is caught: its refusal claim is contradicted", async () => {
  const env = environment([CAT]);
  const cx = await open(env);
  const gz = cx.addSample({ base64: "H4sIAAAAAAAAA8tIzcnJBwCGphA2BgAAAA==" }).digest;
  const gz2 = cx.addSample({ base64: "H4sIAAAAAAAAA8vPS8vPS83JzytJLS4BACLzS5gQAAAA" }).digest;
  const r = await cx.experiment({ operation: { id: "cat.copy", program: CAT, args: ["{in:data}"], inputs: { data: "application/gzip" }, outputs: { stdout: "application/gzip" } }, trials: [{ inputs: { data: gz } }, { inputs: { data: gz2 } }] }, ACTOR);
  assert.equal(stateOf(r, "cat.copy:rejects:truncate"), "contradicted");
  assert.ok(r.contradictions.some((c) => /refuses input damaged by truncate/.test(c)));
});

test("a witness that accepts anything fails calibration and cannot establish a claim", async () => {
  const env = environment();
  const cx = await open(env);
  const r = await cx.calibrate({ witness: { id: "too-kind", builtin: "nonempty", params: ["candidate"] }, references: [{ bind: { candidate: { text: "anything" } } }], mutate: { param: "candidate", kinds: ["truncate", "flip-middle"] } }, ACTOR);
  assert.equal(r.status, "failed");
  const e = await cx.experiment({
    operation: compressOp, trials: [{ inputs: { data: { text: "one\n" } } }, { inputs: { data: { text: "two\n" } } }], controls: false,
    hypotheses: [{ id: "lossless", kind: "preservation", text: "lossless", property: "bytes", check: { witness: "too-kind", bind: { candidate: "output.stdout" } } }],
  }, ACTOR);
  assert.equal(stateOf(e, "gzip.compress:lossless"), "hypothesised");
  assert.ok(e.judgements.every((j) => j.verdict === "not-judged"));
});

test("a changed program makes its claims stale and its skill unusable", async () => {
  const env = environment();
  const progs = join(env.root, "progs");
  mkdirSync(progs);
  // A wrapper script: macOS kills copies of signed system binaries, and a script is easy to change.
  const copy = join(progs, "gzip");
  writeFileSync(copy, `#!/bin/sh\nexec ${GZIP} "$@"\n`, { mode: 0o755 });
  const { grant } = await import("./helpers.js");
  grant(env, [copy]);
  const cx = await open(env);
  const op = (o) => ({ ...o, program: copy });
  const a = { path: join(env.samples, "a.txt") }, b = { path: join(env.samples, "b.txt") };
  const c = await cx.experiment({ operation: op(compressOp), trials: [{ inputs: { data: a } }, { inputs: { data: b } }], controls: false }, ACTOR);
  assert.equal(stateOf(c, "gzip.compress:produces:stdout"), "established");
  writeFileSync(copy, `#!/bin/sh\nexec ${CAT} "$@"\n`, { mode: 0o755 });
  const claim = cx.claims({ operation: "gzip.compress" }).find((x) => x.id === "gzip.compress:produces:stdout");
  assert.equal(claim.state, "stale");
  const s = await crystallize(cx, { ...skillDef(env), successConditions: [{ witness: "builtin:nonempty", bind: { candidate: "steps.compress.stdout" } }], preserve: [] }, ACTOR);
  assert.equal(s.status, "draft");
  assert.ok(s.gaps.some((g) => /program changed/.test(g)));
});

test("an operation id cannot be silently redefined", async () => {
  const env = environment();
  const cx = await open(env);
  await cx.experiment({ operation: compressOp, trials: [{ inputs: { data: { text: "x\n" } } }], controls: false }, ACTOR);
  await assert.rejects(cx.experiment({ operation: { ...compressOp, args: ["-9", "-n", "-c", "{in:data}"] }, trials: [{ inputs: { data: { text: "x\n" } } }] }, ACTOR), /different definition/);
});

test("a tampered ledger is detected", async () => {
  const env = environment();
  const cx = await open(env);
  const lines = readFileSync(cx.ledger.file, "utf8").split("\n");
  const entry = JSON.parse(lines[1]);
  entry.body.reason = "rewritten after the fact";
  lines[1] = JSON.stringify(entry);
  writeFileSync(cx.ledger.file, lines.join("\n"));
  const v = new Ledger(cx.ledger.file).verify();
  assert.equal(v.intact, false);
  assert.equal(v.brokenAt, 2);
});

test("a trial budget beyond the grant is refused before anything runs", async () => {
  const env = environment();
  const { grant } = await import("./helpers.js");
  grant(env, [GZIP], { limits: { timeoutMs: 20000, maxTrialsPerExperiment: 3, maxOutputBytes: 1 << 26, maxBundleBytes: 1 << 25 } });
  const cx = await open(env);
  await assert.rejects(cx.experiment({ operation: compressOp, trials: [1, 2, 3].map((n) => ({ inputs: { data: { text: `${n}\n` } } })) }, ACTOR), /allows 3/);
});

test("the sandbox is present where CI expects it, and it confines a hostile program", { skip: process.env.CORTEX_TEST_UNSANDBOXED === "1" && "running unsandboxed by request" }, async () => {
  const { detectSandbox } = await import("../src/sandbox.js");
  const sb = await detectSandbox();
  if (process.env.CORTEX_EXPECT_SANDBOX === "1") assert.ok(sb.kind, `expected a sandbox: ${sb.reason}`);
  if (!sb.kind) return;
  const { existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const secret = fileURLToPath(new URL("../package.json", import.meta.url)); // under a home directory locally and in CI
  const env = environment(["/bin/sh"]);
  const escape = join(env.root, "escaped.txt");
  const cx = await open(env);
  const r = await cx.experiment({
    operation: { id: "sh.hostile", program: "/bin/sh", args: ["-c", `cat '${secret}' 2>/dev/null; echo out > '${escape}' 2>/dev/null; cat "$0"`, "{in:data}"], inputs: { data: "text/plain" }, outputs: { stdout: "text/plain" } },
    trials: [{ inputs: { data: { text: "harmless\n" } } }], controls: false,
  }, ACTOR);
  assert.equal(existsSync(escape), false, "no write outside the work directory");
  const out = r.trials[0].outputs.stdout ? cx.artefacts.get(r.trials[0].outputs.stdout.digest).toString() : "";
  assert.ok(!out.includes("context-cortex"), "nothing read from the home directory");
});
