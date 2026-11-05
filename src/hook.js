import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
`;

/**
 * PROP-06: Build normalized PATH covering project-local virtualenvs and multi-language user toolchains.
 */
export function buildNormalizedPath(targetRoot = process.cwd(), basePath = process.env.PATH || "") {
  const home = os.homedir();
  const candidateDirs = [
    path.join(targetRoot, ".venv", "bin"),
    path.join(targetRoot, "node_modules", ".bin"),
  ];
  const commonGitDir = resolveGitCommonDir(targetRoot);
  if (commonGitDir) {
    const mainRepoRoot = path.dirname(commonGitDir);
    if (path.resolve(mainRepoRoot) !== path.resolve(targetRoot)) {
      candidateDirs.push(
        path.join(mainRepoRoot, ".venv", "bin"),
        path.join(mainRepoRoot, "node_modules", ".bin")
      );
    }
  }
  candidateDirs.push(
    path.join(home, ".cargo", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  );
  const existingParts = basePath.split(path.delimiter).filter(Boolean);
  const seen = new Set();
  const merged = [];
  for (const dir of [...candidateDirs, ...existingParts]) {
    if (!seen.has(dir)) {
      seen.add(dir);
      merged.push(dir);
    }
  }
  return merged.join(path.delimiter);
}

export function buildNormalizedEnv(targetRoot = process.cwd(), baseEnv = process.env) {
  return {
    ...baseEnv,
    PATH: buildNormalizedPath(targetRoot, baseEnv.PATH || ""),
  };
}

/**
 * Install Git pre-commit & reference-transaction hooks and/or .agents/hooks.json Stop hook.
 */
export function installHooks(targetRoot = process.cwd(), options = {}) {
  const installGit = options.git || (!options.git && !options.agents);
  const installAgents = options.agents || (!options.git && !options.agents);
  const actions = [];

  if (installGit) {
    const gitDir = resolveGitCommonDir(targetRoot);
    if (gitDir) {
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
      } else if (!existing.includes(PRE_COMMIT_SNIPPET.trim())) {
        const markerIdx = existing.indexOf(PRE_COMMIT_MARKER);
        const prefix = existing.slice(0, markerIdx).trimEnd();
        const header = prefix ? `${prefix}\n\n` : "#!/usr/bin/env sh\nset -e\n\n";
        fs.writeFileSync(preCommitPath, `${header}${PRE_COMMIT_SNIPPET}`, "utf8");
        fs.chmodSync(preCommitPath, 0o755);
        actions.push("updated   .git/hooks/pre-commit");
      } else {
        actions.push("ok        .git/hooks/pre-commit (already installed)");
      }

      const refTxPath = path.join(hooksDir, "reference-transaction");
      let existingRefTx = "";
      if (fs.existsSync(refTxPath)) {
        existingRefTx = fs.readFileSync(refTxPath, "utf8");
      }

      if (!existingRefTx.includes(REF_TX_MARKER)) {
        const header = existingRefTx ? `${existingRefTx.trimEnd()}\n\n` : "#!/usr/bin/env sh\n\n";
        fs.writeFileSync(refTxPath, `${header}${REF_TX_SNIPPET}`, "utf8");
        fs.chmodSync(refTxPath, 0o755);
        actions.push("installed .git/hooks/reference-transaction");
      } else if (!existingRefTx.includes(REF_TX_SNIPPET.trim())) {
        const markerIdx = existingRefTx.indexOf(REF_TX_MARKER);
        const prefix = existingRefTx.slice(0, markerIdx).trimEnd();
        const header = prefix ? `${prefix}\n\n` : "#!/usr/bin/env sh\n\n";
        fs.writeFileSync(refTxPath, `${header}${REF_TX_SNIPPET}`, "utf8");
        fs.chmodSync(refTxPath, 0o755);
        actions.push("updated   .git/hooks/reference-transaction");
      } else {
        actions.push("ok        .git/hooks/reference-transaction (already installed)");
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

function findInPath(binName, targetRoot = process.cwd()) {
  const pathEnv = buildNormalizedPath(targetRoot);
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
  const whichPyrefly = findInPath("pyrefly", targetRoot);
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
 * PROP-10: Collect incrementally modified/added files from Git (`--staged` or `HEAD`).
 * Returns `null` if `targetRoot` is not a Git repository.
 */
export function getChangedFiles(targetRoot = process.cwd(), { staged = false } = {}) {
  if (!fs.existsSync(path.join(targetRoot, ".git"))) {
    return null;
  }
  const files = new Set();
  const addFromZ = (stdout) => {
    if (!stdout) return;
    for (const f of stdout.split("\0")) {
      if (!f) continue;
      const rel = f.split(path.sep).join("/");
      const abs = path.join(targetRoot, rel);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        files.add(rel);
      }
    }
  };

  if (staged) {
    const cached = spawnSync(
      "git",
      ["-c", "core.quotePath=false", "diff", "--name-only", "--cached", "--diff-filter=ACMR", "-z"],
      { cwd: targetRoot, encoding: "utf8", timeout: 5000 }
    );
    if (cached.status === 0) {
      addFromZ(cached.stdout);
      return [...files];
    }
    return null;
  }

  const headDiff = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=ACMR", "HEAD", "-z"],
    { cwd: targetRoot, encoding: "utf8", timeout: 5000 }
  );
  if (headDiff.status === 0) {
    addFromZ(headDiff.stdout);
  }
  const worktreeDiff = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=ACMR", "-z"],
    { cwd: targetRoot, encoding: "utf8", timeout: 5000 }
  );
  if (worktreeDiff.status === 0) {
    addFromZ(worktreeDiff.stdout);
  }
  const cachedDiff = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "diff", "--name-only", "--cached", "--diff-filter=ACMR", "-z"],
    { cwd: targetRoot, encoding: "utf8", timeout: 5000 }
  );
  if (cachedDiff.status === 0) {
    addFromZ(cachedDiff.stdout);
  }
  const untracked = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: targetRoot, encoding: "utf8", timeout: 5000 }
  );
  if (untracked.status === 0) {
    addFromZ(untracked.stdout);
  }
  return [...files];
}

/**
 * Run zero-tolerance static type, linter, and incremental formatting checks
 * (Pyright, Pyrefly, Ruff, Ruff Format, ESLint, Prettier, TypeScript) if configured in targetRoot.
 */
export function checkStaticTypes(targetRoot = process.cwd(), options = {}) {
  const { staged = false } = options;
  const issues = [];
  let errorCount = 0;
  let warningCount = 0;
  const childEnv = buildNormalizedEnv(targetRoot);
  const changedFiles = getChangedFiles(targetRoot, { staged });

  const hasPyproject = fs.existsSync(path.join(targetRoot, "pyproject.toml"));
  const hasPyrightConfig = fs.existsSync(path.join(targetRoot, "pyrightconfig.json"));
  const hasRuffConfig =
    fs.existsSync(path.join(targetRoot, "ruff.toml")) ||
    fs.existsSync(path.join(targetRoot, ".ruff.toml"));
  const venvPyright = path.join(targetRoot, ".venv", "bin", "pyright");
  const venvPython = path.join(targetRoot, ".venv", "bin", "python");
  const venvPyrefly = path.join(targetRoot, ".venv", "bin", "pyrefly");
  const venvRuff = path.join(targetRoot, ".venv", "bin", "ruff");

  const isPythonProject =
    hasPyproject ||
    hasPyrightConfig ||
    hasRuffConfig ||
    isExecutableFile(venvPyright) ||
    isExecutableFile(venvPyrefly) ||
    isExecutableFile(venvRuff);

  if (isPythonProject) {
    let pyrightCmd = null;
    const uvCandidate =
      findInPath("uv", targetRoot) || path.join(os.homedir(), ".local", "bin", "uv");

    if (isExecutableFile(venvPyright) && isExecutableFile(venvPython)) {
      pyrightCmd = [venvPyright, ["--pythonpath", venvPython, "--outputjson"]];
    } else if (isExecutableFile(venvPyright)) {
      pyrightCmd = [venvPyright, ["--outputjson"]];
    } else if (findInPath("pyright", targetRoot)) {
      pyrightCmd = [findInPath("pyright", targetRoot), ["--outputjson"]];
    } else if (isExecutableFile(uvCandidate)) {
      pyrightCmd = [uvCandidate, ["run", "pyright", "--outputjson"]];
    }

    if (pyrightCmd) {
      try {
        const proc = spawnSync(pyrightCmd[0], pyrightCmd[1], {
          cwd: targetRoot,
          env: childEnv,
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
            env: childEnv,
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

    // Ruff Python Linter & Incremental Format Check (PROP-10)
    const ruffBin = isExecutableFile(venvRuff)
      ? venvRuff
      : findInPath("ruff", targetRoot);
    if (ruffBin) {
      const changedPyFiles = Array.isArray(changedFiles)
        ? changedFiles.filter((f) => /\.pyi?$/i.test(f))
        : null;
      const shouldRunRuff = changedPyFiles === null || !staged || changedPyFiles.length > 0;

      if (shouldRunRuff) {
        const ruffCheckArgs =
          Array.isArray(changedPyFiles) && changedPyFiles.length > 0
            ? ["check", "--output-format=json", ...changedPyFiles]
            : ["check", "--output-format=json"];
        try {
          const procRuff = spawnSync(ruffBin, ruffCheckArgs, {
            cwd: targetRoot,
            env: childEnv,
            encoding: "utf8",
            timeout: 15000,
          });
          if (procRuff.stdout) {
            const ruffReport = JSON.parse(procRuff.stdout);
            const ruffItems = Array.isArray(ruffReport) ? ruffReport : [];
            for (const item of ruffItems.slice(0, 30)) {
              if (!item || typeof item !== "object") continue;
              errorCount += 1;
              const rawFile = String(item.filename || "");
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
              const loc =
                item.location && typeof item.location === "object"
                  ? item.location
                  : {};
              const lineNo = Number(loc.row || 1);
              const colNo = Number(loc.column || 1);
              const code = String(item.code || "");
              const codeSuffix = code ? ` (${code})` : "";
              const msg = String(item.message || "").replace(/\r?\n/g, " ");
              issues.push(
                `- [ruff] ${relPath}:${lineNo}:${colNo} [error]${codeSuffix} ${msg}`
              );
            }
          }
        } catch {
          // Ignore if ruff execution fails to return JSON
        }
      }

      // Incremental ruff format --check on changed Python files (PROP-10)
      const fmtTargets =
        Array.isArray(changedPyFiles) && changedPyFiles.length > 0
          ? changedPyFiles
          : changedPyFiles === null
          ? ["."]
          : [];
      if (fmtTargets.length > 0) {
        try {
          const procRuffFmt = spawnSync(
            ruffBin,
            ["format", "--check", ...fmtTargets],
            {
              cwd: targetRoot,
              env: childEnv,
              encoding: "utf8",
              timeout: 15000,
            }
          );
          if (procRuffFmt.status !== 0) {
            const combinedOut = `${procRuffFmt.stdout || ""}\n${procRuffFmt.stderr || ""}`;
            const reformatMatches = [];
            for (const line of combinedOut.split(/\r?\n/)) {
              const m = line.match(/^Would reformat:\s*(.+)$/i);
              if (m && m[1]) {
                reformatMatches.push(m[1].trim());
              }
            }
            if (reformatMatches.length === 0) {
              for (const f of fmtTargets.slice(0, 30)) {
                errorCount += 1;
                issues.push(
                  `- [ruff-format] ${f}:1:1 [error] File is not formatted; run \`ruff format ${f}\`.`
                );
              }
            } else {
              for (const unformattedFile of reformatMatches.slice(0, 30)) {
                errorCount += 1;
                issues.push(
                  `- [ruff-format] ${unformattedFile}:1:1 [error] File is not formatted; run \`ruff format ${unformattedFile}\`.`
                );
              }
            }
          }
        } catch {
          // Ignore ruff format invocation errors
        }
      }
    }
  }

  // ESLint JS/TS Linter check (if eslint config exists)
  const eslintConfigFiles = [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yaml",
    ".eslintrc.yml",
  ];
  const hasEslintConfig = eslintConfigFiles.some((f) =>
    fs.existsSync(path.join(targetRoot, f))
  );
  if (hasEslintConfig) {
    const localEslint = path.join(targetRoot, "node_modules", ".bin", "eslint");
    const eslintBin = isExecutableFile(localEslint)
      ? localEslint
      : findInPath("eslint", targetRoot);
    if (eslintBin) {
      const changedJsTsFiles = Array.isArray(changedFiles)
        ? changedFiles.filter((f) => /\.(?:[jt]sx?|[mc]?js)$/i.test(f))
        : null;
      const shouldRunEslint =
        changedJsTsFiles === null || !staged || changedJsTsFiles.length > 0;

      if (shouldRunEslint) {
        const eslintArgs =
          Array.isArray(changedJsTsFiles) && changedJsTsFiles.length > 0
            ? [...changedJsTsFiles, "--format=json"]
            : [".", "--format=json"];
        try {
          const procEslint = spawnSync(eslintBin, eslintArgs, {
            cwd: targetRoot,
            env: childEnv,
            encoding: "utf8",
            timeout: 25000,
          });
          if (procEslint.stdout) {
            const eslintReport = JSON.parse(procEslint.stdout);
            const filesList = Array.isArray(eslintReport) ? eslintReport : [];
            for (const fileEntry of filesList) {
              if (!fileEntry || typeof fileEntry !== "object") continue;
              const rawFile = String(fileEntry.filePath || "");
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
              const messages = Array.isArray(fileEntry.messages)
                ? fileEntry.messages
                : [];
              for (const m of messages.slice(0, 30)) {
                if (!m || typeof m !== "object") continue;
                const sevNum = Number(m.severity || 1);
                if (sevNum < 1) continue;
                const sev = sevNum >= 2 ? "error" : "warning";
                if (sev === "error") {
                  errorCount += 1;
                } else {
                  warningCount += 1;
                }
                const lineNo = Number(m.line || 1);
                const colNo = Number(m.column || 1);
                const ruleId = String(m.ruleId || "");
                const ruleSuffix = ruleId ? ` (${ruleId})` : "";
                const msg = String(m.message || "").replace(/\r?\n/g, " ");
                issues.push(
                  `- [eslint] ${relPath}:${lineNo}:${colNo} [${sev}]${ruleSuffix} ${msg}`
                );
              }
            }
          }
        } catch {
          // Ignore if eslint execution fails to return JSON
        }
      }
    }
  }

  // Prettier incremental format check (PROP-10, if Prettier config exists)
  const prettierConfigFiles = [
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.js",
    ".prettierrc.cjs",
    ".prettierrc.mjs",
    ".prettierrc.yaml",
    ".prettierrc.yml",
    "prettier.config.js",
    "prettier.config.mjs",
    "prettier.config.cjs",
  ];
  let hasPrettierConfig = prettierConfigFiles.some((f) =>
    fs.existsSync(path.join(targetRoot, f))
  );
  if (!hasPrettierConfig && fs.existsSync(path.join(targetRoot, "package.json"))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(targetRoot, "package.json"), "utf8"));
      if (pkg && typeof pkg === "object" && pkg.prettier) {
        hasPrettierConfig = true;
      }
    } catch {
      // Ignore malformed package.json
    }
  }
  if (hasPrettierConfig) {
    const localPrettier = path.join(targetRoot, "node_modules", ".bin", "prettier");
    const prettierBin = isExecutableFile(localPrettier)
      ? localPrettier
      : findInPath("prettier", targetRoot);
    if (prettierBin) {
      const changedPrettierFiles = Array.isArray(changedFiles)
        ? changedFiles.filter((f) =>
            /\.(?:[jt]sx?|[mc]?js|json|css|scss|html|ya?ml)$/i.test(f)
          )
        : ["."];
      if (changedPrettierFiles.length > 0) {
        try {
          const procPrettier = spawnSync(
            prettierBin,
            ["--check", ...changedPrettierFiles],
            {
              cwd: targetRoot,
              env: childEnv,
              encoding: "utf8",
              timeout: 15000,
            }
          );
          if (procPrettier.status !== 0) {
            const out = `${procPrettier.stdout || ""}\n${procPrettier.stderr || ""}`;
            let matchedAny = false;
            for (const line of out.split(/\r?\n/)) {
              const warnMatch = line.match(/^\[warn\]\s+(.+)$/);
              if (
                warnMatch &&
                warnMatch[1] &&
                !warnMatch[1].startsWith("Code style issues")
              ) {
                const fileStr = warnMatch[1].trim();
                matchedAny = true;
                errorCount += 1;
                issues.push(
                  `- [prettier] ${fileStr}:1:1 [error] File is not formatted; run \`prettier --write ${fileStr}\`.`
                );
              }
            }
            if (!matchedAny) {
              for (const f of changedPrettierFiles.slice(0, 30)) {
                errorCount += 1;
                issues.push(
                  `- [prettier] ${f}:1:1 [error] File is not formatted; run \`prettier --write ${f}\`.`
                );
              }
            }
          }
        } catch {
          // Ignore prettier execution failure
        }
      }
    }
  }

  // TypeScript project static check (if tsconfig.json exists)
  const tsconfigPath = path.join(targetRoot, "tsconfig.json");
  if (fs.existsSync(tsconfigPath)) {
    const localTsc = path.join(targetRoot, "node_modules", ".bin", "tsc");
    const tscBin = isExecutableFile(localTsc)
      ? localTsc
      : findInPath("tsc", targetRoot);
    if (tscBin) {
      try {
        const procTsc = spawnSync(tscBin, ["--noEmit", "--pretty", "false"], {
          cwd: targetRoot,
          env: childEnv,
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
