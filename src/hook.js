import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { checkStaticTypes } from "./hook-checks.js";
import { updateHookScript } from "./hook-script.js";
import {
  isReadOnlyAgentTurn,
  unwrapTranscriptString,
  loadVerifyCache,
  saveVerifyCache,
  computeWorkspaceDigest,
  computePreSignedNextCommitDigest,
  computeTranscriptCursorSnapshot,
} from "./hook-tools.js";
import { parseDurationMs } from "./watch.js";
import { checkWorkspace, restoreProtectedMatrices } from "./doctor.js";
import {
  cleanSandboxes,
  ensureWorktreeSharedPaths,
  resolveGitCommonDir,
} from "./clean.js";

export const HOOK_PATH_EXPORT =
  'export PATH="$PWD/.venv/bin:$PWD/node_modules/.bin:$HOME/.cargo/bin:$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"';

const PRE_COMMIT_MARKER = "# yoryon-harness pre-commit hook";
const PRE_COMMIT_SNIPPET = `${PRE_COMMIT_MARKER}
${HOOK_PATH_EXPORT}
if command -v harness >/dev/null 2>&1; then
  harness hook run --staged
elif [ -f "./bin/harness.js" ]; then
  node ./bin/harness.js hook run --staged
fi
# end yoryon-harness pre-commit hook
`;

const REF_TX_MARKER = "# yoryon-harness reference-transaction hook";
const REF_TX_SNIPPET = `${REF_TX_MARKER}
${HOOK_PATH_EXPORT}
if [ "$1" = "committed" ]; then
  if command -v harness >/dev/null 2>&1; then
    harness clean --worktrees --quiet >/dev/null 2>&1 || true
  elif [ -f "./bin/harness.js" ]; then
    node ./bin/harness.js clean --worktrees --quiet >/dev/null 2>&1 || true
  fi
fi
# end yoryon-harness reference-transaction hook
`;

/**
 * Resolve the Git hooks directory for a repository root, linked worktree, or submodule
 * via `git rev-parse --git-path hooks` (which also honors `core.hooksPath`).
 */
export function resolveGitHooksDir(targetRoot = process.cwd()) {
  const dotGit = path.join(targetRoot, ".git");
  if (!fs.existsSync(dotGit)) {
    return null;
  }
  try {
    const proc = spawnSync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd: targetRoot,
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(targetRoot)),
      },
    });
    if (proc.status === 0 && proc.stdout && proc.stdout.trim()) {
      return path.resolve(targetRoot, proc.stdout.trim());
    }
  } catch {
    // Fallback below
  }
  const commonGitDir = resolveGitCommonDir(targetRoot);
  return commonGitDir ? path.join(commonGitDir, "hooks") : null;
}

function parseGitHubRepoSlug(remoteUrl) {
  if (typeof remoteUrl !== "string" || !remoteUrl.trim()) {
    return null;
  }
  const match = remoteUrl
    .trim()
    .match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!match || !match[1] || !match[2]) {
    return null;
  }
  return `${match[1]}/${match[2]}`;
}

function syncGitHubDeleteBranchOnMerge(targetRoot, actions) {
  const gitEnv = {
    ...process.env,
    GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(targetRoot)),
  };
  const remoteProc = spawnSync("git", ["config", "--get", "remote.origin.url"], {
    cwd: targetRoot,
    encoding: "utf8",
    timeout: 5000,
    env: gitEnv,
  });
  const remoteUrl = remoteProc.status === 0 && remoteProc.stdout ? remoteProc.stdout.trim() : "";
  const repoSlug = parseGitHubRepoSlug(remoteUrl);

  if (!repoSlug) {
    actions.push(
      "tip       (optional) To auto-delete merged PR branches on GitHub, run: gh repo edit <owner>/<repo> --delete-branch-on-merge"
    );
    return;
  }

  const cachedProc = spawnSync(
    "git",
    ["config", "--local", "--get", "harness.ghDeleteBranchOnMerge"],
    {
      cwd: targetRoot,
      encoding: "utf8",
      timeout: 5000,
      env: gitEnv,
    }
  );
  if (cachedProc.status === 0 && cachedProc.stdout && cachedProc.stdout.trim() === repoSlug) {
    actions.push(`ok        GitHub deleteBranchOnMerge (${repoSlug})`);
    return;
  }

  const ghProc = spawnSync("gh", ["repo", "edit", repoSlug, "--delete-branch-on-merge"], {
    cwd: targetRoot,
    encoding: "utf8",
    timeout: 10000,
  });

  if (ghProc.status === 0) {
    spawnSync("git", ["config", "--local", "harness.ghDeleteBranchOnMerge", repoSlug], {
      cwd: targetRoot,
      encoding: "utf8",
      timeout: 5000,
      env: gitEnv,
    });
    actions.push(`enabled   GitHub deleteBranchOnMerge (${repoSlug})`);
    return;
  }

  const errDetail = (
    ghProc.stderr ||
    ghProc.stdout ||
    (ghProc.error && ghProc.error.message) ||
    ""
  )
    .trim()
    .split(/\r?\n/)[0];
  actions.push(
    `tip       (optional) Could not auto-enable GitHub deleteBranchOnMerge (${repoSlug}${
      errDetail ? `: ${errDetail}` : ""
    }); to enable manually, run: gh repo edit ${repoSlug} --delete-branch-on-merge`
  );
}

/**
 * Install Git pre-commit & reference-transaction hooks and/or .agents/hooks.json Stop hook.
 */
export function installHooks(targetRoot = process.cwd(), options = {}) {
  const installGit = options.git || (!options.git && !options.agents);
  const installAgents = options.agents || (!options.git && !options.agents);
  const actions = [];

  if (installGit) {
    const hooksDir = resolveGitHooksDir(targetRoot);
    if (hooksDir) {
      fs.mkdirSync(hooksDir, { recursive: true });
      const definitions = [
        ["pre-commit", PRE_COMMIT_MARKER, PRE_COMMIT_SNIPPET, "#!/usr/bin/env sh\nset -e\n"],
        ["reference-transaction", REF_TX_MARKER, REF_TX_SNIPPET, "#!/usr/bin/env sh\n"],
      ];
      let updates;
      try {
        // Validate both scripts before changing either one.
        updates = definitions.map(([name, marker, snippet, header]) => {
          const file = path.join(hooksDir, name);
          const exists = fs.existsSync(file);
          const existing = exists ? fs.readFileSync(file, "utf8") : header;
          return { name, file, exists, existing, content: updateHookScript(existing, marker, snippet) };
        });
      } catch (error) {
        console.error(error.message);
        return 1;
      }
      for (const { file, exists, existing, content } of updates) {
        if (!exists || content !== existing) fs.writeFileSync(file, content, "utf8");
        fs.chmodSync(file, 0o755);
        actions.push(`${!exists ? "installed" : content === existing ? "ok       " : "updated  "} ${file}`);
      }
      spawnSync("git", ["config", "--local", "fetch.prune", "true"], {
        cwd: targetRoot,
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env,
          GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(targetRoot)),
        },
      });
      actions.push("configured git config --local fetch.prune=true");
      syncGitHubDeleteBranchOnMerge(targetRoot, actions);
    } else if (options.git) {
      console.error("No .git directory found in current workspace. Run `git init` first.");
      return 1;
    }
  }

  if (installAgents) {
    const agentsDir = path.join(targetRoot, ".agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    const hooksPath = path.join(agentsDir, "hooks.json");

    let hooksConfig = {};
    if (fs.existsSync(hooksPath)) {
      try {
        hooksConfig = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
      } catch {
        hooksConfig = {};
      }
    }

    const stopHookCommand = "harness hook run --agent";
    const preToolHookCommand = "harness hook pre-tool";
    const existingRule = hooksConfig["harness-doctor-guard"];
    const hasStop =
      existingRule &&
      Array.isArray(existingRule.Stop) &&
      existingRule.Stop.some((h) => h.command === stopHookCommand);
    const hasPreTool =
      existingRule &&
      Array.isArray(existingRule.PreToolUse) &&
      existingRule.PreToolUse.some(
        (entry) =>
          entry.matcher === "run_command" &&
          Array.isArray(entry.hooks) &&
          entry.hooks.some((h) => h.command === preToolHookCommand)
      );

    if (!hasStop || !hasPreTool) {
      hooksConfig["harness-doctor-guard"] = {
        enabled: true,
        PreToolUse: [
          {
            matcher: "run_command",
            hooks: [
              {
                type: "command",
                command: preToolHookCommand,
                timeout: 10,
              },
            ],
          },
        ],
        Stop: [
          {
            type: "command",
            command: stopHookCommand,
            timeout: 30,
          },
        ],
      };
      fs.writeFileSync(hooksPath, JSON.stringify(hooksConfig, null, 2) + "\n", "utf8");
      actions.push(
        "installed .agents/hooks.json (PreToolUse -> `harness hook pre-tool`, Stop -> `harness hook run --agent`)"
      );
    } else {
      actions.push("ok        .agents/hooks.json (already configured)");
    }
  }

  console.log(`Harness hooks configured in ${targetRoot}:`);
  for (const a of actions) {
    console.log(`  ${a}`);
  }
  return 0;
}

/**
 * Execute hook check (`harness hook run [--agent] [--staged] [--no-cache] [--full]`).
 * - `--agent` (Stop hook): Lightweight structural & anti-cheat guard only (`doctor` + `MTX001` auto-revert,
 *   skipping heavy static typecheckers so TDD Red Phase & mid-work turns are never blocked by `pyright`/`tsc`),
 *   short-circuiting on read-only turns and `<git-dir>/harness-verify-cache.json` hits.
 * - `--staged` (`pre-commit`) / default: Runs `doctor` + change-aware concurrent `checkStaticTypes`,
 *   and pre-signs `nextHeadTree` into `<git-dir>/harness-verify-cache.json` via `git write-tree`.
 */
export async function runHook(
  targetRoot = process.cwd(),
  { agentMode = false, staged = false, noCache = false, full = false } = {}
) {
  const bypassCache = Boolean(noCache || process.env.HARNESS_NO_CACHE === "1");
  let payload = {};
  const cacheState = loadVerifyCache(targetRoot);

  if (agentMode && !process.stdin.isTTY) {
    try {
      const rawStdin = fs.readFileSync(0, "utf8").trim();
      if (rawStdin) {
        const parsed = JSON.parse(rawStdin);
        if (parsed && typeof parsed === "object") {
          payload = parsed;
        }
      }
    } catch {
      payload = {};
    }

    const terminationReason = String(
      payload.terminationReason || "NO_TOOL_CALL"
    );
    // Only block stop on normal turn completion; never trap user cancellations or hard limits.
    if (terminationReason !== "NO_TOOL_CALL") {
      console.log(JSON.stringify({ decision: "stop" }));
      return 0;
    }

    // Skip hook checks and cleanup when the current turn (or slice after lastPassedStepIndex) only performed read-only operations.
    if (isReadOnlyAgentTurn(payload, { cacheState })) {
      console.log(JSON.stringify({ decision: "stop" }));
      return 0;
    }
  }

  const wsState = computeWorkspaceDigest(targetRoot);

  if (!bypassCache && wsState) {
    if (agentMode) {
      const isDoctorVerified =
        cacheState.doctorDigests.includes(wsState.digest) ||
        cacheState.fullDigests.includes(wsState.digest);
      if (isDoctorVerified) {
        if (payload && typeof payload.transcriptPath === "string") {
          const cursorSnap = computeTranscriptCursorSnapshot(payload.transcriptPath);
          if (cursorSnap) {
            cacheState.stopCursors[cursorSnap.key] = cursorSnap.entry;
            saveVerifyCache(targetRoot, cacheState);
          }
        }
        console.log(JSON.stringify({ decision: "stop" }));
        return 0;
      }
    } else if (!full && cacheState.fullDigests.includes(wsState.digest)) {
      if (staged) {
        const preSigned = computePreSignedNextCommitDigest(targetRoot, wsState.cliSalt);
        if (preSigned) {
          cacheState.doctorDigests.push(preSigned.digest);
          if (!preSigned.hasUntracked) {
            cacheState.fullDigests.push(preSigned.digest);
          }
          saveVerifyCache(targetRoot, cacheState);
        }
      }
      return 0;
    }
  }

  try {
    ensureWorktreeSharedPaths(targetRoot);
    cleanSandboxes(targetRoot, { quiet: true, silent: agentMode });
  } catch {
    // Non-fatal: never block hook execution if sandbox cleanup encounters transient FS error
  }

  let diagnostics;
  let typecheck;

  if (agentMode) {
    diagnostics = checkWorkspace(targetRoot);
    typecheck = { issues: [], errorCount: 0, warningCount: 0 };
  } else {
    [diagnostics, typecheck] = await Promise.all([
      Promise.resolve().then(() => checkWorkspace(targetRoot)),
      checkStaticTypes(targetRoot, { staged, full }),
    ]);
  }

  // PROP-02: If protected matrices were tampered with, automatically revert immutable cells from HEAD
  if (diagnostics.some((d) => d.code === "MTX001")) {
    try {
      const { restoredFiles } = restoreProtectedMatrices(targetRoot);
      if (restoredFiles.length > 0) {
        for (const d of diagnostics) {
          if (d.code === "MTX001") {
            d.message += " [Auto-reverted immutable cell(s) from HEAD]";
          }
        }
      }
    } catch {
      // Ignore auto-revert failure
    }
  }

  const hasTypeIssues =
    typecheck.issues.length > 0 ||
    typecheck.errorCount > 0 ||
    typecheck.warningCount > 0;

  if (diagnostics.length === 0 && !hasTypeIssues) {
    if (wsState) {
      cacheState.doctorDigests.push(wsState.digest);
      if (!agentMode && !staged) {
        cacheState.fullDigests.push(wsState.digest);
      }
      if (!agentMode && staged) {
        const preSigned = computePreSignedNextCommitDigest(targetRoot, wsState.cliSalt);
        if (preSigned) {
          cacheState.doctorDigests.push(preSigned.digest);
          if (!preSigned.hasUntracked) {
            cacheState.fullDigests.push(preSigned.digest);
          }
        }
      }
      if (agentMode && payload && typeof payload.transcriptPath === "string") {
        const cursorSnap = computeTranscriptCursorSnapshot(payload.transcriptPath);
        if (cursorSnap) {
          cacheState.stopCursors[cursorSnap.key] = cursorSnap.entry;
        }
      }
      saveVerifyCache(targetRoot, cacheState);
    }

    if (agentMode) {
      console.log(JSON.stringify({ decision: "stop" }));
    }
    return 0;
  }

  const sections = [];

  if (diagnostics.length > 0) {
    const docLines = [
      `[harness hook] 检测到 ${diagnostics.length} 处文档结构、测试契约或死链违规，请立即按以下提示自动修复：`,
      "",
    ];
    for (const d of diagnostics) {
      docLines.push(`${d.file}:${d.line} [${d.code}] ${d.message}`);
      if (d.fix) {
        docLines.push(`  fix: ${d.fix}`);
      }
    }
    docLines.push(
      "",
      "tip: 可运行 `harness rule <CODE>` 查看规则说明；若确属合理破例，可在 Markdown 中添加 `<!-- harness-ignore <CODE>: 原因 -->`（或在测试文件中添加 `# harness-ignore <CODE>: 原因`）豁免。"
    );
    sections.push(docLines.join("\n"));
  }

  if (hasTypeIssues) {
    const typeLines = [
      `[pyright-strict-guard] 检测到 ${typecheck.errorCount} 个错误、${typecheck.warningCount} 个警告（typeCheckingMode = "strict"）。`,
      "请在停止前修复以下所有类型检查问题，并运行 `uv run pyright` 确认错误与警告全部清零：",
      "",
      ...typecheck.issues,
    ];
    sections.push(typeLines.join("\n"));
  }

  const message = sections.join("\n\n");

  if (agentMode) {
    console.log(JSON.stringify({ decision: "continue", reason: message }));
    console.error(message);
    return 2;
  }

  console.error(message);
  return 1;
}

const POLLING_LOOP_PATTERNS = [
  /\bwhile\s+(?:true|1|:)\b/i,
  /\bwhile\s+True\s*:/,
  /\bfor\s*\(\(\s*;\s*;\s*\)\)/,
];

function hasValidWatchdogWrapper(cmdLine) {
  const trimmed = cmdLine.trim();
  const match = trimmed.match(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:node\s+\S*harness\.js|(?:\/\S+\/)?(?:yoryon-)?harness)\s+(?:watch|run\s+\S+)\s+([\s\S]+)$/
  );
  if (!match) return false;
  const rest = match[1];
  const dashDashMatch = rest.match(/^(.*?)\s*--\s+(\S[\s\S]*)$/);
  if (!dashDashMatch) return false;
  const flagsPart = dashDashMatch[1];
  const timeoutMatch = flagsPart.match(/(?:^|\s)--timeout(?:=|\s+)(\S+)/);
  if (!timeoutMatch) return false;
  const durationMs = parseDurationMs(timeoutMatch[1]);
  return Boolean(durationMs && durationMs > 0);
}

/**
 * Execute Antigravity `PreToolUse` hook (`harness hook pre-tool`).
 * Enforces that every non-daemon `run_command` is invoked via
 * `harness watch --timeout <duration> -- <cmd>` and contains no handwritten infinite polling loops.
 */
export function runPreToolHook() {
  let payload = {};
  if (!process.stdin.isTTY) {
    try {
      const rawStdin = fs.readFileSync(0, "utf8").trim();
      if (rawStdin) {
        const parsed = JSON.parse(rawStdin);
        if (parsed && typeof parsed === "object") {
          payload = parsed;
        }
      }
    } catch {
      payload = {};
    }
  }

  const toolCall = payload.toolCall && typeof payload.toolCall === "object" ? payload.toolCall : {};
  const toolName = unwrapTranscriptString(String(toolCall.name || ""));
  if (toolName && toolName !== "run_command") {
    console.log(JSON.stringify({ decision: "allow" }));
    return 0;
  }

  const args = toolCall.args && typeof toolCall.args === "object" ? toolCall.args : {};
  const isDaemon = args.IsDaemon === true || unwrapTranscriptString(String(args.IsDaemon || "")) === "true";
  if (isDaemon) {
    console.log(JSON.stringify({ decision: "allow" }));
    return 0;
  }

  const cmdLine = unwrapTranscriptString(String(args.CommandLine ?? args.commandLine ?? ""));
  if (!cmdLine) {
    console.log(JSON.stringify({ decision: "allow" }));
    return 0;
  }

  for (const pattern of POLLING_LOOP_PATTERNS) {
    if (pattern.test(cmdLine)) {
      console.log(
        JSON.stringify({
          decision: "deny",
          reason:
            "[harness-watchdog] 严禁在命令中编写 while true / for ((;;)) 等死循环轮询逻辑。" +
            "长耗时命令请设置 WaitMsBeforeAsync=500 转为后台任务等待系统自动唤醒，或使用内置 schedule 工具。",
        })
      );
      return 0;
    }
  }

  if (!hasValidWatchdogWrapper(cmdLine)) {
    console.log(
      JSON.stringify({
        decision: "deny",
        reason:
          "[harness-watchdog] 每次执行命令必须显式设置超时上限与看门狗！请一律使用格式：" +
          "`harness watch --timeout <30s|5m|2h> [--idle-timeout 5m] [--max-repeat 100] -- <cmd>`。",
      })
    );
    return 0;
  }

  console.log(JSON.stringify({ decision: "allow" }));
  return 0;
}
