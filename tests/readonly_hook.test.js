import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_BIN = path.join(ROOT, "bin", "harness.js");

function initSandboxWithViolation(prefix) {
  fs.mkdirSync(path.join(ROOT, "work"), { recursive: true });
  const sandbox = fs.mkdtempSync(path.join(ROOT, "work", prefix));
  const initRes = spawnSync(process.execPath, [CLI_BIN, "init"], {
    cwd: sandbox,
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(initRes.error, undefined);
  assert.equal(initRes.status, 0, initRes.stderr + initRes.stdout);

  // Introduce a known TST001 violation (phase-numbered test filename)
  const testsDir = path.join(sandbox, "tests");
  fs.mkdirSync(testsDir, { recursive: true });
  fs.writeFileSync(
    path.join(testsDir, "test_phase99.py"),
    "class TestDemo:\n    def test_input_returns_ok(self):\n        assert True\n",
    "utf8"
  );

  // Introduce an expired sandbox item (mtime 48h ago) inside work/
  const expiredDir = path.join(sandbox, "work", "expired-item");
  fs.mkdirSync(expiredDir, { recursive: true });
  const pastTime = new Date(Date.now() - 48 * 3600 * 1000);
  fs.utimesSync(expiredDir, pastTime, pastTime);

  return { sandbox, expiredDir };
}

function runAgentStopHook(cwd, payload) {
  const result = spawnSync(process.execPath, [CLI_BIN, "hook", "run", "--agent"], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.error, undefined);
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    json: result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null,
  };
}

describe("TestReadonlyHookGuard", () => {
  it("test_readonly_turn_with_inspection_tools_skips_stop_hook", () => {
    const { sandbox, expiredDir } = initSandboxWithViolation("readonly-hook-inspect-");
    try {
      const transcriptPath = path.join(sandbox, "work", "transcript.jsonl");
      const lines = [
        // Turn 1: earlier turn that had a mutating edit_file
        {
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          content: "Edit README earlier",
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
          content: "Edited README.md",
        },
        // Turn 2 (latest): read-only inspection turn
        {
          step_index: 3,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          content: "Check status and inspect hooks without changing anything",
        },
        {
          step_index: 4,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          tool_calls: [
            {
              name: "read_file",
              args: { Path: "\"AGENTS.md\"" },
            },
            {
              name: "grep_search",
              args: { Query: "\"doctor\"", SearchPath: "\"src\"" },
            },
            {
              name: "run_command",
              args: {
                CommandLine: "\"git status && git diff --stat && git log -n 5 --oneline\"",
              },
            },
            {
              name: "run_command",
              args: {
                CommandLine: "ls -la .git/hooks && cat .agents/hooks.json",
              },
            },
            {
              name: "run_command",
              args: {
                CommandLine: "\"harness doctor\"",
              },
            },
          ],
        },
        { step_index: 5, source: "MODEL", type: "GENERIC", status: "DONE", content: "ok" },
        { step_index: 6, source: "MODEL", type: "GENERIC", status: "DONE", content: "ok" },
        { step_index: 7, source: "MODEL", type: "GENERIC", status: "DONE", content: "ok" },
        { step_index: 8, source: "MODEL", type: "GENERIC", status: "DONE", content: "ok" },
        { step_index: 9, source: "MODEL", type: "GENERIC", status: "DONE", content: "ok" },
        {
          step_index: 10,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "Inspection complete.",
        },
      ];
      fs.writeFileSync(
        transcriptPath,
        lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
        "utf8"
      );

      const res = runAgentStopHook(sandbox, {
        terminationReason: "NO_TOOL_CALL",
        transcriptPath,
      });

      assert.equal(res.status, 0, `Expected exit 0 for read-only turn, got ${res.status}: ${res.stdout}`);
      assert.deepEqual(res.json, { decision: "stop" });
      assert.equal(
        fs.existsSync(expiredDir),
        true,
        "Stop hook must skip sandbox cleanup on read-only turn"
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("test_pure_qa_turn_without_tool_calls_skips_stop_hook", () => {
    const { sandbox, expiredDir } = initSandboxWithViolation("readonly-hook-qa-");
    try {
      const transcriptPath = path.join(sandbox, "work", "transcript.jsonl");
      const lines = [
        {
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          content: "What is Universal Harness?",
        },
        {
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "It is a repository convention and verification tool.",
        },
      ];
      fs.writeFileSync(
        transcriptPath,
        lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
        "utf8"
      );

      const res = runAgentStopHook(sandbox, {
        terminationReason: "NO_TOOL_CALL",
        transcriptPath,
      });

      assert.equal(res.status, 0);
      assert.deepEqual(res.json, { decision: "stop" });
      assert.equal(fs.existsSync(expiredDir), true);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("test_turn_with_only_errored_tool_calls_skips_stop_hook", () => {
    const { sandbox, expiredDir } = initSandboxWithViolation("readonly-hook-errored-");
    try {
      const transcriptPath = path.join(sandbox, "work", "transcript.jsonl");
      const lines = [
        {
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          content: "Try editing or running a command that gets denied",
        },
        {
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          tool_calls: [
            {
              name: "edit_file",
              args: { Path: "\"README.md\"", Target: "\"x\"", Replacement: "\"y\"" },
            },
            {
              name: "run_command",
              args: { CommandLine: "\"rm -rf work/something\"" },
            },
          ],
        },
        {
          step_index: 2,
          source: "MODEL",
          type: "GENERIC",
          status: "ERROR",
          content: "Tool execution denied by user",
        },
        {
          step_index: 3,
          source: "MODEL",
          type: "GENERIC",
          status: "ERROR",
          content: "Command rejected",
        },
      ];
      fs.writeFileSync(
        transcriptPath,
        lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
        "utf8"
      );

      const res = runAgentStopHook(sandbox, {
        terminationReason: "NO_TOOL_CALL",
        transcriptPath,
      });

      assert.equal(res.status, 0);
      assert.deepEqual(res.json, { decision: "stop" });
      assert.equal(fs.existsSync(expiredDir), true);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("test_mutating_turn_triggers_stop_hook_and_blocks_on_violation", () => {
    const { sandbox } = initSandboxWithViolation("readonly-hook-mutating-");
    try {
      const transcriptPath = path.join(sandbox, "work", "transcript.jsonl");
      const mutatingToolCalls = [
        {
          name: "edit_file",
          args: { Path: "\"README.md\"", Target: "\"old\"", Replacement: "\"new\"" },
        },
        {
          name: "run_command",
          args: { CommandLine: "\"echo hello > newfile.txt\"" },
        },
        {
          name: "run_command",
          args: { CommandLine: "\"git commit -m test\"" },
        },
        {
          name: "run_command",
          args: { CommandLine: "\"sed -i '' 's/a/b/' file.txt\"" },
        },
      ];

      for (const toolCall of mutatingToolCalls) {
        const lines = [
          {
            step_index: 0,
            source: "USER_EXPLICIT",
            type: "USER_INPUT",
            status: "DONE",
            content: "Make a change",
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
            content: "Completed",
          },
        ];
        fs.writeFileSync(
          transcriptPath,
          lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
          "utf8"
        );

        const res = runAgentStopHook(sandbox, {
          terminationReason: "NO_TOOL_CALL",
          transcriptPath,
        });

        assert.equal(
          res.status,
          2,
          `Expected exit 2 for mutating tool call ${JSON.stringify(toolCall)}, got ${res.status}`
        );
        assert.equal(res.json?.decision, "continue");
        assert.match(res.json?.reason || "", /TST001/);
      }
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
