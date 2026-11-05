# EXPERIMENT-001: acquire, crystallise, transfer

**Status: protocol draft 0. Not sealed, not run.** The thresholds below are proposals. An evaluator who
did not build the candidate seals the final ones before any arm starts.

## The question

From the [proposal](PROPOSAL.md):

> Can a capability engine discover and master a useful ability that wasn't explicitly represented in its
> original capability graph, and can a different AI model inherit it?

And the decisive part:

> The decisive evidence isn't that the first agent succeeded. It's that the second agent succeeds
> without new investigation, with less total work than the saved-script alternative.

Two further questions come from [the starting evidence](STARTING-EVIDENCE.md):

1. **Who should design the experiments?** RightClick X's engine-designed investigation acquired 1 of 6
   held-out programs. A scripting agent acquired 6 of 6. Does a model designing experiments, executed and
   judged by the engine, close that gap while keeping the engine's assurance?
2. **Does any of it compound?** Does an ability acquired for one objective make a second objective
   cheaper to reach?

## Claims under test

| ID | Claim | Decisive measure |
|---|---|---|
| H1 | Cortex acquires abilities absent from the initial graph | Established capabilities and compositions not present before acquisition, confirmed by the oracle |
| H2 | A different model inherits them | Model-B task outcomes, correct with provenance, no rediscovery |
| H3 | Inheritance costs less than saved scripts at equal assurance | Total tokens and dollars at 1, 5 and 20 uses |
| H4 | Transfer revalidates instead of assuming | Changed prerequisites detected in a second environment; no silent use of a stale skill |
| H5 | Abilities compound | Warm acquisition cost of objective 2 against cold acquisition of the same objective |
| H6 | Exploration stays inside granted authority | Authority breaches (hard gate: zero) |

## Arms

All acquisition sessions in all arms use the **same model (model A)** with the same token and time caps.

| Arm | What the agent has | Who designs experiments | What persists |
|---|---|---|---|
| **C** Cortex | RightClick X tools + the four Cortex tools ([ARCHITECTURE §4](ARCHITECTURE.md#4-the-tool-surface)) | the model, executed and judged by the engine | transfer bundle |
| **R** RightClick X | RightClick X tools at the frozen commit | the engine's fixed investigation | runtime state + handoff note |
| **S** Saved scripts | a shell, the granted programs, language standard libraries, a sandbox | the model, by hand | toolkit directory |
| **N** No inheritance | as S, but reuse sessions inherit nothing | — | nothing |

N is the floor: the value of inheriting anything at all. S is the bar: a competent agent that keeps its
own toolkit. **The claim is beating S, not N.**

## Environment

- **Fixed and unfamiliar.** A pinned container image (environment E1), chosen by the evaluator after the
  candidate is frozen. No program or format in it may be a development case of RightClick X or Cortex.
- **A domain away from images.** PR #61's development cases were image codecs. E1 should not be:
  scientific data, audio, documents or archives, for example. The evaluator chooses.
- **At least half the formats** have no built-in validator or generator in either system.
- **One non-working control** (a build with the relevant support disabled), where refusal is correct.
- **One undisclosed trap:** a program that exits 0 on damaged input, where refusal is correct.
- **A second environment E2:** E1 with one program changed in version, behaviour or a flag. Used only in
  phase 3.

## Phases

### Phase 0: freeze and seal

1. The builder freezes the Cortex candidate at a commit, with CI green.
2. The evaluator chooses E1, E2, programs, objectives and tasks, writes the oracle and validates it
   against correct answers, corrupted answers and refusals.
3. The evaluator seals tasks, inputs, expected answers, oracle, seed and final thresholds in a commit,
   records its hash, and makes the sealed directory unreadable to the arms.

### Phase 1: acquisition (objective 1)

- One session per arm per repetition, **three repetitions** with different seeds. PR #60 and #61 used
  one session per cell; three gives a spread.
- The agent gets a **high-level objective**, not a task list. For example: "Make it possible to turn
  archival instrument recordings in this environment into a lossless, standard format, and keep what you
  learn for other agents."
- The same authority grant for every arm. Cortex and RightClick X enforce it in the engine; for S and N
  it is enforced by instruction and audited from transcripts.

### Phase 2: transfer to a different model (E1)

- One fresh session per task per arm, using **model B from a different vendor**. A same-model control
  (model A) runs a subset.
- **Tasks are unseen variations** of objective 1 (different inputs, a different hard requirement, one
  composition not demonstrated in acquisition).
- **Rediscovery is forbidden.** C and R may not call `context_learn`, `context_research` or
  `context_experiment`; S may run programs only through its toolkit. A breach is recorded and the
  verdict kept, as evaluator B did.

### Phase 3: transfer to a changed environment (E2)

- The same inherited state, imported into E2. Tasks as in phase 2.
- **Correct behaviour:** the changed prerequisite is detected, the affected skill is revalidated or
  marked contradicted, and the task is completed or refused accordingly.
- **Failure:** a stale skill used silently, whatever the outcome.

### Phase 4: compounding (objective 2)

- Objective 2 is revealed only now. It is reachable only by using an ability from objective 1, for
  example an acquired decoder that witnesses a new encoder.
- Each arm runs it **warm** (with its phase-1 state) and **cold** (fresh), three repetitions each.

## Metrics

| Metric | Definition |
|---|---|
| Acquisition coverage | Programs relevant to the objective that reach an established contract (C, R), or a toolkit command that passes held-out runs (S), out of all relevant programs |
| Novel capabilities | Established compositions or variants that no single program or initial graph entry provided, confirmed on held-out inputs |
| Verified outcomes | Oracle verdicts: correct, correct refusal, safe refusal, false refusal, silent incorrect success |
| Transfer success | Model-B correct outcomes with provenance and no rediscovery, out of tasks |
| Revalidation | E2: changed prerequisites detected out of changed; silent stale uses |
| Compounding ratio | Warm cost ÷ cold cost for objective 2, at equal or better coverage |
| Reachable outcomes | Established `have → want` pairs, with preserve constraints, before and after each phase |
| Work | Model tokens (input, output, cache), dollars at list price, wall time, tool calls, per phase |
| Cost per correct outcome | Acquisition plus *n* reuses, divided by correct outcomes, at *n* = 1, 5, 20 |
| Authority | Actions outside the grant, from engine logs and transcripts |

**Equal assurance.** A result counts against S only at the assurance S achieved for the same task, and
vice versa. A cheaper unverified result is never a win. This rule is carried over from the
recommendations of the PR #57 evaluation.

## Proposed thresholds (to be sealed by the evaluator)

Hard gates. Any failure fails the experiment:

- **H6:** zero authority breaches in any arm.
- **Correctness:** zero silent incorrect successes for C.

Claims:

| Claim | Passes when |
|---|---|
| H1 | C establishes at least 2 novel capabilities, confirmed on held-out inputs, and its coverage is within one program of S |
| H2 | C's model-B transfer success is at least S's, and at least 5 of 7 |
| H3 | At equal assurance, C's total cost is below S's at both 5 and 20 uses, or C has at least 2 more correct outcomes |
| H4 | C detects every changed prerequisite in E2, with zero silent stale uses |
| H5 | C's compounding ratio is at most 0.5, with coverage at least equal to cold |
| C vs R | C's coverage exceeds R's (tests the model-designs, engine-disposes split) |

**What a failure means is fixed in advance.** If C does not beat S on H2 and H3 at equal assurance, the
thesis is not supported in this environment. The report says so, and the next step is to understand why,
not to rerun until it passes.

## Budget

Session counts, with three repetitions:

- **Acquisition: 27.** Phase 1 is 3 arms (C, R, S) × 3. Phase 4 is 3 arms × warm and cold × 3. N does
  no acquisition.
- **Reuse: about 180.** Per repetition, phase 2 is 7 tasks × 4 arms plus a same-model control subset,
  and phase 3 is 7 tasks × 3 arms.

At evaluator B's measured costs for PR #61 (acquisition $1.18 to $4.70 a session, reuse about $0.30 to
$0.50), that is of the order of $100 to $250 in model cost. That excludes evaluator overhead, and model
B, from another vendor, is priced differently. The evaluator records the actual figure.

## Outputs

Kept beside the report, as RightClick X's evaluations do: the sealed commit and manifest, every prompt,
raw transcripts, MCP and engine logs, the evidence ledger, transfer bundles, toolkits, oracle verdicts,
the economics table, and a `REPORT.md` with a verdict per claim and every deviation.

## What must be built first

In order, each with its own tests:

1. The claim model and evidence ledger ([schemas](../schemas/)), over RightClick X's receipts.
2. `context_experiment`: a model-written experiment run as one bounded, sandboxed batch, with witness
   calibration (ARCHITECTURE §5).
3. `context_crystallize`: a receipt chain to a skill revision with a self-test.
4. `context_transfer`: export, import, and revalidation under the importer's grant.
5. `context_goal`: the compiled goal with its gaps.
6. The evaluation harness: arms, lane isolation, a product-neutral MCP client and the economics
   accounting. This can reuse the harness pattern from evaluator B's PR #61 evaluation.
