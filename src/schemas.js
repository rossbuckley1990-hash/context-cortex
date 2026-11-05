// Runtime validation against the published schemas, so an import is checked by the same
// definitions the documentation describes.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
export const SCHEMA_BASE = "https://github.com/rossbuckley1990-hash/context-cortex/schemas/";

let ajv = null;
function load() {
  if (ajv) return ajv;
  // strictTypes and strictRequired are off because conditional subschemas (if/then, contains)
  // narrow objects whose type and properties the parent schema already defines.
  ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
  addFormats(ajv);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) ajv.addSchema(JSON.parse(readFileSync(join(dir, f), "utf8")));
  return ajv;
}

export const BY_SCHEMA_FIELD = {
  "context-cortex/transfer-bundle/v0": "transfer-bundle.schema.json",
  "context-cortex/skill/v0": "skill.schema.json",
  "context-cortex/affordance-claim/v0": "affordance-claim.schema.json",
};

/** Validate a document by its `schema` field. Returns null, or the errors. */
export function validate(doc) {
  const name = BY_SCHEMA_FIELD[doc?.schema];
  if (!name) return [{ instancePath: "/schema", message: `unknown schema ${doc?.schema}` }];
  const fn = load().getSchema(SCHEMA_BASE + name);
  return fn(doc) ? null : fn.errors;
}

export function validateBundle(bundle) {
  if (bundle?.schema !== "context-cortex/transfer-bundle/v0") return "schema must be context-cortex/transfer-bundle/v0";
  const errors = validate(bundle);
  return errors ? errors.slice(0, 5).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ") : null;
}
