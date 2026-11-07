import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_BIN = path.join(ROOT, "bin", "harness.js");

function createTestEnv(sandboxDir) {
  const binDir = path.join(sandboxDir, ".test-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const harnessShim = path.join(binDir, "harness");
  if (!fs.existsSync(harnessShim)) {
    fs.symlinkSync(CLI_BIN, harnessShim);
  }
  return {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH || ""}`,
    HARNESS_WORKTREE_COOLDOWN_MS: "0",
  };
}

function runCmd(cwd, command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 15000,
    env,
  });
  assert.equal(result.error, undefined);
  assert.equal(
    result.status,
    0,
    `Command failed: ${command} ${args.join(" ")}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  return result;
}

function branchExists(cwd, branchName, env = process.env) {
  const result = spawnSync(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    {
      cwd,
      encoding: "utf8",
      timeout: 15000,
      env,
    }
  );
  return result.status === 0;
}

function remoteTrackingRefExists(cwd, remoteBranch, env = process.env) {
  const result = spawnSync(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteBranch}`],
    {
      cwd,
      encoding: "utf8",
      timeout: 15000,
      env,
    }
  );
  return result.status === 0;
}

describe("TestBranchCleanup", () => {
  it("test_hook_install_enables_local_fetch_prune_config", () => {
    fs.mkdirSync(path.join(ROOT, "work"), { recursive: true });
    const sandbox = fs.mkdtempSync(path.join(ROOT, "work", "branch-cleanup-config-"));
    try {
      const env = createTestEnv(sandbox);
      runCmd(sandbox, "git", ["init", "-q"], env);
      runCmd(sandbox, process.execPath, [CLI_BIN, "hook", "install", "--git"], env);

      const pruneCfg = runCmd(
        sandbox,
        "git",
        ["config", "--local", "--get", "fetch.prune"],
        env
      );
      assert.equal(pruneCfg.stdout.trim(), "true");
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("test_merged_and_squash_gone_branches_are_pruned_after_fetch", () => {
    fs.mkdirSync(path.join(ROOT, "work"), { recursive: true });
    const sandbox = fs.mkdtempSync(path.join(ROOT, "work", "branch-cleanup-fetch-"));
    try {
      const env = createTestEnv(sandbox);
      const remoteDir = path.join(sandbox, "remote.git");
      const localDir = path.join(sandbox, "local");

      runCmd(sandbox, "git", ["init", "-q", "--bare", "-b", "main", remoteDir], env);
      runCmd(sandbox, "git", ["clone", "-q", remoteDir, localDir], env);

      runCmd(localDir, "git", ["config", "user.name", "Harness Test"], env);
      runCmd(localDir, "git", ["config", "user.email", "test@example.com"], env);
      runCmd(localDir, "git", ["checkout", "-q", "-B", "main"], env);
      fs.writeFileSync(path.join(localDir, "README.md"), "# init\n", "utf8");
      runCmd(localDir, "git", ["add", "README.md"], env);
      runCmd(localDir, "git", ["commit", "-q", "--no-verify", "-m", "initial commit"], env);
      runCmd(localDir, "git", ["push", "-q", "-u", "origin", "main"], env);

      runCmd(localDir, process.execPath, [CLI_BIN, "hook", "install", "--git"], env);

      // 1. Standard merge PR branch
      runCmd(localDir, "git", ["checkout", "-q", "-b", "feat/merge-pr"], env);
      fs.writeFileSync(path.join(localDir, "merge.txt"), "merge feature\n", "utf8");
      runCmd(localDir, "git", ["add", "merge.txt"], env);
      runCmd(localDir, "git", ["commit", "-q", "--no-verify", "-m", "feat: merge pr"], env);
      runCmd(localDir, "git", ["push", "-q", "-u", "origin", "feat/merge-pr"], env);

      runCmd(localDir, "git", ["checkout", "-q", "main"], env);
      runCmd(localDir, "git", ["merge", "-q", "--no-ff", "--no-verify", "feat/merge-pr", "-m", "Merge feat/merge-pr"], env);
      runCmd(localDir, "git", ["push", "-q", "origin", "main"], env);

      // 2. Squash merge PR branch (commit graph is not ancestor of main, but upstream will be gone)
      runCmd(localDir, "git", ["checkout", "-q", "-b", "feat/squash-pr"], env);
      fs.writeFileSync(path.join(localDir, "squash.txt"), "squash feature v1\n", "utf8");
      runCmd(localDir, "git", ["add", "squash.txt"], env);
      runCmd(localDir, "git", ["commit", "-q", "--no-verify", "-m", "feat: wip squash 1"], env);
      fs.writeFileSync(path.join(localDir, "squash.txt"), "squash feature final\n", "utf8");
      runCmd(localDir, "git", ["add", "squash.txt"], env);
      runCmd(localDir, "git", ["commit", "-q", "--no-verify", "-m", "feat: wip squash 2"], env);
      runCmd(localDir, "git", ["push", "-q", "-u", "origin", "feat/squash-pr"], env);

      runCmd(localDir, "git", ["checkout", "-q", "main"], env);
      fs.writeFileSync(path.join(localDir, "squash.txt"), "squash feature final\n", "utf8");
      runCmd(localDir, "git", ["add", "squash.txt"], env);
      runCmd(localDir, "git", ["commit", "-q", "--no-verify", "-m", "feat: squash pr (#2)"], env);
      runCmd(localDir, "git", ["push", "-q", "origin", "main"], env);

      // 3. Local unpushed WIP branch (no upstream configured, not merged)
      runCmd(localDir, "git", ["checkout", "-q", "-b", "feat/unmerged-wip"], env);
      fs.writeFileSync(path.join(localDir, "wip.txt"), "local work in progress\n", "utf8");
      runCmd(localDir, "git", ["add", "wip.txt"], env);
      runCmd(localDir, "git", ["commit", "-q", "--no-verify", "-m", "wip: local work"], env);
      runCmd(localDir, "git", ["checkout", "-q", "main"], env);

      // Simulate GitHub auto-deleting both PR branches on remote after merge
      runCmd(sandbox, "git", [`--git-dir=${remoteDir}`, "branch", "-D", "feat/merge-pr"], env);
      runCmd(sandbox, "git", [`--git-dir=${remoteDir}`, "branch", "-D", "feat/squash-pr"], env);

      // Run git fetch origin in local (should auto-prune remote refs and trigger reference-transaction cleanup)
      runCmd(localDir, "git", ["fetch", "-q", "origin"], env);

      assert.equal(
        remoteTrackingRefExists(localDir, "origin/feat/merge-pr", env),
        false,
        "Remote-tracking ref origin/feat/merge-pr should be pruned on git fetch"
      );
      assert.equal(
        remoteTrackingRefExists(localDir, "origin/feat/squash-pr", env),
        false,
        "Remote-tracking ref origin/feat/squash-pr should be pruned on git fetch"
      );
      assert.equal(
        branchExists(localDir, "feat/merge-pr", env),
        false,
        "Local merged branch feat/merge-pr should be automatically deleted after fetch"
      );
      assert.equal(
        branchExists(localDir, "feat/squash-pr", env),
        false,
        "Local squash-merged branch feat/squash-pr with [gone] upstream should be automatically deleted after fetch"
      );
      assert.equal(
        branchExists(localDir, "main", env),
        true,
        "Main branch must remain intact"
      );
      assert.equal(
        branchExists(localDir, "feat/unmerged-wip", env),
        true,
        "Unpushed local WIP branch feat/unmerged-wip must remain intact"
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("test_worktree_with_gone_upstream_prunes_when_clean_and_preserves_when_dirty", () => {
    fs.mkdirSync(path.join(ROOT, "work"), { recursive: true });
    const sandbox = fs.mkdtempSync(path.join(ROOT, "work", "branch-cleanup-worktree-"));
    try {
      const env = createTestEnv(sandbox);
      const remoteDir = path.join(sandbox, "remote.git");
      const localDir = path.join(sandbox, "local");
      const wtClean = path.join(sandbox, "wt-clean");
      const wtDirty = path.join(sandbox, "wt-dirty");

      runCmd(sandbox, "git", ["init", "-q", "--bare", "-b", "main", remoteDir], env);
      runCmd(sandbox, "git", ["clone", "-q", remoteDir, localDir], env);

      runCmd(localDir, "git", ["config", "user.name", "Harness Test"], env);
      runCmd(localDir, "git", ["config", "user.email", "test@example.com"], env);
      runCmd(localDir, "git", ["checkout", "-q", "-B", "main"], env);
      fs.writeFileSync(path.join(localDir, "README.md"), "# init\n", "utf8");
      runCmd(localDir, "git", ["add", "README.md"], env);
      runCmd(localDir, "git", ["commit", "-q", "--no-verify", "-m", "initial commit"], env);
      runCmd(localDir, "git", ["push", "-q", "-u", "origin", "main"], env);

      runCmd(localDir, process.execPath, [CLI_BIN, "hook", "install", "--git"], env);

      // Clean linked worktree whose upstream branch will be deleted on remote
      runCmd(localDir, "git", ["worktree", "add", "-q", "-b", "feat/wt-clean-pr", wtClean, "main"], env);
      fs.writeFileSync(path.join(wtClean, "clean.txt"), "clean worktree change\n", "utf8");
      runCmd(wtClean, "git", ["add", "clean.txt"], env);
      runCmd(wtClean, "git", ["commit", "-q", "--no-verify", "-m", "feat: clean wt"], env);
      runCmd(wtClean, "git", ["push", "-q", "-u", "origin", "feat/wt-clean-pr"], env);

      // Dirty linked worktree whose upstream branch will also be deleted on remote
      runCmd(localDir, "git", ["worktree", "add", "-q", "-b", "feat/wt-dirty-pr", wtDirty, "main"], env);
      fs.writeFileSync(path.join(wtDirty, "committed.txt"), "committed change\n", "utf8");
      runCmd(wtDirty, "git", ["add", "committed.txt"], env);
      runCmd(wtDirty, "git", ["commit", "-q", "--no-verify", "-m", "feat: dirty wt"], env);
      runCmd(wtDirty, "git", ["push", "-q", "-u", "origin", "feat/wt-dirty-pr"], env);
      const dirtyFile = path.join(wtDirty, "dirty.txt");
      fs.writeFileSync(dirtyFile, "uncommitted local changes\n", "utf8");

      // Delete both PR branches on bare remote
      runCmd(sandbox, "git", [`--git-dir=${remoteDir}`, "branch", "-D", "feat/wt-clean-pr"], env);
      runCmd(sandbox, "git", [`--git-dir=${remoteDir}`, "branch", "-D", "feat/wt-dirty-pr"], env);

      // Fetch in local repo
      runCmd(localDir, "git", ["fetch", "-q", "origin"], env);

      assert.equal(
        fs.existsSync(wtClean),
        false,
        "Clean worktree wtClean with [gone] upstream should be removed"
      );
      assert.equal(
        branchExists(localDir, "feat/wt-clean-pr", env),
        false,
        "Branch feat/wt-clean-pr of removed clean worktree should be deleted"
      );
      assert.equal(
        fs.existsSync(wtDirty),
        true,
        "Dirty worktree wtDirty must be preserved even when its upstream is [gone]"
      );
      assert.equal(
        fs.existsSync(dirtyFile),
        true,
        "Uncommitted file dirty.txt inside wtDirty must be preserved"
      );
      assert.equal(
        branchExists(localDir, "feat/wt-dirty-pr", env),
        true,
        "Branch feat/wt-dirty-pr of dirty worktree must be preserved"
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("test_init_in_git_repo_installs_hooks_and_prints_remote_branch_cleanup_reminder", () => {
    fs.mkdirSync(path.join(ROOT, "work"), { recursive: true });
    const sandbox = fs.mkdtempSync(path.join(ROOT, "work", "branch-cleanup-init-"));
    try {
      const env = createTestEnv(sandbox);
      runCmd(sandbox, "git", ["init", "-q"], env);
      const initResult = runCmd(sandbox, process.execPath, [CLI_BIN, "init"], env);

      assert.equal(
        fs.existsSync(path.join(sandbox, ".git", "hooks", "reference-transaction")),
        true,
        "reference-transaction hook should be installed during harness init in a git repo"
      );
      const pruneCfg = runCmd(
        sandbox,
        "git",
        ["config", "--local", "--get", "fetch.prune"],
        env
      );
      assert.equal(pruneCfg.stdout.trim(), "true");

      const combinedOutput = `${initResult.stdout || ""}\n${initResult.stderr || ""}`;
      assert.match(
        combinedOutput,
        /delete-branch-on-merge|deleteBranchOnMerge/,
        "harness init output should remind about remote delete-branch-on-merge configuration"
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("test_hook_install_syncs_github_delete_branch_on_merge_or_prints_reminder_on_failure", () => {
    fs.mkdirSync(path.join(ROOT, "work"), { recursive: true });
    const sandbox = fs.mkdtempSync(path.join(ROOT, "work", "branch-cleanup-gh-sync-"));
    try {
      const env = createTestEnv(sandbox);
      const binDir = path.join(sandbox, ".test-bin");
      const ghBin = path.join(binDir, "gh");
      const ghCallsLog = path.join(sandbox, "gh-calls.log");

      runCmd(sandbox, "git", ["init", "-q"], env);
      runCmd(
        sandbox,
        "git",
        ["remote", "add", "origin", "https://github.com/example-org/example-repo.git"],
        env
      );

      // Case A: gh fails (non-blocking reminder)
      fs.writeFileSync(
        ghBin,
        '#!/usr/bin/env sh\necho "HTTP 403: Resource not accessible" >&2\nexit 1\n',
        { encoding: "utf8", mode: 0o755 }
      );
      const failInstall = runCmd(
        sandbox,
        process.execPath,
        [CLI_BIN, "hook", "install", "--git"],
        env
      );
      const failCombined = `${failInstall.stdout || ""}\n${failInstall.stderr || ""}`;
      assert.match(failCombined, /example-org\/example-repo/);
      assert.match(
        failCombined,
        /gh repo edit example-org\/example-repo --delete-branch-on-merge/
      );

      const unsetCheck = spawnSync(
        "git",
        ["config", "--local", "--get", "harness.ghDeleteBranchOnMerge"],
        {
          cwd: sandbox,
          encoding: "utf8",
          timeout: 15000,
          env,
        }
      );
      assert.equal(unsetCheck.stdout.trim(), "");

      // Case B: gh succeeds + idempotency cache
      fs.writeFileSync(
        ghBin,
        `#!/usr/bin/env sh\necho "$@" >> "${ghCallsLog}"\nexit 0\n`,
        { encoding: "utf8", mode: 0o755 }
      );
      runCmd(sandbox, process.execPath, [CLI_BIN, "hook", "install", "--git"], env);

      assert.equal(fs.existsSync(ghCallsLog), true, "gh should be invoked on first install");
      const firstLogLines = fs
        .readFileSync(ghCallsLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
      assert.equal(firstLogLines.length, 1);
      assert.match(
        firstLogLines[0],
        /repo edit example-org\/example-repo --delete-branch-on-merge/
      );

      const cachedCfg = runCmd(
        sandbox,
        "git",
        ["config", "--local", "--get", "harness.ghDeleteBranchOnMerge"],
        env
      );
      assert.equal(cachedCfg.stdout.trim(), "example-org/example-repo");

      // Second install should skip calling gh due to local git config cache
      runCmd(sandbox, process.execPath, [CLI_BIN, "hook", "install", "--git"], env);
      const secondLogLines = fs
        .readFileSync(ghCallsLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
      assert.equal(
        secondLogLines.length,
        1,
        "Second hook install should use cached harness.ghDeleteBranchOnMerge and not call gh again"
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
