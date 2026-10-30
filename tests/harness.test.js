// harness-ignore TST002: black-box test fixture generator for TST002 rule
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CLI_BIN = path.join(REPO_ROOT, "bin/harness.js");

function runCli(cwd, args, options = {}) {
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd,
    encoding: "utf8",
    ...options,
  });
}

function main() {
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
  fs.mkdirSync(expiredWork, { recursive: true });
  fs.mkdirSync(freshWork, { recursive: true });
  const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000);
  fs.utimesSync(expiredWork, twoDaysAgo, twoDaysAgo);

  const hookAgentRes = runCli(sandboxRoot, ["hook", "run", "--agent"]);
  assert.equal(hookAgentRes.status, 2);
  assert.equal(fs.existsSync(expiredWork), false, "Expired work dir should be auto-cleaned by hook");
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

  console.log("✓ All black-box integration contract tests passed.");
  } finally {
    // Clean up test sandbox
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
}

main();
