// Content-addressed artefact store. Every sample, input and output is kept and named by digest.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { detect } from "./formats.js";
import { ensureDir, now, readJson, Refusal, sha256, writeAtomic } from "./util.js";

export const ORIGINS = ["sample", "inline", "trial-output", "mutation", "imported"];

export class ArtefactStore {
  constructor(dir, { maxBytes = 64 * 1024 * 1024 } = {}) {
    this.dir = ensureDir(dir);
    this.maxBytes = maxBytes;
  }

  #paths(digest) {
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Refusal("bad-artefact", `not an artefact digest: ${digest}`);
    const hex = digest.slice(7);
    const d = join(this.dir, hex.slice(0, 2));
    return { data: join(d, hex), meta: join(d, `${hex}.json`) };
  }

  /** Store bytes; returns the artefact's metadata. Re-storing the same bytes keeps the first metadata. */
  put(bytes, { origin, provenance = {} } = {}) {
    if (!ORIGINS.includes(origin)) throw new Error(`unknown artefact origin ${origin}`);
    const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (b.length > this.maxBytes) throw new Refusal("too-large", `artefact of ${b.length} bytes exceeds the ${this.maxBytes}-byte limit`);
    const digest = sha256(b);
    const p = this.#paths(digest);
    if (existsSync(p.meta)) return this.meta(digest);
    const detected = detect(b);
    const meta = { digest, size: b.length, format: detected.format, formatBasis: detected.basis, origin, provenance, createdAt: now() };
    writeAtomic(p.data, b);
    writeAtomic(p.meta, JSON.stringify(meta, null, 2));
    return meta;
  }

  has(digest) {
    return existsSync(this.#paths(digest).meta);
  }

  meta(digest) {
    const m = readJson(this.#paths(digest).meta, null);
    if (!m) throw new Refusal("unknown-artefact", `no artefact ${digest}`);
    return m;
  }

  /** Read bytes and check them against their name, so a damaged store is never trusted. */
  get(digest) {
    const p = this.#paths(digest);
    if (!existsSync(p.data)) throw new Refusal("unknown-artefact", `no artefact ${digest}`);
    const b = readFileSync(p.data);
    if (sha256(b) !== digest) throw new Refusal("artefact-damaged", `stored artefact ${digest} no longer matches its digest`);
    return b;
  }

  path(digest) {
    if (!this.has(digest)) throw new Refusal("unknown-artefact", `no artefact ${digest}`);
    return this.#paths(digest).data;
  }

  list() {
    const out = [];
    for (const d of readdirSync(this.dir)) {
      if (!/^[0-9a-f]{2}$/.test(d)) continue;
      for (const f of readdirSync(join(this.dir, d))) if (f.endsWith(".json")) out.push(readJson(join(this.dir, d, f), null));
    }
    return out.filter(Boolean);
  }
}
