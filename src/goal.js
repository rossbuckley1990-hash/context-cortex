// Goals and gaps: what can be done now, which routes are close, and what evidence is missing.
// Everything here is read from established claims; nothing is suggested from names alone.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Refusal, requireString } from "./util.js";

const MAX_STEPS = 3;

const establishedAt = (c) => c?.history?.filter((h) => h.state === "established").at(-1)?.at ?? null;

/**
 * Everything that can be done now: every format reachable from every other through
 * operations whose claims are established, with the properties proven along the whole route,
 * and which of those became possible after `since` (a ledger sequence number or an ISO time).
 */
export function possibilities(cx, { since } = {}) {
  const s = cx.state.refresh();
  let sinceAt = null;
  if (since !== undefined && since !== null && since !== "") {
    if (/^\d+$/.test(String(since))) {
      const e = cx.ledger.get(Number(since));
      if (!e) throw new Refusal("bad-request", `no ledger entry ${since}`);
      sinceAt = e.at;
    } else if (!Number.isNaN(Date.parse(String(since)))) sinceAt = new Date(String(since)).toISOString();
    else throw new Refusal("bad-request", "since must be a ledger sequence number or an ISO time");
  }
  const views = Object.values(s.claims).map((c) => cx.claimView(c));
  const byId = Object.fromEntries(views.map((c) => [c.id, c]));
  const edges = [];
  for (const o of Object.values(s.operations)) {
    const ins = Object.entries(o.def.inputs);
    if (ins.length !== 1) continue;
    const [inName, from] = ins[0];
    for (const [outName, to] of Object.entries(o.def.outputs)) {
      const a = byId[`${o.def.id}:accepts:${inName}`], p = byId[`${o.def.id}:produces:${outName}`];
      if (a?.state !== "established" || p?.state !== "established") continue;
      const preserves = views.filter((c) => c.operation === o.def.id && c.kind === "preservation" && c.state === "established");
      edges.push({ op: o.def.id, from, to, claims: [a, p, ...preserves], preserves: preserves.map((c) => c.statement.property) });
    }
  }
  const found = new Map();
  const walk = (start, format, path) => {
    if (path.length && format !== start) {
      const key = `${start}→${format}:${path.map((e) => e.op).join(">")}`;
      const props = path.map((e) => new Set(e.preserves)).reduce((acc, set) => new Set([...acc].filter((x) => set.has(x))));
      const latest = path.flatMap((e) => e.claims.map(establishedAt)).filter(Boolean).sort().at(-1);
      found.set(key, { from: start, to: format, via: path.map((e) => e.op), preserves: [...props], establishedAt: latest, ...(sinceAt ? { new: latest > sinceAt } : {}) });
    }
    if (path.length >= MAX_STEPS) return;
    for (const e of edges) if (e.from === format && !path.some((p) => p.op === e.op)) walk(start, e.to, [...path, e]);
  };
  for (const f of new Set(edges.map((e) => e.from))) walk(f, f, []);
  const capabilities = [...found.values()].sort((a, b) => a.via.length - b.via.length);
  const skills = Object.values(s.skills).map((k) => ({ skill: k.id, status: k.status, have: k.goal.have, want: k.goal.want, preserve: k.goal.preserve ?? [] }));
  const formats = [...new Set(capabilities.flatMap((c) => [c.from, c.to]))].sort();
  return {
    formats,
    capabilities,
    skills,
    ...(sinceAt ? { since: sinceAt, newlyPossible: capabilities.filter((c) => c.new).map((c) => `${c.from} → ${c.to} via ${c.via.join(" → ")}`) } : {}),
    contradicted: views.filter((c) => c.state === "contradicted").map((c) => ({ claim: c.id, statement: c.statement.text })),
    note: "Every capability listed rests on established claims only. Nothing here is inferred from names or documentation.",
  };
}

export function goal(cx, req) {
  if (!req?.have && !req?.want) return possibilities(cx, { since: req?.since });
  const have = requireString(req?.have, "have");
  const want = requireString(req?.want, "want");
  const preserve = Array.isArray(req?.preserve) ? req.preserve.map(String) : [];
  if (have === want) throw new Refusal("bad-request", "have and want are the same format");
  const s = cx.state.refresh();
  const views = Object.values(s.claims).map((c) => cx.claimView(c));
  const byId = Object.fromEntries(views.map((c) => [c.id, c]));

  // Skills that already do it.
  const skills = Object.values(s.skills)
    .filter((k) => k.goal.have.includes(have) && k.goal.want.includes(want) && preserve.every((p) => (k.goal.preserve ?? []).includes(p)))
    .map((k) => ({ skill: k.id, status: k.status, preserve: k.goal.preserve ?? [] }));

  // Single-input operations as edges, with the state of the claims each edge rests on.
  const edges = [];
  for (const o of Object.values(s.operations)) {
    const ins = Object.entries(o.def.inputs);
    if (ins.length !== 1) continue;
    const [inName, inFormat] = ins[0];
    for (const [outName, outFormat] of Object.entries(o.def.outputs)) {
      const accepts = byId[`${o.def.id}:accepts:${inName}`];
      const produces = byId[`${o.def.id}:produces:${outName}`];
      const preserves = Object.fromEntries(preserve.map((p) => [p, views.find((c) => c.operation === o.def.id && c.kind === "preservation" && c.statement.property === p) ?? null]));
      edges.push({ op: o.def.id, from: inFormat, to: outFormat, input: inName, output: outName, accepts, produces, preserves });
    }
  }
  const ready = (e) => e.accepts?.state === "established" && e.produces?.state === "established";
  const routes = [];
  const search = (format, path) => {
    if (path.length > MAX_STEPS) return;
    if (format === want && path.length) {
      routes.push(path);
      return;
    }
    for (const e of edges) if (e.from === format && !path.some((p) => p.op === e.op)) search(e.to, [...path, e]);
  };
  search(have, []);
  const described = routes.map((path) => {
    const gaps = [];
    for (const e of path) {
      if (e.accepts?.state !== "established") gaps.push({ operation: e.op, missing: `accepts ${e.from}`, state: e.accepts?.state ?? "untested" });
      if (e.produces?.state !== "established") gaps.push({ operation: e.op, missing: `produces ${e.to}`, state: e.produces?.state ?? "untested" });
      for (const p of preserve) {
        const c = e.preserves[p];
        if (c?.state !== "established") gaps.push({ operation: e.op, missing: `preserves ${p}`, state: c?.state ?? "untested", experiment: `a hypothesis {kind: "preservation", property: "${p}"} on ${e.op}, checked by a calibrated witness` });
      }
    }
    return { steps: path.map((e) => `${e.op} (${e.from} → ${e.to})`), ready: path.every(ready) && !gaps.length, gaps };
  });
  described.sort((a, b) => a.gaps.length - b.gaps.length || a.steps.length - b.steps.length);

  const usedPrograms = new Set(Object.values(s.operations).map((o) => o.pin.path));
  const uninvestigated = [];
  for (const entry of cx.grant.programs) {
    try {
      const st = statSync(entry);
      const files = st.isDirectory() ? readdirSync(entry).map((f) => join(entry, f)) : [entry];
      for (const f of files) {
        if (uninvestigated.length >= 40) break;
        try {
          const fs = statSync(f);
          if (fs.isFile() && fs.mode & 0o111 && !usedPrograms.has(f)) uninvestigated.push(f);
        } catch {
          /* unreadable entry */
        }
      }
    } catch {
      /* missing grant entry */
    }
  }

  const contradicted = views.filter((c) => c.state === "contradicted" && edges.some((e) => e.op === c.operation && (e.from === have || e.to === want))).map((c) => ({ claim: c.id, statement: c.statement.text }));
  const next = [];
  if (skills.some((k) => ["established", "revalidated"].includes(k.status))) next.push(`run skill ${skills.find((k) => ["established", "revalidated"].includes(k.status)).skill} with context_skill`);
  else if (described.some((r) => r.ready)) next.push("a ready route exists: crystallise it with context_crystallize (it needs a calibrated success-condition witness and a self-test)");
  else if (described.length) next.push(`close the gaps on the nearest route (${described[0].steps.join(" → ")}) with context_experiment`);
  else next.push(`no route from ${have} to ${want} is known: define an operation on a granted program and test it with context_experiment${uninvestigated.length ? ` (uninvestigated granted programs: ${uninvestigated.slice(0, 8).map((p) => p.split("/").pop()).join(", ")}…)` : "; the operator has granted no further programs"}`);
  return { goal: { have, want, preserve }, skills, routes: described.slice(0, 10), contradicted, uninvestigatedPrograms: uninvestigated, next };
}
