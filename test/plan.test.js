// context_plan: any requirement, compiled into grounded, executable steps. A security requirement
// against a granted workspace must come back as a program — orient, read the file it names, hunt
// with context_recon, then close with context_repair — with the arguments filled from what is
// really there, not invented; a change requirement must name the exact file to edit and the test
// command to run; a data requirement without a workspace routes through the goal machinery; and a
// code requirement with no code workspace granted must say what is missing, not pretend.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plan } from "../src/plan.js";
import { ACTOR, environment, GZIP, grant, open } from "./helpers.js";

let env, cx, ws;

before(async () => {
  env = environment();
  ws = join(env.root, "code");
  mkdirSync(ws);
  writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "planned-app", scripts: { test: "node --test" } }, null, 2) + "\n");
  writeFileSync(join(ws, "app.js"), 'const { exec } = require("child_process");\nconst file = process.argv[2];\nexec(`wc -c ${file}`, (err, out) => console.log(out || err));\n');
  grant(env, [GZIP], { workspaces: [{ path: ws, network: false }] });
  cx = await open(env);
});

test("a security requirement becomes a grounded hunt-and-repair program", () => {
  const requirement = "fix the command injection in app.js";
  const p = plan(cx, { requirement, workspace: ws }, ACTOR);
  assert.deepEqual(p.intents, ["hunt", "fix"]);
  assert.deepEqual(p.grounding.workspace.relevantFiles, ["app.js"]);
  assert.equal(p.grounding.workspace.security.argvRoutes, 1, JSON.stringify(p.grounding.workspace.security));
  assert.ok(p.grounding.workspace.entryPoints.some((e) => e.kind === "cli" && e.file === "app.js"));
  const names = p.steps.map((s) => s.tool);
  assert.ok(names.includes("context_recon"), JSON.stringify(names));
  assert.ok(names.indexOf("context_repair") > names.indexOf("context_recon"), "repair comes after recon");
  const read = p.steps.find((s) => s.tool === "context_workspace" && s.args.action === "read");
  assert.equal(read.args.path, "app.js");
  assert.equal(read.args.workspace, ws);
  assert.match(p.note, /each step's outcome/i);
  assert.deepEqual(p.needs, []);
});

test("a change requirement names the exact file to edit and runs the tests", () => {
  const requirement = "add a retry to the file handling in app.js and run the tests";
  const p = plan(cx, { requirement, workspace: ws }, ACTOR);
  assert.ok(p.intents.includes("change"));
  const edit = p.steps.find((s) => s.tool === "context_edit");
  assert.ok(edit, JSON.stringify(p.steps.map((s) => s.tool)));
  assert.equal(edit.args.path, "app.js");
  assert.equal(edit.args.reason, requirement);
  assert.match(JSON.stringify(edit.args), /expectDigest|old/);
  const run = p.steps.find((s) => s.tool === "context_run");
  assert.ok(run, "the tests are part of the program");
});

test("a data requirement with no code routes through the goal machinery", () => {
  const p = plan(cx, { requirement: "compress every text file in the samples" }, ACTOR);
  const names = p.steps.map((s) => s.tool);
  assert.ok(names.includes("context_goal") && names.includes("context_gap"), JSON.stringify(names));
  assert.deepEqual(p.needs, []);
  assert.equal(p.grounding.here.programs, 1);
});

test("a code requirement without a granted workspace says what is missing", () => {
  const p = plan(cx, { requirement: "hunt for vulnerabilities in the code" }, ACTOR);
  assert.ok(p.intents.includes("hunt"));
  assert.ok(p.needs.some((n) => /granted code workspace/.test(n)), JSON.stringify(p.needs));
});

test("the step limit is honored and stated", () => {
  const p = plan(cx, { requirement: "fix the command injection in app.js", workspace: ws, limit: 3 }, ACTOR);
  assert.equal(p.steps.length, 3);
  assert.equal(p.truncated, 1);
});

test("refusals: a missing requirement and an ungranted workspace", async () => {
  assert.throws(() => plan(cx, { workspace: ws }, ACTOR), /requirement/);
  assert.throws(() => plan(cx, { requirement: "do things", workspace: env.root }, ACTOR), /not inside a code workspace/);
});

test("every plan is ledgered", () => {
  const ledger = cx.ledgerEntries({ kind: "plan" });
  assert.ok(ledger.entries.length >= 5);
  assert.match(ledger.entries.at(-1).summary, /plan: \d+ step\(s\)/);
  assert.equal(ledger.verify.intact, true);
});
