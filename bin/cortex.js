#!/usr/bin/env node
// cortex: the Context Cortex command line. The same engine as the MCP server, plus the
// operator-only grant commands that no MCP tool has.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Cortex, defaultHome, operatorActor, VERSION } from "../src/cortex.js";
import { defaultGrant, loadGrant, saveGrant } from "../src/grant.js";
import { compose, simulate } from "../src/compose.js";
import { evolve } from "../src/evolve.js";
import { gap, goal } from "../src/goal.js";
import { serveStdio } from "../src/mcp.js";
import { crystallize, explainSkill, listSkills, runSkill } from "../src/skills.js";
import { exportBundle, importBundle, readBundle, revalidateBundle, writeBundle } from "../src/transfer.js";
import { absolute, ensureDir, Refusal } from "../src/util.js";

const HELP = `cortex ${VERSION}: Context Cortex, a capability layer that turns experience with local programs
into checked, transferable skills.

Usage: cortex <command> [options]        (state: $CORTEX_HOME, default ~/.context-cortex)

  mcp                                     serve MCP over stdio (Claude Code, Codex, Cursor, …)
  connect [claude|codex|json]             print MCP client configuration
  status                                  grant, sandbox, counts, ledger integrity

Operator (the only way to change authority):
  grant show
  grant add-program <path>                allow a program, or every program in a directory
  grant add-read-root <dir>               allow reading samples and inputs from a directory
  grant add-write-root <dir>              allow delivering outputs into a directory
  grant remove <path>                     remove an entry from any list
  grant allow-unsandboxed <true|false>    run without a sandbox (off by default; not recommended)

Discovery:
  discover [--limit n] [--refresh] [--formats a,b]   survey every granted program
  probe <program>                         read one program's usage text, sandboxed
  possibilities [--since <seq|time>]      everything established routes make possible now

Learning:
  sample <path>                           store a file from a read root as a sample
  artefact <digest> [--as text|base64]    read a stored artefact
  artefacts [--format f] [--origin o]     list stored artefacts
  experiment <spec.json>                  run an experiment (see docs/USAGE.md)
  calibrate <spec.json>                   calibrate a witness
  witnesses                               list witnesses
  claims [--operation id] [--state s] [--kind k] [--property p]
  explain --operation id | --claim id | --witness id | --entry seq
  evolve [--operation id] [--limit n]     re-decide stale and unfinished claims and skills

Goals and skills:
  goal --have <type> --want <type> [--preserve a,b]
  gap --have <type> --want <type> [--preserve a,b]  gaps, with drafts that close them
  simulate --have t --want t --input <path> [--input <path>] [--preserve a] [--witness id]
  compose --have t --want t [--preserve a,b] [--id name]  build a skill from a ready route
  crystallize <skill.json>                crystallise and self-test a skill by hand
  skills                                  list skills
  skill <skill>                           show a skill's contract
  run <skill> --in name=<path> … [--deliver <path>]
  export <skill>… --out <path>            write a transfer bundle (inside a write root)
  import <bundle.json> [--no-revalidate]  import and revalidate a bundle (inside a read root)
  revalidate <bundle-digest>

  ledger [verify|entries] [--kind k] [--from seq]
  version | help

Output is JSON. Refusals exit 2, other failures 1.`;

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const [k, v] = a.slice(2).split("=", 2);
    if (v !== undefined) flags[k] = v;
    else if (k.startsWith("no-")) flags[k] = true;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
      const val = argv[++i];
      if (flags[k] === undefined) flags[k] = val;
      else flags[k] = [].concat(flags[k], val);
    } else flags[k] = true;
  } else positional.push(a);
}

const home = defaultHome();
const print = (v) => console.log(JSON.stringify(v, null, 2));
const readSpec = (p) => {
  if (!p) throw new Refusal("bad-request", "give a JSON file");
  return JSON.parse(readFileSync(p === "-" ? 0 : resolve(p), "utf8"));
};

async function grantCommand(sub, arg) {
  ensureDir(home);
  const g = loadGrant(home);
  const path = () => absolute(resolve(arg ?? ""), "path");
  if (!sub || sub === "show") return g;
  if (sub === "add-program") g.programs = [...new Set([...g.programs, path()])];
  else if (sub === "add-read-root") g.readRoots = [...new Set([...g.readRoots, path()])];
  else if (sub === "add-write-root") g.writeRoots = [...new Set([...g.writeRoots, path()])];
  else if (sub === "remove") {
    const p = path();
    for (const k of ["programs", "readRoots", "writeRoots"]) g[k] = g[k].filter((x) => x !== p);
  } else if (sub === "allow-unsandboxed") g.allowUnsandboxed = arg === "true";
  else if (sub === "reset") Object.assign(g, defaultGrant());
  else throw new Refusal("bad-request", `unknown grant command ${sub}`);
  saveGrant(home, g);
  const cx = new Cortex(home);
  cx.ledger.append("grant", { change: sub, path: arg ?? null, by: operatorActor() });
  return g;
}

function connect(client = "claude") {
  const script = join(dirname(fileURLToPath(import.meta.url)), "cortex.js");
  const node = process.execPath;
  if (client === "claude") return `claude mcp add context-cortex --scope user -- ${JSON.stringify(node)} ${JSON.stringify(script)} mcp`;
  if (client === "codex") return `# ~/.codex/config.toml\n[mcp_servers.context-cortex]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify([script, "mcp"])}`;
  return JSON.stringify({ mcpServers: { "context-cortex": { command: node, args: [script, "mcp"] } } }, null, 2);
}

async function main() {
  const cmd = positional.shift() ?? "help";
  if (cmd === "help" || flags.help) return console.log(HELP);
  if (cmd === "version") return console.log(VERSION);
  if (cmd === "mcp") return serveStdio(home);
  if (cmd === "connect") return console.log(connect(positional[0]));
  if (cmd === "grant") return print(await grantCommand(positional[0], positional[1]));
  const actor = operatorActor();
  const cx = await Cortex.open(home);
  switch (cmd) {
    case "status":
      return print(await cx.status());
    case "sample":
      return print(cx.addSample({ path: absolute(resolve(positional[0] ?? ""), "sample path") }));
    case "experiment":
      return print(await cx.experiment(readSpec(positional[0]), actor));
    case "calibrate":
      return print(await cx.calibrate(readSpec(positional[0]), actor));
    case "claims":
      return print(cx.claims({ operation: flags.operation, state: flags.state }));
    case "goal":
      return print(goal(cx, { have: flags.have, want: flags.want, preserve: flags.preserve ? String(flags.preserve).split(",") : [], since: flags.since }));
    case "possibilities":
      return print(goal(cx, { since: flags.since }));
    case "probe":
      return print(await cx.probe(absolute(resolve(positional[0] ?? ""), "program")));
    case "discover":
      return print(await cx.discover({ limit: flags.limit ? Number(flags.limit) : 25, refresh: !!flags.refresh, formats: flags.formats ? String(flags.formats).split(",") : undefined }));
    case "artefact":
      return print(cx.artefact(positional[0], { as: flags.as }));
    case "artefacts":
      return print(cx.artefactList({ format: flags.format, origin: flags.origin }));
    case "witnesses":
      return print(cx.witnesses());
    case "explain":
      return print(cx.explain({ operation: flags.operation, claim: flags.claim, witness: flags.witness, entry: flags.entry }));
    case "evolve":
      return print(await evolve(cx, { operation: flags.operation, limit: flags.limit ? Number(flags.limit) : 10 }, actor));
    case "gap":
      return print(gap(cx, { have: flags.have, want: flags.want, preserve: flags.preserve ? String(flags.preserve).split(",") : [] }));
    case "simulate":
      return print(await simulate(cx, { have: flags.have, want: flags.want, preserve: flags.preserve ? String(flags.preserve).split(",") : [], witness: flags.witness, inputs: [].concat(flags.input ?? []).map((p) => ({ path: absolute(resolve(p), "input") })) }, actor));
    case "compose":
      return print(await compose(cx, { have: flags.have, want: flags.want, preserve: flags.preserve ? String(flags.preserve).split(",") : [], id: flags.id }, actor));
    case "crystallize":
      return print(await crystallize(cx, readSpec(positional[0]), actor));
    case "skills":
      return print(listSkills(cx));
    case "skill":
      return print(explainSkill(cx, positional[0]));
    case "run": {
      const inputs = {};
      for (const kv of [].concat(flags.in ?? [])) {
        const i = kv.indexOf("=");
        if (i < 1) throw new Refusal("bad-request", "--in takes name=path");
        inputs[kv.slice(0, i)] = { path: absolute(resolve(kv.slice(i + 1)), "input path") };
      }
      const r = await runSkill(cx, positional[0], inputs, { deliver: flags.deliver ? absolute(resolve(flags.deliver)) : undefined });
      print(r);
      if (r.status !== "completed") process.exitCode = 2;
      return;
    }
    case "export": {
      if (!flags.out) throw new Refusal("bad-request", "export needs --out <path>");
      const bundle = exportBundle(cx, positional, actor);
      return print({ written: writeBundle(cx, bundle, absolute(resolve(flags.out))), skills: positional, artefacts: bundle.artefacts.length });
    }
    case "import":
      return print(await importBundle(cx, readBundle(cx, absolute(resolve(positional[0] ?? ""), "bundle path")), actor, { revalidate: !flags["no-revalidate"] }));
    case "revalidate":
      return print(await revalidateBundle(cx, positional[0], actor));
    case "ledger":
      return print(positional[0] === "entries" ? cx.ledgerEntries({ kind: flags.kind, from: flags.from }) : cx.ledger.verify());
    default:
      throw new Refusal("bad-request", `unknown command ${cmd}; see cortex help`);
  }
}

main().catch((e) => {
  if (e instanceof Refusal) {
    console.error(JSON.stringify({ refused: e.code, message: e.message }, null, 2));
    process.exit(2);
  }
  console.error(`cortex: ${e?.stack ?? e}`);
  process.exit(1);
});
