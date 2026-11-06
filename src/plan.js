// Plan: any requirement, made actionable against what is actually here. The requirement is read,
// its intent classified, and it is compiled into a program of context_* steps — every step the
// exact tool and arguments, grounded in this Cortex's real state: the granted workspaces' files,
// entry points, languages and test commands, the granted programs, the usable skills, and the
// taint routes the static scan already sees. Where grounding cannot fill an argument it is marked
// as a placeholder for the model, never invented. A plan is a proposal: each step's outcome, not
// the plan, decides what is established.
import { files, overview } from "./workspace.js";
import { grantedWorkspace } from "./grant.js";
import { scanWorkspace } from "./hunt.js";
import { listSkills } from "./skills.js";
import { isObject, now, Refusal, requireString } from "./util.js";

const INTENTS = [
  { id: "hunt", re: /secur|vulnerab|exploit|inject|attack|hunt|recon|hardening|cve|owasp|malicious|weakness/i },
  { id: "fix", re: /\bfix\b|repair|solve|patch|remediat|close/i },
  { id: "bug", re: /bug|crash|fails?|broken|regression|error|exception|hang/i },
  { id: "understand", re: /understand|explain|how (?:does|do|to)|what (?:does|is|are)|review|document|overview|describe/i },
  { id: "change", re: /\badd\b|implement|write|create|build|refactor|change|support|update|migrat|remove|delete|rename/i },
  { id: "test", re: /test|verify|check|coverage|reproduce/i },
  { id: "run", re: /run|execute|compile|install|start|deploy/i },
  { id: "data", re: /convert|compress|decompress|transform|encode|decode|batch|every (?:file|document|image)/i },
];
const STOP = new Set("the a an and or of to in on for with into from that this it its is are be been was were will shall must should can could would may might any all every each what which who when where why how do does did done make made get got set put use used using about as at by if then else not no very more most less least also just only than so such per via".split(" "));

/** Salient identifiers and paths in the requirement, to find the files it is about. */
function tokens(text) {
  return [...new Set(String(text).toLowerCase().match(/[a-z0-9_][\w./-]{2,}/g) ?? [])].filter((t) => !STOP.has(t)).slice(0, 12);
}

export function plan(cx, req, actor) {
  if (!isObject(req)) throw new Refusal("bad-request", "plan takes an object");
  const requirement = requireString(req.requirement, "requirement");
  const limit = Math.min(Math.max(3, Number(req.limit ?? 10)), 25);
  const ws = req.workspace === undefined ? null : grantedWorkspace(cx.grant, req.workspace);
  const intents = INTENTS.filter((i) => i.re.test(requirement)).map((i) => i.id);
  const steps = [];
  const needs = [];
  const grounding = { requirement, intents };
  const add = (tool, title, args, produces) => steps.push({ tool, title, args, produces });

  if (ws) {
    const s = scanWorkspace(cx, ws.root);
    const ov = overview(cx, { workspace: ws.root }).workspaces[0];
    const toks = tokens(requirement);
    const relevant = files(cx, { workspace: ws.root, limit: 2000 }).files
      .filter((f) => toks.some((t) => f.path.toLowerCase().includes(t)))
      .slice(0, 8)
      .map((f) => f.path);
    const test = ov.commands?.find((c) => c.purpose === "test" && c.program) ?? null;
    const drivable = s.findings.filter((f) => f.drive).length;
    grounding.workspace = {
      path: ws.root, network: ws.network, files: s.total, languages: s.languages,
      entryPoints: s.entryPoints.slice(0, 8), relevantFiles: relevant,
      security: { staticFindings: s.findings.length, argvRoutes: drivable, secrets: s.secrets.length },
      testCommand: test, commands: ov.commands ?? [],
    };

    add("context_workspace", "Orient: what this workspace is", { workspace: ws.root, action: "overview" }, "files, languages, manifests, git state and the commands the project uses");
    if (relevant.length) {
      for (const path of relevant.slice(0, 3)) add("context_workspace", `Read ${path}`, { workspace: ws.root, action: "read", path }, "the code as it is, with a digest for a safe edit");
    } else if (toks.length) {
      add("context_workspace", "Search the workspace for the requirement's subject", { workspace: ws.root, action: "search", pattern: toks.slice(0, 3).join("|") }, "the lines and files that match");
    }
    if (intents.some((i) => ["hunt", "fix", "bug"].includes(i))) {
      add("context_recon", "Find every way in, exploit-verified", { workspace: ws.root }, `${drivable} argv-sourced route(s) the engine can drive with proof, plus entry points, capabilities and secrets`);
    }
    if (intents.some((i) => ["hunt", "fix"].includes(i))) {
      add("context_repair", "Close what the drives prove open, with proof", { workspace: ws.root }, "guard fixes, each proven by the payload no longer reproducing, benign behavior preserved and the tests unregressed");
    }
    if (intents.includes("change") || intents.includes("bug")) {
      const target = relevant[0] ?? "<the file to change>";
      add("context_edit", `Change ${target}`, { workspace: ws.root, path: target, replace: { old: "<exact text as read>", new: "<the corrected text>" }, reason: requirement.slice(0, 200) }, "a reversible, digest-checked edit; every change keeps its bytes and can be undone");
      const runArgs = test ? { workspace: ws.root, program: test.program, args: test.args } : { workspace: ws.root, program: "<its test command>", args: [] };
      add("context_run", "Run the project's tests", runArgs, "exit code, output, and every file the run changed — undoable");
    }
    if (intents.includes("test") && !steps.some((x) => x.tool === "context_run")) {
      add("context_run", "Run the project's tests", test ? { workspace: ws.root, program: test.program, args: test.args } : { workspace: ws.root, program: "<its test command>", args: [] }, "exit code, output, and every file the run changed — undoable");
    }
    if (intents.includes("run") && !steps.some((x) => x.tool === "context_run")) {
      add("context_run", "Run it", { workspace: ws.root, program: "<the executable>", args: [] }, "sandboxed, workspace-writable, every change reported and undoable");
    }
    if (intents.includes("understand") && !intents.some((i) => ["hunt", "fix", "bug", "change"].includes(i))) {
      add("context_environment", "Place this code in what this machine can do", {}, "the host, granted programs, data formats and what can be done with them");
    }
  } else {
    const usable = listSkills(cx).filter((k) => k.usable);
    grounding.here = {
      programs: cx.grant.programs.length,
      workspaces: cx.grant.workspaces.map((w) => w.path),
      readRoots: cx.grant.readRoots,
      writeRoots: cx.grant.writeRoots,
      usableSkills: usable.map((k) => ({ id: k.id, have: k.have, want: k.want })),
    };
    add("context_environment", "See everything this Cortex can reach and do now", {}, "host, granted programs, data formats and what can be done with them");
    add("context_possibilities", "Everything established routes make possible now", {}, "every format reachable from every other, the skills, and what became possible since a point");
    add("context_goal", "Compile the goal against what is established", { have: "<the format you have>", want: "<the format you want>", preserve: ["<what must survive>"] }, "skills that already do it, and routes over operations with the state of every claim they rest on");
    add("context_gap", "Draft what is missing to close the goal", { have: "<the format you have>", want: "<the format you want>" }, "ready-to-submit experiment and witness drafts");
    if (usable.length) add("context_skill", `Run the matching skill (${usable[0].id})`, { action: "run", id: usable[0].id, inputs: "<{name: source} for this data>", deliver: "<a path inside a write root>" }, "the skill's steps, every success condition re-checked");
    if (intents.some((i) => ["hunt", "fix", "bug", "change", "test", "run"].includes(i))) {
      needs.push("a granted code workspace holding the code — context_recon, context_repair, context_edit and context_run work only inside one the operator granted");
    }
  }

  const out = steps.slice(0, limit);
  cx.ledger.append("plan", { requirement: requirement.slice(0, 200), workspace: ws?.root ?? null, intents, steps: out.length, by: actor });
  return {
    requirement, at: now(), intents, grounding,
    steps: out,
    ...(steps.length > out.length ? { truncated: steps.length - out.length } : {}),
    needs,
    note: "A plan is a proposal compiled from what is true here now. Each step's outcome — its ledgered evidence, not the plan — decides what is established; re-run context_plan when the ground changes.",
  };
}
