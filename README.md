# Context Cortex

**An AI's experience with software, turned into abilities it can prove and pass on.**

Context Cortex is an MCP server and a command line (`cortex`). Through eighteen `context_*` tools, any model
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

## The eighteen tools

Every tool the proposal named exists as its own tool, plus the ones an AI needs in order to use them
without a shell.

| Tool | What the AI gets |
|---|---|
| `context_status` | The grant, the sandbox, counts of operations, claims by state, witnesses and skills, and ledger integrity |
| `context_discover` | A survey of every granted program, with no task needed. Each is probed, sandboxed, for what it says it is and which formats it mentions; unchanged programs are not re-probed |
| `context_probe` | One program's usage text, read sandboxed with no inputs |
| `context_artefact` | Store a sample, read any artefact back (text or base64, bounded), list artefacts, or make a deliberately damaged copy |
| `context_experiment` | Trials, negative controls, a determinism repeat and witness-checked hypotheses, with every claim decided from the evidence |
| `context_witness` | Calibrate a checker against references and generated damage; list or explain witnesses |
| `context_claims` | Every claim with its state, evidence counts and why it is not established yet |
| `context_explain` | The trail behind an operation, claim, witness or ledger entry, down to each trial's inputs, outputs and verdict |
| `context_goal` | For `have → want` with `preserve`: skills, routes, and the state of every claim they rest on |
| `context_gap` | The gaps on the nearest routes, each with a ready-to-submit draft that closes it. For a property to preserve, that includes a witness built from demonstrated trials and an established decoder |
| `context_possibilities` | Every format reachable through established operations, the properties proven along each route, and what became possible `since` a point |
| `context_simulate` | Candidate routes run side by side on real inputs, sandboxed, delivering nothing: what completed, real output formats, sizes, time and checks |
| `context_compose` | The best fully established route turned into a skill in one call, with success conditions from the evidence and self-test fixtures from stored samples; it can run the skill at once |
| `context_crystallize` | A skill defined by hand, held to the same rules |
| `context_skill` | `list`, `explain` or `run` a skill. Every step runs sandboxed, success conditions are checked, and the output can be delivered into a write root |
| `context_evolve` | Re-runs what is stale or unfinished (a changed program, observed claims, an outdated witness, an unusable skill) and reports every state that moved |
| `context_transfer` | `export` a bundle; `import` one, which re-runs everything here; `revalidate` an earlier import |
| `context_ledger` | Verify the hash chain and read entries by kind |

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

**v0.2.0, working and tested; experimental.** On macOS (sandbox-exec), `npm test` passes 38 tests and
17 schema checks. One of the tests is a real MCP client session that drives all eighteen tools over
stdio. CI runs the suite on macOS and on Linux with bubblewrap.

### Real agent runs (6 November 2026, development evidence)

In each run, a fresh headless Claude Code session had only the Context Cortex MCP tools: no shell and
no file tools. Every delivered file was then checked outside Cortex with the real decompressor.

| Run | Given | What the agent did on its own | Cost |
|---|---|---|---|
| 1 (6 tools) | `zstd`, which the tests never use, and a goal | Probed it, established compress and decompress, calibrated a round-trip witness, and built an established skill. The delivered file decompresses with the real `zstd` to the original. | 19 turns, 115 s, $0.85 |
| 2 (18 tools) | A directory of six compressors it was not told about, and "give this machine as many verified lossless text-compression abilities as you can" | Discovered gzip, bzip2, xz, zstd, lz4 and brotli, and established six skills, each re-checking the round trip on every run. All six delivered files decompress to the original. | 53 turns, 246 s, $1.40 |

What the runs exposed was as useful as what they built:

- **An engine bug (run 1).** Unrecognised binary got past a `text/plain` input check. It is fixed and
  has a regression test.
- **Software that cannot be trusted to refuse (run 1).** The compressor accepts damaged input. That is
  correct behaviour for a compressor, and it was recorded as a contradicted claim.
- **A checker too weak for its job (run 2).** `brotli -t` failed calibration because it accepts a
  stream with one byte flipped: Brotli has no checksum. The agent did not trust it, and relied on the
  decompress-and-compare witness, which does catch the flip.
- **Formats the detector cannot see (run 2).** Brotli has no signature, so its decompressor's
  `accepts` claim stays `observed`. The agent reported this instead of claiming it.

These are development runs by the builder, not an independent evaluation.

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
