# Using Context Cortex

The MCP tools and the `cortex` CLI take the same JSON. The examples learn `gzip`; the same pattern works
for any granted program. A complete run is in [`test/helpers.js`](../test/helpers.js) (`learnGzip`), and
the bundle it exports is [`examples/gzip-verified.bundle.json`](../examples/gzip-verified.bundle.json).

State lives in `$CORTEX_HOME` (default `~/.context-cortex`):

- `grant.json` holds the operator's grant;
- `state.json` holds operations, experiments, claims, witnesses and skills;
- `ledger.jsonl` is the hash-chained evidence;
- `artefacts/` holds the content-addressed bytes.

## Sources

Anywhere an input is expected:

| Form | Meaning |
|---|---|
| `"sha256:…"` or `{"artefact": "sha256:…"}` | An artefact already stored, such as a trial's output |
| `{"path": "/abs/file"}` | A file inside an operator read root |
| `{"text": "…"}`, `{"base64": "…"}` | Bytes supplied by the model (origin `model-authored`) |
| `{"mutate": {"of": <source>, "kind": "truncate"}}` | Deterministic damage: `truncate`, `corrupt-header`, `flip-middle` or `empty` |

## 1. Probe

```json
{ "action": "probe", "program": "/usr/bin/gzip" }
```

This runs the program with `--help`, `-h` and no arguments, sandboxed and with no inputs. It returns the
text and the formats it mentions. That text is documentation and a source of hypotheses only.

## 2. Experiment

```json
{
  "operation": {
    "id": "gzip.compress",
    "program": "/usr/bin/gzip",
    "args": ["-n", "-c", "{in:data}"],
    "inputs": { "data": "text/plain" },
    "outputs": { "stdout": "application/gzip" }
  },
  "trials": [
    { "inputs": { "data": { "path": "/samples/a.txt" } } },
    { "inputs": { "data": { "path": "/samples/b.txt" } } }
  ],
  "controls": false
}
```

- **Arguments:** `{in:name}` is replaced by the staged input file, with an extension matching its
  declared format. `{out:name}` is replaced by an output path. An output named `stdout` captures
  standard output, and `"stdin": "name"` feeds an input to standard input.
- **Ids:** operation ids are immutable. A different definition needs a new id.
- **Trials:** each runs once in a fresh sandbox. A trial succeeds when the program exits 0 and every
  declared output is non-empty. Use `"expect": "failure"` for an input the program should refuse.
- **Controls:** by default, the first two successful trials are re-run with `truncate` and
  `corrupt-header` damage. They must be refused, or the `rejects:<kind>` claim is contradicted. Set
  `{kinds, limit, input}` to change that, or `false` when damage is meaningless (any text is valid
  text).
- **Determinism:** one successful trial is repeated. Different outputs keep claims at `observed`.

The report lists every trial, control and judgement, and every claim's state with reasons.

Use `-n` with gzip: without it, gzip stores the file name and modification time, and the outputs of
identical inputs can differ.

## 3. Calibrate a witness

A witness judges results. This one says "decompressing `compressed` gives back `original`", using the
established `gzip.decompress` operation as a decoder:

```json
{
  "action": "calibrate",
  "witness": { "id": "gzip-roundtrip", "builtin": "bytes-equal", "params": ["original", "compressed"], "via": { "compressed": "gzip.decompress" } },
  "references": [
    { "bind": { "original": { "path": "/samples/a.txt" }, "compressed": "sha256:<a trial output>" } }
  ]
}
```

- **Witness kinds:** `builtin` (`bytes-equal`, `nonempty`, `format-is` with `format`), or a granted
  program with `args` using `{param:name}` and `accept: {exit: 0}`.
- **`via`:** passes a param through an operation before comparing. The operation's output claim must be
  established.
- **Calibration:** the engine damages the last param of every reference (`truncate`, `corrupt-header`,
  `flip-middle`). The witness must accept every reference and reject every mutation. A witness that
  accepts anything fails calibration.

## 4. Test a hypothesis

```json
{
  "operation": { "id": "gzip.compress", "...": "same definition as before" },
  "trials": [ { "inputs": { "data": { "path": "/samples/a.txt" } } }, { "inputs": { "data": { "path": "/samples/b.txt" } } } ],
  "controls": false,
  "hypotheses": [{
    "id": "lossless", "kind": "preservation", "text": "decompressing the output returns the input exactly",
    "property": "bytes", "value": "exact",
    "check": { "witness": "gzip-roundtrip", "bind": { "original": "input.data", "compressed": "output.stdout" } }
  }]
}
```

The witness runs on every successful trial. Two distinct supporting inputs, determinism and a calibrated
witness establish the claim `gzip.compress:lossless`.

## 5. Crystallise

```json
{ "skill": {
  "id": "gzip-verified",
  "title": "Compress text with gzip, verified lossless",
  "objective": "Compress a text file so that decompressing it returns exactly the original bytes.",
  "inputs": { "text": "text/plain" },
  "steps": [ { "id": "compress", "operation": "gzip.compress", "bind": { "data": "input.text" } } ],
  "output": "steps.compress.stdout",
  "preserve": ["bytes"],
  "successConditions": [ { "witness": "gzip-roundtrip", "property": "bytes", "bind": { "original": "input.text", "compressed": "steps.compress.stdout" } } ],
  "selfTest": { "fixtures": [
    { "id": "text", "inputs": { "text": { "path": "/samples/a.txt" } }, "expect": "pass" },
    { "id": "binary-is-refused", "inputs": { "text": { "base64": "iVBORw0KGgoAAAANSUhEUg==" } }, "expect": "refuse" }
  ] }
} }
```

- **Steps:** bind each operation input to `input.<name>` or `steps.<id>.<output>`, and formats must
  match. A skill may chain several operations.
- **Preserved properties:** each needs either a success condition with that `property`, or an
  established preservation claim for every step.
- **Answer:** the result is `established`, or `draft` with the gaps. The limitations include every
  contradicted claim about the operations used.

## 6. Use, export, import

```json
{ "action": "run", "id": "gzip-verified", "inputs": { "text": { "path": "/samples/new.txt" } }, "deliver": "/out/new.txt.gz" }
{ "action": "export", "skills": ["gzip-verified"], "path": "/out/gzip.bundle.json" }
{ "action": "import", "path": "/samples/gzip.bundle.json" }
```

The import report lists each step:

- `programs`: same or different program here;
- `calibrations`;
- `experiments`, re-run with their claim states;
- `agreement`: the exporter's state against this host's, for every claim;
- `skills`: `revalidated`, or `contradicted-here` with the gaps.

## 7. Possibilities

```json
{}
{ "since": "120" }
```

`context_goal` with no `have` or `want` lists every established route between formats and the
properties proven along each one. With `since` (a ledger sequence number or an ISO time), it also lists
what became possible after that point.

## CLI equivalents

```text
cortex probe /usr/bin/gzip
cortex experiment spec.json          cortex calibrate witness.json
cortex claims --operation gzip.compress
cortex crystallize skill.json        cortex run gzip-verified --in text=/samples/new.txt --deliver /out/x.gz
cortex goal --have text/plain --want application/gzip --preserve bytes
cortex possibilities --since 120
cortex export gzip-verified --out /out/b.json     cortex import /samples/b.json
cortex ledger verify
```

## The other tools

| Tool | Example arguments |
|---|---|
| `context_discover` | `{}` or `{"formats": ["image/png"], "limit": 50}` |
| `context_probe` | `{"program": "/usr/bin/gzip"}` |
| `context_artefact` | `{"action": "get", "digest": "sha256:…"}`, `{"action": "list", "format": "text/plain"}`, `{"action": "mutate", "digest": "sha256:…", "kind": "truncate"}` |
| `context_witness` | `{"action": "calibrate", "witness": {…}, "references": [{"bind": {…}}]}`, `{"action": "list"}` |
| `context_claims` | `{"operation": "gzip.compress", "state": "observed"}` |
| `context_explain` | `{"claim": "gzip.compress:lossless"}`, `{"operation": "gzip.decompress"}`, `{"entry": 42}` |
| `context_gap` | `{"have": "application/gzip", "want": "text/plain", "preserve": ["bytes"]}`. Submit each draft's `first` then `then` |
| `context_possibilities` | `{"since": "120"}` |
| `context_simulate` | `{"have": "text/plain", "want": "application/gzip", "preserve": ["bytes"], "inputs": [{"text": "…"}], "witness": "gzip-roundtrip"}` |
| `context_compose` | `{"have": "text/plain", "want": "application/gzip", "preserve": ["bytes"], "run": {"input": {"path": "/samples/x.txt"}, "deliver": "/out/x.gz"}}` |
| `context_evolve` | `{}` after a program upgrade, or `{"operation": "gzip.compress"}` |
| `context_ledger` | `{"action": "verify"}`, `{"action": "entries", "kind": "trial", "limit": 20}` |

`compose` builds success conditions from the witnesses that established each preserved property, and
re-runs them on every use. Without anything to preserve, it calibrates a `format-is` witness for the
wanted format from stored samples, or falls back to `builtin:nonempty`.

## Code workspaces

The operator grants one:

```bash
cortex grant add-workspace ~/src/app
cortex grant add-program "$(command -v node)"
```

Add `--network` only if the workspace's builds need the network.

| Tool | Example |
|---|---|
| `context_workspace` | `{}` lists every workspace; `{"action": "search", "workspace": "~/src/app", "pattern": "TODO"}`; `{"action": "read", "workspace": "…", "path": "src/a.js"}` |
| `context_edit` | `{"workspace": "…", "path": "src/a.js", "replace": {"old": "a - b", "new": "a + b"}, "expectDigest": "sha256:…", "reason": "add subtracted"}` |
| `context_run` | `{"workspace": "…", "program": "/opt/homebrew/bin/node", "args": ["--test"]}` |
| undo | `{"action": "undo", "change": "edit-42"}` or `{"action": "undo", "change": "workspace-run-57"}` |

- **Reading:** the digest returned by `read` is what `expectDigest` checks. If anything changed the file
  since, the edit is refused.
- **Edits:** each one returns a change id and a unified diff.
- **Runs:** each one returns its exit code, `passed`, output tails and every file it added, changed or
  removed, with one change id that undoes them all.
- **History:** `context_workspace` with `action: "changes"` lists everything Cortex did there, with
  diffs and undo status.

## Requests in plain language

```bash
cortex do "Compress every text file in ~/inbox losslessly into ~/outbox"
cortex do "The tests in ~/src/app fail; fix the source, not the tests, and prove the suite passes"
cortex do "..." --dry-run     # print the prompt the agent would get
```

- **The agent:** `cortex do` runs Claude Code headless (`CORTEX_AGENT` names another compatible
  command). Its prompt holds the environment model, the rules and the request. It gets only the
  `context_*` tools: no shell and no file tools.
- **The report:** the agent's report goes to stdout. A summary from the ledger (entries by kind,
  deliveries, skills, code changes, test runs, undos) goes to stderr.
- **The record:** everything is saved under `$CORTEX_HOME/requests/`.
