import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cortex } from "../src/cortex.js";
import { defaultGrant, saveGrant } from "../src/grant.js";

export const GZIP = ["/usr/bin/gzip", "/bin/gzip"].find(existsSync);
export const CAT = ["/bin/cat", "/usr/bin/cat"].find(existsSync);
export const ACTOR = { kind: "operator", id: "test" };

/** A fresh home with samples, an output directory and a grant for the given programs. */
export function environment(programs = [GZIP]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cortex-test-")));
  const env = { root, home: join(root, "home"), samples: join(root, "samples"), out: join(root, "out") };
  for (const d of [env.home, env.samples, env.out]) mkdirSync(d, { recursive: true });
  writeFileSync(join(env.samples, "a.txt"), "hello context cortex\n".repeat(20));
  writeFileSync(join(env.samples, "b.txt"), "the quick brown fox jumps over the lazy dog\n".repeat(30));
  writeFileSync(join(env.samples, "c.txt"), "a file the skill has never seen\n");
  grant(env, programs);
  return env;
}

export function grant(env, programs, extra = {}) {
  saveGrant(env.home, {
    ...defaultGrant(),
    programs,
    readRoots: [env.samples],
    writeRoots: [env.out],
    allowUnsandboxed: process.env.CORTEX_TEST_UNSANDBOXED === "1",
    ...extra,
  });
}

export const open = (env) => Cortex.open(env.home);

export const compressOp = { id: "gzip.compress", program: GZIP, args: ["-n", "-c", "{in:data}"], inputs: { data: "text/plain" }, outputs: { stdout: "application/gzip" } };
export const decompressOp = { id: "gzip.decompress", program: GZIP, args: ["-d", "-c", "{in:data}"], inputs: { data: "application/gzip" }, outputs: { stdout: "text/plain" } };

export const skillDef = (env) => ({
  id: "gzip-verified",
  title: "Compress text with gzip, verified lossless",
  objective: "Compress a text file so that decompressing it returns exactly the original bytes.",
  inputs: { text: "text/plain" },
  steps: [{ id: "compress", operation: "gzip.compress", bind: { data: "input.text" } }],
  output: "steps.compress.stdout",
  preserve: ["bytes"],
  successConditions: [{ witness: "gzip-roundtrip", property: "bytes", bind: { original: "input.text", compressed: "steps.compress.stdout" } }],
  selfTest: {
    fixtures: [
      { id: "text", inputs: { text: { path: join(env.samples, "a.txt") } }, expect: "pass" },
      { id: "binary-is-refused", inputs: { text: { base64: "iVBORw0KGgoAAAANSUhEUg==" } }, expect: "refuse" },
    ],
  },
});

/** The whole learning loop for gzip: two experiments, a witness, a hypothesis, a skill. */
export async function learnGzip(cx, env) {
  const a = { path: join(env.samples, "a.txt") }, b = { path: join(env.samples, "b.txt") };
  const compress = await cx.experiment({ operation: compressOp, trials: [{ inputs: { data: a } }, { inputs: { data: b } }, { inputs: { data: { text: "inline\n" } } }], controls: false }, ACTOR);
  const gz = compress.trials.map((t) => t.outputs.stdout.digest);
  const decompress = await cx.experiment({ operation: decompressOp, trials: gz.map((d) => ({ inputs: { data: d } })) }, ACTOR);
  const witness = await cx.calibrate({ witness: { id: "gzip-roundtrip", builtin: "bytes-equal", params: ["original", "compressed"], via: { compressed: "gzip.decompress" } }, references: [{ bind: { original: a, compressed: gz[0] } }, { bind: { original: b, compressed: gz[1] } }] }, ACTOR);
  const lossless = await cx.experiment({
    operation: compressOp, trials: [{ inputs: { data: a } }, { inputs: { data: b } }], controls: false,
    hypotheses: [{ id: "lossless", kind: "preservation", text: "decompressing the output returns the input exactly", property: "bytes", value: "exact", check: { witness: "gzip-roundtrip", bind: { original: "input.data", compressed: "output.stdout" } } }],
  }, ACTOR);
  const { crystallize } = await import("../src/skills.js");
  const skill = await crystallize(cx, skillDef(env), ACTOR);
  return { compress, decompress, witness, lossless, skill, gz };
}

export const stateOf = (report, id) => report.claims.find((c) => c.id === id)?.state;
