import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CLI_BIN = path.join(REPO_ROOT, "bin/harness.js");

function runCli(cwd, args, options = {}) {
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 15000,
    ...options,
  });
}

function describe(_name, fn) {
  fn();
}

function it(_name, fn) {
  fn();
}

describe("TestUniversalHarness", () => {
  it("test_cli_lifecycle_and_guardrails_pass_blackbox_contracts", () => {
    const sandboxRoot = path.join(REPO_ROOT, "work", "blackbox-test-repo");
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
    fs.mkdirSync(sandboxRoot, { recursive: true });

    try {
      // 1. Empty directory fails HAR001 & GIT001
  const failEmpty = runCli(sandboxRoot, ["doctor", "--json"]);
  assert.equal(failEmpty.status, 1);
  const emptyReport = JSON.parse(failEmpty.stdout);
  assert.equal(emptyReport.ok, false);
  assert.ok(emptyReport.diagnostics.some((d) => d.code === "HAR001"));
  assert.ok(emptyReport.diagnostics.some((d) => d.code === "GIT001"));

  // 2. harness init sets up full structure and passes doctor
  const initRes = runCli(sandboxRoot, ["init"]);
  assert.equal(initRes.status, 0);

  const passInit = runCli(sandboxRoot, ["doctor"]);
  assert.equal(passInit.status, 0, passInit.stderr);

  // 3. harness spec new (sparse issue#<N> format) + harness adr new + harness adr supersede
  assert.equal(
    runCli(sandboxRoot, ["spec", "new", "issue#1", "--title", "UI Matrix Redesign"]).status,
    0
  );
  assert.ok(fs.existsSync(path.join(sandboxRoot, "docs/spec/issue#1/spec.md")));

  // Non-consecutive / sparse issue number (e.g., issue#15 created by maintainer)
  assert.equal(
    runCli(sandboxRoot, ["spec", "new", "15", "--title", "Maintainer Feature Spec"]).status,
    0
  );
  assert.ok(fs.existsSync(path.join(sandboxRoot, "docs/spec/issue#15/spec.md")));

  assert.equal(runCli(sandboxRoot, ["adr", "new", "use-postgres"]).status, 0);
  assert.equal(
    runCli(sandboxRoot, [
      "adr",
      "supersede",
      "0001",
      "migrate-to-supabase",
      "--reason",
      "Need RLS and Realtime",
    ]).status,
    0
  );
  assert.equal(runCli(sandboxRoot, ["doctor"]).status, 0);

  // 4. Unindexed file in docs/reference/ triggers REF001
  fs.writeFileSync(path.join(sandboxRoot, "docs/reference/vendor-api.pdf"), "dummy", "utf8");
  const refFail = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.ok(refFail.diagnostics.some((d) => d.code === "REF001"));

  // Registering it in 3-column docs/reference/INDEX.md resolves REF001
  fs.appendFileSync(
    path.join(sandboxRoot, "docs/reference/INDEX.md"),
    "| `vendor-api.pdf` | 第三方接口规范 | 已封存 |\n",
    "utf8"
  );
  assert.equal(runCli(sandboxRoot, ["doctor"]).status, 0);

  // 5. Dead link (LNK001), broken anchor (LNK002), conversation remnant (VOX001), and invalid suppression (SUP001)
  const originalProjectsMd = fs.readFileSync(path.join(sandboxRoot, "PROJECTS.md"), "utf8");
  fs.appendFileSync(
    path.join(sandboxRoot, "PROJECTS.md"),
    "\n根据你的要求，See [missing file](docs/non-existent.md) and [missing anchor](docs/README.md#no-such-heading).\n<!-- harness-ignore VOX001 -->\n",
    "utf8"
  );
  const linkFail = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.ok(linkFail.diagnostics.some((d) => d.code === "LNK001"));
  assert.ok(linkFail.diagnostics.some((d) => d.code === "LNK002"));
  assert.ok(linkFail.diagnostics.some((d) => d.code === "VOX001"));
  assert.ok(linkFail.diagnostics.some((d) => d.code === "SUP001"));

  // 6. Hook install (.agents/hooks.json) & agent hook verification + sandbox TTL cleanup
  assert.equal(runCli(sandboxRoot, ["hook", "install", "--agents"]).status, 0);
  assert.ok(fs.existsSync(path.join(sandboxRoot, ".agents/hooks.json")));

  const expiredWork = path.join(sandboxRoot, "work", "expired-run");
  const freshWork = path.join(sandboxRoot, "work", "fresh-run");
  const expiredTeamwork = path.join(sandboxRoot, ".agents", "teamwork", "expired-subagent");
  const nestedAgents = path.join(sandboxRoot, ".agents", ".agents", "hooks");
  fs.mkdirSync(expiredWork, { recursive: true });
  fs.mkdirSync(freshWork, { recursive: true });
  fs.mkdirSync(expiredTeamwork, { recursive: true });
  fs.mkdirSync(nestedAgents, { recursive: true });
  const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000);
  fs.utimesSync(expiredWork, twoDaysAgo, twoDaysAgo);
  fs.utimesSync(expiredTeamwork, twoDaysAgo, twoDaysAgo);

  const hookAgentRes = runCli(sandboxRoot, ["hook", "run", "--agent"]);
  assert.equal(hookAgentRes.status, 2);
  assert.equal(fs.existsSync(expiredWork), false, "Expired work dir should be auto-cleaned by hook");
  assert.equal(fs.existsSync(expiredTeamwork), false, "Expired .agents/teamwork dir should be auto-cleaned by hook");
  assert.equal(fs.existsSync(path.join(sandboxRoot, ".agents", ".agents")), false, "Nested .agents/.agents should be auto-cleaned by hook");
  assert.equal(fs.existsSync(path.join(sandboxRoot, ".agents", "hooks.json")), true, ".agents/hooks.json must be preserved");
  assert.equal(fs.existsSync(freshWork), true, "Fresh work dir should be preserved by hook");

  assert.equal(runCli(sandboxRoot, ["clean", "--all"]).status, 0);
  assert.equal(fs.existsSync(freshWork), false, "harness clean --all should remove all sandbox items");

  // Restore PROJECTS.md so sandbox repo passes doctor cleanly before testing TST001/TST002 & typecheck hooks
  fs.writeFileSync(path.join(sandboxRoot, "PROJECTS.md"), originalProjectsMd, "utf8");
  assert.equal(runCli(sandboxRoot, ["doctor"]).status, 0);

  // 7. Test Contract Static Checks (TST001 & TST002 in harness doctor and harness rule)
  const ruleTst001 = runCli(sandboxRoot, ["rule", "TST001"]);
  assert.equal(ruleTst001.status, 0);
  assert.ok(ruleTst001.stdout.includes("TST001"));

  const ruleTst002 = runCli(sandboxRoot, ["rule", "TST002"]);
  assert.equal(ruleTst002.status, 0);
  assert.ok(ruleTst002.stdout.includes("TST002"));

  const ruleAll = runCli(sandboxRoot, ["rule", "--all"]);
  assert.equal(ruleAll.status, 0);
  assert.ok(ruleAll.stdout.includes("TST001"));
  assert.ok(ruleAll.stdout.includes("TST002"));

  // 7a. TST001: Phase/number-named test files trigger TST001
  const testsDir = path.join(sandboxRoot, "tests");
  fs.mkdirSync(testsDir, { recursive: true });

  for (const badFileName of ["test_phase1.py", "test1.py", "phase1.test.js"]) {
    const badFilePath = path.join(testsDir, badFileName);
    fs.writeFileSync(badFilePath, "# dummy test\n", "utf8");
    const badNameReport = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
    assert.ok(
      badNameReport.diagnostics.some((d) => d.code === "TST001"),
      `Expected ${badFileName} to trigger TST001`
    );
    fs.rmSync(badFilePath, { force: true });
  }

  // 7b. TST001: Top-level def test_... (not inside class Test<Subject>:) triggers TST001
  const billingTestPath = path.join(testsDir, "test_billing.py");
  fs.writeFileSync(
    billingTestPath,
    "def test_invoice_created():\n    assert True\n",
    "utf8"
  );
  const topLevelReport = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.ok(
    topLevelReport.diagnostics.some((d) => d.code === "TST001"),
    "Top-level def test_invoice_created() should trigger TST001"
  );

  // 7c. TST001: Single-word method name def test_invoice(self): inside class TestBilling: triggers TST001
  fs.writeFileSync(
    billingTestPath,
    "class TestBilling:\n    def test_invoice(self):\n        assert True\n",
    "utf8"
  );
  const singleWordReport = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.ok(
    singleWordReport.diagnostics.some((d) => d.code === "TST001"),
    "Single-word def test_invoice(self) should trigger TST001"
  );

  // 7d. TST001: Valid class TestBilling: with def test_valid_order_generates_invoice(self): passes TST001
  fs.writeFileSync(
    billingTestPath,
    "class TestBilling:\n    def test_valid_order_generates_invoice(self):\n        assert True\n",
    "utf8"
  );
  const validTst001Report = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.equal(
    validTst001Report.diagnostics.some((d) => d.code === "TST001"),
    false,
    "Valid class TestBilling + two-part test method should pass TST001"
  );

  // 7e. TST002: Forbidden mocking / monkeypatching in Python and JS test files triggers TST002
  fs.writeFileSync(
    billingTestPath,
    "from unittest.mock import MagicMock, patch\n\nclass TestBilling:\n    def test_valid_order_generates_invoice(self):\n        assert True\n",
    "utf8"
  );
  const mockImportReport = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.ok(
    mockImportReport.diagnostics.some((d) => d.code === "TST002"),
    "unittest.mock import should trigger TST002"
  );

  fs.writeFileSync(
    billingTestPath,
    'class TestBilling:\n    def test_valid_order_generates_invoice(self, monkeypatch):\n        monkeypatch.setattr(target, "fn", fake)\n        assert True\n',
    "utf8"
  );
  const setattrReport = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.ok(
    setattrReport.diagnostics.some((d) => d.code === "TST002"),
    "monkeypatch.setattr should trigger TST002"
  );

  const jsTestPath = path.join(testsDir, "billing.test.js");
  fs.writeFileSync(jsTestPath, 'jest.mock("axios");\n', "utf8");
  const jestMockReport = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.ok(
    jestMockReport.diagnostics.some((d) => d.code === "TST002"),
    'jest.mock("axios") in JS test file should trigger TST002'
  );
  fs.rmSync(jsTestPath, { force: true });

  // 7f. TST002: monkeypatch.setenv and monkeypatch.delenv are allowed and do NOT trigger TST002
  fs.writeFileSync(
    billingTestPath,
    'class TestBilling:\n    def test_valid_order_generates_invoice(self, monkeypatch):\n        monkeypatch.setenv("WLH_ALLOW_LOOPBACK", "0")\n        monkeypatch.delenv("SECRET_KEY", raising=False)\n        assert True\n',
    "utf8"
  );
  const envPatchReport = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.equal(
    envPatchReport.diagnostics.some((d) => d.code === "TST002"),
    false,
    "monkeypatch.setenv and monkeypatch.delenv should NOT trigger TST002"
  );

  // 7g. TST002 + SUP001: Unreasoned # harness-ignore TST002 triggers SUP001; reasoned comment suppresses TST002 cleanly
  fs.writeFileSync(
    billingTestPath,
    "# harness-ignore TST002\nfrom unittest.mock import MagicMock, patch\n\nclass TestBilling:\n    def test_valid_order_generates_invoice(self):\n        assert True\n",
    "utf8"
  );
  const unreasonedSupReport = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.ok(
    unreasonedSupReport.diagnostics.some((d) => d.code === "SUP001"),
    "Unreasoned # harness-ignore TST002 should trigger SUP001"
  );

  fs.writeFileSync(
    billingTestPath,
    "# harness-ignore TST002: simulate kernel disk-full IOError\nfrom unittest.mock import MagicMock, patch\n\nclass TestBilling:\n    def test_valid_order_generates_invoice(self):\n        assert True\n",
    "utf8"
  );
  const reasonedSupReport = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.equal(
    reasonedSupReport.diagnostics.some((d) => d.code === "TST002"),
    false,
    "Reasoned # harness-ignore TST002 should suppress TST002"
  );
  assert.equal(
    reasonedSupReport.diagnostics.some((d) => d.code === "SUP001"),
    false,
    "Reasoned # harness-ignore TST002 should not trigger SUP001"
  );
  assert.equal(reasonedSupReport.ok, true);

  // 8. Multi-Language Static Type & Linter Zero-Tolerance Stop Hook (Pyright & Pyrefly on NO_TOOL_CALL)
  fs.writeFileSync(
    path.join(sandboxRoot, "pyproject.toml"),
    '[project]\nname = "sandbox-app"\nversion = "0.1.0"\n',
    "utf8"
  );
  const venvBinDir = path.join(sandboxRoot, ".venv", "bin");
  fs.mkdirSync(venvBinDir, { recursive: true });

  const pythonBin = path.join(venvBinDir, "python");
  const pyrightBin = path.join(venvBinDir, "pyright");
  const pyreflyBin = path.join(venvBinDir, "pyrefly");

  fs.writeFileSync(pythonBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    pyrightBin,
    `#!/bin/sh\nprintf '%s\\n' '{"generalDiagnostics":[{"file":"src/app.py","severity":"warning","message":"Type of x is partially unknown","rule":"reportUnknownVariableType","range":{"start":{"line":9,"character":4}}}],"summary":{"errorCount":0,"warningCount":1}}'\nexit 0\n`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    pyreflyBin,
    `#!/bin/sh\nprintf '%s\\n' '{"errors":[{"path":"src/app.py","line":12,"column":1,"severity":"error","name":"bad-return","concise_description":"Expected int, got str"}]}'\nexit 1\n`,
    { mode: 0o755 }
  );
  fs.chmodSync(pythonBin, 0o755);
  fs.chmodSync(pyrightBin, 0o755);
  fs.chmodSync(pyreflyBin, 0o755);

  // 8a. Non-normal termination guard: USER_CANCELED and MAX_INVOCATIONS must output {"decision":"stop"} and exit 0 even when typecheck/doctor has errors
  const badTestForCancel = path.join(testsDir, "test_phase99.py");
  fs.writeFileSync(badTestForCancel, "# triggers TST001\n", "utf8");
  for (const reason of ["USER_CANCELED", "MAX_INVOCATIONS"]) {
    const cancelRes = runCli(sandboxRoot, ["hook", "run", "--agent"], {
      input: JSON.stringify({ terminationReason: reason }),
    });
    assert.equal(cancelRes.status, 0, `Expected exit 0 for ${reason}, got ${cancelRes.status}`);
    const cancelJson = JSON.parse(cancelRes.stdout.trim());
    assert.equal(cancelJson.decision, "stop");
  }
  fs.rmSync(badTestForCancel, { force: true });

  // 8b. Pyright & Pyrefly strict error/warning blocking on NO_TOOL_CALL
  const blockStopRes = runCli(sandboxRoot, ["hook", "run", "--agent"], {
    input: JSON.stringify({ terminationReason: "NO_TOOL_CALL" }),
  });
  const blockStopJson = JSON.parse(blockStopRes.stdout.trim());
  assert.equal(blockStopJson.decision, "continue");
  assert.ok(blockStopJson.reason.includes("[pyright]"), "Reason should include [pyright]");
  assert.ok(blockStopJson.reason.includes("src/app.py:10:5"), "Reason should include 1-based pyright location src/app.py:10:5");
  assert.ok(blockStopJson.reason.includes("reportUnknownVariableType"), "Reason should include reportUnknownVariableType");
  assert.ok(blockStopJson.reason.includes("[pyrefly]"), "Reason should include [pyrefly]");
  assert.ok(blockStopJson.reason.includes("src/app.py:12:1"), "Reason should include pyrefly location src/app.py:12:1");
  assert.ok(blockStopJson.reason.includes("bad-return"), "Reason should include bad-return");

  // Update pyright and pyrefly to output 0 errors and 0 warnings
  fs.writeFileSync(
    pyrightBin,
    `#!/bin/sh\nprintf '%s\\n' '{"generalDiagnostics":[],"summary":{"errorCount":0,"warningCount":0}}'\nexit 0\n`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    pyreflyBin,
    `#!/bin/sh\nprintf '%s\\n' '{"errors":[]}'\nexit 0\n`,
    { mode: 0o755 }
  );
  fs.chmodSync(pyrightBin, 0o755);
  fs.chmodSync(pyreflyBin, 0o755);

  const allowStopRes = runCli(sandboxRoot, ["hook", "run", "--agent"], {
    input: JSON.stringify({ terminationReason: "NO_TOOL_CALL" }),
  });
  assert.equal(allowStopRes.status, 0);
  const allowStopJson = JSON.parse(allowStopRes.stdout.trim());
  assert.equal(allowStopJson.decision, "stop");

  // 8c. Ruff (Python Linter) blocking on NO_TOOL_CALL
  const ruffBin = path.join(venvBinDir, "ruff");
  const ruffPayload = JSON.stringify([
    {
      code: "F401",
      filename: "src/app.py",
      location: { row: 3, column: 8 },
      message: "`os` imported but unused",
    },
  ]);
  fs.writeFileSync(
    ruffBin,
    `#!/bin/sh\nprintf '%s\\n' '${ruffPayload}'\nexit 1\n`,
    { mode: 0o755 }
  );
  fs.chmodSync(ruffBin, 0o755);

  const ruffBlockRes = runCli(sandboxRoot, ["hook", "run", "--agent"], {
    input: JSON.stringify({ terminationReason: "NO_TOOL_CALL" }),
  });
  const ruffBlockJson = JSON.parse(ruffBlockRes.stdout.trim());
  assert.equal(ruffBlockJson.decision, "continue");
  assert.ok(ruffBlockJson.reason.includes("[ruff]"), "Reason should include [ruff]");
  assert.ok(ruffBlockJson.reason.includes("src/app.py:3:8"), "Reason should include src/app.py:3:8");
  assert.ok(ruffBlockJson.reason.includes("F401"), "Reason should include F401");
  assert.ok(ruffBlockJson.reason.includes("imported but unused"), "Reason should include imported but unused");

  // 8d. ESLint (JS/TS Linter) blocking on NO_TOOL_CALL
  fs.writeFileSync(path.join(sandboxRoot, "eslint.config.js"), "export default [];\n", "utf8");
  const nodeBinDir = path.join(sandboxRoot, "node_modules", ".bin");
  fs.mkdirSync(nodeBinDir, { recursive: true });
  const eslintBin = path.join(nodeBinDir, "eslint");
  const eslintPayload = JSON.stringify([
    {
      filePath: "src/index.js",
      errorCount: 1,
      warningCount: 0,
      messages: [
        {
          ruleId: "no-unused-vars",
          severity: 2,
          message: "'x' is assigned a value but never used.",
          line: 7,
          column: 10,
        },
      ],
    },
  ]).replace(/'/g, "'\\''");
  fs.writeFileSync(
    eslintBin,
    `#!/bin/sh\nprintf '%s\\n' '${eslintPayload}'\nexit 1\n`,
    { mode: 0o755 }
  );
  fs.chmodSync(eslintBin, 0o755);

  const eslintBlockRes = runCli(sandboxRoot, ["hook", "run", "--agent"], {
    input: JSON.stringify({ terminationReason: "NO_TOOL_CALL" }),
  });
  const eslintBlockJson = JSON.parse(eslintBlockRes.stdout.trim());
  assert.equal(eslintBlockJson.decision, "continue");
  assert.ok(eslintBlockJson.reason.includes("[eslint]"), "Reason should include [eslint]");
  assert.ok(eslintBlockJson.reason.includes("src/index.js:7:10"), "Reason should include src/index.js:7:10");
  assert.ok(eslintBlockJson.reason.includes("no-unused-vars"), "Reason should include no-unused-vars");
  assert.ok(eslintBlockJson.reason.includes("never used"), "Reason should include never used");

  // 8e. Clean pass when both Ruff and ESLint output []
  fs.writeFileSync(
    ruffBin,
    `#!/bin/sh\nprintf '%s\\n' '[]'\nexit 0\n`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    eslintBin,
    `#!/bin/sh\nprintf '%s\\n' '[]'\nexit 0\n`,
    { mode: 0o755 }
  );
  fs.chmodSync(ruffBin, 0o755);
  fs.chmodSync(eslintBin, 0o755);

  const linterCleanRes = runCli(sandboxRoot, ["hook", "run", "--agent"], {
    input: JSON.stringify({ terminationReason: "NO_TOOL_CALL" }),
  });
  assert.equal(linterCleanRes.status, 0);
  const linterCleanJson = JSON.parse(linterCleanRes.stdout.trim());
  assert.equal(linterCleanJson.decision, "stop");

  // 9. Git Worktree Metadata & Ghost Directory GC (harness hook install --git & harness clean --worktrees)
  assert.equal(
    spawnSync("git", ["init"], { cwd: sandboxRoot, encoding: "utf8", timeout: 5000 }).status,
    0
  );
  assert.equal(
    spawnSync("git", ["config", "user.name", "Harness Test"], { cwd: sandboxRoot, encoding: "utf8", timeout: 5000 }).status,
    0
  );
  assert.equal(
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: sandboxRoot, encoding: "utf8", timeout: 5000 }).status,
    0
  );
  assert.equal(
    spawnSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: sandboxRoot, encoding: "utf8", timeout: 5000 }).status,
    0
  );

  const externalContainer = path.join(sandboxRoot, "work", "wt-container");
  const wtGhostDir = path.join(externalContainer, "wt-ghost");
  const wtAddRes = spawnSync("git", ["worktree", "add", "-b", "feat/wt-ghost", wtGhostDir], {
    cwd: sandboxRoot,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(wtAddRes.status, 0, wtAddRes.stderr);

  const hookGitFromWtRes = runCli(wtGhostDir, ["hook", "install", "--git"]);
  assert.equal(hookGitFromWtRes.status, 0, hookGitFromWtRes.stderr);
  const refTxHookPath = path.join(sandboxRoot, ".git", "hooks", "reference-transaction");
  assert.equal(fs.existsSync(refTxHookPath), true, "reference-transaction hook should exist in common .git/hooks");
  assert.ok(
    (fs.statSync(refTxHookPath).mode & 0o111) !== 0,
    "reference-transaction hook must be executable"
  );

  const hookGitFromRootRes = runCli(sandboxRoot, ["hook", "install", "--git"]);
  assert.equal(hookGitFromRootRes.status, 0, hookGitFromRootRes.stderr);
  assert.equal(fs.existsSync(refTxHookPath), true);

  // PROP-06: Verify pre-commit hook exports node_modules/.bin, .venv/bin, and .cargo/bin
  const preCommitHookContent = fs.readFileSync(
    path.join(sandboxRoot, ".git", "hooks", "pre-commit"),
    "utf8"
  );
  assert.ok(preCommitHookContent.includes("$PWD/node_modules/.bin"));
  assert.ok(preCommitHookContent.includes("$PWD/.venv/bin"));
  assert.ok(preCommitHookContent.includes("$HOME/.cargo/bin"));
  assert.ok(preCommitHookContent.includes("--staged"));

  // Issue #1: Respect custom core.hooksPath and .git regular file (gitdir:) via `git rev-parse --git-path hooks`
  const customHooksDir = path.join(sandboxRoot, ".githooks");
  assert.equal(
    spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
      cwd: sandboxRoot,
      encoding: "utf8",
      timeout: 5000,
    }).status,
    0
  );
  const hookCustomGitRes = runCli(sandboxRoot, ["hook", "install", "--git"]);
  assert.equal(hookCustomGitRes.status, 0, hookCustomGitRes.stderr);
  const customPreCommitPath = path.join(customHooksDir, "pre-commit");
  const customRefTxPath = path.join(customHooksDir, "reference-transaction");
  assert.equal(
    fs.existsSync(customPreCommitPath),
    true,
    "harness hook install --git must install pre-commit into configured core.hooksPath (.githooks)"
  );
  assert.ok(
    (fs.statSync(customPreCommitPath).mode & 0o111) !== 0,
    "pre-commit hook in core.hooksPath must be executable"
  );
  assert.equal(
    fs.existsSync(customRefTxPath),
    true,
    "harness hook install --git must install reference-transaction into configured core.hooksPath (.githooks)"
  );
  assert.ok(
    (fs.statSync(customRefTxPath).mode & 0o111) !== 0,
    "reference-transaction hook in core.hooksPath must be executable"
  );

  // Also verify default `harness hook install` (without --git) respects core.hooksPath
  fs.rmSync(customHooksDir, { recursive: true, force: true });
  const hookCustomDefaultRes = runCli(sandboxRoot, ["hook", "install"]);
  assert.equal(hookCustomDefaultRes.status, 0, hookCustomDefaultRes.stderr);
  assert.equal(
    fs.existsSync(customPreCommitPath),
    true,
    "harness hook install must install pre-commit into configured core.hooksPath (.githooks)"
  );
  assert.equal(
    fs.existsSync(customRefTxPath),
    true,
    "harness hook install must install reference-transaction into configured core.hooksPath (.githooks)"
  );

  // Clean up core.hooksPath and .githooks, then verify `harness hook install` (without --git) inside linked worktree (.git regular file)
  assert.equal(
    spawnSync("git", ["config", "--unset", "core.hooksPath"], {
      cwd: sandboxRoot,
      encoding: "utf8",
      timeout: 5000,
    }).status,
    0
  );
  fs.rmSync(customHooksDir, { recursive: true, force: true });
  const commonPreCommitPath = path.join(sandboxRoot, ".git", "hooks", "pre-commit");
  fs.rmSync(commonPreCommitPath, { force: true });
  fs.rmSync(refTxHookPath, { force: true });
  assert.equal(
    fs.statSync(path.join(wtGhostDir, ".git")).isFile(),
    true,
    "Linked worktree .git must be a regular file (gitdir pointer)"
  );
  const hookDefaultFromWtRes = runCli(wtGhostDir, ["hook", "install"]);
  assert.equal(hookDefaultFromWtRes.status, 0, hookDefaultFromWtRes.stderr);
  assert.equal(
    fs.existsSync(commonPreCommitPath),
    true,
    "harness hook install inside linked worktree (.git file) must install pre-commit into resolved hooks dir"
  );
  assert.ok(
    (fs.statSync(commonPreCommitPath).mode & 0o111) !== 0,
    "pre-commit hook installed from linked worktree must be executable"
  );
  assert.equal(
    fs.existsSync(refTxHookPath),
    true,
    "harness hook install inside linked worktree (.git file) must install reference-transaction into resolved hooks dir"
  );
  assert.ok(
    (fs.statSync(refTxHookPath).mode & 0o111) !== 0,
    "reference-transaction hook installed from linked worktree must be executable"
  );
  fs.rmSync(path.join(wtGhostDir, ".agents"), { recursive: true, force: true });

  assert.equal(
    spawnSync("git", ["update-server-info"], { cwd: sandboxRoot, encoding: "utf8", timeout: 5000 }).status,
    0
  );
  const infoRefsPath = path.join(sandboxRoot, ".git", "info", "refs");
  assert.equal(fs.existsSync(infoRefsPath), true);
  assert.ok(fs.readFileSync(infoRefsPath, "utf8").includes("feat/wt-ghost"));

  const projectsConfigDir = path.join(sandboxRoot, "work", "projects-config");
  const customAgentWtContainer = path.join(
    sandboxRoot,
    "work",
    "custom-agent-worktrees",
    path.basename(sandboxRoot)
  );
  const strayAgentGhostDir = path.join(customAgentWtContainer, "orphan-agent-wt");
  const unrelatedExternalDir = path.join(sandboxRoot, "work", "unrelated-user-dir");
  const importantFilePath = path.join(unrelatedExternalDir, "important.txt");
  fs.mkdirSync(projectsConfigDir, { recursive: true });
  fs.mkdirSync(strayAgentGhostDir, { recursive: true });
  fs.mkdirSync(unrelatedExternalDir, { recursive: true });
  fs.writeFileSync(importantFilePath, "critical user data\n", "utf8");

  fs.mkdirSync(path.join(sandboxRoot, ".agents"), { recursive: true });
  fs.writeFileSync(
    path.join(sandboxRoot, ".agents", "harness.json"),
    JSON.stringify(
      {
        worktreeAgents: [
          {
            agent: "custom-agent",
            worktreeContainers: ["{repoRoot}/work/custom-agent-worktrees/{repo}"],
            projectRegistryDirs: ["{repoRoot}/work/projects-config"],
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );

  const projectJsonPath = path.join(projectsConfigDir, "test-project.json");
  fs.writeFileSync(
    projectJsonPath,
    JSON.stringify(
      {
        id: "test-project-id",
        name: "blackbox-test-repo",
        projectResources: {
          resources: [
            {
              gitFolder: {
                folderUri: pathToFileURL(sandboxRoot).href,
                defaultBranch: "feat/wt-ghost",
              },
            },
          ],
        },
        environments: {
          environments: [
            {
              id: "env-ghost",
              name: "wt-ghost",
              resources: {
                resources: [{ folderUri: pathToFileURL(wtGhostDir).href }],
              },
            },
            {
              id: "env-unrelated-external",
              name: "unrelated-user-dir",
              resources: {
                resources: [{ folderUri: pathToFileURL(unrelatedExternalDir).href }],
              },
            },
          ],
        },
      },
      null,
      2
    ),
    "utf8"
  );

  // Simulate messy worktree teardown: remove .git pointer file inside wt-ghost, leaving ghost directory and stale .git/worktrees/wt-ghost metadata
  fs.rmSync(path.join(wtGhostDir, ".git"), { force: true });
  const wtMetaDir = path.join(sandboxRoot, ".git", "worktrees", "wt-ghost");
  assert.equal(fs.existsSync(wtMetaDir), true, ".git/worktrees/wt-ghost should still exist before clean --worktrees");

  const cleanWtRes = runCli(sandboxRoot, ["clean", "--worktrees"]);
  assert.equal(cleanWtRes.status, 0, cleanWtRes.stderr);
  assert.equal(fs.existsSync(wtMetaDir), false, ".git/worktrees/wt-ghost should be pruned");
  assert.equal(fs.existsSync(wtGhostDir), false, "Orphaned ghost directory wt-ghost should be removed");
  assert.equal(fs.existsSync(externalContainer), false, "Now-empty parent container should be removed");
  assert.equal(
    fs.existsSync(strayAgentGhostDir),
    false,
    "Orphaned worktree inside declaratively configured agent worktreeContainers should be removed"
  );
  assert.equal(
    fs.existsSync(unrelatedExternalDir),
    true,
    "Directory referenced by stale environment outside worktreeContainerDirs must NOT be deleted"
  );
  assert.equal(
    fs.existsSync(importantFilePath),
    true,
    "Files inside directory outside worktreeContainerDirs must be preserved"
  );

  const afterGhostPruneProj = JSON.parse(fs.readFileSync(projectJsonPath, "utf8"));
  assert.equal(
    afterGhostPruneProj.environments,
    undefined,
    "Stale worktree environment should be removed from project config JSON"
  );

  const delBranchRes = spawnSync("git", ["branch", "-D", "feat/wt-ghost"], {
    cwd: sandboxRoot,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(delBranchRes.status, 0, delBranchRes.stderr);

  const cleanAfterBranchDelRes = runCli(sandboxRoot, ["clean", "--worktrees"]);
  assert.equal(cleanAfterBranchDelRes.status, 0, cleanAfterBranchDelRes.stderr);
  assert.equal(
    fs.readFileSync(infoRefsPath, "utf8").includes("feat/wt-ghost"),
    false,
    ".git/info/refs should no longer contain deleted branch feat/wt-ghost"
  );
  assert.equal(
    fs.existsSync(path.join(sandboxRoot, ".git", "refs", "heads", "feat")),
    false,
    "Empty ref namespace directory .git/refs/heads/feat should be removed"
  );
  const afterBranchDelProj = JSON.parse(fs.readFileSync(projectJsonPath, "utf8"));
  assert.notEqual(
    afterBranchDelProj.projectResources.resources[0].gitFolder.defaultBranch,
    "feat/wt-ghost",
    "defaultBranch pointing to a deleted branch should be reconciled to active main repo branch"
  );

  // 10. PROP-08: Worktree cleanup liveness protection (mtime cooldown & .git/index.lock guard)
  const coolingWtDir = path.join(customAgentWtContainer, "concurrent-checkout-wt");
  fs.mkdirSync(coolingWtDir, { recursive: true });
  fs.writeFileSync(path.join(coolingWtDir, "checking-out.txt"), "in progress\n", "utf8");
  const cleanCoolingRes = runCli(sandboxRoot, ["clean", "--worktrees"]);
  assert.equal(cleanCoolingRes.status, 0);
  assert.equal(
    fs.existsSync(coolingWtDir),
    true,
    "Non-empty worktree dir within mtime cooldown window must NOT be deleted"
  );

  // Also test .git/index.lock guard on empty dir
  const lockedEmptyWtDir = path.join(customAgentWtContainer, "locked-wt");
  fs.mkdirSync(lockedEmptyWtDir, { recursive: true });
  const gitIndexLock = path.join(sandboxRoot, ".git", "index.lock");
  fs.writeFileSync(gitIndexLock, "lock\n", "utf8");
  runCli(sandboxRoot, ["clean", "--worktrees"]);
  assert.equal(
    fs.existsSync(lockedEmptyWtDir),
    true,
    "Worktree GC must abort when .git/index.lock is active"
  );
  fs.rmSync(gitIndexLock, { force: true });
  fs.rmSync(coolingWtDir, { recursive: true, force: true });
  fs.rmSync(lockedEmptyWtDir, { recursive: true, force: true });

  // 11. PROP-07: worktreeSharedPaths auto-symlinking in linked Git worktrees
  fs.appendFileSync(path.join(sandboxRoot, ".gitignore"), "\ntests/fixtures/\n.env.test\n", "utf8");
  const mainFixturesDir = path.join(sandboxRoot, "tests", "fixtures");
  fs.mkdirSync(mainFixturesDir, { recursive: true });
  fs.writeFileSync(path.join(mainFixturesDir, "sample.json"), '{"id":1}\n', "utf8");
  fs.writeFileSync(path.join(sandboxRoot, ".env.test"), "TEST_MODE=1\n", "utf8");
  fs.writeFileSync(
    path.join(sandboxRoot, ".agents", "harness.json"),
    JSON.stringify(
      {
        worktreeSharedPaths: ["tests/fixtures", ".env.test"],
      },
      null,
      2
    ),
    "utf8"
  );
  const linkedWtDir = path.join(sandboxRoot, "work", "wt-shared-test");
  assert.equal(
    spawnSync("git", ["worktree", "add", "-b", "feat/wt-shared", linkedWtDir], {
      cwd: sandboxRoot,
      encoding: "utf8",
      timeout: 5000,
    }).status,
    0
  );
  assert.equal(fs.existsSync(path.join(linkedWtDir, "tests", "fixtures", "sample.json")), false);
  assert.equal(fs.existsSync(path.join(linkedWtDir, ".env.test")), false);

  const runInWtRes = runCli(linkedWtDir, ["run", "check-shared", "--", "node", "-e", "process.exit(0)"]);
  assert.equal(runInWtRes.status, 0, runInWtRes.stderr);
  assert.equal(
    fs.existsSync(path.join(linkedWtDir, "tests", "fixtures", "sample.json")),
    true,
    "tests/fixtures should be auto-symlinked into linked worktree"
  );
  assert.equal(
    fs.lstatSync(path.join(linkedWtDir, "tests", "fixtures")).isSymbolicLink(),
    true
  );
  assert.equal(
    fs.existsSync(path.join(linkedWtDir, ".env.test")),
    true,
    ".env.test should be auto-symlinked into linked worktree"
  );
  spawnSync("git", ["worktree", "remove", "--force", linkedWtDir], {
    cwd: sandboxRoot,
    encoding: "utf8",
    timeout: 5000,
  });
  spawnSync("git", ["branch", "-D", "feat/wt-shared"], {
    cwd: sandboxRoot,
    encoding: "utf8",
    timeout: 5000,
  });

  // 12. PROP-09 (DIR001) & PROP-11 (Git-aware dynamic scanner)
  const rogueResearchDir = path.join(sandboxRoot, "docs", "research");
  const rogueAssetsDir = path.join(sandboxRoot, "docs", "assets");
  fs.mkdirSync(rogueResearchDir, { recursive: true });
  fs.mkdirSync(rogueAssetsDir, { recursive: true });
  fs.writeFileSync(path.join(rogueResearchDir, "notes.md"), "# Notes\n", "utf8");
  fs.writeFileSync(path.join(rogueAssetsDir, "diagram.svg"), "<svg/>\n", "utf8");
  const rogueRootPng = path.join(sandboxRoot, "frame_00.png");
  fs.writeFileSync(rogueRootPng, "binary-png-data", "utf8");

  const dir001Report = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.ok(
    dir001Report.diagnostics.some((d) => d.code === "DIR001" && d.file === "docs/research"),
    "Unauthorized docs/research/ directory must trigger DIR001"
  );
  assert.ok(
    dir001Report.diagnostics.some((d) => d.code === "DIR001" && d.file === "docs/assets"),
    "Non-standard docs/assets/ directory must trigger DIR001 (only the 5 standard docs/ subdirectories are allowed)"
  );
  const rootPngDiag = dir001Report.diagnostics.find(
    (d) => d.code === "DIR001" && d.file === "frame_00.png"
  );
  assert.ok(rootPngDiag, "Stray root binary screenshot frame_00.png must trigger DIR001");
  assert.ok(
    rootPngDiag.fix &&
      rootPngDiag.fix.includes("docs/reference/") &&
      !rootPngDiag.fix.includes("docs/assets/"),
    "Root binary file DIR001 fix hint must suggest 'docs/reference/' or 'work/' rather than 'docs/assets/'"
  );

  // Allowing frame_*.png via rootAllowlist in .agents/harness.json clears root DIR001
  fs.rmSync(rogueResearchDir, { recursive: true, force: true });
  fs.rmSync(rogueAssetsDir, { recursive: true, force: true });
  fs.writeFileSync(
    path.join(sandboxRoot, ".agents", "harness.json"),
    JSON.stringify({ rootAllowlist: ["frame_*.png"] }, null, 2),
    "utf8"
  );
  const allowRootReport = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.equal(
    allowRootReport.diagnostics.some((d) => d.code === "DIR001"),
    false,
    "rootAllowlist pattern frame_*.png should allow frame_00.png"
  );
  fs.rmSync(rogueRootPng, { force: true });

  // PROP-11: Git-ignored custom directory with broken links must NOT be scanned by doctor
  fs.appendFileSync(path.join(sandboxRoot, ".gitignore"), "\ncustom_venv/\n", "utf8");
  const customVenvDir = path.join(sandboxRoot, "custom_venv");
  fs.mkdirSync(customVenvDir, { recursive: true });
  fs.writeFileSync(
    path.join(customVenvDir, "broken.md"),
    "根据你的要求 see [dead](missing.md)\n",
    "utf8"
  );
  const gitAwareReport = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.equal(
    gitAwareReport.diagnostics.length,
    0,
    "Git-ignored directory custom_venv/ must not trigger DIR001, LNK001, or VOX001"
  );
  fs.rmSync(customVenvDir, { recursive: true, force: true });

  // 13. PROP-05 (TST001 Multi-Language TS/Vitest Extension) & PROP-12 (TST004 Subprocess Timeout Guard)
  for (const badTsName of ["test1.test.ts", "test_phase2.spec.ts"]) {
    const p = path.join(testsDir, badTsName);
    fs.writeFileSync(
      p,
      'describe("TestCompiler", () => { it("test_input_renders_html", () => {}); });\n',
      "utf8"
    );
    const rep = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
    assert.ok(
      rep.diagnostics.some((d) => d.code === "TST001" && d.file.endsWith(badTsName)),
      `Expected ${badTsName} to trigger TST001`
    );
    fs.rmSync(p, { force: true });
  }

  const tsTestFile = path.join(testsDir, "compiler.test.ts");
  fs.writeFileSync(
    tsTestFile,
    'describe("Compiler", () => {\n  it("renders \'bold\' text", () => {});\n});\n',
    "utf8"
  );
  const badTsHierarchyReport = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.ok(
    badTsHierarchyReport.diagnostics.some(
      (d) => d.code === "TST001" && d.message.includes('describe("Test<Subject>"')
    ),
    'Missing describe("Test<Subject>") in TS test should trigger TST001'
  );
  assert.ok(
    badTsHierarchyReport.diagnostics.some(
      (d) => d.code === "TST001" && d.message.includes("renders 'bold' text")
    ),
    'Non-conforming it("renders \'bold\' text") with embedded single quotes in TS test should trigger TST001'
  );

  // JS/TS test file with NO describe() or it() blocks at all must also trigger TST001
  fs.writeFileSync(tsTestFile, 'import assert from "node:assert/strict";\nassert.equal(1, 1);\n', "utf8");
  const zeroDescribeReport = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.ok(
    zeroDescribeReport.diagnostics.some(
      (d) => d.code === "TST001" && d.file.endsWith("compiler.test.ts")
    ),
    "JS/TS test file without describe('Test<Subject>') + it('test_...') must trigger TST001"
  );

  // Multiline describe(\n "Test...", ...) and second non-conforming top-level describe("BadSuite", ...)
  fs.writeFileSync(
    tsTestFile,
    'describe(\n  "TestCompiler",\n  () => {\n    it(\n      "bad multiline name",\n      () => {}\n    );\n  }\n);\ndescribe("BadSuite", () => {\n  it("test_valid_case_passes", () => {});\n});\n',
    "utf8"
  );
  const multilineTsReport = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.ok(
    multilineTsReport.diagnostics.some(
      (d) => d.code === "TST001" && d.message.includes("'BadSuite'")
    ),
    "Second top-level describe('BadSuite') must trigger TST001 even when first describe is valid"
  );
  assert.ok(
    multilineTsReport.diagnostics.some(
      (d) => d.code === "TST001" && d.message.includes("bad multiline name")
    ),
    "Multiline it(\\n 'bad multiline name', ...) must trigger TST001"
  );

  // Valid TS test hierarchy + regex literal containing backtick/quote + TST004 subprocess without timeout check
  fs.writeFileSync(
    tsTestFile,
    'import { spawnSync } from "node:child_process";\nconst fenceRe = /`/;\nconst quoteRe = /\'/;\ndescribe("TestCompiler", () => {\n  it("test_cjk_delimiter_renders_strong_tag", () => {\n    if (fenceRe.test("`") && !quoteRe.test("x")) {\n      spawnSync("curl", ["--connect-timeout=5", "https://example.com"]);\n    }\n  });\n});\n',
    "utf8"
  );
  const tst004FailReport = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.equal(
    tst004FailReport.diagnostics.some((d) => d.code === "TST001"),
    false,
    "Valid TS describe('TestCompiler') + it('test_cjk_delimiter_renders_strong_tag') must pass TST001"
  );
  assert.ok(
    tst004FailReport.diagnostics.some((d) => d.code === "TST004"),
    "spawnSync without timeout option after regex literal /`/ must still trigger TST004 (regex literal must not desynchronize string masking)"
  );

  // Adding timeout option and RegExp.prototype.test("...") calls resolves TST004 and passes TST001 without false positives
  fs.writeFileSync(
    tsTestFile,
    'import { spawnSync } from "node:child_process";\nconst slugPattern = /^[a-z0-9-]+$/;\ndescribe("TestCompiler", () => {\n  it("test_cjk_delimiter_renders_strong_tag", () => {\n    if (/^bold$/.test("bold") && slugPattern.test("valid-slug")) {\n      spawnSync(\n        "sh",\n        ["-c", "case $x in a) echo ok ;; esac"],\n        { timeout: 5000 }\n      );\n    }\n  });\n});\n',
    "utf8"
  );
  const tst004PassReport = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.equal(
    tst004PassReport.diagnostics.some((d) => d.code === "TST001"),
    false,
    "RegExp.prototype.test('...') inside TS test file must NOT trigger false-positive TST001"
  );
  assert.equal(
    tst004PassReport.diagnostics.some((d) => d.code === "TST004"),
    false,
    "spawnSync with explicit timeout and unmatched ')' inside string arg must pass TST004"
  );
  fs.rmSync(tsTestFile, { force: true });

  // 14. PROP-01 (TST003 Protected Verifier/Baseline Paths) & PROP-02 (MTX001 Protected Matrix Immutable Columns)
  const verifierFile = path.join(sandboxRoot, "tests", "verifiers", "wechat", "verifier.js");
  fs.mkdirSync(path.dirname(verifierFile), { recursive: true });
  fs.writeFileSync(verifierFile, "// official baseline verifier\nexport const verify = () => true;\n", "utf8");

  const matrixFile = path.join(sandboxRoot, "docs", "runbooks", "source-adaptation-matrix.csv");
  fs.writeFileSync(
    matrixFile,
    'source_id,官方入口 URL,notes,status\ndd-uk,https://www.legislation.gov.uk/all,"official index, line 1\nline 2",pending\ndd-us,https://uscode.house.gov/browse,"us code",pending\n',
    "utf8"
  );

  fs.writeFileSync(
    path.join(sandboxRoot, ".agents", "harness.json"),
    JSON.stringify(
      {
        protectedPaths: ["tests/verifiers/**"],
        protectedMatrices: [
          {
            path: "docs/runbooks/source-adaptation-matrix.csv",
            immutableColumns: ["source_id", "官方入口 URL"],
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );

  // Untracked file inside protectedPaths must trigger TST003 even before git add
  const preStageReport = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.ok(
    preStageReport.diagnostics.some(
      (d) => d.code === "TST003" && d.file === "tests/verifiers/wechat/verifier.js"
    ),
    "Untracked file inside protectedPaths must trigger TST003 before staging"
  );

  assert.equal(
    spawnSync("git", ["add", "-A"], { cwd: sandboxRoot, encoding: "utf8", timeout: 5000 }).status,
    0
  );
  // Without HARNESS_ALLOW_PROTECTED=1, pre-commit hook blocks committing changes to protectedPaths
  assert.equal(
    spawnSync("git", ["commit", "-m", "chore: lock verifiers and matrix baseline"], {
      cwd: sandboxRoot,
      encoding: "utf8",
      timeout: 5000,
    }).status,
    1,
    "pre-commit hook must block committing protectedPaths without HARNESS_ALLOW_PROTECTED=1"
  );
  // With HARNESS_ALLOW_PROTECTED=1, initial baseline commit is authorized
  assert.equal(
    spawnSync("git", ["commit", "-m", "chore: lock verifiers and matrix baseline"], {
      cwd: sandboxRoot,
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, HARNESS_ALLOW_PROTECTED: "1" },
    }).status,
    0
  );
  assert.equal(runCli(sandboxRoot, ["doctor"]).status, 0);

  // Inserting a new row at the top of the protected CSV while keeping baseline rows intact must NOT trigger MTX001
  fs.writeFileSync(
    matrixFile,
    'source_id,官方入口 URL,notes,status\ndd-new,https://new.example.gov/index,"new source",pending\ndd-uk,https://www.legislation.gov.uk/all,"official index, line 1\nline 2",adapted\ndd-us,https://uscode.house.gov/browse,"us code",pending\n',
    "utf8"
  );
  const insertedRowReport = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.equal(
    insertedRowReport.diagnostics.some((d) => d.code === "MTX001"),
    false,
    "Inserting a new row at the top of a protected CSV must NOT trigger false-positive MTX001 when baseline rows are intact"
  );

  // Tamper with protected verifier (even adding // harness-ignore TST003 inside it!) and immutable matrix URL column (with inserted row at top)
  fs.writeFileSync(
    verifierFile,
    "// harness-ignore TST003: agent attempting to self-authorize verifier edit\nexport const verify = () => true;\n",
    "utf8"
  );
  fs.writeFileSync(
    matrixFile,
    'source_id,官方入口 URL,notes,status\ndd-new,https://new.example.gov/index,"new source",pending\ndd-uk,https://example.com/single-article.html,"updated note, line 1\nline 2",adapted\ndd-us,https://uscode.house.gov/browse,"us code",pending\n',
    "utf8"
  );

  const tamperReport = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.ok(
    tamperReport.diagnostics.some(
      (d) => d.code === "TST003" && d.file === "tests/verifiers/wechat/verifier.js"
    ),
    "Modifying protected verifier file must trigger TST003 even if // harness-ignore TST003 is injected into the file"
  );
  assert.ok(
    tamperReport.diagnostics.some(
      (d) =>
        d.code === "MTX001" &&
        d.file === "docs/runbooks/source-adaptation-matrix.csv" &&
        d.message.includes("官方入口 URL") &&
        d.message.includes("https://www.legislation.gov.uk/all")
    ),
    "Modifying immutable column '官方入口 URL' on a shifted row must trigger MTX001 with the matched row's HEAD value"
  );

  // HARNESS_ALLOW_PROTECTED=1 bypasses both TST003 and MTX001 when maintainer authorizes baseline update
  const bypassReport = JSON.parse(
    runCli(sandboxRoot, ["doctor", "--json"], {
      env: { ...process.env, HARNESS_ALLOW_PROTECTED: "1" },
    }).stdout
  );
  assert.equal(
    bypassReport.diagnostics.some((d) => d.code === "TST003" || d.code === "MTX001"),
    false,
    "HARNESS_ALLOW_PROTECTED=1 must bypass both TST003 and MTX001"
  );

  // Running harness hook run --agent auto-reverts tampered matrix cell while preserving the newly inserted top row, multiline 'notes', and 'status'
  const mtxHookRes = runCli(sandboxRoot, ["hook", "run", "--agent"], {
    input: JSON.stringify({ terminationReason: "NO_TOOL_CALL" }),
  });
  assert.equal(mtxHookRes.status, 2);
  const mtxHookJson = JSON.parse(mtxHookRes.stdout.trim());
  assert.equal(mtxHookJson.decision, "continue");
  assert.ok(mtxHookJson.reason.includes("[MTX001]"));
  assert.ok(mtxHookJson.reason.includes("Auto-reverted"));

  const revertedMatrixContent = fs.readFileSync(matrixFile, "utf8");
  assert.ok(
    revertedMatrixContent.includes('dd-new,https://new.example.gov/index,"new source",pending'),
    "Hook must preserve newly inserted row at the top of the CSV when reverting tampered baseline row"
  );
  assert.ok(
    revertedMatrixContent.includes("https://www.legislation.gov.uk/all"),
    "Hook must auto-revert tampered '官方入口 URL' cell back to HEAD value"
  );
  assert.ok(
    revertedMatrixContent.includes('"updated note, line 1\nline 2",adapted'),
    "Hook must preserve RFC-4180 multiline quoted cell and mutable 'status' column when reverting immutable column"
  );

  // Revert verifier and matrix files and verify clean pass
  spawnSync(
    "git",
    [
      "checkout",
      "HEAD",
      "--",
      "tests/verifiers/wechat/verifier.js",
      "docs/runbooks/source-adaptation-matrix.csv",
    ],
    {
      cwd: sandboxRoot,
      encoding: "utf8",
      timeout: 5000,
    }
  );
  assert.equal(runCli(sandboxRoot, ["doctor"]).status, 0);

  // 15. PROP-12: AST001 (Declarative Layer Dependency Guard) & AST002 (Core Cleanliness Guard)
  const cleanerPy = path.join(sandboxRoot, "src", "wlh", "cleaners", "text.py");
  const cleanerSubTs = path.join(sandboxRoot, "src", "wlh", "cleaners", "sub", "dom.ts");
  const parserPy = path.join(sandboxRoot, "src", "wlh", "processor", "html.py");
  const parserCommentPy = path.join(sandboxRoot, "src", "wlh", "processor", "safe.py");
  fs.mkdirSync(path.dirname(cleanerSubTs), { recursive: true });
  fs.mkdirSync(path.dirname(parserPy), { recursive: true });
  // Test Python `from wlh import processor`
  fs.writeFileSync(
    cleanerPy,
    "from wlh import processor\n\ndef clean(t):\n    return t\n",
    "utf8"
  );
  // Test JS/TS `export const a = "from x";` and un-semicoloned `export { a }` preceding multiline `import {\n  parseDoc,\n} from "../../processor/html"`
  fs.writeFileSync(
    cleanerSubTs,
    'export const a = "from x";\nexport { a }\nimport {\n  parseDoc,\n} from "../../processor/html";\nexport const cleanDom = () => parseDoc();\n',
    "utf8"
  );
  fs.writeFileSync(
    parserPy,
    'from wlh.cleaners.text import clean\n\nSITE_RULE = "dd-uk-101"\n',
    "utf8"
  );
  // Comment mentioning dd-uk-101 and docstring containing fake import must NOT trigger false-positive AST001/AST002
  fs.writeFileSync(
    parserCommentPy,
    '"""\nfrom wlh.unknown_layer import forbidden\n"""\n# Historical note: site rules like dd-uk-101 belong in adapters, not here\nexport_flag = True\n',
    "utf8"
  );

  fs.writeFileSync(
    path.join(sandboxRoot, ".agents", "harness.json"),
    JSON.stringify(
      {
        architecture: {
          layers: [
            { name: "cleaners", path: "src/wlh/cleaners/**", allowImportsFrom: [] },
            { name: "parsers", path: "src/wlh/processor/**", allowImportsFrom: ["cleaners"] },
          ],
          coreCleanliness: [
            {
              paths: ["src/wlh/processor/**"],
              forbiddenPatterns: ["\\bdd-[a-z0-9-]+\\b"],
            },
          ],
        },
      },
      null,
      2
    ),
    "utf8"
  );

  const astReport = JSON.parse(runCli(sandboxRoot, ["doctor", "--json"]).stdout);
  assert.ok(
    astReport.diagnostics.some(
      (d) => d.code === "AST001" && d.file === "src/wlh/cleaners/text.py"
    ),
    "Disallowed Python `from wlh import processor` from cleaners -> parsers must trigger AST001"
  );
  assert.ok(
    astReport.diagnostics.some(
      (d) =>
        d.code === "AST001" &&
        d.file === "src/wlh/cleaners/sub/dom.ts" &&
        d.line === 3
    ),
    "Disallowed multiline TS import after `export const a = 'from x';` and `export { a }` from cleaners/sub -> processor must trigger AST001 at line 3"
  );
  assert.equal(
    astReport.diagnostics.some(
      (d) => d.code === "AST001" && d.file === "src/wlh/processor/html.py"
    ),
    false,
    "Allowed import from parsers -> cleaners must NOT trigger AST001"
  );
  assert.ok(
    astReport.diagnostics.some(
      (d) => d.code === "AST002" && d.file === "src/wlh/processor/html.py"
    ),
    "Forbidden pattern dd-uk-101 in core processor module code must trigger AST002"
  );
  assert.equal(
    astReport.diagnostics.some(
      (d) => d.code === "AST002" && d.file === "src/wlh/processor/safe.py"
    ),
    false,
    "Comment mentioning dd-uk-101 in core module must NOT trigger false-positive AST002"
  );

  fs.rmSync(path.join(sandboxRoot, "src"), { recursive: true, force: true });
  fs.writeFileSync(path.join(sandboxRoot, ".agents", "harness.json"), "{}\n", "utf8");

  // 16. PROP-10: Incremental formatting gate (ruff format --check & prettier --check + --staged)
  fs.writeFileSync(
    ruffBin,
    `#!/bin/sh\nif [ "$1" = "format" ]; then\n  for arg in "$@"; do\n    if [ "$arg" = "src/unstaged_bad.py" ] || [ "$arg" = "src/app.py" ]; then\n      echo "Would reformat: $arg"\n      exit 1\n    fi\n  done\n  exit 0\nfi\nprintf '%s\\n' '[]'\nexit 0\n`,
    { mode: 0o755 }
  );
  fs.chmodSync(ruffBin, 0o755);
  fs.mkdirSync(path.join(sandboxRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(sandboxRoot, "src", "app.py"), "x=1\n", "utf8");

  const ruffFmtBlockRes = runCli(sandboxRoot, ["hook", "run", "--agent"], {
    input: JSON.stringify({ terminationReason: "NO_TOOL_CALL" }),
  });
  const ruffFmtJson = JSON.parse(ruffFmtBlockRes.stdout.trim());
  assert.equal(ruffFmtJson.decision, "continue");
  assert.ok(
    ruffFmtJson.reason.includes("[ruff-format]") && ruffFmtJson.reason.includes("src/app.py"),
    "Unformatted Python file must be blocked by [ruff-format] in hook"
  );

  // Test `--staged`: staged formatted file `src/staged_good.py` passes `--staged` even when `src/unstaged_bad.py` is unformatted in working tree
  fs.rmSync(path.join(sandboxRoot, "src", "app.py"), { force: true });
  fs.writeFileSync(path.join(sandboxRoot, "src", "staged_good.py"), "x = 1\n", "utf8");
  fs.writeFileSync(path.join(sandboxRoot, "src", "unstaged_bad.py"), "y=2\n", "utf8");
  assert.equal(
    spawnSync("git", ["add", "src/staged_good.py"], {
      cwd: sandboxRoot,
      encoding: "utf8",
      timeout: 5000,
    }).status,
    0
  );
  const stagedOnlyPassRes = runCli(sandboxRoot, ["hook", "run", "--staged"]);
  assert.equal(
    stagedOnlyPassRes.status,
    0,
    `harness hook run --staged must pass when staged file is clean even if unstaged file is unformatted: ${stagedOnlyPassRes.stderr}`
  );
  // Once unstaged_bad.py is staged, `harness hook run --staged` must fail
  assert.equal(
    spawnSync("git", ["add", "src/unstaged_bad.py"], {
      cwd: sandboxRoot,
      encoding: "utf8",
      timeout: 5000,
    }).status,
    0
  );
  const stagedBadFailRes = runCli(sandboxRoot, ["hook", "run", "--staged"]);
  assert.equal(
    stagedBadFailRes.status,
    1,
    "harness hook run --staged must fail when an unformatted Python file is staged"
  );
  assert.ok(stagedBadFailRes.stderr.includes("src/unstaged_bad.py"));
  spawnSync("git", ["reset", "HEAD", "--", "src/staged_good.py", "src/unstaged_bad.py"], {
    cwd: sandboxRoot,
    encoding: "utf8",
    timeout: 5000,
  });
  fs.rmSync(path.join(sandboxRoot, "src", "staged_good.py"), { force: true });
  fs.rmSync(path.join(sandboxRoot, "src", "unstaged_bad.py"), { force: true });

  // Restore clean ruff mock and test prettier --check via node_modules/.bin/prettier
  fs.writeFileSync(
    ruffBin,
    `#!/bin/sh\nprintf '%s\\n' '[]'\nexit 0\n`,
    { mode: 0o755 }
  );
  fs.chmodSync(ruffBin, 0o755);

  const prettierNodeBinDir = path.join(sandboxRoot, "node_modules", ".bin");
  fs.mkdirSync(prettierNodeBinDir, { recursive: true });
  const prettierBin = path.join(prettierNodeBinDir, "prettier");
  fs.writeFileSync(
    prettierBin,
    `#!/bin/sh\necho "[warn] src/ui.ts"\necho "[warn] Code style issues found in the above file. Run Prettier with --write to fix."\nexit 1\n`,
    { mode: 0o755 }
  );
  fs.chmodSync(prettierBin, 0o755);
  fs.writeFileSync(path.join(sandboxRoot, ".prettierrc"), "{}\n", "utf8");
  fs.writeFileSync(path.join(sandboxRoot, "src", "ui.ts"), "export const x=1;\n", "utf8");

  const prettierBlockRes = runCli(sandboxRoot, ["hook", "run", "--agent"], {
    input: JSON.stringify({ terminationReason: "NO_TOOL_CALL" }),
  });
  const prettierJson = JSON.parse(prettierBlockRes.stdout.trim());
  assert.equal(prettierJson.decision, "continue");
  assert.ok(
    prettierJson.reason.includes("[prettier]") && prettierJson.reason.includes("src/ui.ts"),
    "Unformatted TS file must be blocked by [prettier] in hook"
  );

  fs.rmSync(path.join(sandboxRoot, "node_modules"), { recursive: true, force: true });
  fs.rmSync(path.join(sandboxRoot, ".prettierrc"), { force: true });
  fs.rmSync(path.join(sandboxRoot, "src"), { recursive: true, force: true });

  // 17. PROP-03 (harness tdd verify) & PROP-04 (harness sync auto-installs .agents/hooks.json)
  fs.mkdirSync(path.join(sandboxRoot, "src"), { recursive: true });
  const calcPath = path.join(sandboxRoot, "src", "calc.js");
  fs.writeFileSync(calcPath, "export function multiply(a, b) { return 0; }\n", "utf8");
  assert.equal(
    spawnSync("git", ["add", "-A"], { cwd: sandboxRoot, encoding: "utf8", timeout: 5000 }).status,
    0
  );
  assert.equal(
    spawnSync("git", ["commit", "-m", "feat: stub multiply"], {
      cwd: sandboxRoot,
      encoding: "utf8",
      timeout: 5000,
    }).status,
    0
  );

  // Modify implementation, add a new subpackage directory, and write real test checking both
  fs.writeFileSync(calcPath, "export function multiply(a, b) { return a * b; }\n", "utf8");
  const newPkgFile = path.join(sandboxRoot, "src", "newpkg", "helper.js");
  fs.mkdirSync(path.dirname(newPkgFile), { recursive: true });
  fs.writeFileSync(newPkgFile, "export const READY = true;\n", "utf8");

  const calcTestPath = path.join(testsDir, "calc.test.mjs");
  fs.writeFileSync(
    calcTestPath,
    'import fs from "node:fs";\nimport assert from "node:assert/strict";\nimport { multiply } from "../src/calc.js";\nassert.equal(fs.existsSync("./src/newpkg"), true, "newpkg dir must not exist during Red phase");\nassert.equal(multiply(6, 7), 42);\n',
    "utf8"
  );

  const tddPassRes = runCli(sandboxRoot, [
    "tdd",
    "verify",
    "--test",
    "node ./tests/calc.test.mjs",
  ]);
  assert.equal(tddPassRes.status, 0, tddPassRes.stderr);
  assert.ok(tddPassRes.stdout.includes("Red-Green TDD contract verified"));
  assert.equal(
    fs.existsSync(newPkgFile),
    true,
    "Newly created implementation file and parent directory must be restored after tdd verify"
  );

  // Tautological test that passes even on old baseline MUST fail Red Check in harness tdd verify
  fs.writeFileSync(calcTestPath, 'import assert from "node:assert/strict";\nassert.equal(1, 1);\n', "utf8");
  const tddFailRedRes = runCli(sandboxRoot, [
    "tdd",
    "verify",
    "--test",
    "node ./tests/calc.test.mjs",
  ]);
  assert.equal(tddFailRedRes.status, 1, "Tautological test must fail harness tdd verify Red Check");
  assert.ok(tddFailRedRes.stderr.includes("Red Check failed"));

  // Verify implementation file was faithfully restored after Red Check failure
  assert.ok(
    fs.readFileSync(calcPath, "utf8").includes("return a * b;"),
    "Implementation file must be restored after tdd verify"
  );

  // PROP-04: Verify harness sync automatically ensures .agents/hooks.json exists
  fs.rmSync(path.join(sandboxRoot, ".agents", "hooks.json"), { force: true });
  assert.equal(runCli(sandboxRoot, ["sync"]).status, 0);
  assert.equal(
    fs.existsSync(path.join(sandboxRoot, ".agents", "hooks.json")),
    true,
    "harness sync must automatically configure .agents/hooks.json Stop hook"
  );

  console.log("✓ All black-box integration contract tests passed.");
    } finally {
      // Clean up test sandbox
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });
});

