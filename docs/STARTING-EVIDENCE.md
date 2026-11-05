# Starting evidence: what RightClick X has measured

Context Cortex builds on [RightClick X](https://github.com/rossbuckley1990-hash/rightclick-x). Before
designing anything new, this page records what has already been measured, so the first experiment
starts from evidence rather than from a demo.

**As of 5 November 2026.** Every result names the commit it measured. Development evidence (measured by
the session that wrote the code, on programs it had seen) is kept apart from independent evaluation
(a fresh evaluator, programs chosen after a freeze, a sealed oracle).

## What exists on RightClick X `main` (`fc5710e`)

- **A fixed interface of 13 `context_*` MCP tools** over a semantically typed capability graph
  (`context_research`, `context_learn`, `context_compose`, `context_run`, `context_actions`,
  `context_inspect`, `context_explain`, `context_graph`, `context_providers`, `context_run_status`,
  `context_watch`, `context_forget`, `context_runtime`).
- **Reflection** of OpenAPI, GraphQL, MCP servers, web forms, peers and supported platform bindings into
  that graph, plus command-line programs with byte-exact binary artefacts and file roles (PR #57).
- **Saved goals** (`context_compose` with `publish`): a successful outcome becomes `goal:<slug>`, keeps
  its declared checks and risk constraints, and re-plans when a compatible implementation changes.
- **Governance:** risk labels (`read`, `write`, `external`, `destructive`), operator approval for
  destructive calls, sandboxed execution, program identity pinning, receipts, separate read-only
  witnesses, and assurance labels (`verified`, `checked`, `unverified`).

## Results, oldest first

| When | What | Kind | Result |
|---|---|---|---|
| 16 Oct 2026 | Claude Code → Codex saved-goal reuse across a REST → MCP protocol change | development, real public data | A fresh Codex session reused the saved goal; the route was re-learned and re-planned inside one invocation; a separate auditor checked the new answer. 52 phase checks passed. |
| PR #57, `20bc3a7` | Binary artefacts and file roles; independent acceptance | independent | Binary transport byte-exact. Autonomous acquisition **1 of 6** held-out programs. Defects CE1–CE5, fixed in PR #59. |
| PR #60, draft | Autonomous binary acquisition and typed composition | research | Held-out acquisition **1 of 6**. Composed a needlessly lossy route. Lost to a saved-script agent on quality and on repeat-use cost. |
| PR #61, draft, source `cb30f68` | Capability bootstrapping: witnessed formats, sample pool, flag experiments, goal-aware composition | **development** | On the six (now known) programs: 1/6 strict, 3/6 with helper authority, 4/6 with one approved sample root. A fresh agent produced a lossless AVIF through `dwebp` → `avifenc --lossless`, a route found by flag experiments, with pixels confirmed end to end. |
| PR #61, freeze `f88e01c` | Independent acceptance, evaluator B, sealed protocol, six new programs, 20 sessions | **independent** | See below. |

## The newest independent result (PR #61, evaluator B, 5 November 2026)

Six programs chosen after the freeze (`cws2fws`, `fax2tiff`, `x264`, `tiff2rgba`, `tiff2pdf`,
`pal2rgb`), seven sealed tasks, two arms run by the same model: RightClick X (R) against an agent that
writes and saves its own scripts (S).

| Claim | Sealed threshold | R | S |
|---|---|---|---|
| Acquisition | ≥ 4/6 acquired empirically | **1/6** at every authority tier | 6/6 at every tier |
| Automatic composition | ≥ 2 workflows meeting requirements | **0** | — |
| Fresh-agent inheritance | ≥ 4/7 correct, with provenance, no rediscovery | **3/7** | 7/7 |
| Silent incorrect successes | 0 | **0** | 0 |
| Cost per correct outcome | — | $1.61 | $0.94 |

What held up under adversarial tests: identity pinning, sandbox confinement, receipts, artefact
provenance, refusal discipline and honest assurance labels. The evaluator's recommendation was to
**pivot** from "RightClick discovers integrations itself" to "an agent writes the adapter and validator;
RightClick pins, confines, checks, records and hands it to the next agent".

The report is held outside both repositories. A second, concurrent evaluation of PR #61 had not
reported when this page was written.

## What this means for Context Cortex

1. **The proposal's first experiment has already been attempted once, in a narrower form, and failed
   its thresholds.** PR #61 asked an engine to acquire unfamiliar programs by itself and hand them to a
   fresh agent. The engine acquired 1 of 6. An agent writing scripts acquired 6 of 6.
2. **The model is the better experimenter today.** Every program the engine missed, the scripting agent
   understood. Reading usage text, guessing a format, building a sample and checking a result are
   things a model does well and a fixed rule library does badly.
3. **The engine is the better custodian.** Nothing the scripting agent built was pinned, confined,
   witnessed or receipted unless it hand-built that too. That is the part RightClick X measured well.
4. **So the division of labour is an open question, and the first experiment must test it.** The
   proposal says the engine should do "much of the deterministic investigation". The evidence says the
   engine's own investigation loses. [EXPERIMENT-001](EXPERIMENT-001.md) measures both divisions of
   labour against saved scripts at equal assurance, and lets the result decide.
5. **The comparison is saved scripts, not a bare model.** Beating a model with no memory is easy.
   Beating a competent agent that saves its own toolkit, at the same assurance level, is the claim.
