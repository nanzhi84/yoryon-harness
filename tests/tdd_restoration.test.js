import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// Failure boundaries: new relative and dangling links must survive successful
// verification, rejected red checks, and failed green checks. External targets
// must remain byte-identical; restoring a regular file is not equivalent.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidence = path.resolve(process.env.HARNESS_ARTIFACTS_DIR || path.join(root, "artifacts", "regressions"));
function run(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 30000 });
  assert.equal(result.error, undefined);
  return result;
}
function git(cwd, args) {
  const result = run(cwd, "git", args);
  assert.equal(result.status, 0, result.stderr);
}

describe("TestTddRestoration", () => {
  for (const scenario of ["success", "red_rejected", "green_failed"]) {
    it("test_verification_outcome_restores_untracked_symbolic_links_and_external_target", () => {
      fs.mkdirSync(path.join(root, "work"), { recursive: true });
      fs.mkdirSync(evidence, { recursive: true });
      const base = fs.mkdtempSync(path.join(root, "work", "tdd-restoration-"));
      const cwd = path.join(base, "repo");
      fs.mkdirSync(cwd);
      fs.writeFileSync(path.join(base, "external.txt"), "external data\n");
      git(cwd, ["init", "-q"]);
      git(cwd, ["config", "user.name", "Harness Test"]);
      git(cwd, ["config", "user.email", "test@example.invalid"]);
      fs.writeFileSync(path.join(cwd, ".gitignore"), "work/\nartifacts/\n");
      fs.writeFileSync(path.join(cwd, "value.txt"), "old\n");
      git(cwd, ["add", "."]);
      git(cwd, ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "baseline"]);
      fs.writeFileSync(path.join(cwd, "value.txt"), "new\n");
      fs.symlinkSync("../external.txt", path.join(cwd, "relative-link"));
      fs.symlinkSync("../missing.txt", path.join(cwd, "dangling-link"));
      fs.mkdirSync(path.join(cwd, "tests"));
      const body = scenario === "red_rejected" ? "process.exit(0);" : scenario === "green_failed" ? "process.exit(1);" : "import fs from 'node:fs'; process.exit(fs.readFileSync('value.txt', 'utf8') === 'new\\n' ? 0 : 1);";
      fs.writeFileSync(path.join(cwd, "tests", "behavior.mjs"), body);
      const result = run(cwd, process.execPath, [path.join(root, "bin/harness.js"), "tdd", "verify", "--test", "node tests/behavior.mjs"]);
      const links = ["relative-link", "dangling-link"].map(name => {
        try {
          const symbolic = fs.lstatSync(path.join(cwd, name)).isSymbolicLink();
          return { name, symbolic, target: symbolic ? fs.readlinkSync(path.join(cwd, name)) : null };
        } catch { return { name, symbolic: false, target: null }; }
      });
      const report = { scenario, command: "node --test tests/tdd_restoration.test.js", node: process.version, status: result.status, links, external: fs.readFileSync(path.join(base, "external.txt"), "utf8"), value: fs.readFileSync(path.join(cwd, "value.txt"), "utf8") };
      try {
        assert.deepEqual(links, [{ name: "relative-link", symbolic: true, target: "../external.txt" }, { name: "dangling-link", symbolic: true, target: "../missing.txt" }]);
        assert.equal(report.external, "external data\n");
        assert.equal(report.value, "new\n");
        assert.equal(result.status, scenario === "success" ? 0 : 1, result.stderr);
        if (scenario === "red_rejected") assert.match(result.stderr, /Red Check failed/);
        if (scenario === "green_failed") assert.match(result.stderr, /Green Check failed/);
        report.passed = true;
      } catch (error) {
        report.passed = false;
        report.failure = error.message;
        throw error;
      } finally {
        fs.writeFileSync(path.join(evidence, `tdd-${scenario}.json`), JSON.stringify(report, null, 2));
      }
    });
  }
  // Tracked links add a distinct boundary: the red baseline must also be a link,
  // and checking out that baseline must not write through either external target.
  it("test_tracked_link_change_uses_true_baseline_without_writing_external_targets", () => {
    fs.mkdirSync(path.join(root, "work"), { recursive: true });
    fs.mkdirSync(evidence, { recursive: true });
    const base = fs.mkdtempSync(path.join(root, "work", "tdd-tracked-link-"));
    const cwd = path.join(base, "repo");
    fs.mkdirSync(cwd);
    for (const version of ["old", "new"]) fs.writeFileSync(path.join(base, `${version}.txt`), `${version} content\n`);
    git(cwd, ["init", "-q"]);
    git(cwd, ["config", "user.name", "Harness Test"]);
    git(cwd, ["config", "user.email", "test@example.invalid"]);
    fs.writeFileSync(path.join(cwd, ".gitignore"), "work/\nartifacts/\n");
    fs.symlinkSync("../old.txt", path.join(cwd, "value-link"));
    git(cwd, ["add", "."]);
    git(cwd, ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "baseline"]);
    fs.unlinkSync(path.join(cwd, "value-link"));
    fs.symlinkSync("../new.txt", path.join(cwd, "value-link"));
    fs.mkdirSync(path.join(cwd, "tests"));
    fs.mkdirSync(path.join(cwd, "artifacts"));
    fs.writeFileSync(path.join(cwd, "tests", "behavior.mjs"), `
import fs from "node:fs";
const observation = {
  symbolic: fs.lstatSync("value-link").isSymbolicLink(),
  target: fs.readlinkSync("value-link"),
  old: fs.readFileSync("../old.txt", "utf8"),
  current: fs.readFileSync("../new.txt", "utf8"),
};
fs.appendFileSync("artifacts/observations.jsonl", JSON.stringify(observation) + "\\n");
process.exit(observation.target === "../new.txt" ? 0 : 1);
`);
    const result = run(cwd, process.execPath, [path.join(root, "bin/harness.js"), "tdd", "verify", "--test", "node tests/behavior.mjs"]);
    const observationFile = path.join(cwd, "artifacts", "observations.jsonl");
    const observations = fs.existsSync(observationFile) ? fs.readFileSync(observationFile, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    const report = { command: "node --test tests/tdd_restoration.test.js", node: process.version, status: result.status, observations };
    try {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(observations, ["old", "new"].map(version => ({ symbolic: true, target: `../${version}.txt`, old: "old content\n", current: "new content\n" })));
      assert.equal(fs.readlinkSync(path.join(cwd, "value-link")), "../new.txt");
      report.passed = true;
    } catch (error) {
      report.passed = false;
      report.failure = error.message;
      throw error;
    } finally {
      fs.writeFileSync(path.join(evidence, "tdd-tracked-link.json"), JSON.stringify(report, null, 2));
    }
  });

});
