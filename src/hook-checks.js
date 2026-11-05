import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildNormalizedEnv, getChangedFiles, isExecutableFile, findInPath, findPyrefly } from "./hook-tools.js";

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

