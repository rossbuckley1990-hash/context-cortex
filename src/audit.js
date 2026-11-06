// Audit: hunt for weaknesses in an operation by adversarial trials on real inputs. The battery
// feeds each known-good sample every kind of deterministic damage; every run is confined and
// ledgered like any trial. A finding counts only when it reproduces on a repeat run, and the
// engine — not the caller — decides the failure claims from the evidence: a clean refusal
// supports rejects:<damage>, an accepted damaged input refutes it. What was not tested is said.
import { MUTATIONS } from "./formats.js";
import { digestOf, isObject, now, Refusal } from "./util.js";

const RESOURCE_SIGNALS = new Set(["SIGKILL", "SIGXCPU", "SIGXFSZ"]);
const SIGNAL_NAMES = { 1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 4: "SIGILL", 5: "SIGTRAP", 6: "SIGABRT", 7: "SIGBUS", 8: "SIGFPE", 9: "SIGKILL", 10: "SIGUSR1", 11: "SIGSEGV", 12: "SIGUSR2", 13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM", 17: "SIGCHLD", 18: "SIGCONT", 19: "SIGSTOP", 20: "SIGTSTP", 21: "SIGTTIN", 22: "SIGTTOU", 23: "SIGURG", 24: "SIGXCPU", 25: "SIGXFSZ", 27: "SIGPROF", 29: "SIGIO", 31: "SIGSYS" };

/**
 * What one run's outcome means as a weakness, or null for a clean refusal (a damaged input
 * rejected loudly: non-zero exit, no output, no signal).
 */
function classify(r) {
  if (r.timedOut) return { class: "hang", severity: "medium", detail: "did not finish within the trial timeout" };
  if (r.overflow) return { class: "output-flood", severity: "low", detail: "produced more output than the limit allows" };
  // A death by signal arrives two ways: directly (exitCode null, signal set — sandbox-exec execs
  // the program, so it is our own child), or through a forking wrapper such as bubblewrap, which
  // reports it as the shell convention 128+signal. The two cannot be told apart from the outside,
  // so both are the same finding, with the form seen named in the detail.
  let signal = r.exitCode === null ? r.signal : null;
  let viaExit = false;
  if (!signal && Number.isInteger(r.exitCode) && r.exitCode > 128 && r.exitCode <= 160) {
    signal = SIGNAL_NAMES[r.exitCode - 128] ?? null;
    viaExit = !!signal;
  }
  if (signal) {
    const form = viaExit ? `exit code ${r.exitCode} (128+${r.exitCode - 128}), the wrapper-reported form of death by ${signal}` : `killed by ${signal}`;
    if (RESOURCE_SIGNALS.has(signal)) return { class: "resource-kill", severity: "medium", detail: `${form}: a CPU-time, file-size or output limit` };
    return { class: "crash", severity: "high", detail: form };
  }
  if (r.success) return { class: "silent-accept", severity: "high", detail: "exit 0 with output produced on damaged input: exit 0 is not success here" };
  return null;
}

const findingText = (op, run, finding, mutation) =>
  `${op.id} ${finding.class === "silent-accept" ? "accepts damaged input" : finding.class === "hang" ? "hangs" : finding.class === "crash" ? "crashes" : "overruns a limit"}: ${finding.detail}, when input ${run.input} is damaged by ${mutation.kind}`;

/**
 * Run the audit battery. spec: { operation: id or definition, inputs: {name: [source, …]},
 * kinds?: [damage kinds] }. Every declared input needs at least one known-good source; each is
 * damaged by each kind while the other inputs take their first source.
 */
export async function audit(cx, spec, actor) {
  if (!isObject(spec)) throw new Refusal("bad-request", "audit takes an object");
  const kinds = spec.kinds === undefined ? Object.keys(MUTATIONS) : spec.kinds.map(String);
  if (!kinds.length) throw new Refusal("bad-request", "audit needs at least one damage kind");
  for (const k of kinds) if (!MUTATIONS[k]) throw new Refusal("bad-request", `unknown damage kind ${k}; known: ${Object.keys(MUTATIONS).join(", ")}`);
  if (!isObject(spec.inputs)) throw new Refusal("bad-request", "audit.inputs must give known-good sources: {input name: [source, …]}");
  return cx.state.mutate(async (s) => {
    let opRec;
    if (typeof spec.operation === "string") {
      opRec = s.operations[spec.operation];
      if (!opRec) throw new Refusal("unknown-operation", `no operation ${spec.operation}; define it with context_experiment or pass a definition`);
    } else {
      opRec = cx.defineOperation(s, spec.operation);
    }
    const op = opRec.def;
    const sources = {};
    for (const name of Object.keys(op.inputs)) {
      const given = spec.inputs[name] === undefined ? [] : Array.isArray(spec.inputs[name]) ? spec.inputs[name] : [spec.inputs[name]];
      if (!given.length) throw new Refusal("bad-request", `audit.inputs needs at least one known-good source for ${name}, the input of ${op.id}`);
      sources[name] = given.map((src, i) => cx.resolveSource(src, `audit.inputs.${name}[${i}]`).digest);
    }
    for (const name of Object.keys(spec.inputs)) if (!(name in op.inputs)) throw new Refusal("bad-request", `audit.inputs names ${name}, which is not an input of ${op.id}`);

    const plan = [];
    for (const [name, digests] of Object.entries(sources)) for (const digest of digests) for (const kind of kinds) plan.push({ input: name, sample: digest, kind });
    const budget = cx.grant.limits.maxTrialsPerExperiment;
    // Worst case: every run is a candidate that must be repeated before it counts.
    if (plan.length * 2 > budget) throw new Refusal("over-budget", `the battery needs up to ${plan.length * 2} runs (${plan.length} trials plus repeats); the grant allows ${budget}. Give fewer samples or kinds.`);
    const auditId = `audit:${digestOf({ operation: op.id, plan, at: now() }).slice(7, 19)}`;

    const inputsFor = (run, mutated) => Object.fromEntries(Object.entries(sources).map(([n, digests]) => [n, n === run.input ? mutated : digests[0]]));
    const battery = [];
    for (const p of plan) {
      const mutated = cx.resolveSource({ mutate: { of: p.sample, kind: p.kind } }).digest;
      if (mutated === p.sample) continue; // the damage changed nothing (an empty input stays empty)
      const r = await cx.runOperation(opRec, inputsFor(p, mutated), { role: "audit", expect: "failure", experiment: auditId });
      battery.push({ ...p, mutated, run: r });
    }

    const findings = [];
    const unconfirmed = [];
    const repeats = [];
    for (const b of battery) {
      const finding = classify(b.run);
      if (!finding) continue;
      const repeat = await cx.runOperation(opRec, inputsFor(b, b.mutated), { role: "audit", expect: "failure", experiment: auditId });
      repeats.push({ ...b, run: repeat });
      const again = classify(repeat);
      const trials = [b.run.ref, repeat.ref];
      if (again?.class === finding.class) {
        findings.push({
          class: finding.class, severity: finding.severity, statement: findingText(op, b, finding, b),
          input: b.input, sample: b.sample, mutation: { kind: b.kind, of: b.sample, digest: b.mutated },
          exitCode: b.run.exitCode, signal: b.run.signal ?? null, reproduced: true, trials,
          claim: `${op.id}:rejects:${b.kind}`,
        });
      } else {
        unconfirmed.push({
          class: finding.class, statement: findingText(op, b, finding, b), input: b.input, mutation: { kind: b.kind, of: b.sample, digest: b.mutated },
          reproduced: false, reason: again ? `the repeat run was ${again.class}, not ${finding.class}` : "the repeat run refused the damaged input", trials,
        });
      }
    }

    const allRuns = [...battery, ...repeats];
    const controlResults = allRuns.map((x) => ({ ...x.run, kind: x.kind, base: x.mutated }));
    const touched = cx.recordAuditRuns(s, opRec, controlResults, actor, auditId);
    const claims = touched.map((id) => cx.claimView(s.claims[id]));
    const refusals = battery.filter((b) => !classify(b.run)).length;
    cx.ledger.append("audit", {
      audit: auditId, operation: op.id, program: { path: opRec.pin.path, digest: opRec.pin.digest }, by: actor,
      runs: allRuns.length, findings: findings.map(({ class: c, severity, statement, input, mutation, reproduced }) => ({ class: c, severity, statement, input, mutation: mutation.kind, reproduced })),
      unconfirmed: unconfirmed.length, refusals,
    });
    return {
      audit: auditId,
      operation: op.id,
      program: { path: opRec.pin.path, digest: opRec.pin.digest },
      sandbox: allRuns[0]?.run.sandbox ?? null,
      battery: { samples: Object.fromEntries(Object.entries(sources).map(([n, d]) => [n, d.length])), kinds, runs: battery.length, repeats: repeats.length },
      findings,
      unconfirmed,
      refusals,
      claims: claims.map((c) => ({ id: c.id, kind: c.kind, statement: c.statement.text, state: c.state, supporting: c.evidence.supporting.length, refuting: c.evidence.refuting.length, ...(c.reasons?.length ? { reasons: c.reasons } : {}) })),
      contradictions: claims.filter((c) => c.state === "contradicted").map((c) => c.statement.text),
      coverage: {
        inputsTested: Object.keys(sources),
        kindsTried: kinds,
        noOpMutations: plan.length - battery.length,
        note: "No finding means this battery found no reproducible weakness on these samples against this damage — not that the operation is safe.",
      },
    };
  });
}
