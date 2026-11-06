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
  workspaceTimeoutMs: 300_000,
};

export function defaultGrant() {
  return { version: 1, programs: [], readRoots: [], writeRoots: [], workspaces: [], network: false, allowUnsandboxed: false, limits: { ...DEFAULT_LIMITS } };
}

export function loadGrant(home) {
  const g = readJson(join(home, "grant.json"), null) ?? defaultGrant();
  const out = { ...defaultGrant(), ...g, limits: { ...DEFAULT_LIMITS, ...(g.limits ?? {}) } };
  if (out.network) throw new Refusal("bad-grant", "network is granted per code workspace (workspaces[].network), not globally; experiments never have network");
  for (const k of ["programs", "readRoots", "writeRoots"]) out[k] = (out[k] ?? []).map((p) => absolute(p, `grant.${k} entry`));
  out.workspaces = (out.workspaces ?? []).map((w) => (typeof w === "string" ? { path: absolute(w, "grant.workspaces entry"), network: false } : { path: absolute(w.path, "grant.workspaces entry"), network: w.network === true }));
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
  const { given, real } = resolvableProgram(path);
  const ok = forms(given).some((f) => grant.programs.some((g) => within(f, g)));
  if (!ok) throw new Refusal("not-granted", `program is not in the operator's grant: ${given}. The operator can add it with: cortex grant add-program ${given}`);
  return { given, real };
}

/**
 * Any executable file on this machine. Workspace runs use this: a granted workspace is itself the
 * operator's authorisation to work on that code, so the agent may run whatever the work needs
 * (node, npm, git, make, the project's own tools). The sandbox, not the program list, is the
 * containment: writes stay inside the workspace and the run directory, home directories stay
 * unreadable, and there is no network unless the workspace was granted it.
 */
export function resolvableProgram(path) {
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

/** A granted code workspace containing `path` (or named by it). Returns { root, network }. */
export function grantedWorkspace(grant, path) {
  const given = absolute(path, "workspace");
  const real = realpathOrNull(given);
  if (!real) throw new Refusal("unknown-file", `workspace does not exist: ${given}`);
  for (const w of grant.workspaces) {
    const root = realpathOrNull(w.path);
    if (root && within(real, root)) return { root, network: w.network, path: w.path };
  }
  throw new Refusal("not-granted", `not inside a code workspace the operator granted: ${given}. The operator can add it with: cortex grant add-workspace ${given}`);
}

/**
 * Resolve a file inside a workspace, for reading or writing. Refuses anything that resolves
 * outside the workspace (through .., absolute paths or symlinks) and anything inside .git.
 */
export function workspaceFile(ws, rel) {
  if (typeof rel !== "string" || !rel || rel.includes("\0")) throw new Refusal("bad-path", "path must be a non-empty string");
  const target = join(ws.root, rel.startsWith("/") ? relativeTo(ws.root, rel) : rel);
  const parts = target.slice(ws.root.length).split("/").filter(Boolean);
  if (parts.includes(".git")) throw new Refusal("not-granted", "files inside .git are never read or changed");
  if (!within(target, ws.root)) throw new Refusal("not-granted", `path escapes the workspace: ${rel}`);
  const real = realpathOrNull(target);
  if (real && !within(real, ws.root)) throw new Refusal("not-granted", `path resolves outside the workspace: ${rel}`);
  if (!real) {
    const parent = realpathOrNull(join(target, ".."));
    if (parent && !within(parent, ws.root)) throw new Refusal("not-granted", `path resolves outside the workspace: ${rel}`);
  }
  return { abs: real ?? target, rel: (real ?? target).slice(ws.root.length + 1), exists: !!real };
}

function relativeTo(root, abs) {
  const n = absolute(abs);
  const real = realpathOrNull(n) ?? (() => {
    const parent = realpathOrNull(join(n, ".."));
    return parent ? join(parent, n.slice(n.lastIndexOf("/") + 1)) : n;
  })();
  if (!within(real, root)) throw new Refusal("not-granted", `path is outside the workspace: ${abs}`);
  return real.slice(root.length + 1);
}
