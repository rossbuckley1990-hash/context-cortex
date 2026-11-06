// Evolve: revisit what is stale, unfinished or failed, and re-decide it from fresh evidence.
// A changed program gets its experiments re-run; a witness whose program or decoder changed is
// recalibrated; a skill that is not usable is crystallised again. The report says what moved.
import { replay } from "./replay.js";
import { canonical, Refusal } from "./util.js";

const usableStatuses = ["established", "revalidated"];

export async function evolve(cx, { operation, limit = 10 } = {}, actor) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Refusal("bad-request", "limit must be 1 to 50");
  const s = cx.state.refresh();
  const before = Object.fromEntries(Object.values(s.claims).map((c) => [c.claim.id, cx.claimView(c).state]));
  const skillsBefore = Object.fromEntries(Object.values(s.skills).map((k) => [k.id, k.status]));

  const targets = Object.values(s.operations).filter((o) => {
    if (operation) return o.def.id === operation;
    if (cx.currentPin(o.def.program) === null) return false; // gone or ungranted: nothing to re-run
    const states = Object.values(s.claims).filter((c) => c.claim.operation === o.def.id).map((c) => cx.claimView(c).state);
    return states.some((st) => st === "stale" || st === "observed" || st === "hypothesised");
  });
  if (operation && !targets.length) throw new Refusal("unknown-operation", `no operation ${operation}`);
  const experiments = [];
  const seen = new Set();
  for (const o of targets) {
    for (const e of Object.values(s.experiments).filter((x) => x.operation === o.def.id).reverse()) {
      const key = canonical({ trials: e.spec.trials, hypotheses: e.spec.hypotheses, controls: e.spec.controls });
      if (seen.has(key)) continue;
      seen.add(key);
      experiments.push({ operation: e.operation, spec: e.spec });
    }
  }
  const chosen = experiments.slice(0, limit);
  const witnesses = Object.values(s.witnesses)
    .filter((w) => w.origin !== "built-in" && w.calibrationSpec && !cx.witnessCurrent(s, w).ok && w.calibration.status !== "failed")
    .map((w) => ({ id: w.id, definition: w.def, calibrationSpec: w.calibrationSpec }));
  const replayed = await replay(cx, { experiments: chosen, witnesses }, actor);

  const mid = cx.state.refresh();
  const stuck = Object.values(mid.skills).filter((k) => k.definition && (!usableStatuses.includes(k.status) || k.prerequisites.programs.some((p) => cx.currentPin(p.path) !== p.digest)));
  const skills = await replay(cx, { skills: stuck.map((k) => k.definition) }, actor);

  const after = cx.state.refresh();
  const changes = [];
  for (const c of Object.values(after.claims)) {
    const now = cx.claimView(c).state;
    if (before[c.claim.id] !== now) changes.push({ claim: c.claim.id, from: before[c.claim.id] ?? "absent", to: now });
  }
  const skillChanges = Object.values(after.skills).filter((k) => skillsBefore[k.id] !== k.status).map((k) => ({ skill: k.id, from: skillsBefore[k.id] ?? "absent", to: k.status }));
  cx.ledger.append("evolve", { operations: targets.map((o) => o.def.id), experiments: chosen.length, witnesses: witnesses.length, skills: stuck.map((k) => k.id), changes: changes.length });
  return {
    revisited: { operations: targets.map((o) => o.def.id), experiments: chosen.length, skippedExperiments: experiments.length - chosen.length, witnesses: witnesses.map((w) => w.id), skills: stuck.map((k) => k.id) },
    claimChanges: changes,
    newlyEstablished: changes.filter((c) => c.to === "established").map((c) => c.claim),
    newlyContradicted: changes.filter((c) => c.to === "contradicted").map((c) => c.claim),
    skillChanges,
    errors: [...replayed.errors, ...skills.errors],
  };
}
