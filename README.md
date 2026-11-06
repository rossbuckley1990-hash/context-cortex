# Context Cortex

**An AI's experience with software, turned into abilities it can prove and pass on.**

Context Cortex is an MCP server and a command line (`cortex`). Through thirty-three `context_*` tools, any
model can understand the machine it is on, act on real code, and learn what the programs there actually
do by running bounded experiments in a sandbox:

- **The machine:** its programs, its data, its code workspaces, and what it already knows.
- **Real code:** read, search and edit it, run its tests and builds, hunt its weaknesses, fix them with
  proof, and undo any change.
- **Skills:** what works becomes a skill that checks its own results. Another model or machine can
  inherit it, and re-proves it before use.

You can also just ask, with `cortex do "<request>"`. The model's weights never change. What it can
reliably do keeps growing.

```text
  goal ──► probe ──► experiment ──► calibrate ──► crystallise ──► use ──► transfer
  "what do    read a    run trials,   build a       a workflow     run on    export; the
   I need?"   program's  controls,     checker that  becomes a      new       importer
              usage      repeats      must reject   self-testing   inputs,   re-runs every
              text                    damage        skill          checked   experiment
```

## What it gives an AI

- **It understands its whole environment.** `context_environment` covers:
  - the host and what its sandbox enforces;
  - the operator's authority;
  - every granted program and what it says it does;
  - a census of the data by actual content;
  - every code workspace: git branch, languages, manifests, and the test and build commands it uses;
  - what is already established;
  - what it can do with the data right now;
  - what is missing.

  `context_manual` states the rules its own code enforces.
- **It acts on real code.** In workspaces the operator grants, it reads and searches code, makes
  digest-checked edits, and runs any executable that work needs — the project's tests and builds,
  npm, git, make (`context_run`). Every edit and
  every file a run touches is in the ledger with its diff and can be undone.
- **It acts on what you ask.** `cortex do "fix the failing tests in ~/src/app"` hands the request to an
  agent primed with the environment model and the rules, restricted to Cortex's tools. Afterwards the
  ledger, not the agent's own account, says what was done.
- **It surveys any code it is pointed at the way an attacker would — and proves every claim by
  driving it.** `context_reach` maps what fires with your authority in that code and who controls
  each trigger file (a hook shipped in the tree belongs to whoever you cloned it from).
  `context_escape` drives the real escape moves to establish exactly what code run from the
  workspace could do to this host. `context_gates` inventories the host's defenses and the honest
  distance to root — the host itself is the target, no workspace needed. `context_secrets` maps
  every credential the target can reach and proves the read with a sandboxed run — digests, never
  contents. `context_persist` executes each auto-execution primitive's own code to demonstrate
  what would run unsandboxed on your next install or commit, and proves by refused-write trials
  that this grant cannot plant on the host's persistence surfaces.

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

Grant a code workspace and ask for something:

```bash
node bin/cortex.js grant add-workspace ~/src/my-app
node bin/cortex.js grant add-program "$(command -v node)"
node bin/cortex.js do "The tests in ~/src/my-app fail. Fix the source, not the tests, and prove the suite passes."
```

Or connect any MCP client and give the model a goal, not a tool list:

> Using Context Cortex, find out what /usr/bin/gzip can do, prove which operations are lossless, and
> save a skill another agent can use to compress text with a verified round trip.

## The thirty-three tools

Every tool the proposal named exists as its own tool, plus the ones an AI needs to understand its
environment, act on code, and use the rest without a shell.

| Tool | What the AI gets |
|---|---|
| `context_environment` | Everything it can reach and knows: host, sandbox, authority, programs, data census, code workspaces, knowledge, what it can do with the data now, and what is missing |
| `context_manual` | The rules its code enforces: tools, claim states, witnesses, skills, transfer, formats, sources and sandbox policy |
| `context_workspace` | Real code: an overview of each granted workspace, plus files, read (with digest), search, and every change Cortex made there with diffs |
| `context_edit` | Reversible edits: exact-string replace, whole content or delete, refused if the file changed since it was read; `undo` puts back any edit or run |
| `context_run` | Any executable — the project's tests, builds, linters, npm, git — run in the workspace with everything else confined. Every file it changed is reported and undoable |
| `context_audit` | Adversarial trials: every known-good sample against every kind of damage, each finding reproduced before it counts, clean refusals feeding `rejects:<damage>` claims, and an honest statement of what was not tested |
| `context_recon` | Every way into a granted codebase, and proof where they open: entry points, capabilities, dependencies, secrets in the clear, and function-scoped source→sink taint routes (command injection, eval, traversal, SQL injection, XSS, SSRF, prototype pollution, deserialization). argv-sourced routes are exploit-verified by driving the real code with a payload in the sandbox, twice: a reproduced marker, executed command or out-of-workspace read counts as exploited; a write the sandbox refused is reported as contained. Undoable, ledgered, with its own coverage stated |
| `context_repair` | Fixes that carry proof: a one-line guard is applied through reversible edits to what recon proved open, then the exact payload is re-driven twice and must not reproduce, a benign input must behave identically (same exit status and output), and the workspace's own tests must not regress — otherwise the fix is reverted byte-exactly and the failed check named. A write only the code now refuses counts as hardened. Routes that cannot be driven, and classes with no honest one-line guard, come back as needs-redesign with the reasoning, never silently skipped |
| `context_plan` | Any plain-language requirement compiled into grounded, executable `context_*` steps against the real code and state — the files to read, the recon and repair to run, the edits to make, the tests to run — with every step's tool and arguments named from what is true in the workspace, placeholders marked where grounding cannot fill them, and what is missing stated as a need |
| `context_reach` | The grant's true capability graph — programs, read and write roots, workspaces, network — plus every auto-execution trigger in the target's code, classified by the event that fires it, whose authority it runs with, and who controls the trigger file: shipped-in-the-tree triggers belong to whoever you cloned the code from. Recon finds entry points; reach classifies who consents to execution. The tripwire map of any granted code |
| `context_escape` | What could code run from this workspace actually do to the host — established by driving the real attacker moves: writes aimed at home, LaunchAgents, rc files, `/tmp` and the parent, symlinks pointed out, home reads, `.git` hooks and git-config, network, the inherited environment, a child that outlives its run. Every attempt a ledgered trial ending refused, isolated or reverted — or escaped: a critical finding with the marker to remove |
| `context_gates` | The host's defenses inventoried from one process's honest vantage: SIP, Gatekeeper, the application firewall, FileVault, Endpoint Security clients, listening sockets, SUID binaries and PATH hygiene (ptrace scope and the LSMs on Linux), each measured with the host's own query commands inside the fence or marked not-measured with the reason — plus the engine's own fence policy. The target is the host itself; no workspace needed |
| `context_secrets` | Credential reachability for any granted root or workspace, without the keys: every credential-shaped file reported as type, path and digest, and the read-reachability claim then driven — a sandboxed run reads each workspace credential and hashes the same bytes the scan saw, demonstrating the exfiltration-enabling read while still reporting digests. Contents are revealed only by the operator at their terminal, per item, each reveal ledgered; over MCP a reveal is refused whatever it asks |
| `context_persist` | The persistence survey of any granted code with the attack lens: every auto-execution primitive with its firing event, whose authority, and who controls it — each one driven, its own code executed once sandboxed as its real mechanism would run it (output never copied), demonstrating what runs with your authority on the next install or commit. Plus launchd-shaped definitions lying inert in code, and refused-write trials proving this grant cannot plant on any standard host persistence surface |
| `context_apply` | A skill run over every matching file in a directory, each output checked and delivered, never overwriting |
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

- **The grant is the operator's.** It lists programs, read roots, write roots and code workspaces.
  Discovery, experiments and imports never widen it, and no MCP tool can change it.
- **Code workspaces:**
  - granted with `cortex grant add-workspace <dir>`, and `--network` only if its builds need it;
  - edits and runs never leave the workspace, never touch `.git`, and never follow a link out;
  - every change keeps the bytes before and after, so it can be undone;
  - an edit is refused if the file changed since it was read.
- **Everything runs confined:** `sandbox-exec` on macOS, `bubblewrap` on Linux.
  - **Experiments:** no network, writes only inside a fresh work directory, home directories
    unreadable, and CPU, file-size, time and output limits.
  - **Workspace runs:** the same, except that the workspace is also writable, and network is allowed
    only where the operator granted it.

  With no sandbox nothing runs, unless the operator sets `allowUnsandboxed`.
- **Programs are pinned by digest.** A changed program makes its claims stale and its skills unusable
  until they are revalidated.
- **Bundles carry no authority.** On import, artefacts are checked against their digests, the schema is
  enforced, and the skill stays `imported-unvalidated` until this host has re-proven it.

The test suite checks each of these, including a hostile program that tries to read a home directory
file and write outside its sandbox (it can do both when the sandbox is off, and neither when it is on).

## Status

**v0.3.0, working and tested; experimental.** On macOS (sandbox-exec), `npm test` passes 85 tests and
17 schema checks. One of the tests is a real MCP client session over stdio that drives every tool. CI
runs the suite on macOS and on Linux with bubblewrap.

### Real agent runs (6 November 2026, development evidence)

In each run, a fresh headless Claude Code session had only the Context Cortex MCP tools: no shell and
no file tools. Every result was then checked outside Cortex: delivered files with the real
decompressors, and code with the project's own tests.

| Run | Given | What the agent did on its own | Cost |
|---|---|---|---|
| 1 (6 tools) | `zstd`, which the tests never use, and a goal | Probed it, established compress and decompress, calibrated a round-trip witness, and built an established skill. The delivered file decompresses with the real `zstd` to the original. | 19 turns, 115 s, $0.85 |
| 2 (18 tools) | A directory of six compressors it was not told about, and "give this machine as many verified lossless text-compression abilities as you can" | Discovered gzip, bzip2, xz, zstd, lz4 and brotli, and established six skills, each re-checking the round trip on every run. All six delivered files decompress to the original. | 53 turns, 246 s, $1.40 |
| 3 (`cortex do`, 24 tools) | A JavaScript project it had never seen, with three failing tests, and "fix the source, not the tests, and prove the suite passes" | Ran `npm test` (3 failing), found three bugs (whitespace splitting, trailing hyphens, lexicographic sort), made three reversible edits (`edit-18`…`edit-20`), and re-ran `npm test` (3 passing). Checked outside Cortex: the tests pass, and the test file and `package.json` are byte-identical to before. | 10 turns, 49 s, $0.31 |

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

- **HTTP APIs:** not reflected as operations. A workspace run can reach the network where the operator
  allows it, but experiments never can.
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
