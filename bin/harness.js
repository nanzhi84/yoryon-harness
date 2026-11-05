#!/usr/bin/env node

import { runInit, runSync } from "../src/init.js";
import { runDoctor, printRules } from "../src/doctor.js";
import { runSandboxTask } from "../src/run.js";
import { createSpec, createAdr, supersedeAdr } from "../src/scaffold.js";
import { installHooks, runHook } from "../src/hook.js";
import { cleanSandboxes, cleanWorktrees } from "../src/clean.js";
import { runTddVerify } from "../src/tdd.js";

const HELP_TEXT = `yoryon-harness — Personal Universal Agent Harness CLI

Usage:
  harness <command> [options]

Commands:
  init [--force]                                Initialize Universal Harness directories & docs in current repo
  sync                                          Sync latest AGENTS.md, docs/README.md, and .agents/hooks.json Stop hook
  doctor [--json]                               Check directory conventions, doc/text rules, test contracts, and dead links
  rule [--all | <CODE>]                         Explain Harness check rules (HAR001, DIR001, GIT001, ARC001, SPC001, ADR001/002, REF001, LNK001/002, VOX001, SUP001, TST001-004, MTX001, AST001/002)
  hook install [--git] [--agents]               Install Git pre-commit & reference-transaction hooks and/or .agents/hooks.json Stop hook
  hook run [--agent] [--staged]                 Execute TTL sandbox & worktree cleanup + doctor + static typecheck & incremental format check
  clean [--all] [--worktrees] [--max-age 12h]   Clean expired intermediate files in work/ and artifacts/ and prune stale Git worktree metadata
  run <task-name> -- <cmd> [args...]            Run verification command in isolated work/ & artifacts/ sandbox with receipt
  tdd verify --test "<test-cmd>"                Verify Red-Green TDD contract (fails on HEAD baseline -> passes with implementation)
  spec new <issue#<N>> [--title] [--module]     Create an issue-aligned spec directory (docs/spec/issue#<N>/spec.md)
  adr new <slug>                                Create a sequentially numbered ADR (docs/adr/NNNN-<slug>.md)
  adr supersede <old-id> <new> [--reason]       Mark an ADR Superseded, append failure note, and move to docs/adr/superseded/
  help                                          Show this help message
`;

function parseFlagValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const cwd = process.cwd();

  switch (cmd) {
    case "init": {
      const force = args.includes("--force");
      runInit(cwd, { force });
      break;
    }

    case "sync": {
      runSync(cwd);
      break;
    }

    case "doctor":
    case "check": {
      const json = args.includes("--json");
      const code = runDoctor(cwd, { json });
      process.exit(code);
      break;
    }

    case "rule": {
      const code = printRules(args[1]);
      process.exit(code);
      break;
    }

    case "hook": {
      const sub = args[1];
      if (sub === "install") {
        const git = args.includes("--git");
        const agents = args.includes("--agents");
        const code = installHooks(cwd, { git, agents });
        process.exit(code);
      } else if (sub === "run") {
        const agentMode = args.includes("--agent");
        const staged = args.includes("--staged");
        const code = runHook(cwd, { agentMode, staged });
        process.exit(code);
      } else {
        console.error(
          "Usage:\n  harness hook install [--git] [--agents]\n  harness hook run [--agent] [--staged]"
        );
        process.exit(1);
      }
      break;
    }

    case "clean": {
      const all = args.includes("--all");
      const worktreesOnly = args.includes("--worktrees");
      const dryRun = args.includes("--dry-run");
      const quiet = args.includes("--quiet");
      const maxAge = parseFlagValue(args, "--max-age");
      const keep = parseFlagValue(args, "--keep");
      const cooldownMs = parseFlagValue(args, "--cooldown");
      if (worktreesOnly) {
        cleanWorktrees(cwd, { dryRun, quiet, cooldownMs });
      } else {
        cleanSandboxes(cwd, { all, dryRun, quiet, maxAge, keep });
      }
      break;
    }

    case "run": {
      const taskName = args[1];
      const sepIdx = args.indexOf("--");
      const cmdArgs = sepIdx !== -1 ? args.slice(sepIdx + 1) : args.slice(2);
      const code = await runSandboxTask(cwd, taskName, cmdArgs);
      process.exit(code);
      break;
    }

    case "tdd": {
      const sub = args[1];
      if (sub !== "verify") {
        console.error('Usage: harness tdd verify --test "<test-cmd>"');
        process.exit(1);
      }
      const testCmd = parseFlagValue(args, "--test");
      const sepIdx = args.indexOf("--");
      const cmdArgs = sepIdx !== -1 ? args.slice(sepIdx + 1) : [];
      const code = runTddVerify(cwd, { testCmd, cmdArgs });
      process.exit(code);
      break;
    }

    case "spec": {
      const sub = args[1];
      if (sub !== "new") {
        console.error(
          'Usage: harness spec new [issue#<N> | <N>] [--title "<title>"] [--module "<arch-module>"]'
        );
        process.exit(1);
      }
      const title = parseFlagValue(args, "--title");
      const moduleName = parseFlagValue(args, "--module");
      const issueArg = args[2] && !args[2].startsWith("--") ? args[2] : undefined;
      const code = createSpec(cwd, issueArg, { title, module: moduleName });
      process.exit(code);
      break;
    }

    case "adr": {
      const sub = args[1];
      if (sub === "new") {
        const res = createAdr(cwd, args[2] || "");
        process.exit(res.code);
      } else if (sub === "supersede") {
        const reason = parseFlagValue(args, "--reason");
        const code = supersedeAdr(cwd, args[2], args[3], { reason });
        process.exit(code);
      } else {
        console.error(
          'Usage:\n  harness adr new <slug>\n  harness adr supersede <old-id> <new-slug-or-id> [--reason "..."]'
        );
        process.exit(1);
      }
      break;
    }

    default: {
      console.error(`Unknown command '${cmd}'. Run 'harness help' for usage.`);
      process.exit(1);
    }
  }
}

main();
