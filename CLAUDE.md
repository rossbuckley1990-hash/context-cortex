# Working in this repository

Context Cortex is a research project on top of RightClick X (`~/src/rightclick-x`,
github.com/rossbuckley1990-hash/rightclick-x). Read `docs/STARTING-EVIDENCE.md` before proposing
anything.

## Evidence rules

- Name the commit, date and kind (development or independent) of every result you quote.
- Development evidence is never presented as acceptance. A session that builds a candidate does not
  evaluate it.
- Compare against saved scripts at equal assurance. A cheaper, less-checked result is not a win.
- Report failures and contradictions as findings. Never rerun until something passes.
- Independent evaluation workspaces outside the repository (for example `~/src/rcx-pr61-indep-b`) are
  read-only.

## Design rules

- The engine decides claim states from trial evidence. Documentation and model output are hypotheses.
- Discovery and import never grant authority. Unknown effects are planned as destructive and run only
  in the sandbox.
- Keep the tool surface small. A new `context_*` tool must be needed by an experiment.

## Checks

`npm test` validates the examples and the schemas' refusal rules. Keep it passing; when a schema
changes, add a negative case for any new rule in `scripts/check-schemas.mjs`.
