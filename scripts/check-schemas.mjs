// Validates every example against the draft schemas, then checks that the schemas
// refuse what the design says they must refuse. Each negative case mutates a valid
// example and must fail at the expected path, so a case cannot pass for the wrong reason.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// strictTypes and strictRequired are off because conditional subschemas (if/then,
// contains) narrow objects whose type and properties the parent schema already defines.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
addFormats(ajv);
for (const name of readdirSync(join(root, "schemas")).filter((f) => f.endsWith(".json"))) {
  ajv.addSchema(readJson(join(root, "schemas", name)));
}

const base = "https://github.com/rossbuckley1990-hash/context-cortex/schemas/";
const bySchemaField = {
  "context-cortex/transfer-bundle/v0": `${base}transfer-bundle.schema.json`,
  "context-cortex/skill/v0": `${base}skill.schema.json`,
  "context-cortex/affordance-claim/v0": `${base}affordance-claim.schema.json`,
};

const validate = (doc) => {
  const id = bySchemaField[doc.schema];
  if (!id) return { ok: false, errors: [{ instancePath: "/schema", message: `unknown schema ${doc.schema}` }] };
  const fn = ajv.getSchema(id);
  const ok = fn(doc);
  return { ok, errors: fn.errors ?? [] };
};

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`FAIL ${msg}`);
};

// 1. Every example is valid.
const examplesDir = join(root, "examples");
const examples = readdirSync(examplesDir).filter((f) => f.endsWith(".json"));
for (const name of examples) {
  const { ok, errors } = validate(readJson(join(examplesDir, name)));
  if (ok) console.log(`ok   examples/${name}`);
  else fail(`examples/${name}\n${JSON.stringify(errors, null, 2)}`);
}

// 2. Rules the design depends on, each as a mutation that must be refused at a path.
const bundle = () => readJson(join(examplesDir, "lossless-webp-to-avif.bundle.json"));
const negatives = [
  ["a bundle may not carry authority", (b) => { b.carriesAuthority = true; }, "/carriesAuthority"],
  ["import must revalidate", (b) => { b.importPolicy.requireRevalidation = false; }, "/importPolicy/requireRevalidation"],
  ["an established claim needs a calibrated witness", (b) => { b.claims[0].evidence.witnesses[0].calibration.status = "uncalibrated"; }, "/claims/0/evidence/witnesses/0/calibration/status"],
  ["an established claim needs two supporting trials", (b) => { b.claims[0].evidence.supporting.pop(); }, "/claims/0/evidence/supporting"],
  ["an established claim names its promotion rule", (b) => { delete b.claims[1].evidence.promotionRule; }, "/claims/1/evidence"],
  ["a contradicted claim needs a refuting trial", (b) => { b.claims[2].evidence.refuting = []; }, "/claims/2/evidence/refuting"],
  ["an observed claim needs a supporting trial", (b) => { b.claims[2].state = "observed"; b.claims[2].evidence.refuting = []; }, "/claims/2/evidence/supporting"],
  ["a self-test needs a negative fixture", (b) => { b.skills[0].selfTest.fixtures[1].expect = "pass"; }, "/skills/0/selfTest/fixtures"],
  ["a skill needs a success condition", (b) => { b.skills[0].successConditions = []; }, "/skills/0/successConditions"],
  ["a skill needs a demonstrating receipt", (b) => { b.skills[0].provenance.receipts = []; }, "/skills/0/provenance/receipts"],
  ["digests are sha256", (b) => { b.skills[0].revision = "md5:abc"; }, "/skills/0/revision"],
  ["step bindings name an input or an earlier step's port", (b) => { b.skills[0].steps[1].bind.input = "/tmp/anything.png"; }, "/skills/0/steps/1/bind/input"],
  ["claim states are closed", (b) => { b.claims[0].state = "probably-fine"; }, "/claims/0/state"],
  ["effect classes are closed", (b) => { b.skills[0].prerequisites.authority.effectClasses = ["harmless"]; }, "/skills/0/prerequisites/authority/effectClasses/0"],
];

for (const [rule, mutate, path] of negatives) {
  const doc = bundle();
  mutate(doc);
  const { ok, errors } = validate(doc);
  if (ok) {
    fail(`accepted: ${rule}`);
  } else if (!errors.some((e) => e.instancePath === path || e.instancePath.startsWith(`${path}/`))) {
    fail(`refused for another reason: ${rule}\n  expected ${path}, got ${[...new Set(errors.map((e) => e.instancePath))].join(", ")}`);
  } else {
    console.log(`ok   refuses: ${rule}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log(`\nall ${examples.length + negatives.length} checks passed`);
