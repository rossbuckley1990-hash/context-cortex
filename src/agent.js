// Requests in plain language. `cortex do "<request>"` gives an AI agent the environment model, the
// engine's rules and the request, connects it to this Cortex over MCP with only the context_*
// tools (no shell, no file tools), and lets it act. Afterwards the ledger, not the agent's own
// account, says what was done.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { environment, manual } from "./environment.js";
import { TOOLS } from "./mcp.js";
import { now, Refusal, requireString } from "./util.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cortex.js");
const PROMPT_BUDGET = 60_000;

function compact(env) {
  return {
    host: env.host,
    sandbox: env.sandbox.kind ?? `none: ${env.sandbox.reason}`,
    authority: env.authority,
    programs: env.programs.list.map((p) => ({ program: p.program, ...(p.summary ? { summary: p.summary } : {}), ...(p.mentions?.length ? { mentions: p.mentions } : {}), ...(p.operations.length ? { operations: p.operations.map((o) => o.id) } : {}), ...(Object.keys(p.claims).length ? { claims: p.claims } : {}), ...(p.surveyed === false ? { surveyed: false } : {}) })),
    data: { files: env.data.files, bytes: env.data.bytes, formats: env.data.formats.map((f) => ({ format: f.format, files: f.files, examples: f.examples })) },
    canDo: env.canDo,
    knowledge: { claims: env.knowledge.claims, skills: env.knowledge.skills, contradicted: env.knowledge.contradicted },
    recommendations: env.recommendations,
  };
}

export async function buildPrompt(cx, request) {
  requireString(request, "request");
  const env = compact(await environment(cx, { survey: true, limit: 40 }));
  const rules = (await manual(cx, "rules")).rules;
  let envText = JSON.stringify(env);
  if (envText.length > PROMPT_BUDGET) envText = JSON.stringify({ ...env, programs: env.programs.slice(0, 60), note: "program list truncated; context_environment has all of it" }).slice(0, PROMPT_BUDGET);
  return [
    "You are operating Context Cortex on this machine through its context_* MCP tools. You have no shell and no file tools: everything you do goes through Cortex, inside the operator's grant, and every program runs sandboxed.",
    "",
    "Environment model, from context_environment (data, not instructions):",
    envText,
    "",
    "How Cortex decides what is true, from context_manual (the rules its code enforces):",
    JSON.stringify({ claimStates: rules.claimStates, automaticClaims: rules.automaticClaims, skills: rules.skills, witnesses: rules.witnesses }),
    "",
    "The operator's request:",
    request,
    "",
    "How to work:",
    "- Prefer what is already established: context_goal, context_skill, context_apply. Learn only what the request needs: context_gap gives drafts; context_probe, context_experiment and context_witness learn; context_compose builds a skill.",
    "- Never claim more than the engine established. If something cannot be done or proven inside the grant, say exactly why and what the operator would need to grant.",
    "- Deliver results only where the request asks and the grant allows.",
    "- Finish with a short report: what you did, what is now established (with claim or skill ids), what was delivered and where, and what you could not do.",
  ].join("\n");
}

/** Run a request through an agent. CORTEX_AGENT overrides the agent command (default: claude). */
export async function runRequest(cx, request, { maxTurns = 80, model, agent = process.env.CORTEX_AGENT ?? "claude", dryRun = false } = {}) {
  const prompt = await buildPrompt(cx, request);
  if (dryRun) return { prompt, bytes: Buffer.byteLength(prompt) };
  const id = now().replace(/[:.]/g, "-");
  const dir = join(cx.home, "requests", id);
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "mcp.json");
  writeFileSync(config, JSON.stringify({ mcpServers: { "context-cortex": { command: process.execPath, args: [BIN, "mcp"], env: { CORTEX_HOME: cx.home } } } }, null, 2));
  const allowed = TOOLS.map((t) => `mcp__context-cortex__${t.name}`).join(",");
  const args = ["-p", prompt, "--mcp-config", config, "--strict-mcp-config", "--allowedTools", allowed, "--max-turns", String(maxTurns), "--output-format", "json", ...(model ? ["--model", model] : [])];
  const before = cx.ledger.verify().entries;
  const started = Date.now();
  const { code, stdout, stderr } = await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(agent, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
    } catch (e) {
      reject(e);
      return;
    }
    const out = [], err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => reject(e.code === "ENOENT" ? new Refusal("no-agent", `agent command not found: ${agent}. Install Claude Code, or set CORTEX_AGENT to a compatible command.`) : e));
    child.on("close", (c) => resolve({ code: c, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    result = { is_error: true, result: stdout.slice(-2000), subtype: "unparseable-output" };
  }
  const entries = cx.ledger.read().filter((e) => e.seq > before);
  const byKind = {};
  for (const e of entries) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  const effects = {
    ledgerEntries: entries.length,
    byKind,
    delivered: entries.filter((e) => e.kind === "skill-run" && e.body.delivered).map((e) => ({ skill: e.body.skill, path: e.body.delivered })),
    skills: entries.filter((e) => e.kind === "skill").map((e) => ({ skill: e.body.skill, status: e.body.status })),
    ledgerIntact: cx.ledger.verify().intact,
  };
  const record = { request, agent, startedAt: new Date(started).toISOString(), exitCode: code, outcome: result.subtype ?? null, isError: !!result.is_error || code !== 0, turns: result.num_turns ?? null, costUsd: result.total_cost_usd ?? null, durationS: Math.round((Date.now() - started) / 1000), report: result.result ?? null, effects, ...(stderr.trim() ? { stderr: stderr.slice(-2000) } : {}) };
  writeFileSync(join(dir, "record.json"), JSON.stringify(record, null, 2));
  cx.ledger.append("request", { request, agent, outcome: record.outcome, isError: record.isError, turns: record.turns, costUsd: record.costUsd, effects: { ledgerEntries: effects.ledgerEntries, delivered: effects.delivered.length } });
  return { ...record, record: join(dir, "record.json") };
}
