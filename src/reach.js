// Reach: every auto-execution trigger a granted workspace holds, and the exact authority each one
// fires with. A trigger is code that runs with the operator's own authority — or the repository's CI
// authority — because the operator acts, not because Cortex is in the loop: git hooks, npm lifecycle
// scripts, husky, direnv, editor tasks, CI workflows. Most of these are project files the operator
// granted precisely so Cortex can work on them, so the fence rightly leaves them writable; the tool
// that makes that safe is visibility — this map, plus the ledger, which answers for every trigger
// whether Cortex ever changed it and when. .git's own surfaces are the exception the fence takes
// away entirely (refused to runs, refused to edits, restored by the guard), and this scan states
// which side each trigger is on. It lists .git/hooks by name — the one place the engine looks
// inside .git — because a planted hook is exactly the persistence that must never be invisible.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { grantedWorkspace } from "./grant.js";
import { changes } from "./workspace.js";
import { isObject, now, Refusal } from "./util.js";

const MAX_READ = 512 * 1024;
const MAX_TRIGGERS = 120;

const HOOK_EVENTS = {
  "pre-commit": "git commit, before it completes",
  "commit-msg": "git commit, on the message",
  "post-commit": "git commit, after it completes",
  "pre-rebase": "git rebase",
  "post-merge": "git merge or pull finishes",
  "pre-push": "git push",
  "post-checkout": "git checkout or switch",
  "prepare-commit-msg": "git commit, preparing the message",
  "pre-receive": "a push arrives at this repository as a remote",
  update: "a push arrives at this repository as a remote",
  "post-receive": "a push arrives at this repository as a remote",
  "post-update": "a push arrives at this repository as a remote",
  "reference-transaction": "any ref is updated (fires often)",
  fsmonitor: "git needs to refresh the index (fires often)",
  "fsmonitor-watchman": "git needs to refresh the index (fires often)",
  "p4-changelist": "git-p4 submits",
  "p4-prepare-changelist": "git-p4 submits",
  "sendemail-validate": "git send-email runs",
};

const LIFECYCLE = ["preinstall", "install", "postinstall", "preprepare", "prepare", "prepare-workspace", "prepublishOnly", "prepack", "postpack"];

/** Read a file bounded, or null. */
function readBounded(abs) {
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_READ) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/** The last ledgered change that touched a path, from the workspace's own change history. */
function lastTouched(cx, ws, path) {
  try {
    const { changes: list } = changes(cx, { workspace: ws.root, diffs: false });
    for (const c of [...list].reverse()) {
      const hit = c.files.find((f) => f.path === path);
      if (hit) return { change: c.change, at: c.at, undone: c.undone, kind: c.kind };
    }
  } catch {
    /* no history */
  }
  return null;
}

/** Every auto-execution trigger in one workspace. Shared with context_persist, whose inventory
 *  starts from these same firing surfaces. */
export function scanTriggers(cx, ws) {
  const root = ws.root;
  const out = [];
  // The attacker's question about every trigger: who controls the code that fires? A trigger file
  // shipped in the tree is whoever you cloned this from; a .git surface is your local machine's own
  // configuration, which the fence keeps runs from planting into.
  const SHIPPED = "the code you cloned: anyone who can commit to that repository, a dependency update or a codegen step rewrites this — your consent is given by the install, commit or cd that fires it";
  const LOCAL_GIT = "your local git configuration, not shipped with the clone — and the fence refuses runs writing it (context_escape proves that)";
  const push = (t) => {
    if (out.length >= MAX_TRIGGERS) return;
    out.push({ ...t, controlledBy: t.file.startsWith(".git/") ? LOCAL_GIT : SHIPPED });
  };
  const touched = (path) => lastTouched(cx, ws, path);
  const PROJECT_FENCE = "writable by design — a project file, so every Cortex change to it is ledgered and reversible (context_workspace changes)";

  // 1. git's own hooks and config. Names and the security-relevant config lines only; never content.
  const config = readBounded(join(root, ".git", "config"));
  const hooksPathRaw = config ? /^[\t ]*hooksPath[\t ]*=[\t ]*(\S+)/m.exec(config)?.[1] : null;
  const hooksDir = hooksPathRaw ? join(root, hooksPathRaw) : join(root, ".git", "hooks");
  const GIT_FENCE = "refused to runs by the fence (verified by context_escape), refused to edits outright, and restored by the run guard — no Cortex change can reach it";
  try {
    for (const name of readdirSync(hooksDir).filter((n) => !n.endsWith(".sample")).sort()) {
      const abs = join(hooksDir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const rel = hooksPathRaw ? join(hooksPathRaw, name) : `.git/hooks/${name}`;
      push({
        kind: "git-hook", file: rel,
        fires: HOOK_EVENTS[name] ?? `the git event named "${name}"`,
        authority: "operator-shell", impact: "runs with your authority, unsandboxed, the moment you run git",
        fence: GIT_FENCE, cortexTouched: null,
      });
    }
  } catch {
    /* no .git or no hooks directory */
  }
  if (hooksPathRaw) {
    push({
      kind: "git-config-hooksPath", file: ".git/config", detail: `core.hooksPath = ${hooksPathRaw}`,
      fires: "git reads hook scripts from the configured path instead of .git/hooks",
      authority: "operator-shell", impact: "any hook there runs with your authority on the matching git event",
      fence: GIT_FENCE, cortexTouched: null,
    });
  }
  if (config) {
    for (const m of config.matchAll(/^\[(\w+)(?: "([^"]+)")?\][\t ]*$/gm)) {
      const section = m[2] ? `${m[1]}.${m[2]}` : m[1];
      const from = m.index + m[0].length;
      const next = config.slice(from).search(/^\[/m);
      const body = next === -1 ? config.slice(from) : config.slice(from, from + next);
      if (section === "alias") {
        for (const a of body.matchAll(/^[\t ]*([\w-]+)[\t ]*=[\t ]*!(.+)$/gm)) {
          push({
            kind: "git-alias-shell", file: ".git/config", detail: `alias.${a[1]} = ${a[2].trim()}`,
            fires: `you run \`git ${a[1]}\``, authority: "operator-shell",
            impact: "the alias body is a shell command and runs with your authority",
            fence: GIT_FENCE, cortexTouched: null,
          });
        }
      }
    }
  }

  // 2. package.json lifecycle scripts, husky, and .npmrc script-shell.
  const pkg = readBounded(join(root, "package.json"));
  if (pkg) {
    let parsed;
    try {
      parsed = JSON.parse(pkg);
    } catch {
      parsed = null;
    }
    const scripts = parsed?.scripts ?? {};
    for (const name of LIFECYCLE) {
      if (scripts[name]) {
        push({
          kind: "npm-lifecycle", file: "package.json", detail: `scripts.${name} = ${scripts[name]}`,
          fires: `npm ${name === "prepack" || name === "postpack" ? "pack/publish" : name} — no confirmation is asked`,
          authority: "operator-shell", impact: "runs with your authority, unsandboxed, as part of the install",
          fence: PROJECT_FENCE, cortexTouched: touched("package.json"),
        });
      }
    }
    const husky = (parsed?.devDependencies && "husky" in parsed.devDependencies) || /husky/.test(String(scripts.prepare ?? ""));
    if (husky && existsSync(join(root, ".husky"))) {
      const GIT_FENCE_HUSKY = "project files the fence leaves writable by design (only .git/hooks itself is refused); ledgered and reversible";
      for (const name of readdirSync(join(root, ".husky")).sort()) {
        const abs = join(root, `.husky/${name}`);
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        push({
          kind: "husky-hook", file: `.husky/${name}`,
          fires: HOOK_EVENTS[name] ?? `the git event named "${name}" (installed through core.hooksPath at install time)`,
          authority: "operator-shell", impact: "runs with your authority, unsandboxed, on the matching git event",
          fence: GIT_FENCE_HUSKY, cortexTouched: touched(`.husky/${name}`),
        });
      }
    }
  }
  const npmrc = readBounded(join(root, ".npmrc"));
  if (npmrc) {
    const shell = /^[\t ]*script-shell[\t ]*=[\t ]*(.+)$/m.exec(npmrc)?.[1]?.trim();
    if (shell) {
      push({
        kind: "npm-script-shell", file: ".npmrc", detail: `script-shell = ${shell}`,
        fires: "every npm run script in this project",
        authority: "operator-shell", impact: "all package scripts run through this shell command",
        fence: PROJECT_FENCE, cortexTouched: touched(".npmrc"),
      });
    }
  }

  // 3. direnv: fires on cd, before any command you run in the directory.
  if (existsSync(join(root, ".envrc"))) {
    push({
      kind: "direnv", file: ".envrc", fires: "you cd into this directory (if direnv is hooked into your shell)",
      authority: "operator-shell", impact: "the .envrc is sourced with your authority before your first command",
      fence: PROJECT_FENCE, cortexTouched: touched(".envrc"),
    });
  }

  // 4. editor tasks: run by the IDE with your authority when you invoke them.
  const tasks = readBounded(join(root, ".vscode", "tasks.json"));
  if (tasks) {
    let count = 0;
    try {
      const parsed = JSON.parse(tasks.replace(/^\s*\/\/.*$/gm, ""));
      count = (parsed.tasks ?? []).length;
    } catch {
      count = -1;
    }
    push({
      kind: "editor-task", file: ".vscode/tasks.json", detail: count >= 0 ? `${count} task(s) defined` : "present (not parsed)",
      fires: "you run a task from the editor's task list",
      authority: "operator-editor", impact: "the task command runs with your authority from the IDE",
      fence: PROJECT_FENCE, cortexTouched: touched(".vscode/tasks.json"),
    });
  }

  // 5. CI: fires on push, with the CI runner's authority and the repository's secrets.
  const CI_FILES = [
    { re: /\.github\/workflows\/[\w.-]+\.ya?ml$/, detail: (rel) => `GitHub Actions workflow ${rel}` },
  ];
  for (const rel of [".gitlab-ci.yml", ".circleci/config.yml"]) {
    if (existsSync(join(root, rel))) {
      push({
        kind: "ci", file: rel, fires: "you push (or a pipeline event arrives)",
        authority: "ci", impact: "runs on the CI runner with the repository's CI authority and its stored secrets",
        fence: PROJECT_FENCE, cortexTouched: touched(rel),
      });
    }
  }
  try {
    const wf = join(root, ".github", "workflows");
    if (existsSync(wf)) {
      for (const name of readdirSync(wf).filter((n) => CI_FILES[0].re.test(`.github/workflows/${n}`)).sort().slice(0, 30)) {
        const rel = `.github/workflows/${name}`;
        push({
          kind: "ci", file: rel, detail: CI_FILES[0].detail(rel), fires: "you push (or a pipeline event arrives)",
          authority: "ci", impact: "runs on the CI runner with the repository's CI authority and its stored secrets",
          fence: PROJECT_FENCE, cortexTouched: touched(rel),
        });
      }
    }
  } catch {
    /* unreadable */
  }

  return out;
}

/** Who reaches what, from the grant alone: the graph an operator needs to reason about this Cortex. */
function graphOf(grant) {
  return {
    operator: {
      canChange: ["the grant itself — `cortex grant` commands are the only path, and no tool can call them"],
      fires: "every trigger below, with your own unsandboxed authority, when you act",
    },
    engine: {
      programs: grant.programs.length ? grant.programs : [],
      reads: [...grant.readRoots, ...grant.workspaces.map((w) => w.path)],
      writes: [...grant.workspaces.map((w) => `${w.path} (reversible edits, never .git)`), ...grant.writeRoots.map((r) => `${r} (delivery, never overwriting)`)],
      never: ["the grant — no tool changes it", ".git — refused to edits, refused to runs, restored by the run guard"],
    },
    runs: {
      programs: "any executable — the workspace grant is the authorisation for work on that code; the fence is the containment",
      read: [...grant.readRoots.map((r) => `${r} — engine only; read roots are never mounted into runs`), ...grant.workspaces.map((w) => `${w.path} (writable)`), "the rest of the host outside home directories, as any unprivileged process can read it"],
      write: grant.workspaces.map((w) => `${w.path} only — plus the per-run work directory`),
      home: "unreadable (verified by context_escape)",
      network: grant.workspaces.some((w) => w.network) ? "granted to some workspaces (per-workspace)" : "none, anywhere",
      env: "the minimal fixed set (verified by context_escape)",
    },
  };
}

export async function reach(cx, req, actor) {
  if (!isObject(req)) throw new Refusal("bad-request", "reach takes an object");
  const one = req.workspace ? grantedWorkspace(cx.grant, req.workspace) : null;
  const spaces = one ? [one] : cx.grant.workspaces.map((w) => grantedWorkspace(cx.grant, w.path));
  const byWorkspace = spaces.map((ws) => {
    const triggers = scanTriggers(cx, ws);
    const tally = {};
    for (const t of triggers) tally[t.kind] = (tally[t.kind] ?? 0) + 1;
    return {
      workspace: ws.root,
      network: ws.network ?? false,
      triggers,
      counts: { total: triggers.length, ...tally },
      cortexTouched: triggers.filter((t) => t.cortexTouched).map((t) => ({ file: t.file, change: t.cortexTouched.change, at: t.cortexTouched.at, undone: t.cortexTouched.undone })),
    };
  });
  const total = byWorkspace.reduce((n, w) => n + w.counts.total, 0);
  cx.ledger.append("reach", {
    workspaces: spaces.map((w) => w.root), at: now(), triggers: total,
    cortexTouched: byWorkspace.flatMap((w) => w.cortexTouched).length,
    by: actor,
  });
  return {
    at: now(),
    graph: graphOf(cx.grant),
    workspaces: byWorkspace,
    summary: {
      triggers: total,
      firingWithYourAuthority: byWorkspace.flatMap((w) => w.triggers).filter((t) => t.authority === "operator-shell").length,
      firingInCI: byWorkspace.flatMap((w) => w.triggers).filter((t) => t.authority === "ci").length,
      cortexEverTouched: byWorkspace.flatMap((w) => w.cortexTouched).length,
    },
    coverage: {
      triggerKinds: ["git-hook", "git-config-hooksPath", "git-alias-shell", "npm-lifecycle", "husky-hook", "npm-script-shell", "direnv", "editor-task", "ci"],
      method: "each trigger file is read from the workspace; git's hooks are listed by name only — content is never shown; every Cortex change to a writable trigger is found in the ledger",
      note: "a trigger absent from this report means this scan saw none on these files today — a project can add one at any time, and .git/config and hooksPath are read for the lines that matter, not in full. Files outside the granted workspaces were never opened.",
    },
  };
}
