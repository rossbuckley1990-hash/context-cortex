// The operator's authority grant. Only the operator changes it (through the CLI or the file);
// no MCP tool can. Discovery, experiments and imports never widen it.
import { join } from "node:path";
import { absolute, readJson, realpathOrNull, Refusal, within, writeAtomic } from "./util.js";
import { statSync } from "node:fs";

export const DEFAULT_LIMITS = {
  timeoutMs: 20_000,
  maxTrialsPerExperiment: 48,
  maxOutputBytes: 64 * 1024 * 1024,
  maxBundleBytes: 32 * 1024 * 1024,
};

export function defaultGrant() {
  return { version: 1, programs: [], readRoots: [], writeRoots: [], network: false, allowUnsandboxed: false, limits: { ...DEFAULT_LIMITS } };
}

export function loadGrant(home) {
  const g = readJson(join(home, "grant.json"), null) ?? defaultGrant();
  const out = { ...defaultGrant(), ...g, limits: { ...DEFAULT_LIMITS, ...(g.limits ?? {}) } };
  if (out.network) throw new Refusal("bad-grant", "network access is not supported in this version; set network to false");
  for (const k of ["programs", "readRoots", "writeRoots"]) out[k] = (out[k] ?? []).map((p) => absolute(p, `grant.${k} entry`));
  return out;
}

export function saveGrant(home, grant) {
  writeAtomic(join(home, "grant.json"), JSON.stringify(grant, null, 2) + "\n");
}

/** Every form of a path that a grant entry may name: as given, and resolved through symlinks. */
function forms(path) {
  const given = absolute(path);
  const real = realpathOrNull(given);
  return real && real !== given ? [given, real] : [given];
}

/** A granted program: the path (or a directory containing it) is listed. Returns the resolved file. */
export function grantedProgram(grant, path) {
  const given = absolute(path, "program");
  const real = realpathOrNull(given);
  if (!real) throw new Refusal("unknown-program", `program does not exist: ${given}`);
  let isFile = false;
  try {
    const st = statSync(real);
    isFile = st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    /* fall through */
  }
  if (!isFile) throw new Refusal("unknown-program", `not an executable file: ${given}`);
  const ok = forms(given).some((f) => grant.programs.some((g) => within(f, g)));
  if (!ok) throw new Refusal("not-granted", `program is not in the operator's grant: ${given}. The operator can add it with: cortex grant add-program ${given}`);
  return { given, real };
}

/** A host file the engine may read: inside a granted read root, after resolving symlinks. */
export function grantedRead(grant, path) {
  const given = absolute(path);
  const real = realpathOrNull(given);
  if (!real) throw new Refusal("unknown-file", `file does not exist: ${given}`);
  if (!grant.readRoots.some((r) => within(real, realpathOrNull(r) ?? r))) {
    throw new Refusal("not-granted", `file is outside the operator's read roots: ${given}`);
  }
  return real;
}

/** A host path the engine may create: its parent is inside a granted write root, and it does not exist yet. */
export function grantedWrite(grant, path) {
  const given = absolute(path);
  if (realpathOrNull(given)) throw new Refusal("exists", `refusing to overwrite an existing file: ${given}`);
  const parent = realpathOrNull(join(given, ".."));
  if (!parent) throw new Refusal("unknown-file", `parent directory does not exist: ${given}`);
  const name = given.slice(given.lastIndexOf("/") + 1);
  const target = join(parent, name);
  if (!grant.writeRoots.some((r) => within(target, realpathOrNull(r) ?? r))) {
    throw new Refusal("not-granted", `path is outside the operator's write roots: ${given}`);
  }
  return target;
}
