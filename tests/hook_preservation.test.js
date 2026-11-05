import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// Failure boundaries: upgrading a legacy hook must retain user commands on both
// sides; reinstalling must not duplicate their execution or break Git invocation.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidence = path.resolve(process.env.HARNESS_ARTIFACTS_DIR || path.join(root, "artifacts", "regressions"));
// Fixed public legacy script format captured before the migration fix. Deliberately
// has no PATH export and no end marker; never derive old input from new output.
const legacyHooks = {
  "pre-commit": `#!/usr/bin/env sh
set -e

# yoryon-harness pre-commit hook
if command -v harness >/dev/null 2>&1; then
  harness hook run --staged
elif [ -f "./bin/harness.js" ]; then
  node ./bin/harness.js hook run --staged
fi
`,
  "reference-transaction": `#!/usr/bin/env sh

# yoryon-harness reference-transaction hook
if [ "$1" = "committed" ]; then
  if command -v harness >/dev/null 2>&1; then
    harness clean --worktrees --quiet >/dev/null 2>&1 || true
  elif [ -f "./bin/harness.js" ]; then
    node ./bin/harness.js clean --worktrees --quiet >/dev/null 2>&1 || true
  fi
fi
`,
};

function run(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 30000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result;
}

describe("TestHookPreservation", () => {
  for (const name of ["pre-commit", "reference-transaction"]) {
    it("test_legacy_hook_upgrade_preserves_user_commands", () => {
      fs.mkdirSync(path.join(root, "work"), { recursive: true });
      fs.mkdirSync(evidence, { recursive: true });
      const cwd = fs.mkdtempSync(path.join(root, "work", "hook-preservation-"));
      const report = { hook: name, command: "node --test tests/hook_preservation.test.js", node: process.version, assertions: [] };
      try {
        run(cwd, "git", ["init", "-q"]);
        run(cwd, process.execPath, [path.join(root, "bin/harness.js"), "init"]);
        run(cwd, process.execPath, [path.join(root, "bin/harness.js"), "hook", "install", "--git"]);
        const hook = path.join(cwd, ".git", "hooks", name);
        const legacy = legacyHooks[name];
        fs.writeFileSync(hook, legacy.replace("#!/usr/bin/env sh\n", "#!/usr/bin/env sh\nprintf 'before\\n' >> work/user-hook.log\n") + "\nprintf 'after\\n' >> work/user-hook.log\n");
        for (let attempt = 0; attempt < 2; attempt++) {
          run(cwd, process.execPath, [path.join(root, "bin/harness.js"), "hook", "install", "--git"]);
          const result = run(cwd, "git", ["-c", "core.hooksPath=.git/hooks", "hook", "run", name, ...(name === "reference-transaction" ? ["--", "committed"] : [])]);
          const log = path.join(cwd, "work", "user-hook.log");
          const actual = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
          report.assertions.push({ attempt, actual, status: result.status });
          assert.equal(actual, "before\nafter\n".repeat(attempt + 1), "user commands must execute once, in order, after every upgrade");
        }
        report.passed = true;
      } catch (error) {
        report.passed = false;
        report.failure = error.message;
        throw error;
      } finally {
        fs.writeFileSync(path.join(evidence, `hook-${name}.json`), JSON.stringify(report, null, 2));
      }
    });
  }
  it("test_unknown_legacy_hook_refuses_upgrade_without_modifying_bytes", () => {
    fs.mkdirSync(path.join(root, "work"), { recursive: true });
    fs.mkdirSync(evidence, { recursive: true });
    const cwd = fs.mkdtempSync(path.join(root, "work", "hook-unknown-"));
    run(cwd, "git", ["init", "-q"]);
    run(cwd, process.execPath, [path.join(root, "bin/harness.js"), "init"]);
    run(cwd, process.execPath, [path.join(root, "bin/harness.js"), "hook", "install", "--git"]);
    const hook = path.join(cwd, ".git", "hooks", "pre-commit");
    const original = legacyHooks["pre-commit"].replace("  harness hook run --staged", "  printf 'custom logic\\n'\n  harness hook run --staged");
    fs.writeFileSync(hook, original);
    const result = spawnSync(process.execPath, [path.join(root, "bin/harness.js"), "hook", "install", "--git"], { cwd, encoding: "utf8", timeout: 30000 });
    const unchanged = fs.readFileSync(hook, "utf8") === original;
    const report = { command: "node --test tests/hook_preservation.test.js", node: process.version, status: result.status, unchanged, passed: result.status !== 0 && unchanged };
    fs.writeFileSync(path.join(evidence, "hook-unknown.json"), JSON.stringify(report, null, 2));
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, "unrecognized managed content must reject installation");
    assert.equal(unchanged, true, "rejected migration must leave original hook bytes intact");
  });

});
