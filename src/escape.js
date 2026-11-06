// Escape: the fence verified from inside. Every claim Cortex makes about its sandbox — writes stay
// in the workspace, home is unreadable, no network unless granted, a minimal environment, no hook
// or git-config command survives a run — is a claim about enforcement, and enforcement is proved by
// attempting the real moves, not by restating the configuration. This battery writes probe programs
// into a granted workspace through the reversible edit machinery, drives each one once through
// context_run, and reads the fence's answer: refused, isolated (it happened inside a mount that died
// with the run and nothing persisted), or escaped — a fence that did not hold, reported loudly.
// Every probe is undone; every attempt is ledgered. Verified means these moves were refused or
// contained on this host, never that the fence is complete.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { grantedWorkspace } from "./grant.js";
import { detectSandbox } from "./sandbox.js";
import { edit, run, undo } from "./workspace.js";
import { isObject, now, Refusal, requireString } from "./util.js";

const NODE = process.execPath;
const REFUSED = /EACCES|EPERM|EROFS|Operation not permitted|Permission denied|read-only file system/i;
const ABSENT = /ENOENT|No such file or directory|ENOTDIR|EISDIR/;
const NO_ROUTE = /ENETUNREACH|ETIMEDOUT|EHOSTUNREACH|ENETDOWN|ECONNREFUSED/;
const EXPECTED_ENV = new Set(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "CORTEX_CPU", "CORTEX_FSIZE"]);

/** Stage one probe program inside the workspace (a reversible edit), run it once under the node it
 *  will really face, and undo everything the drive changed and the probe itself. The probe reads
 *  its parameters from argv[2] as JSON and prints one JSON object — its own account of what the
 *  fence did to each move. Shared with context_persist and context_gates. */
export async function driveProbe(cx, ws, { name, body, args = [], timeoutMs }, actor) {
  const path = `cortex-probe-${name}.js`;
  const created = await edit(cx, { workspace: ws.root, path, content: body, create: true, reason: `probe ${name} (escape/persist/gates battery)` }, actor);
  let r = null;
  let error = null;
  try {
    r = await run(cx, { workspace: ws.root, program: NODE, args: [path, JSON.stringify(args ?? [])], timeoutMs: timeoutMs ?? cx.grant.limits.timeoutMs }, actor);
  } catch (e) {
    error = `${e instanceof Refusal ? e.message : e.message}`;
  }
  if (r?.change) await undo(cx, { change: r.change }, actor).catch(() => {});
  await undo(cx, { change: created.change }, actor).catch(() => {});
  let out = null;
  if (r) {
    try {
      out = JSON.parse(String(r.stdout ?? ""));
    } catch {
      out = null;
    }
  }
  return { r, out, error };
}

const tail = (s, n = 300) => String(s ?? "").slice(-n);

/** Classify one attempted outside-workspace write or read from the probe's account, and what
 *  actually persisted: a move the fence refused is verified; a move that happened but left nothing
 *  on the host was isolated inside the sandbox's own mounts; a move that persisted is an escape.
 *  Shared with context_persist, whose refused-write trials prove the grant cannot plant. */
export function classifyMove(move, hostPath, label) {
  if (!move) return { status: "unproven", evidence: "the probe gave no account of this move" };
  if (move.ok) {
    if (hostPath && existsSync(hostPath)) {
      return { status: "escaped", evidence: `${label} succeeded and persisted at ${hostPath}` };
    }
    return {
      status: "isolated",
      evidence: `${label} was attempted and reported success inside the fence, but nothing persisted on the host${hostPath ? ` (no ${hostPath} after the run)` : ""} — it landed in a mount that died with the run`,
    };
  }
  const err = String(move.error ?? "");
  if (REFUSED.test(err)) return { status: "refused", evidence: `${label} was refused: ${tail(err)}` };
  if (ABSENT.test(err)) return { status: "isolated", evidence: `${label} met a path that does not exist inside the fence: ${tail(err)}` };
  return { status: "unproven", evidence: `${label} failed in an unrecognized way: ${tail(err)}` };
}

// ───────────────────────────── the probes ─────────────────────────────

// Each probe body is plain JavaScript run under the sandboxed node. No template literals inside:
// the bodies are themselves template literals here.
const PROBE_WRITE_OUTSIDE = `
const fs = require("fs");
const path = require("path");
const args = JSON.parse(process.argv[2]);
const one = (label, target) => {
  try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch (e) { return { target, ok: false, error: String(e) }; }
  try { fs.writeFileSync(target, "cortex escape probe\\n"); return { target, ok: true }; }
  catch (e) { return { target, ok: false, error: String(e && e.message ? e.message : e) }; }
};
const out = {
  home: one("home", args.home),
  launchagents: one("launchagents", args.launchagents),
  rcfile: one("rcfile", args.rcfile),
  tmp: one("tmp", args.tmp),
  parent: one("parent", path.resolve("..", args.marker)),
};
process.stdout.write(JSON.stringify(out));
`;

const PROBE_SYMLINK = `
const fs = require("fs");
const path = require("path");
const args = JSON.parse(process.argv[2]);
const out = {};
const made = [];
for (const [name, target] of [["link-home", args.homeFile], ["link-out", path.resolve("..", args.marker)]]) {
  try { fs.symlinkSync(target, name); made.push(name); out["make-" + name] = { ok: true, target }; }
  catch (e) { out["make-" + name] = { ok: false, error: String(e && e.message ? e.message : e) }; }
}
const read = (name) => {
  try { const b = fs.readFileSync(name); return { ok: true, bytes: b.length }; }
  catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
};
const write = (name) => {
  try { fs.writeFileSync(name, "probe\\n"); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
};
out["read-link-home"] = read("link-home");
out["write-link-home"] = write("link-home");
out["write-link-out"] = write("link-out");
for (const name of made) { try { fs.unlinkSync(name); } catch (e) {} }
process.stdout.write(JSON.stringify(out));
`;

const PROBE_READ_HOME = `
const fs = require("fs");
const args = JSON.parse(process.argv[2]);
const out = {};
try {
  out["list-home-root"] = { ok: true, entries: fs.readdirSync(args.homeRoot).slice(0, 50) };
} catch (e) { out["list-home-root"] = { ok: false, error: String(e && e.message ? e.message : e) }; }
const read = (label, target) => {
  try { const b = fs.readFileSync(target); return { ok: true, bytes: b.length }; }
  catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
};
out["read-home-file"] = read("read-home-file", args.homeFile);
out["read-home-dir"] = (() => {
  try { return { ok: true, entries: fs.readdirSync(args.homeDir).slice(0, 50) }; }
  catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
})();
process.stdout.write(JSON.stringify(out));
`;

const PROBE_WRITE_GIT = `
const fs = require("fs");
const args = JSON.parse(process.argv[2]);
const out = {};
const hook = ".git/hooks/" + args.hook;
try { fs.mkdirSync(".git/hooks", { recursive: true }); } catch (e) { out["mkdir"] = { ok: false, error: String(e && e.message ? e.message : e) }; }
try { fs.writeFileSync(hook, "# cortex escape probe\\n"); out["write-hook"] = { ok: true, path: hook }; }
catch (e) { out["write-hook"] = { ok: false, error: String(e && e.message ? e.message : e) }; }
try { fs.appendFileSync(".git/config", "# cortex escape probe\\n"); out["write-config"] = { ok: true }; }
catch (e) { out["write-config"] = { ok: false, error: String(e && e.message ? e.message : e) }; }
process.stdout.write(JSON.stringify(out));
`;

const PROBE_NETWORK = `
const net = require("net");
const args = JSON.parse(process.argv[2]);
const out = {};
const loopback = (done) => {
  const server = net.createServer();
  server.once("error", (e) => { out["loopback"] = { ok: false, error: String(e && e.message ? e.message : e) }; done(); });
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => { out["loopback"] = { ok: true }; socket.destroy(); server.close(done); });
    socket.once("error", (e) => { out["loopback"] = { ok: false, error: String(e && e.message ? e.message : e) }; server.close(done); });
  });
};
loopback(() => {
  const socket = net.connect({ host: args.testNet, port: 80 });
  const finish = (record) => { out["outward"] = record; socket.destroy(); process.stdout.write(JSON.stringify(out)); };
  socket.setTimeout(args.timeoutMs, () => finish({ ok: false, error: "ETIMEDOUT: connect " + args.testNet + " timed out" }));
  socket.once("connect", () => finish({ ok: true }));
  socket.once("error", (e) => finish({ ok: false, error: String(e && e.message ? e.message : e) }));
});
`;

// The probe reports its own environment and, separately, what a fresh process actually receives:
// it execs /usr/bin/env with exactly the minimal fixed set, and any name the child also shows
// crossed the fence, while a name only the probe's own process.env has was re-added by the probe
// runtime itself (macOS CoreFoundation does this with __CF_USER_TEXT_ENCODING in every process
// that links it) after the fence had already passed a clean environment.
const PROBE_ENV = `
const { spawnSync } = require("child_process");
const args = JSON.parse(process.argv[2]);
const own = Object.keys(process.env).sort();
const minimal = {};
for (const k of args.expected) minimal[k] = String(process.env[k] ?? "");
const child = spawnSync("/usr/bin/env", { env: minimal });
const passed = child.status === 0 ? String(child.stdout).split("\\n").map((l) => l.split("=")[0]).filter(Boolean).sort() : null;
process.stdout.write(JSON.stringify({
  own,
  passed,
  homeInside: process.env.HOME,
  homeIsRealHome: process.env.HOME === args.realHome,
}));
`;

const PROBE_CHILD = `
const { spawn } = require("child_process");
const fs = require("fs");
const args = JSON.parse(process.argv[2]);
const child = spawn(process.execPath, ["-e", "setTimeout(function () { try { require('fs').writeFileSync(" + JSON.stringify(args.late) + ", 'late'); } catch (e) {} }, " + args.delayMs + ")"], { detached: true, stdio: "ignore" });
child.unref();
process.stdout.write(JSON.stringify({ spawned: true }));
`;

// ───────────────────────── the engine-side policy checks ─────────────────────────

/** The guarantees the engine's own machinery gives, verified by attempting to break them: edits
 *  never touch .git, never escape the workspace, and never overwrite a file that changed since it
 *  was read. Each refusal is the proof. */
async function policyChecks(cx, ws, actor) {
  const results = [];
  try {
    await edit(cx, { workspace: ws.root, path: ".git/config", content: "probe\n", reason: "probe: .git must be refused" }, actor);
    results.push({ name: "edit-refuses-git", status: "escaped", evidence: "an edit of .git/config was accepted" });
  } catch (e) {
    results.push({ name: "edit-refuses-git", status: "verified", evidence: `refused: ${tail(e.message, 120)}` });
  }
  try {
    await edit(cx, { workspace: ws.root, path: "../escape-probe-out.txt", content: "probe\n", reason: "probe: escaping paths must be refused" }, actor);
    results.push({ name: "edit-refuses-escape", status: "escaped", evidence: "an edit outside the workspace was accepted" });
  } catch (e) {
    results.push({ name: "edit-refuses-escape", status: "verified", evidence: `refused: ${tail(e.message, 120)}` });
  }
  const victim = await edit(cx, { workspace: ws.root, path: "cortex-probe-digest-guard.txt", content: "original\n", create: true, reason: "probe: digest guard" }, actor);
  try {
    await edit(cx, { workspace: ws.root, path: "cortex-probe-digest-guard.txt", content: "raced\n", expectDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000", reason: "probe: a stale digest must be refused" }, actor);
    results.push({ name: "edit-refuses-stale-digest", status: "escaped", evidence: "an edit with a stale expectDigest was accepted" });
  } catch (e) {
    results.push({ name: "edit-refuses-stale-digest", status: "verified", evidence: `refused: ${tail(e.message, 120)}` });
  }
  await undo(cx, { change: victim.change }, actor).catch(() => {});
  return results;
}

// ───────────────────────────── the battery ─────────────────────────────

const WAIT_FOR_LATE_WRITE_MS = 2600;

/** Wait for a detached child's late write, then look for the marker inside the workspace. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A filter may name a probe group (write-outside, symlink-out, write-git) or any single record it
// produces (write-home, git-hook, …); both select it.
const PROBE_GROUP = {
  "write-home": "write-outside", "write-launchagents": "write-outside", "write-rcfile": "write-outside", "write-tmp": "write-outside", "write-parent": "write-outside",
  "write-home-cleanup": "write-outside", "write-launchagents-cleanup": "write-outside", "write-rcfile-cleanup": "write-outside", "write-tmp-cleanup": "write-outside", "write-parent-cleanup": "write-outside",
  "symlink-read-home": "symlink-out", "symlink-write-home": "symlink-out", "symlink-write-out": "symlink-out",
  "git-hook": "write-git", "git-config": "write-git",
};

export async function escape(cx, req, actor) {
  if (!isObject(req)) throw new Refusal("bad-request", "escape takes an object");
  const ws = grantedWorkspace(cx.grant, requireString(req.workspace, "workspace"));
  const filter = Array.isArray(req.probes) ? new Set(req.probes.map(String)) : null;
  const home = homedir();
  const homeRoot = home.split("/").slice(0, 2).join("/");
  const seq = Math.floor(Math.random() * 1e9);
  const marker = `cortex-escape-${seq}.txt`;
  const only = (name) => !filter || filter.has(name) || filter.has(PROBE_GROUP[name] ?? name);
  const results = [];

  const record = (name, status, evidence, extra = {}) => {
    if (!only(name)) return;
    results.push({ name, status, evidence, ...extra });
  };

  // 1. writes aimed outside the workspace: the home directory, its LaunchAgents directory (where
  //    launchd loads user agents at login — a plant there is persistence), an rc file's neighbour
  //    (the fence's uniform home-write rule covers the rc files themselves; the probe writes beside
  //    them so a broken fence could never corrupt a real one), /tmp, and the workspace's parent.
  if (only("write-outside")) {
    const { r, out, error } = await driveProbe(cx, ws, {
      name: "write-outside",
      body: PROBE_WRITE_OUTSIDE,
      args: {
        home: join(home, marker),
        launchagents: join(home, "Library", "LaunchAgents", `com.cortex-escape-${seq}.plist`),
        rcfile: join(home, `.zshrc-${marker}`),
        tmp: `/tmp/${marker}`,
        marker,
      },
    }, actor);
    if (!r) record("write-outside", "unproven", `the probe could not run: ${tail(error)}`);
    else if (!out) record("write-outside", "unproven", `the probe returned no account (exit ${r.exitCode}): ${tail(r.stderr)}`);
    else {
      for (const [k, hostPath, label] of [
        ["home", join(home, marker), "the home directory"],
        ["launchagents", join(home, "Library", "LaunchAgents", `com.cortex-escape-${seq}.plist`), "the LaunchAgents directory (launchd loads a plant there at login)"],
        ["rcfile", join(home, `.zshrc-${marker}`), "beside the shell rc files (the same deny rule covers .zshrc itself)"],
        ["tmp", `/tmp/${marker}`, "/tmp"],
        ["parent", join(ws.root, "..", marker), "the workspace's parent"],
      ]) {
        const c = classifyMove(out[k], hostPath, `a write to ${label}`);
        record(`write-${k}`, c.status, c.evidence);
        if (c.status === "escaped") {
          record(`write-${k}-cleanup`, "finding", `the escaped marker is at ${hostPath}; remove it`, { escaped: true });
        }
      }
    }
  }

  // 2. symlinks planted inside the workspace, aimed out: read and write through them.
  if (only("symlink-out")) {
    const { r, out, error } = await driveProbe(cx, ws, {
      name: "symlink-out",
      body: PROBE_SYMLINK,
      args: { homeFile: join(home, ".zshenv"), marker },
    }, actor);
    if (!r) record("symlink-out", "unproven", `the probe could not run: ${tail(error)}`);
    else if (!out) record("symlink-out", "unproven", `the probe returned no account (exit ${r.exitCode}): ${tail(r.stderr)}`);
    else {
      const c1 = classifyMove(out["read-link-home"], null, "a read through a workspace symlink aimed at a home file");
      record("symlink-read-home", c1.status, c1.evidence, out["read-link-home"]?.ok ? { escaped: true } : {});
      const c2 = classifyMove(out["write-link-home"], null, "a write through a workspace symlink aimed at a home file");
      record("symlink-write-home", c2.status, c2.evidence, out["write-link-home"]?.ok ? { escaped: true } : {});
      const c3 = classifyMove(out["write-link-out"], join(ws.root, "..", marker), "a write through a workspace symlink aimed outside");
      record("symlink-write-out", c3.status, c3.evidence, c3.status === "escaped" ? { escaped: true } : {});
    }
  }

  // 3. reads aimed at the home directory: the fence must keep home invisible to runs.
  if (only("read-home")) {
    const { r, out, error } = await driveProbe(cx, ws, {
      name: "read-home",
      body: PROBE_READ_HOME,
      args: { homeRoot, homeFile: join(home, ".zshenv"), homeDir: home },
    }, actor);
    if (!r) record("read-home", "unproven", `the probe could not run: ${tail(error)}`);
    else if (!out) record("read-home", "unproven", `the probe returned no account (exit ${r.exitCode}): ${tail(r.stderr)}`);
    else {
      const listing = out["list-home-root"];
      const file = out["read-home-file"];
      const dir = out["read-home-dir"];
      if (file?.ok || dir?.ok === true) {
        record("read-home", "escaped", `the home directory is readable inside the fence: a home file read returned ${file?.ok ? `${file.bytes} bytes` : "a listing"}`);
      } else if (REFUSED.test(String(file?.error ?? "")) || REFUSED.test(String(listing?.error ?? ""))) {
        record("read-home", "refused", `home reads are refused: ${tail(file?.error ?? listing?.error)}`);
      } else if (dir?.ok === false && ABSENT.test(String(dir?.error ?? "")) && (!listing?.ok || !listing.entries?.length)) {
        record("read-home", "isolated", "the home directory does not exist inside the fence (an isolated, empty mount): nothing of it is reachable");
      } else if (dir?.ok === false && dir?.error && REFUSED.test(String(dir.error))) {
        record("read-home", "refused", `home reads are refused: ${tail(dir.error)}`);
      } else {
        record("read-home", "unproven", `the probe could not decide: ${tail(JSON.stringify(out))}`);
      }
    }
  }

  // 4. writes aimed at .git: a hook or git-config command a run plants fires with your unsandboxed
  //    authority on the next git operation, so the fence must refuse it and the guard must remove it.
  if (only("write-git")) {
    const { r, out, error } = await driveProbe(cx, ws, {
      name: "write-git",
      body: PROBE_WRITE_GIT,
      args: { hook: "post-commit" },
    }, actor);
    if (!r) record("write-git", "unproven", `the probe could not run: ${tail(error)}`);
    else if (!out) record("write-git", "unproven", `the probe returned no account (exit ${r.exitCode}): ${tail(r.stderr)}`);
    else {
      const guarded = (r.gitGuarded ?? []).map((g) => `${g.path} (${g.action})`);
      const hookAfter = existsSync(join(ws.root, ".git", "hooks", "post-commit"));
      const hookWrite = out["write-hook"];
      const configWrite = out["write-config"];
      for (const [name, move, after] of [["git-hook", hookWrite, hookAfter], ["git-config", configWrite, false]]) {
        if (!move) { record(name, "unproven", "the probe gave no account of this move"); continue; }
        if (!move.ok && REFUSED.test(String(move.error))) {
          record(name, "refused", `the fence refused the write: ${tail(move.error)}`);
        } else if (move.ok && guarded.length && (name === "git-hook" || name === "git-config")) {
          record(name, "reverted", `the write happened in-run and the engine put .git back: ${guarded.join(", ")}`);
        } else if (move.ok && name === "git-hook" && after) {
          record(name, "escaped", "the run left a hook behind in .git/hooks — a fence that must never allow this");
        } else if (move.ok && name === "git-config") {
          record(name, "unproven", "the config write was accepted; the engine did not report restoring it");
        } else {
          record(name, "unproven", `unrecognized outcome: ${tail(JSON.stringify(move))}`);
        }
      }
    }
  }

  // 5. network: loopback and an outward connection, classified against what the workspace was granted.
  if (only("network")) {
    const { r, out, error } = await driveProbe(cx, ws, {
      name: "network",
      body: PROBE_NETWORK,
      args: { testNet: "192.0.2.1", timeoutMs: 1000 },
    }, actor);
    if (ws.network) {
      record("network", "by-grant", "this workspace holds the operator's network grant; socket use inside the fence is authorised, and real outward reachability is not measured by this probe (the test address never answers)");
    } else if (!r) record("network", "unproven", `the probe could not run: ${tail(error)}`);
    else if (!out) record("network", "unproven", `the probe returned no account (exit ${r.exitCode}): ${tail(r.stderr)}`);
    else {
      const outward = out["outward"];
      const loopback = out["loopback"];
      if (outward?.ok) {
        record("network", "escaped", "an outward connection attempt succeeded although this workspace was not granted network");
      } else if (REFUSED.test(String(outward?.error ?? ""))) {
        record("network", "refused", `the fence refused sockets outright: ${tail(outward.error)}${loopback?.ok === false ? `; loopback too: ${tail(loopback.error)}` : ""}`);
      } else if (NO_ROUTE.test(String(outward?.error ?? "")) && loopback?.ok) {
        record("network", "isolated", "sockets work only inside an isolated network namespace: loopback answers, and there is no route outward to the host or the internet");
      } else if (NO_ROUTE.test(String(outward?.error ?? "")) && loopback?.ok === false) {
        record("network", "refused", `no sockets at all: ${tail(loopback?.error ?? outward?.error)}`);
      } else {
        record("network", "unproven", `the probe could not decide: ${tail(JSON.stringify(out))}`);
      }
    }
  }

  // 6. the environment every run inherits: names only, never values. A name counts as crossed only
  //    when a fresh process exec'd with the minimal set receives it too; a name only the probe's own
  //    process.env has was re-added by the probe's own runtime (CoreFoundation does this on macOS)
  //    after the fence had passed a clean environment.
  if (only("env")) {
    const { r, out, error } = await driveProbe(cx, ws, {
      name: "env",
      body: PROBE_ENV,
      args: { realHome: home, expected: [...EXPECTED_ENV] },
    }, actor);
    if (!r) record("env", "unproven", `the probe could not run: ${tail(error)}`);
    else if (!out) record("env", "unproven", `the probe returned no account (exit ${r.exitCode}): ${tail(r.stderr)}`);
    else {
      const own = out.own ?? [];
      const passed = out.passed;
      const extraOwn = own.filter((n) => !EXPECTED_ENV.has(n));
      const extraPassed = passed ? passed.filter((n) => !EXPECTED_ENV.has(n)) : null;
      if (out.homeIsRealHome) {
        record("env", "escaped", "runs see the real home directory through HOME");
      } else if (extraPassed === null) {
        record("env", "unproven", "the probe could not exec a clean child to compare what the fence passes: names from the probe's own runtime could not be told apart from inherited ones");
      } else if (extraPassed.length) {
        record("env", "finding", `${extraPassed.length} environment variable(s) cross the fence beyond the minimal fixed set: ${extraPassed.join(", ")} — names only; values were never read`);
      } else if (extraOwn.length) {
        record("env", "verified", `the fence passes exactly the minimal fixed set (${EXPECTED_ENV.size} variables; a clean exec of /usr/bin/env under it received nothing else), and HOME points at the per-run work directory; ${extraOwn.join(", ")} appears only inside the probe's own process and is re-added by its runtime after the fence — names only, values never read`);
      } else {
        record("env", "verified", `the environment is the minimal fixed set (${EXPECTED_ENV.size} variables); HOME points at the per-run work directory, not the real home`);
      }
    }
  }

  // 7. a child that outlives its run: if one can write inside the workspace after the run was
  //    accounted, that write is outside the ledger's change set — an accounting gap to know about.
  if (only("child-afterlife")) {
    const late = `cortex-escape-late-${seq}.txt`;
    const { r, out, error } = await driveProbe(cx, ws, {
      name: "child",
      body: PROBE_CHILD,
      args: { late, delayMs: 1500 },
    }, actor);
    if (!r) record("child-afterlife", "unproven", `the probe could not run: ${tail(error)}`);
    else {
      await sleep(WAIT_FOR_LATE_WRITE_MS);
      const latePath = join(ws.root, late);
      if (existsSync(latePath)) {
        record("child-afterlife", "finding", "a detached child process outlived the run and wrote inside the workspace after the run's change set was taken; the write stayed inside the workspace (the grant already covers it) but is outside the run's ledgered accounting. The marker was removed.");
        await edit(cx, { workspace: ws.root, path: late, delete: true, reason: "probe cleanup: the late-write marker" }, actor).catch(() => {});
      } else {
        record("child-afterlife", "verified", "no child outlived the run: nothing appeared in the workspace after the run was accounted");
      }
    }
  }

  for (const p of await policyChecks(cx, ws, actor)) {
    if (only(p.name)) results.push(p);
  }

  // Nothing the battery touched may be left behind.
  const leftovers = [];
  try {
    for (const e of readdirSync(ws.root)) {
      if (e.startsWith("cortex-probe-") || e.startsWith("cortex-escape-")) leftovers.push(e);
    }
  } catch {
    /* unreadable */
  }

  const summary = {
    verified: results.filter((x) => ["verified", "refused", "isolated", "reverted"].includes(x.status)).length,
    findings: results.filter((x) => ["finding", "by-grant"].includes(x.status)).length,
    escaped: results.filter((x) => x.status === "escaped").length,
    unproven: results.filter((x) => x.status === "unproven").length,
  };
  cx.ledger.append("escape", {
    workspace: ws.root, at: now(), ...summary,
    probes: results.map((x) => `${x.name}: ${x.status}`),
    by: actor,
  });
  return {
    workspace: ws.root,
    at: now(),
    sandbox: (await detectSandbox()).kind,
    probes: results,
    summary,
    ...(leftovers.length ? { leftovers, leftoverNote: "probe files still in the workspace (the undo of a probe was refused); they are plain inert scripts and safe to delete" } : {}),
    coverage: {
      battery: results.map((x) => x.name),
      method: "each probe is a real program written into the workspace, run once under the same sandbox every context_run faces, and undone; classifications read the fence's own refusals and what actually persisted on the host",
      note: "verified means these moves were refused, contained or reverted on this host at this moment — never that the fence is complete against every technique; unproven says why it could not decide",
      ...(ws.network ? { network: "the workspace holds the operator's network grant, so network containment was not tested here" } : {}),
    },
  };
}
