// Apply: act on a request across many inputs at once. Each input runs through an established
// skill, every output is checked by the skill's success conditions, and each result is delivered
// into a write root (never overwriting) or refused on its own without stopping the rest.
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { detectPrefix, confirms, extensionFor } from "./formats.js";
import { gap } from "./goal.js";
import { grantedRead } from "./grant.js";
import { listSkills, runSkill } from "./skills.js";
import { absolute, isObject, Refusal, within } from "./util.js";

function filesIn(cx, dir, { recursive, format, limit }) {
  const root = grantedRead(cx.grant, dir);
  if (!statSync(root).isDirectory()) throw new Refusal("bad-request", `not a directory: ${dir}`);
  const out = [];
  const queue = [[root, 0]];
  while (queue.length && out.length < limit) {
    const [d, depth] = queue.shift();
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) break;
      if (e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      let real;
      try {
        real = realpathSync(p);
      } catch {
        continue;
      }
      if (!within(real, root)) continue;
      const st = statSync(real);
      if (st.isDirectory()) {
        if (recursive && depth < 4) queue.push([real, depth + 1]);
        continue;
      }
      if (!st.isFile() || st.size === 0) continue;
      if (format) {
        const buf = Buffer.alloc(Math.min(4096, st.size));
        const fd = openSync(real, "r");
        readSync(fd, buf, 0, buf.length, 0);
        closeSync(fd);
        if (confirms(detectPrefix(buf, st.size <= 4096), format) !== true) continue;
      }
      out.push(real);
    }
  }
  return out;
}

export async function apply(cx, req, actor) {
  if (!isObject(req)) throw new Refusal("bad-request", "apply takes an object");
  const limit = Math.min(Math.max(1, Number(req.limit ?? 50)), 200);
  let skill = req.skill;
  if (!skill) {
    if (!req.have || !req.want) throw new Refusal("bad-request", "name a skill, or have and want");
    const preserve = Array.isArray(req.preserve) ? req.preserve : [];
    const match = listSkills(cx).find((k) => k.usable && k.have.includes(req.have) && k.want.includes(req.want) && preserve.every((p) => k.preserve.includes(p)));
    if (!match) return { status: "no-skill", goal: { have: req.have, want: req.want, preserve }, gap: gap(cx, { have: req.have, want: req.want, preserve }), note: "no usable skill does this yet; close the gaps, then context_compose" };
    skill = match.id;
  }
  const k = cx.state.refresh().skills[skill];
  if (!k) throw new Refusal("unknown-skill", `no skill ${skill}`);
  const inputNames = Object.keys(k.definition.inputs);
  if (inputNames.length !== 1) throw new Refusal("bad-request", `apply runs single-input skills; ${skill} takes ${inputNames.length}`);
  const [inName] = inputNames;
  const inFormat = k.definition.inputs[inName];
  const outFormat = k.goal.want[0];

  let items;
  if (Array.isArray(req.inputs)) items = req.inputs.slice(0, limit).map((src) => ({ src, name: typeof src?.path === "string" ? basename(src.path) : null }));
  else if (typeof req.from === "string") items = filesIn(cx, absolute(req.from, "from"), { recursive: !!req.recursive, format: inFormat, limit }).map((p) => ({ src: { path: p }, name: basename(p) }));
  else throw new Refusal("bad-request", "give inputs (sources) or from (a directory inside a read root)");

  let deliverDir = null;
  if (req.deliverTo) {
    deliverDir = absolute(req.deliverTo, "deliverTo");
    if (!existsSync(deliverDir) || !statSync(deliverDir).isDirectory()) throw new Refusal("bad-request", `deliverTo must be an existing directory: ${deliverDir}`);
    const real = realpathSync(deliverDir);
    if (!cx.grant.writeRoots.some((r) => existsSync(r) && within(real, realpathSync(r)))) throw new Refusal("not-granted", `deliverTo is outside the operator's write roots: ${deliverDir}`);
  }
  const results = [];
  for (const [i, it] of items.entries()) {
    const target = deliverDir ? join(deliverDir, `${it.name ?? `item-${i + 1}`}${extensionFor(outFormat)}`) : undefined;
    if (target && existsSync(target)) {
      results.push({ input: it.name ?? i, status: "skipped", reason: `${target} exists; nothing is overwritten` });
      continue;
    }
    try {
      const r = await runSkill(cx, skill, { [inName]: it.src }, { deliver: target });
      results.push({ input: it.name ?? i, status: r.status, ...(r.output ? { output: r.output } : {}), ...(r.delivered ? { delivered: r.delivered } : {}), ...(r.reason ? { reason: r.reason } : {}) });
    } catch (e) {
      results.push({ input: it.name ?? i, status: "refused", reason: e.message });
    }
  }
  const count = (st) => results.filter((r) => r.status === st).length;
  const summary = { items: results.length, completed: count("completed"), refused: count("refused"), skipped: count("skipped") };
  cx.ledger.append("apply", { skill, revision: k.revision, ...summary, deliverTo: deliverDir, by: actor });
  return { skill, input: inFormat, output: outFormat, ...summary, results, note: "every completed item passed the skill's success conditions; refused items returned nothing" };
}
