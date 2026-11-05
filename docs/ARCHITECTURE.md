# Architecture (draft 0)

**Status: a design. Nothing here is implemented.** It turns the [proposal](PROPOSAL.md) into components,
data and rules, and takes account of [what RightClick X has measured](STARTING-EVIDENCE.md). Where the
evidence leaves a design choice open, this page says so, and [EXPERIMENT-001](EXPERIMENT-001.md) is
designed to settle it.

## 1. The working hypothesis: the model proposes, the engine disposes

The newest independent evaluation found that an agent writing its own scripts acquired 6 of 6 unfamiliar
programs, where RightClick X's rule-based investigation acquired 1 of 6. It also found that RightClick
X's governance (pinning, confinement, receipts, provenance, refusals, assurance labels) held up, and
that the scripting agent had to hand-build all of it.

So Context Cortex starts from this split, as a hypothesis to test rather than a conclusion:

| The model does | The engine does |
|---|---|
| Reads documentation and guesses what a program is for | Holds the authority grant and refuses anything outside it |
| Proposes hypotheses and designs experiments | Runs experiments as one batch, bounded and sandboxed, without returning every trial to the model |
| Writes fixtures, adapters and validators when no built-in one exists | Pins every model-written artefact by digest, confines it and labels its origin |
| Chooses which goal to pursue next | Decides claim states from trial evidence, never from the model's say-so |
| Uses inherited skills | Crystallises, versions, revalidates and transfers skills |

The proposal asks the engine to do "much of the deterministic investigation". That remains true for the
*execution* of investigation: the model writes one experiment, the engine runs fifty trials and returns
a verdict. What changes is who *designs* the investigation. EXPERIMENT-001 compares both.

## 2. Components

```text
                 any model, through one MCP connection
                                 │
      13 RightClick X context_* tools  +  the Cortex tools (§4)
                                 │
  ┌──────────────────────────────┴───────────────────────────────┐
  │                        CONTEXT CORTEX                         │
  │                                                               │
  │  goal compiler ──► gap analyser ──► experiment engine         │
  │        ▲                │                  │                  │
  │        │                ▼                  ▼                  │
  │  possibilities ◄── affordance graph ◄── evidence ledger       │
  │        ▲                │                  ▲                  │
  │        │                ▼                  │                  │
  │     evolver  ◄──── crystalliser ──► skill store ──► transfer  │
  │                                                               │
  │  authority kernel: grant manifest · sandbox · effect classes  │
  └──────────────────────────────┬───────────────────────────────┘
                                 │
           RightClick X runtime: reflection, typed graph,
           planner, execution, receipts, witnesses, pins
```

| Component | Job | RightClick X today |
|---|---|---|
| **Affordance graph** | Capabilities plus *claims* about them, each with a state and evidence (§3) | Typed graph; `context_explain` shows observed behaviour; PR #61 adds witnessed formats and fidelity |
| **Evidence ledger** | Append-only trials: inputs by digest, argv, environment fingerprint, outputs by digest, witness verdicts | Receipts and run provenance (argv per file role still open, R8) |
| **Goal compiler** | Intention → required outcomes, hard requirements, constraints, acceptance checks | `context_compose` `have`/`want`, `preserve` (PR #61) |
| **Gap analyser** | For each candidate route, the claims that are missing or contradicted, and which experiment would resolve each | Compose refusals that name the unproven step (PR #61) |
| **Experiment engine** | Runs a model-written or engine-proposed experiment as one bounded batch; decides claim states | Fixed investigation of ~20–24 trials per program; flag experiments (PR #61) |
| **Witness registry** | Validators and decoders, built-in or model-written, each calibrated (§5) | Closed, hand-written format library; decoders as witnesses (PR #61) |
| **Crystalliser** | A demonstrated run → a skill with pinned steps, prerequisites, checks, limits, provenance, self-test | Saved goals |
| **Skill store** | Versioned, content-addressed skills | Saved goals with immutable revisions and leases |
| **Transfer** | Export and import skill bundles; import always revalidates | Peers and published goals (MCP, REST, GraphQL) |
| **Evolver** | Reopens limited or failed capabilities when the environment or the evidence changes | Bootstrapping loop (PR #61) |
| **Possibilities** | The difference in reachable, established outcomes between two graph revisions | `context_actions` reports what runs now |
| **Authority kernel** | Grant manifest, sandbox, effect classes, refusal | Risk labels, operator approval, sandbox, SSRF guards |

## 3. The empirical affordance graph

A conventional graph says `A accepts PNG → A produces WebP`. The affordance graph keeps that edge and
attaches **claims**. A claim is one checkable statement about a capability.

| Claim kind | Example |
|---|---|
| `precondition` | accepts PNG with an alpha channel; rejects 16-bit PNG with exit 1 |
| `effect` | writes exactly one file at the path given to `-o`; no network; no other writes |
| `preservation` | pixels preserved exactly when `-lossless` is given; EXIF dropped |
| `authority` | needs execute on `/opt/homebrew/bin/cwebp`; effect class `sandbox-write` |
| `failure` | truncated input gives exit 0 and a damaged output (so exit 0 is not success here) |
| `composability` | output satisfies `dwebp`'s input precondition |
| `substitute` | `ffmpeg -c:v libwebp_anim` reaches the same outcome, not proven lossless |

Every claim has a **state**, decided only by the engine from ledger evidence:

```text
 hypothesised ──trial supports──► observed ──meets promotion rule──► established
       │                              │                                   │
       └───────trial refutes──────────┴──────────► contradicted ◄─────────┘
                                                        (new evidence)
 any state ──subject's identity pin changes──► stale (until revalidated)
```

- **Hypothesised:** someone said so (documentation, the model, another environment). Never planned on.
- **Observed:** at least one trial supports it.
- **Established:** the promotion rule for that claim kind holds: for example, deterministic on at least
  two inputs, a calibrated witness confirms it, and the matching negative control behaves as predicted.
- **Contradicted:** a trial refutes it. Contradictions are reported, never silently resolved. A
  contradicted documentation claim is a finding.
- **Stale:** the program, a dependency or the environment changed since the evidence was gathered.

Planning uses established claims only. A route that needs an observed or hypothesised claim is
returned as a gap with the experiment that would close it, not executed.

The machine-readable form is [`schemas/affordance-claim.schema.json`](../schemas/affordance-claim.schema.json).

## 4. The tool surface

The proposal names eight new tools and says not to begin with all eight. EXPERIMENT-001 needs four,
plus one engine behaviour:

| Proposed | For EXPERIMENT-001 | Notes |
|---|---|---|
| `context_goal` | **yes** | Returns the compiled goal *and* its gap analysis, so `context_gap` is a field of its answer |
| `context_experiment` | **yes** | Takes a hypothesis set and an experiment spec, returns verdicts and claim changes, not raw trials |
| `context_crystallize` | **yes** | From a run id or receipt chain to a skill revision |
| `context_transfer` | **yes** | `export` and `import`; import runs the self-test before the skill is usable |
| `context_evolve` | engine loop only | Runs after every learn and import; a tool later, if the model needs to trigger it |
| `context_gap` | folded into `context_goal` | |
| `context_simulate` | later | Could be a dry-run mode of `context_compose` |
| `context_possibilities` | later, but measured | EXPERIMENT-001 computes the reachable-outcome diff offline as a metric |

That would take the interface from 13 tools to 17. Whether the extra tools live inside RightClick X or
in a separate package that drives it is open (§8).

## 5. Witnesses, including ones the model writes

RightClick X's witnesses come from a closed, hand-written library. That is why five of six held-out
programs stayed unacquired: no witness, no samples. The scripting agent won by writing its own.

Cortex lets the model contribute witnesses, adapters and sample generators, under four rules:

1. **Pinned and confined.** Stored by digest, run only in the sandbox, labelled `model-authored` with
   the session and model that wrote it.
2. **Independent of the subject.** A witness may not call the program whose claim it checks, or share
   code with it. A decoder may witness an encoder only when the decoder's own exactness is established.
3. **Calibrated before use.** A witness must accept known-good references and reject a set of
   known-bad mutations (truncated, bit-flipped, wrong container, lossy substitute) before its verdicts
   count. Calibration results are ledger trials like any other.
4. **Assurance says who checked.** A claim established only by model-authored witnesses carries that
   label. The result is never presented with the assurance of a built-in witness.

## 6. Skills and transfer

A **skill** is a crystallised, executable workflow ([`schemas/skill.schema.json`](../schemas/skill.schema.json)):

- **Steps:** capability references with pinned options and port bindings.
- **Prerequisites:** programs with identity pins, formats and the authority each step needs.
- **Success conditions:** the witness checks a run must pass to report success.
- **Known limitations:** contradicted claims and refused input classes, carried forward so the next
  agent does not rediscover them.
- **Provenance:** the acquiring session, model, ledger entries and receipts.
- **Self-test:** fixtures and expected witness verdicts. Revalidation runs these before the skill is used
  in a new environment.

A **transfer bundle** ([`schemas/transfer-bundle.schema.json`](../schemas/transfer-bundle.schema.json))
carries skills, the claims they depend on, evidence digests and model-authored artefacts. On import:

1. Every skill starts `imported-unvalidated`. Nothing is planned on until revalidation.
2. Identity pins are compared. A changed program makes its claims `stale`.
3. The self-test runs under the *importer's* authority grant. An imported bundle never brings authority
   with it.
4. Each skill becomes `revalidated` or `contradicted-here`, with the trials that decided it.

The inheriting model gets an executable contract, not a transcript. That is the proposal's
"transferable expertise".

## 7. Authority

The proposal's limit is non-negotiable, so it is enforced in the engine, not by instruction.

- **Grant manifest.** An explicit list: programs and directories executable for investigation, sample
  roots, network (none by default), writable locations (sandbox scratch by default), and whether any
  non-sandbox effect is allowed.
- **Discovery never grants permission.** A learned or imported capability has no authority of its own.
  Using it needs a grant that covers its established effect claims.
- **Unknown effects are worst-case.** A capability whose effects are not established is treated as
  `destructive` for planning and runs only in the sandbox, with no network and an empty writable
  directory. With no sandbox available, it does not run.
- **Experiments are never consequential.** `context_experiment` runs only on samples, fixtures and copies,
  only in the sandbox. No experiment touches a user's real data or a remote system's state.
- **Breaches invalidate results.** In EXPERIMENT-001 any action outside the grant fails the run, whatever
  its outcome.

## 8. Open decisions

| Decision | Options | Settled by |
|---|---|---|
| Who designs experiments | engine rules, the model, or both | EXPERIMENT-001 arms C-engine and C-model |
| Where Cortex lives | a package that drives RightClick X through its library API and serves the extra tools, or changes inside RightClick X | Start as a package: it keeps RightClick X's interface unchanged until the experiment earns the change |
| Witness independence for model-authored witnesses | the four rules in §5, or stricter (a second model must write the witness) | Calibration failure rate in EXPERIMENT-001 |
| Skill granularity | one skill per goal, or reusable sub-skills | Compounding metric in EXPERIMENT-001 |
| License | none yet (RightClick X is Apache-2.0) | Owner |
