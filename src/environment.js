// Understanding the environment, and understanding Cortex itself.
// environment(): one model of everything this Cortex can reach and knows: the host and its
//   sandbox, the operator's authority, every granted program, the data in the read roots, the
//   established knowledge, what can be done with that data now, and what is missing.
// manual(): the engine's own rules, read from the constants the code enforces, so an AI can
//   reason about exactly how the tools decide, not about a paraphrase.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_WITNESSES, CLAIM_KINDS, DEFAULT_CONTROLS, PROMOTION_RULES, VERSION } from "./cortex.js";
import { detectPrefix, extensionFor, KNOWN_FORMATS, MUTATIONS } from "./formats.js";
import { possibilities } from "./goal.js";
import { detectSandbox, SANDBOX_POLICY } from "./sandbox.js";
import { listSkills } from "./skills.js";
import { overview as workspaceOverview } from "./workspace.js";
import { Refusal, within } from "./util.js";

const PREFIX = 4096;

/** Walk the read roots (bounded) and detect each file's format from its first bytes. */
function census(grant, maxFiles) {
  const byFormat = new Map();
  let files = 0, bytes = 0, truncated = false;
  const roots = grant.readRoots.map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return null;
    }
  });
  for (const [i, root] of roots.entries()) {
    if (!root) continue;
    const queue = [[root, 0]];
    while (queue.length) {
      const [dir, depth] = queue.shift();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (files >= maxFiles) {
          truncated = true;
          break;
        }
        const path = join(dir, e.name);
        let real;
        try {
          real = realpathSync(path);
        } catch {
          continue;
        }
        if (!roots.some((r) => r && within(real, r))) continue; // never follow a link out of the roots
        let st;
        try {
          st = statSync(real);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (depth < 4 && !e.name.startsWith(".")) queue.push([real, depth + 1]);
          continue;
        }
        if (!st.isFile()) continue;
        const buf = Buffer.alloc(Math.min(PREFIX, st.size));
        try {
          const fd = openSync(real, "r");
          readSync(fd, buf, 0, buf.length, 0);
          closeSync(fd);
        } catch {
          continue;
        }
        const d = st.size === 0 ? { format: null } : detectPrefix(buf, st.size <= PREFIX);
        const key = d.format ?? "unrecognised";
        const entry = byFormat.get(key) ?? { format: key, files: 0, bytes: 0, examples: [] };
        entry.files++;
        entry.bytes += st.size;
        if (entry.examples.length < 3) entry.examples.push(real);
        byFormat.set(key, entry);
        files++;
        bytes += st.size;
      }
    }
    if (i === roots.length - 1 && files >= maxFiles) truncated = true;
  }
  return { files, bytes, truncated, formats: [...byFormat.values()].sort((a, b) => b.files - a.files) };
}

export async function environment(cx, { survey = false, limit = 25, maxFiles = 2000 } = {}) {
  if (survey) await cx.discover({ limit });
  const s = cx.state.refresh();
  const grant = cx.reloadGrant();
  const sb = await detectSandbox();
  const status = await cx.status();

  const programs = cx.grantedPrograms().map((p) => {
    const inv = s.inventory?.[p];
    const ops = Object.values(s.operations).filter((o) => o.pin.path === p);
    const claims = Object.values(s.claims).filter((c) => ops.some((o) => o.def.id === c.claim.operation)).map((c) => cx.claimView(c).state);
    const tally = {};
    for (const st of claims) tally[st] = (tally[st] ?? 0) + 1;
    return {
      program: p,
      ...(inv ? { summary: inv.summary, mentions: inv.formats, surveyedAt: inv.probedAt } : { surveyed: false }),
      operations: ops.map((o) => ({ id: o.def.id, inputs: o.def.inputs, outputs: o.def.outputs })),
      claims: tally,
      changedSinceLearned: ops.some((o) => cx.currentPin(o.def.program) !== o.pin.digest),
    };
  });

  const data = census(grant, maxFiles);
  const poss = possibilities(cx);
  const skills = listSkills(cx);
  const canDo = data.formats
    .filter((f) => f.format !== "unrecognised")
    .map((f) => ({
      format: f.format,
      files: f.files,
      skills: skills.filter((k) => k.usable && k.have.includes(f.format)).map((k) => ({ skill: k.id, want: k.want, preserve: k.preserve })),
      routes: poss.capabilities.filter((c) => c.from === f.format).map((c) => ({ to: c.to, via: c.via, preserves: c.preserves })),
    }));

  const recommendations = [];
  const unsurveyed = programs.filter((p) => p.surveyed === false).length;
  if (!grant.programs.length) recommendations.push("operator: no programs are granted; `cortex grant add-program <path>` (only the operator can)");
  if (unsurveyed) recommendations.push(`${unsurveyed} granted program(s) not surveyed yet: context_discover (or environment with survey: true)`);
  if (!grant.readRoots.length) recommendations.push("operator: no read roots, so there is no data to learn from or act on; `cortex grant add-read-root <dir>`");
  if (!grant.writeRoots.length) recommendations.push("operator: no write roots, so results can be returned but not delivered; `cortex grant add-write-root <dir>`");
  for (const f of canDo) if (!f.skills.length && !f.routes.length) {
    const candidates = programs.filter((p) => p.mentions?.includes(f.format)).map((p) => p.program.split("/").pop());
    recommendations.push(`${f.files} ${f.format} file(s) and nothing established can act on them${candidates.length ? `; programs that mention ${f.format}: ${candidates.join(", ")} (context_probe, then context_experiment)` : ""}`);
  }
  if (!grant.workspaces.length) recommendations.push("operator: no code workspaces are granted, so Cortex cannot act on code; `cortex grant add-workspace <dir>` (add --network if its builds need it)");
  const stale = programs.filter((p) => p.changedSinceLearned).map((p) => p.program);
  if (stale.length) recommendations.push(`programs changed since they were learned: ${stale.join(", ")}; context_evolve re-proves them`);
  const unfinished = (status.counts.claimsByState.observed ?? 0) + (status.counts.claimsByState.hypothesised ?? 0);
  if (unfinished) recommendations.push(`${unfinished} claim(s) are observed or hypothesised; context_claims lists why, context_evolve re-runs them`);
  const unusable = skills.filter((k) => !k.usable).map((k) => k.id);
  if (unusable.length) recommendations.push(`skills not usable now: ${unusable.join(", ")}; context_skill explain says why`);

  return {
    host: { platform: platform(), release: release(), arch: arch(), cpus: cpus().length, memoryBytes: totalmem(), node: process.version },
    cortex: { version: VERSION, home: cx.home, tools: (await import("./mcp.js")).TOOLS.length },
    sandbox: { kind: sb.kind ?? null, ...(sb.kind ? {} : { reason: sb.reason }), enforces: sb.kind ? SANDBOX_POLICY : [], unsandboxedAllowed: grant.allowUnsandboxed },
    authority: { programs: grant.programs, readRoots: grant.readRoots, writeRoots: grant.writeRoots, network: false, limits: grant.limits, note: "Only the operator changes this. No tool can widen it." },
    programs: { granted: programs.length, surveyed: programs.length - unsurveyed, list: programs },
    data,
    workspaces: workspaceOverview(cx).workspaces,
    knowledge: {
      claims: status.counts.claimsByState,
      operations: status.counts.operations,
      witnesses: cx.witnesses().map((w) => ({ id: w.id, calibration: w.calibration, current: w.current })),
      skills,
      contradicted: poss.contradicted,
      ledger: status.ledger,
    },
    canDo,
    possibilities: { formats: poss.formats, routes: poss.capabilities.length },
    recommendations,
  };
}

const TOPICS = ["overview", "tools", "rules", "formats", "sources", "safety", "usage"];

/** Cortex describing itself, from the constants its code enforces. */
export async function manual(cx, topic) {
  if (topic && !TOPICS.includes(topic)) throw new Refusal("bad-request", `unknown topic ${topic}; topics: ${TOPICS.join(", ")}`);
  const { TOOLS } = await import("./mcp.js");
  const sections = {
    overview: {
      what: "Context Cortex turns experience with the programs on this machine into checked, transferable skills. The model proposes operations, hypotheses and skills; the engine runs everything sandboxed, records every trial in a hash-chained ledger, and decides what is true from that evidence alone.",
      loop: ["context_environment / context_status: what is here", "context_discover, context_probe: what programs say they do", "context_experiment: what they actually do (trials, controls, a determinism repeat)", "context_witness: calibrate a checker that must reject damage", "context_experiment with hypotheses: prove properties such as bytes or pixels preserved", "context_gap: drafts that close what is missing", "context_simulate: compare routes on real inputs", "context_compose / context_crystallize: a self-testing skill", "context_skill / context_apply: use it on one input or many", "context_evolve: re-prove after change", "context_transfer: hand it to another agent, which re-proves it"],
      version: VERSION,
    },
    tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, arguments: Object.keys(t.inputSchema.properties ?? {}), required: t.inputSchema.required ?? [], readOnly: !!t.annotations?.readOnlyHint })),
    rules: {
      claimStates: PROMOTION_RULES,
      claimKinds: CLAIM_KINDS,
      automaticClaims: {
        "accepts:<input>": "every successful trial whose input really is the declared format supports it; a failed one refutes it",
        "produces:<output>": "every successful trial whose output really is the declared format supports it; another known format refutes it",
        "rejects:<damage>": `negative controls: by default ${DEFAULT_CONTROLS.kinds.join(" and ")} copies of the first ${DEFAULT_CONTROLS.limit} successful trials must be refused`,
        "refuses-given": "trials the model marked expect: failure must fail",
      },
      trialSuccess: "exit 0, not timed out, output within limits, and every declared output present and non-empty",
      witnesses: {
        builtins: Object.keys(BUILTIN_WITNESSES),
        definable: ["builtin bytes-equal (two params)", "builtin nonempty (one)", "builtin format-is with format (one)", "a granted program with args using {param:name} and accept {exit}"],
        via: "a param passed through an operation (one input, one output, with an established output claim) before comparing: a decoder witnessing an encoder",
        calibration: "must accept every reference and reject every mutation; mutations are generated from the last param (truncate, corrupt-header, flip-middle) unless mutate says otherwise",
      },
      skills: {
        established: "every claim it rests on established, every success-condition witness calibrated and current, every preserved property shown (an end-to-end success condition with that property, or an established preservation claim for every step), and the self-test (at least one pass and one refuse) behaves as declared",
        run: "inputs must really be the declared format; every step sandboxed; every success condition re-checked; a result that fails them is refused, never returned",
        usable: "established or revalidated, every program pin current, every witness current",
      },
      code: "code workspaces are granted by the operator; context_workspace reads and searches them (never .git, never through a link out), context_edit changes files reversibly (exact-string replace, whole content or delete; expectDigest refuses to overwrite a concurrent change; every change keeps the bytes before and after and can be undone), context_run runs granted programs with the workspace writable and reports and can undo every file a run changed; network only where the operator granted it to that workspace",
      transfer: "a bundle never carries authority; artefacts are checked against their digests; skills start imported-unvalidated; revalidation re-runs every calibration, experiment and self-test here",
    },
    formats: {
      detectedBySignature: KNOWN_FORMATS,
      extensions: Object.fromEntries(KNOWN_FORMATS.map((f) => [f, extensionFor(f)]).filter(([, e]) => e)),
      unknownFormats: "a declared format the detector does not know can be established only by a hypothesis on that port's format judged by a calibrated format witness",
      mutations: Object.keys(MUTATIONS),
    },
    sources: {
      forms: ['"sha256:…" or {"artefact": "sha256:…"}: a stored artefact', '{"path": "/abs/file"}: a file inside a read root', '{"text": "…"} or {"base64": "…"}: bytes from the model', '{"mutate": {"of": <source>, "kind": "truncate|corrupt-header|flip-middle|empty"}}: deterministic damage'],
      argumentTokens: ["{in:name}: the staged input file (with an extension matching its declared format)", "{out:name}: an output path", "outputs named stdout capture standard output; stdin: <name> feeds an input"],
    },
    safety: { sandbox: SANDBOX_POLICY, grant: "programs, read roots and write roots are the operator's; no MCP tool can change them", deliveries: "only inside a write root, never overwriting", pins: "programs are pinned by digest; a change makes claims stale and skills unusable until re-proven" },
    usage: (() => {
      const p = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "USAGE.md");
      return existsSync(p) ? readFileSync(p, "utf8") : "docs/USAGE.md is not installed with this copy";
    })(),
  };
  if (topic) return { topic, [topic]: sections[topic] };
  const { usage, ...rest } = sections;
  return { topics: TOPICS, ...rest, usage: "ask for topic usage for the full specification guide" };
}

export { relative };
