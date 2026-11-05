import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SANDBOX_DIRS = ["work", "artifacts", ".agents/teamwork"];
const PROTECTED_NAMES = new Set([".gitkeep", ".gitignore"]);
const PROTECTED_AGENTS_NAMES = new Set([
  "hooks",
  "hooks.json",
  "harness.json",
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
 * Declarative multi-agent worktree location and project registry specs.
 * Supports `{home}`, `~`, `{repo}` (repository directory name), and `{repoRoot}` (full repository path).
 * Additional or custom agent specs can be declared in `~/.config/harness/config.json` or `<repo>/.agents/harness.json`
 * under `"worktreeAgents": [{ "agent": "...", "worktreeContainers": [...], "projectRegistryDirs": [...] }]`.
 */
export const DEFAULT_AGENT_WORKTREE_SPECS = [
  {
    agent: "antigravity",
    worktreeContainers: ["~/.gemini/antigravity/worktrees/{repo}"],
    projectRegistryDirs: ["~/.gemini/config/projects"],
  },
  {
    agent: "cursor",
    worktreeContainers: ["~/.cursor/worktrees/{repo}"],
    projectRegistryDirs: [],
  },
  {
    agent: "claude-code",
    worktreeContainers: ["{repoRoot}/.claude/worktrees", "~/.claude/worktrees/{repo}"],
    projectRegistryDirs: [],
  },
  {
    agent: "codex",
    worktreeContainers: ["~/.codex/worktrees/{repo}"],
    projectRegistryDirs: [],
  },
];

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

function safeRealpath(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function uriToFsPath(uri) {
  if (typeof uri !== "string" || !uri.trim()) {
    return null;
  }
  const trimmed = uri.trim();
  if (trimmed.startsWith("file://")) {
    try {
      return path.resolve(fileURLToPath(trimmed));
    } catch {
      return null;
    }
  }
  return path.resolve(trimmed);
}

function hasValidWorktreeGitLink(dirPath) {
  const dotGitPath = path.join(dirPath, ".git");
  if (!fs.existsSync(dotGitPath)) {
    return false;
  }
  try {
    const stat = fs.lstatSync(dotGitPath);
    if (stat.isDirectory()) {
      return true;
    }
    if (stat.isFile()) {
      const content = fs.readFileSync(dotGitPath, "utf8").trim();
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (!match) {
        return false;
      }
      const targetMetaDir = path.resolve(dirPath, match[1].trim());
      return fs.existsSync(targetMetaDir) && fs.existsSync(path.join(targetMetaDir, "gitdir"));
    }
  } catch {
    return false;
  }
  return false;
}

function resolveMainRepoBranch(commonGitDir) {
  const headFile = path.join(commonGitDir, "HEAD");
  try {
    if (fs.existsSync(headFile)) {
      const raw = fs.readFileSync(headFile, "utf8").trim();
      const match = raw.match(/^ref:\s*refs\/heads\/(.+)$/);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
  } catch {
    // Ignore read errors
  }
  if (fs.existsSync(path.join(commonGitDir, "refs", "heads", "main"))) {
    return "main";
  }
  return null;
}

function gitBranchExists(commonGitDir, branchName) {
  if (!branchName || typeof branchName !== "string") {
    return false;
  }
  const looseRef = path.join(commonGitDir, "refs", "heads", branchName);
  if (fs.existsSync(looseRef) && fs.statSync(looseRef).isFile()) {
    return true;
  }
  const packedRefs = path.join(commonGitDir, "packed-refs");
  try {
    if (fs.existsSync(packedRefs)) {
      const content = fs.readFileSync(packedRefs, "utf8");
      const escaped = branchName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`^[0-9a-f]{40,64}\\s+refs/heads/${escaped}\\s*$`, "m");
      return re.test(content);
    }
  } catch {
    // Ignore packed-refs read errors
  }
  return false;
}

function isStrictDescendantPath(childPath, parentPath) {
  const rel = path.relative(parentPath, childPath);
  return Boolean(rel && rel !== "." && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function isInsideWorktreeContainers(targetPath, worktreeContainerDirs, mainRepoRoot) {
  if (!targetPath || !Array.isArray(worktreeContainerDirs) || worktreeContainerDirs.length === 0) {
    return false;
  }
  const resolvedTarget = path.resolve(targetPath);
  const realTarget = safeRealpath(targetPath);
  const resolvedRepo = path.resolve(mainRepoRoot);
  const realRepo = safeRealpath(mainRepoRoot);
  const resolvedHome = path.resolve(os.homedir());
  const realHome = safeRealpath(os.homedir());

  if (
    resolvedTarget === path.parse(resolvedTarget).root ||
    resolvedTarget === resolvedRepo ||
    realTarget === realRepo ||
    resolvedTarget === resolvedHome ||
    realTarget === realHome ||
    isStrictDescendantPath(resolvedRepo, resolvedTarget) ||
    isStrictDescendantPath(realRepo, realTarget)
  ) {
    return false;
  }

  for (const containerDir of worktreeContainerDirs) {
    if (!containerDir) continue;
    const resolvedContainer = path.resolve(containerDir);
    const realContainer = safeRealpath(containerDir);
    if (
      resolvedContainer === path.parse(resolvedContainer).root ||
      resolvedContainer === resolvedRepo ||
      realContainer === realRepo ||
      resolvedContainer === resolvedHome ||
      realContainer === realHome ||
      isStrictDescendantPath(resolvedRepo, resolvedContainer) ||
      isStrictDescendantPath(realRepo, realContainer)
    ) {
      continue;
    }
    if (
      isStrictDescendantPath(resolvedTarget, resolvedContainer) ||
      isStrictDescendantPath(realTarget, realContainer)
    ) {
      return true;
    }
  }
  return false;
}

function removeEmptyParentContainer(wtPhysicalDir, mainRepoRoot, dryRun) {
  const parentDir = path.dirname(wtPhysicalDir);
  const resolvedParent = parentDir ? path.resolve(parentDir) : "";
  const resolvedRepo = path.resolve(mainRepoRoot);
  const resolvedHome = path.resolve(os.homedir());
  if (
    parentDir &&
    resolvedParent !== resolvedRepo &&
    resolvedParent !== resolvedHome &&
    resolvedParent !== path.parse(resolvedParent).root &&
    !isStrictDescendantPath(resolvedRepo, resolvedParent) &&
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

export function expandWorktreeTemplate(template, { repoRoot, homeDir = os.homedir() }) {
  if (typeof template !== "string" || !template.trim()) {
    return null;
  }
  const repoName = path.basename(repoRoot);
  let expanded = template.trim();
  if (expanded === "~") {
    expanded = homeDir;
  } else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = path.join(homeDir, expanded.slice(2));
  }
  expanded = expanded
    .replace(/\{home\}/g, homeDir)
    .replace(/\{repoRoot\}/g, repoRoot)
    .replace(/\{repo\}/g, repoName);
  return path.resolve(repoRoot, expanded);
}

function loadJsonSpecsFromFile(configPath) {
  try {
    if (!configPath || !fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const specs = [];
    if (Array.isArray(parsed?.worktreeAgents)) {
      specs.push(...parsed.worktreeAgents);
    }
    if (Array.isArray(parsed?.worktreeContainers) || Array.isArray(parsed?.projectRegistryDirs)) {
      specs.push({
        agent: "custom-config",
        worktreeContainers: Array.isArray(parsed.worktreeContainers) ? parsed.worktreeContainers : [],
        projectRegistryDirs: Array.isArray(parsed.projectRegistryDirs)
          ? parsed.projectRegistryDirs
          : [],
      });
    }
    return specs;
  } catch {
    return [];
  }
}

export function resolveAgentWorktreePaths(mainRepoRoot, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const baseSpecs = Array.isArray(options.agentSpecs)
    ? options.agentSpecs
    : DEFAULT_AGENT_WORKTREE_SPECS;

  const globalConfigPath =
    options.configPath ||
    process.env.HARNESS_CONFIG_PATH ||
    path.join(homeDir, ".config", "harness", "config.json");
  const repoConfigPath = path.join(mainRepoRoot, ".agents", "harness.json");

  const combinedSpecs = [
    ...baseSpecs,
    ...loadJsonSpecsFromFile(globalConfigPath),
    ...loadJsonSpecsFromFile(repoConfigPath),
  ];

  const containerDirs = new Set();
  const registryDirs = new Set();

  for (const spec of combinedSpecs) {
    const containers = Array.isArray(spec?.worktreeContainers) ? spec.worktreeContainers : [];
    for (const tpl of containers) {
      const resolved = expandWorktreeTemplate(tpl, { repoRoot: mainRepoRoot, homeDir });
      if (resolved) containerDirs.add(resolved);
    }
    const registries = Array.isArray(spec?.projectRegistryDirs)
      ? spec.projectRegistryDirs
      : spec?.projectRegistryDir
      ? [spec.projectRegistryDir]
      : [];
    for (const tpl of registries) {
      const resolved = expandWorktreeTemplate(tpl, { repoRoot: mainRepoRoot, homeDir });
      if (resolved) registryDirs.add(resolved);
    }
  }

  if (options.worktreesRootDir) {
    const resolved = expandWorktreeTemplate(
      path.join(String(options.worktreesRootDir), "{repo}"),
      { repoRoot: mainRepoRoot, homeDir }
    );
    if (resolved) containerDirs.add(resolved);
  }
  if (Array.isArray(options.worktreeContainers)) {
    for (const tpl of options.worktreeContainers) {
      const resolved = expandWorktreeTemplate(tpl, { repoRoot: mainRepoRoot, homeDir });
      if (resolved) containerDirs.add(resolved);
    }
  }
  if (options.projectsConfigDir) {
    const resolved = expandWorktreeTemplate(String(options.projectsConfigDir), {
      repoRoot: mainRepoRoot,
      homeDir,
    });
    if (resolved) registryDirs.add(resolved);
  }

  return {
    worktreeContainerDirs: [...containerDirs],
    projectRegistryDirs: [...registryDirs],
  };
}

function hasActiveGitLock(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return false;
  const candidates = [
    path.join(dirPath, "index.lock"),
    path.join(dirPath, "HEAD.lock"),
    path.join(dirPath, "config.lock"),
    path.join(dirPath, ".git", "index.lock"),
    path.join(dirPath, ".git", "HEAD.lock"),
  ];
  return candidates.some((p) => fs.existsSync(p));
}

function loadRepoHarnessJson(repoRoot) {
  try {
    const p = path.join(repoRoot, ".agents", "harness.json");
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      return JSON.parse(fs.readFileSync(p, "utf8")) || {};
    }
  } catch {
    // Ignore invalid JSON
  }
  return {};
}

/**
 * Automatically symlink declared `worktreeSharedPaths` (e.g., `["tests/fixtures", ".env.test"]`)
 * from the main repository root into a linked Git worktree when running inside a worktree.
 */
export function ensureWorktreeSharedPaths(targetRoot = process.cwd()) {
  const commonGitDir = resolveGitCommonDir(targetRoot);
  if (!commonGitDir) {
    return { linked: [] };
  }
  const mainRepoRoot = path.dirname(commonGitDir);
  if (
    path.resolve(targetRoot) === path.resolve(mainRepoRoot) ||
    safeRealpath(targetRoot) === safeRealpath(mainRepoRoot)
  ) {
    return { linked: [] };
  }

  const wtConfig = loadRepoHarnessJson(targetRoot);
  const mainConfig = loadRepoHarnessJson(mainRepoRoot);
  const sharedPaths = new Set([
    ...(Array.isArray(mainConfig.worktreeSharedPaths) ? mainConfig.worktreeSharedPaths : []),
    ...(Array.isArray(wtConfig.worktreeSharedPaths) ? wtConfig.worktreeSharedPaths : []),
  ]);

  const linked = [];
  for (const rawRel of sharedPaths) {
    if (typeof rawRel !== "string" || !rawRel.trim()) continue;
    const relPath = rawRel.trim().replace(/^\/+|\/+$/g, "");
    if (!relPath || path.isAbsolute(relPath)) continue;

    const srcAbs = path.resolve(mainRepoRoot, relPath);
    const destAbs = path.resolve(targetRoot, relPath);
    if (
      !isStrictDescendantPath(srcAbs, path.resolve(mainRepoRoot)) ||
      !isStrictDescendantPath(destAbs, path.resolve(targetRoot))
    ) {
      continue;
    }

    if (!fs.existsSync(srcAbs)) continue;
    try {
      const existingStat = fs.lstatSync(destAbs, { throwIfNoEntry: false });
      if (existingStat) {
        if (existingStat.isSymbolicLink() && !fs.existsSync(destAbs)) {
          fs.rmSync(destAbs, { force: true });
        } else {
          continue;
        }
      }

      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      const srcStat = fs.statSync(srcAbs);
      fs.symlinkSync(srcAbs, destAbs, srcStat.isDirectory() ? "dir" : "file");
      linked.push(relPath);
    } catch {
      // Ignore transient symlink errors
    }
  }

  return { linked };
}

/**
 * Reconcile and prune stale Git worktree metadata (.git/worktrees/*),
 * orphaned ghost worktree directories across configured Agents,
 * IDE project worktree registries, .git/info/refs, and empty ref namespaces.
 */
export function cleanWorktrees(targetRoot = process.cwd(), options = {}) {
  if (process.env.HARNESS_CLEAN_WORKTREES_ACTIVE === "1") {
    return { prunedWorktrees: [], removedGhostDirs: [], refreshedServerInfo: false };
  }
  const dryRun = Boolean(options.dryRun);
  const quiet = Boolean(options.quiet);
  const silent = Boolean(options.silent);

  const commonGitDir = resolveGitCommonDir(targetRoot);
  if (!commonGitDir) {
    return { prunedWorktrees: [], removedGhostDirs: [], refreshedServerInfo: false };
  }

  // PROP-08: Abort destructive worktree GC if the common .git directory currently holds an active lock
  if (hasActiveGitLock(commonGitDir)) {
    return { prunedWorktrees: [], removedGhostDirs: [], refreshedServerInfo: false };
  }

  const mainRepoRoot = path.dirname(commonGitDir);
  const mainRepoReal = safeRealpath(mainRepoRoot);
  const repoHarnessConfig = loadRepoHarnessJson(mainRepoRoot);
  const rawCooldown =
    options.cooldownMs !== undefined
      ? options.cooldownMs
      : process.env.HARNESS_WORKTREE_COOLDOWN_MS !== undefined
      ? process.env.HARNESS_WORKTREE_COOLDOWN_MS
      : repoHarnessConfig.worktreeCooldownMs;
  const explicitCooldownMs =
    rawCooldown !== undefined && rawCooldown !== null && rawCooldown !== ""
      ? parseDurationMs(typeof rawCooldown === "number" ? `${rawCooldown}ms` : String(rawCooldown))
      : 0;
  const defaultNonEmptyCooldownMs = explicitCooldownMs > 0 ? explicitCooldownMs : 10000;
  const now = Date.now();

  const isCoolingDown = (dirPath, { requireExplicitOrNonEmpty = false } = {}) => {
    if (!fs.existsSync(dirPath)) return false;
    if (hasActiveGitLock(dirPath)) return true;
    try {
      const entries = fs.readdirSync(dirPath).filter((n) => n !== ".DS_Store");
      const thresholdMs =
        explicitCooldownMs > 0
          ? explicitCooldownMs
          : requireExplicitOrNonEmpty && entries.length > 0
          ? defaultNonEmptyCooldownMs
          : 0;
      if (thresholdMs <= 0) return false;
      const { mtimeMs } = statTree(dirPath);
      return now - mtimeMs < thresholdMs;
    } catch {
      return false;
    }
  };

  const worktreesMetaDir = path.join(commonGitDir, "worktrees");
  const prunedWorktrees = [];
  const removedGhostDirs = [];
  const activeWorktreePaths = new Set([path.resolve(mainRepoRoot), mainRepoReal]);
  let hasCoolingWorktreeMeta = false;

  const recordPruned = (name) => {
    if (name && !prunedWorktrees.includes(name)) {
      prunedWorktrees.push(name);
    }
  };
  const recordGhostDir = (dirPath) => {
    const resolved = path.resolve(dirPath);
    if (!removedGhostDirs.includes(resolved)) {
      removedGhostDirs.push(resolved);
    }
  };

  if (fs.existsSync(worktreesMetaDir) && fs.statSync(worktreesMetaDir).isDirectory()) {
    for (const wtName of fs.readdirSync(worktreesMetaDir)) {
      const wtEntryDir = path.join(worktreesMetaDir, wtName);
      try {
        if (!fs.statSync(wtEntryDir).isDirectory()) continue;
        const isLocked =
          fs.existsSync(path.join(wtEntryDir, "locked")) || hasActiveGitLock(wtEntryDir);

        const gitdirFile = path.join(wtEntryDir, "gitdir");
        if (!fs.existsSync(gitdirFile)) continue;

        const rawTarget = fs.readFileSync(gitdirFile, "utf8").trim();
        if (!rawTarget) continue;

        const wtGitFile = path.resolve(wtEntryDir, rawTarget);
        const wtPhysicalDir = path.dirname(wtGitFile);
        const hasGitLink = fs.existsSync(wtGitFile) && fs.existsSync(wtPhysicalDir);
        const cooling =
          isCoolingDown(wtEntryDir) ||
          isCoolingDown(wtPhysicalDir, { requireExplicitOrNonEmpty: true });

        if (isLocked || cooling || hasGitLink) {
          if (!hasGitLink) {
            hasCoolingWorktreeMeta = true;
          }
          activeWorktreePaths.add(path.resolve(wtPhysicalDir));
          activeWorktreePaths.add(safeRealpath(wtPhysicalDir));
          continue;
        }

        recordPruned(wtName);
        const resolvedWtDir = path.resolve(wtPhysicalDir);
        const resolvedRepo = path.resolve(mainRepoRoot);
        const resolvedHome = path.resolve(os.homedir());
        const isSafeWtTarget =
          path.basename(wtGitFile) === ".git" &&
          resolvedWtDir !== resolvedRepo &&
          resolvedWtDir !== resolvedHome &&
          resolvedWtDir !== path.parse(resolvedWtDir).root &&
          !isStrictDescendantPath(resolvedRepo, resolvedWtDir);
        if (
          isSafeWtTarget &&
          fs.existsSync(wtPhysicalDir) &&
          !hasValidWorktreeGitLink(wtPhysicalDir)
        ) {
          if (!dryRun) {
            fs.rmSync(wtPhysicalDir, { recursive: true, force: true });
          }
          recordGhostDir(wtPhysicalDir);
        }
        if (isSafeWtTarget) {
          removeEmptyParentContainer(wtPhysicalDir, mainRepoRoot, dryRun);
        }
      } catch {
        // Ignore transient worktree metadata errors
      }
    }
  }

  if (!dryRun && !hasCoolingWorktreeMeta) {
    spawnSync("git", ["worktree", "prune", "--expire", "now"], {
      cwd: mainRepoRoot,
      encoding: "utf8",
      timeout: 5000,
    });
  }

  const { worktreeContainerDirs, projectRegistryDirs } = resolveAgentWorktreePaths(
    mainRepoRoot,
    options
  );

  // Sweep orphaned ghost worktree directories across all declaratively configured Agent containers
  for (const repoWorktreesDir of worktreeContainerDirs) {
    if (!fs.existsSync(repoWorktreesDir) || !fs.statSync(repoWorktreesDir).isDirectory()) {
      continue;
    }
    for (const entryName of fs.readdirSync(repoWorktreesDir)) {
      if (entryName === ".DS_Store") continue;
      const entryPath = path.join(repoWorktreesDir, entryName);
      try {
        if (!fs.statSync(entryPath).isDirectory()) continue;
        const resolvedEntry = path.resolve(entryPath);
        const realEntry = safeRealpath(entryPath);
        if (activeWorktreePaths.has(resolvedEntry) || activeWorktreePaths.has(realEntry)) {
          continue;
        }
        if (isCoolingDown(entryPath, { requireExplicitOrNonEmpty: true })) {
          activeWorktreePaths.add(resolvedEntry);
          activeWorktreePaths.add(realEntry);
          continue;
        }
        if (!hasValidWorktreeGitLink(entryPath)) {
          if (!dryRun) {
            fs.rmSync(entryPath, { recursive: true, force: true });
          }
          recordPruned(entryName);
          recordGhostDir(entryPath);
        }
      } catch {
        // Ignore transient directory errors
      }
    }
    try {
      const remaining = fs.readdirSync(repoWorktreesDir).filter((n) => n !== ".DS_Store");
      if (remaining.length === 0 && !dryRun) {
        fs.rmSync(repoWorktreesDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore parent cleanup errors
    }
  }

  // Reconcile stale worktree entries across all declaratively configured Agent project registries
  const mainBranch = resolveMainRepoBranch(commonGitDir);
  for (const projectsConfigDir of projectRegistryDirs) {
    if (!fs.existsSync(projectsConfigDir) || !fs.statSync(projectsConfigDir).isDirectory()) {
      continue;
    }
    for (const fileName of fs.readdirSync(projectsConfigDir)) {
      if (!fileName.endsWith(".json")) continue;
      const jsonPath = path.join(projectsConfigDir, fileName);
      try {
        if (!fs.statSync(jsonPath).isFile()) continue;
        const rawJson = fs.readFileSync(jsonPath, "utf8");
        const projectObj = JSON.parse(rawJson);
        const resources = projectObj?.projectResources?.resources;
        if (!Array.isArray(resources)) continue;

        let matchesMainRepo = false;
        let modified = false;

        for (const res of resources) {
          const folderUri = res?.gitFolder?.folderUri || res?.folderUri;
          const folderPath = uriToFsPath(folderUri);
          if (!folderPath) continue;
          if (
            path.resolve(folderPath) === path.resolve(mainRepoRoot) ||
            safeRealpath(folderPath) === mainRepoReal
          ) {
            matchesMainRepo = true;
          }
        }

        if (!matchesMainRepo) continue;

        const envList = projectObj?.environments?.environments;
        if (Array.isArray(envList)) {
          const keptEnvs = [];
          for (const env of envList) {
            const envResources = env?.resources?.resources;
            const envPaths = Array.isArray(envResources)
              ? envResources
                  .map((r) => uriToFsPath(r?.folderUri || r?.gitFolder?.folderUri))
                  .filter(Boolean)
              : [];

            const isActive =
              envPaths.length > 0 &&
              envPaths.some((p) => {
                const resolvedP = path.resolve(p);
                const realP = safeRealpath(p);
                return (
                  fs.existsSync(resolvedP) &&
                  (hasValidWorktreeGitLink(resolvedP) ||
                    isCoolingDown(resolvedP, { requireExplicitOrNonEmpty: true })) &&
                  (activeWorktreePaths.has(resolvedP) || activeWorktreePaths.has(realP))
                );
              });

            if (isActive) {
              keptEnvs.push(env);
            } else {
              for (const p of envPaths) {
                if (
                  fs.existsSync(p) &&
                  path.resolve(p) !== path.resolve(mainRepoRoot) &&
                  isInsideWorktreeContainers(p, worktreeContainerDirs, mainRepoRoot) &&
                  !hasValidWorktreeGitLink(p) &&
                  !isCoolingDown(p, { requireExplicitOrNonEmpty: true })
                ) {
                  if (!dryRun) {
                    fs.rmSync(p, { recursive: true, force: true });
                  }
                  recordGhostDir(p);
                  removeEmptyParentContainer(p, mainRepoRoot, dryRun);
                }
              }
              const staleName =
                env?.name || (envPaths[0] ? path.basename(envPaths[0]) : "stale-env");
              recordPruned(staleName);
              if (
                !dryRun &&
                staleName &&
                staleName !== "main" &&
                staleName !== "master" &&
                staleName !== mainBranch &&
                gitBranchExists(commonGitDir, staleName)
              ) {
                spawnSync("git", ["branch", "-d", staleName], {
                  cwd: mainRepoRoot,
                  encoding: "utf8",
                  timeout: 5000,
                  env: { ...process.env, HARNESS_CLEAN_WORKTREES_ACTIVE: "1" },
                });
              }
              modified = true;
            }
          }

          if (keptEnvs.length !== envList.length) {
            if (keptEnvs.length === 0) {
              delete projectObj.environments;
            } else {
              projectObj.environments.environments = keptEnvs;
            }
            modified = true;
          }
        }

        for (const res of resources) {
          const folderUri = res?.gitFolder?.folderUri || res?.folderUri;
          const folderPath = uriToFsPath(folderUri);
          if (!folderPath) continue;
          if (
            path.resolve(folderPath) === path.resolve(mainRepoRoot) ||
            safeRealpath(folderPath) === mainRepoReal
          ) {
            const defaultBranch = res?.gitFolder?.defaultBranch;
            if (
              defaultBranch &&
              !gitBranchExists(commonGitDir, defaultBranch) &&
              mainBranch &&
              gitBranchExists(commonGitDir, mainBranch)
            ) {
              res.gitFolder.defaultBranch = mainBranch;
              modified = true;
            }
          }
        }

        if (modified && !dryRun) {
          const serialized = JSON.stringify(projectObj, null, 2) + "\n";
          const tmpPath = `${jsonPath}.tmp.${process.pid}`;
          fs.writeFileSync(tmpPath, serialized, "utf8");
          fs.renameSync(tmpPath, jsonPath);
        }
      } catch {
        // Ignore malformed or concurrent project JSON files
      }
    }
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
