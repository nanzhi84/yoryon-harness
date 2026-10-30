#!/usr/bin/env node

import { runInit, runSync } from "../src/init.js";
import { runDoctor, printRules } from "../src/doctor.js";
import { runSandboxTask } from "../src/run.js";
import { createSpec, createAdr, supersedeAdr } from "../src/scaffold.js";
import { installHooks, runHook } from "../src/hook.js";
import { cleanSandboxes } from "../src/clean.js";

const HELP_TEXT = `yoryon-harness — Personal Universal Agent Harness CLI

Usage:
  harness <command> [options]

Commands:
  init [--force]                                Initialize Universal Harness directories & docs in current repo
  sync                                          Sync latest AGENTS.md and docs/README.md without touching project files
  doctor [--json]                               Check directory conventions, doc/text rules, test contracts, and dead links
  rule [--all | <CODE>]                         Explain Harness check rules (HAR001, GIT001, ARC001, SPC001, ADR001/002, REF001, LNK001/002, VOX001, SUP001, TST001/002)
  hook install [--git] [--agents]               Install Git pre-commit hook and/or .agents/hooks.json Stop hook for auto-repair & TTL cleanup
  hook run [--agent]                            Execute TTL sandbox cleanup + doctor + static typecheck (outputs Antigravity Stop hook JSON in --agent mode)
  clean [--all] [--max-age 12h] [--keep <N>]    Clean expired or all intermediate files in work/ and artifacts/
  run <task-name> -- <cmd> [args...]            Run verification command in isolated work/ & artifacts/ sandbox with receipt
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
        const code = runHook(cwd, { agentMode });
        process.exit(code);
      } else {
        console.error(
          "Usage:\n  harness hook install [--git] [--agents]\n  harness hook run [--agent]"
        );
        process.exit(1);
      }
      break;
    }

    case "clean": {
      const all = args.includes("--all");
      const dryRun = args.includes("--dry-run");
      const quiet = args.includes("--quiet");
      const maxAge = parseFlagValue(args, "--max-age");
      const keep = parseFlagValue(args, "--keep");
      cleanSandboxes(cwd, { all, dryRun, quiet, maxAge, keep });
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
