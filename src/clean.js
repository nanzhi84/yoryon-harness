import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SANDBOX_DIRS = ["work", "artifacts", ".agents/teamwork"];
const PROTECTED_NAMES = new Set([".gitkeep", ".gitignore"]);
const PROTECTED_AGENTS_NAMES = new Set([
  "hooks",
  "hooks.json",
  "rules",
  "skills",
  "workflows",
  "plugins",
  "mcp",
  "agents",
  "teamwork",
  ".gitkeep",
  ".gitignore",
]);
const DEFAULT_MAX_AGE = "12h";

/**
 * Parse human-readable duration strings (e.g. "30m", "12h", "7d", "3600s") into milliseconds.
 * Bare numbers are interpreted as hours.
 */
export function parseDurationMs(input = DEFAULT_MAX_AGE) {
  if (typeof input === "number" && Number.isFinite(input) && input >= 0) {
    return input * 3600 * 1000;
  }
  const str = String(input || DEFAULT_MAX_AGE).trim().toLowerCase();
  const match = str.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
  if (!match) {
    throw new Error(
      `Invalid duration '${input}'. Expected format like '30m', '12h', '24h', or '7d'.`
    );
  }
  const val = parseFloat(match[1]);
  const unit = match[2] || "h";
  switch (unit) {
    case "ms":
      return val;
    case "s":
      return val * 1000;
    case "m":
      return val * 60 * 1000;
    case "h":
      return val * 3600 * 1000;
    case "d":
      return val * 24 * 3600 * 1000;
    default:
      return val * 3600 * 1000;
  }
}

/**
 * Compute recursive latest mtimeMs and total byte size of a file or directory.
 */
function statTree(targetPath) {
  let stat;
  try {
    stat = fs.lstatSync(targetPath);
  } catch {
    return { mtimeMs: 0, bytes: 0 };
  }

  let latestMtime = stat.mtimeMs;
  let totalBytes = stat.isDirectory() ? 0 : stat.size;

  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    let children = [];
    try {
      children = fs.readdirSync(targetPath);
    } catch {
      children = [];
    }
    for (const child of children) {
      const childStats = statTree(path.join(targetPath, child));
      if (childStats.mtimeMs > latestMtime) {
        latestMtime = childStats.mtimeMs;
      }
      totalBytes += childStats.bytes;
    }
  }

  return { mtimeMs: latestMtime, bytes: totalBytes };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Clean intermediate files/directories under `work/` and `artifacts/`.
 *
 * Options:
 * - all (boolean): remove all non-protected entries regardless of age
 * - maxAge (string | number): TTL threshold (default: env HARNESS_CLEAN_MAX_AGE or "12h")
 * - keep (number | undefined): keep at most N newest entries per sandbox directory
 * - dryRun (boolean): report what would be removed without deleting
 * - quiet (boolean): only log when entries are actually removed
 */
export function cleanSandboxes(targetRoot = process.cwd(), options = {}) {
  const all = Boolean(options.all);
  const dryRun = Boolean(options.dryRun);
  const quiet = Boolean(options.quiet);
  const silent = Boolean(options.silent);
  const maxAgeSpec =
    options.maxAge !== undefined
      ? options.maxAge
      : process.env.HARNESS_CLEAN_MAX_AGE || DEFAULT_MAX_AGE;
  const maxAgeMs = all ? 0 : parseDurationMs(maxAgeSpec);

  const rawKeep =
    options.keep !== undefined ? options.keep : process.env.HARNESS_CLEAN_KEEP;
  const keepCount =
    rawKeep !== undefined && rawKeep !== "" ? Math.max(0, parseInt(rawKeep, 10)) : undefined;

  const now = Date.now();
  const removed = [];
  const kept = [];
  let bytesFreed = 0;

  for (const dirName of SANDBOX_DIRS) {
    const sandboxDir = path.join(targetRoot, dirName);
    if (!fs.existsSync(sandboxDir) || !fs.statSync(sandboxDir).isDirectory()) {
      continue;
    }

    const entries = fs
      .readdirSync(sandboxDir)
      .filter((name) => !PROTECTED_NAMES.has(name) && !name.startsWith("."))
      .map((name) => {
        const fullPath = path.join(sandboxDir, name);
        const relPath = path.join(dirName, name);
        const { mtimeMs, bytes } = statTree(fullPath);
        return { name, fullPath, relPath, mtimeMs, bytes };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

    entries.forEach((entry, idx) => {
      const ageMs = Math.max(0, now - entry.mtimeMs);
      const expiredByAge = all || ageMs >= maxAgeMs;
      const expiredByCount = keepCount !== undefined && idx >= keepCount;

      if (expiredByAge || expiredByCount) {
        if (!dryRun) {
          fs.rmSync(entry.fullPath, { recursive: true, force: true });
        }
        removed.push(entry.relPath);
        bytesFreed += entry.bytes;
      } else {
        kept.push(entry.relPath);
      }
    });

    if (
      dirName === ".agents/teamwork" &&
      !dryRun &&
      fs.existsSync(sandboxDir) &&
      fs.readdirSync(sandboxDir).length === 0
    ) {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  }

  // Also GC stray/nested non-config entries inside `.agents/` (e.g. `.agents/.agents`, `.agents/scratch`)
  const agentsDir = path.join(targetRoot, ".agents");
  if (fs.existsSync(agentsDir) && fs.statSync(agentsDir).isDirectory()) {
    const strayEntries = fs
      .readdirSync(agentsDir)
      .filter((name) => !PROTECTED_AGENTS_NAMES.has(name) && name !== ".DS_Store")
      .map((name) => {
        const fullPath = path.join(agentsDir, name);
        const relPath = path.join(".agents", name);
        const { mtimeMs, bytes } = statTree(fullPath);
        return { name, fullPath, relPath, mtimeMs, bytes };
      });

    for (const entry of strayEntries) {
      const ageMs = Math.max(0, now - entry.mtimeMs);
      const isNestedAgents = entry.name === ".agents";
      if (all || isNestedAgents || ageMs >= maxAgeMs) {
        if (!dryRun) {
          fs.rmSync(entry.fullPath, { recursive: true, force: true });
        }
        removed.push(entry.relPath);
        bytesFreed += entry.bytes;
      } else {
        kept.push(entry.relPath);
      }
    }
  }

  try {
    cleanWorktrees(targetRoot, { dryRun, quiet: true, silent: true });
  } catch {
    // Non-fatal: never block sandbox cleanup if git worktree pruning encounters an error
  }

  if (!silent && (removed.length > 0 || !quiet)) {
    const prefix = dryRun ? "[harness clean --dry-run]" : "[harness clean]";
    if (removed.length === 0) {
      console.log(
        `${prefix} nothing expired in work/ or artifacts/ (kept ${kept.length} recent item(s), policy: ${
          all ? "all" : `max-age=${maxAgeSpec}`
        }${keepCount !== undefined ? `, keep=${keepCount}` : ""}).`
      );
    } else {
      console.log(
        `${prefix} ${dryRun ? "would remove" : "removed"} ${removed.length} item(s) (${formatBytes(
          bytesFreed
        )}), kept ${kept.length} recent item(s):`
      );
      for (const rel of removed) {
        console.log(`  - ${rel}`);
      }
    }
  }

  return { removed, kept, bytesFreed };
}

/**
 * Resolve the common .git directory for a repository root or linked worktree root.
 */
export function resolveGitCommonDir(targetRoot = process.cwd()) {
  const dotGit = path.join(targetRoot, ".git");
  if (!fs.existsSync(dotGit)) {
    return null;
  }
  if (fs.statSync(dotGit).isDirectory()) {
    return dotGit;
  }
  try {
    const proc = spawnSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: targetRoot,
      encoding: "utf8",
      timeout: 5000,
    });
    if (proc.status === 0 && proc.stdout && proc.stdout.trim()) {
      const resolved = path.resolve(targetRoot, proc.stdout.trim());
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        return resolved;
      }
    }
  } catch {
    // Fallback below
  }
  return null;
}

function pruneEmptySubdirs(rootDir) {
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    return;
  }
  for (const name of fs.readdirSync(rootDir)) {
    const fullPath = path.join(rootDir, name);
    try {
      const stat = fs.lstatSync(fullPath);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        pruneEmptySubdirs(fullPath);
        const remaining = fs.readdirSync(fullPath).filter((n) => n !== ".DS_Store");
        if (remaining.length === 0) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        }
      }
    } catch {
      // Ignore concurrent deletion
    }
  }
}

/**
 * Reconcile and prune stale Git worktree metadata (.git/worktrees/*),
 * orphaned ghost worktree directories, .git/info/refs, and empty ref namespaces.
 */
export function cleanWorktrees(targetRoot = process.cwd(), options = {}) {
  const dryRun = Boolean(options.dryRun);
  const quiet = Boolean(options.quiet);
  const silent = Boolean(options.silent);

  const commonGitDir = resolveGitCommonDir(targetRoot);
  if (!commonGitDir) {
    return { prunedWorktrees: [], removedGhostDirs: [], refreshedServerInfo: false };
  }

  const mainRepoRoot = path.dirname(commonGitDir);
  const worktreesMetaDir = path.join(commonGitDir, "worktrees");
  const prunedWorktrees = [];
  const removedGhostDirs = [];

  if (fs.existsSync(worktreesMetaDir) && fs.statSync(worktreesMetaDir).isDirectory()) {
    for (const wtName of fs.readdirSync(worktreesMetaDir)) {
      const wtEntryDir = path.join(worktreesMetaDir, wtName);
      try {
        if (!fs.statSync(wtEntryDir).isDirectory()) continue;
        if (fs.existsSync(path.join(wtEntryDir, "locked"))) continue;

        const gitdirFile = path.join(wtEntryDir, "gitdir");
        if (!fs.existsSync(gitdirFile)) continue;

        const rawTarget = fs.readFileSync(gitdirFile, "utf8").trim();
        if (!rawTarget) continue;

        const wtGitFile = path.resolve(wtEntryDir, rawTarget);
        const wtPhysicalDir = path.dirname(wtGitFile);

        if (!fs.existsSync(wtGitFile)) {
          prunedWorktrees.push(wtName);
          if (
            fs.existsSync(wtPhysicalDir) &&
            path.resolve(wtPhysicalDir) !== path.resolve(mainRepoRoot)
          ) {
            if (!dryRun) {
              fs.rmSync(wtPhysicalDir, { recursive: true, force: true });
            }
            removedGhostDirs.push(wtPhysicalDir);
          }

          const parentDir = path.dirname(wtPhysicalDir);
          if (
            parentDir &&
            path.resolve(parentDir) !== path.resolve(mainRepoRoot) &&
            path.resolve(parentDir) !== path.parse(parentDir).root &&
            fs.existsSync(parentDir)
          ) {
            try {
              const siblings = fs.readdirSync(parentDir).filter((n) => n !== ".DS_Store");
              if (siblings.length === 0 && !dryRun) {
                fs.rmSync(parentDir, { recursive: true, force: true });
              }
            } catch {
              // Ignore parent cleanup errors
            }
          }
        }
      } catch {
        // Ignore transient worktree metadata errors
      }
    }
  }

  if (!dryRun) {
    spawnSync("git", ["worktree", "prune", "--expire", "now"], {
      cwd: mainRepoRoot,
      encoding: "utf8",
      timeout: 5000,
    });
  }

  let refreshedServerInfo = false;
  const infoRefsPath = path.join(commonGitDir, "info", "refs");
  if (fs.existsSync(infoRefsPath)) {
    if (!dryRun) {
      const res = spawnSync("git", ["update-server-info"], {
        cwd: mainRepoRoot,
        encoding: "utf8",
        timeout: 5000,
      });
      refreshedServerInfo = res.status === 0;
    } else {
      refreshedServerInfo = true;
    }
  }

  if (!dryRun) {
    pruneEmptySubdirs(path.join(commonGitDir, "refs", "heads"));
    pruneEmptySubdirs(path.join(commonGitDir, "logs", "refs", "heads"));
  }

  if (!silent && (prunedWorktrees.length > 0 || removedGhostDirs.length > 0 || !quiet)) {
    const prefix = dryRun ? "[harness clean --worktrees --dry-run]" : "[harness clean --worktrees]";
    console.log(
      `${prefix} pruned ${prunedWorktrees.length} stale worktree metadata item(s), removed ${removedGhostDirs.length} ghost directory(ies)${
        refreshedServerInfo ? ", refreshed .git/info/refs" : ""
      }.`
    );
  }

  return { prunedWorktrees, removedGhostDirs, refreshedServerInfo };
}
