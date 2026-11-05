// Regenerates examples/gzip-verified.bundle.json from a real run of the learning loop
// on this host: node scripts/make-example.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportBundle } from "../src/transfer.js";
import { environment, learnGzip, open } from "../test/helpers.js";

const env = environment();
const cx = await open(env);
await learnGzip(cx, env);
const bundle = exportBundle(cx, ["gzip-verified"], { kind: "operator", id: "example" });
bundle.notes = `Exported from a real run of the gzip learning loop (test/helpers.js learnGzip) on ${process.platform}-${process.arch}. Program digests are those of this host's gzip; importing it elsewhere re-runs every experiment there.`;
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "gzip-verified.bundle.json");
writeFileSync(out, JSON.stringify(bundle, null, 2) + "\n");
console.log(`wrote ${out}: ${bundle.skills.length} skill, ${bundle.experiments.length} experiments, ${bundle.claims.length} claims, ${bundle.artefacts.length} artefacts`);
