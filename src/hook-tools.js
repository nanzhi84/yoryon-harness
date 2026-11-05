import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveGitCommonDir } from "./clean.js";

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

export function findInPath(binName, targetRoot = process.cwd()) {
  const pathEnv = buildNormalizedPath(targetRoot);
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binName);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function findPyrefly(targetRoot) {
  const venvPyrefly = path.join(targetRoot, ".venv", "bin", "pyrefly");
  if (isExecutableFile(venvPyrefly)) {
    return venvPyrefly;
  }
  const whichPyrefly = findInPath("pyrefly", targetRoot);
  if (whichPyrefly) {
    return whichPyrefly;
  }
  const extRoot = path.join(os.homedir(), ".antigravity-ide", "extensions");
  if (fs.existsSync(extRoot) && fs.statSync(extRoot).isDirectory()) {
    const dirs = fs
      .readdirSync(extRoot)
      .filter((d) => d.startsWith("meta.pyrefly-"))
      .sort()
      .reverse();
    for (const d of dirs) {
      const candidate = path.join(extRoot, d, "bin", "pyrefly");
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * PROP-10: Collect incrementally modified/added files from Git (`--staged` or `HEAD`).
 * Returns `null` if `targetRoot` is not a Git repository.
 */
export function getChangedFiles(targetRoot = process.cwd(), { staged = false } = {}) {
  if (!fs.existsSync(path.join(targetRoot, ".git"))) {
    return null;
  }
  const files = new Set();
  const addFromZ = (stdout) => {
    if (!stdout) return;
    for (const f of stdout.split("\0")) {
      if (!f) continue;
      const rel = f.split(path.sep).join("/");
      const abs = path.join(targetRoot, rel);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        files.add(rel);
      }
    }
  };

  if (staged) {
    const cached = spawnSync(
      "git",
      ["-c", "core.quotePath=false", "diff", "--name-only", "--cached", "--diff-filter=ACMR", "-z"],
      { cwd: targetRoot, encoding: "utf8", timeout: 5000 }
    );
    if (cached.status === 0) {
      addFromZ(cached.stdout);
      return [...files];
    }
    return null;
  }

  const headDiff = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=ACMR", "HEAD", "-z"],
    { cwd: targetRoot, encoding: "utf8", timeout: 5000 }
  );
  if (headDiff.status === 0) {
    addFromZ(headDiff.stdout);
  }
  const worktreeDiff = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=ACMR", "-z"],
    { cwd: targetRoot, encoding: "utf8", timeout: 5000 }
  );
  if (worktreeDiff.status === 0) {
    addFromZ(worktreeDiff.stdout);
  }
  const cachedDiff = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "diff", "--name-only", "--cached", "--diff-filter=ACMR", "-z"],
    { cwd: targetRoot, encoding: "utf8", timeout: 5000 }
  );
  if (cachedDiff.status === 0) {
    addFromZ(cachedDiff.stdout);
  }
  const untracked = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: targetRoot, encoding: "utf8", timeout: 5000 }
  );
  if (untracked.status === 0) {
    addFromZ(untracked.stdout);
  }
  return [...files];
}

