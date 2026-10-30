import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

function isExecutableFile(filePath) {
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

function findInPath(binName) {
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binName);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

function findPyrefly(targetRoot) {
  const venvPyrefly = path.join(targetRoot, ".venv", "bin", "pyrefly");
  if (isExecutableFile(venvPyrefly)) {
    return venvPyrefly;
  }
  const whichPyrefly = findInPath("pyrefly");
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
 * Run zero-tolerance static type checks (Pyright, Pyrefly, TypeScript) if configured in targetRoot.
 */
export function checkStaticTypes(targetRoot = process.cwd()) {
  const issues = [];
  let errorCount = 0;
  let warningCount = 0;

  const hasPyproject = fs.existsSync(path.join(targetRoot, "pyproject.toml"));
  const hasPyrightConfig = fs.existsSync(path.join(targetRoot, "pyrightconfig.json"));
  const venvPyright = path.join(targetRoot, ".venv", "bin", "pyright");
  const venvPython = path.join(targetRoot, ".venv", "bin", "python");
  const venvPyrefly = path.join(targetRoot, ".venv", "bin", "pyrefly");

  const isPythonProject =
    hasPyproject ||
    hasPyrightConfig ||
    isExecutableFile(venvPyright) ||
    isExecutableFile(venvPyrefly);

  if (isPythonProject) {
    let pyrightCmd = null;
    const uvCandidate =
      findInPath("uv") || path.join(os.homedir(), ".local", "bin", "uv");

    if (isExecutableFile(venvPyright) && isExecutableFile(venvPython)) {
      pyrightCmd = [venvPyright, ["--pythonpath", venvPython, "--outputjson"]];
    } else if (isExecutableFile(venvPyright)) {
      pyrightCmd = [venvPyright, ["--outputjson"]];
    } else if (findInPath("pyright")) {
      pyrightCmd = [findInPath("pyright"), ["--outputjson"]];
    } else if (isExecutableFile(uvCandidate)) {
      pyrightCmd = [uvCandidate, ["run", "pyright", "--outputjson"]];
    }

    if (pyrightCmd) {
      try {
        const proc = spawnSync(pyrightCmd[0], pyrightCmd[1], {
          cwd: targetRoot,
          encoding: "utf8",
          timeout: 25000,
        });
        if (proc.stdout) {
          const report = JSON.parse(proc.stdout);
          const diagnostics = Array.isArray(report.generalDiagnostics)
            ? report.generalDiagnostics
            : [];
          const pyrightIssues = diagnostics.filter(
            (d) =>
              d &&
              typeof d === "object" &&
              (d.severity === "error" || d.severity === "warning")
          );
          const summary =
            report.summary && typeof report.summary === "object"
              ? report.summary
              : {};
          errorCount += Number(summary.errorCount || 0);
          warningCount += Number(summary.warningCount || 0);

          for (const d of pyrightIssues.slice(0, 30)) {
            const rawFile = String(d.file || "");
            let relPath = rawFile;
            if (rawFile) {
              try {
                const candidateRel = path.relative(
                  targetRoot,
                  path.resolve(targetRoot, rawFile)
                );
                if (!candidateRel.startsWith("..")) {
                  relPath = candidateRel.split(path.sep).join("/");
                }
              } catch {
                relPath = rawFile;
              }
            }
            const start =
              d.range && typeof d.range === "object" && d.range.start
                ? d.range.start
                : {};
            const lineNo = Number(start.line ?? 0) + 1;
            const colNo = Number(start.character ?? 0) + 1;
            const severity = String(d.severity || "warning");
            const rule = String(d.rule || "");
            const ruleSuffix = rule ? ` (${rule})` : "";
            const msg = String(d.message || "").replace(/\r?\n/g, " ");
            issues.push(
              `- [pyright] ${relPath}:${lineNo}:${colNo} [${severity}]${ruleSuffix} ${msg}`
            );
          }
          if (pyrightIssues.length > 30) {
            issues.push(
              `... 以及其余 ${pyrightIssues.length - 30} 处 pyright 诊断，请运行 \`uv run pyright\` 查看完整列表。`
            );
          }
        }
      } catch {
        // Ignore if pyright binary is not installed or fails to output JSON
      }
    }

    const pyreflyBin = findPyrefly(targetRoot);
    if (pyreflyBin) {
      try {
        const procPf = spawnSync(
          pyreflyBin,
          ["check", "--min-severity=warn", "--output-format=json"],
          {
            cwd: targetRoot,
            encoding: "utf8",
            timeout: 15000,
          }
        );
        if (procPf.stdout) {
          const pfReport = JSON.parse(procPf.stdout);
          const pfErrors =
            pfReport && Array.isArray(pfReport.errors) ? pfReport.errors : [];
          for (const item of pfErrors.slice(0, 20)) {
            if (!item || typeof item !== "object") continue;
            const sev = String(item.severity || "warn").toLowerCase();
            if (sev === "error") {
              errorCount += 1;
            } else {
              warningCount += 1;
            }
            const pathStr = String(item.path || "");
            const lineNo = Number(item.line || 1);
            const colNo = Number(item.column || 1);
            const name = String(item.name || "");
            const desc = String(
              item.concise_description || item.description || ""
            );
            issues.push(
              `- [pyrefly] ${pathStr}:${lineNo}:${colNo} [${sev}] (${name}) ${desc}`
            );
          }
        }
      } catch {
        // Ignore if pyrefly execution fails to return JSON
      }
    }
  }

  // TypeScript project static check (if tsconfig.json exists)
  const tsconfigPath = path.join(targetRoot, "tsconfig.json");
  if (fs.existsSync(tsconfigPath)) {
    const localTsc = path.join(targetRoot, "node_modules", ".bin", "tsc");
    const tscBin = isExecutableFile(localTsc) ? localTsc : findInPath("tsc");
    if (tscBin) {
      try {
        const procTsc = spawnSync(tscBin, ["--noEmit", "--pretty", "false"], {
          cwd: targetRoot,
          encoding: "utf8",
          timeout: 25000,
        });
        const out = `${procTsc.stdout || ""}\n${procTsc.stderr || ""}`;
        for (const line of out.split(/\r?\n/)) {
          const m = line.match(
            /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/
          );
          if (m) {
            const [, fileStr, lineNo, colNo, sev, code, msg] = m;
            if (sev === "error") {
              errorCount += 1;
            } else {
              warningCount += 1;
            }
            issues.push(
              `- [tsc] ${fileStr}:${lineNo}:${colNo} [${sev}] (${code}) ${msg}`
            );
          }
        }
      } catch {
        // Ignore transient tsc execution failure
      }
    }
  }

  return { issues, errorCount, warningCount };
}

/**
 * Execute hook check (`harness hook run [--agent]`).
 * When `--agent` is set and issues are found, outputs Antigravity Stop hook JSON
 * (`{"decision":"continue","reason":"..."}`) and exits with code 2 so coding agents
 * are blocked from stopping and automatically repair documentation, test contracts, and static type errors.
 */
export function runHook(targetRoot = process.cwd(), { agentMode = false } = {}) {
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
    cleanSandboxes(targetRoot, { quiet: true, silent: agentMode });
  } catch {
    // Non-fatal: never block hook execution if sandbox cleanup encounters transient FS error
  }

  const diagnostics = checkWorkspace(targetRoot);
  const typecheck = checkStaticTypes(targetRoot);
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
