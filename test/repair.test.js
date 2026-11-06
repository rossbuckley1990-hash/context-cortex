// context_repair: solve what recon proves open, and prove it solved. The fixture project has the
// argv-driven routes recon found — command injection, eval, traversal read, traversal write — and
// the engine must close each with a guard fix that earns itself: the payload re-driven twice
// without reproducing, a benign input behaving byte-identically, and the project's own tests
// unregressed. A second workspace pins the vulnerable behavior in its tests, and the fix there
// must be reverted with the file byte-identical to before. Request-sourced routes come back as
// needs-redesign, never silently skipped, and a clean tree is an honest null.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repair } from "../src/repair.js";
import { files } from "../src/workspace.js";
import { ACTOR, environment, grant, open } from "./helpers.js";

const PY = ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"].find(existsSync);
const CLI_SRC = 'const { exec } = require("child_process");\nconst file = process.argv[2];\nexec(`wc -c ${file}`, (err, out) => console.log(out || err));\n';
const PIN_SRC = 'const { exec } = require("child_process");\nconst file = process.argv[2];\nexec(`wc -c ${file}`, (err, out) => console.log(out || err));\n';
let env, cx, ws, pinned;

before(async () => {
  env = environment();
  ws = join(env.root, "fixable");
  pinned = join(env.root, "pinned");
  mkdirSync(ws);
  mkdirSync(pinned);
  writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "fixable-app", bin: { "fix-cli": "cli.js" }, scripts: { test: "node test-app.js" } }, null, 2) + "\n");
  writeFileSync(join(ws, "cli.js"), CLI_SRC);
  writeFileSync(join(ws, "evaldriven.js"), "const expr = process.argv[2];\neval(expr);\n");
  writeFileSync(join(ws, "reader.js"), 'const fs = require("fs");\nconst path = process.argv[2];\nconsole.log(fs.readFileSync(path, "utf8"));\n');
  writeFileSync(join(ws, "writer.js"), 'const fs = require("fs");\nconst target = process.argv[2];\nfs.writeFileSync(target, "pwned");\nconsole.log("written");\n');
  writeFileSync(
    join(ws, "app.py"),
    "import os\nimport sys\n\ndef run():\n    target = sys.argv[1]\n    os.system(\"file \" + target)\n\nif __name__ == \"__main__\":\n    run()\n",
  );
  writeFileSync(
    join(ws, "server.js"),
    'const express = require("express");\nconst app = express();\napp.get("/greet", (req, res) => {\n  res.send(`<h1>Hello ${req.query.name}</h1>`);\n});\napp.listen(3000);\n',
  );
  writeFileSync(
    join(ws, "test-app.js"),
    'const { spawnSync } = require("child_process");\n'
      + 'const one = spawnSync(process.execPath, ["cli.js", "context-repair-benign.txt"], { encoding: "utf8" });\n'
      + 'if (one.status !== 0 || !/\\d+ context-repair-benign\\.txt/.test(one.stdout)) { console.error("cli.js no longer reports a size: " + (one.stderr || one.stdout)); process.exit(1); }\n'
      + 'const two = spawnSync(process.execPath, ["reader.js", "context-repair-benign.txt"], { encoding: "utf8" });\n'
      + 'if (two.status !== 0 || !two.stdout.includes("context repair benign input")) { console.error("reader.js no longer reads: " + (two.stderr || two.stdout)); process.exit(1); }\n'
      + 'console.log("ok");\n',
  );
  writeFileSync(join(pinned, "package.json"), JSON.stringify({ name: "pinned-app", scripts: { test: "node pin-test.js" } }, null, 2) + "\n");
  writeFileSync(join(pinned, "pin-cli.js"), PIN_SRC);
  writeFileSync(
    join(pinned, "pin-test.js"),
    'const { spawnSync } = require("child_process");\n'
      + 'const r = spawnSync(process.execPath, ["pin-cli.js", "a;b"], { encoding: "utf8" });\n'
      + 'if (r.status !== 0) { console.error("pin-cli.js must accept any argument, shell metacharacters included (pinned behavior)"); process.exit(1); }\n'
      + 'console.log("ok");\n',
  );
  grant(env, [], { workspaces: [{ path: ws, network: false }, { path: pinned, network: false }] });
  cx = await open(env);
});

test("repair closes argv-driven routes with proof: payload, benign behavior, tests", async () => {
  const r = await repair(cx, { workspace: ws }, ACTOR);
  assert.equal(r.summary.reverted, 0, JSON.stringify(r.summary));

  const cli = r.repairs.find((x) => x.file === "cli.js");
  assert.equal(cli.status, "closed", JSON.stringify(cli));
  assert.match(cli.guard, /untrusted argument/);
  assert.ok(cli.change.startsWith("edit-"), "the fix is one undoable edit");
  assert.equal(cli.proof.benign.equivalent, true);
  assert.ok(cli.postRuns.length === 2 && cli.postRuns.every((x) => !x.proof), "the payload no longer reproduces on either run");
  assert.equal(cli.proof.tests.before.passed, true, JSON.stringify(cli.proof.tests));
  assert.equal(cli.proof.tests.after.passed, true, "the project's own tests still pass with the fix");

  const ev = r.repairs.find((x) => x.file === "evaldriven.js");
  assert.equal(ev.status, "closed", JSON.stringify(ev));
  assert.match(ev.guard, /untrusted expression/);

  const reader = r.repairs.find((x) => x.file === "reader.js");
  assert.equal(reader.status, "closed", JSON.stringify(reader));
  assert.match(reader.guard, /path refused/);

  const writer = r.repairs.find((x) => x.file === "writer.js");
  assert.equal(writer.status, "hardened", JSON.stringify(writer));
  assert.match(writer.proof.after, /refuses the attacker's path/);

  if (PY) {
    const py = r.repairs.find((x) => x.file === "app.py");
    assert.equal(py.status, "closed", JSON.stringify(py));
    assert.match(py.guard, /untrusted argument/);
  }
  assert.equal(r.summary.closed, PY ? 4 : 3, JSON.stringify(r.summary));
  assert.equal(r.summary.hardened, 1);

  assert.ok(readFileSync(join(ws, "cli.js"), "utf8").includes("untrusted argument"), "the guard is really in the file");
  const leftover = files(cx, { workspace: ws, pattern: "recon-marker|context-repair-benign" });
  assert.equal(leftover.shown, 0, `drives left files behind: ${JSON.stringify(leftover.files)}`);
  const ledger = cx.ledgerEntries({ kind: "repair" });
  assert.ok(ledger.entries.length >= 1);
  assert.match(ledger.entries.at(-1).summary, /repair of .*: \d+ closed/);
  assert.equal(ledger.verify.intact, true);
});

test("a route already closed is reported, not re-fixed", async () => {
  const r = await repair(cx, { workspace: ws }, ACTOR);
  assert.equal(r.summary.closed, 0, JSON.stringify(r.summary));
  const cli = r.repairs.find((x) => x.file === "cli.js");
  assert.equal(cli.status, "not-open");
  assert.match(cli.reason, /nothing was changed/);
  const writer = r.repairs.find((x) => x.file === "writer.js");
  assert.equal(writer.status, "not-open", JSON.stringify(writer));
});

test("tests that pin the vulnerability revert the fix, byte for byte", async () => {
  const r = await repair(cx, { workspace: pinned }, ACTOR);
  const pin = r.repairs.find((x) => x.file === "pin-cli.js");
  assert.equal(pin.status, "reverted", JSON.stringify(pin));
  assert.match(pin.reason, /tests regressed/);
  assert.match(pin.note, /the fix was undone/);
  assert.match(pin.attempted, /untrusted argument/);
  assert.equal(readFileSync(join(pinned, "pin-cli.js"), "utf8"), PIN_SRC, "the file is exactly as it was");
  assert.equal(r.summary.reverted, 1);
});

test("request-sourced routes are needs-redesign with reasoning, never a silent skip", async () => {
  const r = await repair(cx, { workspace: ws, classes: ["command-injection", "xss"] }, ACTOR);
  const xss = r.needsRedesign.find((x) => x.file === "server.js" && x.class === "xss");
  assert.ok(xss, JSON.stringify(r.needsRedesign));
  assert.match(xss.reason, /sandbox does not grant|no honest one-line guard/);
  assert.ok(r.skipped.every((x) => /not attempted/.test(x.reason)), "anything not attempted says why");
});

test("classes and file filters narrow the attempt", async () => {
  const one = await repair(cx, { workspace: ws, file: "reader.js" }, ACTOR);
  assert.equal(one.repairs.length, 1);
  assert.equal(one.repairs[0].file, "reader.js");
  assert.ok(one.repairs[0].status === "closed" || one.repairs[0].status === "not-open");
  const cls = await repair(cx, { workspace: ws, classes: ["command-injection"] }, ACTOR);
  assert.ok(cls.repairs.every((x) => x.class === "command-injection"));
});

test("refusals: a workspace that was not granted, and a missing argument", async () => {
  await assert.rejects(repair(cx, { workspace: env.root }, ACTOR), /not inside a code workspace/);
  await assert.rejects(repair(cx, {}, ACTOR), /workspace/);
});

test("a clean tree is an honest null", async () => {
  const clean = join(env.root, "clean-project");
  mkdirSync(clean);
  writeFileSync(join(clean, "index.js"), 'const fs = require("fs");\nconsole.log(fs.readFileSync("data.txt", "utf8").toUpperCase());\n');
  writeFileSync(join(clean, "data.txt"), "just text\n");
  grant(env, [], { workspaces: [{ path: ws, network: false }, { path: pinned, network: false }, { path: clean, network: false }] });
  cx.reloadGrant();
  const r = await repair(cx, { workspace: clean }, ACTOR);
  assert.deepEqual(r.repairs, []);
  assert.equal(r.summary.attempted, 0);
  assert.match(r.coverage.note, /never for every input/);
});
