import fs from "node:fs";
import path from "node:path";
import { checkWorkspace } from "./doctor.js";
import { cleanSandboxes } from "./clean.js";

const PRE_COMMIT_MARKER = "# yoryon-harness pre-commit hook";
const PRE_COMMIT_SNIPPET = `${PRE_COMMIT_MARKER}
if command -v harness >/dev/null 2>&1; then
  harness hook run
elif [ -f "./bin/harness.js" ]; then
  node ./bin/harness.js hook run
fi
`;

/**
 * Install Git pre-commit hook and/or Claude Code agent hook.
 */
export function installHooks(targetRoot = process.cwd(), options = {}) {
  const installGit = options.git || (!options.git && !options.claude);
  const installClaude = options.claude || (!options.git && !options.claude);
  const actions = [];

  if (installGit) {
    const gitDir = path.join(targetRoot, ".git");
    if (fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory()) {
      const hooksDir = path.join(gitDir, "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });
      const preCommitPath = path.join(hooksDir, "pre-commit");

      let existing = "";
      if (fs.existsSync(preCommitPath)) {
        existing = fs.readFileSync(preCommitPath, "utf8");
      }

      if (!existing.includes(PRE_COMMIT_MARKER)) {
        const header = existing ? `${existing.trimEnd()}\n\n` : "#!/usr/bin/env sh\nset -e\n\n";
        fs.writeFileSync(preCommitPath, `${header}${PRE_COMMIT_SNIPPET}`, "utf8");
        fs.chmodSync(preCommitPath, 0o755);
        actions.push("installed .git/hooks/pre-commit");
      } else {
        actions.push("ok        .git/hooks/pre-commit (already installed)");
      }
    } else if (options.git) {
      console.error("No .git directory found in current workspace. Run `git init` first.");
      return 1;
    }
  }

  if (installClaude) {
    const claudeDir = path.join(targetRoot, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");

    let settings = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      } catch {
        settings = {};
      }
    }

    settings.hooks = settings.hooks || {};
    settings.hooks.Stop = settings.hooks.Stop || [];

    const hookCommand = "harness hook run --agent";
    const alreadyConfigured = settings.hooks.Stop.some((entry) =>
      entry.hooks?.some((h) => h.command === hookCommand)
    );

    if (!alreadyConfigured) {
      settings.hooks.Stop.push({
        matcher: "",
        hooks: [
          {
            type: "command",
            command: hookCommand,
          },
        ],
      });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
      actions.push("installed .claude/settings.json (Stop hook -> `harness hook run --agent`)");
    } else {
      actions.push("ok        .claude/settings.json (already configured)");
    }
  }

  console.log(`Harness hooks configured in ${targetRoot}:`);
  for (const a of actions) {
    console.log(`  ${a}`);
  }
  return 0;
}

/**
 * Execute hook check (`harness hook run [--agent]`).
 * When `--agent` is set and issues are found, exits with code 2 and writes actionable
 * instructions to stderr so coding agents (e.g. Claude Code) are blocked from stopping
 * and automatically repair the documentation formatting & file placement.
 */
export function runHook(targetRoot = process.cwd(), { agentMode = false } = {}) {
  try {
    cleanSandboxes(targetRoot, { quiet: true });
  } catch {
    // Non-fatal: never block hook execution if sandbox cleanup encounters transient FS error
  }

  const diagnostics = checkWorkspace(targetRoot);
  if (diagnostics.length === 0) {
    return 0;
  }

  console.error(
    `[harness hook] 检测到 ${diagnostics.length} 处文档结构、摆放或死链违规，请立即按以下提示自动修复：\n`
  );
  for (const d of diagnostics) {
    console.error(`${d.file}:${d.line} [${d.code}] ${d.message}`);
    if (d.fix) {
      console.error(`  fix: ${d.fix}`);
    }
  }
  console.error(
    `\ntip: 可运行 \`harness rule <CODE>\` 查看规则说明；若确属合理破例，可在 Markdown 中添加 \`<!-- harness-ignore <CODE>: 原因 -->\` 豁免。`
  );

  // Exit code 2 signals coding agent hooks (like Claude Code Stop/PostToolUse) to block and feed stderr back to the model
  return agentMode ? 2 : 1;
}
