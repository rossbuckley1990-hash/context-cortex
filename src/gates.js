// Gates: the host's defenses, inventoried from exactly the vantage this engine has. Every gate is
// either measured — by running the real query command inside the same sandbox every context_run
// faces, or by the engine's own read-only filesystem census — or marked not-measured with the
// reason, which is often itself the control working (sudoers is unreadable without root; TCC is
// consulted only after the fence has already refused the home directory). A gate that cannot be
// read from here is reported as unreadable, never guessed. The one defense this tool can state
// from authority rather than inference is the fence itself: its exact policy, with context_escape
// as the way to verify each claim by attempting the real moves.
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { grantedWorkspace } from "./grant.js";
import { detectSandbox, newWorkDir, runConfined, cleanupWork, SANDBOX_POLICY } from "./sandbox.js";
import { driveProbe } from "./escape.js";
import { isObject, now, Refusal, requireString } from "./util.js";

const NODE = process.execPath;

const MAX_FILES_PER_DIR = 2000;
const SUID_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin", "/opt/homebrew/bin"];

const tail = (s, n = 400) => String(s ?? "").trim().slice(0, n);

/** One host query command, run inside the fence. The probe never interprets: it reports exit status,
 *  a bounded head of each stream, and — so a long table is never truncated to a sample — which
 *  section headers the full output contains and which lines match a given filter. The meaning of
 *  any of that is decided by the engine, not the probe. */
const PROBE_HOST_CMD = `
const { spawnSync } = require("child_process");
const args = JSON.parse(process.argv[2]);
const out = {};
for (const c of args.commands) {
  try {
    const r = spawnSync(c.cmd[0], c.cmd.slice(1), { encoding: "utf8", timeout: args.timeoutMs });
    const stdout = String(r.stdout ?? "");
    const rec = { exit: r.status, error: r.error ? String(r.error) : null, stdoutHead: stdout.slice(0, 400), stderr: String(r.stderr ?? "").slice(0, 800) };
    if (c.filter) { const m = stdout.split("\\n").filter((l) => new RegExp(c.filter).test(l)); rec.matchCount = m.length; rec.matches = m.slice(0, 25); }
    if (c.sections) rec.sections = Object.fromEntries(c.sections.map((s) => [s, stdout.includes(s)]));
    out[c.name] = rec;
  } catch (e) { out[c.name] = { exit: null, error: String(e && e.message ? e.message : e) }; }
}
process.stdout.write(JSON.stringify(out));
`;

/** The SUID/SGID binaries the standard directories hold — the pieces of the host that elevate.
 *  Engine-side, read-only, bounded. */
function suidInventory() {
  const found = [];
  let truncated = false;
  for (const dir of SUID_DIRS) {
    if (!existsSync(dir)) continue;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names.slice(0, MAX_FILES_PER_DIR)) {
      try {
        const st = statSync(join(dir, name));
        if (st.isFile() && st.mode & 0o6000) found.push(join(dir, name));
      } catch {
        /* went away */
      }
    }
    if (names.length > MAX_FILES_PER_DIR) truncated = true;
  }
  return { count: found.length, examples: found.slice(0, 40), dirs: SUID_DIRS.filter(existsSync), ...(truncated ? { truncated: true } : {}) };
}

/** Which PATH directories are world-writable — a host hygiene check, not a gate. */
function pathDirHygiene() {
  const bad = [];
  for (const dir of SUID_DIRS) {
    try {
      const st = statSync(dir);
      if (st.mode & 0o002) bad.push(dir);
    } catch {
      /* absent */
    }
  }
  return bad;
}

export async function gates(cx, req, actor) {
  if (!isObject(req)) throw new Refusal("bad-request", "gates takes an object");
  // The target is the host itself; a workspace is only where the probe is staged from. Without one
  // the same probe runs through the experiment fence — a fresh work directory, no write roots —
  // which is the same vantage every trial gets.
  const ws = req.workspace ? grantedWorkspace(cx.grant, requireString(req.workspace, "workspace")) : null;
  const isMac = platform() === "darwin";
  const isLinux = platform() === "linux";
  const out = [];
  const entry = (gate, state, evidence, meaning, extra = {}) => out.push({ gate, state, evidence, meaning, ...extra });

  // The commands that answer for the host's own gates. All are read-only queries; if the sandbox
  // refuses one, that is reported, never worked around.
  const cmds = isMac
    ? [
        { name: "csrutil", cmd: ["/usr/bin/csrutil", "status"] },
        { name: "spctl", cmd: ["/usr/sbin/spctl", "--status"] },
        { name: "socketfilterfw", cmd: ["/usr/libexec/ApplicationFirewall/socketfilterfw", "--getglobalstate"] },
        { name: "fdesetup", cmd: ["/usr/bin/fdesetup", "status"] },
        { name: "sysext", cmd: ["/usr/bin/systemextensionsctl", "list"] },
        { name: "netstat", cmd: ["/usr/sbin/netstat", "-an"], filter: "LISTEN", sections: ["Active Internet connections"] },
      ]
    : isLinux
      ? [
          { name: "ss", cmd: ["/usr/sbin/ss", "-tlnp"], sections: ["State"] },
          { name: "ptrace", cmd: ["/bin/cat", "/proc/sys/kernel/yama/ptrace_scope"] },
        ]
      : [];
  let r = null, probeOut = null, error = null;
  if (ws) {
    ({ r, out: probeOut, error } = await driveProbe(cx, ws, {
      name: "gates",
      body: PROBE_HOST_CMD,
      args: { commands: cmds, timeoutMs: 8000 },
    }, actor));
  } else {
    const work = newWorkDir();
    writeFileSync(join(work, "cortex-gates-probe.js"), PROBE_HOST_CMD);
    try {
      r = await runConfined({ grant: cx.grant, program: NODE, args: [join(work, "cortex-gates-probe.js"), JSON.stringify({ commands: cmds, timeoutMs: 8000 })], work, timeoutMs: 20_000, maxOutputBytes: 1024 * 1024 });
      try { probeOut = JSON.parse(String(r.stdout ?? "")); } catch { probeOut = null; }
    } catch (e) {
      r = null;
      error = e instanceof Refusal ? e.message : String(e?.message ?? e);
    } finally {
      cleanupWork(work);
    }
  }
  const results = probeOut ?? {};
  const said = (name) => tail(results[name]?.stdoutHead ?? "", 200);

  if (isMac) {
    const sip = results.csrutil;
    if (!r) entry("sip", "not-measured", `the probe could not run: ${tail(error, 160)}`, "System Integrity Protection state is unknown from here");
    else if (!sip) entry("sip", "not-measured", `csrutil gave no account (probe exit ${r.exitCode}): ${tail(r.stderr, 200)}`, "System Integrity Protection state is unknown from here");
    else if (/enabled/i.test(sip.stdoutHead)) entry("sip", "enforced", `csrutil status: ${said("csrutil")}`, "system files, protected directories and runtime protections are defended against root-level modification");
    else if (/disabled/i.test(sip.stdoutHead)) entry("sip", "disabled", `csrutil status: ${said("csrutil")}`, "System Integrity Protection is off: root-level code can modify system files — this host relies on per-process fences alone", { finding: true });
    else entry("sip", "not-measured", `csrutil answered unexpectedly (exit ${sip.exit}): ${said("csrutil") || tail(sip.stderr, 200)}`, "System Integrity Protection state is unknown from here");

    const gk = results.spctl;
    if (!gk) entry("gatekeeper", "not-measured", "spctl gave no account", "Gatekeeper state is unknown from here");
    else if (/assessments enabled/i.test(gk.stdoutHead)) entry("gatekeeper", "enforced", `spctl --status: ${said("spctl")}`, "unsigned applications are blocked from launching by first run");
    else if (/assessments disabled/i.test(gk.stdoutHead)) entry("gatekeeper", "disabled", `spctl --status: ${said("spctl")}`, "Gatekeeper is off: unsigned code launches without assessment", { finding: true });
    else entry("gatekeeper", "not-measured", `spctl answered unexpectedly (exit ${gk.exit}): ${said("spctl") || tail(gk.stderr, 160)}`, "Gatekeeper state is unknown from here");

    const fw = results.socketfilterfw;
    if (!fw) entry("firewall", "not-measured", "socketfilterfw gave no account", "The application firewall state is unknown from here");
    else if (/enabled/i.test(fw.stdoutHead)) entry("firewall", "enforced", `socketfilterfw: ${said("socketfilterfw")}`, "incoming connections are filtered per application");
    else if (/disabled/i.test(fw.stdoutHead)) entry("firewall", "disabled", `socketfilterfw: ${said("socketfilterfw")}`, "The application firewall is off", { finding: true });
    else entry("firewall", "not-measured", `socketfilterfw answered unexpectedly (exit ${fw.exit}): ${said("socketfilterfw") || tail(fw.stderr, 160)}`, "The application firewall state is unknown from here");

    const fv = results.fdesetup;
    if (!fv) entry("filevault", "not-measured", "fdesetup gave no account", "FileVault state is unknown from here");
    else if (/On/i.test(fv.stdoutHead) && !/Off/i.test(fv.stdoutHead)) entry("filevault", "enforced", `fdesetup status: ${said("fdesetup")}`, "the startup volume is encrypted at rest");
    else if (/Off/i.test(fv.stdoutHead)) entry("filevault", "disabled", `fdesetup status: ${said("fdesetup")}`, "the startup volume is not encrypted at rest", { finding: true });
    else entry("filevault", "not-measured", `fdesetup answered unexpectedly (exit ${fv.exit}): ${said("fdesetup") || tail(fv.stderr, 120)}`, "FileVault state is unknown from here — some macOS builds require admin privileges to query it");

    const es = results.sysext;
    if (!es) entry("endpoint-security", "not-measured", "systemextensionsctl gave no account", "Endpoint Security clients (the system extensions that watch process, file and disk events) are unknown from here");
    else if (es.exit === 0 || /com\.apple\.|teamID/i.test(String(es.stdoutHead) + String(es.stderr))) {
      const ids = [es.stdoutHead, es.stderr].join("\n").split("\n").filter((l) => /\[--\]|enabled|activated/i.test(l) || /^[a-z0-9]{10}\s/i.test(l.trim()));
      entry("endpoint-security", "inventory", `systemextensionsctl list reported ${ids.length} system extension entry line(s) from inside the fence${ids.length ? `: ${ids.slice(0, 6).map((l) => tail(l, 90)).join("; ")}` : ""} — an Endpoint Security client must hold a special entitlement from Apple; third-party security tools live here`, "which daemons watch security events on this host", { count: ids.length });
    } else entry("endpoint-security", "not-measured", `systemextensionsctl could not list from inside the fence (exit ${es.exit}): ${said("sysext") || tail(es.stderr, 160)}`, "Endpoint Security clients are unknown from here — listing may need developer mode or privileges this engine will not take");
  }
  if (isLinux) {
    const ptrace = results.ptrace;
    if (!r) entry("ptrace-scope", "not-measured", `the probe could not run: ${tail(error, 160)}`, "ptrace restrictions are unknown from here");
    else if (ptrace && ptrace.exit === 0) {
      const v = String(ptrace.stdoutHead ?? "").trim();
      const meanings = ["classic ptrace restrictions (a process may ptrace only its own children)", "a process may ptrace only its own descendants — the admin-only escape hatch", "only admin processes may ptrace; the CAP_SYS_PTRACE capability is required", "no process may ptrace another"];
      entry("ptrace-scope", v === "" ? "not-measured" : `yama${v || "0"}`, `/proc/sys/kernel/yama/ptrace_scope = ${v || "(empty — yama not enabled)"}`, meanings[Number(v)] ?? `kernel.yama.ptrace_scope is ${v}`);
    } else entry("ptrace-scope", "not-measured", ptrace ? `the scope file could not be read from inside the fence (exit ${ptrace.exit}): ${tail(ptrace.stderr, 160)}` : "the scope file gave no account", "ptrace restrictions are unknown from here");
    if (existsSync("/sys/kernel/security/apparmor")) entry("apparmor", "present", "/sys/kernel/security/apparmor exists", "the AppArmor LSM is loaded; which profiles confine what is not measurable from inside this fence — the engine reads its own confinement directly");
    if (existsSync("/sys/fs/selinux")) entry("selinux", "present", "/sys/fs/selinux exists", "the SELinux LSM is loaded");
  }

  // Listeners. A process with no network access sees no network tables — that is the fence's own
  // design, and it is reported as not-measured rather than as an empty host. Only when the tables
  // are genuinely visible does the count stand, and then as a lower bound (other uids' sockets are
  // invisible without privileges).
  const netstat = isMac ? results.netstat : results.ss;
  const tablesVisible = isMac ? netstat?.sections?.["Active Internet connections"] === true : netstat?.sections?.State === true;
  if (netstat && tablesVisible) {
    const listen = netstat.matches ?? [];
    entry("listeners", "inventory", `${netstat.matchCount} listening socket(s) counted by ${isMac ? "netstat -an" : "ss -tlnp"} inside the fence; sockets owned by other uids are typically invisible to a process without privileges, so this is a lower bound`, "services accepting connections on this host", { count: netstat.matchCount, sample: listen.map((l) => tail(l, 120)) });
  } else if (netstat) {
    entry("listeners", "not-measured", `${isMac ? "netstat -an" : "ss -tlnp"} ran inside the fence but the network tables it reports are not the host's: a process denied network access cannot see them (the command returned only the sections the fence allows). Counting the host's listeners would take an unfenced process, which this engine will not be. The host's listening services are therefore unknown from here`, "unmeasurable does not mean quiet: the fence hides the tables rather than emptying them");
  } else {
    entry("listeners", "not-measured", !r ? `the probe could not run: ${tail(error, 160)}` : `the host's own tool gave no account (probe exit ${r.exitCode}): ${tail(r.stderr, 160)}`, "the set of services accepting connections on this host is unknown from here");
  }

  // sudo: the configuration is deliberately unreadable without root — the refusal is the control.
  entry("sudo", "refused-by-design", "/etc/sudoers is unreadable without root by design; which users may elevate, and to what, cannot be inventoried from here", "elevation rules exist but are invisible to this engine — a healthy state; the engine has no sudo path of its own to test");

  // TCC: the fence refuses home reads before TCC is ever consulted, and the TCC database needs root.
  if (isMac) entry("tcc", "not-measured", "privacy protections (TCC) sit in front of the user's own data, but inside the fence the home directory is refused before TCC is consulted, and the TCC database needs root to read; which applications hold which permissions is not measurable from here", "unmeasurable does not mean permissive: the fence denies the data outright");

  // AMFI: no userspace query this engine knows answers for it.
  if (isMac) entry("amfi", "not-measured", "Apple Mobile File Integrity has no unprivileged query this engine knows; it is enforced in the kernel at code-signing time and cannot be read from userspace here", "unsigned and improperly signed code is expected to be killed at exec on a stock macOS — asserted from platform knowledge, not measured");

  // The one gate this engine states with authority: its own fence, in force here and now.
  const sb = await detectSandbox();
  const fence = {
    gate: "cortex-fence",
    state: sb.kind ?? "absent",
    evidence: sb.kind ? `sandbox: ${sb.kind}` : `no sandbox is available: ${tail(sb.reason, 160)}${cx.grant.allowUnsandboxed ? " (the operator has allowed running without it)" : ""}`,
    meaning: "the fence around every trial and run on this host; context_escape verifies each claim it makes by attempting the real escape moves",
    policy: SANDBOX_POLICY,
  };
  if (!sb.kind && !cx.grant.allowUnsandboxed) fence.finding = true;

  const suid = suidInventory();
  const worldWritable = pathDirHygiene();
  const summary = {
    enforced: out.filter((g) => g.state === "enforced" || g.state === "refused-by-design").length,
    present: out.filter((g) => g.state === "present").length,
    disabled: out.filter((g) => g.state === "disabled").length,
    notMeasured: out.filter((g) => g.state === "not-measured").length,
    ...(worldWritable.length ? { worldWritablePathDirs: worldWritable } : {}),
  };
  cx.ledger.append("gates", { workspace: ws ? ws.root : null, at: now(), ...summary, fence: fence.state, by: actor });
  return {
    ...(ws ? { workspace: ws.root } : { target: "the host itself — its defenses are the machine's own, not any one workspace's" }),
    at: now(),
    host: { platform: platform(), home: homedir(), sandbox: sb.kind ?? null },
    gates: out,
    fence,
    suid,
    summary,
    coverage: {
      method: "each gate was measured with the host's own query commands run inside the same sandbox every context_run faces, or with the engine's read-only filesystem census; a gate the vantage cannot see is reported not-measured with the reason — never guessed",
      note: "this is an inventory of defenses visible from one process on the host, not an audit: it says nothing about defenses it could not measure, and states which those are",
    },
  };
}
