import fs from "node:fs";
import path from "node:path";

const SANDBOX_DIRS = ["work", "artifacts"];
const PROTECTED_NAMES = new Set([".gitkeep", ".gitignore"]);
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
      .filter((name) => !PROTECTED_NAMES.has(name))
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
  }

  if (removed.length > 0 || !quiet) {
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
