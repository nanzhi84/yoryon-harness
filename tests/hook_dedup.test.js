import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_BIN = path.join(ROOT, "bin", "harness.js");

function runCli(cwd, args, options = {}) {
  const res = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 15000,
    ...options,
  });
  assert.equal(res.error, undefined, res.error ? String(res.error) : "");
  return res;
}

function runGit(cwd, args, options = {}) {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 15000,
    ...options,
  });
  assert.equal(res.error, undefined, res.error ? String(res.error) : "");
  return res;
}

function runAgentStop(cwd, payload = { terminationReason: "NO_TOOL_CALL" }, extraArgs = [], env = process.env) {
  const res = runCli(cwd, ["hook", "run", "--agent", ...extraArgs], {
    input: JSON.stringify(payload),
    env,
  });
  return {
    status: res.status,
    stdout: res.stdout.trim(),
    stderr: res.stderr.trim(),
    json: res.stdout.trim() ? JSON.parse(res.stdout.trim()) : null,
  };
}

function createGitSandbox(prefix) {
  fs.mkdirSync(path.join(ROOT, "work"), { recursive: true });
  const sandbox = fs.mkdtempSync(path.join(ROOT, "work", `${prefix}repo-`));
  const stateDir = fs.mkdtempSync(path.join(ROOT, "work", `${prefix}state-`));
  const logFile = path.join(stateDir, "invocations.jsonl");

  assert.equal(runGit(sandbox, ["init", "-q"]).status, 0);
  assert.equal(runGit(sandbox, ["config", "user.name", "Harness Test"]).status, 0);
  assert.equal(runGit(sandbox, ["config", "user.email", "test@example.com"]).status, 0);

  const initRes = runCli(sandbox, ["init"]);
  assert.equal(initRes.status, 0, initRes.stderr + initRes.stdout);

  fs.appendFileSync(path.join(sandbox, ".gitignore"), "\n.venv/\nnode_modules/\n", "utf8");
  fs.mkdirSync(path.join(sandbox, ".agents"), { recursive: true });
  fs.writeFileSync(
    path.join(sandbox, ".agents", "harness.json"),
    JSON.stringify(
      {
        rootAllowlist: [
          ".venv",
          "node_modules",
          "config.yaml",
          "pyrefly.toml",
          "tsconfig.json",
          "package.json",
          "eslint.config.js",
          "pyproject.toml",
        ],
      },
      null,
      2
    ),
    "utf8"
  );

  const cleanup = () => {
    fs.rmSync(sandbox, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  };

  return { sandbox, stateDir, logFile, cleanup };
}

function writeExecutable(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}

function installRecorderStub(binDir, binaryName, logFile, mode = "clean") {
  const escapedLog = logFile.replace(/'/g, "'\\''");
  let body = "";

  if (binaryName === "python") {
    body = `#!/bin/sh\nexit 0\n`;
  } else if (binaryName === "pyright") {
    if (mode === "error") {
      body = [
        "#!/bin/sh",
        `printf '%s\\t%s\\n' 'pyright' "$*" >> '${escapedLog}'`,
        `printf '%s\\n' '{"generalDiagnostics":[{"file":"src/app.py","severity":"error","message":"Type mismatch","rule":"reportAssignmentType","range":{"start":{"line":1,"character":0}}}],"summary":{"errorCount":1,"warningCount":0}}'`,
        "exit 1",
        "",
      ].join("\n");
    } else if (mode === "check-helper-exists") {
      body = [
        "#!/bin/sh",
        `printf '%s\\t%s\\n' 'pyright' "$*" >> '${escapedLog}'`,
        "if [ ! -f src/helper.py ]; then",
        `  printf '%s\\n' '{"generalDiagnostics":[{"file":"src/main.py","severity":"error","message":"Import \\"src.helper\\" could not be resolved","rule":"reportMissingImports","range":{"start":{"line":0,"character":5}}}],"summary":{"errorCount":1,"warningCount":0}}'`,
        "  exit 1",
        "fi",
        `printf '%s\\n' '{"generalDiagnostics":[],"summary":{"errorCount":0,"warningCount":0}}'`,
        "exit 0",
        "",
      ].join("\n");
    } else {
      body = [
        "#!/bin/sh",
        `printf '%s\\t%s\\n' 'pyright' "$*" >> '${escapedLog}'`,
        `printf '%s\\n' '{"generalDiagnostics":[],"summary":{"errorCount":0,"warningCount":0}}'`,
        "exit 0",
        "",
      ].join("\n");
    }
  } else if (binaryName === "pyrefly") {
    if (mode === "error") {
      body = [
        "#!/bin/sh",
        `printf '%s\\t%s\\n' 'pyrefly' "$*" >> '${escapedLog}'`,
        `printf '%s\\n' '{"errors":[{"path":"src/a.py","line":1,"column":1,"severity":"error","name":"ide-fallback","concise_description":"Unexpected pyrefly invocation"}]}'`,
        "exit 1",
        "",
      ].join("\n");
    } else {
      body = [
        "#!/bin/sh",
        `printf '%s\\t%s\\n' 'pyrefly' "$*" >> '${escapedLog}'`,
        `printf '%s\\n' '{"errors":[]}'`,
        "exit 0",
        "",
      ].join("\n");
    }
  } else if (binaryName === "ruff") {
    if (mode === "error") {
      body = [
        "#!/bin/sh",
        'if [ "$1" = "format" ]; then',
        `  printf '%s\\t%s\\n' 'ruff-format' "$*" >> '${escapedLog}'`,
        "  exit 0",
        "fi",
        `printf '%s\\t%s\\n' 'ruff-check' "$*" >> '${escapedLog}'`,
        `printf '%s\\n' '[{"code":"F401","filename":"src/app.py","location":{"row":1,"column":1},"message":"unused import"}]'`,
        "exit 1",
        "",
      ].join("\n");
    } else {
      body = [
        "#!/bin/sh",
        'if [ "$1" = "format" ]; then',
        `  printf '%s\\t%s\\n' 'ruff-format' "$*" >> '${escapedLog}'`,
        "  exit 0",
        "fi",
        `printf '%s\\t%s\\n' 'ruff-check' "$*" >> '${escapedLog}'`,
        `printf '%s\\n' '[]'`,
        "exit 0",
        "",
      ].join("\n");
    }
  } else if (binaryName === "eslint") {
    body = [
      "#!/bin/sh",
      `printf '%s\\t%s\\n' 'eslint' "$*" >> '${escapedLog}'`,
      `printf '%s\\n' '[]'`,
      "exit 0",
      "",
    ].join("\n");
  } else if (binaryName === "tsc") {
    body = [
      "#!/bin/sh",
      `printf '%s\\t%s\\n' 'tsc' "$*" >> '${escapedLog}'`,
      "exit 0",
      "",
    ].join("\n");
  } else if (binaryName === "prettier") {
    body = [
      "#!/bin/sh",
      `printf '%s\\t%s\\n' 'prettier' "$*" >> '${escapedLog}'`,
      "exit 0",
      "",
    ].join("\n");
  }

  writeExecutable(path.join(binDir, binaryName), body);
}

function readInvocations(logFile) {
  if (!fs.existsSync(logFile)) {
    return [];
  }
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const tabIdx = line.indexOf("\t");
      if (tabIdx === -1) {
        return { tool: line, args: "" };
      }
      return {
        tool: line.slice(0, tabIdx),
        args: line.slice(tabIdx + 1),
      };
    });
}

function countTool(logFile, toolName) {
  return readInvocations(logFile).filter((entry) => entry.tool === toolName).length;
}

function resetInvocations(logFile) {
  fs.rmSync(logFile, { force: true });
}

function createExpiredWorkMarker(sandbox, name) {
  const dir = path.join(sandbox, "work", name);
  fs.mkdirSync(dir, { recursive: true });
  const past = new Date(Date.now() - 48 * 3600 * 1000);
  fs.utimesSync(dir, past, past);
  return dir;
}

describe("TestPreCommitAndVerifyCache", () => {
  it("test_git_commit_runs_checkers_once_and_presigns_cache_for_stop_hook", () => {
    const { sandbox, logFile, cleanup } = createGitSandbox("v1-presign-");
    try {
      assert.equal(runCli(sandbox, ["hook", "install"]).status, 0);

      fs.writeFileSync(
        path.join(sandbox, "pyproject.toml"),
        '[project]\nname = "demo"\nversion = "0.1.0"\n',
        "utf8"
      );
      fs.mkdirSync(path.join(sandbox, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(sandbox, "src", "app.py"),
        "def add(a: int, b: int) -> int:\n    return a + b\n",
        "utf8"
      );

      const venvBin = path.join(sandbox, ".venv", "bin");
      installRecorderStub(venvBin, "python", logFile, "clean");
      installRecorderStub(venvBin, "pyright", logFile, "clean");
      installRecorderStub(venvBin, "ruff", logFile, "clean");

      assert.equal(runGit(sandbox, ["add", "-A"]).status, 0);
      const initCommit = runGit(sandbox, ["commit", "-m", "chore: initial baseline"]);
      assert.equal(initCommit.status, 0, initCommit.stderr + initCommit.stdout);
      resetInvocations(logFile);

      // Modify Python file and run git add + git commit (triggers pre-commit -> harness hook run --staged)
      fs.writeFileSync(
        path.join(sandbox, "src", "app.py"),
        "def add(a: int, b: int) -> int:\n    return a + b + 1\n",
        "utf8"
      );
      assert.equal(runGit(sandbox, ["add", "."]).status, 0);
      const featCommit = runGit(sandbox, ["commit", "-m", "feat: increment add"]);
      assert.equal(featCommit.status, 0, featCommit.stderr + featCommit.stdout);

      assert.equal(countTool(logFile, "pyright"), 1, "pre-commit must run pyright exactly once");
      assert.equal(countTool(logFile, "ruff-check"), 1, "pre-commit must run ruff check exactly once");
      assert.equal(countTool(logFile, "ruff-format"), 1, "pre-commit must run ruff format --check exactly once");

      const gitDirRel = runGit(sandbox, ["rev-parse", "--git-dir"]).stdout.trim();
      const gitDirAbs = path.resolve(sandbox, gitDirRel);
      const cachePath = path.join(gitDirAbs, "harness-verify-cache.json");
      assert.equal(
        fs.existsSync(cachePath),
        true,
        "pre-commit must write <git-dir>/harness-verify-cache.json"
      );
      assert.equal(
        fs.existsSync(path.join(sandbox, "harness-verify-cache.json")),
        false,
        "verify cache must live inside <git-dir>, never polluting workspace root"
      );

      // Immediately after commit, Stop hook must hit pre-signed tree cache without running pyright/ruff or slow cleanup
      const expiredMarker = createExpiredWorkMarker(sandbox, "expired-post-commit");
      const stopRes = runAgentStop(sandbox, { terminationReason: "NO_TOOL_CALL" });
      assert.equal(stopRes.status, 0, stopRes.stderr + stopRes.stdout);
      assert.deepEqual(stopRes.json, { decision: "stop" });
      assert.equal(countTool(logFile, "pyright"), 1, "Stop hook must not re-run pyright");
      assert.equal(countTool(logFile, "ruff-check"), 1, "Stop hook must not re-run ruff check");
      assert.equal(
        fs.existsSync(expiredMarker),
        true,
        "Stop hook hitting pre-signed cache must fast-return before sandbox TTL sweep"
      );

      // --no-cache must bypass verify cache and execute Stop hook body (while still never invoking pyright)
      const noCacheFlagRes = runAgentStop(
        sandbox,
        { terminationReason: "NO_TOOL_CALL" },
        ["--no-cache"]
      );
      assert.equal(noCacheFlagRes.status, 0);
      assert.deepEqual(noCacheFlagRes.json, { decision: "stop" });
      assert.equal(countTool(logFile, "pyright"), 1, "Stop hook with --no-cache still must not invoke pyright");
      assert.equal(
        fs.existsSync(expiredMarker),
        false,
        "--no-cache must bypass verify cache and run full Stop hook sweep"
      );

      // HARNESS_NO_CACHE=1 must also bypass verify cache
      const expiredMarkerEnv = createExpiredWorkMarker(sandbox, "expired-env-bypass");
      const cachedAgainRes = runAgentStop(sandbox, { terminationReason: "NO_TOOL_CALL" });
      assert.equal(cachedAgainRes.status, 0);
      assert.equal(fs.existsSync(expiredMarkerEnv), true, "Cached Stop hook must short-circuit");

      const noCacheEnvRes = runAgentStop(
        sandbox,
        { terminationReason: "NO_TOOL_CALL" },
        [],
        { ...process.env, HARNESS_NO_CACHE: "1" }
      );
      assert.equal(noCacheEnvRes.status, 0);
      assert.deepEqual(noCacheEnvRes.json, { decision: "stop" });
      assert.equal(
        fs.existsSync(expiredMarkerEnv),
        false,
        "HARNESS_NO_CACHE=1 must bypass verify cache"
      );
    } finally {
      cleanup();
    }
  });
});

describe("TestStopHookLightweightGuard", () => {
  it("test_stop_hook_allows_tdd_red_phase_when_pyright_reports_errors", () => {
    const { sandbox, logFile, cleanup } = createGitSandbox("v2-tdd-red-");
    try {
      fs.writeFileSync(
        path.join(sandbox, "pyproject.toml"),
        '[project]\nname = "tdd-red"\nversion = "0.1.0"\n',
        "utf8"
      );
      const venvBin = path.join(sandbox, ".venv", "bin");
      installRecorderStub(venvBin, "python", logFile, "clean");
      installRecorderStub(venvBin, "pyright", logFile, "error");
      installRecorderStub(venvBin, "ruff", logFile, "error");

      const testsDir = path.join(sandbox, "tests");
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(
        path.join(testsDir, "test_pricing.py"),
        [
          "from pricing.engine import calculate_discount",
          "",
          "class TestPricingEngine:",
          "    def test_vip_order_applies_twenty_percent_discount(self):",
          "        assert calculate_discount(100, tier='vip') == 80",
          "",
        ].join("\n"),
        "utf8"
      );

      const res = runAgentStop(sandbox, { terminationReason: "NO_TOOL_CALL" });
      assert.equal(res.status, 0, `Expected Stop hook exit 0 during TDD Red Phase, got ${res.status}: ${res.stdout}`);
      assert.deepEqual(res.json, { decision: "stop" });
      assert.equal(countTool(logFile, "pyright"), 0, "Stop hook must launch pyright 0 times");
      assert.equal(countTool(logFile, "ruff-check"), 0, "Stop hook must launch ruff 0 times");
    } finally {
      cleanup();
    }
  });

  it("test_stop_hook_blocks_contract_violations_reverts_mtx001_and_caches_dirty_pass", () => {
    const { sandbox, cleanup } = createGitSandbox("v2-contracts-");
    try {
      const matrixRel = "docs/runbooks/source-adaptation-matrix.csv";
      const matrixAbs = path.join(sandbox, matrixRel);
      fs.mkdirSync(path.dirname(matrixAbs), { recursive: true });
      fs.writeFileSync(
        matrixAbs,
        "source_id,官方入口 URL,status\ndd-uk,https://www.legislation.gov.uk/all,pending\n",
        "utf8"
      );
      fs.writeFileSync(
        path.join(sandbox, ".agents", "harness.json"),
        JSON.stringify(
          {
            rootAllowlist: [".venv", "node_modules"],
            protectedMatrices: [
              {
                path: matrixRel,
                immutableColumns: ["source_id", "官方入口 URL"],
              },
            ],
          },
          null,
          2
        ),
        "utf8"
      );

      assert.equal(runGit(sandbox, ["add", "-A"]).status, 0);
      assert.equal(
        runGit(sandbox, ["commit", "-m", "chore: lock matrix baseline"], {
          env: { ...process.env, HARNESS_ALLOW_PROTECTED: "1" },
        }).status,
        0
      );

      const testsDir = path.join(sandbox, "tests");
      fs.mkdirSync(testsDir, { recursive: true });

      // 1. TST001 violation must block Stop hook with exit 2
      const badNameFile = path.join(testsDir, "test_phase99.py");
      fs.writeFileSync(
        badNameFile,
        "class TestBadName:\n    def test_valid_input_returns_true(self):\n        assert True\n",
        "utf8"
      );
      const tst001Res = runAgentStop(sandbox, { terminationReason: "NO_TOOL_CALL" });
      assert.equal(tst001Res.status, 2);
      assert.equal(tst001Res.json?.decision, "continue");
      assert.match(tst001Res.json?.reason || "", /TST001/);
      fs.rmSync(badNameFile, { force: true });

      // 2. TST002 violation must block Stop hook with exit 2
      const mockTestFile = path.join(testsDir, "test_billing.py");
      const pyMockImport = ["from unittest", "mock import Magic" + "Mock"].join(".");
      fs.writeFileSync(
        mockTestFile,
        `${pyMockImport}\n\nclass TestBilling:\n    def test_invoice_line_computes_subtotal(self):\n        stub = ${"Magic" + "Mock"}()\n        assert stub is not None\n`,
        "utf8"
      );
      const tst002Res = runAgentStop(sandbox, { terminationReason: "NO_TOOL_CALL" });
      assert.equal(tst002Res.status, 2);
      assert.equal(tst002Res.json?.decision, "continue");
      assert.match(tst002Res.json?.reason || "", /TST002/);

      // 3. MTX001 violation must block Stop hook with exit 2 AND auto-revert immutable cell from HEAD
      fs.rmSync(mockTestFile, { force: true });
      fs.writeFileSync(
        matrixAbs,
        "source_id,官方入口 URL,status\ndd-uk,https://tampered.example.org/fake,adapted\n",
        "utf8"
      );
      const mtxRes = runAgentStop(sandbox, { terminationReason: "NO_TOOL_CALL" });
      assert.equal(mtxRes.status, 2);
      assert.equal(mtxRes.json?.decision, "continue");
      assert.match(mtxRes.json?.reason || "", /MTX001/);

      const revertedCsv = fs.readFileSync(matrixAbs, "utf8");
      assert.ok(
        revertedCsv.includes("https://www.legislation.gov.uk/all"),
        "Stop hook must auto-revert tampered immutable URL cell from HEAD"
      );
      assert.ok(
        revertedCsv.includes(",adapted"),
        "Stop hook must preserve mutable status column edit"
      );

      // 4. Compliant uncommitted dirty state passes once, then hits fingerprint cache on repeat Stop hook
      fs.writeFileSync(
        mockTestFile,
        "class TestBilling:\n    def test_invoice_line_computes_subtotal(self):\n        assert 2 * 3 == 6\n",
        "utf8"
      );
      const firstCleanDirtyRes = runAgentStop(sandbox, { terminationReason: "NO_TOOL_CALL" });
      assert.equal(firstCleanDirtyRes.status, 0, firstCleanDirtyRes.stdout + firstCleanDirtyRes.stderr);
      assert.deepEqual(firstCleanDirtyRes.json, { decision: "stop" });

      const expiredMarker = createExpiredWorkMarker(sandbox, "expired-dirty-cache");
      const secondCleanDirtyRes = runAgentStop(sandbox, { terminationReason: "NO_TOOL_CALL" });
      assert.equal(secondCleanDirtyRes.status, 0);
      assert.deepEqual(secondCleanDirtyRes.json, { decision: "stop" });
      assert.equal(
        fs.existsSync(expiredMarker),
        true,
        "Second Stop hook on unchanged compliant dirty workspace must hit verify cache"
      );
    } finally {
      cleanup();
    }
  });
});

describe("TestChangeAwarePreCommitGate", () => {
  it("test_markdown_and_yaml_changes_skip_all_language_checkers", () => {
    const { sandbox, logFile, cleanup } = createGitSandbox("v3-noncode-");
    try {
      fs.writeFileSync(
        path.join(sandbox, "pyproject.toml"),
        '[project]\nname = "polyglot"\nversion = "0.1.0"\n',
        "utf8"
      );
      fs.writeFileSync(path.join(sandbox, "package.json"), '{"name":"polyglot","version":"0.1.0"}\n', "utf8");
      fs.writeFileSync(path.join(sandbox, "tsconfig.json"), '{"compilerOptions":{"noEmit":true}}\n', "utf8");
      fs.writeFileSync(path.join(sandbox, "eslint.config.js"), "export default [];\n", "utf8");
      fs.writeFileSync(path.join(sandbox, "config.yaml"), "env: dev\n", "utf8");
      fs.mkdirSync(path.join(sandbox, "src"), { recursive: true });
      fs.writeFileSync(path.join(sandbox, "src", "a.py"), "x: int = 1\n", "utf8");
      fs.writeFileSync(path.join(sandbox, "src", "index.ts"), "export const x: number = 1;\n", "utf8");

      const venvBin = path.join(sandbox, ".venv", "bin");
      const nodeBin = path.join(sandbox, "node_modules", ".bin");
      installRecorderStub(venvBin, "python", logFile, "clean");
      installRecorderStub(venvBin, "pyright", logFile, "clean");
      installRecorderStub(venvBin, "ruff", logFile, "clean");
      installRecorderStub(nodeBin, "eslint", logFile, "clean");
      installRecorderStub(nodeBin, "tsc", logFile, "clean");

      assert.equal(runGit(sandbox, ["add", "-A"]).status, 0);
      assert.equal(runGit(sandbox, ["commit", "-m", "chore: baseline"]).status, 0);
      resetInvocations(logFile);

      // Stage only README.md and config.yaml
      fs.appendFileSync(path.join(sandbox, "README.md"), "\nUpdated docs section.\n", "utf8");
      fs.writeFileSync(path.join(sandbox, "config.yaml"), "env: staging\n", "utf8");
      assert.equal(runGit(sandbox, ["add", "README.md", "config.yaml"]).status, 0);

      const stagedRes = runCli(sandbox, ["hook", "run", "--staged", "--no-cache"]);
      assert.equal(stagedRes.status, 0, stagedRes.stderr + stagedRes.stdout);
      assert.equal(countTool(logFile, "pyright"), 0, "Doc/YAML staged changes must not launch pyright");
      assert.equal(countTool(logFile, "ruff-check"), 0, "Doc/YAML staged changes must not launch ruff check");
      assert.equal(countTool(logFile, "ruff-format"), 0, "Doc/YAML staged changes must not launch ruff format");
      assert.equal(countTool(logFile, "eslint"), 0, "Doc/YAML staged changes must not launch eslint");
      assert.equal(countTool(logFile, "tsc"), 0, "Doc/YAML staged changes must not launch tsc");

      // Unstaged doc edit via无参 `harness hook run` must also not fallback to full-repo ruff/eslint/pyright/tsc
      fs.appendFileSync(path.join(sandbox, "README.md"), "More unstaged notes.\n", "utf8");
      const fullRes = runCli(sandbox, ["hook", "run", "--no-cache"]);
      assert.equal(fullRes.status, 0, fullRes.stderr + fullRes.stdout);
      assert.equal(countTool(logFile, "pyright"), 0);
      assert.equal(countTool(logFile, "ruff-check"), 0);
      assert.equal(countTool(logFile, "eslint"), 0);
      assert.equal(countTool(logFile, "tsc"), 0);
    } finally {
      cleanup();
    }
  });

  it("test_single_python_file_edit_passes_only_changed_file_to_ruff_and_skips_js_ts", () => {
    const { sandbox, logFile, cleanup } = createGitSandbox("v3-pyscope-");
    try {
      fs.writeFileSync(
        path.join(sandbox, "pyproject.toml"),
        '[project]\nname = "pyscope"\nversion = "0.1.0"\n',
        "utf8"
      );
      fs.writeFileSync(path.join(sandbox, "package.json"), '{"name":"pyscope","version":"0.1.0"}\n', "utf8");
      fs.writeFileSync(path.join(sandbox, "tsconfig.json"), '{"compilerOptions":{"noEmit":true}}\n', "utf8");
      fs.writeFileSync(path.join(sandbox, "eslint.config.js"), "export default [];\n", "utf8");
      fs.mkdirSync(path.join(sandbox, "src"), { recursive: true });
      fs.writeFileSync(path.join(sandbox, "src", "a.py"), "a: int = 1\n", "utf8");
      fs.writeFileSync(path.join(sandbox, "src", "b.py"), "b: int = 2\n", "utf8");
      fs.writeFileSync(path.join(sandbox, "src", "index.ts"), "export const n: number = 1;\n", "utf8");

      const venvBin = path.join(sandbox, ".venv", "bin");
      const nodeBin = path.join(sandbox, "node_modules", ".bin");
      installRecorderStub(venvBin, "python", logFile, "clean");
      installRecorderStub(venvBin, "pyright", logFile, "clean");
      installRecorderStub(venvBin, "ruff", logFile, "clean");
      installRecorderStub(nodeBin, "eslint", logFile, "clean");
      installRecorderStub(nodeBin, "tsc", logFile, "clean");

      assert.equal(runGit(sandbox, ["add", "-A"]).status, 0);
      assert.equal(runGit(sandbox, ["commit", "-m", "chore: baseline"]).status, 0);
      resetInvocations(logFile);

      fs.writeFileSync(path.join(sandbox, "src", "a.py"), "a: int = 42\n", "utf8");
      assert.equal(runGit(sandbox, ["add", "src/a.py"]).status, 0);

      const res = runCli(sandbox, ["hook", "run", "--staged", "--no-cache"]);
      assert.equal(res.status, 0, res.stderr + res.stdout);
      assert.equal(countTool(logFile, "pyright"), 1);
      assert.equal(countTool(logFile, "ruff-check"), 1);
      assert.equal(countTool(logFile, "eslint"), 0, "eslint must not run when no JS/TS files changed");
      assert.equal(countTool(logFile, "tsc"), 0, "tsc must not run when no JS/TS files changed");

      const ruffCheckCall = readInvocations(logFile).find((entry) => entry.tool === "ruff-check");
      assert.ok(ruffCheckCall, "Expected ruff-check invocation record");
      assert.ok(ruffCheckCall.args.includes("src/a.py"), `Expected ruff args to contain src/a.py, got: ${ruffCheckCall.args}`);
      assert.equal(
        ruffCheckCall.args.includes("src/b.py"),
        false,
        `ruff must not receive untouched src/b.py: ${ruffCheckCall.args}`
      );
    } finally {
      cleanup();
    }
  });

  it("test_pyrefly_ignores_unconfigured_ide_extension_and_runs_when_explicitly_enabled", () => {
    const { sandbox, stateDir, logFile, cleanup } = createGitSandbox("v3-pyrefly-");
    try {
      const fakeHome = path.join(stateDir, "fake-home");
      const ideExtDir = path.join(fakeHome, ".antigravity-ide", "extensions", "meta.pyrefly-0.99.0");
      installRecorderStub(path.join(ideExtDir, "bin"), "pyrefly", logFile, "error");
      installRecorderStub(path.join(ideExtDir, "bundled", "bin"), "pyrefly", logFile, "error");

      fs.writeFileSync(
        path.join(sandbox, "pyproject.toml"),
        '[project]\nname = "no-pyrefly"\nversion = "0.1.0"\n',
        "utf8"
      );
      fs.mkdirSync(path.join(sandbox, "src"), { recursive: true });
      fs.writeFileSync(path.join(sandbox, "src", "a.py"), "x: int = 1\n", "utf8");

      const venvBin = path.join(sandbox, ".venv", "bin");
      installRecorderStub(venvBin, "python", logFile, "clean");
      installRecorderStub(venvBin, "pyright", logFile, "clean");
      installRecorderStub(venvBin, "ruff", logFile, "clean");

      assert.equal(runGit(sandbox, ["add", "-A"]).status, 0);
      assert.equal(runGit(sandbox, ["commit", "-m", "chore: baseline"]).status, 0);
      resetInvocations(logFile);

      fs.writeFileSync(path.join(sandbox, "src", "a.py"), "x: int = 2\n", "utf8");
      assert.equal(runGit(sandbox, ["add", "src/a.py"]).status, 0);

      const unconfiguredRes = runCli(sandbox, ["hook", "run", "--staged", "--no-cache"], {
        env: { ...process.env, HOME: fakeHome },
      });
      assert.equal(unconfiguredRes.status, 0, unconfiguredRes.stderr + unconfiguredRes.stdout);
      assert.equal(
        countTool(logFile, "pyrefly"),
        0,
        "Unconfigured repo must not implicitly execute pyrefly from IDE extensions directory"
      );

      // Explicitly enabling via pyrefly.toml + pyrefly on PATH must execute pyrefly
      const localBin = path.join(fakeHome, ".local", "bin");
      installRecorderStub(localBin, "pyrefly", logFile, "clean");
      fs.writeFileSync(path.join(sandbox, "pyrefly.toml"), 'project-includes = ["src"]\n', "utf8");
      assert.equal(runGit(sandbox, ["add", "pyrefly.toml", "src/a.py"]).status, 0);

      const configuredTomlRes = runCli(sandbox, ["hook", "run", "--staged", "--no-cache"], {
        env: { ...process.env, HOME: fakeHome, PATH: `${localBin}:${process.env.PATH || ""}` },
      });
      assert.equal(configuredTomlRes.status, 0, configuredTomlRes.stderr + configuredTomlRes.stdout);
      assert.equal(countTool(logFile, "pyrefly"), 1, "pyrefly must run when pyrefly.toml is present");

      // Explicitly installing .venv/bin/pyrefly (even without pyrefly.toml) must also execute pyrefly
      resetInvocations(logFile);
      fs.rmSync(path.join(sandbox, "pyrefly.toml"), { force: true });
      installRecorderStub(venvBin, "pyrefly", logFile, "clean");
      fs.writeFileSync(path.join(sandbox, "src", "a.py"), "x: int = 3\n", "utf8");
      assert.equal(runGit(sandbox, ["add", "-A"]).status, 0);

      const venvPyreflyRes = runCli(sandbox, ["hook", "run", "--staged", "--no-cache"], {
        env: { ...process.env, HOME: fakeHome },
      });
      assert.equal(venvPyreflyRes.status, 0, venvPyreflyRes.stderr + venvPyreflyRes.stdout);
      assert.equal(countTool(logFile, "pyrefly"), 1, "pyrefly must run when .venv/bin/pyrefly exists");
    } finally {
      cleanup();
    }
  });

  it("test_staged_deleted_python_module_triggers_pyright_and_catches_broken_import", () => {
    const { sandbox, logFile, cleanup } = createGitSandbox("v3-deleted-py-");
    try {
      fs.writeFileSync(
        path.join(sandbox, "pyproject.toml"),
        '[project]\nname = "delcheck"\nversion = "0.1.0"\n',
        "utf8"
      );
      fs.mkdirSync(path.join(sandbox, "src"), { recursive: true });
      fs.writeFileSync(path.join(sandbox, "src", "helper.py"), "def greet() -> str:\n    return 'hi'\n", "utf8");
      fs.writeFileSync(
        path.join(sandbox, "src", "main.py"),
        "from src.helper import greet\n\nmessage: str = greet()\n",
        "utf8"
      );

      const venvBin = path.join(sandbox, ".venv", "bin");
      installRecorderStub(venvBin, "python", logFile, "clean");
      installRecorderStub(venvBin, "pyright", logFile, "check-helper-exists");
      installRecorderStub(venvBin, "ruff", logFile, "clean");

      assert.equal(runGit(sandbox, ["add", "-A"]).status, 0);
      assert.equal(runGit(sandbox, ["commit", "-m", "chore: add helper and main"]).status, 0);
      resetInvocations(logFile);

      // Delete helper.py via `git rm` without editing any surviving file
      assert.equal(runGit(sandbox, ["rm", "-q", "src/helper.py"]).status, 0);

      const stagedDelRes = runCli(sandbox, ["hook", "run", "--staged", "--no-cache"]);
      assert.equal(
        countTool(logFile, "pyright"),
        1,
        "Deleting a tracked .py file (D status) must still trigger pyright"
      );
      assert.equal(
        stagedDelRes.status,
        1,
        "harness hook run --staged must fail with exit 1 when deleted module breaks imports"
      );
      assert.match(stagedDelRes.stderr, /\[pyright\]/);
      assert.match(stagedDelRes.stderr, /reportMissingImports/);
      assert.equal(
        countTool(logFile, "ruff-check"),
        0,
        "ruff must not run when existingChangedPyFiles is empty after pure file deletion"
      );
    } finally {
      cleanup();
    }
  });
});

describe("TestReadonlyShellUnwrapAndCursor", () => {
  it("test_wrapped_shells_and_coordination_tools_short_circuit_stop_hook", () => {
    const { sandbox, cleanup } = createGitSandbox("v4-unwrap-");
    try {
      // Plant an active TST001 violation so any non-readonly classification returns exit 2
      const testsDir = path.join(sandbox, "tests");
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(
        path.join(testsDir, "test_phase99.py"),
        "class TestViolation:\n    def test_case_returns_true(self):\n        assert True\n",
        "utf8"
      );

      const transcriptPath = path.join(sandbox, "work", "transcript.jsonl");
      const readonlyToolCases = [
        {
          name: "run_command",
          args: {
            CommandLine: "\"harness watch --timeout 10s -- zsh -c 'git status && ls -la | head -n 5'\"",
          },
        },
        {
          name: "run_command",
          args: {
            CommandLine: "harness watch --timeout 10s -- bash -lc 'set -o pipefail; git status | head -n 3'",
          },
        },
        {
          name: "run_command",
          args: {
            CommandLine: "harness watch --timeout 10s -- \"git status && git diff\"",
          },
        },
        {
          name: "send_message",
          args: { Recipient: "\"agent-peer\"", Message: "\"Status update\"" },
        },
        {
          name: "schedule",
          args: { DurationSeconds: 30, Prompt: "\"Check async job\"" },
        },
        {
          name: "define_subagent",
          args: { Name: "\"auditor\"", Description: "\"Readonly auditor\"", SystemPrompt: "\"Audit\"" },
        },
        {
          name: "swarm",
          args: { action: "\"status\"" },
        },
        {
          name: "swarm",
          args: { action: "models" },
        },
        {
          name: "invoke_subagent",
          args: {
            TypeName: "\"research\"",
            Role: "\"Codebase Researcher\"",
            Prompt: "\"Inspect module boundaries\"",
          },
        },
      ];

      for (const toolCall of readonlyToolCases) {
        const steps = [
          {
            step_index: 0,
            source: "USER_EXPLICIT",
            type: "USER_INPUT",
            status: "DONE",
            content: "Inspect repository and coordinate",
          },
          {
            step_index: 1,
            source: "MODEL",
            type: "PLANNER_RESPONSE",
            status: "DONE",
            tool_calls: [toolCall],
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
            content: "Read-only step complete.",
          },
        ];
        fs.writeFileSync(
          transcriptPath,
          steps.map((s) => JSON.stringify(s)).join("\n") + "\n",
          "utf8"
        );

        const res = runAgentStop(sandbox, {
          terminationReason: "NO_TOOL_CALL",
          transcriptPath,
        });
        assert.equal(
          res.status,
          0,
          `Expected exit 0 for readonly tool ${JSON.stringify(toolCall)}, got ${res.status}: ${res.stdout}`
        );
        assert.deepEqual(res.json, { decision: "stop" });
      }

      // Mutating shell inside zsh -c or mutating subagent/swarm action must NOT be treated as readonly
      const mutatingToolCases = [
        {
          name: "run_command",
          args: {
            CommandLine: "harness watch --timeout 10s -- zsh -c 'echo mutated > README.md'",
          },
        },
        {
          name: "invoke_subagent",
          args: {
            TypeName: "\"self\"",
            Role: "\"Implementer\"",
            Prompt: "\"Modify files\"",
          },
        },
        {
          name: "swarm",
          args: {
            action: "\"add\"",
            name: "\"worker\"",
            brief: "\"Edit code\"",
          },
        },
      ];

      for (const badCall of mutatingToolCases) {
        const steps = [
          {
            step_index: 0,
            source: "USER_EXPLICIT",
            type: "USER_INPUT",
            status: "DONE",
            content: "Mutate repo",
          },
          {
            step_index: 1,
            source: "MODEL",
            type: "PLANNER_RESPONSE",
            status: "DONE",
            tool_calls: [badCall],
          },
          {
            step_index: 2,
            source: "MODEL",
            type: "GENERIC",
            status: "DONE",
            content: "done",
          },
        ];
        fs.writeFileSync(
          transcriptPath,
          steps.map((s) => JSON.stringify(s)).join("\n") + "\n",
          "utf8"
        );

        const res = runAgentStop(sandbox, {
          terminationReason: "NO_TOOL_CALL",
          transcriptPath,
        });
        assert.equal(
          res.status,
          2,
          `Expected exit 2 for mutating tool ${JSON.stringify(badCall)}, got ${res.status}`
        );
        assert.equal(res.json?.decision, "continue");
      }
    } finally {
      cleanup();
    }
  });

  it("test_failed_stop_hook_prevents_readonly_escape_until_passed_cursor_advances", () => {
    const { sandbox, cleanup } = createGitSandbox("v4-cursor-");
    try {
      assert.equal(runGit(sandbox, ["add", "-A"]).status, 0);
      assert.equal(runGit(sandbox, ["commit", "-m", "chore: initial"]).status, 0);

      const testsDir = path.join(sandbox, "tests");
      fs.mkdirSync(testsDir, { recursive: true });
      const badTestFile = path.join(testsDir, "test_phase99.py");
      fs.writeFileSync(
        badTestFile,
        "class TestViolation:\n    def test_case_returns_true(self):\n        assert True\n",
        "utf8"
      );

      const transcriptPath = path.join(sandbox, "work", "cursor-transcript.jsonl");
      const steps = [
        {
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          content: "Implement feature",
        },
        {
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          tool_calls: [
            {
              name: "edit_file",
              args: { Path: "\"README.md\"", Target: "\"a\"", Replacement: "\"b\"" },
            },
          ],
        },
        {
          step_index: 2,
          source: "MODEL",
          type: "GENERIC",
          status: "DONE",
          content: "Edited",
        },
        {
          step_index: 3,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "First mini-turn complete.",
        },
      ];
      fs.writeFileSync(
        transcriptPath,
        steps.map((s) => JSON.stringify(s)).join("\n") + "\n",
        "utf8"
      );

      // Mini-turn 1: mutating edit_file + TST001 violation -> blocked with exit 2 (cursor must NOT advance)
      const turn1Res = runAgentStop(sandbox, {
        terminationReason: "NO_TOOL_CALL",
        transcriptPath,
      });
      assert.equal(turn1Res.status, 2);
      assert.equal(turn1Res.json?.decision, "continue");
      assert.match(turn1Res.json?.reason || "", /TST001/);

      // Mini-turn 2: append ONLY read_file without fixing TST001 -> must NOT escape!
      steps.push(
        {
          step_index: 4,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          tool_calls: [
            {
              name: "read_file",
              args: { Path: "\"README.md\"" },
            },
          ],
        },
        {
          step_index: 5,
          source: "MODEL",
          type: "GENERIC",
          status: "DONE",
          content: "Read README",
        },
        {
          step_index: 6,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "Read-only follow-up without fixing violation.",
        }
      );
      fs.writeFileSync(
        transcriptPath,
        steps.map((s) => JSON.stringify(s)).join("\n") + "\n",
        "utf8"
      );

      const turn2Res = runAgentStop(sandbox, {
        terminationReason: "NO_TOOL_CALL",
        transcriptPath,
      });
      assert.equal(
        turn2Res.status,
        2,
        "Stop hook must keep blocking when previous mini-turn failed and violation remains unfixed"
      );
      assert.equal(turn2Res.json?.decision, "continue");
      assert.match(turn2Res.json?.reason || "", /TST001/);

      // Mini-turn 3: fix violation -> Stop hook passes and advances lastPassedStepIndex
      fs.rmSync(badTestFile, { force: true });
      steps.push(
        {
          step_index: 7,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          tool_calls: [
            {
              name: "run_command",
              args: { CommandLine: "\"harness watch --timeout 5s -- rm -f tests/test_phase99.py\"" },
            },
          ],
        },
        {
          step_index: 8,
          source: "MODEL",
          type: "GENERIC",
          status: "DONE",
          content: "Removed bad test",
        },
        {
          step_index: 9,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "Violation fixed.",
        }
      );
      fs.writeFileSync(
        transcriptPath,
        steps.map((s) => JSON.stringify(s)).join("\n") + "\n",
        "utf8"
      );

      const turn3Res = runAgentStop(sandbox, {
        terminationReason: "NO_TOOL_CALL",
        transcriptPath,
      });
      assert.equal(turn3Res.status, 0, turn3Res.stdout + turn3Res.stderr);
      assert.deepEqual(turn3Res.json, { decision: "stop" });

      // Mini-turn 4: plant external violation to prove cursor scans ONLY steps after lastPassedStepIndex
      fs.writeFileSync(
        badTestFile,
        "class TestExternal:\n    def test_case_returns_true(self):\n        assert True\n",
        "utf8"
      );
      steps.push(
        {
          step_index: 10,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          tool_calls: [
            {
              name: "read_file",
              args: { Path: "\"README.md\"" },
            },
            {
              name: "send_message",
              args: { Recipient: "\"parent\"", Message: "\"Awaiting wakeup\"" },
            },
          ],
        },
        {
          step_index: 11,
          source: "MODEL",
          type: "GENERIC",
          status: "DONE",
          content: "ok",
        },
        {
          step_index: 12,
          source: "MODEL",
          type: "GENERIC",
          status: "DONE",
          content: "ok",
        },
        {
          step_index: 13,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "Read-only post-pass step.",
        }
      );
      fs.writeFileSync(
        transcriptPath,
        steps.map((s) => JSON.stringify(s)).join("\n") + "\n",
        "utf8"
      );

      const turn4Res = runAgentStop(sandbox, {
        terminationReason: "NO_TOOL_CALL",
        transcriptPath,
      });
      assert.equal(
        turn4Res.status,
        0,
        `Expected exit 0 via lastPassedStepIndex readonly slice, got ${turn4Res.status}: ${turn4Res.stdout}`
      );
      assert.deepEqual(turn4Res.json, { decision: "stop" });
    } finally {
      cleanup();
    }
  });
});

describe("TestWatchHeredocAndSingleArgShell", () => {
  it("test_heredoc_regular_file_stdin_passes_through_while_pipe_stdin_closes", () => {
    const zshCmd = [
      `${ JSON.stringify(process.execPath) } ${ JSON.stringify(CLI_BIN) } watch --timeout 5s -- ${ JSON.stringify(process.execPath) } -e "const fs=require('fs'); console.log('LEN:'+fs.readFileSync(0,'utf8').trim())" << 'EOF'`,
      "heredoc-payload-ok",
      "EOF",
    ].join("\n");

    const heredocRes = spawnSync("/bin/zsh", ["-c", zshCmd], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(heredocRes.error, undefined);
    assert.equal(heredocRes.status, 0, heredocRes.stderr + heredocRes.stdout);
    assert.match(heredocRes.stdout, /LEN:heredoc-payload-ok/);

    // Pipe (non-regular-file) stdin must still receive immediate EOF without hanging
    const pipeRes = spawnSync(
      process.execPath,
      [
        CLI_BIN,
        "watch",
        "--timeout",
        "5s",
        "--",
        process.execPath,
        "-e",
        "const fs=require('fs'); console.log('PIPE:['+fs.readFileSync(0,'utf8')+']')",
      ],
      {
        cwd: ROOT,
        input: "ignored-pipe-bytes",
        encoding: "utf8",
        timeout: 15000,
      }
    );
    assert.equal(pipeRes.error, undefined);
    assert.equal(pipeRes.status, 0, pipeRes.stderr);
    assert.match(pipeRes.stdout, /PIPE:\[\]/);
  });

  it("test_single_string_command_runs_under_user_shell_with_pipefail", () => {
    const okRes = spawnSync(
      process.execPath,
      [
        CLI_BIN,
        "watch",
        "--timeout",
        "5s",
        "--",
        'set -o pipefail; printf "ok:%s\\n" "${ZSH_VERSION:-missing}" | cat',
      ],
      {
        cwd: ROOT,
        env: { ...process.env, SHELL: "/bin/zsh" },
        encoding: "utf8",
        timeout: 15000,
      }
    );
    assert.equal(okRes.error, undefined);
    assert.equal(okRes.status, 0, okRes.stderr + okRes.stdout);
    assert.doesNotMatch(
      okRes.stdout.trim(),
      /^ok:missing$/,
      "Single-string command must execute under $SHELL (/bin/zsh) rather than hardcoded /bin/sh"
    );
    assert.match(okRes.stdout.trim(), /^ok:\d+\./);

    const failPipeRes = spawnSync(
      process.execPath,
      [CLI_BIN, "watch", "--timeout", "5s", "--", "set -o pipefail; false | cat"],
      {
        cwd: ROOT,
        env: { ...process.env, SHELL: "/bin/zsh" },
        encoding: "utf8",
        timeout: 15000,
      }
    );
    assert.equal(failPipeRes.error, undefined);
    assert.notEqual(failPipeRes.status, 0, "pipefail failure inside single-string command must propagate non-zero exit");
  });
});
