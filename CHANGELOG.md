# Changelog

本项目的所有重要版本变更、新特性汇总与修复记录均归档于此。

## [Unreleased]

### Added
- 新增声明式多 Agent Worktree 容器与项目环境注册表自动回收能力（`harness clean --worktrees` 及 `src/clean.js` 中的 `DEFAULT_AGENT_WORKTREE_SPECS` / `cleanWorktrees`）：内置 Antigravity、Cursor、Claude Code、Codex 路径模板（支持 `~`、`{home}`、`{repo}`、`{repoRoot}` 占位符及 `.agents/harness.json` / `~/.config/harness/config.json` 扩展声明），基于 `git rev-parse --git-common-dir` 与 `.git/worktrees/*/gitdir` 自动清理孤儿 worktree 空壳目录、同步剔除项目注册表中已失效的 `environments` 条目并修正已删除的 `defaultBranch`、执行 `git worktree prune --expire now`、刷新 `.git/info/refs` 并回收 `refs/heads/` 空目录；同时在 `harness hook install --git` 中自动挂载 `.git/hooks/reference-transaction` 钩子。
- 新增测试契约静态巡检规则 `TST001`（拦截 `tests/` 下阶段/序号命名及未归入 `class Test<Subject>:` 的裸测试函数或单词方法名）与 `TST002`（拦截 `unittest.mock`、`MagicMock`、`monkeypatch.setattr`、`jest.mock` 等业务打桩，放行 `monkeypatch.setenv`/`delenv` 并支持 `# harness-ignore CODE: 原因` 豁免）。
- 升级 `src/hook.js` (`harness hook run --agent`)：内置 `terminationReason == "NO_TOOL_CALL"` 正常回合守卫，以及多语言静态类型与 Linter 零容忍检查（自动探测并解析 `.venv/bin/pyright`、`pyrefly`、`ruff`、`eslint`、`tsc` 的错误与警告 JSON）。
- 新增 `harness clean` 命令及 `src/clean.js` 沙盒 TTL / 配额清理模块，并在 `harness hook run` 与 `harness run` 中内置自动过期清理。
- 升级 `AGENTS.md` 与 `PROJECTS.md` 规范母本：确立三要素黑盒测试命名规范，以及 `PROJECTS.md` 与 `docs/adr/` 的职责边界红线。
- 初始化项目 Universal Harness 目录结构与文档规范。
