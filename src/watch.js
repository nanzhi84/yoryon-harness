import fs from "node:fs";
import { spawn } from "node:child_process";
import { buildNormalizedEnv } from "./hook-tools.js";

function isRegularFileStdin() {
  try {
    return fs.fstatSync(0).isFile();
  } catch {
    return false;
  }
}

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5m (300s)
export const DEFAULT_MAX_REPEAT = 100;
export const DEFAULT_REDRAW_THROTTLE_MS = 10 * 1000; // 10s
const SIGNAL_GRACE_MS = 500;
const HOST_SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};
const IN_PLACE_REDRAW_CHUNK_RE = /\r(?!\n)|\x1b\[[0-9;]*[ABCDEFGHJKfsu]/;
const IN_PLACE_REDRAW_LINE_RE = /\x1b\[[0-9;]*[ABCDEFGHJKfsu]|\x1b\[\?[0-9;]*[hl]/;

/**
 * Resolve terminal environment variables passed to watched child processes:
 * - Explicit `--tty`: injects `TTY_COMPATIBLE=1`, `FORCE_COLOR=1`, `CLICOLOR_FORCE=1`,
 *   upgrades empty/dumb `TERM` to `xterm-256color`, and ensures `COLUMNS`/`LINES`.
 * - Automatic outer TTY passthrough (when `!noTty` and outer stdout/stderr are non-dumb TTYs):
 *   forwards `TTY_COMPATIBLE=1`, `COLUMNS`, and `LINES` unless `NO_COLOR` is set.
 */
export function resolveChildTerminalEnv(baseEnv, options = {}) {
  const {
    tty = false,
    noTty = false,
    outerStdoutIsTty = Boolean(process.stdout.isTTY),
    outerStderrIsTty = Boolean(process.stderr.isTTY),
    outerColumns = process.stdout.columns || process.stderr.columns || 0,
    outerRows = process.stdout.rows || process.stderr.rows || 0,
  } = options;

  const childEnv = { ...(baseEnv || {}) };
  if (noTty) {
    return childEnv;
  }

  const rawTerm = String(childEnv.TERM || "").trim();
  const isDumbOrEmptyTerm =
    !rawTerm || rawTerm.toLowerCase() === "dumb" || rawTerm.toLowerCase() === "unknown";

  if (tty) {
    childEnv.TTY_COMPATIBLE = "1";
    if (!childEnv.FORCE_COLOR) childEnv.FORCE_COLOR = "1";
    if (!childEnv.CLICOLOR_FORCE) childEnv.CLICOLOR_FORCE = "1";
    if (isDumbOrEmptyTerm) childEnv.TERM = "xterm-256color";
    if (!childEnv.COLUMNS) {
      childEnv.COLUMNS = String(outerColumns > 0 ? outerColumns : 120);
    }
    if (!childEnv.LINES) {
      childEnv.LINES = String(outerRows > 0 ? outerRows : 40);
    }
    return childEnv;
  }

  if (outerStdoutIsTty && outerStderrIsTty && !isDumbOrEmptyTerm && !childEnv.NO_COLOR) {
    if (!childEnv.TTY_COMPATIBLE) childEnv.TTY_COMPATIBLE = "1";
    if (!childEnv.COLUMNS && outerColumns > 0) {
      childEnv.COLUMNS = String(outerColumns);
    }
    if (!childEnv.LINES && outerRows > 0) {
      childEnv.LINES = String(outerRows);
    }
  }

  return childEnv;
}

/**
 * Parse human-readable duration strings like "300ms", "30s", "5m", "2h", or plain seconds "30".
 * Returns duration in milliseconds, or null if invalid.
 */
export function parseDurationMs(raw) {
  if (typeof raw !== "string" && typeof raw !== "number") {
    return null;
  }
  const str = String(raw).trim();
  if (!str) return null;

  const match = str.match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs)?$/i);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  const unit = (match[2] || "s").toLowerCase();
  if (unit === "ms") return Math.ceil(value);
  if (unit === "s" || unit === "sec" || unit === "secs") return Math.ceil(value * 1000);
  if (unit === "m" || unit === "min" || unit === "mins") return Math.ceil(value * 60 * 1000);
  if (unit === "h" || unit === "hr" || unit === "hrs") return Math.ceil(value * 3600 * 1000);
  return null;
}

export function formatDurationMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms % 3600000 === 0) return `${ms / 3600000}h`;
  if (ms % 60000 === 0) return `${ms / 60000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Normalize a log line for consecutive duplicate loop detection by stripping ANSI codes
 * and leading timestamps so repeated loop errors with advancing timestamps are still caught.
 */
export function normalizeLineForRepeatCheck(line) {
  return line
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(
      /^\[?\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?\s*/i,
      ""
    )
    .trim();
}

function signalProcessGroup(child, signal) {
  if (!child || !child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Ignore if already exited
    }
  }
}

function isProcessGroupAlive(pgid) {
  if (!pgid || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

function killProcessGroup(child, initialSignal = "SIGTERM") {
  if (!child || !child.pid) return;
  signalProcessGroup(child, initialSignal);
  const killTimer = setTimeout(() => {
    signalProcessGroup(child, "SIGKILL");
  }, SIGNAL_GRACE_MS);
  killTimer.unref();
}

/**
 * Run a child command under the Universal Harness watchdog:
 * - Enforces total wall-clock timeout (`wallTimeoutMs`)
 * - Enforces silent hang / inactivity timeout (`idleTimeoutMs`, default 5m)
 * - Enforces consecutive identical line loop breaker (`maxRepeat`, default 100)
 * - Closes stdin (`ignore`) to prevent interactive prompt hangs
 * - Cascades host `SIGTERM` / `SIGINT` / `SIGHUP` signals to `-child.pid` with `SIGKILL` escalation
 * - Terminates the entire detached process group on breach and returns exitCode 124
 */
export async function runWatchedProcess(targetRoot, cmdArgs, options = {}) {
  const {
    wallTimeoutMs,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    maxRepeat = DEFAULT_MAX_REPEAT,
    env = buildNormalizedEnv(targetRoot),
    tty = false,
    noTty = false,
    outerStdoutIsTty = Boolean(process.stdout.isTTY),
    outerStderrIsTty = Boolean(process.stderr.isTTY),
    outerColumns = process.stdout.columns || process.stderr.columns || 0,
    outerRows = process.stdout.rows || process.stderr.rows || 0,
    redrawThrottleMs: rawRedrawThrottleMs,
    onStdoutChunk,
    onStderrChunk,
  } = options;
  const redrawThrottleMs = rawRedrawThrottleMs ?? DEFAULT_REDRAW_THROTTLE_MS;

  const childEnv = resolveChildTerminalEnv(env, {
    tty,
    noTty,
    outerStdoutIsTty,
    outerStderrIsTty,
    outerColumns,
    outerRows,
  });

  return new Promise((resolve) => {
    let settled = false;
    let childClosed = false;
    let watchdogTriggered = null;
    let forwardedSignal = null;
    let graceTimer = null;
    let reapTimer = null;
    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    let lastNormalizedLine = null;
    let repeatCount = 0;
    let stdoutPartial = "";
    let stderrPartial = "";

    const emitRawStdout = (buf) => {
      process.stdout.write(buf);
      if (onStdoutChunk) onStdoutChunk(buf);
    };
    const emitRawStderr = (buf) => {
      process.stderr.write(buf);
      if (onStderrChunk) onStderrChunk(buf);
    };

    const createRedrawState = (enabled, writeFn) => ({
      enabled,
      writeFn,
      lastKey: null,
      lastEmittedAt: 0,
      pendingChunk: null,
      pendingKey: null,
    });

    const stdoutRedraw = createRedrawState(
      Boolean(!noTty && tty && !outerStdoutIsTty),
      emitRawStdout
    );
    const stderrRedraw = createRedrawState(
      Boolean(!noTty && tty && !outerStderrIsTty),
      emitRawStderr
    );

    const flushPendingRedraw = (state, now = Date.now()) => {
      if (!state.pendingChunk) return;
      const chunkToWrite = state.pendingChunk;
      const keyToWrite = state.pendingKey;
      state.pendingChunk = null;
      state.pendingKey = null;
      if (keyToWrite !== null && keyToWrite === state.lastKey) {
        return;
      }
      state.lastKey = keyToWrite;
      state.lastEmittedAt = now;
      state.writeFn(chunkToWrite);
    };

    const flushAllPendingRedraws = (now = Date.now()) => {
      flushPendingRedraw(stdoutRedraw, now);
      flushPendingRedraw(stderrRedraw, now);
    };

    const stdinOption = isRegularFileStdin() ? 0 : "ignore";
    const shellOption =
      cmdArgs.length === 1
        ? (childEnv && childEnv.SHELL) || process.env.SHELL || true
        : false;

    const child = spawn(cmdArgs[0], cmdArgs.slice(1), {
      cwd: targetRoot,
      env: childEnv,
      shell: shellOption,
      detached: true,
      stdio: [stdinOption, "pipe", "pipe"],
    });

    const signalListeners = [];

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(checkTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (reapTimer) clearInterval(reapTimer);
      for (const [sig, listener] of signalListeners) {
        process.off(sig, listener);
      }
      resolve(result);
    };

    for (const sig of Object.keys(HOST_SIGNAL_EXIT_CODES)) {
      const listener = () => {
        if (settled) return;
        if (forwardedSignal) {
          signalProcessGroup(child, "SIGKILL");
          return;
        }
        forwardedSignal = sig;
        const signalExitCode = HOST_SIGNAL_EXIT_CODES[sig];
        clearInterval(checkTimer);
        signalProcessGroup(child, sig);

        if (!child.pid || (childClosed && !isProcessGroupAlive(child.pid))) {
          flushAllPendingRedraws();
          finish({ exitCode: signalExitCode, watchdogTriggered: null });
          return;
        }

        const signalReceivedAt = Date.now();
        graceTimer = setTimeout(() => {
          signalProcessGroup(child, "SIGKILL");
        }, SIGNAL_GRACE_MS);

        reapTimer = setInterval(() => {
          if (settled) return;
          if (childClosed && !isProcessGroupAlive(child.pid)) {
            flushAllPendingRedraws();
            finish({ exitCode: signalExitCode, watchdogTriggered: null });
            return;
          }
          if (Date.now() - signalReceivedAt >= SIGNAL_GRACE_MS + 300) {
            signalProcessGroup(child, "SIGKILL");
            flushAllPendingRedraws();
            finish({ exitCode: signalExitCode, watchdogTriggered: null });
          }
        }, 20);
      };
      process.on(sig, listener);
      signalListeners.push([sig, listener]);
    }

    const emitWatchdogError = (code, detail) => {
      if (settled || forwardedSignal) return;
      watchdogTriggered = code;
      flushAllPendingRedraws();
      const msg = `\n[harness-watchdog] ${code}: ${detail}\n`;
      emitRawStderr(Buffer.from(msg, "utf8"));
      killProcessGroup(child);
      finish({ exitCode: 124, watchdogTriggered });
    };

    const inspectLines = (textChunk, isStderr = false) => {
      if (settled || forwardedSignal) return;
      const combined = (isStderr ? stderrPartial : stdoutPartial) + textChunk;
      let scanBody = combined;
      let trailingCr = "";
      if (combined.endsWith("\r")) {
        // Keep trailing CR until next chunk so split CRLF ("\r" + "\n") is not misread as bare CR.
        scanBody = combined.slice(0, -1);
        trailingCr = "\r";
      }

      let lastIndex = 0;
      const lineRegex = /([^\r\n]*)(\r\n|\n|\r)/g;
      let match;
      while ((match = lineRegex.exec(scanBody)) !== null) {
        const rawLine = match[1];
        const delim = match[2];
        lastIndex = lineRegex.lastIndex;

        if (delim === "\r" || IN_PLACE_REDRAW_LINE_RE.test(rawLine)) {
          continue;
        }

        const normalized = normalizeLineForRepeatCheck(rawLine);
        if (!normalized) continue;
        if (normalized === lastNormalizedLine) {
          repeatCount += 1;
          if (repeatCount >= maxRepeat) {
            emitWatchdogError(
              "LOOP_DETECTED",
              `检测到连续 ${maxRepeat} 行重复输出，疑似死循环刷屏，已自动熔断 (${normalized.slice(0, 100)})`
            );
            return;
          }
        } else {
          lastNormalizedLine = normalized;
          repeatCount = 1;
        }
      }

      const remainder = scanBody.slice(lastIndex) + trailingCr;
      if (isStderr) {
        stderrPartial = remainder;
      } else {
        stdoutPartial = remainder;
      }
    };

    const handleStreamChunk = (chunk, text, state, now = Date.now()) => {
      if (!state.enabled) {
        state.writeFn(chunk);
        return;
      }

      const visibleKey = text
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
        .replace(/\r/g, "")
        .trim();

      if (IN_PLACE_REDRAW_CHUNK_RE.test(text)) {
        if (!visibleKey) {
          state.writeFn(chunk);
          return;
        }
        if (visibleKey === state.lastKey) {
          state.pendingChunk = null;
          state.pendingKey = null;
          return;
        }
        if (
          state.lastEmittedAt === 0 ||
          redrawThrottleMs <= 0 ||
          now - state.lastEmittedAt >= redrawThrottleMs
        ) {
          state.pendingChunk = null;
          state.pendingKey = null;
          state.lastKey = visibleKey;
          state.lastEmittedAt = now;
          state.writeFn(chunk);
          return;
        }
        state.pendingChunk = chunk;
        state.pendingKey = visibleKey;
        return;
      }

      flushPendingRedraw(state, now);
      if (visibleKey) {
        state.lastKey = visibleKey;
      }
      state.writeFn(chunk);
    };

    const pollIntervalMs = Math.max(
      20,
      Math.min(200, Math.floor(Math.min(wallTimeoutMs, idleTimeoutMs) / 4))
    );

    const checkTimer = setInterval(() => {
      if (settled || forwardedSignal) return;
      const now = Date.now();
      if (now - startedAt >= wallTimeoutMs) {
        emitWatchdogError(
          "WALL_TIMEOUT",
          `命令执行超过设定总时长上限 (${formatDurationMs(wallTimeoutMs)})，已自动熔断终止。`
        );
        return;
      }
      if (now - lastActivityAt >= idleTimeoutMs) {
        emitWatchdogError(
          "IDLE_TIMEOUT",
          `连续 ${formatDurationMs(idleTimeoutMs)} 无任何日志输出，疑似静默挂起、网络未设 timeout 或死锁，已自动熔断终止。`
        );
      }
    }, pollIntervalMs);

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      const now = Date.now();
      lastActivityAt = now;
      const text = chunk.toString("utf8");
      handleStreamChunk(chunk, text, stdoutRedraw, now);
      inspectLines(text, false);
    });

    child.stderr.on("data", (chunk) => {
      if (settled) return;
      const now = Date.now();
      lastActivityAt = now;
      const text = chunk.toString("utf8");
      handleStreamChunk(chunk, text, stderrRedraw, now);
      inspectLines(text, true);
    });

    child.on("error", (err) => {
      childClosed = true;
      if (settled) return;
      flushAllPendingRedraws();
      const msg = `[harness-watchdog] Failed to start command: ${err.message}\n`;
      emitRawStderr(Buffer.from(msg, "utf8"));
      finish({ exitCode: 127, watchdogTriggered: null });
    });

    child.on("close", (code) => {
      childClosed = true;
      if (settled) return;
      if (forwardedSignal) {
        const signalExitCode = HOST_SIGNAL_EXIT_CODES[forwardedSignal];
        if (!child.pid || !isProcessGroupAlive(child.pid)) {
          flushAllPendingRedraws();
          finish({ exitCode: signalExitCode, watchdogTriggered: null });
        }
        return;
      }
      flushAllPendingRedraws();
      finish({ exitCode: code ?? 1, watchdogTriggered: null });
    });
  });
}

/**
 * Parse `harness watch` arguments:
 * `harness watch --timeout <duration> [--idle-timeout <duration>] [--max-repeat <N>] [--tty | --no-tty] -- <cmd> [args...]`
 */
export function parseWatchArgs(args) {
  const sepIdx = args.indexOf("--");
  const optionArgs = sepIdx !== -1 ? args.slice(0, sepIdx) : [];
  const cmdArgs = sepIdx !== -1 ? args.slice(sepIdx + 1) : args;

  let timeoutRaw = null;
  let idleTimeoutRaw = null;
  let maxRepeatRaw = null;
  let tty = false;
  let noTty = false;

  for (let i = 0; i < optionArgs.length; i++) {
    const arg = optionArgs[i];
    if (arg === "--timeout" && i + 1 < optionArgs.length) {
      timeoutRaw = optionArgs[++i];
    } else if (arg.startsWith("--timeout=")) {
      timeoutRaw = arg.slice("--timeout=".length);
    } else if (arg === "--idle-timeout" && i + 1 < optionArgs.length) {
      idleTimeoutRaw = optionArgs[++i];
    } else if (arg.startsWith("--idle-timeout=")) {
      idleTimeoutRaw = arg.slice("--idle-timeout=".length);
    } else if (arg === "--max-repeat" && i + 1 < optionArgs.length) {
      maxRepeatRaw = optionArgs[++i];
    } else if (arg.startsWith("--max-repeat=")) {
      maxRepeatRaw = arg.slice("--max-repeat=".length);
    } else if (arg === "--tty") {
      tty = true;
      noTty = false;
    } else if (arg === "--no-tty") {
      noTty = true;
      tty = false;
    }
  }

  const wallTimeoutMs = timeoutRaw ? parseDurationMs(timeoutRaw) : null;
  const idleTimeoutMs = idleTimeoutRaw
    ? parseDurationMs(idleTimeoutRaw)
    : DEFAULT_IDLE_TIMEOUT_MS;
  const maxRepeat = maxRepeatRaw ? Number.parseInt(maxRepeatRaw, 10) : DEFAULT_MAX_REPEAT;

  return {
    sepIdx,
    cmdArgs,
    wallTimeoutMs,
    idleTimeoutMs,
    maxRepeat,
    tty,
    noTty,
  };
}

/**
 * CLI entrypoint for `harness watch --timeout <duration> [--idle-timeout <duration>] [--max-repeat <N>] [--tty | --no-tty] -- <cmd> [args...]`
 */
export async function runWatchCli(targetRoot, args) {
  const { sepIdx, cmdArgs, wallTimeoutMs, idleTimeoutMs, maxRepeat, tty, noTty } =
    parseWatchArgs(args);

  if (sepIdx === -1 || !wallTimeoutMs) {
    console.error(
      "Usage: harness watch --timeout <duration> [--idle-timeout 5m] [--max-repeat 100] [--tty] -- <cmd> [args...]\n" +
        "Error: Missing or invalid required --timeout <duration> (e.g. 30s, 5m, 2h) or '--' command separator."
    );
    return 2;
  }

  if (!idleTimeoutMs || idleTimeoutMs <= 0) {
    console.error("Error: Invalid --idle-timeout <duration> (e.g. 5m, 300s).");
    return 2;
  }

  if (!Number.isInteger(maxRepeat) || maxRepeat <= 0) {
    console.error("Error: Invalid --max-repeat <N> (must be a positive integer).");
    return 2;
  }

  if (cmdArgs.length === 0) {
    console.error("Error: Missing command to execute after '--'.");
    return 2;
  }

  const { exitCode } = await runWatchedProcess(targetRoot, cmdArgs, {
    wallTimeoutMs,
    idleTimeoutMs,
    maxRepeat,
    tty,
    noTty,
  });
  return exitCode;
}
