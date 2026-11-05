import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { snapshotPath, readHeadPath, restorePath } from "./tdd-files.js";
import { ensureWorktreeSharedPaths } from "./clean.js";
import { buildNormalizedEnv } from "./hook-tools.js";

function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

const ROOT_META_DOCS = new Set([
  "README.md",
  "PROJECTS.md",
  "AGENTS.md",
  "CHANGELOG.md",
  "CLAUDE.md",
]);

function isTestOrMetaFile(relPath) {
  const norm = relPath.split(path.sep).join("/");
  if (
    ROOT_META_DOCS.has(norm) ||
    norm.startsWith("tests/") ||
    norm.startsWith("test/") ||
    norm.startsWith("__tests__/") ||
    norm.startsWith("work/") ||
    norm.startsWith("artifacts/") ||
    norm.startsWith(".agents/") ||
    norm.startsWith("docs/")
  ) {
    return true;
  }
  const base = path.basename(norm);
  if (
    /\.(?:test|spec)\.[jt]sx?$/i.test(base) ||
    /\.(?:test|spec)\.[mc]?js$/i.test(base) ||
    /^test_.*\.py$/i.test(base) ||
    /.*_test\.py$/i.test(base) ||
    /.*_test\.go$/i.test(base)
  ) {
    return true;
  }
  return false;
}

function collectChangedImplFiles(targetRoot) {
  const files = new Set();

  const diffHead = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "diff", "--name-only", "HEAD", "-z"],
    { cwd: targetRoot, encoding: "utf8", timeout: 5000 }
  );
  if (diffHead.status === 0 && diffHead.stdout) {
    for (const item of diffHead.stdout.split("\0")) {
      if (item && !isTestOrMetaFile(item)) {
        files.add(item);
      }
    }
  }

  const diffWorktree = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "diff", "--name-only", "-z"],
    { cwd: targetRoot, encoding: "utf8", timeout: 5000 }
  );
  if (diffWorktree.status === 0 && diffWorktree.stdout) {
    for (const item of diffWorktree.stdout.split("\0")) {
      if (item && !isTestOrMetaFile(item)) {
        files.add(item);
      }
    }
  }

  const diffCached = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "diff", "--name-only", "--cached", "-z"],
    { cwd: targetRoot, encoding: "utf8", timeout: 5000 }
  );
  if (diffCached.status === 0 && diffCached.stdout) {
    for (const item of diffCached.stdout.split("\0")) {
      if (item && !isTestOrMetaFile(item)) {
        files.add(item);
      }
    }
  }

  const untracked = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: targetRoot, encoding: "utf8", timeout: 5000 }
  );
  if (untracked.status === 0 && untracked.stdout) {
    for (const item of untracked.stdout.split("\0")) {
      if (item && !isTestOrMetaFile(item)) {
        files.add(item);
      }
    }
  }

  return [...files];
}

function execTestCommand(targetRoot, testCmd, cmdArgs, env) {
  const started = Date.now();
  let proc;
  if (Array.isArray(cmdArgs) && cmdArgs.length > 0) {
    proc = spawnSync(cmdArgs[0], cmdArgs.slice(1), {
      cwd: targetRoot,
      env,
      shell: cmdArgs.length === 1,
      encoding: "utf8",
      timeout: 120000,
    });
  } else {
    proc = spawnSync(testCmd, {
      cwd: targetRoot,
      env,
      shell: true,
      encoding: "utf8",
      timeout: 120000,
    });
  }
  const durationMs = Date.now() - started;
  return {
    exitCode: proc.status ?? 1,
    stdout: proc.stdout || "",
    stderr: proc.stderr || "",
    durationMs,
  };
}

function pruneEmptyParentsToRoot(fileAbsPath, targetRoot) {
  const resolvedRoot = path.resolve(targetRoot);
  let dir = path.dirname(path.resolve(fileAbsPath));
  while (dir && dir !== resolvedRoot && dir.startsWith(resolvedRoot + path.sep)) {
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) break;
      const entries = fs.readdirSync(dir);
      if (entries.length === 0) {
        fs.rmdirSync(dir);
        dir = path.dirname(dir);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

/**
 * `harness tdd verify --test "<test-cmd>"` (or `harness tdd verify -- <cmd> [args...]`)
 *
 * Automated Red-Green TDD contract verifier:
 * 1. Red Check: Temporarily reverts non-test implementation changes to HEAD baseline and runs `<test-cmd>`.
 *    Asserts exitCode !== 0 (new tests MUST fail without the implementation changes).
 * 2. Green Check: Restores implementation changes and runs `<test-cmd>`.
 *    Asserts exitCode === 0 (tests MUST pass with the implementation changes).
 * 3. Writes `artifacts/<run-id>/tdd_receipt.json`.
 */
export function runTddVerify(targetRoot = process.cwd(), options = {}) {
  const testCmd = options.testCmd;
  const cmdArgs = options.cmdArgs;
  const displayCmd =
    testCmd || (Array.isArray(cmdArgs) && cmdArgs.length > 0 ? cmdArgs.join(" ") : "");

  if (!displayCmd) {
    console.error('Usage: harness tdd verify --test "<test-cmd>"');
    return 1;
  }

  try {
    ensureWorktreeSharedPaths(targetRoot);
  } catch {
    // Non-fatal
  }

  const headCheck = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: targetRoot,
    encoding: "utf8",
    timeout: 5000,
  });
  if (headCheck.status !== 0) {
    console.error(
      "[harness tdd verify] Requires a Git repository with at least one commit (HEAD) to compare baseline."
    );
    return 1;
  }

  const implFiles = collectChangedImplFiles(targetRoot);
  if (implFiles.length === 0) {
    console.error(
      "[harness tdd verify] No modified implementation files detected relative to HEAD."
    );
    return 1;
  }

  const runId = `${formatTimestamp()}-tdd-verify`;
  const artifactsDir = path.join(targetRoot, "artifacts", runId);
  fs.mkdirSync(artifactsDir, { recursive: true });
  const receiptPath = path.join(artifactsDir, "tdd_receipt.json");

  const startedAt = new Date();
  const env = {
    ...buildNormalizedEnv(targetRoot),
    HARNESS_RUN_ID: runId,
    HARNESS_ARTIFACTS_DIR: artifactsDir,
  };

  // Resolve every snapshot before mutating the working tree.
  const backups = implFiles.map((relPath) => {
    const absPath = path.join(targetRoot, relPath);
    return { absPath, current: snapshotPath(absPath), baseline: readHeadPath(targetRoot, relPath) };
  });

  let redResult = null;
  let caughtSignal = null;
  const onSignal = (sig) => {
    caughtSignal = sig;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    // Phase 1 (Red Check): Revert implementation files to HEAD baseline
    for (const item of backups) {
      restorePath(item.absPath, item.baseline);
      if (item.baseline.kind === "missing") pruneEmptyParentsToRoot(item.absPath, targetRoot);
    }

    console.log(`[harness tdd verify] Phase 1 (Red Check): running '${displayCmd}' on HEAD baseline...`);
    redResult = execTestCommand(targetRoot, testCmd, cmdArgs, env);
  } finally {
    // Always restore implementation files back to their exact working tree state
    for (const item of backups) {
      restorePath(item.absPath, item.current);
      if (item.current.kind === "missing") pruneEmptyParentsToRoot(item.absPath, targetRoot);
    }

    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  if (caughtSignal) {
    return 130;
  }

  if (redResult.exitCode === 0) {
    const completedAt = new Date();
    const receipt = {
      runId,
      testCommand: displayCmd,
      implFilesReverted: implFiles,
      redCheck: {
        exitCode: redResult.exitCode,
        durationMs: redResult.durationMs,
        ok: false,
      },
      greenCheck: null,
      verified: false,
      failureReason:
        "Red Check failed: test command exited with 0 on the pre-implementation baseline (tautological or non-discriminating test).",
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
    };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");
    console.error(
      `✗ [harness tdd verify] Red Check failed: '${displayCmd}' passed (exit 0) even with implementation changes reverted! Receipt: ${path.relative(
        targetRoot,
        receiptPath
      )}`
    );
    return 1;
  }

  console.log(
    `✓ [harness tdd verify] Phase 1 (Red Check) passed: test failed on old baseline as expected (exit_code=${redResult.exitCode}).`
  );
  console.log(`[harness tdd verify] Phase 2 (Green Check): running '${displayCmd}' with implementation...`);

  const greenResult = execTestCommand(targetRoot, testCmd, cmdArgs, env);
  const completedAt = new Date();
  const verified = redResult.exitCode !== 0 && greenResult.exitCode === 0;

  const receipt = {
    runId,
    testCommand: displayCmd,
    implFilesReverted: implFiles,
    redCheck: {
      exitCode: redResult.exitCode,
      durationMs: redResult.durationMs,
      ok: true,
    },
    greenCheck: {
      exitCode: greenResult.exitCode,
      durationMs: greenResult.durationMs,
      ok: greenResult.exitCode === 0,
    },
    verified,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
  };

  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");

  if (!verified) {
    console.error(
      `✗ [harness tdd verify] Green Check failed: '${displayCmd}' exited with code ${greenResult.exitCode}. Receipt: ${path.relative(
        targetRoot,
        receiptPath
      )}`
    );
    if (greenResult.stdout) process.stderr.write(greenResult.stdout);
    if (greenResult.stderr) process.stderr.write(greenResult.stderr);
    return 1;
  }

  console.log(
    `✓ [harness tdd verify] Red-Green TDD contract verified (red=${redResult.exitCode} -> green=0). Receipt: ${path.relative(
      targetRoot,
      receiptPath
    )}`
  );
  return 0;
}
