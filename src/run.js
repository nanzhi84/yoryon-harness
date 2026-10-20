import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function sanitizeSlug(name) {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "") || "task"
  );
}

/**
 * `harness run <task-name> -- <command...>`
 * Creates isolated `work/<run-id>/` and `artifacts/<run-id>/`, injects env vars,
 * executes command, and records `stdout.log`, `stderr.log`, and `receipt.json`.
 */
export async function runSandboxTask(targetRoot, taskName, cmdArgs) {
  if (!taskName || !cmdArgs || cmdArgs.length === 0) {
    console.error("Usage: harness run <task-name> -- <command> [args...]");
    return 1;
  }

  const slug = sanitizeSlug(taskName);
  const runId = `${formatTimestamp()}-${slug}`;
  const workDir = path.join(targetRoot, "work", runId);
  const artifactsDir = path.join(targetRoot, "artifacts", runId);

  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });

  const stdoutLogPath = path.join(artifactsDir, "stdout.log");
  const stderrLogPath = path.join(artifactsDir, "stderr.log");
  const receiptPath = path.join(artifactsDir, "receipt.json");

  const stdoutStream = fs.createWriteStream(stdoutLogPath);
  const stderrStream = fs.createWriteStream(stderrLogPath);

  const startedAt = new Date();
  const env = {
    ...process.env,
    HARNESS_RUN_ID: runId,
    HARNESS_TASK_NAME: slug,
    HARNESS_WORK_DIR: workDir,
    HARNESS_ARTIFACTS_DIR: artifactsDir,
  };

  console.log(`[harness run] run_id=${runId}`);
  console.log(`[harness run] work_dir=${path.relative(targetRoot, workDir)}`);
  console.log(`[harness run] artifacts_dir=${path.relative(targetRoot, artifactsDir)}`);

  const exitCode = await new Promise((resolve) => {
    const child = spawn(cmdArgs[0], cmdArgs.slice(1), {
      cwd: targetRoot,
      env,
      shell: cmdArgs.length === 1,
      stdio: ["inherit", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      stdoutStream.write(chunk);
    });

    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      stderrStream.write(chunk);
    });

    child.on("error", (err) => {
      const msg = `Failed to start command: ${err.message}\n`;
      process.stderr.write(msg);
      stderrStream.write(msg);
      resolve(127);
    });

    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });

  stdoutStream.end();
  stderrStream.end();

  const completedAt = new Date();
  const artifactFiles = fs.readdirSync(artifactsDir);

  const receipt = {
    runId,
    taskName: slug,
    command: cmdArgs,
    exitCode,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    workDir: path.relative(targetRoot, workDir),
    artifactsDir: path.relative(targetRoot, artifactsDir),
    artifacts: artifactFiles,
  };

  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  console.log(
    `[harness run] finished with exit_code=${exitCode} (${receipt.durationMs}ms). Receipt: ${path.relative(
      targetRoot,
      receiptPath
    )}`
  );

  return exitCode;
}
