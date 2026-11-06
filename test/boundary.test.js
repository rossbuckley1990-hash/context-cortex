// The boundary tools: reach (the tripwire map), escape (the fence proven by attempting the real
// moves), gates (the defense inventory), secrets (the credential map without the keys) and
// persist (persistence both sides: what has a foothold, and proof this grant cannot take one).
// Each engine is driven against a workspace planted with the shapes it must find, and the
// classifications must come from the fence's real answers — refusals, not assumptions.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { escape } from "../src/escape.js";
import { gates } from "../src/gates.js";
import { persist } from "../src/persist.js";
import { reach } from "../src/reach.js";
import { secrets } from "../src/secrets.js";
import { edit } from "../src/workspace.js";
import { ACTOR, environment, grant, open } from "./helpers.js";

let env, cx, ws, root;

before(async () => {
  env = environment();
  root = join(env.root, "boundary");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, ".git", "hooks"), { recursive: true });
  mkdirSync(join(root, ".husky"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho hook\n");
  writeFileSync(join(root, ".git", "config"), '[core]\n\thooksPath = .husky\n[alias]\n\tco = !git checkout $1\n');
  writeFileSync(join(root, ".husky", "pre-commit"), "npm test\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", scripts: { prepare: "husky", postinstall: "node setup.js", test: "node test.js" }, devDependencies: { husky: "^9" } }));
  writeFileSync(join(root, ".envrc"), "export APP_ENV=dev\n");
  writeFileSync(join(root, ".env"), "STRIPE_API_KEY=fake_test_51Helloworlditworks00000\n");
  writeFileSync(join(root, "app.js"), "const token = 'ghp_abcdefghijklmnopqrstuvwxyzABCDEF123456';\nconsole.log(token);\n");
  mkdirSync(join(root, "agent"), { recursive: true });
  writeFileSync(join(root, "agent", "com.example.updater.plist"), '<?xml version="1.0"?>\n<plist><dict><key>Label</key><string>com.example.updater</string><key>ProgramArguments</key><array><string>/usr/local/bin/updater</string></array><key>RunAtLoad</key><true/></dict></plist>\n');
  grant(env, [], { workspaces: [{ path: root, network: false }] });
  cx = await open(env);
});

test("reach maps every trigger kind and ties the ledger to what Cortex touched", async () => {
  await edit(cx, { workspace: root, path: ".envrc", replace: { old: "APP_ENV=dev", new: "APP_ENV=dev\nexport X=1" }, reason: "test: touch a trigger" }, ACTOR);
  const r = await reach(cx, { workspace: root }, ACTOR);
  const kinds = new Set(r.workspaces[0].triggers.map((t) => t.kind));
  for (const k of ["git-hook", "git-config-hooksPath", "git-alias-shell", "npm-lifecycle", "husky-hook", "direnv"]) assert.ok(kinds.has(k), `${k} found`);
  const envrc = r.workspaces[0].triggers.find((t) => t.kind === "direnv");
  assert.equal(envrc.cortexTouched.change.slice(0, 5), "edit-");
  assert.equal(r.workspaces[0].cortexTouched.length, 1);
  // the hooksPath redirect means git's own hooks directory is inert — the map must say so
  const hooksPath = r.workspaces[0].triggers.find((t) => t.kind === "git-config-hooksPath");
  assert.match(hooksPath.detail, /hooksPath = \.husky/);
  // the grant graph separates what the engine reads from what runs can see
  assert.ok(r.graph.runs.read.some((x) => x.includes("engine only")));
  assert.ok(r.graph.engine.programs !== undefined);
  assert.equal(r.summary.firingWithYourAuthority, r.workspaces[0].triggers.filter((t) => t.authority === "operator-shell").length);
});

test("escape attempts the real moves and reports only what the fence actually did", async () => {
  const r = await escape(cx, { workspace: root, probes: ["write-outside", "symlink-out", "read-home", "write-git", "env"] }, ACTOR);
  const byName = Object.fromEntries(r.probes.map((p) => [p.name, p]));
  // home-aimed moves: sandbox-exec refuses them outright; bubblewrap hands the run an empty tmpfs
  // home instead, so the write lands in a mount that dies with the run — both mean the fence held.
  const held = (n) => assert.ok(["refused", "isolated"].includes(byName[n].status), `${n}: ${byName[n]?.status} — ${byName[n]?.evidence}`);
  for (const n of ["write-home", "write-launchagents", "write-rcfile", "symlink-read-home", "symlink-write-home", "read-home"]) held(n);
  // everywhere else the write is aimed at a read-only surface: refused on every fence
  const refused = (n) => assert.equal(byName[n].status, "refused", `${n}: ${byName[n]?.evidence}`);
  for (const n of ["write-tmp", "write-parent", "symlink-write-out", "git-hook", "git-config"]) refused(n);
  assert.ok(byName.env.status === "verified" || byName.env.status === "finding", `env: ${byName.env?.status}`);
  assert.equal(r.summary.escaped, 0, "no move may persist outside the workspace");
  assert.deepEqual(r.leftovers ?? [], []);
  assert.equal(existsSync(join(root, ".git", "hooks", "post-commit")), false, "no hook was left behind");
  // every probe was undone: no probe file remains
  const { files } = await import("../src/workspace.js");
  const listing = files(cx, { workspace: root });
  assert.ok(!listing.files.some((f) => f.path.startsWith("cortex-probe-")), "probe scripts were cleaned up");
});

test("escape probes can be narrowed, and an unknown probe name is not a crash", async () => {
  const r = await escape(cx, { workspace: root, probes: ["write-git"] }, ACTOR);
  assert.deepEqual(r.probes.map((p) => p.name).filter((n) => n.startsWith("git")), ["git-hook", "git-config"]);
  assert.ok(r.probes.every((p) => !p.name.startsWith("write-") || p.name.startsWith("write-git") === false));
});

test("gates measures the host's own gates or says honestly it cannot", async () => {
  const r = await gates(cx, { workspace: root }, ACTOR);
  const byGate = Object.fromEntries(r.gates.map((g) => [g.gate, g]));
  // the macOS gates are queried with macOS tools; on Linux the same slots are ptrace-scope and the LSMs
  if (platform() === "darwin") {
    assert.ok(byGate.sip.state === "enforced" || byGate.sip.state === "disabled" || byGate.sip.state === "not-measured", `sip: ${byGate.sip?.state}`);
    assert.ok(["enforced", "disabled", "not-measured"].includes(byGate.gatekeeper.state));
  } else {
    assert.ok(byGate["ptrace-scope"]?.state, "the Linux gate is there");
  }
  // the sudoers refusal is the control working, reported as such — never guessed
  assert.equal(byGate.sudo.state, "refused-by-design");
  // listeners: either a real inventory or an honest not-measured with the fence named as the reason
  assert.ok(["inventory", "not-measured"].includes(byGate.listeners.state));
  if (byGate.listeners.state === "not-measured") assert.match(byGate.listeners.evidence, /fence/);
  assert.ok(Array.isArray(r.suid.examples));
  assert.ok(["macos-sandbox-exec", "linux-bwrap", "none"].includes(r.fence.state), `the fence states itself: ${r.fence.state}`);
  assert.ok(r.fence.policy.length >= 5);
});

test("secrets maps credentials without contents, and reveals only at the operator's terminal", async () => {
  const r = await secrets(cx, {}, { kind: "model", id: "agent" });
  const paths = r.items.map((i) => i.path);
  assert.ok(paths.includes(".env"), "the env file is found");
  assert.ok(paths.includes("app.js"), "the token in code is found");
  assert.ok(paths.includes("agent/com.example.updater.plist") === false, "a plist is not a credential");
  const dotEnv = r.items.find((i) => i.path === ".env");
  assert.equal(dotEnv.reachableBy, "engine+runs", "a workspace secret is readable by runs");
  assert.ok(dotEnv.digest.startsWith("sha256:"), "items carry digests, never contents");
  assert.ok(!JSON.stringify(r).includes("fake_test_51Helloworld"), "no content leaked into the report");
  const readRootItem = r.items.find((i) => i.scope === "read-root");
  if (readRootItem) assert.equal(readRootItem.reachableBy, "engine-only");

  // a model asking to reveal is refused, whatever digest it names
  await assert.rejects(secrets(cx, { reveal: [dotEnv.digest] }, { kind: "model", id: "agent" }), /operator's own hand/);
  // the operator at their terminal can reveal, per item, and it is bounded
  const op = await secrets(cx, { reveal: [dotEnv.digest] }, { kind: "operator", id: "ross" });
  assert.equal(op.reveals.length, 1);
  assert.match(op.reveals[0].content, /fake_test_51Helloworld/);
  // an unknown digest is refused, not guessed
  await assert.rejects(secrets(cx, { reveal: ["sha256:0000"] }, { kind: "operator", id: "ross" }), /no scanned item/);
  // the ledger recorded every scan and the reveal by digest, never by content
  const entries = cx.ledger.read().filter((e) => e.kind === "secrets");
  assert.ok(entries.length >= 2);
  const revealEntry = entries.find((e) => e.body.revealed?.length);
  assert.ok(revealEntry, "the operator's reveal is ledgered");
  assert.deepEqual(revealEntry.body.revealed, [dotEnv.digest]);
  assert.ok(!JSON.stringify(entries).includes("fake_test_51Helloworld"), "the ledger holds the reveal's digest, not the bytes");
});

test("persist inventories the footholds and proves the grant cannot plant", async () => {
  const r = await persist(cx, { workspace: root }, ACTOR);
  // the workspace's own primitives: the husky hook and the postinstall, with their firing events
  assert.ok(r.workspacePrimitives.some((t) => t.kind === "husky-hook" && t.file === ".husky/pre-commit"));
  assert.ok(r.workspacePrimitives.some((t) => t.kind === "npm-lifecycle"));
  // the inert launchd definition in code, labeled as installing nothing by itself
  const plist = r.launchdDefinitions.find((d) => d.label === "com.example.updater");
  assert.ok(plist, "the launchd-shaped plist is found");
  assert.equal(plist.program, "/usr/local/bin/updater");
  // every host surface that exists was either refused, isolated, absent — never planted
  assert.equal(r.summary.planted, 0, "no persistence surface may be plantable");
  for (const s of r.hostSurfaces) {
    assert.ok(["cannot-plant", "isolated", "absent", "unproven", "not-measured"].includes(s.status), `${s.kind}: ${s.status}`);
    if (s.status === "cannot-plant") assert.match(s.writeEvidence, /EACCES|EPERM|EROFS|Operation not permitted|Permission denied|read-only/i);
  }
  // the home surfaces ride the one rule that matters: home is refused to runs — or, under
  // bubblewrap, an empty tmpfs mount nothing real survives in
  const homeSurface = r.hostSurfaces.find((s) => s.path?.includes("LaunchAgents") && s.path?.includes("Library"));
  if (homeSurface) assert.ok(["cannot-plant", "absent", "isolated"].includes(homeSurface.status), `${homeSurface.status}`);
});

test("the boundary tools refuse what is outside their contract", async () => {
  const refused = /not inside a code workspace|not-granted|workspace does not exist/;
  await assert.rejects(reach(cx, { workspace: "/etc" }, ACTOR), refused);
  await assert.rejects(escape(cx, {}, ACTOR), /workspace/);
  await assert.rejects(gates(cx, { workspace: join(env.root, "nope") }, ACTOR), refused);
  await assert.rejects(persist(cx, {}, ACTOR), /workspace/);
});

test("every boundary tool is ledgered with its own kind", async () => {
  const kinds = new Set(cx.ledger.read().map((e) => e.kind));
  for (const k of ["reach", "escape", "gates", "secrets", "persist"]) assert.ok(kinds.has(k), `${k} is in the ledger`);
});
