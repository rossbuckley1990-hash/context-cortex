// context_audit: adversarial trials on real inputs. A finding counts only when it reproduces;
// clean refusals feed rejects:<damage> claims; accepted damage contradicts them; and the honest
// null — no reproducible weakness — is reported as exactly that, never as safety.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { audit } from "../src/audit.js";
import { DEFAULT_LIMITS } from "../src/grant.js";
import { ACTOR, compressOp, decompressOp, environment, grant, open } from "./helpers.js";

let env, cx;

// On macOS, copies of signed system binaries are killed, so tests use wrapper scripts.
function program(name, body) {
  const p = join(env.root, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

const regrant = (programs, extra = {}) => {
  grant(env, programs, extra);
  cx.reloadGrant();
};

before(async () => {
  env = environment();
  cx = await open(env);
});

test("the honest null: gzip refuses every damaged input, and the audit says only that", async () => {
  const a = { path: join(env.samples, "a.txt") }, b = { path: join(env.samples, "b.txt") }, c = { path: join(env.samples, "c.txt") };
  const compress = await cx.experiment({ operation: compressOp, trials: [{ inputs: { data: a } }, { inputs: { data: b } }, { inputs: { data: c } }], controls: false }, ACTOR);
  const gz = compress.trials.map((t) => t.outputs.stdout.digest);
  await cx.experiment({ operation: decompressOp, trials: gz.map((d) => ({ inputs: { data: d } })), controls: false }, ACTOR);

  const r = await audit(cx, { operation: "gzip.decompress", inputs: { data: gz } }, ACTOR);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.unconfirmed, []);
  assert.equal(r.refusals, 12);
  assert.deepEqual(r.battery, { samples: { data: 3 }, kinds: ["truncate", "corrupt-header", "flip-middle", "empty"], runs: 12, repeats: 0 });
  const states = Object.fromEntries(r.claims.filter((cl) => cl.id.includes(":rejects:")).map((cl) => [cl.id.split(":").at(-1), cl.state]));
  // Three distinct samples establish rejection of truncation and corruption — but every empty
  // mutation is the same zero bytes, so that is one distinct damaged input, and two are needed.
  assert.deepEqual(states, { truncate: "established", "corrupt-header": "established", "flip-middle": "established", empty: "observed" });
  assert.match(r.coverage.note, /not that the operation is safe/);

  const entries = cx.ledgerEntries({ kind: "audit" });
  assert.equal(entries.entries.length, 1);
  assert.match(entries.entries[0].summary, /audit of gzip\.decompress: 0 finding\(s\) \(none\), 12 clean refusal\(s\)/);
  assert.equal(entries.verify.intact, true);
});

test("a crash on damaged input is a finding once it reproduces", async () => {
  const crasher = program("crasher", 'if grep -q secret "$1"; then printf "ok\\n"; exit 0; fi\nkill -s SEGV $$');
  regrant([crasher]);
  const op = { id: "crash.copy", program: crasher, args: ["{in:data}"], inputs: { data: "text/plain" }, outputs: { stdout: "text/plain" } };
  await cx.experiment({ operation: op, trials: [{ inputs: { data: { text: "the secret is safe\n" } } }], controls: false }, ACTOR);

  const r = await audit(cx, { operation: "crash.copy", inputs: { data: [{ text: "the secret is safe\n" }] } }, ACTOR);
  assert.equal(r.findings.length, 4);
  for (const f of r.findings) {
    assert.equal(f.class, "crash");
    assert.equal(f.severity, "high");
    // sandbox-exec execs the program, so the SIGSEGV reaches the engine directly; bubblewrap forks,
    // so the same death arrives as exit code 128+11. Both are the same crash.
    assert.ok(f.signal === "SIGSEGV" || f.exitCode === 139, `signal=${f.signal} exitCode=${f.exitCode}`);
    assert.equal(f.reproduced, true);
    assert.match(f.statement, /crashes/);
  }
  assert.equal(r.refusals, 0);
  assert.equal(r.unconfirmed.length, 0);
  // A crash still refused the input, so the evidence supports rejects:<kind> — but one sample gives
  // one distinct damaged input per kind, and two are needed to establish anything.
  const rejects = r.claims.filter((cl) => cl.id.includes(":rejects:"));
  assert.ok(rejects.every((cl) => cl.state === "observed"));
  assert.match(rejects[0].reasons.join(" "), /distinct/);
});

test("a silent accept on damaged input is a finding and contradicts the rejects claims", async () => {
  const liar = program("liar", 'printf "looks fine\\n"');
  regrant([liar]);
  const op = { id: "liar.copy", program: liar, args: ["{in:data}"], inputs: { data: "text/plain" }, outputs: { stdout: "text/plain" } };
  await cx.experiment({ operation: op, trials: [{ inputs: { data: { text: "genuine input\n" } } }], controls: false }, ACTOR);

  const r = await audit(cx, { operation: "liar.copy", inputs: { data: [{ text: "genuine input\n" }] } }, ACTOR);
  assert.equal(r.findings.length, 4);
  assert.ok(r.findings.every((f) => f.class === "silent-accept" && f.severity === "high" && f.reproduced === true));
  assert.ok(r.findings.every((f) => f.claim === "liar.copy:rejects:" + f.mutation.kind));
  assert.equal(r.refusals, 0);
  assert.ok(r.claims.filter((cl) => cl.id.includes(":rejects:")).every((cl) => cl.state === "contradicted"));
  assert.equal(r.contradictions.length, 4);
  assert.match(r.contradictions[0], /refuses input damaged by/);
});

test("a signal death a wrapper reports as 128+N is still a crash", async () => {
  const faker = program("faker", 'if grep -q secret "$1"; then printf "ok\\n"; exit 0; fi\nexit 139');
  regrant([faker]);
  const op = { id: "faker.copy", program: faker, args: ["{in:data}"], inputs: { data: "text/plain" }, outputs: { stdout: "text/plain" } };
  const r = await audit(cx, { operation: op, inputs: { data: [{ text: "the secret is safe\n" }] }, kinds: ["truncate"] }, ACTOR);
  assert.equal(r.findings.length, 1, JSON.stringify(r.unconfirmed));
  assert.equal(r.findings[0].class, "crash");
  assert.equal(r.findings[0].exitCode, 139);
  assert.match(r.findings[0].statement, /128\+11/);
});

test("a hang is a finding when the trial timeout kills it twice", async () => {
  const sleeper = program("sleeper", "sleep 30");
  regrant([sleeper], { limits: { ...DEFAULT_LIMITS, timeoutMs: 1000 } });
  const op = { id: "sleep.copy", program: sleeper, args: ["{in:data}"], inputs: { data: "text/plain" }, outputs: { stdout: "text/plain" } };
  await cx.experiment({ operation: op, trials: [{ inputs: { data: { text: "any\n" } } }], controls: false }, ACTOR);

  const r = await audit(cx, { operation: "sleep.copy", inputs: { data: [{ text: "any\n" }] }, kinds: ["empty"] }, ACTOR);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].class, "hang");
  assert.equal(r.findings[0].severity, "medium");
  assert.equal(r.findings[0].reproduced, true);
  assert.equal(r.findings[0].signal, "SIGKILL");
  assert.deepEqual(r.coverage.kindsTried, ["empty"], "what was not tried is visible");
});

test("the battery refuses bad specs rather than running anything", async () => {
  regrant([]);
  await assert.rejects(audit(cx, { operation: "no.such", inputs: { data: [{ text: "x\n" }] } }, ACTOR), /no operation no\.such/);
  await assert.rejects(audit(cx, { operation: "gzip.compress", inputs: { data: [{ text: "x\n" }] }, kinds: ["burn"] }, ACTOR), /unknown damage kind/);
  await assert.rejects(audit(cx, { operation: "gzip.compress", inputs: {} }, ACTOR), /at least one known-good source for data/);
  await assert.rejects(audit(cx, { operation: "gzip.compress", inputs: { data: [{ text: "x\n" }], spare: [{ text: "y\n" }] } }, ACTOR), /names spare/);
  const many = Array.from({ length: 7 }, (_, i) => ({ text: `sample ${i}\n` }));
  await assert.rejects(audit(cx, { operation: "gzip.compress", inputs: { data: many } }, ACTOR), /the grant allows 48/);
});
