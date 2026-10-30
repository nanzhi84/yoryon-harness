import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CLI_BIN = path.join(REPO_ROOT, "bin/harness.js");

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function main() {
  const sandboxRoot = path.join(REPO_ROOT, "work", "blackbox-test-repo");
  fs.rmSync(sandboxRoot, { recursive: true, force: true });
  fs.mkdirSync(sandboxRoot, { recursive: true });

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

  // Clean up test sandbox
  fs.rmSync(sandboxRoot, { recursive: true, force: true });
  console.log("✓ All black-box integration contract tests passed.");
}

main();
