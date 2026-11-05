// The evidence ledger: append-only JSON lines, each entry hash-linked to the one before.
// Claim states are decided only from entries here.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { canonical, ensureDir, now, sha256 } from "./util.js";
import { dirname } from "node:path";

export const GENESIS = "sha256:" + "0".repeat(64);

const hashOf = (e) => sha256(canonical({ seq: e.seq, at: e.at, kind: e.kind, body: e.body, prev: e.prev }));

export class Ledger {
  constructor(file) {
    this.file = file;
    ensureDir(dirname(file));
    this.reload();
  }

  reload() {
    const entries = this.read();
    const last = entries.at(-1);
    this.seq = last?.seq ?? 0;
    this.head = last?.hash ?? GENESIS;
  }

  read() {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }

  /** Append one entry and return a reference to it: { trial, digest }. */
  append(kind, body) {
    this.reload();
    const entry = { seq: this.seq + 1, at: now(), kind, body, prev: this.head };
    entry.hash = hashOf(entry);
    appendFileSync(this.file, JSON.stringify(entry) + "\n");
    this.seq = entry.seq;
    this.head = entry.hash;
    return { trial: `${kind}-${entry.seq}`, digest: entry.hash, seq: entry.seq };
  }

  get(seq) {
    return this.read().find((e) => e.seq === seq) ?? null;
  }

  /** Check every link and hash. Returns { intact, entries, brokenAt? }. */
  verify() {
    let prev = GENESIS;
    let entries;
    try {
      entries = this.read();
    } catch (e) {
      return { intact: false, entries: 0, brokenAt: null, reason: `unreadable: ${e.message}` };
    }
    for (const e of entries) {
      if (e.prev !== prev) return { intact: false, entries: entries.length, brokenAt: e.seq, reason: "link does not match the previous entry" };
      if (hashOf(e) !== e.hash) return { intact: false, entries: entries.length, brokenAt: e.seq, reason: "entry content does not match its hash" };
      prev = e.hash;
    }
    return { intact: true, entries: entries.length, head: prev };
  }
}
