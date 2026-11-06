// Recon: every way into a codebase, and proof where they open. Maps a granted workspace — entry
// points, capabilities, dependencies, secrets in the clear — then hunts source→sink taint routes
// (command injection, eval, path traversal, SQL injection, XSS, SSRF, prototype pollution,
// deserialization) with function-scoped static analysis. Where a route starts at argv the real code
// is driven with a payload inside the sandbox, twice: a marker file, a command executed, a read
// outside the workspace — and only a reproduced drive counts as exploited. A write the sandbox
// blocks is reported as contained: the code followed the attacker's path, the fence held. What
// static analysis cannot see is stated; no finding never means secure.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { grantedWorkspace } from "./grant.js";
import { files, run, undo } from "./workspace.js";
import { isObject, now, Refusal, requireString } from "./util.js";

const NODE = process.execPath;
const PY = ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"].find((p) => existsSync(p)) ?? null;

const MAX_SCAN_BYTES = 512 * 1024;
const MAX_ENTRIES = 500;
export const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".html", ".json", ".yml", ".yaml", ".toml", ".sh", ".bash", ".zsh", ".sql", ".env", ".rb", ".php", ".go", ".rs", ".txt", ".md"]);
const JS_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"]);

export const SECRETS = [
  { id: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "aws-secret-access-key", re: /\b(?:aws[_-])?secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{30,}/i },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { id: "openai-style-api-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { id: "private-key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { id: "assigned-credential", re: /\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|auth)\b\s*["']?\s*[:=]\s*["'][^"'\s]{6,}["']/i },
];

const JS_SOURCES = /process\.argv|req\.(?:query|body|params|headers|files|file|url)|request\.(?:query|body|args|form|files|values|payload)|ctx\.(?:request|query|body)|url\.parse|\.on\(\s*["']data["']/;
const PY_SOURCES = /\bsys\.argv|\brequest\.(?:args|form|values|files|headers|get_json|data)|\bos\.environ\b|\binput\s*\(|\bsys\.stdin/;

/** Sinks: class, severity, what a drive can prove. ctx narrows a too-common name to files that also
 *  mention the technology, so `exec(` alone in a non-child_process file is not a finding. */
const JS_SINKS = [
  { class: "command-injection", severity: "critical", re: /\bexec(?:Sync)?\s*\(/, ctx: /child_process/, drive: "exec" },
  { class: "command-injection", severity: "critical", re: /\bspawn(?:Sync)?\s*\(/, ctx: /child_process[\s\S]*shell\s*:\s*true/, drive: "exec" },
  { class: "eval-injection", severity: "critical", re: /\beval\s*\(|\bnew\s+Function\s*\(/, drive: "eval" },
  { class: "path-traversal", severity: "high", re: /\breadFileSync\s*\(|\breadFile\s*\(|\bcreateReadStream\s*\(/, drive: "read" },
  { class: "path-traversal", severity: "high", re: /\bwriteFileSync\s*\(|\bappendFileSync\s*\(|\bcreateWriteStream\s*\(|\bunlinkSync\s*\(/, drive: "write" },
  { class: "sql-injection", severity: "high", re: /\.(?:query|execute)\s*\(/, ctx: /sqlite|mysql|postgres|\bpg\b|sequelize|knex|prisma|mongodb/i },
  { class: "xss", severity: "medium", re: /\.innerHTML\s*=|\bres\.(?:send|write|end)\s*\(/ },
  { class: "ssrf", severity: "high", re: /\bfetch\s*\(|\baxios(?:\.\w+)?\s*\(\s*\(?/ },
  { class: "prototype-pollution", severity: "medium", re: /\b(?:merge|defaultsDeep)\s*\(/, ctx: /lodash/i },
  { class: "deserialization", severity: "critical", re: /\bnodeSerialize\w*\s*\(|\bunserialize\s*\(/ },
];
const PY_SINKS = [
  { class: "command-injection", severity: "critical", re: /\bos\.system\s*\(|\bos\.popen\s*\(|\bsubprocess\.\w+\s*\(/, drive: "exec" },
  { class: "eval-injection", severity: "critical", re: /\beval\s*\(|\bexec\s*\(|\bcompile\s*\(/, drive: "eval" },
  { class: "path-traversal", severity: "high", re: /\bopen\s*\(/, drive: "read" },
  { class: "deserialization", severity: "critical", re: /\bpickle\.loads?\s*\(|\byaml\.load\s*\(|\bmarshal\.loads?\s*\(/ },
  { class: "sql-injection", severity: "high", re: /\b(?:cursor\.)?execute(?:many)?\s*\(/, ctx: /sqlite|mysql|postgres|psycopg|sqlalchemy/i },
  { class: "ssrf", severity: "high", re: /\brequests\.(?:get|post|put|head)\s*\(|\burlopen\s*\(/ },
  { class: "xss", severity: "medium", re: /\brender_template_string\s*\(|\bHttpResponse\s*\(/ },
];

const SKETCHES = {
  "sql-injection": "' OR '1'='1' --",
  xss: "<script>alert(1)</script>",
  ssrf: "http://169.254.169.254/latest/meta-data/",
  deserialization: "a crafted pickle with __reduce__ that executes on load",
  "prototype-pollution": '{"__proto__": {"isAdmin": true}}',
};

// ───────────────────────────── code understanding ─────────────────────────────

/** Function spans as line ranges [start, end], 0-based, from brace depth. Control-flow keywords are
 *  excluded from the start pattern so `if (x) {` does not fragment the enclosing function. */
function spansJS(lines) {
  const out = [];
  const open = [];
  let depth = 0;
  const KEYWORD = "(?!if\\b|for\\b|while\\b|switch\\b|catch\\b|return\\b|else\\b|do\\b|typeof\\b|new\\b)";
  const startRe = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s*([A-Za-z_$][\\w$]*)|([A-Za-z_$][\\w$]*)\\s*(?:=|:)\\s*(?:async\\s*)?(?:function\\b|\\([^()]*\\)\\s*=>)|(${KEYWORD}[A-Za-z_$][\\w$]*)\\s*\\([^;{}()]*\\)\\s*\\{`);
  lines.forEach((line, i) => {
    const before = depth;
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    const m = startRe.exec(line);
    if (m && /\{/.test(line)) open.push({ name: m[1] || m[2] || m[3] || "(anonymous)", start: i, depth: before + 1 });
    while (open.length && depth < open[open.length - 1].depth) {
      const f = open.pop();
      out.push({ name: f.name, start: f.start, end: i });
    }
  });
  for (const f of open) out.push({ name: f.name, start: f.start, end: lines.length - 1 });
  return out;
}

/** Function spans from indentation. A def ends where a non-blank line returns to its indent. */
function spansPY(lines) {
  const out = [];
  const open = [];
  lines.forEach((line, i) => {
    const indent = line.match(/^\s*/)[0].length;
    const isDef = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(line);
    const endsEarlier = line.trim() && !line.trim().startsWith("#");
    if (isDef || endsEarlier) {
      while (open.length && indent <= open[open.length - 1].indent) {
        const f = open.pop();
        out.push({ name: f.name, start: f.start, end: i - 1 });
      }
    }
    if (isDef) open.push({ name: isDef[2], indent, start: i });
  });
  for (const f of open) out.push({ name: f.name, start: f.start, end: lines.length - 1 });
  return out;
}

const trim = (s) => String(s).trim().slice(0, 160);

/** Entry points: the doors a request or an attacker can walk through. */
function entryPoints(rel, text, lines, pkg) {
  const out = [];
  const at = (re) => lines.findIndex((l) => re.test(l)) + 1;
  if (/\b(?:app|router|server)\.(?:get|post|put|patch|delete|all|use)\s*\(\s*["'][^"']+["']/.test(text)) {
    for (const [i, l] of lines.entries()) {
      const m = /\b(?:app|router|server)\.(get|post|put|patch|delete|all|use)\s*\(\s*["']([^"']+)["']/.exec(l);
      if (m) out.push({ kind: "http-route", detail: `${m[1].toUpperCase()} ${m[2]}`, file: rel, line: i + 1 });
    }
  }
  if (/@app\.route\s*\(/.test(text) || /@(?:app|bp|blueprint)\.(?:get|post|put|delete)\s*\(/i.test(text)) {
    for (const [i, l] of lines.entries()) {
      const m = /@app\.route\s*\(\s*["']([^"']+)["']/.exec(l) || /@(?:app|bp)\.(get|post|put|delete)\s*\(\s*["']([^"']+)["']/i.exec(l);
      if (m) out.push({ kind: "http-route", detail: m[1], file: rel, line: i + 1 });
    }
  }
  if (/http\.createServer|\.listen\s*\(/.test(text)) out.push({ kind: "http-server", detail: "listens for requests", file: rel, line: at(/http\.createServer|\.listen\s*\(/) });
  if (/net\.createServer|\.on\(\s*["']connection["']/.test(text)) out.push({ kind: "socket-server", detail: "listens on a socket", file: rel, line: at(/net\.createServer|\.on\(\s*["']connection["']/) });
  if (JS_EXT.has(`.${rel.split(".").pop()}`) && /\bprocess\.argv\b/.test(text)) out.push({ kind: "cli", detail: "reads command-line arguments", file: rel, line: at(/\bprocess\.argv\b/) });
  if (rel.endsWith(".py") && (/\bsys\.argv\b/.test(text) || /__name__\s*==\s*["']__main__["']/.test(text))) out.push({ kind: "cli", detail: "reads command-line arguments (or is a __main__ entry)", file: rel, line: at(/\bsys\.argv\b|__name__\s*==/) });
  if (/\bprocess\.stdin\b|\bsys\.stdin\b|\breadline\b/.test(text)) out.push({ kind: "stdin", detail: "reads standard input", file: rel, line: at(/\bprocess\.stdin\b|\bsys\.stdin\b|\breadline\b/) });
  if (/multer|formidable|multipart|\breq\.files\b|\brequest\.files\b/.test(text)) out.push({ kind: "file-upload", detail: "accepts uploaded files", file: rel, line: at(/multer|formidable|multipart|\breq\.files\b|\brequest\.files\b/) });
  const bin = pkg?.bin;
  if (bin && (bin === rel || (typeof bin === "object" && Object.values(bin).includes(rel)))) out.push({ kind: "package-bin", detail: `declared executable in package.json`, file: rel, line: 1 });
  return out;
}

/** What the code can do, condensed to capabilities an operator cares about. */
function capabilities(text) {
  const caps = new Set();
  const has = (re) => re.test(text);
  if (has(/require\(\s*["']fs["']|from\s+["'](?:node:)?fs|import\s+fs|\bos\.path|\bopen\s*\(/)) caps.add("filesystem");
  if (has(/child_process|\bsubprocess\b|\bos\.system|\bpopen\b/)) caps.add("exec");
  if (has(/\b(?:https?|net|dgram)\b|axios|\bfetch\s*\(|\brequests\.|urllib|\bsocket\(/)) caps.add("network");
  if (has(/\bcrypto\b|hashlib|\bsecrets\.|bcrypt|\bjwt\b/)) caps.add("crypto");
  if (has(/sqlite|mysql|postgres|mongodb|sequelize|knex|prisma|psycopg|sqlalchemy/i)) caps.add("database");
  if (has(/\bpickle\b|\byaml\.load\b|\bmarshal\b|nodeSerialize|unserialize/i)) caps.add("deserialization");
  if (has(/\.node["']|node-gyp|\bctypes\b|\bcffi\b/)) caps.add("native-code");
  if (has(/process\.env|\bos\.environ/)) caps.add("environment");
  if (has(/\beval\s*\(|\bnew\s+Function\b|\bexec\s*\(/)) caps.add("dynamic-evaluation");
  return [...caps];
}

// ───────────────────────────── taint hunting ─────────────────────────────

/** Identifiers assigned from a source on one line. */
function taintedVars(line, sourceRe) {
  const vars = new Set();
  if (!sourceRe.test(line)) return vars;
  for (const m of line.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=|(?<![.\w])([A-Za-z_]\w*)\s*=\s*(?!=)/g)) {
    if (m[1]) vars.add(m[1]);
    else if (m[2]) vars.add(m[2]);
  }
  return vars;
}

/**
 * One file's findings. Taint is function-scoped: a sink is a candidate when the same function
 * (or the module top level) assigns from a source a variable the sink uses — or names the source
 * directly. Static heuristics; the report says so.
 */
function huntFile(rel, text, lines) {
  const ext = `.${rel.split(".").pop()}`;
  const isJS = JS_EXT.has(ext);
  const isPY = ext === ".py";
  if (!isJS && !isPY) return [];
  const sinks = isJS ? JS_SINKS : PY_SINKS;
  const sourceRe = isJS ? JS_SOURCES : PY_SOURCES;
  const spans = [...(isJS ? spansJS(lines) : spansPY(lines)), { name: "<module>", start: 0, end: lines.length - 1 }];
  const findings = [];
  const seen = new Set();
  for (const [i, line] of lines.entries()) {
    for (const sink of sinks) {
      if (!sink.re.test(line)) continue;
      if (sink.ctx && !sink.ctx.test(text)) continue;
      const id = `${rel}:${i + 1}:${sink.class}`;
      if (seen.has(id)) break;
      const span = spans.find((s) => i >= s.start && i <= s.end);
      const spanLines = lines.slice(span.start, span.end + 1);
      const vars = new Set(spanLines.flatMap((l) => [...taintedVars(l, sourceRe)]));
      const named = [...vars].filter((v) => new RegExp(`\\b${v.replace(/\$/g, "\\$")}\\b`).test(line));
      if (!sourceRe.test(line) && !named.length) continue;
      const srcIdx = spanLines.findIndex((l) => sourceRe.test(l));
      const sourceLine = 1 + span.start + (srcIdx < 0 ? i - span.start : srcIdx);
      const sourceText = spanLines[srcIdx < 0 ? i - span.start : srcIdx] ?? line;
      seen.add(id);
      findings.push({
        id,
        class: sink.class,
        severity: sink.severity,
        file: rel,
        line: i + 1,
        function: span.name,
        chain: {
          source: { line: sourceLine, text: trim(sourceText) },
          sink: { line: i + 1, text: trim(line) },
        },
        drive: sink.drive && /\b(?:process|sys)\.argv\b/.test(sourceText) ? sink.drive : null,
      });
      break;
    }
  }
  return findings;
}

// ───────────────────────────── exploitation drives ─────────────────────────────

/** A payload that proves impact when it lands. Markers land inside the workspace (cwd), so a
 *  successful drive is visible in the run's file changes and undone with it. The command payloads
 *  keep a benign first operand: `x; touch …` — a payload that left the command operand-less (as
 *  `; touch …` does to `wc -c x`) could make the target read stdin and hang the drive. */
export function payloadFor(kind, seq, isJS) {
  const marker = `recon-marker-${seq}.txt`;
  if (kind === "exec") return { argument: `x; touch ${marker}`, marker, proves: "the attacker's string ran as a shell command" };
  if (kind === "eval") {
    return isJS
      ? { argument: `require("fs").writeFileSync("${marker}","recon")`, marker, proves: "the attacker's string was evaluated as JavaScript" }
      : { argument: `__import__("os").system("touch ${marker}")`, marker, proves: "the attacker's string was evaluated as Python" };
  }
  if (kind === "read") return { argument: "/etc/passwd", marker: null, proves: "a file outside the workspace was read through the attacker-controlled path" };
  if (kind === "write") return { argument: `../${marker}`, marker, proves: "the code wrote to a path outside the workspace chosen by the attacker" };
  return null;
}

/** Whether one run of the real code proved the payload's impact. Write routes prove through the
 *  sandbox's refusal naming the attacker's marker — unconfined the write would have landed. The
 *  refusal is reported as EACCES/EPERM under sandbox-exec and as EROFS under bubblewrap (its
 *  rootfs is mounted read-only), so both spellings count. */
export function payloadProof(drive, payload, r) {
  const out = String(r.stdout ?? "");
  const err = String(r.stderr ?? "");
  if (drive === "write") {
    return (payload.marker ? err.includes(payload.marker) : true) && /EACCES|EPERM|EROFS|permission denied|read-only file system/i.test(err);
  }
  if (payload.marker) return r.changes.some((c) => c.path === payload.marker && (c.kind === "added" || c.kind === "changed"));
  if (drive === "read") return /root:[x*]:0:0:|daemon:|nobody:/.test(out);
  return false;
}

/**
 * Drive one finding with the real code, twice. Exploited requires the same proof on both runs;
 * a write the sandbox refused on both runs is contained — the code followed the path, the fence
 * held. Every file change is undone after each run.
 */
async function driveFinding(cx, ws, f, seq, actor) {
  const isJS = !f.file.endsWith(".py");
  const program = isJS ? NODE : PY;
  if (!program) return { status: "not-drivable", reason: isJS ? "no node runtime" : "no python3 runtime", runs: [] };
  const p = payloadFor(f.drive, seq, isJS);
  const runs = [];
  let proved = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await run(cx, { workspace: ws.root, program, args: [f.file, p.argument], timeoutMs: cx.grant.limits.timeoutMs }, actor);
    const proof = payloadProof(f.drive, p, r);
    if (proof) proved += 1;
    runs.push({ change: r.change, passed: r.passed, exitCode: r.exitCode, proof, changes: r.changes.map((c) => `${c.kind} ${c.path}`), stdoutTail: String(r.stdout ?? "").slice(-200), stderrTail: String(r.stderr ?? "").slice(-300) });
    await undo(cx, { change: r.change }, actor).catch(() => {});
  }
  if (proved === 2) {
    return {
      status: f.drive === "write" ? "contained-by-sandbox" : "exploited",
      payload: p,
      evidence: f.drive === "write"
        ? "the code followed the attacker's path to a write outside the workspace and the sandbox refused it (EACCES, EPERM or a read-only root), on both runs; unconfined this is an arbitrary file write"
        : p.proves + ", on both runs",
      runs,
      note: "each drive ran the real code twice inside the sandbox; every file change was undone",
    };
  }
  return {
    status: "failed",
    payload: p,
    evidence: "the payload did not produce its proof on both runs",
    runs,
    note: "a failed drive means this payload did not open it — not that the route is safe",
  };
}

// ───────────────────────────── the scan ─────────────────────────────

/** One static scan of a workspace: the map and every taint finding, with no drives run. Shared by
 *  recon (which then drives routes), repair (which then fixes them) and plan (which grounds a
 *  requirement in what is here). */
export function scanWorkspace(cx, root) {
  const listing = files(cx, { workspace: root, limit: 5000 });
  const languages = {};
  const entryPointsOut = [];
  const capabilityCounts = {};
  const secretFindings = [];
  const findings = [];
  const deps = {};
  let pkg = null;
  let scanned = 0;
  let linesTotal = 0;

  // Manifests first: entry points for a file named in package.json bin need pkg known before any
  // code file is scanned (the file list is alphabetical, so cli.js precedes package.json).
  for (const f of listing.files) {
    if (f.path === "package.json") {
      try {
        pkg = JSON.parse(readFileSync(join(root, f.path), "utf8"));
        deps.npm = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
      } catch { /* not JSON */ }
    }
    if (f.path === "requirements.txt") {
      try {
        deps.python = readFileSync(join(root, f.path), "utf8").split("\n").map((l) => l.split(/[=<>~#]/)[0].trim()).filter(Boolean);
      } catch { /* unreadable */ }
    }
  }

  for (const f of listing.files) {
    const abs = join(root, f.path);
    const ext = `.${f.path.split(".").pop()}`;
    if (!TEXT_EXT.has(ext) || f.size > MAX_SCAN_BYTES) continue;
    scanned += 1;
    const text = readFileSync(abs, "utf8");
    const lines = text.split("\n");
    linesTotal += lines.length;
    const lang = JS_EXT.has(ext) ? (ext === ".ts" || ext === ".tsx" ? "TypeScript" : "JavaScript") : ext === ".py" ? "Python" : ext.slice(1).toUpperCase();
    languages[lang] = (languages[lang] ?? 0) + 1;
    entryPointsOut.push(...entryPoints(f.path, text, lines, pkg));
    for (const cap of capabilities(text)) capabilityCounts[cap] = (capabilityCounts[cap] ?? 0) + 1;
    for (const [i, line] of lines.entries()) {
      for (const s of SECRETS) {
        const m = s.re.exec(line);
        if (m) secretFindings.push({ kind: s.id, file: f.path, line: i + 1, match: trim(m[0]) });
      }
    }
    findings.push(...huntFile(f.path, text, lines));
  }

  return { total: listing.total, scanned, lines: linesTotal, languages, entryPoints: entryPointsOut, capabilities: capabilityCounts, secrets: secretFindings, findings, pkg, deps };
}

export async function recon(cx, req, actor) {
  if (!isObject(req)) throw new Refusal("bad-request", "recon takes an object");
  const ws = grantedWorkspace(cx.grant, requireString(req.workspace, "workspace"));
  const driveLimit = Math.min(Math.max(0, Number(req.driveLimit ?? 10)), 25);
  const s = scanWorkspace(cx, ws.root);
  const { findings } = s;
  const entryPointsOut = s.entryPoints;
  const secretFindings = s.secrets;

  // Exploitation drives: argv-sourced candidates, most severe first, at most driveLimit.
  const drivable = findings.filter((f) => f.drive).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.line - b.line).slice(0, driveLimit);
  const driven = new Set(drivable.map((f) => f.id));
  let seq = 0;
  for (const f of findings) {
    if (driven.has(f.id)) {
      seq += 1;
      f.drive = await driveFinding(cx, ws, f, seq, actor);
    } else {
      const kind = f.drive;
      f.drive = {
        status: "not-drivable",
        reason: kind
          ? driveLimit
            ? "beyond the drive limit for this scan; raise driveLimit"
            : "drives are disabled (driveLimit 0)"
          : "the tainted source is request data, stdin or environment: driving it needs a live request the sandbox does not grant",
        runs: [],
        ...(kind ? {} : SKETCHES[f.class] ? { sketch: SKETCHES[f.class] } : {}),
      };
    }
  }

  const summary = {
    exploited: findings.filter((f) => f.drive.status === "exploited").length,
    contained: findings.filter((f) => f.drive.status === "contained-by-sandbox").length,
    candidates: findings.filter((f) => f.drive.status === "failed" || f.drive.status === "not-drivable").length,
    secrets: secretFindings.length,
    entryPoints: entryPointsOut.length,
  };
  const list = (status) => findings.filter((f) => f.drive.status === status).map((f) => `${f.file}:${f.line} ${f.class}`);
  cx.ledger.append("recon", {
    workspace: ws.root, files: s.scanned, lines: s.lines, at: now(), ...summary,
    findings: [...list("exploited"), ...list("contained-by-sandbox"), ...list("failed"), ...list("not-drivable")],
    by: actor,
  });
  return {
    workspace: ws.root,
    at: now(),
    map: {
      files: s.total,
      scanned: s.scanned,
      lines: s.lines,
      languages: s.languages,
      entryPoints: entryPointsOut.slice(0, MAX_ENTRIES),
      entryPointsTruncated: Math.max(0, entryPointsOut.length - MAX_ENTRIES),
      capabilities: s.capabilities,
      dependencies: s.deps,
      secrets: secretFindings.slice(0, MAX_ENTRIES),
    },
    findings,
    summary,
    coverage: {
      filesScanned: `${s.scanned} of ${s.total} (text files up to ${MAX_SCAN_BYTES / 1024} KB; .git, node_modules and vendored trees skipped)`,
      languages: Object.keys(s.languages),
      sinkPatterns: { JavaScript: JS_SINKS.length, TypeScript: JS_SINKS.length, Python: PY_SINKS.length },
      method: "function-scoped static taint analysis plus sandboxed exploitation drives on argv-sourced routes; no interprocedural data flow, no dynamic dispatch, no reflection, and no driving of request-sourced routes without a live server and a network grant",
      note: "Exploited means reproduced twice by running the real code with the payload shown, every change undone. Contained means the code followed the attacker's path and the sandbox refused it. Candidates are static evidence only. No finding means this scan saw nothing on these files — never that the code is secure.",
    },
  };
}
