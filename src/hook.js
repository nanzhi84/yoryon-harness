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
 * Install Git pre-commit hook and/or .agents/hooks.json Stop hook.
 */
export function installHooks(targetRoot = process.cwd(), options = {}) {
  const installGit = options.git || (!options.git && !options.agents);
  const installAgents = options.agents || (!options.git && !options.agents);
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
 * Execute hook check (`harness hook run [--agent]`).
 * When `--agent` is set and issues are found, outputs Antigravity Stop hook JSON
 * (`{"decision":"continue","reason":"..."}`) and exits with code 2 so coding agents
 * are blocked from stopping and automatically repair documentation formatting & file placement.
 */
export function runHook(targetRoot = process.cwd(), { agentMode = false } = {}) {
  try {
    cleanSandboxes(targetRoot, { quiet: true });
  } catch {
    // Non-fatal: never block hook execution if sandbox cleanup encounters transient FS error
  }

  const diagnostics = checkWorkspace(targetRoot);
  if (diagnostics.length === 0) {
    if (agentMode) {
      console.log(JSON.stringify({ decision: "stop" }));
    }
    return 0;
  }

  const lines = [
    `[harness hook] 检测到 ${diagnostics.length} 处文档结构、摆放或死链违规，请立即按以下提示自动修复：`,
    "",
  ];
  for (const d of diagnostics) {
    lines.push(`${d.file}:${d.line} [${d.code}] ${d.message}`);
    if (d.fix) {
      lines.push(`  fix: ${d.fix}`);
    }
  }
  lines.push(
    "",
    "tip: 可运行 `harness rule <CODE>` 查看规则说明；若确属合理破例，可在 Markdown 中添加 `<!-- harness-ignore <CODE>: 原因 -->` 豁免。"
  );
  const message = lines.join("\n");

  if (agentMode) {
    console.log(JSON.stringify({ decision: "continue", reason: message }));
    console.error(message);
    return 2;
  }

  console.error(message);
  return 1;
}
