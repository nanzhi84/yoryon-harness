import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { runWatchedProcess } from "../src/watch.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_BIN = path.join(ROOT, "bin", "harness.js");

function runWatch(args, cwd = ROOT) {
  return spawnSync(process.execPath, [CLI_BIN, "watch", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 15000,
  });
}

function runPreToolHook(payload, cwd = ROOT) {
  const result = spawnSync(process.execPath, [CLI_BIN, "hook", "pre-tool"], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.error, undefined);
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    json: result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null,
  };
}

function initSandboxWithViolation(prefix) {
  fs.mkdirSync(path.join(ROOT, "work"), { recursive: true });
  const sandbox = fs.mkdtempSync(path.join(ROOT, "work", prefix));
  const initRes = spawnSync(process.execPath, [CLI_BIN, "init"], {
    cwd: sandbox,
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(initRes.error, undefined);
  assert.equal(initRes.status, 0, initRes.stderr + initRes.stdout);

  const testsDir = path.join(sandbox, "tests");
  fs.mkdirSync(testsDir, { recursive: true });
  fs.writeFileSync(
    path.join(testsDir, "test_phase99.py"),
    "class TestDemo:\n    def test_input_returns_ok(self):\n        assert True\n",
    "utf8"
  );

  return { sandbox };
}

describe("TestWatchdogCli", () => {
  it("test_normal_command_with_timeout_exits_with_child_code", () => {
    const res0 = runWatch([
      "--timeout",
      "5s",
      "--",
      process.execPath,
      "-e",
      "console.log('hello-watch'); process.exit(0)",
    ]);
    assert.equal(res0.error, undefined);
    assert.equal(res0.status, 0, res0.stderr);
    assert.match(res0.stdout, /hello-watch/);

    const res7 = runWatch([
      "--timeout",
      "5s",
      "--",
      process.execPath,
      "-e",
      "process.exit(7)",
    ]);
    assert.equal(res7.error, undefined);
    assert.equal(res7.status, 7, res7.stderr);
  });

  it("test_missing_timeout_flag_returns_error", () => {
    const res = runWatch(["--", "echo", "hi"]);
    assert.equal(res.error, undefined);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /--timeout/);
  });

  it("test_stdin_closed_immediately_prevents_interactive_hang", () => {
    const res = runWatch([
      "--timeout",
      "5s",
      "--",
      process.execPath,
      "-e",
      "let d=''; process.stdin.on('data', c => d+=c); process.stdin.on('end', () => { console.log('stdin-eof'); process.exit(0); });",
    ]);
    assert.equal(res.error, undefined);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /stdin-eof/);
  });

  it("test_exceeding_wall_timeout_terminates_process_with_124", () => {
    const res = runWatch([
      "--timeout",
      "300ms",
      "--",
      process.execPath,
      "-e",
      "setInterval(() => console.log(Date.now()), 50)",
    ]);
    assert.equal(res.error, undefined);
    assert.equal(res.status, 124, `Expected 124, got ${res.status}: ${res.stderr}`);
    assert.match(res.stderr, /WALL_TIMEOUT/);
  });

  it("test_silent_hang_exceeding_idle_timeout_terminates_with_124", () => {
    const res = runWatch([
      "--timeout",
      "10s",
      "--idle-timeout",
      "300ms",
      "--",
      process.execPath,
      "-e",
      "console.log('started'); setTimeout(() => {}, 5000)",
    ]);
    assert.equal(res.error, undefined);
    assert.equal(res.status, 124, `Expected 124, got ${res.status}: ${res.stderr}`);
    assert.match(res.stderr, /IDLE_TIMEOUT/);
  });

  it("test_repeated_identical_lines_triggers_loop_breaker_with_124", () => {
    const res = runWatch([
      "--timeout",
      "10s",
      "--max-repeat",
      "15",
      "--",
      process.execPath,
      "-e",
      "for (let i = 0; i < 200; i++) console.log('ERROR: connection refused');",
    ]);
    assert.equal(res.error, undefined);
    assert.equal(res.status, 124, `Expected 124, got ${res.status}: ${res.stderr}`);
    assert.match(res.stderr, /LOOP_DETECTED/);
  });
});

describe("TestPreToolWatchdogHook", () => {
  it("test_command_without_harness_watch_is_denied", () => {
    const res = runPreToolHook({
      toolCall: {
        name: "run_command",
        args: { CommandLine: "pytest tests/", IsDaemon: false },
      },
    });
    assert.equal(res.status, 0);
    assert.equal(res.json?.decision, "deny");
    assert.match(res.json?.reason || "", /harness watch --timeout/);
  });

  it("test_command_with_while_true_polling_loop_is_denied", () => {
    const res = runPreToolHook({
      toolCall: {
        name: "run_command",
        args: {
          CommandLine: "harness watch --timeout 30s -- sh -c 'while true; do sleep 1; done'",
          IsDaemon: false,
        },
      },
    });
    assert.equal(res.status, 0);
    assert.equal(res.json?.decision, "deny");
    assert.match(res.json?.reason || "", /while true|轮询|死循环/i);
  });

  it("test_valid_harness_watch_command_is_allowed", () => {
    const res = runPreToolHook({
      toolCall: {
        name: "run_command",
        args: {
          CommandLine: "harness watch --timeout 30s -- git status",
          IsDaemon: false,
        },
      },
    });
    assert.equal(res.status, 0);
    assert.equal(res.json?.decision, "allow");
  });

  it("test_daemon_command_is_allowed", () => {
    const res = runPreToolHook({
      toolCall: {
        name: "run_command",
        args: {
          CommandLine: "npm run dev",
          IsDaemon: true,
        },
      },
    });
    assert.equal(res.status, 0);
    assert.equal(res.json?.decision, "allow");
  });

  it("test_hook_install_registers_pre_tool_and_stop_hooks", () => {
    fs.mkdirSync(path.join(ROOT, "work"), { recursive: true });
    const sandbox = fs.mkdtempSync(path.join(ROOT, "work", "watchdog-hook-install-"));
    try {
      const installRes = spawnSync(
        process.execPath,
        [CLI_BIN, "hook", "install", "--agents"],
        {
          cwd: sandbox,
          encoding: "utf8",
          timeout: 15000,
        }
      );
      assert.equal(installRes.error, undefined);
      assert.equal(installRes.status, 0, installRes.stderr + installRes.stdout);

      const hooksJsonPath = path.join(sandbox, ".agents", "hooks.json");
      assert.equal(fs.existsSync(hooksJsonPath), true);
      const hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, "utf8"));
      const guard = hooksConfig?.hooks?.["harness-doctor-guard"] || hooksConfig?.["harness-doctor-guard"];
      assert.ok(guard, "Expected harness-doctor-guard in .agents/hooks.json");

      const preToolUse = guard.PreToolUse;
      assert.ok(Array.isArray(preToolUse), "Expected PreToolUse array in harness-doctor-guard");
      const hasRunCommandPreTool = preToolUse.some(
        (entry) =>
          entry.matcher === "run_command" &&
          Array.isArray(entry.hooks) &&
          entry.hooks.some((h) => h.command === "harness hook pre-tool")
      );
      assert.equal(hasRunCommandPreTool, true, "Expected PreToolUse matcher 'run_command' with 'harness hook pre-tool'");

      const stopHooks = guard.Stop;
      assert.ok(Array.isArray(stopHooks), "Expected Stop array in harness-doctor-guard");
      const hasStopHook = stopHooks.some(
        (entry) =>
          entry.command === "harness hook run --agent" ||
          (Array.isArray(entry.hooks) &&
            entry.hooks.some((h) => h.command === "harness hook run --agent"))
      );
      assert.equal(hasStopHook, true, "Expected Stop hook with 'harness hook run --agent'");
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("test_readonly_command_wrapped_in_harness_watch_skips_stop_hook", () => {
    const { sandbox } = initSandboxWithViolation("watchdog-readonly-");
    try {
      const transcriptPath = path.join(sandbox, "work", "transcript.jsonl");
      const lines = [
        {
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          content: "Check status with harness watch",
        },
        {
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          tool_calls: [
            {
              name: "run_command",
              args: {
                CommandLine: "\"harness watch --timeout 30s -- git status && git diff\"",
              },
            },
          ],
        },
        {
          step_index: 2,
          source: "MODEL",
          type: "GENERIC",
          status: "DONE",
          content: "ok",
        },
        {
          step_index: 3,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "Done.",
        },
      ];
      fs.writeFileSync(
        transcriptPath,
        lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
        "utf8"
      );

      const res = spawnSync(process.execPath, [CLI_BIN, "hook", "run", "--agent"], {
        cwd: sandbox,
        input: JSON.stringify({
          terminationReason: "NO_TOOL_CALL",
          transcriptPath,
        }),
        encoding: "utf8",
        timeout: 15000,
      });
      assert.equal(res.error, undefined);
      assert.equal(res.status, 0, `Expected exit 0, got ${res.status}: ${res.stdout}`);
      const json = res.stdout.trim() ? JSON.parse(res.stdout.trim()) : null;
      assert.deepEqual(json, { decision: "stop" });
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

function isPidGoneEsrch(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return Boolean(err && err.code === "ESRCH");
  }
}

async function waitWithTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForReadyFile(readyFilePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(readyFilePath)) {
      const raw = fs.readFileSync(readyFilePath, "utf8");
      return JSON.parse(raw);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ready file: ${readyFilePath}`);
}

async function assertPidsTerminatedWithEsrch(pids, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => isPidGoneEsrch(pid))) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  for (const pid of pids) {
    assert.throws(
      () => process.kill(pid, 0),
      { code: "ESRCH" },
      `Expected PID ${pid} to be terminated with ESRCH, but process is still alive`
    );
  }
}

async function verifyWatcherSignalCascade({
  signal,
  expectedExitCode,
  ignoreSignals = [],
}) {
  fs.mkdirSync(path.join(ROOT, "work"), { recursive: true });
  const sandbox = fs.mkdtempSync(path.join(ROOT, "work", "watchdog-signal-"));
  const readyFilePath = path.join(sandbox, "ready.json");
  const grandchildScriptPath = path.join(sandbox, "grandchild.js");
  const childScriptPath = path.join(sandbox, "child.js");

  const ignoreSnippet = `const IGNORE_SIGNALS = ${JSON.stringify(ignoreSignals)};\nfor (const sig of IGNORE_SIGNALS) { process.on(sig, () => {}); }\n`;

  fs.writeFileSync(
    grandchildScriptPath,
    `${ignoreSnippet}process.stdout.write("grandchild-ready\\n");\nsetInterval(() => {}, 1000);\n`,
    "utf8"
  );

  fs.writeFileSync(
    childScriptPath,
    [
      'import fs from "node:fs";',
      'import { spawn } from "node:child_process";',
      "const [readyFile, grandchildScript] = process.argv.slice(2);",
      ignoreSnippet,
      "const grandchild = spawn(process.execPath, [grandchildScript], {",
      '  stdio: ["ignore", "pipe", "pipe"],',
      "  timeout: 25000,",
      "});",
      'grandchild.stdout.once("data", () => {',
      "  const tmpFile = `${readyFile}.tmp`;",
      "  fs.writeFileSync(",
      "    tmpFile,",
      "    JSON.stringify({ pid: process.pid, grandchildPid: grandchild.pid }),",
      '    "utf8"',
      "  );",
      "  fs.renameSync(tmpFile, readyFile);",
      "});",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
    "utf8"
  );

  const trackedPids = new Set();
  let watchProc;

  try {
    watchProc = spawn(
      process.execPath,
      [
        CLI_BIN,
        "watch",
        "--timeout",
        "30s",
        "--",
        process.execPath,
        childScriptPath,
        readyFilePath,
        grandchildScriptPath,
      ],
      {
        cwd: ROOT,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
      }
    );

    if (watchProc.pid) {
      trackedPids.add(watchProc.pid);
    }

    let stderrBuf = "";
    watchProc.stdout.resume();
    watchProc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
    });

    const exitPromise = new Promise((resolve, reject) => {
      watchProc.once("error", reject);
      watchProc.once("exit", (code, exitSignal) => {
        resolve({ code, exitSignal });
      });
    });

    const { pid: childPid, grandchildPid } = await waitForReadyFile(readyFilePath, 5000);
    trackedPids.add(childPid);
    trackedPids.add(grandchildPid);

    assert.equal(isPidGoneEsrch(childPid), false, "Expected child process to be running before signal");
    assert.equal(isPidGoneEsrch(grandchildPid), false, "Expected grandchild process to be running before signal");

    const signalSentAt = Date.now();
    process.kill(watchProc.pid, signal);

    const { code, exitSignal } = await waitWithTimeout(
      exitPromise,
      3000,
      `harness watch did not exit within 3000ms after receiving ${signal} (stderr: ${stderrBuf})`
    );
    const elapsedMs = Date.now() - signalSentAt;

    assert.ok(
      elapsedMs < 3000,
      `Expected harness watch to exit promptly (< 3000ms) on ${signal}, took ${elapsedMs}ms`
    );
    assert.ok(
      code === expectedExitCode || exitSignal === signal,
      `Expected exit code ${expectedExitCode} or signal ${signal}, got code=${code}, signal=${exitSignal} (stderr: ${stderrBuf})`
    );

    await assertPidsTerminatedWithEsrch([childPid, grandchildPid], 1000);
  } finally {
    try {
      if (fs.existsSync(readyFilePath)) {
        const parsed = JSON.parse(fs.readFileSync(readyFilePath, "utf8"));
        if (parsed?.pid) trackedPids.add(parsed.pid);
        if (parsed?.grandchildPid) trackedPids.add(parsed.grandchildPid);
      }
    } catch {}

    for (const pid of trackedPids) {
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }

    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

describe("TestWatchdogSignalCascade", () => {
  it("test_sigterm_on_watcher_terminates_process_tree_and_exits_143", async () => {
    await verifyWatcherSignalCascade({
      signal: "SIGTERM",
      expectedExitCode: 143,
    });
  });

  it("test_sigint_on_watcher_terminates_process_tree_and_exits_130", async () => {
    await verifyWatcherSignalCascade({
      signal: "SIGINT",
      expectedExitCode: 130,
    });
  });

  it("test_sighup_on_watcher_terminates_process_tree_and_exits_129", async () => {
    await verifyWatcherSignalCascade({
      signal: "SIGHUP",
      expectedExitCode: 129,
    });
  });

  it("test_stubborn_process_tree_ignoring_sigterm_is_force_killed_within_grace_period", async () => {
    await verifyWatcherSignalCascade({
      signal: "SIGTERM",
      expectedExitCode: 143,
      ignoreSignals: ["SIGTERM"],
    });
  });

  it("test_repeated_normal_runs_do_not_leak_host_signal_listeners", async () => {
    assert.equal(typeof runWatchedProcess, "function");
    const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
    const beforeCounts = Object.fromEntries(
      signals.map((sig) => [sig, process.listenerCount(sig)])
    );

    for (let i = 0; i < 5; i += 1) {
      const res = await runWatchedProcess(
        ROOT,
        [process.execPath, "-e", "process.exit(0)"],
        { wallTimeoutMs: 5000 }
      );
      if (typeof res === "number") {
        assert.equal(res, 0);
      } else if (res && typeof res === "object" && "exitCode" in res) {
        assert.equal(res.exitCode, 0);
      }
    }

    const afterCounts = Object.fromEntries(
      signals.map((sig) => [sig, process.listenerCount(sig)])
    );
    assert.deepEqual(afterCounts, beforeCounts);
  });
});

describe("TestWatchdogTerminalAndProgress", () => {
  it("test_tty_flag_with_dumb_term_injects_terminal_env_and_keeps_stdout_clean", () => {
    const env = { ...process.env, TERM: "dumb" };
    delete env.TTY_COMPATIBLE;
    delete env.FORCE_COLOR;
    delete env.CLICOLOR_FORCE;
    delete env.NO_COLOR;
    delete env.COLUMNS;
    delete env.LINES;

    const script = [
      'process.stderr.write("progress-stderr\\n");',
      'process.stdout.write(JSON.stringify({',
      '  ttyCompat: process.env.TTY_COMPATIBLE,',
      '  forceColor: process.env.FORCE_COLOR,',
      '  term: process.env.TERM,',
      '  cols: process.env.COLUMNS,',
      '  lines: process.env.LINES,',
      '}));',
    ].join(" ");

    const res = spawnSync(
      process.execPath,
      [CLI_BIN, "watch", "--tty", "--timeout", "5s", "--", process.execPath, "-e", script],
      {
        cwd: ROOT,
        env,
        encoding: "utf8",
        timeout: 15000,
      }
    );

    assert.equal(res.error, undefined);
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ttyCompat, "1");
    assert.equal(parsed.forceColor, "1");
    assert.equal(parsed.term, "xterm-256color");
    assert.ok(Number(parsed.cols) > 0, `Expected COLUMNS > 0, got ${parsed.cols}`);
    assert.ok(Number(parsed.lines) > 0, `Expected LINES > 0, got ${parsed.lines}`);
    assert.equal(res.stderr.includes("progress-stderr"), true);
  });

  it("test_outer_smart_terminal_auto_forwards_tty_compatibility_unless_dumb_or_disabled", async () => {
    const cleanEnv = { ...process.env };
    delete cleanEnv.TTY_COMPATIBLE;
    delete cleanEnv.COLUMNS;
    delete cleanEnv.LINES;
    delete cleanEnv.NO_COLOR;

    const script = [
      'process.stdout.write(JSON.stringify({',
      '  ttyCompat: process.env.TTY_COMPATIBLE ?? null,',
      '  cols: process.env.COLUMNS ?? null,',
      '  lines: process.env.LINES ?? null,',
      '}));',
    ].join(" ");

    const runCase = async (options) => {
      let stdout = "";
      const res = await runWatchedProcess(
        ROOT,
        [process.execPath, "-e", script],
        {
          ...options,
          onStdoutChunk: (chunk) => {
            stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
          },
        }
      );
      assert.equal(res.exitCode, 0);
      return JSON.parse(stdout);
    };

    const caseA = await runCase({
      wallTimeoutMs: 5000,
      outerStdoutIsTty: true,
      outerStderrIsTty: true,
      outerColumns: 132,
      outerRows: 43,
      env: { ...cleanEnv, TERM: "xterm-256color" },
    });
    assert.equal(caseA.ttyCompat, "1");
    assert.equal(caseA.cols, "132");
    assert.equal(caseA.lines, "43");

    const caseB = await runCase({
      wallTimeoutMs: 5000,
      outerStdoutIsTty: true,
      outerStderrIsTty: true,
      outerColumns: 132,
      outerRows: 43,
      env: { ...cleanEnv, TERM: "dumb" },
    });
    assert.equal(caseB.ttyCompat, null);

    const caseC = await runCase({
      wallTimeoutMs: 5000,
      noTty: true,
      outerStdoutIsTty: true,
      outerStderrIsTty: true,
      outerColumns: 132,
      outerRows: 43,
      env: { ...cleanEnv, TERM: "xterm-256color" },
    });
    assert.equal(caseC.ttyCompat, null);

    const caseD = await runCase({
      wallTimeoutMs: 5000,
      outerStdoutIsTty: false,
      outerStderrIsTty: true,
      outerColumns: 132,
      outerRows: 43,
      env: { ...cleanEnv, TERM: "xterm-256color" },
    });
    assert.equal(caseD.ttyCompat, null);
  });

  it("test_in_place_carriage_return_and_cursor_control_frames_do_not_trigger_loop_breaker", () => {
    const progressScript = [
      'for (let i = 0; i < 35; i++) process.stderr.write("\\rDownloading 50%");',
      'for (let i = 0; i < 35; i++) process.stderr.write("\\r\\x1b[2K\\x1b[1AWaiting for worker\\n");',
      "process.exit(0);",
    ].join(" ");

    const progressRes = runWatch([
      "--timeout",
      "5s",
      "--max-repeat",
      "10",
      "--",
      process.execPath,
      "-e",
      progressScript,
    ]);
    assert.equal(progressRes.error, undefined);
    assert.equal(progressRes.status, 0, progressRes.stderr);

    const loopScript = [
      'for (let i = 0; i < 35; i++) process.stderr.write("\\x1b[31mERROR: connection refused\\x1b[0m\\n");',
    ].join(" ");

    const loopRes = runWatch([
      "--timeout",
      "5s",
      "--max-repeat",
      "10",
      "--",
      process.execPath,
      "-e",
      loopScript,
    ]);
    assert.equal(loopRes.error, undefined);
    assert.equal(loopRes.status, 124, `Expected 124, got ${loopRes.status}: ${loopRes.stderr}`);
    assert.match(loopRes.stderr, /LOOP_DETECTED/);
  });

  it("test_tty_flag_over_non_tty_pipe_deduplicates_consecutive_identical_redraw_frames", () => {
    const script = [
      "let count = 0;",
      "const timer = setInterval(() => {",
      "  count += 1;",
      "  if (count <= 15) {",
      '    process.stderr.write("\\r\\x1b[2KInitializing panel");',
      "    return;",
      "  }",
      "  clearInterval(timer);",
      '  process.stderr.write("\\r\\x1b[2KCompleted 5/5\\n");',
      '  process.stdout.write(\'{"ok":true}\\n\');',
      "  process.exit(0);",
      "}, 10);",
    ].join(" ");

    const res = spawnSync(
      process.execPath,
      [CLI_BIN, "watch", "--tty", "--timeout", "5s", "--", process.execPath, "-e", script],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 15000,
      }
    );

    assert.equal(res.error, undefined);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout), { ok: true });
    const occurrences = res.stderr.split("Initializing panel").length - 1;
    assert.equal(occurrences, 1, `Expected 1 occurrence of Initializing panel, got ${occurrences}: ${res.stderr}`);
    assert.equal(res.stderr.includes("Completed 5/5"), true);
  });
});
