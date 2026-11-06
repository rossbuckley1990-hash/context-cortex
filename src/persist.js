// Persist: what already has a foothold on this machine, and proof that this grant cannot take one.
// Persistence is the dividing line between an incident and a compromise: code that runs once is
// contained, code that runs at every login is a foothold. This tool walks both sides. First the
// inventory: the auto-execution primitives inside the granted workspaces (the ones reach classifies
// by who consents), and launchd-agent-shaped definitions lying inert in code. Then the proof: every
// standard host persistence surface — the directories launchd, cron, autostart and the shells read
// at login — is driven with a real write from inside the fence, and the answer is recorded: refused
// (the grant cannot plant here — proven by the fence's own refusal), isolated (the write landed in
// a mount that died with the run and nothing touched the host), or planted — a critical finding,
// because that is a foothold this engine could take. Surfaces the fence lets a run read are also
// listed, so the owner sees what already has a foothold; surfaces it refuses stay invisible and
// say so. Nothing here is measured by being believed; every claim is a trial in the ledger.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { grantedWorkspace } from "./grant.js";
import { driveProbe, classifyMove } from "./escape.js";
import { scanTriggers } from "./reach.js";
import { run, undo } from "./workspace.js";
import { isObject, now, Refusal, requireString } from "./util.js";

const DRIVE_MAX = 6;
const DRIVE_TIMEOUT_MS = 12_000;

const tail = (s, n = 300) => String(s ?? "").slice(-n);

/** The persistence surfaces of the host, per platform. Each names what fires it, who installs it
 *  legitimately, and what it means that this grant cannot write there. */
function surfaces() {
  const home = homedir();
  if (platform() === "darwin") {
    return [
      { path: join(home, "Library", "LaunchAgents"), kind: "launchd-user-agents", fires: "launchd loads every plist here at your login", owner: "you (or an installer running as you)", note: "the whole home directory is refused to runs (context_escape), so every surface under it — LaunchAgents, login items, shell rc files, browser profiles — is unreachable to this grant in one rule" },
      { path: "/Library/LaunchAgents", kind: "launchd-system-agents", fires: "launchd loads every plist here at any user's login", owner: "an admin (sudo)", note: "writable only by root on a healthy host; the fence refuses writes to every non-granted path regardless" },
      { path: "/Library/LaunchDaemons", kind: "launchd-system-daemons", fires: "launchd loads every plist here at boot", owner: "an admin (sudo)", note: "the highest-value persistence on the machine" },
      { path: "/etc/periodic/daily", kind: "periodic-daily", fires: "launchd runs every script here once a day", owner: "an admin (sudo)", note: "" },
      { path: "/etc/periodic/weekly", kind: "periodic-weekly", fires: "launchd runs every script here weekly", owner: "an admin (sudo)", note: "" },
      { path: "/etc/periodic/monthly", kind: "periodic-monthly", fires: "launchd runs every script here monthly", owner: "an admin (sudo)", note: "" },
      { path: "/var/at/tabs", kind: "cron-spool", fires: "cron runs the user crontabs stored here on their schedule", owner: "the OS's own SUID crontab tool", note: "root-only to read; the engine runs no SUID binary, so what is inside stays unknown from here" },
      { path: join(home, ".config"), kind: "home-dotconfig", fires: "the shell and many tools source files under here at startup", owner: "you", note: "the home write-refusal covers the rc files themselves" },
    ];
  }
  if (platform() === "linux") {
    return [
      { path: join(home, ".config/autostart"), kind: "xdg-autostart-user", fires: "the desktop runs every .desktop here at your login", owner: "you", note: "under the home directory" },
      { path: "/etc/xdg/autostart", kind: "xdg-autostart-system", fires: "the desktop runs every .desktop here at any user's login", owner: "a distro package or an admin" },
      { path: "/etc/systemd/system", kind: "systemd-system", fires: "systemd loads every unit here at boot or on demand", owner: "root" },
      { path: join(home, ".config/systemd/user"), kind: "systemd-user", fires: "systemd loads every user unit here at your login", owner: "you", note: "under the home directory" },
      { path: "/etc/cron.d", kind: "cron-d", fires: "cron runs every crontab here on its schedule", owner: "root" },
      { path: "/etc/rc.local", kind: "rc-local", fires: "at boot, init runs this script if it exists", owner: "root", file: true },
      { path: join(home, ".local/bin"), kind: "user-bin", fires: "nothing fires by itself — but anything planted here is on PATH and so a keystroke away from running", owner: "you", note: "under the home directory" },
    ];
  }
  return [];
}

const PROBE_PERSIST = `
const fs = require("fs");
const path = require("path");
const args = JSON.parse(process.argv[2]);
const out = {};
for (const p of args.paths) {
  const rec = {};
  let dir = p.path;
  try {
    const st = fs.statSync(p.path);
    rec.exists = true;
    if (st.isDirectory()) rec.read = { ok: true, names: fs.readdirSync(p.path).slice(0, 30) };
    else { rec.read = { ok: true, file: true }; dir = path.dirname(p.path); }
  } catch (e) { rec.exists = false; rec.read = { ok: false, error: String(e && e.message ? e.message : e) }; }
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const target = dir + "/" + args.marker;
  try { fs.writeFileSync(target, "cortex persist probe\\n"); rec.write = { ok: true, target }; }
  catch (e) { rec.write = { ok: false, error: String(e && e.message ? e.message : e) }; }
  rec.writeDir = dir;
  out[p.path] = rec;
}
process.stdout.write(JSON.stringify(out));
`;

/** launchd-agent-shaped plists sitting in a granted workspace: inert until an operator installs
 *  them, and exactly what a run must never be able to install for itself. */
function launchdDefinitions(cx, ws) {
  const found = [];
  const walk = (relDir, depth) => {
    let entries;
    try {
      entries = readdirSync(join(ws.root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (depth > 3 || found.length >= 20) continue;
      if (e.isDirectory()) { if (!e.name.startsWith(".") && e.name !== "node_modules") walk(join(relDir, e.name), depth + 1); continue; }
      if (!e.name.endsWith(".plist") && !e.name.endsWith(".launchd")) continue;
      let text;
      try {
        const st = statSync(join(ws.root, relDir, e.name));
        if (st.size > 64 * 1024) continue;
        text = readFileSync(join(ws.root, relDir, e.name), "utf8");
      } catch { continue; }
      if (/<key>Label<\/key>/i.test(text) && /<key>Program(?:Arguments)?<\/key>/i.test(text)) {
        const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/i.exec(text)?.[1] ?? "(unparsed)";
        const program = /<key>Program(?:Arguments)?<\/key>\s*(?:<string>([^<]+)<\/string>|[\s\S]*?<string>([^<]+)<\/string>)/i.exec(text)?.slice(1).find(Boolean) ?? "(unparsed)";
        found.push({ file: join(relDir, e.name), label, program, fires: "nothing, until an operator installs it into a LaunchAgents directory — then at login", owner: "whoever installs it" });
      }
    }
  };
  walk(".", 0);
  return found;
}

/** Prove what each workspace primitive actually is: its code, executed once, sandboxed, the way
 *  its real mechanism would — npm runs the script line through the shell, git execs the hook file,
 *  direnv sources the file. Only the exit status and output size are recorded: a trigger's output
 *  is untrusted and never copied into a report. What this proves is that the code runs; the firing
 *  event itself (your install, your commit) is what runs it unsandboxed with your authority. */
async function driveTriggers(cx, ws, triggers, actor) {
  const out = [];
  for (const t of triggers.slice(0, DRIVE_MAX)) {
    const base = { kind: t.kind, file: t.file, fires: t.fires, authority: t.authority, ...(t.controlledBy ? { controlledBy: t.controlledBy } : {}) };
    let program, args;
    if (t.kind === "npm-lifecycle") {
      const m = /^scripts\.([\w-]+) = ([\s\S]*)$/.exec(t.detail ?? "");
      if (!m) { out.push({ ...base, driven: { status: "not-driven", reason: "the script line could not be read" } }); continue; }
      program = "/bin/sh"; args = ["-c", m[2]];
    } else if (t.kind === "git-hook" || t.kind === "husky-hook") {
      const abs = join(ws.root, t.file);
      let st = null;
      try { st = statSync(abs); } catch { /* absent */ }
      if (!st?.isFile()) { out.push({ ...base, driven: { status: "not-driven", reason: "the hook file is not present" } }); continue; }
      const executable = !!(st.mode & 0o111);
      program = executable ? abs : "/bin/sh";
      args = executable ? [] : [abs];
    } else if (t.kind === "direnv") {
      program = "/bin/sh"; args = [join(ws.root, t.file)];
    } else {
      out.push({ ...base, driven: { status: "not-driven", reason: "not shell code: its runner (an IDE, a CI service) is not present here, so the mechanism cannot be driven honestly" } });
      continue;
    }
    try {
      const r = await run(cx, { workspace: ws.root, program, args, timeoutMs: DRIVE_TIMEOUT_MS }, actor);
      // what the driven trigger's code changed in the workspace is undone, like every probe drive
      if (r?.change) await undo(cx, { change: r.change }, actor).catch(() => {});
      const note = r.exitCode === 0
        ? `the code executed to completion (exit 0${r.stdout?.length ? `, ${r.stdout.length} bytes of output, not reproduced here: a trigger's output is untrusted` : ""}). On the real event ("${t.fires}") the same code runs unsandboxed with your authority`
        : `the code executed (exit ${r.exitCode} — its own behavior here, possibly expecting the real event's environment). On the real event ("${t.fires}") the same code runs unsandboxed with your authority`;
      out.push({ ...base, driven: { status: r.exitCode === 0 ? "executed" : "executed-nonzero", exitCode: r.exitCode, note } });
    } catch (e) {
      out.push({ ...base, driven: { status: "not-driven", reason: `the drive was refused: ${tail(String(e?.message ?? e), 140)}` } });
    }
  }
  return out;
}

export async function persist(cx, req, actor) {
  if (!isObject(req)) throw new Refusal("bad-request", "persist takes an object");
  const ws = grantedWorkspace(cx.grant, requireString(req.workspace, "workspace"));
  const home = homedir();
  const seq = Math.floor(Math.random() * 1e9);
  const marker = `com.cortex-persist-probe-${seq}.txt`;

  // 1. the workspace's own auto-execution primitives — the firing surfaces reach classifies —
  //    each driven: its code executed once, sandboxed, as its mechanism would run it.
  const triggers = scanTriggers(cx, ws).filter((t) => ["git-hook", "husky-hook", "npm-lifecycle", "direnv", "editor-task"].includes(t.kind));
  const plists = launchdDefinitions(cx, ws);
  const drives = await driveTriggers(cx, ws, triggers, actor);

  // 2. every standard host persistence surface, driven with a real write from inside the fence.
  const list = surfaces();
  const { r, out, error } = await driveProbe(cx, ws, {
    name: "persist",
    body: PROBE_PERSIST,
    args: { paths: list.map((s) => ({ path: s.path })), marker },
  }, actor);

  const surfaceResults = [];
  if (!r) {
    surfaceResults.push({ surface: "all", status: "not-measured", evidence: `the probe could not run: ${tail(error)}` });
  } else if (!out) {
    surfaceResults.push({ surface: "all", status: "not-measured", evidence: `the probe returned no account (exit ${r.exitCode}): ${tail(r.stderr)}` });
  } else {
    for (const s of list) {
      const rec = out[s.path];
      if (!rec) { surfaceResults.push({ ...s, status: "not-measured", evidence: "the probe gave no account of this surface" }); continue; }
      const markerPath = join(rec.writeDir ?? s.path, marker);
      const writeErr = String(rec.write?.error ?? "");
      const w = classifyMove(rec.write?.ok ? { ok: true } : { ok: false, error: rec.write?.error }, markerPath, `a plant in ${s.path}`);
      const status = rec.exists === false && /ENOENT|ENOTDIR|EISDIR/.test(writeErr)
        ? "absent"
        : w.status === "refused" ? "cannot-plant" : w.status === "isolated" ? "isolated" : w.status === "escaped" ? "planted" : "unproven";
      const readStatus = rec.exists === false
        ? "absent"
        : rec.read?.ok && rec.read.names
          ? (s.path.startsWith(home) && rec.read.names.length === 0 ? "isolated-empty" : "inventoried")
          : rec.read?.ok ? "present"
          : "refused";
      surfaceResults.push({
        ...s,
        status,
        ...(status === "absent" ? { evidence: "the surface does not exist on this host — nothing loads from here" } : { writeEvidence: w.evidence }),
        ...(readStatus === "inventoried" ? { contents: rec.read.names } : {}),
        ...(readStatus === "isolated-empty" ? { readEvidence: "the fence gives runs an empty home mount: the host's real home is invisible, so what persists there cannot be inventoried from here" } : {}),
        ...(readStatus === "refused" ? { readEvidence: `unreadable from inside the fence: ${tail(rec.read?.error, 140)}` } : {}),
        ...(w.status === "escaped" ? { critical: true, cleanup: markerPath } : {}),
      });
    }
  }

  const summary = {
    surfaces: surfaceResults.length,
    cannotPlant: surfaceResults.filter((s) => s.status === "cannot-plant").length,
    isolated: surfaceResults.filter((s) => s.status === "isolated").length,
    absent: surfaceResults.filter((s) => s.status === "absent").length,
    planted: surfaceResults.filter((s) => s.status === "planted").length,
    inventories: surfaceResults.filter((s) => Array.isArray(s.contents)).length,
    workspacePrimitives: triggers.length,
    launchdDefinitions: plists.length,
    primitivesDriven: drives.filter((d) => d.driven.status.startsWith("executed")).length,
  };
  cx.ledger.append("persist", { workspace: ws.root, at: now(), ...summary, planted: summary.planted, by: actor });
  return {
    workspace: ws.root,
    at: now(),
    workspacePrimitives: triggers.map((t) => ({ kind: t.kind, file: t.file, fires: t.fires, authority: t.authority, fence: t.fence })),
    primitiveDrives: drives,
    launchdDefinitions: plists,
    hostSurfaces: surfaceResults,
    summary,
    ...(summary.planted ? { critical: `this grant could plant ${summary.planted} host persistence surface(s) — a foothold the fence was supposed to make impossible; each is listed with the marker to remove` } : {}),
    coverage: {
      method: "the workspace was scanned for auto-execution primitives and launchd-shaped definitions; each primitive's own code was then executed once, sandboxed, as its real mechanism would run it (npm's script line through the shell, a hook file as git execs it, an envrc as the shell sources it) — exit status recorded, output never copied, since a trigger's output is untrusted; and every standard host persistence surface was driven with a real marker write from inside the same sandbox every context_run faces, classified by the fence's answer and what actually persisted on the host",
      note: "no planted surface means these writes were refused or contained on this host — never that no persistence exists: a surface the fence cannot read says so, and a persistence mechanism this list does not name is invisible to it",
      ...(platform() === "win32" ? { platform: "no persistence battery exists for this platform; nothing was measured and nothing is claimed" } : {}),
    },
  };
}
