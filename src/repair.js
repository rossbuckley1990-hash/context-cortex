// Repair: close what recon proves open, and prove it closed. For each argv-driven finding in a
// granted workspace the engine applies one minimal guard edit through the reversible edit
// machinery, then makes the fix earn its keep: the exact payload is re-driven twice and must no
// longer reproduce, a benign input must behave exactly as before, and the workspace's own tests
// must not regress. Any check that fails undoes the fix and names the check that failed. Routes
// the sandbox cannot drive and classes with no honest one-line guard come back as needs-redesign
// with the reasoning — never a silent skip. Closed means proven for the payload driven, never
// that every input is safe.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { grantedWorkspace } from "./grant.js";
import { edit, run, undo } from "./workspace.js";
import { payloadFor, payloadProof, scanWorkspace, SEVERITY_RANK } from "./hunt.js";
import { isObject, now, Refusal, requireString } from "./util.js";

const NODE = process.execPath;
const PY = ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"].find((p) => existsSync(p)) ?? null;

const BENIGN_INPUT = "context-repair-benign.txt";
const BENIGN_WRITE = "context-repair-benign-out.txt";
const MAX_LIST = 50;

const RECIPE_CLASSES = new Set(["command-injection", "eval-injection", "path-traversal"]);
const REDESIGN = {
  "sql-injection": "parameterise the query (prepared statements) and validate types; no honest one-line guard exists",
  xss: "encode for the output context and set a content security policy; no honest one-line guard exists",
  ssrf: "allowlist the destinations (scheme, host, port) and refuse link-local metadata addresses; no honest one-line guard exists",
  "prototype-pollution": "use a merge that skips __proto__ and constructor, or an explicit schema; no honest one-line guard exists",
  deserialization: "never unserialize attacker data; use a data-only format with schema validation; no honest one-line guard exists",
};

/** The sink line in the file as it is now. Edits can move lines between the scan and the fix, so
 *  the finding's remembered text is re-located, and a line that cannot be found uniquely — or is
 *  found twice — is refused rather than guessed at. */
function locate(lines, sinkText) {
  const hits = [];
  for (const [i, l] of lines.entries()) if (l.trim().startsWith(sinkText)) hits.push(i);
  return hits.length === 1 ? hits[0] : null;
}

/** The identifier the tainted value was assigned to on the source line. */
function taintedName(f) {
  return /([A-Za-z_$][\w$]*)\s*=\s*(?:sys\.argv|process\.argv)/.exec(f.chain.source.text)?.[1] ?? null;
}

/** One minimal guard for one finding, as an exact-string replacement {old, new} for context_edit —
 *  or a reason it cannot be fixed honestly. Guards preserve the guarded path for benign inputs:
 *  the command still runs, the arithmetic expression still evaluates, the relative path still
 *  opens; only the attacker's spellings are refused. */
function buildFix(f, text) {
  const lines = text.split("\n");
  const idx = locate(lines, f.chain.sink.text);
  if (idx === null) return { reason: "the sink line cannot be found uniquely in the file as it is now — the code moved, or two lines share it; re-run recon after the code settles" };
  const line = lines[idx];
  const indent = line.match(/^\s*/)[0];
  const isJS = !f.file.endsWith(".py");
  const guardBefore = (guard) => ({ old: line, new: indent + guard + "\n" + line });
  const argOf = (re) => re.exec(line)?.[0] ?? null;

  if (f.class === "command-injection" && isJS) {
    const vars = [...line.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g)].map((m) => m[1]);
    if (!vars.length) return { reason: "the command is not built from a template literal, so the tainted value cannot be guarded mechanically" };
    const cond = vars.map((v) => "/[\\n;&|`$()]/.test(" + v + ")").join(" || ");
    return guardBefore('if (' + cond + ') { throw new Error("untrusted argument"); }');
  }
  if (f.class === "command-injection") {
    const expr = argOf(/sys\.argv\[\d+\]/) ?? taintedName(f);
    if (!expr) return { reason: "the command is not built from a value this recipe can name" };
    return guardBefore('if __import__("re").search(r"[\\n;&|`$()]", ' + expr + '): raise SystemExit("untrusted argument")');
  }
  if (f.class === "eval-injection" && isJS) {
    const m = /\beval\(\s*([^()]+?)\s*\)/.exec(line);
    if (!m) return { reason: "eval is called with a parenthesised expression this recipe cannot wrap" };
    return { old: m[0], new: '(e => { if (!/^[\\d\\s+\\-*/().]+$/.test(e)) throw new Error("untrusted expression"); return eval(e); })(' + m[1] + ")" };
  }
  if (f.class === "eval-injection") {
    if (/\bexec\s*\(|\bcompile\s*\(/.test(line)) return { reason: "exec or compile of untrusted input has no benign form worth preserving; this needs a redesign" };
    const expr = argOf(/sys\.argv\[\d+\]/) ?? taintedName(f);
    if (!expr) return { reason: "the evaluated value is not one this recipe can name" };
    return guardBefore('if not __import__("re").fullmatch(r"[\\d\\s+\\-*/().]+", ' + expr + '): raise SystemExit("untrusted expression")');
  }
  if (isJS) {
    const m = /\b(readFileSync|readFile|createReadStream|writeFileSync|appendFileSync|createWriteStream|unlinkSync)\(\s*([^()]+?)\s*([,)])/.exec(line);
    if (!m) return { reason: "the path argument contains parentheses; this recipe only wraps a simple argument" };
    const iife = '(p => { if (typeof p === "string" && (p.startsWith("/") || p.includes(".."))) throw new Error("path refused"); return p; })(' + m[2] + ")";
    return { old: m[0], new: m[1] + "(" + iife + m[3] };
  }
  const expr = argOf(/sys\.argv\[\d+\]/) ?? taintedName(f);
  if (!expr) return { reason: "the opened path is not one this recipe can name" };
  return guardBefore('if ' + expr + '.startswith("/") or ".." in ' + expr + ': raise SystemExit("path refused")');
}

/** The test command, from the caller or from package.json scripts.test. Only a plain `node …`
 *  script can be resolved to the absolute runtime the sandbox needs; anything else is stated, not
 *  silently substituted. */
function detectTest(req, pkg) {
  if (isObject(req.test) && typeof req.test.program === "string") {
    return { program: req.test.program, args: Array.isArray(req.test.args) ? req.test.args.map(String) : [] };
  }
  const script = typeof pkg?.scripts?.test === "string" ? pkg.scripts.test.trim() : null;
  if (script) {
    const m = /^node\s+(.+)$/.exec(script);
    if (m) return { program: NODE, args: m[1].split(/\s+/) };
    return { reason: `package.json runs "${script.slice(0, 60)}" as its test, which cannot be resolved to an absolute program for the sandbox; pass test {program, args} to have it used` };
  }
  return { reason: "no test script in package.json; the proof rested on the payload re-drive and the benign equivalence alone" };
}

const pick = (r) => ({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: !!r.timedOut });

/** Equivalence on the program's observable contract: exit status and what it writes to standard
 *  output. Standard error is diagnostics, and runtimes emit nondeterministic noise there — on
 *  macOS every python3 run logs an xcrun cache failure with a fresh random filename — that has
 *  nothing to do with the guarded code. A guard that throws changes the exit status, so a
 *  behavior change on a benign input cannot slip through on stderr alone. */
function sameBehavior(a, b) {
  if (a.timedOut || b.timedOut) return { ok: false, why: "a benign run timed out" };
  if (a.exitCode !== b.exitCode) return { ok: false, why: `exit ${a.exitCode} became ${b.exitCode}` };
  if (String(a.stdout ?? "") !== String(b.stdout ?? "")) return { ok: false, why: "standard output changed" };
  return { ok: true };
}

/** Tests must not newly fail: passing tests stay passing; already-failing tests fail the same way. */
function testsOk(before, after) {
  if (!after) return { ok: true };
  if (before?.passed && !after.passed) return { ok: false, why: `exit 0 before, exit ${after.exitCode} after` };
  if (before && !before.passed && String(before.stdout ?? "") !== String(after.stdout ?? "")) return { ok: false, why: "the set of failing tests changed" };
  return { ok: true };
}

async function runTest(cx, ws, testCmd, actor) {
  const r = await run(cx, { workspace: ws.root, program: testCmd.program, args: testCmd.args, timeoutMs: Math.min(cx.grant.limits.workspaceTimeoutMs ?? 300_000, 120_000) }, actor);
  const out = { exitCode: r.exitCode, passed: r.passed, stdout: r.stdout, stderr: r.stderr };
  if (r.change) await undo(cx, { change: r.change }, actor).catch(() => {});
  return out;
}

async function repairOne(cx, ws, f, seq, testCmd, actor) {
  const base = { id: f.id, class: f.class, severity: f.severity, file: f.file, line: f.line, function: f.function, chain: f.chain };
  const isJS = !f.file.endsWith(".py");
  const program = isJS ? NODE : PY;
  if (!program) return { ...base, status: "not-fixed", reason: isJS ? "no node runtime" : "no python3 runtime" };
  const p = payloadFor(f.drive, seq, isJS);
  const benignArg = f.drive === "eval" ? "1+1" : f.drive === "write" ? BENIGN_WRITE : BENIGN_INPUT;
  const drive = (args) => run(cx, { workspace: ws.root, program, args, timeoutMs: cx.grant.limits.timeoutMs }, actor);
  const settle = async (r) => { if (r.change) await undo(cx, { change: r.change }, actor).catch(() => {}); };

  // The payload must reproduce on the code as it is: repairing a route that is not open would
  // prove nothing. One drive here; the fix afterwards gets the stricter two-run test.
  const before = await drive([f.file, p.argument]);
  const open = payloadProof(f.drive, p, before);
  const baseline = { exitCode: before.exitCode, proof: open, changes: before.changes.map((c) => `${c.kind} ${c.path}`), stderrTail: String(before.stderr ?? "").slice(-200) };
  await settle(before);
  if (!open) {
    return { ...base, status: "not-open", reason: "the payload did not reproduce on the code as it is — already fixed, or this payload no longer drives it; nothing was changed", payload: p, baseline };
  }

  const benignBefore = await drive([f.file, benignArg]);
  await settle(benignBefore);
  const testsBefore = testCmd.program ? await runTest(cx, ws, testCmd, actor) : null;

  const fix = buildFix(f, readFileSync(join(ws.root, f.file), "utf8"));
  if (fix.reason) return { ...base, status: "not-fixed", reason: fix.reason, payload: p, baseline };
  let applied;
  try {
    applied = await edit(cx, { workspace: ws.root, path: f.file, replace: { old: fix.old, new: fix.new }, reason: `context_repair: guard the ${f.class} route at ${f.file}:${f.line}` }, actor);
  } catch (e) {
    return { ...base, status: "not-fixed", reason: e.message, payload: p, baseline, attempted: fix.new };
  }

  const revert = async (reason, extra = {}) => {
    let undone = true;
    let undoError = null;
    try {
      await undo(cx, { change: applied.change }, actor);
    } catch (e) {
      undone = false;
      undoError = e.message;
    }
    return {
      ...base, status: undone ? "reverted" : "revert-failed", reason, change: applied.change, undoError,
      attempted: fix.new.split("\n")[0], attemptedDiff: applied.summary, payload: p, baseline, ...extra,
      note: undone
        ? "the fix was undone; the route is open again — the diff shows what was attempted, for a hand fix"
        : `the fix is still applied and could not be undone (${undoError}); undo change ${applied.change} with context_edit once the file is back to its digest`,
    };
  };

  // The fix earns its keep: the payload must fail to reproduce on both post-fix runs.
  const postRuns = [];
  let closedRuns = 0;
  for (let i = 0; i < 2; i++) {
    const r = await drive([f.file, p.argument]);
    const proof = payloadProof(f.drive, p, r);
    const refusedInCode = f.drive === "write" ? /path refused/.test(String(r.stderr ?? "")) : !proof;
    if (refusedInCode) closedRuns += 1;
    postRuns.push({ exitCode: r.exitCode, proof, changes: r.changes.map((c) => `${c.kind} ${c.path}`), stderrTail: String(r.stderr ?? "").slice(-200) });
    await settle(r);
  }
  if (closedRuns !== 2) {
    return revert(f.drive === "write" ? "the code still reaches the filesystem on the attacker's path instead of refusing it itself" : "the payload still reproduces after the fix", { postRuns });
  }

  // Benign behavior must be byte-identical, and the workspace's own tests must not regress.
  const benignAfter = await drive([f.file, benignArg]);
  await settle(benignAfter);
  const same = sameBehavior(benignBefore, benignAfter);
  if (!same.ok) {
    return revert(`the fix changed behavior on the benign input "${benignArg}" (${same.why})`, { postRuns, benign: { argument: benignArg, before: pick(benignBefore), after: pick(benignAfter) } });
  }

  const testsAfter = testCmd.program ? await runTest(cx, ws, testCmd, actor) : null;
  const verdict = testsOk(testsBefore, testsAfter);
  if (!verdict.ok) return revert(`the workspace's tests regressed (${verdict.why})`, { postRuns, tests: testsAfter ? { before: testsBefore, after: testsAfter } : null });

  return {
    ...base,
    status: f.drive === "write" ? "hardened" : "closed",
    change: applied.change, digest: applied.digest, diff: applied.summary,
    guard: fix.new.split("\n")[0].trim().slice(0, 240),
    payload: p,
    proof: {
      before: f.drive === "write" ? "the code followed the attacker's path and only the sandbox refused it" : "the payload reproduced on the unchanged code",
      after: f.drive === "write" ? "the code itself now refuses the attacker's path on both post-fix runs" : "the payload no longer reproduces on either post-fix run",
      benign: { argument: benignArg, before: pick(benignBefore), after: pick(benignAfter), equivalent: true },
      tests: testCmd.program ? { before: testsBefore, after: testsAfter } : { ran: false, reason: testCmd.reason },
    },
    postRuns,
    note: "proven for this payload, this benign input and these tests — not for every input or every class",
  };
}

const needsRedesignEntry = (f) => ({
  id: f.id, class: f.class, severity: f.severity, file: f.file, line: f.line,
  status: "needs-redesign",
  reason: RECIPE_CLASSES.has(f.class) && !f.drive
    ? "the route starts at request data, stdin or the environment, so a fix cannot be proven here without a live request the sandbox does not grant; fix it by hand and let recon re-verify, or drive it once the entry point is reachable"
    : REDESIGN[f.class] ?? "no honest one-line guard exists for this class",
});

export async function repair(cx, req, actor) {
  if (!isObject(req)) throw new Refusal("bad-request", "repair takes an object");
  const ws = grantedWorkspace(cx.grant, requireString(req.workspace, "workspace"));
  const limit = Math.min(Math.max(1, Number(req.limit ?? 10)), 25);
  const onlyClasses = Array.isArray(req.classes) ? new Set(req.classes.map(String)) : null;
  const s = scanWorkspace(cx, ws.root);
  const testCmd = detectTest(req, s.pkg);

  const targets = s.findings
    .filter((f) => RECIPE_CLASSES.has(f.class) && f.drive && (!onlyClasses || onlyClasses.has(f.class)) && (req.file === undefined || f.file === req.file))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.line - b.line)
    .slice(0, limit);
  const inTargets = new Set(targets.map((f) => f.id));

  const redesign = [];
  const skipped = [];
  for (const f of s.findings) {
    if (inTargets.has(f.id)) continue;
    if (!f.drive || !RECIPE_CLASSES.has(f.class)) redesign.push(needsRedesignEntry(f));
    else skipped.push({ id: f.id, class: f.class, file: f.file, line: f.line, reason: "not attempted under this call's filters or limit — call again with wider filters" });
  }
  const redesignTotal = redesign.length;

  // A benign input shared by every guard recipe: a stable file the attacker never controls, so
  // behavior before and after a fix is compared on ground that does not move.
  let benignChange = null;
  if (targets.some((f) => f.drive === "exec" || f.drive === "read")) {
    try {
      const c = await edit(cx, { workspace: ws.root, path: BENIGN_INPUT, content: "context repair benign input\n", create: true }, actor);
      benignChange = c.change ?? null;
    } catch { /* it already exists; the name still serves */ }
  }

  const results = [];
  let seq = 0;
  for (const f of targets) {
    seq += 1;
    results.push(await repairOne(cx, ws, f, seq, testCmd, actor));
  }

  let benignLeft = false;
  if (benignChange) {
    try {
      await undo(cx, { change: benignChange }, actor);
    } catch {
      benignLeft = true;
    }
  }

  const summary = {
    attempted: results.length,
    closed: results.filter((r) => r.status === "closed").length,
    hardened: results.filter((r) => r.status === "hardened").length,
    reverted: results.filter((r) => r.status === "reverted" || r.status === "revert-failed").length,
    notOpen: results.filter((r) => r.status === "not-open").length,
    notFixed: results.filter((r) => r.status === "not-fixed").length,
    needsRedesign: redesignTotal,
  };
  cx.ledger.append("repair", {
    workspace: ws.root, at: now(), ...summary,
    results: results.map((r) => `${r.file}:${r.line} ${r.class} ${r.status}`),
    by: actor,
  });
  return {
    workspace: ws.root,
    at: now(),
    scanned: s.scanned,
    findings: s.findings.length,
    repairs: results,
    needsRedesign: redesign.slice(0, MAX_LIST),
    redesignTruncated: Math.max(0, redesignTotal - MAX_LIST),
    skipped,
    summary,
    ...(benignLeft ? { leftover: `${BENIGN_INPUT} could not be removed after the run; undo its edit with context_edit {action: "undo"} when the workspace is quiet` } : {}),
    coverage: {
      recipes: [
        "guard untrusted command arguments before a shell runs (JS template exec, Python os.system/subprocess)",
        "restrict eval to a literal arithmetic expression, preserving evaluation of the allowed subset",
        "refuse absolute and parent-relative paths before any filesystem call (JS fs calls, Python open)",
      ],
      tests: testCmd.program ? { program: testCmd.program, args: testCmd.args } : { ran: false, reason: testCmd.reason },
      method: "per finding: reproduce the payload once on the unchanged code, apply one reversible guard edit, re-drive the payload twice (it must no longer reproduce), re-run a benign input (behavior must be identical) and the workspace's tests (they must not regress); any failed proof reverts the fix",
      note: "Closed means proven for the payload driven, the benign input observed and the tests run — never for every input or every class. Needs-redesign routes are returned with reasoning, not skipped. Every fix is one undoable edit; a reverted fix leaves the code exactly as it was.",
    },
  };
}
