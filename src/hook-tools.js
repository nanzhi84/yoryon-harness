import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveGitCommonDir } from "./clean.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_PACKAGE_VERSION = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(MODULE_DIR, "..", "package.json"), "utf8")
    );
    return String(pkg.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
})();

/**
 * PROP-06: Build normalized PATH covering project-local virtualenvs and multi-language user toolchains.
 */
export function buildNormalizedPath(targetRoot = process.cwd(), basePath = process.env.PATH || "") {
  const home = os.homedir();
  const candidateDirs = [
    path.join(targetRoot, ".venv", "bin"),
    path.join(targetRoot, "node_modules", ".bin"),
  ];
  const commonGitDir = resolveGitCommonDir(targetRoot);
  if (commonGitDir) {
    const mainRepoRoot = path.dirname(commonGitDir);
    if (path.resolve(mainRepoRoot) !== path.resolve(targetRoot)) {
      candidateDirs.push(
        path.join(mainRepoRoot, ".venv", "bin"),
        path.join(mainRepoRoot, "node_modules", ".bin")
      );
    }
  }
  candidateDirs.push(
    path.join(home, ".cargo", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  );
  const existingParts = basePath.split(path.delimiter).filter(Boolean);
  const seen = new Set();
  const merged = [];
  for (const dir of [...candidateDirs, ...existingParts]) {
    if (!seen.has(dir)) {
      seen.add(dir);
      merged.push(dir);
    }
  }
  return merged.join(path.delimiter);
}

export function buildNormalizedEnv(targetRoot = process.cwd(), baseEnv = process.env) {
  return {
    ...baseEnv,
    PATH: buildNormalizedPath(targetRoot, baseEnv.PATH || ""),
  };
}

export function isExecutableFile(filePath) {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return false;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findInPath(binName, targetRoot = process.cwd(), baseEnv = process.env) {
  const pathEnv = buildNormalizedPath(targetRoot, (baseEnv && baseEnv.PATH) || "");
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binName);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function isPyreflyConfigured(targetRoot = process.cwd()) {
  const venvPyrefly = path.join(targetRoot, ".venv", "bin", "pyrefly");
  if (isExecutableFile(venvPyrefly)) {
    return true;
  }
  if (fs.existsSync(path.join(targetRoot, "pyrefly.toml"))) {
    return true;
  }
  const pyprojectPath = path.join(targetRoot, "pyproject.toml");
  if (fs.existsSync(pyprojectPath)) {
    try {
      const content = fs.readFileSync(pyprojectPath, "utf8");
      if (/^\s*\[tool\.pyrefly(?:\.|\])/m.test(content)) {
        return true;
      }
    } catch {
      // Ignore unreadable pyproject.toml
    }
  }
  return false;
}

export function findPyrefly(targetRoot, baseEnv = process.env) {
  const venvPyrefly = path.join(targetRoot, ".venv", "bin", "pyrefly");
  if (isExecutableFile(venvPyrefly)) {
    return venvPyrefly;
  }
  if (!isPyreflyConfigured(targetRoot)) {
    return null;
  }
  return findInPath("pyrefly", targetRoot, baseEnv);
}

function buildGitIsolatedEnv(targetRoot, baseEnv = process.env) {
  return {
    ...baseEnv,
    GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(targetRoot)),
  };
}

/**
 * Collect both surviving changed files (`existingChangedFiles`, for per-file linters/formatters)
 * and all touched paths including deletions (`allTouchedPaths`, `--diff-filter=ACMRD`, for cross-file typecheckers).
 * Returns `null` if `targetRoot` is not a Git repository.
 */
export function getWorkspaceChanges(targetRoot = process.cwd(), { staged = false } = {}) {
  if (!fs.existsSync(path.join(targetRoot, ".git"))) {
    return null;
  }
  const gitEnv = buildGitIsolatedEnv(targetRoot);
  const allTouched = new Set();
  const existingFiles = new Set();

  const addFromZ = (stdout) => {
    if (!stdout) return;
    for (const f of stdout.split("\0")) {
      if (!f) continue;
      const rel = f.split(path.sep).join("/");
      allTouched.add(rel);
      const abs = path.join(targetRoot, rel);
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          existingFiles.add(rel);
        }
      } catch {
        // Ignore transient stat failure
      }
    }
  };

  if (staged) {
    const cached = spawnSync(
      "git",
      ["-c", "core.quotePath=false", "diff", "--name-only", "--cached", "--diff-filter=ACMRD", "-z"],
      { cwd: targetRoot, encoding: "utf8", timeout: 5000, env: gitEnv }
    );
    if (cached.status === 0) {
      addFromZ(cached.stdout);
      return {
        existingChangedFiles: [...existingFiles],
        allTouchedPaths: [...allTouched],
      };
    }
    return null;
  }

  const headDiff = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=ACMRD", "HEAD", "-z"],
    { cwd: targetRoot, encoding: "utf8", timeout: 5000, env: gitEnv }
  );
  if (headDiff.status === 0) {
    addFromZ(headDiff.stdout);
  }
  const worktreeDiff = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=ACMRD", "-z"],
    { cwd: targetRoot, encoding: "utf8", timeout: 5000, env: gitEnv }
  );
  if (worktreeDiff.status === 0) {
    addFromZ(worktreeDiff.stdout);
  }
  const cachedDiff = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "diff", "--name-only", "--cached", "--diff-filter=ACMRD", "-z"],
    { cwd: targetRoot, encoding: "utf8", timeout: 5000, env: gitEnv }
  );
  if (cachedDiff.status === 0) {
    addFromZ(cachedDiff.stdout);
  }
  const untracked = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: targetRoot, encoding: "utf8", timeout: 5000, env: gitEnv }
  );
  if (untracked.status === 0) {
    addFromZ(untracked.stdout);
  }
  return {
    existingChangedFiles: [...existingFiles],
    allTouchedPaths: [...allTouched],
  };
}

/**
 * PROP-10: Collect incrementally modified/added existing files from Git (`--staged` or `HEAD`).
 * Returns `null` if `targetRoot` is not a Git repository.
 */
export function getChangedFiles(targetRoot = process.cwd(), { staged = false } = {}) {
  const changes = getWorkspaceChanges(targetRoot, { staged });
  return changes ? changes.existingChangedFiles : null;
}

const VERIFY_CACHE_FILENAME = "harness-verify-cache.json";
const MAX_CACHED_DIGESTS = 32;

export function resolveGitDir(targetRoot = process.cwd()) {
  if (!fs.existsSync(path.join(targetRoot, ".git"))) {
    return null;
  }
  try {
    const proc = spawnSync("git", ["rev-parse", "--git-dir"], {
      cwd: targetRoot,
      encoding: "utf8",
      timeout: 5000,
      env: buildGitIsolatedEnv(targetRoot),
    });
    if (proc.status === 0 && proc.stdout && proc.stdout.trim()) {
      return path.resolve(targetRoot, proc.stdout.trim());
    }
  } catch {
    // Ignore git resolution errors
  }
  return null;
}

export function loadVerifyCache(targetRoot = process.cwd()) {
  const empty = {
    schemaVersion: 1,
    doctorDigests: [],
    fullDigests: [],
    stopCursors: {},
  };
  const gitDir = resolveGitDir(targetRoot);
  if (!gitDir) return empty;
  const cachePath = path.join(gitDir, VERIFY_CACHE_FILENAME);
  try {
    if (!fs.existsSync(cachePath)) return empty;
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== 1) {
      return empty;
    }
    return {
      schemaVersion: 1,
      doctorDigests: Array.isArray(parsed.doctorDigests) ? parsed.doctorDigests : [],
      fullDigests: Array.isArray(parsed.fullDigests) ? parsed.fullDigests : [],
      stopCursors:
        parsed.stopCursors && typeof parsed.stopCursors === "object"
          ? parsed.stopCursors
          : {},
    };
  } catch {
    return empty;
  }
}

export function saveVerifyCache(targetRoot = process.cwd(), cacheState) {
  const gitDir = resolveGitDir(targetRoot);
  if (!gitDir || !fs.existsSync(gitDir)) return false;
  const cachePath = path.join(gitDir, VERIFY_CACHE_FILENAME);
  const tmpPath = `${cachePath}.${process.pid}.tmp`;
  const normalized = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    doctorDigests: [...new Set(cacheState.doctorDigests || [])].slice(-MAX_CACHED_DIGESTS),
    fullDigests: [...new Set(cacheState.fullDigests || [])].slice(-MAX_CACHED_DIGESTS),
    stopCursors: cacheState.stopCursors || {},
  };
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2) + "\n", "utf8");
    fs.renameSync(tmpPath, cachePath);
    return true;
  } catch {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup failure
    }
    return false;
  }
}

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function computeCliSalt(targetRoot) {
  const hash = crypto.createHash("sha256");
  hash.update(`v1\0${CLI_PACKAGE_VERSION}\0`);
  hash.update(process.env.HARNESS_ALLOW_PROTECTED === "1" ? "allow-protected\0" : "strict\0");
  const harnessJsonPath = path.join(targetRoot, ".agents", "harness.json");
  try {
    if (fs.existsSync(harnessJsonPath) && fs.statSync(harnessJsonPath).isFile()) {
      hash.update(fs.readFileSync(harnessJsonPath));
    }
  } catch {
    // Ignore
  }
  return hash.digest("hex");
}

function computeDigestFromTreeAndEntries(targetRoot, cliSalt, treeOid, statusMap) {
  const sortedPaths = [...statusMap.keys()].sort();
  const hash = crypto.createHash("sha256");
  hash.update(`${cliSalt}\n${treeOid}\n`);
  for (const rel of sortedPaths) {
    const xy = statusMap.get(rel) || "";
    const abs = path.join(targetRoot, rel);
    try {
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) {
        hash.update(`${rel}\0${xy}\0L\0${fs.readlinkSync(abs)}\n`);
      } else if (st.isFile()) {
        const fileHash = sha256Hex(fs.readFileSync(abs));
        hash.update(`${rel}\0${xy}\0F\0${fileHash}\n`);
      } else {
        hash.update(`${rel}\0${xy}\0O\n`);
      }
    } catch {
      hash.update(`${rel}\0${xy}\0D\n`);
    }
  }
  return hash.digest("hex");
}

function parsePorcelainZEntries(stdout) {
  const entries = new Map();
  if (!stdout) return entries;
  const parts = stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const x = entry[0];
    const y = entry[1];
    const relPath = entry.slice(3).split(path.sep).join("/");
    if (relPath) entries.set(relPath, xy);
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const origPath = parts[i + 1];
      if (origPath) {
        entries.set(origPath.split(path.sep).join("/"), `${xy}:orig`);
      }
      i += 1;
    }
  }
  return entries;
}

export function computeWorkspaceDigest(targetRoot = process.cwd()) {
  if (!fs.existsSync(path.join(targetRoot, ".git"))) {
    return null;
  }
  const gitEnv = buildGitIsolatedEnv(targetRoot);
  const treeProc = spawnSync("git", ["rev-parse", "--verify", "HEAD^{tree}"], {
    cwd: targetRoot,
    encoding: "utf8",
    timeout: 5000,
    env: gitEnv,
  });
  const headTree =
    treeProc.status === 0 && treeProc.stdout && treeProc.stdout.trim()
      ? treeProc.stdout.trim()
      : "UNBORN";

  const statusProc = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "-uall"],
    { cwd: targetRoot, encoding: "utf8", timeout: 5000, env: gitEnv }
  );
  if (statusProc.status !== 0) {
    return null;
  }
  const statusEntries = parsePorcelainZEntries(statusProc.stdout || "");
  const cliSalt = computeCliSalt(targetRoot);
  const digest = computeDigestFromTreeAndEntries(
    targetRoot,
    cliSalt,
    headTree,
    statusEntries
  );
  return {
    cliSalt,
    headTree,
    changedPaths: [...statusEntries.keys()],
    digest,
  };
}

export function computePreSignedNextCommitDigest(targetRoot = process.cwd(), cliSaltInput = null) {
  if (!fs.existsSync(path.join(targetRoot, ".git"))) {
    return null;
  }
  const gitEnv = buildGitIsolatedEnv(targetRoot);
  // Only pre-sign next HEAD tree if there are NO unstaged tracked edits/deletions
  const unstagedProc = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=ACMRD", "-z"],
    { cwd: targetRoot, encoding: "utf8", timeout: 5000, env: gitEnv }
  );
  if (unstagedProc.status !== 0 || (unstagedProc.stdout && unstagedProc.stdout.length > 0)) {
    return null;
  }

  const writeTreeProc = spawnSync("git", ["write-tree"], {
    cwd: targetRoot,
    encoding: "utf8",
    timeout: 5000,
    env: gitEnv,
  });
  const nextTreeOid =
    writeTreeProc.status === 0 && writeTreeProc.stdout ? writeTreeProc.stdout.trim() : "";
  if (!nextTreeOid) {
    return null;
  }

  const untrackedProc = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: targetRoot, encoding: "utf8", timeout: 5000, env: gitEnv }
  );
  if (untrackedProc.status !== 0) {
    return null;
  }
  const untrackedEntries = new Map();
  for (const raw of (untrackedProc.stdout || "").split("\0")) {
    if (!raw) continue;
    untrackedEntries.set(raw.split(path.sep).join("/"), "??");
  }

  const cliSalt = cliSaltInput || computeCliSalt(targetRoot);
  return {
    digest: computeDigestFromTreeAndEntries(
      targetRoot,
      cliSalt,
      nextTreeOid,
      untrackedEntries
    ),
    hasUntracked: untrackedEntries.size > 0,
  };
}

export function computeTranscriptCursorSnapshot(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) {
    return null;
  }
  const resolved = path.resolve(transcriptPath.trim());
  if (!fs.existsSync(resolved)) {
    return null;
  }
  try {
    const rawLines = fs
      .readFileSync(resolved, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim());
    if (rawLines.length === 0) return null;
    const steps = rawLines.map((line) => JSON.parse(line));
    const lastStep = steps[steps.length - 1];
    const lastPassedStepIndex =
      lastStep && typeof lastStep.step_index === "number"
        ? lastStep.step_index
        : steps.length - 1;
    return {
      key: resolved,
      entry: {
        lastPassedStepIndex,
        stepAnchor: sha256Hex(JSON.stringify(lastStep)),
      },
    };
  } catch {
    return null;
  }
}

const PURE_READONLY_COMMANDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "nl",
  "od",
  "xxd",
  "hexdump",
  "file",
  "stat",
  "du",
  "df",
  "pwd",
  "whoami",
  "id",
  "uname",
  "date",
  "uptime",
  "printenv",
  "which",
  "whereis",
  "type",
  "realpath",
  "readlink",
  "basename",
  "dirname",
  "echo",
  "printf",
  "true",
  "false",
  "test",
  "[",
  "[[",
  "expr",
  "seq",
  "cmp",
  "diff",
  "colordiff",
  "md5",
  "md5sum",
  "shasum",
  "sha1sum",
  "sha256sum",
  "cksum",
  "jq",
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "ag",
  "ack",
  "cut",
  "uniq",
  "tr",
  "column",
  "fold",
  "fmt",
  "pr",
  "rev",
  "tac",
  "paste",
  "join",
  "comm",
  "look",
  "strings",
  "nm",
  "objdump",
  "otool",
  "ldd",
  "ps",
  "top",
  "pgrep",
  "lsof",
  "netstat",
  "ss",
  "ifconfig",
  "ip",
  "dig",
  "nslookup",
  "host",
  "ping",
  "tree",
  "pyright",
  "mypy",
  "flake8",
]);

const READONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "rev-list",
  "describe",
  "shortlog",
  "blame",
  "annotate",
  "ls-files",
  "ls-tree",
  "ls-remote",
  "cat-file",
  "check-ignore",
  "check-attr",
  "check-mailmap",
  "check-ref-format",
  "cherry",
  "count-objects",
  "difftool",
  "for-each-ref",
  "grep",
  "help",
  "merge-base",
  "merge-tree",
  "name-rev",
  "range-diff",
  "show-branch",
  "show-ref",
  "var",
  "verify-commit",
  "verify-pack",
  "verify-tag",
  "version",
  "whatchanged",
]);

const READONLY_TOOL_NAMES = new Set([
  "read_file",
  "view_file",
  "view_file_outline",
  "view_code_item",
  "grep_search",
  "find_by_name",
  "list_dir",
  "list_resources",
  "read_resource",
  "search_web",
  "search_marketplace",
  "list_plugin_accounts",
  "ask_question",
  "send_message",
  "schedule",
  "define_subagent",
]);

const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

function extractShellDashCScript(bin, args) {
  if (!SHELL_WRAPPERS.has(bin)) return null;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "-o" || arg === "+o") {
      if (i + 1 >= args.length) return null;
      i += 2;
      continue;
    }
    if (
      arg === "--norc" ||
      arg === "--noprofile" ||
      arg === "--no-rcs" ||
      arg === "--no-globalrcs"
    ) {
      i += 1;
      continue;
    }
    if (/^-[A-Za-z]+$/.test(arg)) {
      const flags = arg.slice(1);
      for (const ch of flags) {
        if (!"cleuxvf".includes(ch)) {
          return null;
        }
      }
      if (flags.includes("c")) {
        if (i + 1 >= args.length || typeof args[i + 1] !== "string") {
          return null;
        }
        return args[i + 1];
      }
      i += 1;
      continue;
    }
    return null;
  }
  return null;
}

export function unwrapTranscriptString(val) {
  if (typeof val !== "string") return "";
  const trimmed = val.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed.trim();
    } catch {
      // Fall through
    }
  }
  return trimmed;
}

function splitShellSegments(cmdLine) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < cmdLine.length; i++) {
    const ch = cmdLine[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < cmdLine.length) {
        current += ch + cmdLine[i + 1];
        i++;
        continue;
      }
      if (ch === '"') quote = null;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < cmdLine.length) {
      current += ch + cmdLine[i + 1];
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      segments.push(current.trim());
      current = "";
      continue;
    }
    if ((ch === "&" || ch === "|") && cmdLine[i + 1] === ch) {
      segments.push(current.trim());
      current = "";
      i++;
      continue;
    }
    if (ch === "|" || ch === "&") {
      segments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    segments.push(current.trim());
  }
  return segments.filter(Boolean);
}

function hasUnsafeOutputRedirection(segment) {
  const sanitized = segment
    .replace(/[012]?>>?\s*\/dev\/null\b/g, "")
    .replace(/&>>?\s*\/dev\/null\b/g, "")
    .replace(/[012]?>&[012-]/g, "")
    .replace(/&>[012]/g, "");

  let quote = null;
  for (let i = 0; i < sanitized.length; i++) {
    const ch = sanitized[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < sanitized.length) {
        i++;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "\\" && i + 1 < sanitized.length) {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ">") {
      return true;
    }
  }
  return false;
}

function tokenizeShellSegment(segment) {
  const tokens = [];
  let current = "";
  let quote = null;
  let hasTokenChar = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      hasTokenChar = true;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < segment.length) {
        current += segment[i + 1];
        i++;
      } else if (ch === '"') {
        quote = null;
      } else {
        current += ch;
      }
      hasTokenChar = true;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) {
      current += segment[i + 1];
      hasTokenChar = true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasTokenChar = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasTokenChar) {
        tokens.push(current);
        current = "";
        hasTokenChar = false;
      }
      continue;
    }
    current += ch;
    hasTokenChar = true;
  }
  if (hasTokenChar) {
    tokens.push(current);
  }
  return tokens;
}

function isReadOnlyGitCommand(args) {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (
      arg === "-C" ||
      arg === "-c" ||
      arg === "--git-dir" ||
      arg === "--work-tree" ||
      arg === "--namespace"
    ) {
      i += 2;
      continue;
    }
    if (
      arg.startsWith("--git-dir=") ||
      arg.startsWith("--work-tree=") ||
      arg.startsWith("--namespace=") ||
      arg === "--no-pager" ||
      arg === "-P" ||
      arg === "--paginate" ||
      arg === "-p" ||
      arg === "--bare" ||
      arg === "--no-replace-objects" ||
      arg === "--literal-pathspecs"
    ) {
      i += 1;
      continue;
    }
    if (arg === "--version" || arg === "-v" || arg === "--help" || arg === "-h") {
      return true;
    }
    break;
  }

  if (i >= args.length) {
    return true;
  }

  const sub = args[i];
  const subArgs = args.slice(i + 1);

  if (READONLY_GIT_SUBCOMMANDS.has(sub)) {
    return true;
  }

  if (sub === "branch") {
    if (subArgs.length === 0) return true;
    const mutatingBranchFlags = new Set([
      "-d",
      "-D",
      "--delete",
      "-m",
      "-M",
      "--move",
      "-c",
      "-C",
      "--copy",
      "-f",
      "--force",
      "-u",
      "--set-upstream-to",
      "--unset-upstream",
      "--edit-description",
    ]);
    if (subArgs.some((a) => mutatingBranchFlags.has(a) || a.startsWith("--set-upstream-to="))) {
      return false;
    }
    const queryFlags = new Set([
      "-a",
      "--all",
      "-r",
      "--remotes",
      "-l",
      "--list",
      "-v",
      "-vv",
      "--verbose",
      "--show-current",
      "--contains",
      "--no-contains",
      "--merged",
      "--no-merged",
      "--points-at",
    ]);
    if (subArgs.some((a) => queryFlags.has(a))) {
      return true;
    }
    return false;
  }

  if (sub === "tag") {
    if (subArgs.length === 0) return true;
    if (
      subArgs.some((a) =>
        ["-d", "--delete", "-a", "--annotate", "-s", "--sign", "-f", "--force", "-u", "-m"].includes(a)
      )
    ) {
      return false;
    }
    return subArgs.some((a) =>
      ["-l", "--list", "-v", "--verify", "--contains", "--no-contains", "--points-at"].includes(a)
    );
  }

  if (sub === "remote") {
    if (subArgs.length === 0) return true;
    if (subArgs.every((a) => a === "-v" || a === "--verbose")) return true;
    return subArgs[0] === "show" || subArgs[0] === "get-url";
  }

  if (sub === "stash") {
    return subArgs[0] === "list" || subArgs[0] === "show";
  }

  if (sub === "worktree") {
    return subArgs[0] === "list";
  }

  if (sub === "reflog") {
    return subArgs.length === 0 || subArgs[0] === "show" || subArgs[0] === "exists";
  }

  if (sub === "config") {
    const mutatingConfigFlags = new Set([
      "--unset",
      "--unset-all",
      "--replace-all",
      "--add",
      "--remove-section",
      "--rename-section",
      "--edit",
      "-e",
    ]);
    if (subArgs.some((a) => mutatingConfigFlags.has(a))) return false;
    return subArgs.some((a) =>
      ["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l"].includes(a)
    );
  }

  return false;
}

export function isReadOnlyShellCommand(rawCommandLine, depth = 0) {
  if (depth > 4) return false;
  let cmdLine = unwrapTranscriptString(rawCommandLine);
  if (!cmdLine) return false;

  // Unwrap leading `harness watch ... -- <inner command>` wrapper if present
  const leadingWatchMatch = cmdLine.match(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:node\s+\S*harness\.js|(?:\/\S+\/)?(?:yoryon-)?harness)\s+watch\s+(?:(?!--\s)[^;&|`$])+--\s+([\s\S]+)$/
  );
  if (leadingWatchMatch && leadingWatchMatch[1]) {
    cmdLine = leadingWatchMatch[1].trim();
    if (!cmdLine) return false;
    if (
      (cmdLine.startsWith("'") || cmdLine.startsWith('"')) &&
      splitShellSegments(cmdLine).length === 1
    ) {
      const singleArgTokens = tokenizeShellSegment(cmdLine);
      if (singleArgTokens.length === 1) {
        return isReadOnlyShellCommand(singleArgTokens[0], depth + 1);
      }
    }
  }

  // Check and neutralize $(...) command substitutions outside single quotes
  let cleanedCmd = "";
  let singleQuoted = false;
  for (let i = 0; i < cmdLine.length; i++) {
    const ch = cmdLine[i];
    if (ch === "\\" && !singleQuoted && i + 1 < cmdLine.length) {
      cleanedCmd += ch + cmdLine[i + 1];
      i++;
      continue;
    }
    if (ch === "'") {
      singleQuoted = !singleQuoted;
      cleanedCmd += ch;
      continue;
    }
    if (!singleQuoted && ch === "$" && cmdLine[i + 1] === "(") {
      let parenDepth = 1;
      let j = i + 2;
      while (j < cmdLine.length && parenDepth > 0) {
        if (cmdLine[j] === "\\") {
          j += 2;
          continue;
        }
        if (cmdLine[j] === "(") parenDepth++;
        else if (cmdLine[j] === ")") parenDepth--;
        j++;
      }
      if (parenDepth !== 0) return false;
      const inner = cmdLine.slice(i + 2, j - 1);
      if (!isReadOnlyShellCommand(inner, depth + 1)) {
        return false;
      }
      cleanedCmd += "__SUB__";
      i = j - 1;
      continue;
    }
    if (!singleQuoted && ch === "`") {
      let j = i + 1;
      while (j < cmdLine.length && cmdLine[j] !== "`") {
        if (cmdLine[j] === "\\") j += 2;
        else j++;
      }
      if (j >= cmdLine.length) return false;
      const inner = cmdLine.slice(i + 1, j);
      if (!isReadOnlyShellCommand(inner, depth + 1)) {
        return false;
      }
      cleanedCmd += "__SUB__";
      i = j;
      continue;
    }
    cleanedCmd += ch;
  }

  const segments = splitShellSegments(cleanedCmd);
  if (segments.length === 0) return false;

  for (const segment of segments) {
    if (hasUnsafeOutputRedirection(segment)) {
      return false;
    }
    let tokens = tokenizeShellSegment(segment);
    while (tokens.length > 0 && (tokens[0] === "(" || tokens[0] === ")")) {
      tokens.shift();
    }
    while (tokens.length > 0 && tokens[tokens.length - 1] === ")") {
      tokens.pop();
    }
    while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
      tokens.shift();
    }
    while (
      tokens.length > 0 &&
      ["env", "command", "time", "nice", "nohup"].includes(path.basename(tokens[0]))
    ) {
      tokens.shift();
      while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
        tokens.shift();
      }
    }
    if (tokens.length >= 2 && path.basename(tokens[0]) === "uv" && tokens[1] === "run") {
      tokens = tokens.slice(2);
      while (tokens.length > 0 && tokens[0].startsWith("-")) {
        tokens.shift();
      }
    }
    if (tokens.length === 0) continue;

    const bin = path.basename(tokens[0]);
    const args = tokens.slice(1);

    const innerShellScript = extractShellDashCScript(bin, args);
    if (innerShellScript !== null) {
      if (!isReadOnlyShellCommand(innerShellScript, depth + 1)) {
        return false;
      }
      continue;
    }

    if (bin === ":" || bin === "export") {
      continue;
    }
    if (bin === "set") {
      let validSet = true;
      for (let idx = 0; idx < args.length; idx++) {
        const a = args[idx];
        if (a === "-o" || a === "+o") {
          idx += 1;
          continue;
        }
        if (/^[-+][euoxvf]+$/.test(a)) {
          continue;
        }
        validSet = false;
        break;
      }
      if (!validSet) return false;
      continue;
    }

    if (PURE_READONLY_COMMANDS.has(bin)) {
      continue;
    }
    if (bin === "sort") {
      if (args.some((a) => a === "-o" || a.startsWith("-o") || a === "--output" || a.startsWith("--output="))) {
        return false;
      }
      continue;
    }
    if (bin === "sed") {
      if (
        args.some(
          (a) =>
            a === "-i" ||
            a === "--in-place" ||
            a.startsWith("--in-place=") ||
            /^-[A-Za-z]*i/.test(a)
        )
      ) {
        return false;
      }
      continue;
    }
    if (bin === "yq") {
      if (args.some((a) => a === "-i" || a === "--inplace")) {
        return false;
      }
      continue;
    }
    if (bin === "awk" || bin === "gawk") {
      if (args.some((a) => a === "-i" || a === "inplace")) {
        return false;
      }
      continue;
    }
    if (bin === "find") {
      if (
        args.some((a) =>
          ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fls", "-fprintf"].includes(a)
        )
      ) {
        return false;
      }
      continue;
    }
    if (bin === "harness" || bin === "yoryon-harness") {
      const sub = args[0] || "";
      if (sub === "watch") {
        const dashDashIdx = args.indexOf("--");
        if (dashDashIdx !== -1 && dashDashIdx + 1 < args.length) {
          const innerSegment = args.slice(dashDashIdx + 1).join(" ");
          if (isReadOnlyShellCommand(innerSegment, depth + 1)) {
            continue;
          }
        }
        return false;
      }
      if (
        !sub ||
        ["doctor", "rule", "help", "--help", "-h", "--version", "-v"].includes(sub) ||
        (sub === "clean" && args.includes("--dry-run"))
      ) {
        continue;
      }
      return false;
    }
    if (bin === "git") {
      if (isReadOnlyGitCommand(args)) {
        continue;
      }
      return false;
    }
    if (bin === "gh") {
      const sub = args[0] || "";
      const sub2 = args[1] || "";
      if (
        ["status", "version", "help", "--help", "-h", "--version", "search"].includes(sub) ||
        [
          "auth status",
          "repo view",
          "repo list",
          "issue list",
          "issue view",
          "issue status",
          "pr list",
          "pr view",
          "pr status",
          "pr checks",
          "pr diff",
          "run list",
          "run view",
          "release list",
          "release view",
        ].includes(`${sub} ${sub2}`)
      ) {
        continue;
      }
      return false;
    }
    if (bin === "ruff") {
      if (
        (args[0] === "check" && !args.includes("--fix") && !args.includes("--fix-only")) ||
        (args[0] === "format" && args.includes("--check"))
      ) {
        continue;
      }
      return false;
    }
    if (bin === "pyrefly") {
      if (args[0] === "check") continue;
      return false;
    }
    if (bin === "eslint") {
      if (!args.includes("--fix")) continue;
      return false;
    }
    if (bin === "prettier") {
      if (
        (args.includes("--check") || args.includes("-c")) &&
        !args.includes("--write") &&
        !args.includes("-w")
      ) {
        continue;
      }
      return false;
    }
    if (bin === "tsc") {
      if (args.includes("--noEmit")) continue;
      return false;
    }

    return false;
  }

  return true;
}

export function isReadOnlyToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== "object") return false;
  const name = unwrapTranscriptString(String(toolCall.name || ""));
  if (!name) return false;
  if (READONLY_TOOL_NAMES.has(name)) {
    return true;
  }
  const args = toolCall.args && typeof toolCall.args === "object" ? toolCall.args : {};
  if (name === "manage_subagents") {
    return unwrapTranscriptString(String(args.Action || "")) === "list";
  }
  if (name === "manage_task") {
    const action = unwrapTranscriptString(String(args.Action || ""));
    return action === "list" || action === "status";
  }
  if (name === "invoke_subagent") {
    const typeName = unwrapTranscriptString(String(args.TypeName ?? args.typeName ?? ""));
    return typeName === "research";
  }
  if (name === "swarm") {
    const action = unwrapTranscriptString(String(args.action ?? args.Action ?? ""));
    return action === "status" || action === "models";
  }
  if (name === "run_command") {
    const cmdLine = args.CommandLine ?? args.commandLine ?? "";
    return isReadOnlyShellCommand(String(cmdLine));
  }
  return false;
}

export function isReadOnlyAgentTurn(payload, options = {}) {
  if (!payload || typeof payload !== "object") return false;

  if (payload.toolCall && typeof payload.toolCall === "object") {
    return isReadOnlyToolCall(payload.toolCall);
  }

  const transcriptPath =
    typeof payload.transcriptPath === "string" ? payload.transcriptPath.trim() : "";
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return false;
  }

  let steps = [];
  try {
    const rawLines = fs
      .readFileSync(transcriptPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim());
    steps = rawLines.map((line) => JSON.parse(line));
  } catch {
    return false;
  }

  let lastUserInputIdx = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i] && steps[i].type === "USER_INPUT") {
      lastUserInputIdx = i;
      break;
    }
  }

  let sliceStartIdx = lastUserInputIdx >= 0 ? lastUserInputIdx + 1 : 0;
  const cacheState = options.cacheState;
  const resolvedTranscript = path.resolve(transcriptPath);
  const cursorEntry =
    cacheState &&
    cacheState.stopCursors &&
    typeof cacheState.stopCursors === "object"
      ? cacheState.stopCursors[resolvedTranscript]
      : null;

  if (
    cursorEntry &&
    typeof cursorEntry.lastPassedStepIndex === "number" &&
    typeof cursorEntry.stepAnchor === "string"
  ) {
    let anchorIdx = -1;
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i];
      const sIdx = s && typeof s.step_index === "number" ? s.step_index : i;
      if (sIdx === cursorEntry.lastPassedStepIndex) {
        if (sha256Hex(JSON.stringify(s)) === cursorEntry.stepAnchor) {
          anchorIdx = i;
        }
        break;
      }
    }
    if (anchorIdx >= 0 && anchorIdx + 1 > sliceStartIdx) {
      sliceStartIdx = anchorIdx + 1;
    }
  }

  const turnSteps = steps.slice(sliceStartIdx);

  // If any step in turnSteps had truncated tool_calls, attempt to load transcript_full.jsonl
  let fullByStepIndex = null;
  if (
    turnSteps.some(
      (s) =>
        s &&
        Array.isArray(s.truncated_fields) &&
        s.truncated_fields.includes("tool_calls")
    )
  ) {
    const fullPath = path.join(path.dirname(transcriptPath), "transcript_full.jsonl");
    if (fs.existsSync(fullPath)) {
      try {
        fullByStepIndex = new Map();
        const fullLines = fs
          .readFileSync(fullPath, "utf8")
          .split(/\r?\n/)
          .filter((line) => line.trim());
        for (const line of fullLines) {
          const parsed = JSON.parse(line);
          if (parsed && parsed.step_index !== undefined) {
            fullByStepIndex.set(parsed.step_index, parsed);
          }
        }
      } catch {
        fullByStepIndex = null;
      }
    }
  }

  for (let i = 0; i < turnSteps.length; i++) {
    let step = turnSteps[i];
    if (!step || step.type !== "PLANNER_RESPONSE") continue;
    if (
      fullByStepIndex &&
      Array.isArray(step.truncated_fields) &&
      step.truncated_fields.includes("tool_calls") &&
      fullByStepIndex.has(step.step_index)
    ) {
      step = fullByStepIndex.get(step.step_index);
    }

    const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    for (let k = 0; k < toolCalls.length; k++) {
      const tc = toolCalls[k];
      const resultStep = turnSteps[i + 1 + k];
      if (
        resultStep &&
        resultStep.type !== "PLANNER_RESPONSE" &&
        resultStep.type !== "USER_INPUT" &&
        resultStep.status === "ERROR"
      ) {
        continue;
      }
      if (!isReadOnlyToolCall(tc)) {
        return false;
      }
    }
  }

  return true;
}


