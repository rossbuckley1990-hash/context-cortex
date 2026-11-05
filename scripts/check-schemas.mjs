// Validates every example against the schemas, then checks that the schemas refuse what the
// design says they must refuse. Each negative case mutates a valid example and must fail at the
// expected path, so a case cannot pass for the wrong reason.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../src/schemas.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`FAIL ${msg}`);
};

const examplesDir = join(root, "examples");
const examples = readdirSync(examplesDir).filter((f) => f.endsWith(".json"));
for (const name of examples) {
  const errors = validate(readJson(join(examplesDir, name)));
  if (!errors) console.log(`ok   examples/${name}`);
  else fail(`examples/${name}\n${JSON.stringify(errors, null, 2)}`);
}

const bundle = () => readJson(join(examplesDir, "gzip-verified.bundle.json"));
const idx = (b, pred) => {
  const i = b.claims.findIndex(pred);
  if (i < 0) throw new Error("the example has no claim of the kind this check needs");
  return i;
};
const established = (b) => idx(b, (c) => c.state === "established" && c.evidence.witnesses?.length);
const preservation = (b) => idx(b, (c) => c.state === "established" && c.kind === "preservation");
const negatives = [
  ["a bundle may not carry authority", (b) => { b.carriesAuthority = true; return "/carriesAuthority"; }],
  ["import must revalidate", (b) => { b.importPolicy.requireRevalidation = false; return "/importPolicy/requireRevalidation"; }],
  ["an established claim's witness must be calibrated", (b) => { const i = established(b); b.claims[i].evidence.witnesses[0].calibration.status = "uncalibrated"; return `/claims/${i}/evidence/witnesses/0/calibration/status`; }],
  ["an established claim needs two supporting trials", (b) => { const i = established(b); b.claims[i].evidence.supporting = b.claims[i].evidence.supporting.slice(0, 1); return `/claims/${i}/evidence/supporting`; }],
  ["an established claim names its promotion rule", (b) => { const i = established(b); delete b.claims[i].evidence.promotionRule; return `/claims/${i}/evidence`; }],
  ["an established preservation claim names its witness", (b) => { const i = preservation(b); delete b.claims[i].evidence.witnesses; return `/claims/${i}/evidence`; }],
  ["a contradicted claim needs a refuting trial", (b) => { const i = established(b); b.claims[i].state = "contradicted"; b.claims[i].evidence.refuting = []; return `/claims/${i}/evidence/refuting`; }],
  ["an observed claim needs a supporting trial", (b) => { const i = established(b); b.claims[i].state = "observed"; b.claims[i].evidence.supporting = []; return `/claims/${i}/evidence/supporting`; }],
  ["a self-test needs a fixture that must be refused", (b) => { b.skills[0].selfTest.fixtures.forEach((f) => (f.expect = "pass")); return "/skills/0/selfTest/fixtures"; }],
  ["a skill needs a success condition", (b) => { b.skills[0].successConditions = []; return "/skills/0/successConditions"; }],
  ["an established skill needs demonstrations", (b) => { b.skills[0].provenance.demonstrations = []; return "/skills/0/provenance/demonstrations"; }],
  ["digests are sha256", (b) => { b.skills[0].revision = "md5:abc"; return "/skills/0/revision"; }],
  ["step bindings name an input or an earlier step's output", (b) => { b.skills[0].steps[0].bind.data = "/tmp/anything.txt"; return "/skills/0/steps/0/bind/data"; }],
  ["claim states are closed", (b) => { b.claims[0].state = "probably-fine"; return "/claims/0/state"; }],
  ["effect classes are closed", (b) => { b.skills[0].prerequisites.authority.effectClasses = ["harmless"]; return "/skills/0/prerequisites/authority/effectClasses/0"; }],
  ["artefacts carry their bytes", (b) => { delete b.artefacts[0].data; return "/artefacts/0"; }],
];

for (const [rule, mutate] of negatives) {
  const doc = bundle();
  const path = mutate(doc);
  const errors = validate(doc);
  if (!errors) fail(`accepted: ${rule}`);
  else if (!errors.some((e) => e.instancePath === path || e.instancePath.startsWith(`${path}/`))) {
    fail(`refused for another reason: ${rule}\n  expected ${path}, got ${[...new Set(errors.map((e) => e.instancePath))].join(", ")}`);
  } else console.log(`ok   refuses: ${rule}`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log(`\nall ${examples.length + negatives.length} schema checks passed`);
