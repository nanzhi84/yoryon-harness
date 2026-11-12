import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  buildNormalizedEnv,
  getWorkspaceChanges,
  isExecutableFile,
  findInPath,
  findPyrefly,
} from "./hook-tools.js";

const PYTHON_TYPE_TRIGGER_RE =
  /(?:\.pyi?$|(?:^|\/)(?:pyproject\.toml|pyrightconfig\.json|mypy\.ini|pyrefly\.toml|uv\.lock|poetry\.lock|Pipfile(?:\.lock)?|requirements[^/]*\.txt|setup\.py|setup\.cfg))$/i;
const RUFF_CONFIG_RE = /(?:^|\/)(?:ruff\.toml|\.ruff\.toml|pyproject\.toml)$/i;
const ESLINT_CONFIG_RE =
  /(?:^|\/)(?:eslint\.config\.[mc]?[jt]s|\.eslintrc(?:\.(?:[mc]?js|json|ya?ml))?|package\.json)$/i;
const PRETTIER_CONFIG_RE =
  /(?:^|\/)(?:\.prettierrc(?:\.(?:[mc]?js|json|ya?ml))?|prettier\.config\.[mc]?js)$/i;
const TSC_TRIGGER_RE =
  /(?:\.(?:[mc]?[jt]sx?|d\.ts)$|(?:^|\/)(?:tsconfig(?:\.[^/]+)?\.json|jsconfig\.json|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?))$/i;

function runToolAsync(bin, args, { cwd, env, timeoutMs = 25000 }) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timer = null;
    let child = null;

    const finish = (status) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ status: status ?? 1, stdout, stderr });
    };

    try {
      child = spawn(bin, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish(127);
      return;
    }

    timer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore if exited
      }
      finish(124);
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 1));
  });
}

function toRepoRelativePath(targetRoot, rawFile) {
  const fileStr = String(rawFile || "");
  if (!fileStr) return "";
  try {
    const candidateRel = path.relative(targetRoot, path.resolve(targetRoot, fileStr));
    if (!candidateRel.startsWith("..")) {
      return candidateRel.split(path.sep).join("/");
    }
  } catch {
    // Fall back to rawFile
  }
  return fileStr;
}

/**
 * Run zero-tolerance static type, linter, and incremental formatting checks concurrently
 * (Pyright, explicitly-configured Pyrefly, Ruff, Ruff Format, ESLint, Prettier, TypeScript).
 */
export async function checkStaticTypes(targetRoot = process.cwd(), options = {}) {
  const { staged = false, full = false } = options;
  const childEnv = buildNormalizedEnv(targetRoot);
  const changes = full ? null : getWorkspaceChanges(targetRoot, { staged });
  const isGitIncremental = changes !== null;
  const allTouchedPaths = changes ? changes.allTouchedPaths : null;
  const existingChangedFiles = changes ? changes.existingChangedFiles : null;

  if (isGitIncremental && allTouchedPaths.length === 0) {
    return { issues: [], errorCount: 0, warningCount: 0 };
  }

  const tasks = [];

  const hasPyproject = fs.existsSync(path.join(targetRoot, "pyproject.toml"));
  const hasPyrightConfig = fs.existsSync(path.join(targetRoot, "pyrightconfig.json"));
  const hasPyreflyConfig = fs.existsSync(path.join(targetRoot, "pyrefly.toml"));
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
    hasPyreflyConfig ||
    hasRuffConfig ||
    isExecutableFile(venvPyright) ||
    isExecutableFile(venvPyrefly) ||
    isExecutableFile(venvRuff);

  if (isPythonProject) {
    const shouldRunPythonTypes =
      !isGitIncremental || allTouchedPaths.some((f) => PYTHON_TYPE_TRIGGER_RE.test(f));

    if (shouldRunPythonTypes) {
      let pyrightCmd = null;
      const homeDir = childEnv.HOME || os.homedir();
      const uvCandidate =
        findInPath("uv", targetRoot, childEnv) || path.join(homeDir, ".local", "bin", "uv");
      const pathPyright = findInPath("pyright", targetRoot, childEnv);

      if (isExecutableFile(venvPyright) && isExecutableFile(venvPython)) {
        pyrightCmd = [venvPyright, ["--pythonpath", venvPython, "--outputjson"]];
      } else if (isExecutableFile(venvPyright)) {
        pyrightCmd = [venvPyright, ["--outputjson"]];
      } else if (pathPyright) {
        pyrightCmd = [pathPyright, ["--outputjson"]];
      } else if (isExecutableFile(uvCandidate)) {
        pyrightCmd = [uvCandidate, ["run", "pyright", "--outputjson"]];
      }

      if (pyrightCmd) {
        tasks.push(
          (async () => {
            const localIssues = [];
            let errCnt = 0;
            let warnCnt = 0;
            try {
              const proc = await runToolAsync(pyrightCmd[0], pyrightCmd[1], {
                cwd: targetRoot,
                env: childEnv,
                timeoutMs: 25000,
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
                errCnt += Number(summary.errorCount || 0);
                warnCnt += Number(summary.warningCount || 0);

                for (const d of pyrightIssues.slice(0, 30)) {
                  const relPath = toRepoRelativePath(targetRoot, d.file);
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
                  localIssues.push(
                    `- [pyright] ${relPath}:${lineNo}:${colNo} [${severity}]${ruleSuffix} ${msg}`
                  );
                }
                if (pyrightIssues.length > 30) {
                  localIssues.push(
                    `... 以及其余 ${pyrightIssues.length - 30} 处 pyright 诊断，请运行 \`uv run pyright\` 查看完整列表。`
                  );
                }
              }
            } catch {
              // Ignore if pyright fails to output JSON
            }
            return { issues: localIssues, errorCount: errCnt, warningCount: warnCnt };
          })()
        );
      }

      const pyreflyBin = findPyrefly(targetRoot, childEnv);
      if (pyreflyBin) {
        tasks.push(
          (async () => {
            const localIssues = [];
            let errCnt = 0;
            let warnCnt = 0;
            try {
              const procPf = await runToolAsync(
                pyreflyBin,
                ["check", "--min-severity=warn", "--output-format=json"],
                {
                  cwd: targetRoot,
                  env: childEnv,
                  timeoutMs: 15000,
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
                    errCnt += 1;
                  } else {
                    warnCnt += 1;
                  }
                  const pathStr = String(item.path || "");
                  const lineNo = Number(item.line || 1);
                  const colNo = Number(item.column || 1);
                  const name = String(item.name || "");
                  const desc = String(
                    item.concise_description || item.description || ""
                  );
                  localIssues.push(
                    `- [pyrefly] ${pathStr}:${lineNo}:${colNo} [${sev}] (${name}) ${desc}`
                  );
                }
              }
            } catch {
              // Ignore if pyrefly execution fails to return JSON
            }
            return { issues: localIssues, errorCount: errCnt, warningCount: warnCnt };
          })()
        );
      }
    }

    // Ruff Python Linter & Incremental Format Check
    const ruffBin = isExecutableFile(venvRuff)
      ? venvRuff
      : findInPath("ruff", targetRoot, childEnv);
    if (ruffBin) {
      const ruffConfigTouched =
        !isGitIncremental || allTouchedPaths.some((f) => RUFF_CONFIG_RE.test(f));
      const changedPyFiles = isGitIncremental
        ? existingChangedFiles.filter((f) => /\.pyi?$/i.test(f))
        : null;
      const shouldRunRuff =
        !isGitIncremental || ruffConfigTouched || changedPyFiles.length > 0;

      if (shouldRunRuff) {
        const ruffCheckArgs =
          !isGitIncremental || ruffConfigTouched
            ? ["check", "--output-format=json"]
            : ["check", "--output-format=json", ...changedPyFiles];

        tasks.push(
          (async () => {
            const localIssues = [];
            let errCnt = 0;
            try {
              const procRuff = await runToolAsync(ruffBin, ruffCheckArgs, {
                cwd: targetRoot,
                env: childEnv,
                timeoutMs: 15000,
              });
              if (procRuff.stdout) {
                const ruffReport = JSON.parse(procRuff.stdout);
                const ruffItems = Array.isArray(ruffReport) ? ruffReport : [];
                for (const item of ruffItems.slice(0, 30)) {
                  if (!item || typeof item !== "object") continue;
                  errCnt += 1;
                  const relPath = toRepoRelativePath(targetRoot, item.filename);
                  const loc =
                    item.location && typeof item.location === "object"
                      ? item.location
                      : {};
                  const lineNo = Number(loc.row || 1);
                  const colNo = Number(loc.column || 1);
                  const code = String(item.code || "");
                  const codeSuffix = code ? ` (${code})` : "";
                  const msg = String(item.message || "").replace(/\r?\n/g, " ");
                  localIssues.push(
                    `- [ruff] ${relPath}:${lineNo}:${colNo} [error]${codeSuffix} ${msg}`
                  );
                }
              }
            } catch {
              // Ignore if ruff execution fails to return JSON
            }
            return { issues: localIssues, errorCount: errCnt, warningCount: 0 };
          })()
        );

        const fmtTargets =
          !isGitIncremental || ruffConfigTouched ? ["."] : changedPyFiles;
        if (fmtTargets.length > 0) {
          tasks.push(
            (async () => {
              const localIssues = [];
              let errCnt = 0;
              try {
                const procRuffFmt = await runToolAsync(
                  ruffBin,
                  ["format", "--check", ...fmtTargets],
                  {
                    cwd: targetRoot,
                    env: childEnv,
                    timeoutMs: 15000,
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
                  const targets = reformatMatches.length > 0 ? reformatMatches : fmtTargets;
                  for (const unformattedFile of targets.slice(0, 30)) {
                    errCnt += 1;
                    localIssues.push(
                      `- [ruff-format] ${unformattedFile}:1:1 [error] File is not formatted; run \`ruff format ${unformattedFile}\`.`
                    );
                  }
                }
              } catch {
                // Ignore ruff format invocation errors
              }
              return { issues: localIssues, errorCount: errCnt, warningCount: 0 };
            })()
          );
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
      : findInPath("eslint", targetRoot, childEnv);
    if (eslintBin) {
      const eslintConfigTouched =
        !isGitIncremental || allTouchedPaths.some((f) => ESLINT_CONFIG_RE.test(f));
      const changedJsTsFiles = isGitIncremental
        ? existingChangedFiles.filter((f) => /\.(?:[jt]sx?|[mc]?js)$/i.test(f))
        : null;
      const shouldRunEslint =
        !isGitIncremental || eslintConfigTouched || changedJsTsFiles.length > 0;

      if (shouldRunEslint) {
        const eslintArgs =
          !isGitIncremental || (eslintConfigTouched && changedJsTsFiles.length === 0)
            ? [".", "--format=json"]
            : [...changedJsTsFiles, "--format=json"];

        tasks.push(
          (async () => {
            const localIssues = [];
            let errCnt = 0;
            let warnCnt = 0;
            try {
              const procEslint = await runToolAsync(eslintBin, eslintArgs, {
                cwd: targetRoot,
                env: childEnv,
                timeoutMs: 25000,
              });
              if (procEslint.stdout) {
                const eslintReport = JSON.parse(procEslint.stdout);
                const filesList = Array.isArray(eslintReport) ? eslintReport : [];
                for (const fileEntry of filesList) {
                  if (!fileEntry || typeof fileEntry !== "object") continue;
                  const relPath = toRepoRelativePath(targetRoot, fileEntry.filePath);
                  const messages = Array.isArray(fileEntry.messages)
                    ? fileEntry.messages
                    : [];
                  for (const m of messages.slice(0, 30)) {
                    if (!m || typeof m !== "object") continue;
                    const sevNum = Number(m.severity || 1);
                    if (sevNum < 1) continue;
                    const sev = sevNum >= 2 ? "error" : "warning";
                    if (sev === "error") {
                      errCnt += 1;
                    } else {
                      warnCnt += 1;
                    }
                    const lineNo = Number(m.line || 1);
                    const colNo = Number(m.column || 1);
                    const ruleId = String(m.ruleId || "");
                    const ruleSuffix = ruleId ? ` (${ruleId})` : "";
                    const msg = String(m.message || "").replace(/\r?\n/g, " ");
                    localIssues.push(
                      `- [eslint] ${relPath}:${lineNo}:${colNo} [${sev}]${ruleSuffix} ${msg}`
                    );
                  }
                }
              }
            } catch {
              // Ignore if eslint execution fails to return JSON
            }
            return { issues: localIssues, errorCount: errCnt, warningCount: warnCnt };
          })()
        );
      }
    }
  }

  // Prettier incremental format check (if Prettier config exists)
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
      : findInPath("prettier", targetRoot, childEnv);
    if (prettierBin) {
      const prettierConfigTouched =
        !isGitIncremental || allTouchedPaths.some((f) => PRETTIER_CONFIG_RE.test(f));
      const changedPrettierFiles = isGitIncremental
        ? existingChangedFiles.filter((f) =>
            /\.(?:[jt]sx?|[mc]?js|json|css|scss|html|ya?ml)$/i.test(f)
          )
        : ["."];
      const prettierTargets =
        !isGitIncremental || (prettierConfigTouched && changedPrettierFiles.length === 0)
          ? ["."]
          : changedPrettierFiles;

      if (prettierTargets.length > 0) {
        tasks.push(
          (async () => {
            const localIssues = [];
            let errCnt = 0;
            try {
              const procPrettier = await runToolAsync(
                prettierBin,
                ["--check", ...prettierTargets],
                {
                  cwd: targetRoot,
                  env: childEnv,
                  timeoutMs: 15000,
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
                    errCnt += 1;
                    localIssues.push(
                      `- [prettier] ${fileStr}:1:1 [error] File is not formatted; run \`prettier --write ${fileStr}\`.`
                    );
                  }
                }
                if (!matchedAny) {
                  for (const f of prettierTargets.slice(0, 30)) {
                    errCnt += 1;
                    localIssues.push(
                      `- [prettier] ${f}:1:1 [error] File is not formatted; run \`prettier --write ${f}\`.`
                    );
                  }
                }
              }
            } catch {
              // Ignore prettier execution failure
            }
            return { issues: localIssues, errorCount: errCnt, warningCount: 0 };
          })()
        );
      }
    }
  }

  // TypeScript project static check (if tsconfig.json exists)
  const tsconfigPath = path.join(targetRoot, "tsconfig.json");
  if (fs.existsSync(tsconfigPath)) {
    const shouldRunTsc =
      !isGitIncremental || allTouchedPaths.some((f) => TSC_TRIGGER_RE.test(f));
    if (shouldRunTsc) {
      const localTsc = path.join(targetRoot, "node_modules", ".bin", "tsc");
      const tscBin = isExecutableFile(localTsc)
        ? localTsc
        : findInPath("tsc", targetRoot, childEnv);
      if (tscBin) {
        tasks.push(
          (async () => {
            const localIssues = [];
            let errCnt = 0;
            let warnCnt = 0;
            try {
              const procTsc = await runToolAsync(
                tscBin,
                ["--noEmit", "--pretty", "false"],
                {
                  cwd: targetRoot,
                  env: childEnv,
                  timeoutMs: 25000,
                }
              );
              const out = `${procTsc.stdout || ""}\n${procTsc.stderr || ""}`;
              for (const line of out.split(/\r?\n/)) {
                const m = line.match(
                  /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/
                );
                if (m) {
                  const [, fileStr, lineNo, colNo, sev, code, msg] = m;
                  if (sev === "error") {
                    errCnt += 1;
                  } else {
                    warnCnt += 1;
                  }
                  localIssues.push(
                    `- [tsc] ${fileStr}:${lineNo}:${colNo} [${sev}] (${code}) ${msg}`
                  );
                }
              }
            } catch {
              // Ignore transient tsc execution failure
            }
            return { issues: localIssues, errorCount: errCnt, warningCount: warnCnt };
          })()
        );
      }
    }
  }

  const results = await Promise.all(tasks);
  const issues = [];
  let errorCount = 0;
  let warningCount = 0;
  for (const r of results) {
    issues.push(...r.issues);
    errorCount += r.errorCount;
    warningCount += r.warningCount;
  }

  return { issues, errorCount, warningCount };
}
