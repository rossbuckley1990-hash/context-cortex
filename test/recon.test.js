// context_recon: every way into a codebase, and proof where they open. The fixture project has
// argv-sourced routes (command injection, eval, traversal read, traversal write) that must be
// exploit-verified by running the real code inside the sandbox — a write outside the workspace
// must come back as contained, the fence holding — plus request-sourced routes that stay honest
// candidates, secrets in the clear, and a clean tree that yields an honest null.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recon } from "../src/hunt.js";
import { files } from "../src/workspace.js";
import { ACTOR, environment, grant, open } from "./helpers.js";

const PY = ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"].find(existsSync);
let env, cx, ws;

before(async () => {
  env = environment();
  ws = join(env.root, "vuln");
  mkdirSync(ws);
  writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "vuln-app", bin: { "vuln-cli": "cli.js" }, dependencies: { express: "^4.18.0" } }, null, 2) + "\n");
  writeFileSync(
    join(ws, "server.js"),
    'const express = require("express");\nconst app = express();\napp.get("/greet", (req, res) => {\n  const name = req.query.name;\n  res.send(`<h1>Hello ${name}</h1>`);\n});\napp.listen(3000);\n',
  );
  writeFileSync(join(ws, "cli.js"), 'const { exec } = require("child_process");\nconst file = process.argv[2];\nexec(`wc -c ${file}`, (err, out) => console.log(out || err));\n');
  writeFileSync(join(ws, "evaldriven.js"), "const expr = process.argv[2];\neval(expr);\n");
  writeFileSync(join(ws, "reader.js"), 'const fs = require("fs");\nconst path = process.argv[2];\nconsole.log(fs.readFileSync(path, "utf8"));\n');
  writeFileSync(join(ws, "writer.js"), 'const fs = require("fs");\nconst target = process.argv[2];\nfs.writeFileSync(target, "pwned");\nconsole.log("written");\n');
  writeFileSync(
    join(ws, "app.py"),
    "import os\nimport sys\n\ndef run():\n    target = sys.argv[1]\n    os.system(\"file \" + target)\n\nif __name__ == \"__main__\":\n    run()\n",
  );
  writeFileSync(join(ws, "config.json"), '{\n  "aws_access_key_id": "AKIAIOSFODNN7EXAMPLE"\n}\n');
  writeFileSync(join(ws, "db.js"), 'const password = "hunter2-super-secret";\nconsole.log("connected");\n');
  writeFileSync(join(ws, "clean.js"), 'const fs = require("fs");\nconsole.log(fs.readFileSync("fixed.txt", "utf8"));\n');
  grant(env, [], { workspaces: [{ path: ws, network: false }] });
  cx = await open(env);
});

const by = (r, cls, file) => r.findings.filter((f) => f.class === cls && (!file || f.file === file));

test("recon maps a codebase: entries, capabilities, dependencies, secrets", async () => {
  const r = await recon(cx, { workspace: ws, driveLimit: 0 }, ACTOR);
  const eps = r.map.entryPoints;
  assert.ok(eps.some((e) => e.kind === "http-route" && e.detail === "GET /greet" && e.file === "server.js"), JSON.stringify(eps));
  assert.ok(eps.some((e) => e.kind === "http-server"));
  assert.ok(eps.some((e) => e.kind === "cli" && e.file === "cli.js"));
  assert.ok(eps.some((e) => e.kind === "cli" && e.file === "app.py"));
  assert.ok(eps.some((e) => e.kind === "package-bin" && e.file === "cli.js"), "the declared bin is an entry");
  assert.ok(r.map.capabilities.exec >= 2);
  assert.ok(r.map.dependencies.npm.includes("express"));
  assert.ok(r.map.languages.JavaScript >= 7);
  assert.equal(r.map.languages.Python, 1);
  assert.ok(r.map.secrets.some((s) => s.kind === "aws-access-key-id" && s.file === "config.json"));
  assert.ok(r.map.secrets.some((s) => s.kind === "assigned-credential" && s.file === "db.js"));
  assert.ok(!r.findings.some((f) => f.file === "clean.js"), "a literal path with no taint is not a finding");
  assert.match(r.coverage.note, /never that the code is secure/);
});

test("argv routes are exploit-verified by running the real code, and everything is undone", async () => {
  const r = await recon(cx, { workspace: ws }, ACTOR);
  const injection = by(r, "command-injection", "cli.js");
  assert.equal(injection.length, 1, JSON.stringify(r.findings));
  const f = injection[0];
  assert.equal(f.severity, "critical");
  assert.match(f.chain.source.text, /process\.argv/);
  assert.match(f.chain.sink.text, /exec/);
  assert.equal(f.drive.status, "exploited", JSON.stringify(f.drive));
  assert.match(f.drive.evidence, /on both runs/);
  assert.ok(f.drive.runs.length === 2 && f.drive.runs.every((x) => x.proof), "both runs proved it");
  assert.ok(f.drive.runs.every((x) => x.changes.some((c) => /^added recon-marker/.test(c))), JSON.stringify(f.drive.runs));

  const evalF = by(r, "eval-injection", "evaldriven.js")[0];
  assert.equal(evalF.drive.status, "exploited");
  const readF = by(r, "path-traversal", "reader.js")[0];
  assert.equal(readF.drive.status, "exploited", JSON.stringify(readF.drive));
  assert.match(readF.drive.evidence, /outside the workspace/);
  assert.ok(readF.drive.runs.every((x) => x.proof), "both runs read the outside file");
  if (PY) {
    const pyF = by(r, "command-injection", "app.py")[0];
    assert.equal(pyF.drive.status, "exploited", JSON.stringify(pyF.drive));
  }
  assert.equal(r.summary.exploited, PY ? 4 : 3, JSON.stringify(r.summary));
  assert.equal(r.summary.contained, 1, JSON.stringify(r.summary));
  // A write outside the workspace: the code followed the path, the fence held.
  const writeF = by(r, "path-traversal", "writer.js")[0];
  assert.equal(writeF.drive.status, "contained-by-sandbox");
  assert.match(writeF.drive.evidence, /sandbox refused it/);
  // Every drive's marker was undone: the workspace is exactly as it was.
  const leftover = files(cx, { workspace: ws, pattern: "recon-marker" });
  assert.equal(leftover.shown, 0, `markers left behind: ${JSON.stringify(leftover.files)}`);
  const ledger = cx.ledgerEntries({ kind: "recon" });
  assert.ok(ledger.entries.length >= 2);
  assert.match(ledger.entries.at(-1).summary, /recon of .*: \d+ file\(s\), \d+ exploited/);
  assert.equal(ledger.verify.intact, true);
});

test("request-sourced routes stay honest candidates with a payload sketch", async () => {
  const r = await recon(cx, { workspace: ws }, ACTOR);
  const xss = by(r, "xss", "server.js");
  assert.equal(xss.length, 1, JSON.stringify(r.findings));
  assert.equal(xss[0].drive.status, "not-drivable");
  assert.match(xss[0].drive.reason, /live request/);
  assert.equal(xss[0].drive.sketch, "<script>alert(1)</script>");
  const driven = r.findings.filter((f) => f.drive.runs?.length);
  assert.equal(driven.length, PY ? 5 : 4, "only the argv routes were driven");
});

test("driveLimit 0 disables drives without hiding the routes", async () => {
  const r = await recon(cx, { workspace: ws, driveLimit: 0 }, ACTOR);
  assert.equal(r.summary.exploited, 0);
  const injection = by(r, "command-injection", "cli.js")[0];
  assert.equal(injection.drive.status, "not-drivable");
  assert.match(injection.drive.reason, /driveLimit 0/);
  assert.equal(r.findings.length >= 5, true, "the static findings are all still there");
});

test("refusals: a workspace that was not granted, and a missing argument", async () => {
  await assert.rejects(recon(cx, { workspace: env.root }, ACTOR), /not inside a code workspace/);
  await assert.rejects(recon(cx, {}, ACTOR), /workspace/);
});

test("a clean tree is an honest null, not a claim of safety", async () => {
  const clean = join(env.root, "clean-project");
  mkdirSync(clean);
  writeFileSync(join(clean, "index.js"), 'const fs = require("fs");\nconsole.log(fs.readFileSync("data.txt", "utf8").toUpperCase());\n');
  writeFileSync(join(clean, "data.txt"), "just text\n");
  grant(env, [], { workspaces: [{ path: ws, network: false }, { path: clean, network: false }] });
  cx.reloadGrant();
  const r = await recon(cx, { workspace: clean }, ACTOR);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.map.secrets, []);
  assert.equal(r.summary.exploited, 0);
  assert.equal(r.summary.contained, 0);
  assert.equal(r.summary.candidates, 0);
  assert.match(r.coverage.note, /never that the code is secure/);
});
