// Small shared helpers: digests, canonical JSON, atomic files, refusals.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, normalize, resolve, sep } from "node:path";

/** sha256 of bytes or a string, as "sha256:<hex>". */
export function sha256(data) {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

/** JSON with sorted object keys, so equal values always hash equally. */
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

export const digestOf = (value) => sha256(canonical(value));

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

/** Write via a temporary file and rename, so a reader never sees a partial file. */
export function writeAtomic(path, data) {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

export const now = () => new Date().toISOString();

/** A refusal: the engine declined to act. Nothing was run or changed. */
export class Refusal extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "Refusal";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** An absolute, normalised path; refuses relative paths and NUL bytes. */
export function absolute(path, what = "path") {
  if (typeof path !== "string" || !path || path.includes("\0")) throw new Refusal("bad-path", `${what} must be a non-empty path`);
  if (!isAbsolute(path)) throw new Refusal("bad-path", `${what} must be absolute: ${path}`);
  return normalize(path);
}

/** Is `path` equal to `root` or inside it? Both must already be absolute and normalised. */
export function within(path, root) {
  const r = root.endsWith(sep) ? root : root + sep;
  return path === root || path.startsWith(r);
}

/** realpath that returns null for a missing file instead of throwing. */
export function realpathOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export const resolvePath = (p) => resolve(p);

export const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function requireString(v, what) {
  if (typeof v !== "string" || !v.trim()) throw new Refusal("bad-request", `${what} must be a non-empty string`);
  return v;
}

export function requireId(v, what) {
  requireString(v, what);
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(v)) throw new Refusal("bad-request", `${what} must match [a-z0-9][a-z0-9._-]*: ${v}`);
  return v;
}
