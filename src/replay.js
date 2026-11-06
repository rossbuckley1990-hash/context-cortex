// Re-run recorded work in dependency order: experiments whose witnesses are ready, then witness
// calibrations (which may need those experiments' operations established), then the rest, then
// skills. Used by transfer revalidation and by evolve.
import { crystallize } from "./skills.js";

export async function replay(cx, { experiments = [], witnesses = [], skills = [] }, actor, { skillStatus } = {}) {
  const out = { experiments: [], calibrations: [], skills: [], errors: [] };
  const pendingWitnesses = [...witnesses];
  const pendingExperiments = [...experiments];
  for (let round = 0; round < 4 && (pendingWitnesses.length || pendingExperiments.length); round++) {
    for (const e of [...pendingExperiments]) {
      const needs = (e.spec.hypotheses ?? []).map((h) => h.check.witness).filter((w) => !w.startsWith("builtin:"));
      if (round < 3 && needs.some((w) => pendingWitnesses.some((p) => p.id === w))) continue;
      try {
        const r = await cx.experiment({ operation: e.spec.operation, trials: e.spec.trials.map((t) => ({ inputs: t.inputs, expect: t.expect })), hypotheses: e.spec.hypotheses, controls: e.spec.controls }, actor);
        out.experiments.push({ operation: e.operation, experiment: r.experiment, claims: r.claims.map((c) => ({ id: c.id, state: c.state })) });
      } catch (err) {
        out.errors.push(`experiment on ${e.operation}: ${err.message}`);
      }
      pendingExperiments.splice(pendingExperiments.indexOf(e), 1);
    }
    for (const w of [...pendingWitnesses]) {
      try {
        const r = await cx.calibrate({ witness: w.definition, references: w.calibrationSpec.references, mutations: w.calibrationSpec.mutations, mutate: w.calibrationSpec.mutate }, actor);
        out.calibrations.push({ witness: w.id, status: r.status });
        pendingWitnesses.splice(pendingWitnesses.indexOf(w), 1);
      } catch (err) {
        if (round === 3) {
          out.errors.push(`witness ${w.id}: ${err.message}`);
          pendingWitnesses.splice(pendingWitnesses.indexOf(w), 1);
        }
      }
    }
  }
  for (const def of skills) {
    try {
      const r = await crystallize(cx, def, actor, { status: skillStatus });
      out.skills.push({ skill: def.id, status: r.status, revision: r.revision, ...(r.gaps ? { gaps: r.gaps } : {}), selfTest: r.selfTest });
    } catch (err) {
      out.skills.push({ skill: def.id, status: "unchanged", error: err.message });
    }
  }
  return out;
}
