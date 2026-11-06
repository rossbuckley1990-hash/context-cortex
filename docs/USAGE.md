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

## Audit an operation

Adversarial trials on an operation you have already learned (or define inline): every known-good
sample meets every kind of deterministic damage, and a weakness counts only when it reproduces.

```json
{
  "operation": "gzip.decompress",
  "inputs": { "data": ["sha256:<a trial output>", "sha256:<another trial output>"] }
}
```

- **Operation:** an id learned earlier, or a definition as in an experiment. Every input of the
  operation needs at least one known-good source; each source is damaged by each kind while the
  other inputs take their first source.
- **Kinds:** all of `truncate`, `corrupt-header`, `flip-middle`, `empty` unless `kinds` narrows them.
- **Findings:** `crash` (death by a signal such as SIGSEGV — seen directly, or as exit code 128+N
  when a sandbox wrapper like bubblewrap reports it), `silent-accept` (exit 0 with output on damaged input),
  `hang`, `resource-kill`, `output-flood`. Every candidate is repeated; it counts only when the same
  class reproduces. Anything else is reported as `unconfirmed`, never silently dropped.
- **Claims:** the runs feed the same evidence machinery as negative controls. A clean refusal
  supports `rejects:<damage>`; a run that accepted damaged input contradicts it.
- **Coverage:** the report names the inputs, kinds and sample counts tried — and says outright that
  no finding means no reproducible weakness on these samples, not that the operation is safe.

## Recon a codebase

`context_recon` takes a granted workspace and finds every way in, then proves where they open:

```json
{ "workspace": "/home/me/src/app", "driveLimit": 10 }
```

- **Map:** entry points (HTTP routes, servers, CLIs, stdin, file uploads, declared bins), capabilities,
  dependencies, languages, and secrets in the clear (credential assignments, private keys, AWS keys,
  tokens — reported with the matching text, so redact before sharing).
- **Taint routes:** function-scoped static analysis links a source (argv, request data, environment,
  stdin) to a dangerous sink in the same function — command injection, eval, path traversal, SQL
  injection, XSS, SSRF, prototype pollution, deserialization. These are candidates, reported with the
  source and sink lines.
- **Exploit-verification:** a route that starts at argv is driven by running the real code with a
  payload inside the sandbox, twice. A reproduced marker file, executed command or read of a file
  outside the workspace counts as `exploited`; a write the sandbox refused is `contained-by-sandbox`
  (the code followed the attacker's path; the fence held). Every drive's file changes are undone.
  Request-sourced routes cannot be driven without a live server and are reported with a payload
  sketch instead.
- **Honesty:** the report states the files, languages and sink patterns scanned and the method's
  limits; no finding means this scan saw nothing on these files — never that the code is secure.

## Repair with proof

`context_repair` fixes what recon proved open — and a fix only counts when it survives the proof:

```json
{ "workspace": "/home/me/src/app", "limit": 10, "test": { "program": "/usr/bin/node", "args": ["--test"] } }
```

- **Recipe guards:** for command injection, eval injection and path traversal, a one-line guard is
  built for the exact sink (refuse shell metacharacters, restrict eval to arithmetic, refuse absolute
  and `..` paths) and applied through `context_edit`, so it is reversible like any edit.
- **The proof, per finding:** the payload must reproduce on the unchanged code first (otherwise the
  route is `not-open` and nothing is changed); after the guard, the exact payload is re-driven twice
  and must not reproduce; a benign input must behave identically before and after (same exit status
  and standard output — standard error is platform diagnostics); the workspace's own tests must not
  regress. Any failed check reverts the fix byte-exactly and names the check that failed, keeping the
  attempted diff for a hand fix.
- **Statuses:** `closed` (the payload is dead), `hardened` (a write the code itself now refuses), plus
  `reverted`, `revert-failed`, `not-open`, `not-fixed`. Routes the sandbox cannot drive and classes with
  no honest one-line guard (SQL injection, XSS, SSRF, prototype pollution, deserialization) come back
  as `needs-redesign` with the reasoning — never silently skipped. Anything filtered out or beyond the
  limit is `skipped` and says so.
- **Honesty:** `closed` is proven for the payload driven, never for every input or every class.

## Make a requirement actionable

`context_plan` compiles any plain-language requirement into grounded, executable steps:

```json
{ "requirement": "find and fix the command injection in the CLI, then make the tests pass", "workspace": "/home/me/src/app" }
```

- **Grounded, not invented:** with a workspace, the plan is compiled from a real scan and overview —
  entry points, static findings, a file list, the detected test command — and each step names the exact
  tool and arguments, down to the files to read and the edits to make. What grounding cannot fill is a
  marked placeholder (`<exact text as read>`), never invented content.
- **Any intent:** hunt, fix, bug, understand, change, test, run, data — recognised from the wording and
  mapped to the tools that serve it: recon and repair for hunt/fix/bug, `context_edit` plus a test run
  for changes, environment/possibilities/goal/gap/skill for data work with no workspace needed.
- **Honesty:** what is missing is stated as a need (a granted workspace for code work, a program, a
  skill). The plan is ledgered, and each step's outcome — not the plan — decides what is established.

## Know the boundary

Five tools survey any code the operator has granted — a third-party checkout is the normal case —
the way an attacker would, and every claim is driven, not asserted: each trigger's own code is
executed, each credential read is demonstrated, each escape move is attempted. The operator's
authority stays out of reach: contents are revealed only at the operator's terminal, and host
persistence writes are proven refused. Everything else is measured or honestly marked not-measured.

```json
{ "workspace": "/home/me/src/vendor-app" }
```

- **`context_reach` — the tripwire map.** The grant's true capability graph: every program, read root,
  write root, workspace and network grant, separated by who can use what (the engine reads read roots;
  runs never see them). Inside the target's code, every auto-execution trigger is classified by the
  event that fires it — a git hook runs on your next commit, an npm script on your next install, a
  direnv file when the shell starts — by whose authority it runs, and by who controls the file: a
  trigger shipped in the tree belongs to whoever you cloned this from, while `.git` surfaces are your
  local configuration, which the fence keeps runs from planting into. Every trigger Cortex ever
  touched is tied to its ledger entry.
- **`context_escape` — the blast radius, proven.** What could code run from this workspace actually
  do to this host? Established by driving the real escape moves, each a ledgered trial: writes aimed
  at the home directory, `LaunchAgents`, rc files, `/tmp` and the workspace parent; symlinks planted
  inside and pointed out; reads of home; `.git` hooks and git-config; network sockets; the inherited
  environment (names only); a detached child outliving its run; and the engine's own guards. Every
  attempt ends `refused`, `isolated` or `reverted` — or `escaped`, a critical finding with the
  marker's path. Run it on third-party code before you build or install it. Probes can be narrowed:
  `{"probes": ["write-git", "env"]}`.
- **`context_gates` — the defense inventory.** The host's defenses inventoried from one process's
  honest vantage: SIP, Gatekeeper, the application firewall, FileVault, Endpoint Security clients,
  listening sockets, SUID binaries and PATH hygiene (ptrace scope and the LSMs on Linux), each
  measured with the host's own query commands run inside the fence. A gate the vantage cannot see is
  `not-measured` with the reason — which is often the control itself working (sudoers is unreadable
  without root; the fence hides the network tables from a process denied network). The target is the
  host itself: call it with no workspace to survey the machine.
- **`context_secrets` — the credential map, with the read proven.** Every credential-shaped thing
  the grant can reach — in the read roots and the target's code — reported as type, path and digest,
  never content. For each workspace, the reachability claim is then demonstrated: a sandboxed run
  reads each credential file found there and hashes the same bytes the scan saw — the enabling step
  of credential exfiltration, proven on this host, still reported as digests. Contents are shown only
  by the operator at their own terminal, naming the digest: `cortex secrets --reveal sha256:…`. Over
  MCP a reveal is refused whatever it asks; every operator reveal is ledgered by digest.
- **`context_persist` — persistence, driven and proven.** The inventory with the attack lens: the
  target's auto-execution primitives, each with what fires it, whose authority, and who controls the
  file — and each one driven: its own code executed once, sandboxed, exactly as its real mechanism
  would run it (npm's script line through the shell, a hook file as git execs it, an envrc as the
  shell sources it). Exit status recorded, output never copied (a trigger's output is untrusted);
  what the driven code changed is undone. Executed is the demonstration: this code, written by
  whoever you cloned from, runs with your authority the moment you install or commit. Then the host
  side: every standard persistence surface — LaunchAgents and LaunchDaemons, periodic and cron
  directories, autostart and systemd paths — driven with a real marker write from inside the fence:
  `cannot-plant` (refused — proven), `isolated`, `absent`, or `planted`, a critical finding.

## CLI equivalents

```text
cortex probe /usr/bin/gzip
cortex experiment spec.json          cortex calibrate witness.json
cortex audit audit.json              cortex recon --workspace ~/src/app
cortex repair --workspace ~/src/app  cortex plan "fix the command injection in ~/src/app"
cortex reach --workspace ~/src/app    cortex escape --workspace ~/src/app
cortex gates                          cortex gates --workspace ~/src/app
cortex persist --workspace ~/src/app  cortex secrets
cortex secrets --reveal sha256:…      # the operator's terminal only
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
| `context_audit` | `{"operation": "gzip.decompress", "inputs": {"data": ["sha256:…", "sha256:…"]}}` |
| `context_recon` | `{"workspace": "/home/me/src/app", "driveLimit": 10}` |
| `context_repair` | `{"workspace": "/home/me/src/app", "limit": 10, "test": {"program": "/usr/bin/node", "args": ["--test"]}}` |
| `context_plan` | `{"requirement": "find and fix the command injection in the CLI", "workspace": "/home/me/src/app"}` |
| `context_reach` | `{"workspace": "/home/me/src/app"}` or `{}` for the grant graph alone |
| `context_escape` | `{"workspace": "/home/me/src/app"}` or `{"workspace": "…", "probes": ["write-git", "env", "symlink-out", "read-home", "network", "child-afterlife"]}` |
| `context_gates` | `{}` to survey the host itself, or `{"workspace": "/home/me/src/app"}` to stage the probe from that code |
| `context_secrets` | `{}` (contents only via `cortex secrets --reveal sha256:…` at the operator's terminal) |
| `context_persist` | `{"workspace": "/home/me/src/app"}` |
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
