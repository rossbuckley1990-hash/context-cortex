// Skills: demonstrated workflows crystallised into executable, self-testing contracts.
import { copyFileSync } from "node:fs";
import { confirms, detect } from "./formats.js";
import { grantedWrite } from "./grant.js";
import { digestOf, isObject, now, Refusal, requireId, requireString } from "./util.js";

const REF = /^(input\.([A-Za-z0-9_-]+)|steps\.([a-z0-9][a-z0-9-]*)\.([A-Za-z0-9_-]+))$/;

/** Validate a skill definition and resolve its fixtures to artefacts. Returns the normalised definition. */
function normalise(cx, s, def) {
  if (!isObject(def)) throw new Refusal("bad-request", "skill definition must be an object");
  const id = requireId(def.id, "skill.id");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Refusal("bad-request", "skill.id must match [a-z0-9][a-z0-9-]*");
  const title = requireString(def.title, "skill.title");
  const objective = requireString(def.objective, "skill.objective");
  if (!isObject(def.inputs) || !Object.keys(def.inputs).length) throw new Refusal("bad-request", "skill.inputs must declare at least one input format");
  if (!Array.isArray(def.steps) || !def.steps.length) throw new Refusal("bad-request", "skill.steps must list at least one step");
  const formats = {}; // ref -> declared format
  for (const [n, f] of Object.entries(def.inputs)) formats[`input.${n}`] = requireString(f, `skill.inputs.${n}`);
  const steps = [];
  const seen = new Set();
  for (const [i, st] of def.steps.entries()) {
    if (!isObject(st)) throw new Refusal("bad-request", `steps[${i}] must be an object`);
    const sid = requireString(st.id, `steps[${i}].id`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(sid) || seen.has(sid)) throw new Refusal("bad-request", `steps[${i}].id must be unique and match [a-z0-9][a-z0-9-]*`);
    seen.add(sid);
    const op = s.operations[st.operation];
    if (!op) throw new Refusal("unknown-operation", `steps[${i}] uses unknown operation ${st.operation}`);
    if (!isObject(st.bind)) throw new Refusal("bad-request", `steps[${i}].bind must map each operation input to input.<name> or steps.<id>.<output>`);
    for (const [port, format] of Object.entries(op.def.inputs)) {
      const ref = st.bind[port];
      if (typeof ref !== "string" || !REF.test(ref)) throw new Refusal("bad-request", `steps[${i}].bind.${port} must be input.<name> or steps.<id>.<output>`);
      if (!(ref in formats)) throw new Refusal("bad-request", `steps[${i}].bind.${port} refers to ${ref}, which is not a skill input or an earlier step's output`);
      if (formats[ref] !== format) throw new Refusal("format-mismatch", `steps[${i}] feeds ${formats[ref]} from ${ref} into ${st.operation}.${port}, which takes ${format}`);
    }
    for (const port of Object.keys(st.bind)) if (!(port in op.def.inputs)) throw new Refusal("bad-request", `steps[${i}].bind names an unknown input ${port}`);
    for (const [port, format] of Object.entries(op.def.outputs)) formats[`steps.${sid}.${port}`] = format;
    steps.push({ id: sid, operation: st.operation, bind: { ...st.bind } });
  }
  const output = requireString(def.output, "skill.output");
  if (!output.startsWith("steps.") || !(output in formats)) throw new Refusal("bad-request", "skill.output must be steps.<id>.<output> of a step");
  const preserve = Array.isArray(def.preserve) ? def.preserve.map((p) => requireString(p, "skill.preserve[]")) : [];
  const successConditions = (def.successConditions ?? []).map((c, i) => {
    if (!isObject(c) || !isObject(c.bind)) throw new Refusal("bad-request", `successConditions[${i}] must be {witness, bind, property?}`);
    const w = cx.witnessRecord(s, c.witness);
    if (!w) throw new Refusal("unknown-witness", `successConditions[${i}] uses unknown witness ${c.witness}`);
    for (const p of w.def.params) {
      if (typeof c.bind[p] !== "string" || !(c.bind[p] in formats)) throw new Refusal("bad-request", `successConditions[${i}].bind.${p} must be a skill input or step output`);
    }
    return { witness: c.witness, bind: { ...c.bind }, ...(c.property ? { property: String(c.property) } : {}), ...(c.check ? { check: String(c.check) } : {}) };
  });
  if (!successConditions.length) throw new Refusal("bad-request", "a skill needs at least one success condition checked by a calibrated witness");
  const fixtures = def.selfTest?.fixtures;
  if (!Array.isArray(fixtures)) throw new Refusal("bad-request", "skill.selfTest.fixtures must be an array");
  if (!fixtures.some((f) => f?.expect === "pass") || !fixtures.some((f) => f?.expect === "refuse")) {
    throw new Refusal("bad-request", "the self-test needs at least one fixture expected to pass and one expected to be refused");
  }
  const resolvedFixtures = fixtures.map((f, i) => {
    const inputs = {};
    for (const n of Object.keys(def.inputs)) inputs[n] = cx.resolveSource(f.inputs?.[n], `selfTest.fixtures[${i}].inputs.${n}`).digest;
    return { id: requireString(f.id, `selfTest.fixtures[${i}].id`), inputs, expect: f.expect };
  });
  const limitations = (def.limitations ?? []).map((l) => ({ text: requireString(l?.text, "limitations[].text"), ...(l.claim ? { claim: String(l.claim) } : {}), ...(l.inputClass ? { inputClass: String(l.inputClass) } : {}) }));
  return { id, title, objective, inputs: { ...def.inputs }, steps, output, preserve, successConditions, limitations, selfTest: { fixtures: resolvedFixtures }, outputFormat: formats[output] };
}

/** What a skill depends on, and what stops it from being established. */
function prerequisites(cx, s, def) {
  const gaps = [];
  const claims = new Set();
  const limitations = [];
  const programs = new Map();
  for (const st of def.steps) {
    const op = s.operations[st.operation];
    const pinNow = cx.currentPin(op.def.program);
    if (pinNow !== op.pin.digest) gaps.push(`${st.operation}: its program changed or is no longer granted; re-run its experiments`);
    programs.set(op.pin.path, { path: op.pin.path, digest: op.pin.digest });
    const needed = [...Object.keys(op.def.inputs).map((n) => `${st.operation}:accepts:${n}`), ...Object.keys(op.def.outputs).map((n) => `${st.operation}:produces:${n}`)];
    for (const id of needed) {
      const c = cx.claimView(s.claims[id]);
      if (!c) gaps.push(`${id}: no evidence yet`);
      else if (c.state !== "established") gaps.push(`${id} is ${c.state}${c.reasons?.length ? ` (${c.reasons.join("; ")})` : ""}`);
      claims.add(id);
    }
    for (const c of Object.values(s.claims).filter((c) => c.claim.operation === st.operation)) {
      const v = cx.claimView(c);
      if (v.state === "contradicted") limitations.push({ text: `${st.operation}: contradicted: ${v.statement.text}`, claim: v.id });
    }
  }
  const preservedBy = {};
  for (const p of def.preserve) {
    const cond = def.successConditions.find((c) => c.property === p);
    if (cond) {
      preservedBy[p] = `checked end to end by ${cond.witness} on every run`;
      continue;
    }
    const perStep = def.steps.map((st) => Object.values(s.claims).map((c) => cx.claimView(c)).find((c) => c.operation === st.operation && c.kind === "preservation" && c.statement.property === p && c.state === "established"));
    if (perStep.every(Boolean)) {
      perStep.forEach((c) => claims.add(c.id));
      preservedBy[p] = `established for every step (${perStep.map((c) => c.id).join(", ")})`;
    } else gaps.push(`preserve ${p}: neither an end-to-end success condition with property ${p} nor an established ${p} preservation claim for every step`);
  }
  for (const c of def.successConditions) {
    const w = cx.witnessRecord(s, c.witness);
    const cur = cx.witnessCurrent(s, w);
    if (!cur.ok) gaps.push(`success condition ${c.witness}: ${cur.reason}`);
    if (w?.def.program) programs.set(w.def.program, { path: w.def.program, digest: w.pins.program });
    for (const opId of Object.values(w?.def.via ?? {})) {
      const op = s.operations[opId];
      if (op) programs.set(op.pin.path, { path: op.pin.path, digest: op.pin.digest });
    }
  }
  return { gaps, claims: [...claims], limitations, programs: [...programs.values()], preservedBy };
}

/** Execute a skill's pipeline on input artefacts. Refuses instead of returning an unchecked result. */
async function execute(cx, s, def, inputs, { role = "skill-run" } = {}) {
  for (const [n, format] of Object.entries(def.inputs)) {
    const meta = cx.artefacts.meta(inputs[n]);
    const ok = confirms({ format: meta.format }, format);
    if (ok === false) return { status: "refused", reason: `input ${n} is ${meta.format ?? "unrecognised"}, the skill takes ${format}`, steps: [], conditions: [] };
  }
  const values = Object.fromEntries(Object.entries(inputs).map(([n, d]) => [`input.${n}`, d]));
  const steps = [];
  for (const st of def.steps) {
    const op = s.operations[st.operation];
    const bound = Object.fromEntries(Object.entries(st.bind).map(([port, ref]) => [port, values[ref]]));
    const r = await cx.runOperation(op, bound, { role, expect: "success" });
    steps.push({ step: st.id, trial: r.ref, outcome: r.success ? "success" : "failure", exitCode: r.exitCode });
    if (!r.success) return { status: "refused", reason: `step ${st.id} (${st.operation}) failed with exit ${r.exitCode}${r.stderrTail ? `: ${r.stderrTail.trim().slice(-200)}` : ""}`, steps, conditions: [] };
    for (const [port, o] of Object.entries(r.outputs)) values[`steps.${st.id}.${port}`] = o.digest;
  }
  const conditions = [];
  for (const c of def.successConditions) {
    const w = cx.witnessRecord(s, c.witness);
    const bind = Object.fromEntries(Object.entries(c.bind).map(([p, ref]) => [p, values[ref]]));
    const v = await cx.runWitness(s, w, bind);
    conditions.push({ witness: c.witness, accept: v.accept, reason: v.reason, run: v.ref });
    if (!v.accept) return { status: "refused", reason: `success condition ${c.witness} rejected the result (${v.reason})`, steps, conditions };
  }
  const out = cx.artefacts.meta(values[def.output]);
  return { status: "completed", output: { digest: out.digest, size: out.size, format: out.format }, steps, conditions };
}

/** Crystallise a definition into a skill. It is established only if every prerequisite holds and the self-test passes. */
export async function crystallize(cx, def, actor, { status: importedStatus } = {}) {
  return cx.state.mutate(async (s) => {
    const d = normalise(cx, s, def);
    const pre = prerequisites(cx, s, d);
    const selfTest = [];
    if (!pre.gaps.length) {
      for (const f of d.selfTest.fixtures) {
        const r = await execute(cx, s, d, f.inputs, { role: "self-test" });
        selfTest.push({ fixture: f.id, expect: f.expect, result: r.status, ...(r.reason ? { reason: r.reason } : {}), ok: (f.expect === "pass") === (r.status === "completed"), runs: [...r.steps.map((x) => x.trial), ...r.conditions.map((x) => x.run)] });
      }
    }
    const passed = !pre.gaps.length && selfTest.every((t) => t.ok);
    const status = passed ? (importedStatus === "revalidate" ? "revalidated" : "established") : importedStatus === "revalidate" ? "contradicted-here" : "draft";
    const demonstrations = selfTest.flatMap((t) => t.runs);
    const ops = d.steps.map((st) => s.operations[st.operation]);
    const skill = {
      schema: "context-cortex/skill/v0",
      id: d.id,
      title: d.title,
      objective: d.objective,
      goal: { have: Object.values(d.inputs), want: [d.outputFormat], ...(d.preserve.length ? { preserve: d.preserve } : {}) },
      steps: d.steps.map((st) => ({ id: st.id, operation: st.operation, bind: st.bind })),
      prerequisites: {
        programs: pre.programs,
        formats: [...new Set([...Object.values(d.inputs), d.outputFormat])],
        claims: pre.claims,
        authority: { effectClasses: ["sandbox-write"], executables: [...new Set(pre.programs.map((p) => p.path))], network: false },
      },
      successConditions: d.successConditions.map((c) => ({ witness: c.witness, check: c.check ?? (c.property ? `${c.property} preserved` : "accepted by the witness"), on: d.output, ...(c.property ? { property: c.property } : {}) })),
      limitations: [...d.limitations, ...pre.limitations.filter((l) => !d.limitations.some((x) => x.claim === l.claim))],
      provenance: { acquiredBy: actor, acquiredAt: now(), demonstrations: demonstrations.length ? demonstrations : [], operations: ops.map((o) => o.def.id) },
      selfTest: { fixtures: d.selfTest.fixtures },
      definition: d,
      status,
    };
    const { status: _st, revision: _rv, provenance: _pv, ...content } = skill;
    skill.revision = digestOf(content);
    if (passed || !s.skills[d.id] || s.skills[d.id].status !== "established") s.skills[d.id] = skill;
    cx.ledger.append("skill", { skill: d.id, revision: skill.revision, status, gaps: pre.gaps, selfTest: selfTest.map(({ runs, ...t }) => t) });
    return {
      skill: d.id,
      revision: skill.revision,
      status,
      ...(pre.gaps.length ? { gaps: pre.gaps } : {}),
      preservedBy: pre.preservedBy,
      selfTest: selfTest.map(({ runs, ...t }) => t),
      limitations: skill.limitations,
      ...(passed ? {} : { kept: s.skills[d.id] === skill ? "this definition (not established)" : "the earlier established revision" }),
    };
  });
}

export function listSkills(cx) {
  const s = cx.state.refresh();
  return Object.values(s.skills).map((k) => ({ id: k.id, title: k.title, status: k.status, have: k.goal.have, want: k.goal.want, preserve: k.goal.preserve ?? [], usable: usable(cx, s, k).ok }));
}

function usable(cx, s, k) {
  if (!["established", "revalidated"].includes(k.status)) return { ok: false, reason: `skill ${k.id} is ${k.status}` };
  for (const p of k.prerequisites.programs) if (cx.currentPin(p.path) !== p.digest) return { ok: false, reason: `program ${p.path} changed or is no longer granted since the skill was ${k.status}; revalidate it` };
  for (const c of k.successConditions) {
    const cur = cx.witnessCurrent(s, cx.witnessRecord(s, c.witness));
    if (!cur.ok) return { ok: false, reason: cur.reason };
  }
  return { ok: true };
}

export function explainSkill(cx, id) {
  const s = cx.state.refresh();
  const k = s.skills[id];
  if (!k) throw new Refusal("unknown-skill", `no skill ${id}`);
  const { definition, ...rest } = k;
  return { ...rest, usable: usable(cx, s, k) };
}

/** Run an established skill. Inputs are sources; `deliver` copies the output into a write root. */
export async function runSkill(cx, id, inputs, { deliver } = {}) {
  return cx.state.mutate(async (s) => {
    const k = s.skills[id];
    if (!k) throw new Refusal("unknown-skill", `no skill ${id}`);
    const u = usable(cx, s, k);
    if (!u.ok) throw new Refusal("not-usable", u.reason);
    const target = deliver ? grantedWrite(cx.grant, deliver) : null;
    const resolved = {};
    for (const n of Object.keys(k.definition.inputs)) resolved[n] = cx.resolveSource(inputs?.[n], `inputs.${n}`).digest;
    const r = await execute(cx, s, k.definition, resolved);
    cx.ledger.append("skill-run", { skill: id, revision: k.revision, inputs: resolved, status: r.status, output: r.output?.digest ?? null });
    if (r.status === "completed" && target) {
      copyFileSync(cx.artefacts.path(r.output.digest), target);
      r.delivered = target;
    }
    return {
      skill: id,
      revision: k.revision,
      ...r,
      ...(r.status === "completed" ? { assurance: `checked by ${k.successConditions.map((c) => c.witness).join(", ")}; programs pinned; run confined`, outputPath: cx.artefacts.path(r.output.digest) } : {}),
      limitations: k.limitations,
    };
  });
}

export { detect };
