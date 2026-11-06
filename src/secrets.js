// Secrets: the credential map without the keys. Every secret the operator's grant can reach —
// credential-shaped files and credential-shaped content in the read roots and granted workspaces,
// and credential-shaped variable names in the engine's own environment — reported as kind, path
// and digest, never as content. Each item says who can reach it: a secret inside a granted
// workspace is readable by any code Cortex runs there (builds, tests, its own CLI), while a
// secret inside a read root is engine-only: read roots are never mounted into runs, so no sandboxed
// program ever sees them. Values come out only behind explicit per-item opt-in from the
// operator's own terminal — an actor of kind "operator", which the MCP path never is — and every
// reveal is ledgered with what was shown, to whom, never what it said. The keychain and anything
// outside every grant are reported as unreachable by design, with the fence's refusal as proof.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { platform } from "node:os";
import { grantedWorkspace } from "./grant.js";
import { SECRETS } from "./hunt.js";
import { isObject, now, Refusal, within } from "./util.js";

const MAX_FILES = 4000;
const MAX_CONTENT_SCAN = 2 * 1024 * 1024;
const MAX_REVEAL_BYTES = 16 * 1024;
const SECRET_ENV_NAME = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|PASS|API_?KEY|APIKEY|PRIVATE_?KEY|CREDENTIAL(?:S)?|AUTH|ACCESS_?KEY|CLIENT_?SECRET|SESSION_?KEY)(?:_|$)|^AWS_|^GITHUB_|^GCP_|^GOOGLE_|^AZURE_|^STRIPE|^SLACK|^OPENAI|^ANTHROPIC|^SSH_/i;

const NAME_RULES = [
  { re: /(^|\/)\.env(\.[\w.-]+)?$/, kind: "env-file", what: "environment file — variable assignments, often live credentials" },
  { re: /(^|\/)\.netrc$/, kind: "netrc", what: "machine login credentials" },
  { re: /(^|\/)\.npmrc$/, kind: "npmrc", what: "npm registry token" },
  { re: /(^|\/)\.pypirc$/, kind: "pypirc", what: "package index credentials" },
  { re: /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/, kind: "ssh-private-key", what: "an SSH private key" },
  { re: /\.(pem|key)$/i, kind: "key-material", what: "key material by name (a .pem can also be a public certificate — content decides)" },
  { re: /\.(p12|pfx)$/i, kind: "certificate-bundle", what: "a certificate and its private key, bundled" },
  { re: /\.(kdbx|keychain|akp)$/i, kind: "credential-vault", what: "an encrypted credential vault" },
  { re: /(^|\/)(credentials|config)$/, dir: /(\.aws|\.kube|\.docker|\.gcloud)$/, kind: "cloud-config", what: "a cloud or container CLI credential file" },
  { re: /(^|\/)\.git-credentials$/, kind: "git-credentials", what: "git HTTP credentials in the clear" },
  { re: /(^|\/)\.htpasswd$/, kind: "htpasswd", what: "password hashes" },
  { re: /\.ovpn$|\.rdp$|\.jks$|\.keystore$/i, kind: "connection-credential", what: "a VPN, remote-desktop or Java keystore credential" },
  { re: /(^|\/)(secrets?|.*secret.*)\.(json|ya?ml|txt|env)$/i, kind: "named-secrets", what: "a file that declares itself secret by name" },
  { re: /\.(tfvars)$/i, kind: "terraform-vars", what: "Terraform variables, often provider keys" },
  { re: /(^|\/)\.ssh\//, dir: null, kind: "ssh-directory", what: "an SSH directory" },
];

/** One granted root's credential-shaped files, by name and by content. .git is never opened —
 *  the same rule that makes it uneditable makes it unscanned, and the coverage note says so. */
function scanRoot(root, scope, cap) {
  const found = new Map();
  const byFile = (rel, abs, st, extra) => {
    const key = abs;
    const item = found.get(key) ?? { path: rel, absolute: abs, size: st.size, digest: digestFile(abs, st.size), kinds: [], ...(extra ?? {}) };
    if (!found.has(key)) found.set(key, item);
    return item;
  };
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (cap.files >= MAX_FILES) {
        cap.truncated = true;
        return;
      }
      if (e.name === ".git" || e.name === "node_modules") continue;
      const abs = join(dir, e.name);
      let real;
      try {
        real = realpathSync(abs);
      } catch {
        continue;
      }
      if (!within(real, root)) continue; // never follow a link out of the granted root
      let st;
      try {
        st = statSync(real);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 5) walk(real, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      cap.files++;
      const rel = relative(root, real);
      const parent = rel.split("/").slice(0, -1).join("/");
      let nameHit = null;
      for (const rule of NAME_RULES) {
        const nameOk = rule.re.test(rel) || rule.re.test(e.name);
        const dirOk = !rule.dir || (parent && rule.dir.test(parent));
        if (nameOk && dirOk) { nameHit = rule; break; }
      }
      if (nameHit) {
        const item = byFile(rel, real, st, { scope, byName: true });
        if (!item.kinds.includes(nameHit.kind)) item.kinds.push(nameHit.kind);
        if (!item.what) item.what = nameHit.what;
        else if (!item.what.includes(nameHit.what)) item.what += `; ${nameHit.what}`;
      }
      if (st.size > MAX_CONTENT_SCAN) continue;
      let text;
      try {
        text = readFileSync(real, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\0")) continue; // binary — pattern hits there would be noise
      const lines = text.split("\n");
      for (const [i, line] of lines.entries()) {
        if (line.length > 400) continue;
        for (const s of SECRETS) {
          const m = s.re.exec(line);
          if (m) {
            const item = byFile(rel, real, st, { scope });
            if (!item.contentHits) item.contentHits = [];
            if (!item.kinds.includes(s.id)) item.kinds.push(s.id);
            item.contentHits.push({ kind: s.id, line: i + 1 });
            break;
          }
        }
      }
    }
  };
  walk(root, 0);
  return [...found.values()];
}

function digestFile(abs, size) {
  // small files digest whole; the point is a stable operator-addressable id, not a forensic hash
  try {
    const buf = size <= MAX_CONTENT_SCAN ? readFileSync(abs) : readFileSync(abs).subarray(0, MAX_CONTENT_SCAN);
    return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
  } catch {
    return "sha256:unreadable";
  }
}

export async function secrets(cx, req, actor) {
  if (!isObject(req)) throw new Refusal("bad-request", "secrets takes an object");
  const isOperator = actor && actor.kind === "operator";
  const reveal = Array.isArray(req.reveal) ? req.reveal.map(String) : [];

  // The scan: read roots and granted workspaces, each item classified by who can reach it.
  const cap = { files: 0, truncated: false };
  const items = [];
  const scopes = [
    ...cx.grant.readRoots.map((r) => ({ root: safeReal(r), scope: "read-root" })),
    ...cx.grant.workspaces.map((w) => {
      try {
        return { root: grantedWorkspace(cx.grant, w.path).root, scope: "workspace", network: w.network === true };
      } catch {
        return { root: safeReal(w.path), scope: "workspace" };
      }
    }),
  ];
  for (const s of scopes) {
    if (!s.root) continue;
    const reachableBy = s.scope === "workspace" ? "engine+runs" : "engine-only";
    for (const item of scanRoot(s.root, s.scope, cap)) {
      items.push({
        ...item,
        root: s.root,
        scope: s.scope,
        reachableBy,
        ...(reachableBy === "engine+runs" ? { exposure: "any code run in this workspace (tests, builds, its own CLI) reads this file; the fence binds the workspace into every run" } : { exposure: "read roots are never mounted into runs: no sandboxed program sees this file — only the engine's own machinery (digests, samples), which reports digests, not contents" }),
      });
    }
  }

  // Credential-shaped names in the engine's own environment: names only, never values.
  const envNames = Object.keys(process.env).filter((n) => SECRET_ENV_NAME.test(n)).sort();

  // The keychain: outside every grant, with the fence's refusal as the proof it stays that way.
  const outside = [
    ...(platform() === "darwin" ? [{
      what: "the macOS keychain",
      state: "unreachable-by-design",
      evidence: "the keychain store lives under the home directory, which the fence refuses to every run (verified by context_escape), and the engine reads only granted roots; the operator could grant /usr/bin/security as a program, and reach would then say so",
    }] : []),
    ...(platform() === "linux" ? [{
      what: "the host's secret services (gnome-keyring and friends)",
      state: "unreachable-by-design",
      evidence: "they live under the home directory, which the fence keeps empty inside its mounts, and the engine reads only granted roots",
    }] : []),
  ];

  // Reveals: only an operator at their own terminal, per item, ledgered.
  const reveals = [];
  if (reveal.length) {
    if (!isOperator) {
      throw new Refusal("not-authorized", "secret contents are shown only by the operator's own hand: run `cortex secrets --reveal sha256:…` at your terminal, naming the digest(s). This tool over MCP never reveals, whatever it is asked");
    }
    for (const digest of reveal) {
      const item = items.find((i) => i.digest === digest);
      if (!item) throw new Refusal("bad-request", `no scanned item has digest ${digest}; reveal names one of the reported digests`);
      let content;
      try {
        content = readFileSync(item.absolute, "utf8").slice(0, MAX_REVEAL_BYTES);
      } catch (e) {
        throw new Refusal("bad-request", `the file could not be read: ${e.message}`);
      }
      reveals.push({ digest: item.digest, path: item.path, kinds: item.kinds, content });
    }
  }

  const summary = {
    items: items.length,
    byScope: { workspace: items.filter((i) => i.scope === "workspace").length, readRoot: items.filter((i) => i.scope === "read-root").length },
    runReachable: items.filter((i) => i.reachableBy === "engine+runs").length,
    envNames: envNames.length,
    revealed: reveals.length,
    ...(cap.truncated ? { truncated: true, note: "the scan stopped at its file cap; grant smaller roots or clear clutter for the rest" } : {}),
  };
  cx.ledger.append("secrets", { at: now(), ...summary, revealed: reveals.map((r) => r.digest), by: typeof actor === "object" ? `${actor.kind}:${actor.id}` : String(actor) });
  return {
    at: now(),
    items: items.map((i) => ({ ...i, absolute: undefined, ...(i.contentHits ? { contentHits: i.contentHits } : {}) })),
    env: {
      names: envNames,
      note: "these variable names exist in the engine's own environment — names only, values were never read; runs receive only the minimal fixed set (verified by context_escape), so no sandboxed program inherits any of them",
    },
    outsideGrant: outside,
    ...(reveals.length ? { reveals } : {}),
    summary,
    coverage: {
      scanned: cap.files,
      method: "every file in the granted read roots and workspaces (skipping .git and node_modules) was matched by name rules and content patterns; the digest is over the file's bytes, so the operator can address a reveal to exactly the item they saw",
      note: "a credential this scan did not find either is not in the granted roots and workspaces, or does not look like a credential to these patterns — it says nothing about the rest of the host, which no grant covers. .git/config can carry a token in a remote URL and is not opened, by the same rule that keeps it uneditable.",
    },
  };
}

const safeReal = (p) => {
  try {
    const r = realpathSync(p);
    return existsSync(r) ? r : null;
  } catch {
    return null;
  }
};
