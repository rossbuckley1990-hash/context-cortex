// Confined program execution. Every trial and witness program runs here:
// no network, writes only inside a fresh work directory, home directories unreadable,
// CPU-time, file-size, wall-clock and output limits. Without a sandbox nothing runs,
// unless the operator's grant explicitly allows unsandboxed execution.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Refusal } from "./util.js";

const LIMITS = 'ulimit -t "$CORTEX_CPU" 2>/dev/null; ulimit -f "$CORTEX_FSIZE" 2>/dev/null; exec "$0" "$@"';
const HOME_ROOTS = ["/Users", "/home", "/root"];
const PATH_DIRS = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

const sbString = (s) => JSON.stringify(s);

function macProfile(work, readRoots) {
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*)",
    `(allow file-write* (subpath ${sbString(work)}) (literal "/dev/null") (literal "/dev/tty"))`,
    `(deny file-read* ${HOME_ROOTS.map((h) => `(subpath ${sbString(h)})`).join(" ")})`,
    `(allow file-read* (subpath ${sbString(work)}))`,
    ...readRoots.map((r) => `(allow file-read* (subpath ${sbString(r)}))`),
  ].join("\n");
}

let probed = null;

/** Which sandbox this host can enforce, checked by actually running one. */
export async function detectSandbox() {
  const forced = process.env.CORTEX_SANDBOX;
  if (forced === "none") return { kind: null, reason: "disabled by CORTEX_SANDBOX=none" };
  if (probed) return probed;
  const candidates = [];
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) candidates.push("macos-sandbox-exec");
  if (process.platform === "linux") for (const p of ["/usr/bin/bwrap", "/bin/bwrap"]) if (existsSync(p)) candidates.push(`linux-bwrap:${p}`);
  for (const c of candidates) {
    try {
      const r = await execute({ kind: c, program: "/bin/sh", args: ["-c", "exit 0"], readRoots: [], timeoutMs: 10_000, maxOutputBytes: 1024 });
      if (r.exitCode === 0) return (probed = { kind: c.split(":")[0], spec: c, reason: "probe ran" });
    } catch {
      /* try the next one */
    }
  }
  return (probed = { kind: null, reason: candidates.length ? "a sandbox exists but its probe failed" : "no supported sandbox on this host" });
}

export function newWorkDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), "cortex-")));
}

/** Run one program. `work` must come from newWorkDir(); the caller stages files there. */
async function execute({ kind, program, args, work, stdinPath, readRoots = [], timeoutMs, maxOutputBytes, cpuSeconds, maxFileKiB }) {
  const own = !work;
  const dir = work ?? newWorkDir();
  const roots = [...new Set([...readRoots, dirname(program)])];
  let argv;
  if (!kind) {
    argv = ["/bin/sh", "-c", LIMITS, program, ...args];
  } else if (kind === "macos-sandbox-exec") {
    const profile = join(dir, ".cortex.sb");
    writeFileSync(profile, macProfile(dir, roots));
    argv = ["/usr/bin/sandbox-exec", "-f", profile, "/bin/sh", "-c", LIMITS, program, ...args];
  } else if (kind.startsWith("linux-bwrap")) {
    const bwrap = kind.includes(":") ? kind.split(":")[1] : "/usr/bin/bwrap";
    argv = [
      bwrap, "--ro-bind", "/", "/", ...HOME_ROOTS.filter(existsSync).flatMap((h) => ["--tmpfs", h]),
      ...roots.filter(existsSync).flatMap((r) => ["--ro-bind", r, r]),
      "--bind", dir, dir, "--dev", "/dev", "--proc", "/proc", "--unshare-all", "--die-with-parent", "--chdir", dir,
      "/bin/sh", "-c", LIMITS, program, ...args,
    ];
  } else {
    throw new Error(`unknown sandbox ${kind}`);
  }
  const env = {
    PATH: PATH_DIRS.join(":"),
    HOME: dir,
    TMPDIR: dir,
    LANG: "C",
    LC_ALL: "C",
    TERM: "dumb",
    CORTEX_CPU: String(cpuSeconds ?? Math.max(1, Math.ceil(timeoutMs / 1000))),
    CORTEX_FSIZE: String(maxFileKiB ?? Math.max(1, Math.floor(maxOutputBytes / 1024))),
  };
  const t0 = Date.now();
  try {
    return await new Promise((resolveRun, rejectRun) => {
      const child = spawn(argv[0], argv.slice(1), { cwd: dir, env, stdio: [stdinPath ? "pipe" : "ignore", "pipe", "pipe"] });
      const out = [], err = [];
      let outBytes = 0, errBytes = 0, overflow = false, timedOut = false;
      child.stdout.on("data", (d) => {
        outBytes += d.length;
        if (outBytes > maxOutputBytes) {
          overflow = true;
          child.kill("SIGKILL");
        } else out.push(d);
      });
      child.stderr.on("data", (d) => {
        if (errBytes < 64 * 1024) err.push(d);
        errBytes += d.length;
      });
      if (stdinPath) {
        import("node:fs").then(({ createReadStream }) => createReadStream(stdinPath).pipe(child.stdin).on("error", () => {}));
      }
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        rejectRun(e);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolveRun({ exitCode: code, signal, timedOut, overflow, stdout: Buffer.concat(out), stderr: Buffer.concat(err), durationMs: Date.now() - t0, work: dir });
      });
    });
  } finally {
    if (own) rmSync(dir, { recursive: true, force: true });
  }
}

/** Run a program under the host sandbox, or refuse. */
export async function runConfined({ grant, program, args, work, stdinPath }) {
  const sb = await detectSandbox();
  if (!sb.kind && !grant.allowUnsandboxed) {
    throw new Refusal("no-sandbox", `no sandbox is available (${sb.reason}); nothing was run. An operator may set allowUnsandboxed in the grant.`);
  }
  const r = await execute({
    kind: sb.kind ? sb.spec : null,
    program,
    args,
    work,
    stdinPath,
    readRoots: [],
    timeoutMs: grant.limits.timeoutMs,
    maxOutputBytes: grant.limits.maxOutputBytes,
  });
  return { ...r, sandbox: sb.kind ?? "none (operator allowed unsandboxed execution)" };
}

export const cleanupWork = (dir) => rmSync(dir, { recursive: true, force: true });
