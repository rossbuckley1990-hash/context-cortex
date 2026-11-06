// Simulation and automatic composition.
// simulate: run candidate routes side by side on real inputs, sandboxed, nothing delivered,
//   and compare what they actually did.
// compose: turn the best route whose claims are all established into a skill, generating its
//   success conditions from the evidence and its self-test fixtures from stored samples.
import { confirms, detect } from "./formats.js";
import { goal } from "./goal.js";
import { crystallize, runSkill } from "./skills.js";
import { isObject, Refusal, requireString } from "./util.js";

const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "skill";

function chain(s, operations, have) {
  let format = have;
  const steps = [];
  for (const [i, id] of operations.entries()) {
    const op = s.operations[id];
    if (!op) throw new Refusal("unknown-operation", `no operation ${id}`);
    const ins = Object.entries(op.def.inputs);
    if (ins.length !== 1) throw new Refusal("bad-request", `${id} takes ${ins.length} inputs; routes use single-input operations`);
    if (ins[0][1] !== format) throw new Refusal("format-mismatch", `step ${i + 1} (${id}) takes ${ins[0][1]}, but receives ${format}`);
    const [outName, outFormat] = Object.entries(op.def.outputs)[0];
    steps.push({ op, input: ins[0][0], output: outName, from: format, to: outFormat });
    format = outFormat;
  }
  return { steps, produces: format };
}

/** Run routes on inputs and compare them. Nothing is crystallised or delivered. */
export async function simulate(cx, req, actor) {
  const have = requireString(req?.have, "have");
  const want = requireString(req?.want, "want");
  const preserve = Array.isArray(req.preserve) ? req.preserve.map(String) : [];
  const inputs = Array.isArray(req.inputs) ? req.inputs : req.input !== undefined ? [req.input] : [];
  if (!inputs.length || inputs.length > 3) throw new Refusal("bad-request", "simulate takes 1 to 3 inputs");
  const s0 = cx.state.refresh();
  const candidates = Array.isArray(req.routes) && req.routes.length ? req.routes.map((r) => ({ operations: r })) : goal(cx, { have, want, preserve }).routes.slice(0, 5);
  if (!candidates.length) return { goal: { have, want, preserve }, routes: [], note: "no route connects these formats; context_gap shows what to learn" };
  const witness = req.witness ? cx.witnessRecord(s0, req.witness) : null;
  if (req.witness && !witness) throw new Refusal("unknown-witness", `no witness ${req.witness}`);
  if (witness && witness.def.params.length !== 2) throw new Refusal("bad-request", "simulate's witness compares two params: the input and the route's output");
  return cx.state.mutate(async (s) => {
    const resolved = inputs.map((src, i) => cx.resolveSource(src, `inputs[${i}]`).digest);
    const results = [];
    for (const cand of candidates) {
      const { steps, produces } = chain(s, cand.operations, have);
      const runs = [];
      let ms = 0;
      for (const d of resolved) {
        let current = d, failed = null;
        for (const st of steps) {
          const r = await cx.runOperation(st.op, { [st.input]: current }, { role: "simulate", expect: "success" });
          ms += r.durationMs;
          if (!r.success) {
            failed = `${st.op.def.id} exited ${r.exitCode}`;
            break;
          }
          current = r.outputs[st.output].digest;
        }
        const out = failed ? null : cx.artefacts.meta(current);
        let checked = null;
        if (out && witness) {
          const cur = cx.witnessCurrent(s, witness);
          if (cur.ok) {
            const v = await cx.runWitness(s, witness, { [witness.def.params[0]]: d, [witness.def.params[1]]: current });
            checked = v.accept;
          }
        }
        runs.push({ input: d, ...(failed ? { failed } : { output: { digest: out.digest, size: out.size, format: out.format }, formatOk: confirms(detect(cx.artefacts.get(out.digest)), want) === true }), ...(checked !== null ? { witness: checked } : {}) });
      }
      const views = Object.values(s.claims).map((c) => cx.claimView(c));
      const proven = Object.fromEntries(preserve.map((p) => [p, steps.every((st) => views.some((c) => c.operation === st.op.def.id && c.kind === "preservation" && c.statement.property === p && c.state === "established"))]));
      const ok = runs.every((r) => !r.failed && r.formatOk && r.witness !== false);
      results.push({
        operations: cand.operations, produces, ok, proven, runs,
        totalOutputBytes: runs.reduce((n, r) => n + (r.output?.size ?? 0), 0), durationMs: ms,
      });
    }
    results.sort((a, b) => Number(b.ok) - Number(a.ok) || Object.values(b.proven).filter(Boolean).length - Object.values(a.proven).filter(Boolean).length || a.operations.length - b.operations.length || a.totalOutputBytes - b.totalOutputBytes);
    cx.ledger.append("simulation", { have, want, preserve, inputs: resolved, routes: results.map((r) => ({ operations: r.operations, ok: r.ok })), by: actor });
    return {
      goal: { have, want, preserve },
      best: results[0]?.ok ? results[0].operations : null,
      routes: results,
      note: "Simulation runs each route sandboxed on your inputs and delivers nothing. 'proven' means every step has an established preservation claim; 'witness' is the check you supplied, run on this input.",
    };
  });
}

function hypothesisBinding(s, claimId) {
  const c = s.claims[claimId];
  const hypId = claimId.slice(c.claim.operation.length + 1);
  for (const e of Object.values(s.experiments).filter((x) => x.operation === c.claim.operation).reverse()) {
    const h = e.spec.hypotheses.find((x) => x.id === hypId);
    if (h) return h.check;
  }
  return null;
}

/** Compose a skill from the best ready route, and optionally run it. */
export async function compose(cx, req, actor) {
  const have = requireString(req?.have, "have");
  const want = requireString(req?.want, "want");
  const preserve = Array.isArray(req.preserve) ? req.preserve.map(String) : [];
  const g = goal(cx, { have, want, preserve });
  const route = req.operations ? { operations: req.operations } : g.routes.find((r) => r.ready);
  if (!route) {
    const { gap } = await import("./goal.js");
    return { status: "no-ready-route", goal: g.goal, routes: g.routes.map(({ steps, gaps }) => ({ steps, gaps })), drafts: gap(cx, { have, want, preserve }).drafts, note: "no route has every claim established; submit the drafts, then compose again" };
  }
  const s = cx.state.refresh();
  const { steps, produces } = chain(s, route.operations, have);
  if (produces !== want) throw new Refusal("format-mismatch", `the route produces ${produces}, not ${want}`);
  const refs = steps.map((st, i) => ({ id: `s${i + 1}`, inRef: i === 0 ? "input.input" : `steps.s${i}.${steps[i - 1].output}`, outRef: `steps.s${i + 1}.${st.output}`, st }));

  // Success conditions: for each preserved property, every step's own established witness check, re-run on that step.
  const successConditions = [];
  for (const p of preserve) {
    for (const r of refs) {
      const claim = Object.values(s.claims).map((c) => cx.claimView(c)).find((c) => c.operation === r.st.op.def.id && c.kind === "preservation" && c.statement.property === p && c.state === "established");
      const check = claim && hypothesisBinding(s, claim.id);
      if (!check) throw new Refusal("not-established", `${r.st.op.def.id} has no established ${p} claim with a witness to re-run`);
      const bind = Object.fromEntries(Object.entries(check.bind).map(([param, ref]) => [param, ref.startsWith("input.") ? r.inRef : r.outRef]));
      successConditions.push({ witness: check.witness, property: p, bind, check: `${p} preserved by ${r.st.op.def.id}` });
    }
  }
  if (!successConditions.length) {
    let w = Object.values(s.witnesses).find((x) => x.def.builtin === "format-is" && x.def.format === want && cx.witnessCurrent(s, x).ok);
    if (!w) {
      const refsOfWant = cx.artefactList({ format: want, limit: 3 }).map((a) => a.digest);
      if (refsOfWant.length) {
        const id = `format-is.${slug(want)}`;
        await cx.calibrate({ witness: { id, builtin: "format-is", format: want, params: ["candidate"] }, references: refsOfWant.map((d) => ({ bind: { candidate: d } })), mutate: { param: "candidate", kinds: ["corrupt-header", "empty"] } }, actor);
        w = cx.witnessRecord(cx.state.refresh(), id);
        if (w?.calibration.status !== "calibrated") w = null;
      }
    }
    successConditions.push(w ? { witness: w.id, bind: { candidate: refs.at(-1).outRef }, check: `output is ${want}` } : { witness: "builtin:nonempty", bind: { candidate: refs.at(-1).outRef }, check: "output is non-empty" });
  }

  const pass = (req.fixtures?.pass ?? cx.artefactList({ format: have, limit: 2 }).map((a) => a.digest)).slice(0, 3);
  if (!pass.length) throw new Refusal("bad-request", `no stored sample of ${have} to self-test with; pass fixtures.pass`);
  const decoy = have === "image/png" ? { base64: "H4sIAAAAAAAAAwMAAAAAAAAAAAA=" } : { base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ" };
  const refuse = req.fixtures?.refuse ?? [decoy];
  const def = {
    id: req.id ?? slug(`${have}-to-${want}${preserve.length ? `-${preserve.join("-")}` : ""}`),
    title: req.title ?? `${have} to ${want}${preserve.length ? `, preserving ${preserve.join(" and ")}` : ""}`,
    objective: req.objective ?? `Turn ${have} into ${want}${preserve.length ? ` with ${preserve.join(", ")} preserved` : ""} via ${route.operations.join(" → ")}.`,
    inputs: { input: have },
    steps: refs.map((r) => ({ id: r.id, operation: r.st.op.def.id, bind: { [r.st.input]: r.inRef } })),
    output: refs.at(-1).outRef,
    preserve,
    successConditions,
    selfTest: { fixtures: [...pass.map((p, i) => ({ id: `sample-${i + 1}`, inputs: { input: p }, expect: "pass" })), ...refuse.map((r, i) => ({ id: `wrong-format-${i + 1}`, inputs: { input: r }, expect: "refuse" }))] },
  };
  const crystallised = await crystallize(cx, def, actor);
  const out = { status: crystallised.status, route: route.operations, skill: def.id, crystallised };
  if (isObject(req.run) && crystallised.status === "established") out.run = await runSkill(cx, def.id, { input: req.run.input }, { deliver: req.run.deliver });
  return out;
}
