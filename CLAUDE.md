# Working in this repository

Context Cortex is a standalone MCP server and CLI (`bin/cortex.js`, engine in `src/`). It does not
embed RightClick X; `docs/STARTING-EVIDENCE.md` records what RightClick X measured, which shaped the
design. Read it before proposing a new direction.

## Layout

- `src/cortex.js`: the engine: operations, trials, witnesses, calibration, experiments, claim decisions
  (`decide` is the only place a claim state is set).
- `src/skills.js`, `src/transfer.js` and `src/goal.js`: skills, bundles with revalidation, and goals and
  possibilities.
- `src/sandbox.js`: sandbox-exec and bubblewrap confinement. `src/grant.js`: the operator's authority.
- `src/ledger.js`, `src/artefacts.js` and `src/state.js`: the hash-chained ledger, the
  content-addressed store, and locked state.
- `src/mcp.js`: the six `context_*` tools. `bin/cortex.js`: the CLI.

## Rules

- The engine decides claim states from ledger evidence. Documentation and model output are hypotheses.
- No MCP tool may change the grant. Discovery and import never grant authority.
- Nothing runs unconfined unless the operator set `allowUnsandboxed`.
- Keep the tool surface small: a new tool must be needed by a real workflow or by EXPERIMENT-001.
- Name the commit, date and kind (development or independent) of every result you quote. Development
  evidence is never presented as acceptance.

## Checks

`npm test` runs the node:test suite (engine, safety, confinement, a real MCP client session) and the
schema checks. Keep it passing. When a schema changes, run `npm run example` and add a negative case in
`scripts/check-schemas.mjs` for any new rule. On macOS, copies of signed system binaries are killed, so
tests use wrapper scripts for programs they modify.
