// Transfer: export skills with the operations, experiments, witness calibrations, claims and
// sample bytes they rest on; import them and revalidate by re-running everything locally.
// An imported bundle never carries authority, and imported claims are only hypotheses here.
import { readFileSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { grantedRead, grantedWrite } from "./grant.js";
import { validateBundle } from "./schemas.js";
import { replay } from "./replay.js";
import { digestOf, isObject, now, Refusal, sha256 } from "./util.js";

function collect(cx, s, skillIds) {
  if (!Array.isArray(skillIds) || !skillIds.length) throw new Refusal("bad-request", "name at least one skill to export");
  const skills = skillIds.map((id) => {
    const k = s.skills[id];
    if (!k) throw new Refusal("unknown-skill", `no skill ${id}`);
    if (!["established", "revalidated"].includes(k.status)) throw new Refusal("not-usable", `skill ${id} is ${k.status}; only established or revalidated skills are exported`);
    return k;
  });
  const opIds = new Set();
  const witnessIds = new Set();
  for (const k of skills) {
    k.steps.forEach((st) => opIds.add(st.operation));
    k.successConditions.forEach((c) => witnessIds.add(c.witness));
  }
  // Witnesses can depend on operations (via), and experiments on witnesses: close over both.
  let grew = true;
  while (grew) {
    grew = false;
    for (const wid of [...witnessIds]) for (const op of Object.values(s.witnesses[wid]?.def.via ?? {})) if (!opIds.has(op)) (opIds.add(op), (grew = true));
    for (const e of Object.values(s.experiments)) {
      if (!opIds.has(e.operation)) continue;
      for (const h of e.spec.hypotheses) if (!witnessIds.has(h.check.witness)) (witnessIds.add(h.check.witness), (grew = true));
    }
  }
  const experiments = Object.values(s.experiments).filter((e) => opIds.has(e.operation) && e.spec.operation && s.operations[e.operation].pin.digest === cx.currentPin(s.operations[e.operation].def.program));
  const witnesses = [...witnessIds].filter((id) => !id.startsWith("builtin:")).map((id) => s.witnesses[id]);
  const claims = Object.values(s.claims).filter((c) => opIds.has(c.claim.operation)).map((c) => cx.claimView(c)).map(({ reasons, ...c }) => c);
  const digests = new Set();
  for (const e of experiments) for (const t of e.spec.trials) Object.values(t.inputs).forEach((d) => digests.add(d));
  for (const w of witnesses) for (const b of [...w.calibrationSpec.references, ...w.calibrationSpec.mutations]) Object.values(b.bind).forEach((d) => digests.add(d));
  for (const k of skills) for (const f of k.selfTest.fixtures) Object.values(f.inputs).forEach((d) => digests.add(d));
  return { skills, operations: [...opIds].map((id) => s.operations[id]), experiments, witnesses, claims, digests: [...digests] };
}

export function exportBundle(cx, skillIds, actor) {
  const s = cx.state.refresh();
  const c = collect(cx, s, skillIds);
  const artefacts = c.digests.map((d) => {
    const meta = cx.artefacts.meta(d);
    const origin = { sample: "operator-supplied", inline: "model-authored", "trial-output": "program-output", mutation: "engine-generated", imported: "imported", workspace: "operator-supplied" }[meta.origin];
    return { id: d, digest: d, origin, role: "fixture", ...(meta.format ? { mediaType: meta.format } : {}), data: cx.artefacts.get(d).toString("base64") };
  });
  const pins = c.operations.map((o) => ({ path: o.pin.path, digest: o.pin.digest }));
  const bundle = {
    schema: "context-cortex/transfer-bundle/v0",
    exportedAt: now(),
    exportedBy: actor,
    sourceEnvironment: { fingerprint: digestOf({ platform: platform(), arch: arch(), pins }), description: `${platform()}-${arch()}; ${pins.map((p) => p.path).join(", ")}` },
    skills: c.skills,
    operations: c.operations.map((o) => ({ ...o.def, pin: { path: o.pin.path, digest: o.pin.digest } })),
    experiments: c.experiments.map((e) => ({ id: e.id, operation: e.operation, spec: e.spec })),
    witnesses: c.witnesses.map((w) => ({ id: w.id, origin: w.origin, definition: w.def, calibrationSpec: w.calibrationSpec, calibration: { status: w.calibration.status, referencesAccepted: w.calibration.referencesAccepted, mutationsRejected: w.calibration.mutationsRejected, mutationsTried: w.calibration.mutationsTried } })),
    claims: c.claims,
    artefacts,
    evidence: c.experiments.flatMap((e) => e.trials),
    carriesAuthority: false,
    importPolicy: { requireRevalidation: true, initialStatus: "imported-unvalidated" },
  };
  const size = Buffer.byteLength(JSON.stringify(bundle));
  if (size > cx.grant.limits.maxBundleBytes) throw new Refusal("too-large", `bundle would be ${size} bytes; the grant allows ${cx.grant.limits.maxBundleBytes}`);
  const problems = validateBundle(bundle);
  if (problems) throw new Error(`exported bundle does not match its schema: ${problems}`);
  cx.ledger.append("export", { skills: skillIds, bundle: sha256(JSON.stringify(bundle)), artefacts: artefacts.length });
  return bundle;
}

export function writeBundle(cx, bundle, path) {
  const target = grantedWrite(cx.grant, path);
  writeFileSync(target, JSON.stringify(bundle, null, 2));
  return target;
}

export function readBundle(cx, path) {
  const real = grantedRead(cx.grant, path);
  const text = readFileSync(real, "utf8");
  if (Buffer.byteLength(text) > cx.grant.limits.maxBundleBytes) throw new Refusal("too-large", "bundle exceeds the grant's size limit");
  return JSON.parse(text);
}

/**
 * Import a bundle. Nothing in it is trusted: artefacts are checked against their digests,
 * skills start imported-unvalidated, and revalidation re-runs every calibration, experiment
 * and self-test under this host's grant and sandbox.
 */
export async function importBundle(cx, bundle, actor, { revalidate = true } = {}) {
  if (!isObject(bundle)) throw new Refusal("bad-request", "bundle must be an object");
  const size = Buffer.byteLength(JSON.stringify(bundle));
  if (size > cx.grant.limits.maxBundleBytes) throw new Refusal("too-large", `bundle is ${size} bytes; the grant allows ${cx.grant.limits.maxBundleBytes}`);
  const problems = validateBundle(bundle);
  if (problems) throw new Refusal("invalid-bundle", `bundle does not match the transfer-bundle schema: ${problems}`);
  const decoded = bundle.artefacts.map((a) => {
    const bytes = Buffer.from(a.data, "base64");
    if (sha256(bytes) !== a.digest) throw new Refusal("invalid-bundle", `artefact ${a.digest} does not match its bytes`);
    return bytes;
  });
  const bundleDigest = sha256(JSON.stringify(bundle));
  await cx.state.mutate(async (s) => {
    for (const k of bundle.skills) {
      const mine = s.skills[k.id];
      if (mine && ["established", "revalidated"].includes(mine.status) && mine.revision !== k.revision) {
        throw new Refusal("skill-conflict", `a different revision of skill ${k.id} is already established here`);
      }
    }
    decoded.forEach((bytes) => cx.artefacts.put(bytes, { origin: "imported", provenance: { bundle: bundleDigest } }));
    s.imports = s.imports ?? {};
    s.imports[bundleDigest] = { at: now(), by: actor, skills: bundle.skills.map((k) => k.id), exportedBy: bundle.exportedBy, sourceEnvironment: bundle.sourceEnvironment, bundle };
    for (const k of bundle.skills) if (!s.skills[k.id] || !["established", "revalidated"].includes(s.skills[k.id].status)) s.skills[k.id] = { ...k, status: "imported-unvalidated", importedFrom: bundleDigest };
  });
  cx.ledger.append("import", { bundle: bundleDigest, skills: bundle.skills.map((k) => k.id), artefacts: decoded.length, from: bundle.sourceEnvironment });
  const report = { bundle: bundleDigest, imported: bundle.skills.map((k) => k.id), status: "imported-unvalidated" };
  if (!revalidate) return report;
  return { ...report, revalidation: await revalidateBundle(cx, bundleDigest, actor) };
}

/** Re-establish everything a bundle claims, here. */
export async function revalidateBundle(cx, bundleDigest, actor) {
  const s = cx.state.refresh();
  const imp = s.imports?.[bundleDigest];
  if (!imp) throw new Refusal("unknown-import", `no imported bundle ${bundleDigest}`);
  const b = imp.bundle;
  const steps = { programs: [], calibrations: [], experiments: [], skills: [], agreement: [] };
  for (const op of b.operations) {
    const here = cx.currentPin(op.program);
    steps.programs.push({ program: op.program, here: here ? (here === op.pin.digest ? "same program" : "different program") : "missing or not granted" });
  }
  if (steps.programs.some((p) => p.here === "missing or not granted")) {
    return { ...steps, outcome: "not-revalidated", reason: "a program the bundle needs is missing or not granted on this host; the operator decides what to grant", skills: b.skills.map((k) => ({ skill: k.id, status: "imported-unvalidated" })) };
  }
  const replayed = await replay(cx, { experiments: b.experiments, witnesses: b.witnesses, skills: [] }, actor);
  steps.experiments = replayed.experiments;
  steps.calibrations = replayed.calibrations;
  const errors = replayed.errors;
  const local = cx.state.refresh();
  for (const c of b.claims) {
    const mine = cx.claimView(local.claims[c.id]);
    steps.agreement.push({ claim: c.id, exported: c.state, here: mine?.state ?? "not tested" });
  }
  const crystallised = await replay(cx, { skills: b.skills.map((k) => k.definition) }, actor, { skillStatus: "revalidate" });
  for (const [i, k] of b.skills.entries()) {
    const r = crystallised.skills[i];
    steps.skills.push({ skill: k.id, status: r.status === "unchanged" ? "imported-unvalidated" : r.status, ...(r.gaps ? { gaps: r.gaps } : {}), ...(r.error ? { error: r.error } : {}), selfTest: r.selfTest, sameRevision: r.revision === k.revision });
  }
  const disagreements = steps.agreement.filter((a) => a.exported !== a.here);
  cx.ledger.append("revalidation", { bundle: bundleDigest, skills: steps.skills.map((k) => ({ skill: k.skill, status: k.status })), disagreements: disagreements.length, errors });
  return { ...steps, errors, disagreements, outcome: steps.skills.every((k) => k.status === "revalidated") ? "revalidated" : "not-revalidated" };
}
