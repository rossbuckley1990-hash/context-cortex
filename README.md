# Context Cortex

**An AI's experience with software, turned into abilities it can prove and pass on.**

Context Cortex is an MCP server and a command line (`cortex`). Through six `context_*` tools, any model
can learn what the programs on a machine actually do, by running bounded experiments in a sandbox. It
can turn what works into a skill that checks its own results, and hand that skill to a different model
or machine, which re-proves it before use. The model's weights never change. What it can reliably do
keeps growing.

```text
  goal ──► probe ──► experiment ──► calibrate ──► crystallise ──► use ──► transfer
  "what do    read a    run trials,   build a       a workflow     run on    export; the
   I need?"   program's  controls,     checker that  becomes a      new       importer
              usage      repeats      must reject   self-testing   inputs,   re-runs every
              text                    damage        skill          checked   experiment
```

## What it gives an AI

- **It learns programs it was never given a tool for.** Any program the operator grants becomes
  learnable through MCP alone, with no shell needed. The AI reads the usage text (`probe`), defines an
  operation, and tests it.
- **Its beliefs are backed by trials.** Every claim (what a program accepts, produces, refuses or
  preserves) is decided by the engine from sandboxed trials in a hash-chained ledger. The AI's
  hypotheses stay hypotheses until the evidence says otherwise.
- **It catches software that lies.** Negative controls feed damaged inputs to every operation. A program
  that exits 0 on a truncated file gets a *contradicted* claim, which is carried into every skill that
  uses it.
- **Its checkers are checked.** A witness (the thing that judges a result) counts only after it has
  accepted known-good references and rejected generated damage.
- **Its skills refuse rather than guess.** A skill runs its success conditions on every run. A result
  that fails them is refused, never returned.
- **What one model learns, another inherits.** Export a skill, and a fresh model on another machine
  imports it. The importer re-runs every calibration, experiment and self-test under its own grant and
  reports where it agrees with the exporter.
- **It knows what has become possible.** `context_goal` with no arguments maps every format reachable
  through established operations, the properties proven along each route, and what became possible since
  a given point. It also names the granted programs nobody has investigated yet.

## Install

Requires Node.js 22.18 or later.

```bash
git clone https://github.com/rossbuckley1990-hash/context-cortex.git
cd context-cortex
npm install
npm test
```

Grant the programs and directories it may use. Only the operator can do this; no MCP tool can:

```bash
node bin/cortex.js grant add-program /usr/bin/gzip
node bin/cortex.js grant add-read-root ~/cortex-samples
node bin/cortex.js grant add-write-root ~/cortex-out
```

Connect an AI client:

```bash
node bin/cortex.js connect claude   # prints: claude mcp add context-cortex ...
node bin/cortex.js connect codex    # Codex TOML
node bin/cortex.js connect json     # generic mcpServers JSON
```

Then give the model a goal, not a tool list:

> Using Context Cortex, find out what /usr/bin/gzip can do, prove which operations are lossless, and
> save a skill another agent can use to compress text with a verified round trip.

## The six tools

| Tool | What the AI gets |
|---|---|
| `context_status` | The grant, the sandbox, counts of operations, claims by state, witnesses and skills, and ledger integrity |
| `context_goal` | For `have → want` with `preserve`: skills, routes, the gaps blocking each route and the experiment that closes it. With no arguments: everything possible now, and what is newly possible `since` a point |
| `context_experiment` | `probe` a program's usage text, `run` an experiment (trials, controls, a determinism repeat, hypotheses), `calibrate` a witness, store a `sample`, list `claims` |
| `context_crystallize` | Turn a demonstrated workflow into a skill. It is established only when its claims are established, its witnesses calibrated, its preserved properties shown, and its self-test (one pass and one refuse at least) behaves as declared |
| `context_skill` | `list`, `explain` or `run` a skill. Every step runs sandboxed and its success conditions are checked. `deliver` writes the output into a write root, never overwriting |
| `context_transfer` | `export` a bundle, or `import` one, which re-runs everything here. `revalidate` an earlier import |

The CLI has the same operations, plus the grant commands. Run `node bin/cortex.js help`.
[docs/USAGE.md](docs/USAGE.md) has the specification formats and a worked example.

## How it decides what is true

| State | Means |
|---|---|
| `hypothesised` | Someone said so (the model, documentation, another machine). Never planned on |
| `observed` | At least one trial supports it, but the promotion rule does not hold yet. The reasons are listed |
| `established` | At least two distinct inputs support it, nothing refutes it, outputs were identical on a repeat run, and any judging witness is calibrated |
| `contradicted` | A trial refutes it. Reported, never silently resolved |
| `stale` | The program's digest changed since the evidence was gathered |

Every operation automatically gets `accepts`, `produces` and, from negative controls, `rejects:<damage>`
claims. The model adds its own hypotheses (for example "decompressing the output returns the input
exactly"), each checked by a calibrated witness on every successful trial.

## Authority and confinement

- **The grant is the operator's.** It lists programs, read roots and write roots. Discovery,
  experiments and imports never widen it, and no MCP tool can change it.
- **Everything runs confined:** `sandbox-exec` on macOS, `bubblewrap` on Linux, with no network, writes
  only inside a fresh work directory, home directories unreadable, and CPU, file-size, time and output
  limits. With no sandbox nothing runs, unless the operator sets `allowUnsandboxed`.
- **Programs are pinned by digest.** A changed program makes its claims stale and its skills unusable
  until they are revalidated.
- **Bundles carry no authority.** On import, artefacts are checked against their digests, the schema is
  enforced, and the skill stays `imported-unvalidated` until this host has re-proven it.

The test suite checks each of these, including a hostile program that tries to read a home directory
file and write outside its sandbox (it can do both when the sandbox is off, and neither when it is on).

## Status

**v0.1.0, working and tested; experimental.** On macOS (sandbox-exec), `npm test` passes 25 tests and
17 schema checks. One of the tests is a real MCP client session that runs the whole loop through
`context_*` calls alone. CI runs the suite on macOS and on Linux with bubblewrap.

Not yet built, and not claimed:

- **Inputs:** only local programs, with file or stdin input and file or stdout output. There are no
  HTTP APIs and no network access.
- **Witnesses:** they are built-ins, granted programs, or comparisons through an established operation.
  A model cannot yet write its own validator code.
- **Format detection:** by magic bytes for about twenty formats. Others need a format witness to be
  established.
- **No independent evaluation has been run.** [EXPERIMENT-001](docs/EXPERIMENT-001.md) is the protocol
  for one: does a fresh model with Context Cortex beat an agent that saves its own scripts, at equal
  assurance? Until it is run, that advantage is a hypothesis.

## Background

- [docs/PROPOSAL.md](docs/PROPOSAL.md): the original proposal.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the design.
- [docs/STARTING-EVIDENCE.md](docs/STARTING-EVIDENCE.md): what RightClick X measured. Context Cortex is
  a separate system that doesn't embed RightClick X, but its design follows those results.

Related work: [Voyager](https://arxiv.org/abs/2305.16291) (2023),
[SkillX](https://arxiv.org/abs/2604.04804) (2026),
[Learning by Doing](https://arxiv.org/abs/2611.01386) (2026).

License: not yet chosen.
