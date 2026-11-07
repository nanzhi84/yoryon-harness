import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { checkStaticTypes } from "./hook-checks.js";
import { updateHookScript } from "./hook-script.js";
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

    const hookCommand = "harness hook run --agent";
    const existingRule = hooksConfig["harness-doctor-guard"];
    const alreadyConfigured =
      existingRule &&
      Array.isArray(existingRule.Stop) &&
      existingRule.Stop.some((h) => h.command === hookCommand);

    if (!alreadyConfigured) {
      hooksConfig["harness-doctor-guard"] = {
        enabled: true,
        Stop: [
          {
            type: "command",
            command: hookCommand,
            timeout: 30,
          },
        ],
      };
      fs.writeFileSync(hooksPath, JSON.stringify(hooksConfig, null, 2) + "\n", "utf8");
      actions.push("installed .agents/hooks.json (Stop hook -> `harness hook run --agent`)");
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
 * Execute hook check (`harness hook run [--agent] [--staged]`).
 * When `--agent` is set and issues are found, outputs Antigravity Stop hook JSON
 * (`{"decision":"continue","reason":"..."}`) and exits with code 2 so coding agents
 * are blocked from stopping and automatically repair documentation, test contracts, and static type errors.
 */
export function runHook(
  targetRoot = process.cwd(),
  { agentMode = false, staged = false } = {}
) {
  if (agentMode && !process.stdin.isTTY) {
    let payload = {};
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
  }

  try {
    ensureWorktreeSharedPaths(targetRoot);
    cleanSandboxes(targetRoot, { quiet: true, silent: agentMode });
  } catch {
    // Non-fatal: never block hook execution if sandbox cleanup encounters transient FS error
  }

  const diagnostics = checkWorkspace(targetRoot);

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

  const typecheck = checkStaticTypes(targetRoot, { staged });
  const hasTypeIssues =
    typecheck.issues.length > 0 ||
    typecheck.errorCount > 0 ||
    typecheck.warningCount > 0;

  if (diagnostics.length === 0 && !hasTypeIssues) {
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
