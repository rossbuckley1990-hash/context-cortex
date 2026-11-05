// Persistent engine state (operations, experiments, claims, witnesses, skills), written atomically
// and guarded by a lock file so an MCP server and a CLI on the same home never interleave writes.
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeAtomic } from "./util.js";

export const STATE_VERSION = 1;

const empty = () => ({ version: STATE_VERSION, operations: {}, experiments: {}, claims: {}, witnesses: {}, skills: {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

export class State {
  constructor(home) {
    this.file = join(home, "state.json");
    this.lockFile = join(home, "state.lock");
    this.data = this.load();
  }

  load() {
    const d = readJson(this.file, null);
    if (!d) return empty();
    if (d.version !== STATE_VERSION) throw new Error(`state ${this.file} has version ${d.version}; this engine reads ${STATE_VERSION}`);
    return { ...empty(), ...d };
  }

  save() {
    writeAtomic(this.file, JSON.stringify(this.data, null, 2));
  }

  /** Run fn with the state freshly loaded under an exclusive lock, then save it. */
  async mutate(fn) {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const fd = openSync(this.lockFile, "wx");
        writeSync(fd, String(process.pid));
        closeSync(fd);
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        let holder = NaN;
        try {
          holder = Number(readFileSync(this.lockFile, "utf8"));
        } catch {
          /* removed meanwhile */
        }
        if (Number.isFinite(holder) && holder !== process.pid && !alive(holder)) rmSync(this.lockFile, { force: true });
        else if (holder === process.pid) throw new Error("state lock is already held by this process (nested mutate)");
        if (Date.now() > deadline) throw new Error(`state is locked by process ${holder}`);
        await sleep(50);
      }
    }
    try {
      this.data = this.load();
      const result = await fn(this.data);
      this.save();
      return result;
    } finally {
      rmSync(this.lockFile, { force: true });
    }
  }

  refresh() {
    this.data = this.load();
    return this.data;
  }
}
