// Acting on real code: a small JavaScript project with a bug and a failing test.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { changes, edit, overview, read, run, search, undo } from "../src/workspace.js";
import { ACTOR, environment, grant, open } from "./helpers.js";

const NODE = realpathSync(process.execPath);
const BUGGY = "export function add(a, b) {\n  return a - b;\n}\n";
let env, cx, ws;

before(async () => {
  env = environment([NODE]);
  ws = join(env.root, "calc");
  mkdirSync(join(ws, "src"), { recursive: true });
  mkdirSync(join(ws, "test"));
  mkdirSync(join(ws, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(ws, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(ws, ".git", "refs", "heads", "main"), "0123456789abcdef0123456789abcdef01234567\n");
  writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "calc", type: "module", scripts: { test: "node --test" } }, null, 2));
  writeFileSync(join(ws, "src", "math.js"), BUGGY);
  writeFileSync(join(ws, "test", "math.test.js"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/math.js";\ntest("add", () => assert.equal(add(2, 3), 5));\n');
  symlinkSync("/etc/hosts", join(ws, "escape-link"));
  grant(env, [NODE], { workspaces: [{ path: ws, network: false }] });
  cx = await open(env);
});

test("overview understands the project: git, languages, manifests and its test command", () => {
  const o = overview(cx).workspaces[0];
  assert.equal(o.git.branch, "main");
  assert.equal(o.git.commit, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(o.languages.JavaScript, 2);
  assert.deepEqual(o.manifests[0].scripts, { test: "node --test" });
  assert.equal(o.commands[0].wants, "npm");
  assert.ok(!o.topLevel.includes(".git"));
});

test("search and read find the bug", () => {
  const s = search(cx, { workspace: ws, pattern: "a - b" });
  assert.deepEqual(s.matches.map((m) => [m.path, m.line]), [["src/math.js", 2]]);
  const r = read(cx, { workspace: ws, path: "src/math.js" });
  assert.equal(r.content, BUGGY);
  assert.match(r.digest, /^sha256:/);
});

test("fix the bug: failing test, reversible edit with a diff, passing test, undo", async () => {
  const failing = await run(cx, { workspace: ws, program: NODE, args: ["--test"] }, ACTOR);
  assert.equal(failing.passed, false);
  assert.deepEqual(failing.changes, []);

  const { digest } = read(cx, { workspace: ws, path: "src/math.js" });
  const e = await edit(cx, { workspace: ws, path: "src/math.js", replace: { old: "a - b", new: "a + b" }, expectDigest: digest, reason: "add subtracted" }, ACTOR);
  assert.match(e.change, /^edit-\d+$/);
  assert.match(e.diff, /-  return a - b;\n\+  return a \+ b;/);

  const passing = await run(cx, { workspace: ws, program: NODE, args: ["--test"] }, ACTOR);
  assert.equal(passing.passed, true, passing.stdout + passing.stderr);

  await assert.rejects(edit(cx, { workspace: ws, path: "src/math.js", replace: { old: "a + b", new: "b + a" }, expectDigest: digest }, ACTOR), /read it again/);

  const u = await undo(cx, { change: e.change }, ACTOR);
  assert.deepEqual(u.files, ["src/math.js"]);
  assert.equal(readFileSync(join(ws, "src", "math.js"), "utf8"), BUGGY);
  await assert.rejects(undo(cx, { change: e.change }, ACTOR), /already undone/);
  const listed = changes(cx, { workspace: ws }).changes.find((c) => c.change === e.change);
  assert.equal(listed.undone, true);
  assert.match(listed.files[0].diff, /\+  return a \+ b;/);
});

test("a run's file changes are reported and can be undone; writes outside the workspace are blocked", async () => {
  const outside = join(env.root, "outside.txt");
  const script = `const fs=require("fs"); fs.writeFileSync("gen.txt","generated"); fs.appendFileSync("src/math.js","// touched\\n"); try { fs.writeFileSync(${JSON.stringify(outside)}, "x") } catch {}`;
  const r = await run(cx, { workspace: ws, program: NODE, args: ["-e", script] }, ACTOR);
  assert.equal(r.passed, true, r.stderr);
  assert.deepEqual(r.changes.map((c) => [c.path, c.kind]).sort(), [["gen.txt", "added"], ["src/math.js", "changed"]]);
  const sandboxed = !String(r.sandbox).startsWith("none");
  if (sandboxed) assert.equal(existsSync(outside), false, "the sandbox kept the run inside the workspace");
  await undo(cx, { change: r.change }, ACTOR);
  assert.equal(existsSync(join(ws, "gen.txt")), false);
  assert.equal(readFileSync(join(ws, "src", "math.js"), "utf8"), BUGGY);
});

test("a child that outlives its run is accounted: the late write joins the change set and undo reverts it", async () => {
  rmSync(join(ws, "late.txt"), { force: true });
  const script = `const {spawn}=require("child_process"); const c=spawn(process.execPath,["-e","setTimeout(()=>{try{require('fs').writeFileSync('late.txt','late')}catch(e){}},500)"],{detached:true,stdio:"ignore"}); c.unref();`;
  const r = await run(cx, { workspace: ws, program: NODE, args: ["-e", script] }, ACTOR);
  assert.equal(r.passed, true, r.stderr);
  if (String(r.sandbox).startsWith("linux-bwrap")) {
    // bwrap unshares the pid namespace: every child dies with the run, so none can outlive it — a
    // stronger guarantee than the accounting window, which is the layer for fences that let a
    // daemonised child survive
    await new Promise((res) => setTimeout(res, 1200));
    assert.equal(existsSync(join(ws, "late.txt")), false, "the pid namespace killed the child: nothing may appear");
    assert.equal(r.lateWrites ?? 0, 0);
    assert.equal(r.settled, true, r.settledNote);
    return;
  }
  assert.ok(r.changes.some((c) => c.path === "late.txt" && c.kind === "added"), "the late write is in the ledgered change set");
  assert.ok(r.lateWrites >= 1, `the accounting window saw it appear after the run closed (lateWrites: ${r.lateWrites ?? 0})`);
  assert.match(r.lateNote, /surviving child process/);
  const listed = changes(cx, { workspace: ws }).changes.find((c) => c.change === r.change);
  assert.equal(listed.lateWrites, r.lateWrites, "the ledger carries the accounting too");
  await undo(cx, { change: r.change }, ACTOR);
  assert.equal(existsSync(join(ws, "late.txt")), false, "undo reverts the late write along with the run");
});

test("every run reports whether the workspace settled after it closed", async () => {
  const r = await run(cx, { workspace: ws, program: NODE, args: ["-e", ""] }, ACTOR);
  assert.equal(r.settled, true, r.settledNote);
  assert.equal(r.lateWrites ?? 0, 0);
  assert.equal(r.passed, true, r.stderr);
});

test("an undo refuses when the file changed since, and changes nothing", async () => {
  const e = await edit(cx, { workspace: ws, path: "notes.md", content: "first\n", create: true }, ACTOR);
  writeFileSync(join(ws, "notes.md"), "changed by someone else\n");
  await assert.rejects(undo(cx, { change: e.change }, ACTOR), /changed since/);
  assert.equal(readFileSync(join(ws, "notes.md"), "utf8"), "changed by someone else\n");
});

test("nothing outside the workspace, in .git, or through a link out is read or written", async () => {
  await assert.rejects(edit(cx, { workspace: ws, path: "../outside.txt", content: "x" }, ACTOR), /escapes the workspace/);
  await assert.rejects(edit(cx, { workspace: ws, path: "/etc/hosts", content: "x" }, ACTOR), /outside the workspace/);
  await assert.rejects(edit(cx, { workspace: ws, path: ".git/config", content: "x" }, ACTOR), /\.git/);
  assert.throws(() => read(cx, { workspace: ws, path: "escape-link" }), /outside the workspace/);
  await assert.rejects(edit(cx, { workspace: ws, path: "src/math.js", replace: { old: "a", new: "b" } }, ACTOR), /occurs \d+ times/);
  assert.throws(() => read(cx, { workspace: env.samples, path: "a.txt" }), /not inside a code workspace/);
  await assert.rejects(run(cx, { workspace: ws, program: "/bin/definitely-not-a-tool", args: [] }, ACTOR), /does not exist/);
});

test("any executable runs inside a granted workspace: the grant is the workspace, the sandbox the fence", async () => {
  const r = await run(cx, { workspace: ws, program: "/bin/sh", args: ["-c", "printf 'shell works\\n' > shell.txt"] }, ACTOR);
  assert.equal(r.passed, true, r.stderr);
  assert.ok(r.changes.some((c) => c.path === "shell.txt" && c.kind === "added"));
  await undo(cx, { change: r.change }, ACTOR);
  assert.equal(existsSync(join(ws, "shell.txt")), false);
});

test("a workspace under a home directory is runnable: the sandbox allows the ancestors it must", async () => {
  // sandbox-exec needs search permission on every component of the workspace path, so the profile
  // grants metadata — never reads — on those ancestors. This repository lives under a home
  // directory on macOS dev machines and CI alike, which is exactly the case the rules cover.
  const repo = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
  grant(env, [NODE], { workspaces: [{ path: ws, network: false }, { path: repo, network: false }] });
  cx.reloadGrant();
  const r = await run(cx, { workspace: repo, program: NODE, args: ["-e", 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync("package.json","utf8")).name)'] }, ACTOR);
  assert.equal(r.passed, true, r.stdout + r.stderr);
  assert.match(r.stdout, /context-cortex/);
});
